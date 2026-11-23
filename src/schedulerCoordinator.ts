import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { CheckinService, todayCN } from './checkinService';
import { AutoSwitcher, RotationEvent } from './autoSwitcher';
import { CheckinScheduler } from './checkinScheduler';
import { CooldownLogWatcher } from './cooldownLogWatcher';
import { UsageTracker } from './usageTracker';
import { TokenLedger } from './tokenLedger';
import { acquireLock, tryClaimSchedulerLeader, releaseSchedulerLeader } from './accountLock';
import { checkForUpdates } from './updater';
import { formatAccountLabel } from './importExportService';
import { isCnAccount, isEnterpriseAccount } from './domain';
import { t } from './i18n';

export interface SchedulerCoordinatorDeps {
  store: AccountStore;
  switcher: SeamlessSwitcher;
  checkinService: CheckinService;
  autoSwitcher: AutoSwitcher;
  checkinScheduler: CheckinScheduler;
  cooldownWatcher: CooldownLogWatcher;
  usageTracker: UsageTracker;
  tokenLedger?: TokenLedger;
  onStateUpdated: () => void;
  onNotify: (level: 'success' | 'error' | 'warn', message: string, detail?: string) => void;
  onRequestTaskRunAuto: () => Promise<void>;
  onPromptRestart: () => Promise<void>;
  onPromptElevation: (plan: any, acc: CodeBuddyAccount) => Promise<void>;
}

/**
 * 后台调度中枢协调器
 * 统一托管定时签到、4h 漏签兜底、额度守卫、60s 健康巡检、配额周期刷新、被动 429 联动、配置热更新及多窗口 Leader 选主。
 */
export class SchedulerCoordinator implements vscode.Disposable {
  private deps: SchedulerCoordinatorDeps;
  private startupTimers: NodeJS.Timeout[] = [];
  private checkinTimer: NodeJS.Timeout | null = null;
  private quotaRefreshTimer: NodeJS.Timeout | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private cleanups: Array<() => void> = [];
  private started = false;
  private disposed = false;
  private lastAutoRestartHintAt = 0;

  constructor(deps: SchedulerCoordinatorDeps) {
    this.deps = deps;
  }

  private bindEvent<T>(emitter: NodeJS.EventEmitter, event: string, handler: (...args: T[]) => void): void {
    emitter.on(event, handler);
    this.cleanups.push(() => emitter.removeListener(event, handler));
  }

  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;

    const { store, checkinService, autoSwitcher, checkinScheduler, cooldownWatcher, usageTracker, tokenLedger } = this.deps;
    const cfg = vscode.workspace.getConfiguration('buddyRelay');

    // 1. 绑定 Leader 检查到定点签到与 Token 全局刷新
    checkinScheduler.setLeaderCheck(() => tryClaimSchedulerLeader());
    autoSwitcher.setTokenRefreshLeaderCheck(() => tryClaimSchedulerLeader());

    // 2. 绑定 AutoSwitcher 自动轮换事件
    this.bindEvent<RotationEvent>(autoSwitcher, 'rotation', (ev) => {
      if (ev?.toUid) acquireLock(ev.toUid);
      const notifyEnabled = vscode.workspace.getConfiguration('buddyRelay').get<boolean>('autoSwitch.notifyOnSwitch', true);
      if (notifyEnabled) {
        const reasonText =
          ev.reason === 'rate_limited_429' ? t('msg.rotate429')
            : ev.reason === 'quota_exhausted' ? t('msg.rotateQuota')
            : t('msg.rotateSchedule');
        const targetLabel = formatAccountLabel(ev.targetAccount, store.getPrivacyMode?.() ?? false);
        this.deps.onNotify('success', t('msg.autoRotated', reasonText, targetLabel));
      }
      this.deps.onStateUpdated();
    });
    this.bindEvent(autoSwitcher, 'needs_restart', () => {
      const now = Date.now();
      if (now - this.lastAutoRestartHintAt >= 10 * 60 * 1000) {
        this.lastAutoRestartHintAt = now;
        void this.deps.onPromptRestart();
      }
    });
    this.bindEvent<any>(autoSwitcher, 'needs_elevation', (ev) => {
      const now = Date.now();
      if (now - this.lastAutoRestartHintAt >= 10 * 60 * 1000 && ev?.res?.elevationPlan) {
        this.lastAutoRestartHintAt = now;
        void this.deps.onPromptElevation(ev.res.elevationPlan, ev.targetAccount);
      }
    });
    this.bindEvent<any>(autoSwitcher, 'rotation_failed', (ev) => {
      const msg = ev?.res?.message || t('err.unknownError');
      console.warn(`[BuddyRelay][AutoSwitch] 自动切号未生效: ${msg}`);
      this.deps.onNotify('error', t('msg.switchFailed', msg), ev?.res?.detail);
    });

    // 3. 绑定宿主日志 429 冷却监听并打通 autoSwitch.on429 被动切换
    this.bindEvent(cooldownWatcher, 'change', () => this.deps.onStateUpdated());
    this.bindEvent<{ uid: string; model: string; resetAt: number; hitAt: number }>(
      cooldownWatcher,
      'rateLimit',
      (ev) => { void autoSwitcher.handlePassiveRateLimit(ev.uid, ev.model, ev.resetAt); }
    );
    this.bindEvent(cooldownWatcher, 'usageLog', () => {
      if (!tokenLedger || this.disposed) return;
      if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = setTimeout(() => {
        this.tokenRefreshTimer = null;
        if (this.disposed) return;
        void tokenLedger.getSummary(true).then(() => {
          if (!this.disposed) this.deps.onStateUpdated();
        }).catch(() => {});
      }, 800);
    });
    cooldownWatcher.start();

    if (tokenLedger) {
      this.startupTimers.push(setTimeout(() => {
        if (this.disposed) return;
        void tokenLedger.getSummary(false).then(() => {
          if (!this.disposed) this.deps.onStateUpdated();
        }).catch(() => {});
      }, 1200));
    }

    // 4. 定点签到调度器
    checkinScheduler.onScheduleSummary((success, total, awarded) => {
      this.deps.onNotify('success', t('msg.scheduledCheckinDone', success, total, awarded));
      if (awarded > 0) {
        usageTracker.recordAction({
          type: 'reward',
          accountId: 'batch',
          accountName: t('act.scheduler'),
          deltaCredits: awarded,
          title: t('act.scheduledCheckin'),
          detail: t('act.scheduledCheckinDetail', success, total, awarded)
        });
      }
      this.deps.onStateUpdated();
      if (vscode.workspace.getConfiguration('buddyRelay').get<boolean>('growthTasks.autoAfterCheckin', true)) {
        this.deps.onRequestTaskRunAuto().catch(() => {});
      }
    });
    if (cfg.get<boolean>('autoCheckin', true)) checkinScheduler.start();

    // 5. 启动时静默同步配额（仅 Leader）、漏签兜底（5s）与静默更新检查（8s）
    if (store.count() > 0) {
      this.startupTimers.push(setTimeout(() => {
        if (this.disposed || !tryClaimSchedulerLeader()) return;
        checkinService.batchSyncStatus(store.getAll(), store).then(() => this.deps.onStateUpdated()).catch(() => {});
      }, 2000));
    }
    if (cfg.get<boolean>('autoCheckin', true) && cfg.get<boolean>('autoCheckin.startupMakeup', true)) {
      this.startupTimers.push(setTimeout(async () => {
        if (!this.disposed && tryClaimSchedulerLeader()) await this.performDailyCheckinIfNeeded();
      }, 5000));
    }
    if (vscode.workspace.getConfiguration('buddyRelay.update').get<boolean>('autoCheck', true)) {
      this.startupTimers.push(setTimeout(() => {
        if (!this.disposed && tryClaimSchedulerLeader()) checkForUpdates(true).catch(() => {});
      }, 8000));
    }

    // 6. 每 4 小时跨天漏签守护
    this.checkinTimer = setInterval(async () => {
      const c = vscode.workspace.getConfiguration('buddyRelay');
      if (c.get<boolean>('autoCheckin', true) && c.get<boolean>('autoCheckin.startupMakeup', true)) {
        if (tryClaimSchedulerLeader()) await this.performDailyCheckinIfNeeded();
      }
    }, 4 * 60 * 60 * 1000);

    // 7. 额度守卫、60s 健康巡检与配额周期刷新
    this.syncQuotaGuardState();
    autoSwitcher.startMonitor(60 * 1000);
    this.rebuildQuotaRefreshTimer();
  }

  public onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void {
    if (this.disposed) return;

    if (e.affectsConfiguration('buddyRelay.refreshIntervalMinutes')) {
      this.rebuildQuotaRefreshTimer();
    }
    if (e.affectsConfiguration('buddyRelay.autoCheckin')) {
      const enabled = vscode.workspace.getConfiguration('buddyRelay').get<boolean>('autoCheckin', true);
      if (enabled) {
        this.deps.checkinScheduler.start();
        console.log('[BuddyRelay] 自动签到配置变更，调度器已重排');
      } else {
        this.deps.checkinScheduler.stop();
        console.log('[BuddyRelay] 自动签到已关闭，调度器停止');
      }
    }
    if (e.affectsConfiguration('buddyRelay.autoSwitch')) {
      this.syncQuotaGuardState();
      this.deps.autoSwitcher.getEffectiveStrategy();
      this.deps.onStateUpdated();
    }
  }

  private syncQuotaGuardState(): void {
    const getAutoSwitchConfig = () => {
      const cfg = vscode.workspace.getConfiguration('buddyRelay');
      if (!cfg.get<boolean>('autoSwitch.enabled', true)) return null;
      return {
        enabled: true,
        thresholdPercent: Math.max(0, Math.min(90, cfg.get<number>('autoSwitch.quotaThresholdPercent', 10))),
        cooldownMinutes: Math.max(1, cfg.get<number>('autoSwitch.cooldownMinutes', 5))
      };
    };

    if (vscode.workspace.getConfiguration('buddyRelay').get<boolean>('autoSwitch.enabled', true)) {
      this.deps.autoSwitcher.startQuotaGuard(getAutoSwitchConfig);
    } else {
      this.deps.autoSwitcher.stopQuotaGuard();
    }
  }

  private rebuildQuotaRefreshTimer(): void {
    if (this.quotaRefreshTimer) {
      clearInterval(this.quotaRefreshTimer);
      this.quotaRefreshTimer = null;
    }
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    const refreshMinutes = Math.max(5, cfg.get<number>('refreshIntervalMinutes', 15));
    this.quotaRefreshTimer = setInterval(async () => {
      if (this.disposed || !tryClaimSchedulerLeader()) return;
      try {
        const { store, checkinService, usageTracker } = this.deps;
        await checkinService.batchSyncStatus(store.getAll(), store);
        const active = store.getActive();
        if (active && active.totalCredits !== undefined) {
          usageTracker.recordSnapshot(active, active.totalCredits, t('ut.snapshotSource'));
        }
        this.deps.onStateUpdated();
      } catch {
        // 定时刷新失败不中断调度循环
      }
    }, refreshMinutes * 60 * 1000);
  }

  private async performDailyCheckinIfNeeded(): Promise<void> {
    const { store, checkinService } = this.deps;
    const today = todayCN();
    const needCheckin = store.getAll().filter(
      (acc) =>
        acc.status !== 'disabled' &&
        acc.status !== 'expired' &&
        !isEnterpriseAccount(acc) &&
        isCnAccount(acc.domain) &&
        (!acc.todayCheckedIn || acc.lastCheckinDate !== today)
    );
    if (needCheckin.length === 0) return;

    console.log(`[BuddyRelay] 自动签到任务启动: 发现 ${needCheckin.length} 个账号需完成今日签到`);
    try {
      const report = await checkinService.batchCheckin(needCheckin, store);
      if (report.successCount > 0) {
        console.log(`[BuddyRelay] 兜底签到完成，为 ${report.successCount} 个账号共新领 ${report.totalCreditsAwarded} 点算力`);
        this.deps.onStateUpdated();
      }
    } catch (err: any) {
      console.warn(`[BuddyRelay] 定时自动签到异常: ${err.message}`);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers = [];
    if (this.checkinTimer) {
      clearInterval(this.checkinTimer);
      this.checkinTimer = null;
    }
    if (this.quotaRefreshTimer) {
      clearInterval(this.quotaRefreshTimer);
      this.quotaRefreshTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    const { autoSwitcher, checkinScheduler, cooldownWatcher } = this.deps;
    checkinScheduler.setLeaderCheck(null);
    checkinScheduler.stop();
    autoSwitcher.setTokenRefreshLeaderCheck(null);
    autoSwitcher.stopMonitor();
    cooldownWatcher.stop();

    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];

    try { releaseSchedulerLeader(); } catch { /* 退出清理容错 */ }
  }
}
