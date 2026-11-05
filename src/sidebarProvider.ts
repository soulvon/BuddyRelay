import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount, QuotaPackageItem, maskName, maskUid } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { CheckinService, isTodayCheckedIn } from './checkinService';
import { CockpitImporter } from './cockpitImporter';
import { OAuthService } from './oauthService';
import { GrowthTaskService, GrowthTask } from './growthTaskService';
import { getOtherLockedUids } from './accountLock';
import { buildDiagnostic, showFailureWithActions, copyDiagnostic, openIssueReport } from './diagnostics';
import { checkForUpdates, getCurrentVersion } from './updater';
import { UsageTracker } from './usageTracker';
import { t, getLangDict } from './i18n';
import { detectHostEdition } from './host';
import { isCnAccount } from './domain';
import { readHostLoginUid } from './hostSession';
import { PATHS } from './constants';
import { loadCooldownEvents } from './cooldownLogWatcher';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'buddy-relay.sidebarView';

  private _view?: vscode.WebviewView;
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private checkinService: CheckinService;
  private importer: CockpitImporter;
  private oauthService: OAuthService;
  private growthTasks: GrowthTaskService;
  private usageTracker?: UsageTracker;
  private extensionUri: vscode.Uri;
  private isOperating: boolean = false;
  private currentOperationMessage: string = '';
  private _abortTaskBatch: boolean = false;

  constructor(
    extensionUri: vscode.Uri,
    store: AccountStore,
    switcher: SeamlessSwitcher,
    checkinService: CheckinService,
    importer: CockpitImporter,
    oauthService: OAuthService,
    usageTracker?: UsageTracker
  ) {
    this.extensionUri = extensionUri;
    this.store = store;
    this.switcher = switcher;
    this.checkinService = checkinService;
    this.importer = importer;
    this.oauthService = oauthService;
    this.usageTracker = usageTracker;
    this.growthTasks = new GrowthTaskService();

    // 监听号池状态变化并主动推流给 Webview
    this.store.on('change', () => {
      this.postStateToWebview();
    });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // 注册 Webview 消息分发中枢
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'webviewReady':
          this.postStateToWebview();
          break;

        case 'switchAccount':
          await this.handleSwitchAccount(message.accountId);
          break;

        case 'runDoctor':
          await this.handleRunDoctor();
          break;

        case 'restartApp':
          await this.handleRestartApp();
          break;

        case 'checkinAccount':
          await this.handleCheckinAccount(message.accountId);
          break;

        case 'deleteAccount':
          await this.handleDeleteAccount(String(message.accountId), message.confirmed === true);
          break;

        case 'addAccountOAuth':
          await this.handleAddAccountOAuth();
          break;

        case 'importCockpit':
          await this.handleImportCockpit();
          break;

        case 'batchCheckin':
          await this.handleBatchCheckin();
          break;

        case 'refreshStatus':
          await this.handleRefreshStatus();
          break;

        case 'refreshModelStats':
          await this.handleRefreshModelStats(Number(message.days) || 7, message.force === true);
          break;

        case 'importJson':
          await this.handleImportJson(String(message.text || ''));
          break;

        case 'importLocal':
          await this.handleImportLocal();
          break;

        case 'taskList':
          await this.handleTaskList(
            message.accountId ? String(message.accountId) : undefined
          );
          break;

        case 'taskRunAuto':
          await this.handleTaskRunAuto(
            Array.isArray(message.accountIds) ? message.accountIds.map(String) : null
          );
          break;

        case 'taskAcceptAll':
          await this.handleTaskAcceptAll(
            Array.isArray(message.accountIds) ? message.accountIds.map(String) : null
          );
          break;

        case 'taskClaim':
          await this.handleTaskClaim(
            String(message.taskCode || ''),
            message.accountId ? String(message.accountId) : undefined
          );
          break;

        case 'taskStop':
          this._abortTaskBatch = true;
          this.sendNotify('error', t('msg.stopRequested'));
          break;

        case 'togglePrivacyMode':
          await this.store.setPrivacyMode(Boolean(message.enabled));
          break;

        case 'toggleAccountStatus':
          await this.handleToggleAccountStatus(String(message.accountId));
          break;

        case 'importAccountsFile':
          await this.handleImportAccountsFile();
          break;

        case 'saveSettings':
          await this.handleSaveSettings(message.settings);
          break;

        case 'checkUpdate':
          await checkForUpdates(false);
          break;

        case 'exportAccounts':
          await this.handleExportAccounts(message.mode);
          break;

        case 'reauthAccount':
          await this.handleReauthAccount(String(message.accountId));
          break;

        case 'updateNotes':
          await this.handleUpdateNotes(String(message.accountId), String(message.notes || ''));
          break;

        case 'updateTags':
          await this.handleUpdateTags(String(message.accountId), Array.isArray(message.tags) ? message.tags : []);
          break;

        case 'clearUsage':
          this.usageTracker?.clearRecords();
          this.sendNotify('success', t('msg.usageCleared'));
          this.postStateToWebview();
          break;

        case 'copyText':
          await copyDiagnostic(String(message.text || ''));
          break;

        case 'reportIssue':
          await openIssueReport(String(message.text || ''));
          break;
      }
    });

    // 每次面板由隐藏变可见时同步最新状态
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postStateToWebview();
      }
    });
  }

  /**
   * 向 Webview 推送全量号池与调度状态
   */
  public postStateToWebview(): void {
    if (!this._view) {
      return;
    }

    const accounts = this.store.getAll();
    const active = this.store.getActive();
    const checkedTodayCount = accounts.filter((a) => isTodayCheckedIn(a)).length;
    const totalCredits = accounts.reduce(
      (sum, acc) => sum + (acc.totalCredits || 0),
      0
    );
    // 跨窗口占用：其他存活窗口正持有的账号（排除当前活跃号）
    const activeUid = active?.uid || '';
    const lockedUids = Array.from(getOtherLockedUids()).filter(u => u !== activeUid);

    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    const settings = {
      autoCheckin: cfg.get<boolean>('autoCheckin', true),
      dailyTime: cfg.get<string>('autoCheckin.dailyTime', '00:10'),
      randomJitterMinutes: cfg.get<number>('autoCheckin.randomJitterMinutes', 30),
      perAccountDelaySeconds: cfg.get<number>('autoCheckin.perAccountDelaySeconds', 15),
      refreshIntervalMinutes: cfg.get<number>('refreshIntervalMinutes', 15),
      growthTasksAutoAfterCheckin: cfg.get<boolean>('growthTasks.autoAfterCheckin', true),
      startupMakeup: cfg.get<boolean>('autoCheckin.startupMakeup', true),
      autoUseMakeupCard: cfg.get<boolean>('growthTasks.autoUseMakeupCard', true),
      autoSwitchEnabled: cfg.get<boolean>('autoSwitch.enabled', true),
      quotaThresholdPercent: cfg.get<number>('autoSwitch.quotaThresholdPercent', 10),
      autoSwitchStrategy: cfg.get<string>('autoSwitch.strategy', 'highest_quota'),
      cooldownMinutes: cfg.get<number>('autoSwitch.cooldownMinutes', 5),
      autoSwitchOn429: cfg.get<boolean>('autoSwitch.on429', true),
      autoSwitchNotify: cfg.get<boolean>('autoSwitch.notifyOnSwitch', true),
      privacyModeDefault: cfg.get<boolean>('privacyModeDefault', false),
      updateAutoCheck: cfg.get<boolean>('update.autoCheck', true),
      updateAutoInstall: cfg.get<boolean>('update.autoInstall', false),
      locale: cfg.get<string>('locale', 'auto')
    };

    // 今日统计：自动路径只查余额发生变化的账号，节流与退避由 UsageTracker 内部负责
    this.refreshUsageStats(false);

    const enabledAccountCount = accounts.filter((a) => a.status !== 'disabled').length;

    const usageSummary = this.usageTracker?.getDailySummary(enabledAccountCount);

    // 模型级冷却与账号级 rateLimitUntil 是两套独立状态：某个模型撞限流不代表
    // 账号整体不可用（宿主本身就允许切换到其他模型继续使用）。
    let cooldownEvents: ReturnType<typeof loadCooldownEvents> | null = null;
    let cooldownEventsError = '';
    try {
      cooldownEvents = loadCooldownEvents();
    } catch (err: any) {
      cooldownEventsError = String(err && err.message ? err.message : err);
    }

    this._view.webview.postMessage({
      command: 'updateState',
      data: {
        accounts: accounts.map((acc) => {
          const actRemain = typeof acc.totalCredits === 'number' ? acc.totalCredits : 0;
          const basePkg: QuotaPackageItem = acc.basePackage || {
            title: t('pkg.base'),
            count: 1,
            remain: 0,
            total: 500,
            percent: 0
          };

          const actPkg: QuotaPackageItem = acc.activityPackage || {
            title: t('pkg.activity'),
            count: 30,
            remain: actRemain,
            total: 3000,
            percent: actRemain > 0 ? Math.min(100, Math.round((actRemain / 3000) * 100)) : 0
          };

          return {
            id: acc.id,
            uid: acc.uid,
            email: acc.email,
            nickname: acc.nickname || acc.email,
            paymentType: acc.paymentType || 'free',
            status: acc.status,
            isActive: active ? active.id === acc.id : false,
            totalCredits: acc.totalCredits ?? 0,
            todayConsumed: usageSummary?.perAccountConsumed[acc.id] ?? 0,
            todayGrants: usageSummary?.perAccountGrants[acc.id] ?? 0,
            basePackage: basePkg,
            activityPackage: actPkg,
            checkinStreak: acc.checkinStreak ?? 0,
            todayCheckedIn: isTodayCheckedIn(acc),
            rateLimitUntil: acc.rateLimitUntil,
            lastUsed: acc.lastUsed,
            notes: acc.notes || '',
            tags: Array.isArray(acc.tags) ? acc.tags : []
          };
        }),
        activeId: active?.id || null,
        stats: {
          total: accounts.length,
          activeCount: accounts.filter((a) => a.status === 'active').length,
          idleCount: accounts.filter((a) => a.status === 'idle').length,
          rateLimitedCount: accounts.filter((a) => a.status === 'rate_limited').length,
          disabledCount: accounts.filter((a) => a.status === 'disabled').length,
          checkedTodayCount,
          totalCredits
        },
        settings,
        isOperating: this.isOperating,
        operationMessage: this.currentOperationMessage,
        privacyMode: this.store.getPrivacyMode(),
        lockedUids,
        version: getCurrentVersion(),
        hostEdition: detectHostEdition(),
        allTags: this.store.getAllTags(),
        usageSummary,
        recentRecords: this.usageTracker?.getRecentOfficialRequests(60) || [],
        modelStats: this.usageTracker?.getModelStatsSnapshot() || null,
        cooldownEvents,
        cooldownEventsError
      }
    });
  }

  /**
   * 1. 切换账号
   */
  public async handleSwitchAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      this.sendNotify('error', t('err.targetMissing'));
      return;
    }

    this.setOperating(true, t('msg.switchingTo', target.nickname || target.email));

    try {
      const res = await this.switcher.switchAccount(target, this.store);
      if (res.needsFullRestart) {
        // 补丁本次重打：指令已就位，重启后自动完成切号。模态框引导用户一键完全退出
        await this.promptFullRestart();
        return;
      }
      if (res.success) {
        this.sendNotify('success',
          t('msg.switched', target.nickname || target.email)
        );
      } else {
        // 切号失败自动跑链路自检：可引导的直接弹重启模态框，其余原样报错
        const doc = this.switcher.runDoctor();
        if (doc.status === 'needs_full_restart' || doc.status === 'repaired_needs_full_restart') {
          await this.promptFullRestart();
          return;
        }
        this.notifySwitchFailure(t('err.switchAbnormal', res.message), res.detail);
      }
    } catch (err: any) {
      this.notifySwitchFailure(t('err.switchFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 链路自检入口（工具栏按钮）：按检查结果分派处理
   */
  public async handleRunDoctor(): Promise<void> {
    const doc = this.switcher.runDoctor();
    if (doc.status === 'healthy') {
      this.sendNotify('success', doc.message);
      return;
    }
    if (doc.status === 'needs_full_restart' || doc.status === 'repaired_needs_full_restart') {
      await this.promptFullRestart();
      return;
    }
    this.sendNotify('error', doc.message);
  }

  /**
   * 完全重启引导：确认/取消，确认则直接帮用户退出整个应用。
   * 仅在补丁安装/升级后需要一次；之后切号均为无感热切，不再弹出。
   */
  private async promptFullRestart(): Promise<void> {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ command: 'showRestartModal' });
  }

  /**
   * 一键自动重启：派脱离助手进程等主进程退出后拉起 CodeBuddy，再发起退出。
   * 用户点确认即完成"退出 + 重新打开"，无需自己找图标。
   */
  public async handleRestartApp(): Promise<void> {
    this.spawnRestartHelper();
    await vscode.commands.executeCommand('workbench.action.quit');
  }

  /**
   * 派发完全重启助手（detached，主进程退出后自动拉起宿主）。
   * helper 以 ELECTRON_RUN_AS_NODE 运行（同 execPath 的 Node 模式），
   * 轮询主进程 PID（扩展宿主的父进程）消失后启动宿主可执行文件。
   */
  private spawnRestartHelper(): void {
    try {
      const dir = PATHS.RELAY_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const helperPath = path.join(dir, 'restart-helper.js');
      const logPath = path.join(dir, 'restart-helper.log').replace(/\\/g, '\\\\');
      fs.writeFileSync(helperPath, [
        "const { spawn } = require('child_process');",
        "const fs = require('fs');",
        'const pid = Number(process.argv[2]);',
        'const exe = process.argv[3];',
        `const logPath = '${logPath}';`,
        "const log = m => { try { fs.appendFileSync(logPath, Date.now() + ' ' + m + '\\n'); } catch (_) {} };",
        "log('wait pid=' + pid + ' exe=' + exe);",
        'const t0 = Date.now();',
        'const timer = setInterval(() => {',
        '  let alive = true;',
        '  try { process.kill(pid, 0); } catch { alive = false; }',
        '  if (alive && Date.now() - t0 < 120000) return;',
        '  clearInterval(timer);',
        '  if (!alive) {',
        '    setTimeout(() => {',
        "      try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); log('relaunched'); }",
        "      catch (e) { log('relaunch-failed ' + e.message); }",
        '      process.exit(0);',
        '    }, 800);',
        '  } else {',
        "    log('timeout waiting exit');",
        '    process.exit(0);',
        '  }',
        '}, 400);',
        ''
      ].join('\n'), 'utf8');

      const exe = process.execPath;
      const child = child_process.spawn(exe, [helperPath, String(process.ppid), exe], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      child.unref();
    } catch (_) {
      // 助手派发失败不阻断退出：最坏情况用户需手动重新打开
    }
  }

  /**
   * 2. 单账号签到
   */
  public async handleCheckinAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      return;
    }

    this.setOperating(true, t('msg.checkingInFor', target.nickname || target.email));
    try {
      const res = await this.checkinService.checkinAccount(target, this.store);
      if (res.success) {
        this.sendNotify('success',
          `[${target.nickname || target.email}] ${res.message}`
        );
      } else {
        this.sendNotify('error',
          `[${target.nickname || target.email}] ${t('err.checkinFailed', res.error || res.message)}`
        );
      }
    } catch (err: any) {
      this.sendNotify('error', t('err.checkinError', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 3. 一键全员签到
   */
  public async handleBatchCheckin(): Promise<void> {
    const accounts = this.store.getAll();
    if (accounts.length === 0) {
      this.sendNotify('success', t('msg.poolEmpty'));
      return;
    }

    this.setOperating(true, t('msg.batchCheckinRunning', accounts.length));
    try {
      const report = await this.checkinService.batchCheckin(accounts, this.store);
      this.sendNotify('success',
        t('msg.batchCheckinDone', report.totalCreditsAwarded, report.successCount, report.alreadyCheckedInCount, report.failedCount)
      );
    } catch (err: any) {
      this.sendNotify('error', t('err.batchCheckinError', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 4. 从 Cockpit 导入账号
   */
  public async handleImportCockpit(): Promise<void> {
    this.setOperating(true, t('msg.scanningCockpit'));
    try {
      const res = await this.importer.importToStore(this.store);
      if (res.success) {
        this.sendNotify('success',
          t('msg.cockpitImported', res.decryptedCount)
        );
        this.checkinService.batchSyncStatus(this.store.getAll(), this.store).catch(() => {});
      } else {
        this.sendNotify('error', t('msg.cockpitPartial', res.decryptedCount, res.totalFound));
      }
    } catch (err: any) {
      this.sendNotify('error', t('err.cockpitImportError', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 5. 官方 OAuth 登录添加账号
   */
  public async handleAddAccountOAuth(): Promise<void> {
    this.setOperating(true, t('msg.requestingOAuth'));
    try {
      const account = await this.oauthService.loginAndSave(this.store, {
        onAuthUrl: (url) => {
          // 唤起系统默认浏览器打开官方授权页
          vscode.env.openExternal(vscode.Uri.parse(url));
          this.setOperating(true, t('msg.oauthPageOpened'));
        }
      });
      this.sendNotify('success',
        t('msg.oauthSuccess', account.nickname || account.email)
      );
      this.checkinService.syncAccountStatus(account, this.store).catch(() => {});
    } catch (err: any) {
      this.sendNotify('error', t('err.oauthFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 6. 删除账号
   */
  public async handleDeleteAccount(accountId: string, confirmed: boolean = false): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      return;
    }

    if (!confirmed) {
      const confirmBtn = t('ui.confirmRemoveBtn');
      const confirm = await vscode.window.showWarningMessage(
        t('ui.confirmRemove', target.nickname || target.email),
        { modal: true },
        confirmBtn
      );
      if (confirm !== confirmBtn) {
        return;
      }
    }

    await this.store.delete(accountId);
    this.sendNotify('success', t('msg.accountRemoved', target.nickname || target.email));
  }

  /**
   * 7. 刷新状态与额度
   */
  /**
   * 今日统计拉取：自动路径只查余额变化的号；手动刷新强制重拉全部有凭证的号。
   * 请求节流（自动 3 分钟 / 手动 10 秒）与失败退避由 UsageTracker 内部跨窗口共享。
   */
  private refreshUsageStats(force: boolean): void {
    if (!this.usageTracker) {
      return;
    }
    const usageItems = this.store
      .getAll()
      .filter((a) => typeof a.totalCredits === 'number')
      .map((a) => ({
        id: a.id,
        credits: a.totalCredits as number,
        token: a.accessToken || '',
        uid: a.uid || ''
      }));
    const changedIds = new Set(this.usageTracker.detectChangedAccounts(usageItems) || []);
    const eligible = usageItems.filter((i) => i.token && i.uid);
    const targets = force ? eligible : eligible.filter((i) => changedIds.has(i.id));
    if (!targets.length) {
      return;
    }
    void this.usageTracker
      .refreshOfficialStats(targets, { force })
      .then((changed) => {
        if (changed) {
          this.postStateToWebview();
        }
      })
      .catch(() => {});
    // 模型用量统计跟随刷新（内部自带 3 分钟节流与历史天一次性同步，重复调度无害）
    void this.usageTracker
      .refreshModelStats(eligible, { force })
      .then((changed) => {
        if (changed) {
          this.postStateToWebview();
        }
      })
      .catch(() => {});
  }

  /**
   * 模型用量统计拉取（侧栏切换时间范围或手动刷新时触发）
   * 历史天按账号一次性同步，之后只补今天；完成后推送最新快照
   */
  private async handleRefreshModelStats(days: number, force: boolean): Promise<void> {
    if (!this.usageTracker) {
      return;
    }
    const eligible = this.store
      .getAll()
      .filter((a) => a.accessToken && a.uid)
      .map((a) => ({ id: a.id, token: a.accessToken || '', uid: a.uid || '' }));
    if (!eligible.length) {
      return;
    }
    try {
      const changed = await this.usageTracker.refreshModelStats(eligible, { days, force });
      if (changed) {
        this.postStateToWebview();
      }
    } catch (err: any) {
      console.warn('[SidebarProvider] 模型统计拉取失败:', err.message);
    }
  }

  public async handleRefreshStatus(): Promise<void> {
    this.setOperating(true, t('msg.refreshing'));
    try {
      await this.checkinService.batchSyncStatus(this.store.getAll(), this.store);
      // 手动刷新认定"用户要看最新"：强制重拉今日明细，避免被自动节流吞成无变化
      this.refreshUsageStats(true);
      this.sendNotify('success', t('msg.refreshDone'));
    } catch (err: any) {
      this.sendNotify('error', t('err.refreshFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 批量执行进度推流（模态框进度区逐号一行）
   */
  private sendTaskProgress(
    text: string,
    level: 'doing' | 'ok' | 'fail',
    percent?: number,
    accountIndex?: number,
    totalAccounts?: number
  ): void {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({
      command: 'taskProgress',
      text,
      level,
      percent: typeof percent === 'number' ? percent : undefined,
      accountIndex,
      totalAccounts
    });
  }

  /**
   * 批量执行结果统计推流（驱动独立进度弹窗切换至统计卡片）
   */
  private sendTaskBatchSummary(summary: {
    mode: 'auto' | 'accept';
    totalAccounts: number;
    processedAccounts: number;
    stopped: boolean;
    durationSec: number;
    totalAccepted: number;
    totalClaimed: number;
    totalCredits: number;
    totalEnergy: number;
    totalSkipped: number;
    totalFailures: number;
    details: Array<{ accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string }>;
  }): void {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({
      command: 'taskBatchSummary',
      data: summary
    });
  }

  private async cancellableSleep(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this._abortTaskBatch) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  private sleep(ms: number): Promise<void> {
    return this.cancellableSleep(ms);
  }

  /**
   * 拉取指定账号（或激活账号）成长任务列表并推流给 Webview
   */
  public async handleTaskList(accountId?: string): Promise<void> {
    let target = accountId ? this.store.get(accountId) : null;
    if (!target) {
      target = this.store.getActive() || this.store.getAll()[0];
    }
    if (!target) {
      this.sendNotify('error', t('msg.poolEmpty'));
      return;
    }
    const name = target.nickname || target.email;
    this.setOperating(true, t('msg.readingTasksFor', name));
    try {
      const sourceErrors: string[] = [];
      const [tasks, assetSummary] = await Promise.all([
        this.growthTasks.listTasks(target, sourceErrors),
        this.growthTasks.getGrowthAssetSummary(target)
      ]);
      // 双源全挂（token 失效/网络异常/风控）时空列表必须带出真实原因
      if (tasks.length === 0 && sourceErrors.length > 0) {
        this.sendNotify('error', t('err.readTasksFailed', sourceErrors.join(' | ')));
      }
      this.pushTasksToWebview(tasks, target.id, name, assetSummary);
    } catch (err: any) {
      this.sendNotify('error', t('err.readTasksFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  private pushTasksToWebview(
    tasks: GrowthTask[],
    accountId?: string,
    accountName?: string,
    assetSummary?: any
  ): void {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({
      command: 'updateTasks',
      data: {
        accountId,
        accountName,
        assetSummary,
        tasks: tasks.map(t => ({
          taskCode: t.taskCode,
          title: t.title,
          acceptStatus: t.acceptStatus,
          claimed: t.claimed,
          locked: t.locked,
          current: t.current,
          target: t.target,
          manualOnly: t.manualOnly,
          source: t.source
        }))
      }
    });
  }

  /**
   * 一键完成可自动任务：领养Buddy → 批量报名 → 领取全部达标奖励
   */
  public async handleTaskRunAuto(accountIds?: string[] | null): Promise<void> {
    this._abortTaskBatch = false;
    const startTime = Date.now();

    // 解析目标账号：勾选列表优先，否则回退当前激活账号
    let targets: CodeBuddyAccount[] = [];
    if (accountIds && accountIds.length > 0) {
      for (const id of accountIds) {
        const acc = this.store.get(id);
        if (acc) {
          targets.push(acc);
        }
      }
    } else {
      const active = this.store.getActive();
      if (active) {
        targets.push(active);
      }
    }

    // 成长任务为国内版 (codebuddy.cn) 专属, 国际账号明确跳过并提示, 不静默
    const cnTargets = targets.filter(acc => isCnAccount(acc.domain));
    if (cnTargets.length < targets.length) {
      this.sendNotify('warn', t('intl.cnOnlyDetail'));
    }
    targets = cnTargets;

    if (targets.length === 0) {
      this.sendNotify('error', t('err.noAccountsToRun'));
      return;
    }

    this.setOperating(true, t('msg.batchTaskRunning', targets.length));
    let totalClaimed = 0;
    let totalCredits = 0;
    let totalEnergy = 0;
    let totalAccepted = 0;
    let totalSkipped = 0;
    let totalFailures = 0;
    let processedAccounts = 0;
    let wasStopped = false;
    const details: Array<{ accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string }> = [];

    this.sendTaskProgress(t('prog.batchStart', targets.length), 'doing', 0, 0, targets.length);

    try {
      for (let i = 0; i < targets.length; i++) {
        if (this._abortTaskBatch) {
          wasStopped = true;
          this.sendTaskProgress(t('prog.aborted'), 'fail', Math.round((i / targets.length) * 100), i, targets.length);
          details.push({
            accountName: targets[i].nickname || targets[i].email,
            status: 'stopped',
            message: t('prog.stoppedByUser')
          });
          break;
        }

        const acc = targets[i];
        const name = acc.nickname || acc.email;
        const currentPct = Math.round((i / targets.length) * 100);
        this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${t('prog.executing')}`, 'doing', currentPct, i + 1, targets.length);

        try {
          const report = await this.growthTasks.runAutoComplete(acc);
          processedAccounts++;
          totalClaimed += report.claimed;
          totalCredits += report.claimedCredits;
          totalEnergy += report.claimedEnergy;
          totalAccepted += report.accepted;
          totalSkipped += report.skipped.length;
          totalFailures += report.failures.length;

          // 账号受限（11140 request illegal）检测：立即跳过该号
          const restricted = report.failures.some(
            f => f.includes('11140') || f.toLowerCase().includes('request illegal')
          );
          if (restricted) {
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${t('prog.accountRestricted')}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: t('err.restrictedDetail') });
            continue;
          }

          const parts: string[] = [];
          if (report.buddyAdopted) {
            parts.push(t('act.buddyAdopted'));
          }
          if (report.accepted > 0) {
            parts.push(t('act.acceptedN', report.accepted));
          }
          if (report.claimed > 0) {
            parts.push(t('act.claimedN', report.claimed, report.claimedCredits));
          }
          if (report.travelClaimed) {
            parts.push(t('act.travelGift'));
          }
          if (report.travelDeparted) {
            parts.push(t('act.travelDeparted', report.travelLocation || t('act.travelDefault')));
          }
          if (report.streakRedeemedCredits > 0) {
            parts.push(t('act.streakRedeemed', report.streakRedeemedCredits));
          }
          if (report.madeUpDays > 0) {
            parts.push(t('act.madeUpDays', report.madeUpDays));
          }
          if (report.buddyBoxesOpened > 0) {
            parts.push(t('act.boxOpened', report.newBuddyName || t('act.newBuddy')));
          }
          if (report.lotteryDraws > 0) {
            parts.push(t('act.lotteryN', report.lotteryDraws));
          }

          if (parts.length > 0) {
            const detailMsg = parts.join('，');
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${detailMsg}`, 'ok', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'ok', message: detailMsg });
          } else if (report.failures.length > 0) {
            const failMsg = t('err.taskExecuteAbnormal', report.failures.join('; '));
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${failMsg}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: failMsg });
          } else {
            const infoMsg = t('msg.noClaimable', report.inProgressTasks, report.skipped.length);
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${infoMsg}`, 'doing', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'skipped', message: infoMsg });
          }
        } catch (err: any) {
          processedAccounts++;
          totalFailures++;
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${t('prog.failWithReason', err.message)}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
          details.push({ accountName: name, status: 'fail', message: err.message });
        }

        // 账号间拟人化随机间隔（最后一个不等；支持随时被中止打断）
        if (i < targets.length - 1 && !this._abortTaskBatch) {
          await this.cancellableSleep(Math.round((3 + Math.random() * 5) * 1000));
        }
      }

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      this.sendTaskProgress(
        wasStopped ? t('prog.batchStopped') : t('prog.batchFinished'),
        wasStopped ? 'fail' : 'ok',
        100,
        targets.length,
        targets.length
      );

      // 发送结构化完成统计摘要
      this.sendTaskBatchSummary({
        mode: 'auto',
        totalAccounts: targets.length,
        processedAccounts,
        stopped: wasStopped,
        durationSec,
        totalAccepted,
        totalClaimed,
        totalCredits,
        totalEnergy,
        totalSkipped,
        totalFailures,
        details
      });

      this.sendNotify(
        totalClaimed > 0 || totalAccepted > 0 ? 'success' : 'error',
        t('msg.batchTaskDone', processedAccounts, targets.length, totalClaimed, totalCredits)
      );

      // 刷新展示的目标账号任务列表（所见即所操作）
      const primaryTarget = targets[0] || this.store.getActive();
      if (primaryTarget) {
        const tasks = await this.growthTasks.listTasks(primaryTarget);
        this.pushTasksToWebview(tasks, primaryTarget.id, primaryTarget.nickname || primaryTarget.email);
      }

      // 领奖会加积分：回拉余额，让侧栏算力/卡片/今日统计同步刷新
      await this.syncBalancesAfterTasks(targets);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 任务批量结束后回拉余额：领奖会改积分，不同步则侧栏算力/卡片/今日统计停在旧值。
   * 单号失败不阻断其他号，也不伪装成功——余额留旧值，下一次刷新纠正。
   */
  private async syncBalancesAfterTasks(targets: CodeBuddyAccount[]): Promise<void> {
    if (!targets.length) {
      return;
    }
    await Promise.all(
      targets.map(async (acc) => {
        try {
          await this.checkinService.syncAccountStatus(acc, this.store);
        } catch {
          // 忽略单号同步失败，避免覆盖已成功的任务结果
        }
      })
    );
    this.postStateToWebview();
  }

  /**
   * 领取单个任务奖励（支持指定目标账号）
   */
  public async handleTaskClaim(taskCode: string, accountId?: string): Promise<void> {
    const target = accountId ? this.store.get(accountId) : this.store.getActive();
    if (!target) {
      this.sendNotify('error', t('err.noClaimTarget'));
      return;
    }
    const name = target.nickname || target.email;
    try {
      const r = await this.growthTasks.claimTask(target, taskCode);
      if (r.ok && !r.already) {
        this.sendNotify('success', t('msg.claimOk', name, r.credit, r.energy));
      } else if (r.already) {
        this.sendNotify('error', t('msg.claimAlready', name));
      } else {
        this.sendNotify('error', t('err.claimNotMet', name) + (r.detail ? ` (${r.detail})` : ''));
      }
      const tasks = await this.growthTasks.listTasks(target);
      this.pushTasksToWebview(tasks, target.id, name);
      if (r.ok && !r.already) {
        await this.syncBalancesAfterTasks([target]);
      }
    } catch (err: any) {
      this.sendNotify('error', t('err.claimFailed', err.message));
    }
  }

  /**
   * 批量报名全部未报名任务
   */
  public async handleTaskAcceptAll(accountIds?: string[] | null): Promise<void> {
    this._abortTaskBatch = false;
    const startTime = Date.now();

    let targets: CodeBuddyAccount[] = [];
    if (accountIds && accountIds.length > 0) {
      for (const id of accountIds) {
        const acc = this.store.get(id);
        if (acc) {
          targets.push(acc);
        }
      }
    } else {
      const active = this.store.getActive();
      if (active) {
        targets.push(active);
      }
    }

    // 成长任务为国内版 (codebuddy.cn) 专属, 国际账号明确跳过并提示, 不静默
    const cnTargets = targets.filter(acc => isCnAccount(acc.domain));
    if (cnTargets.length < targets.length) {
      this.sendNotify('warn', t('intl.cnOnlyDetail'));
    }
    targets = cnTargets;

    if (targets.length === 0) {
      this.sendNotify('error', t('err.noAccountsToRun'));
      return;
    }

    this.setOperating(true, t('msg.batchAcceptRunning', targets.length));
    let totalAccepted = 0;
    let totalFailures = 0;
    let processedAccounts = 0;
    let wasStopped = false;
    const details: Array<{ accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string }> = [];

    this.sendTaskProgress(t('prog.acceptStart', targets.length), 'doing', 0, 0, targets.length);

    try {
      for (let i = 0; i < targets.length; i++) {
        if (this._abortTaskBatch) {
          wasStopped = true;
          this.sendTaskProgress(t('prog.acceptAborted'), 'fail', Math.round((i / targets.length) * 100), i, targets.length);
          details.push({
            accountName: targets[i].nickname || targets[i].email,
            status: 'stopped',
            message: t('prog.stoppedByUser')
          });
          break;
        }

        const acc = targets[i];
        const name = acc.nickname || acc.email;
        const currentPct = Math.round((i / targets.length) * 100);
        this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${t('prog.accepting')}`, 'doing', currentPct, i + 1, targets.length);

        try {
          const tasks = await this.growthTasks.listTasks(acc);
          const res = await this.growthTasks.acceptAll(acc, tasks);
          processedAccounts++;
          totalAccepted += res.accepted;
          totalFailures += res.failed;

          if (res.failed > 0) {
            const failMsg = res.accepted > 0
              ? t('msg.acceptPartial', res.accepted, res.failed, res.failures.join('; '))
              : t('err.acceptFailed', res.failures.join('; '));
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${failMsg}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: failMsg });
          } else {
            const okMsg = res.accepted > 0
              ? t('msg.acceptedN', res.accepted)
              : (res.alreadyAccepted > 0 ? t('msg.nothingToAccept') : t('msg.noTasksToAccept'));
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${okMsg}`, res.accepted > 0 ? 'ok' : 'doing', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'ok', message: okMsg });
          }
        } catch (err: any) {
          processedAccounts++;
          totalFailures++;
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${t('prog.acceptError', err.message)}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
          details.push({ accountName: name, status: 'fail', message: err.message });
        }

        if (i < targets.length - 1 && !this._abortTaskBatch) {
          await this.cancellableSleep(Math.round((3 + Math.random() * 5) * 1000));
        }
      }

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      this.sendTaskProgress(
        wasStopped ? t('prog.acceptStopped') : t('prog.acceptFinished'),
        wasStopped ? 'fail' : 'ok',
        100,
        targets.length,
        targets.length
      );

      this.sendTaskBatchSummary({
        mode: 'accept',
        totalAccounts: targets.length,
        processedAccounts,
        stopped: wasStopped,
        durationSec,
        totalAccepted,
        totalClaimed: 0,
        totalCredits: 0,
        totalEnergy: 0,
        totalSkipped: 0,
        totalFailures,
        details
      });

      this.sendNotify(
        totalAccepted > 0 ? 'success' : (totalFailures > 0 ? 'error' : 'success'),
        t('msg.batchAcceptDone', totalAccepted) + (totalFailures > 0 ? t('msg.batchAcceptDoneFail', totalFailures) : '')
      );

      // 刷新展示的目标账号任务列表
      const primaryTarget = targets[0] || this.store.getActive();
      if (primaryTarget) {
        const fresh = await this.growthTasks.listTasks(primaryTarget);
        this.pushTasksToWebview(fresh, primaryTarget.id, primaryTarget.nickname || primaryTarget.email);
      }

      // 报名/领取后余额可能变化，回拉一次让统计跟上
      await this.syncBalancesAfterTasks(targets);
    } finally {
      this.setOperating(false);
    }
  }

  private setOperating(isOperating: boolean, message: string = ''): void {
    this.isOperating = isOperating;
    this.currentOperationMessage = message;
    this.postStateToWebview();
  }

  /**
   * Webview 内 toast 通知（Kite 同款右下角浮层）
   * detail 非空时，toast 会带「复制详情 / 反馈问题」两个入口——报错截图里最缺的版本与系统信息
   * 由宿主统一拼好，用户一键带走，不再靠口头描述环境。
   */
  public sendNotify(level: 'success' | 'error' | 'warn', message: string, detail?: string): void {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ command: 'notify', level, message, detail: detail || '' });
  }

  /**
   * 切号失败统一出口：toast 带诊断详情，用户可一键复制或上报。
   * 侧栏未打开时退化为原生通知，避免错误被静默吞掉。
   */
  public notifySwitchFailure(message: string, detail?: string): void {
    if (!this._view) {
      void showFailureWithActions(message, detail);
      return;
    }
    this.sendNotify('error', message, buildDiagnostic(message, detail));
  }

  /**
   * 兼容多种来源的账号 JSON 字段映射（BuddyRelay 导出格式 / Cockpit 明文导出格式 / 下划线风格）
   */
  /**
   * 解码 JWT Payload (提取 sub, nickname, preferred_username, exp)
   */
  private parseJwtPayload(token: string): Record<string, any> | null {
    try {
      const parts = token.trim().split('.');
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
      return JSON.parse(jsonStr);
    } catch (_) {
      return null;
    }
  }

  /**
   * 兼容多种来源的账号 JSON/Token 字段映射（支持纯JWT解码补全UID与昵称）
   */
  private normalizeImportedAccount(raw: any): CodeBuddyAccount | null {
    if (!raw) return null;
    let data: Record<string, any> = {};
    if (typeof raw === 'string') {
      data = { access_token: raw.trim() };
    } else if (typeof raw === 'object') {
      data = raw;
    } else {
      return null;
    }

    const accessToken = data.accessToken || data.access_token || data.token;
    if (!accessToken) {
      return null;
    }

    // 智能尝试 JWT Payload 解码提取元数据
    const jwt = this.parseJwtPayload(String(accessToken));
    const uid = data.uid || data.id || jwt?.sub || jwt?.uid;
    if (!uid) {
      return null;
    }

    const now = Date.now();
    const nickname = data.nickname || jwt?.nickname || data.email || jwt?.preferred_username || String(uid);
    const email = data.email || jwt?.preferred_username || data.nickname || String(uid);
    const expiresAt = Number(data.expiresAt || data.expires_at || (jwt?.exp ? jwt.exp * 1000 : 0));

    const account: CodeBuddyAccount = {
      id: data.id || `imported_${String(uid).slice(0, 8)}_${now}`,
      uid: String(uid),
      email: String(email),
      nickname: String(nickname),
      accessToken: String(accessToken),
      refreshToken: data.refreshToken || data.refresh_token || '',
      tokenType: data.tokenType || data.token_type || 'Bearer',
      expiresAt,
      domain: data.domain || 'www.codebuddy.cn',
      paymentType: data.paymentType || data.payment_type || 'free',
      quotaRaw: data.quotaRaw || data.quota_raw,
      authRaw: data.authRaw || data.auth_raw,
      profileRaw: data.profileRaw || data.profile_raw,
      usageRaw: data.usageRaw || data.usage_raw,
      status: data.status === 'disabled' ? 'disabled' : 'idle',
      checkinStreak: typeof data.checkinStreak === 'number'
        ? data.checkinStreak
        : (typeof data.checkin_streak === 'number' ? data.checkin_streak : 0),
      todayCheckedIn: Boolean(data.todayCheckedIn ?? data.today_checked_in),
      lastCheckinDate: data.lastCheckinDate || data.last_checkin_date,
      lastCheckinTime: data.lastCheckinTime || data.last_checkin_time,
      totalCredits: typeof data.totalCredits === 'number' ? data.totalCredits : undefined,
      basePackage: data.basePackage,
      activityPackage: data.activityPackage,
      createdAt: Number(data.createdAt || now),
      lastUsed: Number(data.lastUsed || now),
      notes: data.notes
    };
    return account;
  }

  /**
   * 本地导入：读取本机 CodeBuddy 当前已登录会话入池
   *
   * 宿主 accessToken 存于 secret://（宿主进程系统级加密），扩展进程无法直接读取；
   * 因此流程为：storage.json 读 genie.userId 识别当前登录号 →
   * 从本机 Cockpit Tools 账号池逐个解密、按内容 UID 匹配该号密文 → 入池。
   */
  public async handleImportLocal(): Promise<void> {
    this.setOperating(true, t('msg.readingLocalSession'));
    try {
      const uid = readHostLoginUid();
      if (!uid) {
        this.sendNotify('error', t('err.noLocalSession'));
        return;
      }

      if (this.store.get(uid)) {
        this.sendNotify('error', t('err.duplicateAccount'));
        return;
      }

      let account: CodeBuddyAccount | undefined;
      try {
        account = this.importer.findAccountByUid(uid);
      } catch (err: any) {
        this.sendNotify('error', t('err.localTokenLocked', uid, err.message));
        return;
      }

      if (!account) {
        this.sendNotify('error', t('err.localTokenLocked', uid, t('err.localNoVaultMatch')));
        return;
      }

      await this.store.upsert(account);
      this.checkinService.syncAccountStatus(account, this.store).catch(() => {});
      this.sendNotify('success', t('msg.localImported', account.nickname || account.email || uid));
    } catch (err: any) {
      this.sendNotify('error', t('err.localImportFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 账号启用/禁用切换
   */
  public async handleToggleAccountStatus(accountId: string): Promise<void> {
    const acc = await this.store.toggleStatus(accountId);
    if (acc) {
      const isDis = acc.status === 'disabled';
      this.sendNotify('success', isDis ? t('msg.accountDisabled', acc.nickname || acc.email) : t('msg.accountEnabled', acc.nickname || acc.email));
      this.postStateToWebview();
    }
  }

  /**
   * 从文件选择导入账号 (.json)
   */
  public async handleImportAccountsFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { [t('fileFilter.jsonAccounts')]: ['json'], [t('fileFilter.allFiles')]: ['*'] },
      openLabel: t('fileFilter.openLabel')
    });
    if (uris && uris[0]) {
      this.setOperating(true, t('msg.readingFile'));
      try {
        const text = await fs.promises.readFile(uris[0].fsPath, 'utf8');
        await this.handleImportJson(text);
      } catch (err: any) {
        this.sendNotify('error', t('err.readFileFailed', err.message));
      } finally {
        this.setOperating(false);
      }
    }
  }

  /**
   * 保存规则与调度偏好设置
   */
  public async handleSaveSettings(settings: Record<string, any>): Promise<void> {
    if (!settings || typeof settings !== 'object') return;
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    try {
      if ('autoCheckin' in settings) await cfg.update('autoCheckin', Boolean(settings.autoCheckin), vscode.ConfigurationTarget.Global);
      if ('dailyTime' in settings) await cfg.update('autoCheckin.dailyTime', String(settings.dailyTime || '00:10'), vscode.ConfigurationTarget.Global);
      if ('randomJitterMinutes' in settings) await cfg.update('autoCheckin.randomJitterMinutes', Number(settings.randomJitterMinutes || 30), vscode.ConfigurationTarget.Global);
      if ('perAccountDelaySeconds' in settings) await cfg.update('autoCheckin.perAccountDelaySeconds', Number(settings.perAccountDelaySeconds || 15), vscode.ConfigurationTarget.Global);
      if ('refreshIntervalMinutes' in settings) await cfg.update('refreshIntervalMinutes', Number(settings.refreshIntervalMinutes || 15), vscode.ConfigurationTarget.Global);
      if ('growthTasksAutoAfterCheckin' in settings) await cfg.update('growthTasks.autoAfterCheckin', Boolean(settings.growthTasksAutoAfterCheckin), vscode.ConfigurationTarget.Global);
      if ('startupMakeup' in settings) await cfg.update('autoCheckin.startupMakeup', Boolean(settings.startupMakeup), vscode.ConfigurationTarget.Global);
      if ('autoUseMakeupCard' in settings) await cfg.update('growthTasks.autoUseMakeupCard', Boolean(settings.autoUseMakeupCard), vscode.ConfigurationTarget.Global);
      if ('autoSwitchEnabled' in settings) await cfg.update('autoSwitch.enabled', Boolean(settings.autoSwitchEnabled), vscode.ConfigurationTarget.Global);
      if ('quotaThresholdPercent' in settings) await cfg.update('autoSwitch.quotaThresholdPercent', Number(settings.quotaThresholdPercent || 10), vscode.ConfigurationTarget.Global);
      if ('autoSwitchStrategy' in settings) await cfg.update('autoSwitch.strategy', String(settings.autoSwitchStrategy || 'highest_quota'), vscode.ConfigurationTarget.Global);
      if ('cooldownMinutes' in settings) await cfg.update('autoSwitch.cooldownMinutes', Number(settings.cooldownMinutes || 5), vscode.ConfigurationTarget.Global);
      if ('autoSwitchOn429' in settings) await cfg.update('autoSwitch.on429', Boolean(settings.autoSwitchOn429), vscode.ConfigurationTarget.Global);
      if ('autoSwitchNotify' in settings) await cfg.update('autoSwitch.notifyOnSwitch', Boolean(settings.autoSwitchNotify), vscode.ConfigurationTarget.Global);
      if ('privacyModeDefault' in settings) await cfg.update('privacyModeDefault', Boolean(settings.privacyModeDefault), vscode.ConfigurationTarget.Global);
      if ('updateAutoCheck' in settings) await cfg.update('update.autoCheck', Boolean(settings.updateAutoCheck), vscode.ConfigurationTarget.Global);
      if ('updateAutoInstall' in settings) await cfg.update('update.autoInstall', Boolean(settings.updateAutoInstall), vscode.ConfigurationTarget.Global);
      if ('locale' in settings) await cfg.update('locale', String(settings.locale || 'auto'), vscode.ConfigurationTarget.Global);
      this.sendNotify('success', t('msg.settingsSaved'));
      this.postStateToWebview();
    } catch (e: any) {
      this.sendNotify('error', t('err.saveSettingsFailed', e.message));
    }
  }

  /**
   * 智能匹配批量导入：JSON / JWT Token智能提取 / 分隔符多行 / 已有号覆盖更新
   */
  public async handleImportJson(text: string): Promise<void> {
    const raw = text.trim();
    if (!raw) {
      this.sendNotify('error', t('err.importEmpty'));
      return;
    }

    this.setOperating(true, t('msg.parsingImport'));

    try {
      let items: any[] = [];
      try {
        const parsed = JSON.parse(raw);
        items = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {
        // 非标准 JSON，走按行智能识别 (Kite 模式)
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('#') || line.startsWith('//')) continue;
          // 匹配 JWT Token (eyJ...)
          const jwtMatch = line.match(/\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)\b/);
          if (jwtMatch) {
            const allJwts = line.match(/\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)\b/g) || [];
            items.push({
              access_token: allJwts[0],
              refresh_token: allJwts.length > 1 ? allJwts[1] : ''
            });
            continue;
          }
          // 分隔符行
          const parts = line.split(/\s*[-]{2,}\s*|\s*[,|\t]\s*/).filter(Boolean);
          if (parts.length >= 2) {
            if (parts[1].startsWith('eyJ')) {
              items.push({ uid: parts[0], access_token: parts[1] });
            } else if (parts[0].startsWith('eyJ')) {
              items.push({ access_token: parts[0], uid: parts[1] });
            }
          }
        }
      }

      if (items.length === 0) {
        this.sendNotify('error', t('err.importUnrecognized'));
        return;
      }

      let freshCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      const fresh: CodeBuddyAccount[] = [];
      const updated: CodeBuddyAccount[] = [];

      for (const item of items) {
        const acc = this.normalizeImportedAccount(item);
        if (!acc) {
          skippedCount++;
          continue;
        }

        const existing = this.store.get(acc.id) || this.store.get(acc.uid);
        if (existing) {
          // 智能覆盖更新已有账号的令牌
          existing.accessToken = acc.accessToken;
          if (acc.refreshToken) existing.refreshToken = acc.refreshToken;
          if (acc.expiresAt) existing.expiresAt = acc.expiresAt;
          if (acc.quotaRaw) existing.quotaRaw = acc.quotaRaw;
          if (existing.status === 'expired') existing.status = 'idle';
          existing.lastUsed = Date.now();
          updated.push(existing);
          updatedCount++;
        } else {
          fresh.push(acc);
          freshCount++;
        }
      }

      const allToSave = [...fresh, ...updated];
      if (allToSave.length > 0) {
        await this.store.upsertBatch(allToSave);
        // 后台异步进行在线配额与状态对账验真
        this.checkinService.batchSyncStatus(allToSave, this.store).catch(() => {});
      }

      if (freshCount > 0 || updatedCount > 0) {
        const parts: string[] = [];
        if (freshCount > 0) parts.push(t('import.added', freshCount));
        if (updatedCount > 0) parts.push(t('import.updated', updatedCount));
        if (skippedCount > 0) parts.push(t('import.skipped', skippedCount));
        this.sendNotify('success', t('msg.importDone', parts.join('，')));
      } else {
        this.sendNotify('error', t('err.importAllInvalid', skippedCount));
      }
    } catch (err: any) {
      this.sendNotify('error', t('err.importError', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 号池全量备份导出（支持完整凭证备份与脱敏分享模式）
   */
  public async handleExportAccounts(mode: 'full' | 'masked' = 'full'): Promise<void> {
    const list = this.store.getAll();
    if (list.length === 0) {
      this.sendNotify('error', t('err.exportEmpty'));
      return;
    }

    const isMasked = mode === 'masked';
    const exportData = list.map(acc => {
      if (isMasked) {
        return {
          id: acc.id,
          uid: maskUid(acc.uid, true),
          email: maskName(acc.email, true),
          nickname: maskName(acc.nickname, true),
          status: acc.status,
          totalCredits: acc.totalCredits ?? 0,
          paymentType: acc.paymentType || 'free',
          notes: acc.notes,
          tags: acc.tags
        };
      }
      return acc;
    });

    const defaultFileName = isMasked
      ? `buddyrelay-accounts-masked-${new Date().toISOString().slice(0, 10)}.json`
      : `buddyrelay-accounts-backup-${new Date().toISOString().slice(0, 10)}.json`;

    const uri = await vscode.window.showSaveDialog({
      filters: { 'JSON Files': ['json'] },
      defaultUri: vscode.Uri.file(defaultFileName),
      title: isMasked ? t('saveTitle.masked') : t('saveTitle.full')
    });

    if (!uri) return;

    try {
      fs.writeFileSync(uri.fsPath, JSON.stringify(exportData, null, 2), 'utf8');
      this.sendNotify('success', t('msg.exported', isMasked ? t('exportMode.masked') : t('exportMode.full'), path.basename(uri.fsPath)));
    } catch (e: any) {
      this.sendNotify('error', t('err.exportWriteFailed', e.message));
    }
  }

  /**
   * 失效账号原地重新唤起浏览器 OAuth 授权更新
   */
  public async handleReauthAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      this.sendNotify('error', t('err.accountMissing'));
      return;
    }

    this.setOperating(true, t('msg.reauthRunning', target.nickname || target.email));
    try {
      const refreshed = await this.oauthService.loginAndSave(this.store, {
        onAuthUrl: (url) => {
          vscode.env.openExternal(vscode.Uri.parse(url));
          this.sendNotify('success', t('msg.reauthPageOpened'));
        }
      });
      this.sendNotify('success', t('msg.reauthDone', refreshed.nickname || refreshed.email));
    } catch (err: any) {
      this.sendNotify('error', t('err.reauthFailed', err.message));
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 更新单个账号的备注信息 (Notes)
   */
  public async handleUpdateNotes(accountId: string, notes: string): Promise<void> {
    await this.store.updateNotes(accountId, notes);
    this.sendNotify('success', t('msg.notesSaved'));
    this.postStateToWebview();
  }

  /**
   * 更新单个账号的自定义业务标签 (Tags)
   */
  public async handleUpdateTags(accountId: string, tags: string[]): Promise<void> {
    await this.store.updateTags(accountId, tags);
    this.sendNotify('success', t('msg.tagsSaved'));
    this.postStateToWebview();
  }

  /**
   * 核心 Webview HTML 结构模板
   * 1:1 深度复刻 Kite 经典卡片 (.grid-card) 质感 + Cockpit 配额进度条 + 隐私脱敏
   * i18n: 静态文案 {{i:key}} 占位符按当前语言替换; 动态文案经 __I18N__ 字典注入
   */
  private getHtmlForWebview(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'main.css')
    );
    const htmlPath = path.join(this.extensionUri.fsPath, 'resources', 'webview', 'sidebar.html');
    if (fs.existsSync(htmlPath)) {
      let content = fs.readFileSync(htmlPath, 'utf8');
      content = content.replace('{{CSS_URI}}', `${cssUri.toString()}?v=${Date.now()}`);
      // CSP: 宿主会对未声明 CSP 的 webview 注入兜底严格策略 (script-src 仅放行固定 hash, inline 脚本全灭);
      // 扩展自带 CSP 自我声明, 同时把 webview.cspSource 注入资源白名单
      content = content.replaceAll('{{CSP_SOURCE}}', () => webview.cspSource);
      const dict = getLangDict();
      // 字典内 </script> 转义, 防止注入串提前闭合脚本块; 函数式替换杜绝 $ 特殊替换模式吞字符
      const dictJson = JSON.stringify(dict).replace(/<\//g, '<\\/');
      content = content.replaceAll('{{I18N_JSON}}', () => dictJson);
      content = content.replace(/\{\{i:([\w.]+)\}\}/g, (full, key: string) => {
        const v = dict[key];
        if (v === undefined) {
          console.warn(`[BuddyRelay][i18n] missing webview key: ${key}`);
          return full;
        }
        return v;
      });
      return content;
    }
    return `<!DOCTYPE html><html><body><h3>${t('err.htmlMissing')}: ${htmlPath}</h3></body></html>`;
  }

  /**
   * 语言切换后整页重载侧栏 (重新注入当前语言的字典与静态文案)
   */
  public reloadWebview(): void {
    if (!this._view) {
      return;
    }
    this._view.webview.html = this.getHtmlForWebview(this._view.webview);
  }
}
