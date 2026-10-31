import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CockpitImporter } from './cockpitImporter';
import { CheckinService } from './checkinService';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { AutoSwitcher } from './autoSwitcher';
import { CheckinScheduler } from './checkinScheduler';
import { OAuthService } from './oauthService';
import { StatusBarManager } from './statusBar';
import { SidebarProvider } from './sidebarProvider';
import { checkForUpdates } from './updater';
import { initAccountLock, acquireLock, releaseLock, startHeartbeat, stopHeartbeat } from './accountLock';
import { UsageTracker } from './usageTracker';
import { t, initI18n, watchLocaleConfig, onLangChange } from './i18n';
import { detectHostEdition } from './host';

let checkinTimer: NodeJS.Timeout | null = null;
let quotaRefreshTimer: NodeJS.Timeout | null = null;
let checkinScheduler: CheckinScheduler | null = null;
let statusBarManager: StatusBarManager | null = null;
let autoSwitcherInstance: AutoSwitcher | null = null;
let usageTrackerInstance: UsageTracker | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[BuddyRelay] 正在启动会话保护与交互体系...');

  // 0. 国际化初始化 (buddyRelay.locale 配置优先, auto 时跟随 IDE 显示语言)
  initI18n();

  // 1. 初始化核心存储与调度服务
  const store = new AccountStore(context);
  context.subscriptions.push({ dispose: () => store.dispose() });
  const switcher = new SeamlessSwitcher();
  const oauthService = new OAuthService();
  const checkinService = new CheckinService();
  const importer = new CockpitImporter();
  const usageTracker = new UsageTracker();
  usageTrackerInstance = usageTracker;
  const autoSwitcher = new AutoSwitcher(store, switcher, oauthService, { usageTracker });
  autoSwitcherInstance = autoSwitcher;
  const checkinScheduler = new CheckinScheduler(store, checkinService);

  // 1.5 跨窗口账号锁：初始化并为当前活跃账号持锁 (心跳自动续期，退出释放)
  const windowName = t('common.window', vscode.env.sessionId.slice(0, 8).toUpperCase());
  initAccountLock(`${vscode.env.sessionId}:${process.pid}`, windowName);
  let lastLockedUid: string | null = store.getActive()?.uid || null;
  if (lastLockedUid) {
    acquireLock(lastLockedUid);
  }
  startHeartbeat();
  // 活跃账号变更时跟随迁移锁（含本窗口切换与外部窗口切换后的状态重载）
  store.on('change', () => {
    const uid = store.getActive()?.uid || null;
    if (uid !== lastLockedUid) {
      lastLockedUid = uid;
      if (uid) {
        acquireLock(uid);
      } else {
        releaseLock();
      }
    }
  });

  // 1.8 检查是否默认开启隐私脱敏模式
  const defaultPrivacy = vscode.workspace.getConfiguration('buddyRelay').get<boolean>('privacyModeDefault', false);
  if (defaultPrivacy && !store.getPrivacyMode()) {
    store.setPrivacyMode(true).catch(() => {});
  }

  // 2. 初始化界面体系：左下角常驻状态栏与侧栏 Webview
  statusBarManager = new StatusBarManager(store, switcher);
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    store,
    switcher,
    checkinService,
    importer,
    oauthService,
    usageTracker
  );

  // 注册 Webview 视图提供者
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    ),
    statusBarManager,
    watchLocaleConfig()
  );

  // 语言切换联动：状态栏立即重渲染，侧栏整页重载（字典与静态文案随 HTML 重注入）
  onLangChange(() => {
    statusBarManager?.update();
    sidebarProvider.reloadWebview();
  });

  // 3. 自愈检查 main.js Patch v4
  try {
    const patchRes = switcher.healPatch();
    if (patchRes.success) {
      console.log(`[BuddyRelay] ${patchRes.message}`);
    } else {
      console.warn(`[BuddyRelay] Patch 自愈提示: ${patchRes.message}`);
    }
  } catch (err: any) {
    console.warn(`[BuddyRelay] Patch v4 自检异常: ${err.message}`);
  }

  // 4. 初次启动号池打底检测：若为空则尝试自动导入 Cockpit Tools
  if (store.count() === 0) {
    try {
      const verify = importer.verifyCockpitStorage();
      if (verify.hasKey && verify.accountFilesCount > 0) {
        const importRes = await importer.importToStore(store);
        if (importRes.success) {
          sidebarProvider.sendNotify(
            'success',
            t('msg.autoImported', importRes.decryptedCount)
          );
          checkinService.batchSyncStatus(store.getAll(), store).catch(() => {});
        }
      }
    } catch (_) {}
  } else {
    // 号池非空时，静默后台同步一次各账号配额与签到状态
    setTimeout(() => {
      checkinService.batchSyncStatus(store.getAll(), store).catch(() => {});
    }, 2000);
  }

  // 5. 注册命令列表
  // (1) 状态栏点击弹出 QuickPick
  const showQuickPickCmd = vscode.commands.registerCommand(
    'buddy-relay.showAccountQuickPick',
    async () => {
      if (statusBarManager) {
        await statusBarManager.showQuickPick();
      }
    }
  );

  // (2) 切换账号 (兼容命令行参数与 QuickPick 唤起)
  const switchAccountCmd = vscode.commands.registerCommand(
    'buddy-relay.switchAccount',
    async (accountOrId?: CodeBuddyAccount | string) => {
      if (!accountOrId) {
        if (statusBarManager) {
          await statusBarManager.showQuickPick();
        }
        return;
      }

      let target: CodeBuddyAccount | undefined;
      if (typeof accountOrId === 'string') {
        target = store.get(accountOrId) || store.find(accountOrId);
      } else {
        target = accountOrId;
      }

      if (!target) {
        vscode.window.showErrorMessage(t('err.accountNotFound'));
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('msg.switchingTo', target.nickname || target.email),
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: t('msg.progressPatch') });
          const res = await switcher.switchAccount(target!, store);
          if (res.success) {
            sidebarProvider.sendNotify(
              'success',
              t('msg.switched', target!.nickname || target!.email)
            );
          } else {
            sidebarProvider.sendNotify('error', t('msg.switchFailed', res.message));
          }
        }
      );
    }
  );

  // (3) 一键签到
  const checkinCmd = vscode.commands.registerCommand('buddy-relay.checkin', async () => {
    await sidebarProvider.handleBatchCheckin();
  });

  // (4) 从 Cockpit 导入
  const importCockpitCmd = vscode.commands.registerCommand(
    'buddy-relay.importCockpit',
    async () => {
      await sidebarProvider.handleImportCockpit();
    }
  );

  // (5) 添加账号 (OAuth)
  const addAccountOAuthCmd = vscode.commands.registerCommand(
    'buddy-relay.addAccountOAuth',
    async () => {
      await sidebarProvider.handleAddAccountOAuth();
    }
  );

  // (6) 删除账号
  const deleteAccountCmd = vscode.commands.registerCommand(
    'buddy-relay.deleteAccount',
    async (accountOrId?: CodeBuddyAccount | string) => {
      if (accountOrId) {
        const id = typeof accountOrId === 'string' ? accountOrId : accountOrId.id;
        await sidebarProvider.handleDeleteAccount(id);
      }
    }
  );

  // (7) 刷新状态
  const refreshStatusCmd = vscode.commands.registerCommand(
    'buddy-relay.refreshStatus',
    async () => {
      await sidebarProvider.handleRefreshStatus();
    }
  );

  // (8) 检查更新
  const checkUpdateCmd = vscode.commands.registerCommand(
    'buddy-relay.checkUpdate',
    async () => {
      await checkForUpdates(false);
    }
  );

  context.subscriptions.push(
    showQuickPickCmd,
    switchAccountCmd,
    checkinCmd,
    importCockpitCmd,
    addAccountOAuthCmd,
    deleteAccountCmd,
    refreshStatusCmd,
    checkUpdateCmd
  );

  // 6. 启动时后台静默检查更新 (延迟 8 秒，避免抢占启动资源)
  const updateCfg = vscode.workspace.getConfiguration('buddyRelay.update');
  if (updateCfg.get<boolean>('autoCheck', true)) {
    setTimeout(() => {
      checkForUpdates(true).catch(() => {});
    }, 8000);
  }

  // 7. 自动轮换事件 → webview toast 通知
  autoSwitcher.on('rotation', (ev: any) => {
    const notifyEnabled = vscode.workspace
      .getConfiguration('buddyRelay')
      .get<boolean>('autoSwitch.notifyOnSwitch', true);
    if (notifyEnabled) {
      const reasonText =
        ev.reason === 'rate_limited_429'
          ? t('msg.rotate429')
          : ev.reason === 'quota_exhausted'
          ? t('msg.rotateQuota')
          : t('msg.rotateSchedule');
      sidebarProvider.sendNotify(
        'success',
        t('msg.autoRotated', reasonText, ev.targetAccount.nickname || ev.targetAccount.email)
      );
    }
    statusBarManager?.update();
    sidebarProvider.postStateToWebview();
  });

  // 7. 定时任务：定点自动签到 + 额度守卫自动切换 + 配额刷新
  setupScheduledTasks(store, checkinService, autoSwitcher, checkinScheduler, sidebarProvider, usageTracker);

  console.log('[BuddyRelay] 界面与调度体系已就绪');
}

/**
 * 配置定时自动签到（Cockpit Tools 式定点+随机抖动）与额度守卫自动切换
 */
function setupScheduledTasks(
  store: AccountStore,
  checkinService: CheckinService,
  autoSwitcher: AutoSwitcher,
  checkinScheduler: CheckinScheduler,
  sidebarProvider: SidebarProvider,
  usageTracker?: UsageTracker
): void {
  const config = vscode.workspace.getConfiguration('buddyRelay');

  // 1. 定点签到调度器（每日 HH:mm + 随机抖动 + 拟人化间隔）
  checkinScheduler.onScheduleSummary((success, total, awarded) => {
    sidebarProvider.sendNotify(
      'success',
      t('msg.scheduledCheckinDone', success, total, awarded)
    );
    if (awarded > 0 && usageTracker) {
      usageTracker.recordAction({
        type: 'reward',
        accountId: 'batch',
        accountName: t('act.scheduler'),
        deltaCredits: awarded,
        title: t('act.scheduledCheckin'),
        detail: t('act.scheduledCheckinDetail', success, total, awarded)
      });
    }
    statusBarManager?.update();
    sidebarProvider.postStateToWebview();
    // 签到完成后顺手跑一轮成长任务（报名+领奖），配置可关
    if (
      vscode.workspace
        .getConfiguration('buddyRelay')
        .get<boolean>('growthTasks.autoAfterCheckin', true)
    ) {
      sidebarProvider.handleTaskRunAuto().catch(() => {});
    }
  });
  if (config.get<boolean>('autoCheckin', true)) {
    checkinScheduler.start();
  }

  // 2. 启动时漏签兜底（覆盖"关机错过定点"的场景）
  if (config.get<boolean>('autoCheckin', true) && config.get<boolean>('autoCheckin.startupMakeup', true)) {
    setTimeout(async () => {
      await performDailyCheckinIfNeeded(store, checkinService);
    }, 5000);
  }

  // 3. 每 4 小时跨天漏签守护（兜底中的兜底）
  checkinTimer = setInterval(async () => {
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    if (cfg.get<boolean>('autoCheckin', true) && cfg.get<boolean>('autoCheckin.startupMakeup', true)) {
      await performDailyCheckinIfNeeded(store, checkinService);
    }
  }, 4 * 60 * 60 * 1000);

  // 4. 额度守卫：当前账号算力占比 ≤ 阈值时自动无感切换（配置驱动）
  const getAutoSwitchConfig = () => {
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    if (!cfg.get<boolean>('autoSwitch.enabled', true)) {
      return null;
    }
    return {
      enabled: true,
      thresholdPercent: Math.max(
        0,
        Math.min(90, cfg.get<number>('autoSwitch.quotaThresholdPercent', 10))
      ),
      cooldownMinutes: Math.max(
        1,
        cfg.get<number>('autoSwitch.cooldownMinutes', 5)
      )
    };
  };
  autoSwitcher.startQuotaGuard(getAutoSwitchConfig);

  // 5. 健康巡检（429 冷却恢复 + Token 临期自动刷新）
  autoSwitcher.startMonitor(60 * 1000);

  // 6. 定时配额与状态刷新任务
  const refreshMinutes = Math.max(
    5,
    config.get<number>('refreshIntervalMinutes', 15)
  );
  quotaRefreshTimer = setInterval(async () => {
    try {
      const active = store.getActive();
      if (active) {
        await checkinService.syncAccountStatus(active, store);
        const refreshed = store.get(active.id);
        if (refreshed && refreshed.totalCredits !== undefined && usageTracker) {
          usageTracker.recordSnapshot(refreshed, refreshed.totalCredits, t('ut.snapshotSource'));
        }
      }
      statusBarManager?.update();
    } catch (_) {}
  }, refreshMinutes * 60 * 1000);

  // 7. 配置热更新：签到配置变化时重排调度器
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('buddyRelay.autoCheckin')) {
      const cfg = vscode.workspace.getConfiguration('buddyRelay');
      if (cfg.get<boolean>('autoCheckin', true)) {
        checkinScheduler.start();
        console.log('[BuddyRelay] 自动签到配置变更，调度器已重排');
      } else {
        checkinScheduler.stop();
        console.log('[BuddyRelay] 自动签到已关闭，调度器停止');
      }
    }
  });
}

/**
 * 检查今日是否有未签到账号并自动执行签到
 */
async function performDailyCheckinIfNeeded(
  store: AccountStore,
  checkinService: CheckinService
): Promise<void> {
  const accounts = store.getAll();
  const today = new Date().toISOString().slice(0, 10);
  const needCheckin = accounts.filter(
    (acc) =>
      acc.status !== 'disabled' &&
      acc.status !== 'expired' &&
      (!acc.todayCheckedIn || acc.lastCheckinDate !== today)
  );

  if (needCheckin.length === 0) {
    return;
  }

  console.log(`[BuddyRelay] 自动签到任务启动: 发现 ${needCheckin.length} 个账号需完成今日签到`);
  try {
    const report = await checkinService.batchCheckin(needCheckin, store);
    if (report.successCount > 0) {
      console.log(
        `[BuddyRelay] 兜底签到完成，为 ${report.successCount} 个账号共新领 ${report.totalCreditsAwarded} 点算力`
      );
    }
    statusBarManager?.update();
  } catch (err: any) {
    console.warn(`[BuddyRelay] 定时自动签到异常: ${err.message}`);
  }
}

export function deactivate() {
  if (checkinTimer) {
    clearInterval(checkinTimer);
    checkinTimer = null;
  }
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer);
    quotaRefreshTimer = null;
  }
  if (checkinScheduler) {
    checkinScheduler.stop();
    checkinScheduler = null;
  }
  if (autoSwitcherInstance) {
    autoSwitcherInstance.stopMonitor();
    autoSwitcherInstance = null;
  }
  if (statusBarManager) {
    statusBarManager.dispose();
    statusBarManager = null;
  }
  // 跨窗口账号锁：退出时释放本窗口持有并停止心跳
  try {
    releaseLock();
    stopHeartbeat();
  } catch (_) {}
}
