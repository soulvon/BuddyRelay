import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount, QuotaPackageItem } from './accountStore';
import { SeamlessSwitcher, ElevationPlan } from './seamlessSwitcher';
import { CheckinService, isTodayCheckedIn } from './checkinService';
import { CockpitImporter } from './cockpitImporter';
import { OAuthService } from './oauthService';
import { GrowthTaskService } from './growthTaskService';
import { acquireLock, getOtherLockedUids } from './accountLock';
import { buildDiagnostic, showFailureWithActions, copyDiagnostic, openIssueReport } from './diagnostics';
import { checkForUpdates, getCurrentVersion } from './updater';
import { UsageTracker } from './usageTracker';
import { t, getLangDict } from './i18n';
import { detectHostEdition } from './host';
import { isCnAccount } from './domain';
import { PATHS } from './constants';
import { loadCooldownEvents } from './cooldownLogWatcher';
import { TokenLedger } from './tokenLedger';
import { collectRestartWaitPids, buildRestartHelperSource, spawnIdeRestartHelper } from './restartHelper';
import {
  formatAccountLabel,
  parseJwtPayload as parseJwtPayloadHelper,
  normalizeImportedAccount as normalizeImportedAccountHelper,
  importAccountsFromText,
  importFromFileDialog,
  readLocalHostAccount,
  exportAccounts
} from './importExportService';
import { TaskOrchestrator } from './taskOrchestrator';

export interface SidebarProviderOptions {
  onActiveSwitched?: (uid: string) => void;
  tokenLedger?: TokenLedger;
}

const BOOL_SETTING_MAP: ReadonlyArray<readonly [string, string, boolean]> = [
  ['autoCheckin', 'autoCheckin', true],
  ['growthTasksAutoAfterCheckin', 'growthTasks.autoAfterCheckin', true],
  ['startupMakeup', 'autoCheckin.startupMakeup', true],
  ['autoUseMakeupCard', 'growthTasks.autoUseMakeupCard', true],
  ['autoSwitchEnabled', 'autoSwitch.enabled', true],
  ['autoSwitchOn429', 'autoSwitch.on429', true],
  ['autoSwitchNotify', 'autoSwitch.notifyOnSwitch', true],
  ['privacyModeDefault', 'privacyModeDefault', false],
  ['updateAutoCheck', 'update.autoCheck', true],
  ['updateAutoInstall', 'update.autoInstall', true]
];

const NUM_SETTING_MAP: ReadonlyArray<readonly [string, string, number, number, number]> = [
  ['randomJitterMinutes', 'autoCheckin.randomJitterMinutes', 30, 0, 120],
  ['perAccountDelaySeconds', 'autoCheckin.perAccountDelaySeconds', 15, 0, 60],
  ['refreshIntervalMinutes', 'refreshIntervalMinutes', 15, 5, 120],
  ['quotaThresholdPercent', 'autoSwitch.quotaThresholdPercent', 10, 0, 90],
  ['cooldownMinutes', 'autoSwitch.cooldownMinutes', 5, 1, 60]
];

const STR_SETTING_MAP: ReadonlyArray<readonly [string, string, string]> = [
  ['dailyTime', 'autoCheckin.dailyTime', '00:10'],
  ['autoSwitchStrategy', 'autoSwitch.strategy', 'highest_quota'],
  ['locale', 'locale', 'auto']
];

export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'buddy-relay.sidebarView';

  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private checkinService: CheckinService;
  private importer: CockpitImporter;
  private oauthService: OAuthService;
  private growthTasks: GrowthTaskService;
  private usageTracker?: UsageTracker;
  private tokenLedger?: TokenLedger;
  private options?: SidebarProviderOptions;
  private taskOrchestrator: TaskOrchestrator;
  private isOperating: boolean = false;
  private currentOperationMessage: string = '';
  private _isElevating: boolean = false;
  private _relayDir: string = PATHS.RELAY_DIR;
  private postStateTimer: NodeJS.Timeout | null = null;
  private readonly _onStoreChange = () => { this.schedulePostState(); };

  constructor(
    extensionUri: vscode.Uri,
    store: AccountStore,
    switcher: SeamlessSwitcher,
    checkinService: CheckinService,
    importer: CockpitImporter,
    oauthService: OAuthService,
    usageTracker?: UsageTracker,
    options?: SidebarProviderOptions
  ) {
    this._extensionUri = extensionUri;
    this.store = store;
    this.switcher = switcher;
    this.checkinService = checkinService;
    this.importer = importer;
    this.oauthService = oauthService;
    this.usageTracker = usageTracker;
    this.tokenLedger = options?.tokenLedger;
    this.options = options;
    this.growthTasks = new GrowthTaskService();
    this.taskOrchestrator = new TaskOrchestrator({
      store: this.store,
      checkinService: this.checkinService,
      growthTasks: this.growthTasks,
      postMessage: (msg) => this._view?.webview.postMessage(msg),
      setOperating: (active, msg = '') => this.setOperating(active, msg),
      sendNotify: (level, message, detail) => this.sendNotify(level, message, detail),
      postStateToWebview: () => this.postStateToWebview()
    });
    if (typeof (this.store as any)?.on === 'function') {
      this.store.on('change', this._onStoreChange);
    }
  }

  public dispose(): void {
    if (this.postStateTimer) { clearTimeout(this.postStateTimer); this.postStateTimer = null; }
    if (typeof (this.store as any)?.removeListener === 'function') this.store.removeListener('change', this._onStoreChange);
  }

  public schedulePostState(delayMs: number = 50): void {
    if (this.postStateTimer) clearTimeout(this.postStateTimer);
    this.postStateTimer = setTimeout(() => { this.postStateTimer = null; this.postStateToWebview(); }, Math.max(0, delayMs));
  }

  private displayLabel(account: Pick<CodeBuddyAccount, 'nickname' | 'email' | 'uid'> & { displayName?: string }): string {
    return formatAccountLabel(account, this.store.getPrivacyMode?.() ?? false);
  }

  private async withOperating(message: string, errKey: string | null, fn: () => Promise<void>): Promise<void> {
    this.setOperating(true, message);
    try { await fn(); }
    catch (err: any) { if (errKey) this.sendNotify('error', t(errKey, err?.message || String(err))); }
    finally { this.setOperating(false); }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView, _ctx: vscode.WebviewViewResolveContext, _tok: vscode.CancellationToken): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')] };
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      try { await this.dispatchWebviewMessage(message); }
      catch (err: any) { this.sendNotify('error', err?.message || String(err)); }
    });
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) this.postStateToWebview(); });
  }

  private async dispatchWebviewMessage(message: any): Promise<void> {
    if (!message || typeof message.command !== 'string') return;
    const id = String(message.accountId || '');
    switch (message.command) {
      case 'webviewReady': this.postStateToWebview(); break;
      case 'switchAccount': await this.handleSwitchAccount(id); break;
      case 'runDoctor': await this.handleRunDoctor(); break;
      case 'restartApp': await this.handleRestartApp(); break;
      case 'checkinAccount': await this.handleCheckinAccount(id); break;
      case 'deleteAccount': await this.handleDeleteAccount(id, message.confirmed === true); break;
      case 'addAccountOAuth': await this.handleAddAccountOAuth(); break;
      case 'importCockpit': await this.handleImportCockpit(); break;
      case 'batchCheckin': await this.handleBatchCheckin(); break;
      case 'refreshStatus': await this.handleRefreshStatus(); break;
      case 'refreshAccount': await this.handleRefreshAccount(id); break;
      case 'refreshModelStats': await this.handleRefreshModelStats(Number(message.days) || 7, message.force === true); break;
      case 'refreshTokenLedger': await this.handleRefreshTokenLedger(); break;
      case 'importJson': await this.handleImportJson(String(message.text || '')); break;
      case 'importLocal': await this.handleImportLocal(); break;
      case 'taskList': await this.taskOrchestrator.handleTaskList(message.accountId ? id : undefined); break;
      case 'taskRunAuto': await this.taskOrchestrator.handleTaskRunAuto(Array.isArray(message.accountIds) ? message.accountIds.map(String) : null); break;
      case 'taskAcceptAll': await this.taskOrchestrator.handleTaskAcceptAll(Array.isArray(message.accountIds) ? message.accountIds.map(String) : null); break;
      case 'taskAcceptSingle': await this.taskOrchestrator.handleTaskAcceptSingle(id, String(message.taskCode || '')); break;
      case 'taskClaim': await this.taskOrchestrator.handleTaskClaim(String(message.taskCode || ''), message.accountId ? id : undefined); break;
      case 'taskStop': this.taskOrchestrator.requestStop(); break;
      case 'togglePrivacyMode': await this.store.setPrivacyMode?.(Boolean(message.enabled)); break;
      case 'toggleAccountStatus': await this.handleToggleAccountStatus(id); break;
      case 'importAccountsFile': await this.handleImportAccountsFile(); break;
      case 'saveSettings': await this.handleSaveSettings(message.settings); break;
      case 'checkUpdate': await checkForUpdates(false); break;
      case 'exportAccounts': await this.handleExportAccounts(message.mode); break;
      case 'reauthAccount': await this.handleReauthAccount(id); break;
      case 'updateAccountMeta': {
        const displayName = typeof message.displayName === 'string' ? message.displayName : undefined;
        await this.handleUpdateAccountMeta(
          id,
          displayName,
          typeof message.notes === 'string' ? message.notes : '',
          Array.isArray(message.tags) ? message.tags.map(String) : []
        );
        break;
      }
      case 'updateNotes':
        await this.store.updateNotes?.(id, String(message.notes || ''));
        this.sendNotify('success', t('msg.notesSaved'));
        this.postStateToWebview();
        break;
      case 'updateTags':
        await this.store.updateTags?.(id, Array.isArray(message.tags) ? message.tags : []);
        this.sendNotify('success', t('msg.tagsSaved'));
        this.postStateToWebview();
        break;
      case 'clearUsage':
        this.usageTracker?.clearRecords();
        this.sendNotify('success', t('msg.usageCleared'));
        this.postStateToWebview();
        break;
      case 'copyText': await copyDiagnostic(String(message.text || '')); break;
      case 'reportIssue': await openIssueReport(String(message.text || '')); break;
    }
  }

  private readSettingsSnapshot(): Record<string, any> {
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    const out: Record<string, any> = {};
    for (const [k, cfgKey, def] of BOOL_SETTING_MAP) out[k] = cfg.get<boolean>(cfgKey, def);
    for (const [k, cfgKey, def] of NUM_SETTING_MAP) out[k] = cfg.get<number>(cfgKey, def);
    for (const [k, cfgKey, def] of STR_SETTING_MAP) out[k] = cfg.get<string>(cfgKey, def);
    return out;
  }

  public postStateToWebview(): void {
    if (!this._view) return;

    const accounts = this.store.getAll?.() ?? [];
    const active = this.store.getActive?.();
    const checkedTodayCount = accounts.filter((a) => isTodayCheckedIn(a)).length;
    const totalCredits = accounts.reduce((sum, acc) => sum + (acc.totalCredits || 0), 0);
    const activeUid = active?.uid || '';
    let lockedUids: string[] = [];
    try {
      lockedUids = Array.from(getOtherLockedUids()).filter((u) => u !== activeUid);
    } catch {
      lockedUids = [];
    }

    this.refreshUsageStats(false);
    const enabledCount = accounts.filter((a) => a.status !== 'disabled').length;
    const usageSummary = this.usageTracker?.getDailySummary(enabledCount);
    const tokenLedgerSummary = this.tokenLedger?.getCachedSummary() ?? null;
    if (this.tokenLedger && !tokenLedgerSummary) {
      void this.tokenLedger.getSummary(false).then(() => this.schedulePostState(50)).catch(() => {});
    }

    let cooldownEvents: ReturnType<typeof loadCooldownEvents> | null = null;
    let cooldownEventsError = '';
    try { cooldownEvents = loadCooldownEvents(); }
    catch (err: any) { cooldownEventsError = String(err?.message || err); }

    const loadHealthy = typeof (this.store as any).isLoadHealthy === 'function'
      ? Boolean((this.store as any).isLoadHealthy())
      : true;

    this._view.webview.postMessage({
      command: 'updateState',
      data: {
        accounts: accounts.map((acc) => {
          const actRemain = typeof acc.totalCredits === 'number' ? acc.totalCredits : 0;
          const basePkg: QuotaPackageItem = acc.basePackage || { title: t('pkg.base'), count: 1, remain: 0, total: 500, percent: 0 };
          const actPkg: QuotaPackageItem = acc.activityPackage || {
            title: t('pkg.activity'), count: 30, remain: actRemain, total: 3000,
            percent: actRemain > 0 ? Math.min(100, Math.round((actRemain / 3000) * 100)) : 0
          };
          return {
            id: acc.id, uid: acc.uid, email: acc.email, nickname: acc.nickname || acc.email,
            displayName: acc.displayName || '',
            paymentType: acc.paymentType || 'free', status: acc.status,
            isActive: active ? active.id === acc.id : false,
            totalCredits: acc.totalCredits ?? 0,
            todayConsumed: usageSummary?.perAccountConsumed[acc.id] ?? 0,
            todayGrants: usageSummary?.perAccountGrants[acc.id] ?? 0,
            tokenStats: tokenLedgerSummary?.perAccount[acc.uid] || null,
            basePackage: basePkg, activityPackage: actPkg,
            checkinStreak: acc.checkinStreak ?? 0, todayCheckedIn: isTodayCheckedIn(acc),
            rateLimitUntil: acc.rateLimitUntil, lastUsed: acc.lastUsed,
            notes: acc.notes || '', tags: Array.isArray(acc.tags) ? acc.tags : []
          };
        }),
        activeId: active?.id || null,
        stats: {
          total: accounts.length,
          activeCount: accounts.filter((a) => a.status === 'active').length,
          idleCount: accounts.filter((a) => a.status === 'idle').length,
          rateLimitedCount: accounts.filter((a) => a.status === 'rate_limited').length,
          disabledCount: accounts.filter((a) => a.status === 'disabled').length,
          checkedTodayCount, totalCredits
        },
        settings: this.readSettingsSnapshot(),
        isOperating: this.isOperating,
        operationMessage: this.currentOperationMessage,
        privacyMode: this.store.getPrivacyMode?.() ?? false,
        lockedUids, loadHealthy,
        version: getCurrentVersion(),
        hostEdition: detectHostEdition(),
        allTags: this.store.getAllTags?.() ?? [],
        usageSummary,
        recentRecords: this.usageTracker?.getRecentOfficialRequests(60) || [],
        modelStats: this.usageTracker?.getModelStatsSnapshot() || null,
        tokenLedger: tokenLedgerSummary,
        cooldownEvents, cooldownEventsError
      }
    });
  }

  public async handleSwitchAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) { this.sendNotify('error', t('err.targetMissing')); return; }

    const label = this.displayLabel(target);
    this.setOperating(true, t('msg.switchingTo', label));
    try {
      const res = await this.switcher.switchAccount(target, this.store);
      if (res.needsElevation && res.elevationPlan) { await this.promptElevationAndApply(res.elevationPlan, target); return; }
      if (res.needsFullRestart) { await this.promptFullRestart(); return; }
      if (res.success) {
        if (target.uid) {
          try { acquireLock(target.uid); } catch {}
          this.options?.onActiveSwitched?.(target.uid);
        }
        this.sendNotify('success', t('msg.switched', label));
      } else {
        const doc = this.switcher.runDoctor();
        if (doc.status === 'needs_elevation' && doc.elevationPlan) { await this.promptElevationAndApply(doc.elevationPlan, target); return; }
        if (doc.status === 'needs_full_restart' || doc.status === 'repaired_needs_full_restart') { await this.promptFullRestart(); return; }
        this.notifySwitchFailure(t('err.switchAbnormal', res.message), res.detail);
      }
    } catch (err: any) {
      this.notifySwitchFailure(t('err.switchFailed', err?.message || String(err)));
    } finally {
      this.setOperating(false);
    }
  }

  public async promptElevationAndApply(plan: ElevationPlan, pendingAccount?: CodeBuddyAccount): Promise<boolean> {
    if (this._isElevating) return false;
    this._isElevating = true;
    try {
      const grantLabel = t('sw.elevateBtn');
      const choice = await vscode.window.showWarningMessage(t('sw.elevatePrompt'), grantLabel, t('ui.restartLater'));
      if (choice !== grantLabel) return false;

      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('sw.elevatingProgress'), cancellable: false },
        async () => this.switcher.completeSwitchAfterElevation(plan, pendingAccount, this.store)
      );
      if (res.cancelled) {
        this.sendNotify('warn', t('sw.elevateCancelled'));
        if (!this._view || !this._view.visible) void vscode.window.showInformationMessage(t('sw.elevateCancelled'));
        return false;
      }
      if (!res.success) { this.notifySwitchFailure(res.message, res.detail); return false; }
      await this.promptFullRestart();
      return true;
    } finally {
      this._isElevating = false;
    }
  }

  public async handleRunDoctor(): Promise<void> {
    const doc = this.switcher.runDoctor();
    if (doc.status === 'healthy') { this.sendNotify('success', doc.message); return; }
    if (doc.status === 'needs_elevation' && doc.elevationPlan) { await this.promptElevationAndApply(doc.elevationPlan); return; }
    if (doc.status === 'needs_full_restart' || doc.status === 'repaired_needs_full_restart') { await this.promptFullRestart(); return; }
    this.sendNotify('error', doc.message);
  }

  public async promptNativeRestart(message: string = t('sw.restartHint')): Promise<void> {
    const nowLabel = t('ui.restartNow');
    const choice = await vscode.window.showInformationMessage(message, nowLabel, t('ui.restartLater'));
    if (choice === nowLabel) await this.handleRestartApp();
  }

  public async promptFullRestart(): Promise<void> {
    if (!this._view || !this._view.visible) { await this.promptNativeRestart(t('sw.restartHint')); return; }
    this._view.webview.postMessage({ command: 'showRestartModal' });
  }

  public async handleRestartApp(): Promise<void> {
    this.spawnRestartHelper();
    await vscode.commands.executeCommand('workbench.action.quit');
  }

  public static collectRestartWaitPids(ppid: number = process.ppid, env: NodeJS.ProcessEnv = process.env): number[] { return collectRestartWaitPids(env, process.pid, ppid); }
  public static buildRestartHelperSource(logPath?: string): string { return (buildRestartHelperSource as any)(logPath); }
  private spawnRestartHelper(): void { try { spawnIdeRestartHelper(this._relayDir || PATHS.RELAY_DIR); } catch {} }

  public async handleCheckinAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) return;
    const label = this.displayLabel(target);
    await this.withOperating(t('msg.checkingInFor', label), 'err.checkinError', async () => {
      const res = await this.checkinService.checkinAccount(target, this.store);
      this.sendNotify(res.success ? 'success' : 'error',
        res.success ? `[${label}] ${res.message}` : `[${label}] ${t('err.checkinFailed', res.error || res.message)}`);
    });
  }

  public async handleBatchCheckin(): Promise<void> {
    const accounts = this.store.getAll();
    if (accounts.length === 0) { this.sendNotify('success', t('msg.poolEmpty')); return; }
    await this.withOperating(t('msg.batchCheckinRunning', accounts.length), 'err.batchCheckinError', async () => {
      const r = await this.checkinService.batchCheckin(accounts, this.store);
      this.sendNotify('success', t('msg.batchCheckinDone', r.totalCreditsAwarded, r.successCount, r.alreadyCheckedInCount, r.failedCount));
    });
  }

  public async handleImportCockpit(): Promise<void> {
    await this.withOperating(t('msg.scanningCockpit'), 'err.cockpitImportError', async () => {
      const res = await this.importer.importToStore(this.store);
      if (res.success) {
        this.sendNotify('success', t('msg.cockpitImported', res.decryptedCount));
        this.checkinService.batchSyncStatus(this.store.getAll(), this.store).catch(() => {});
      } else {
        this.sendNotify('error', t('msg.cockpitPartial', res.decryptedCount, res.totalFound));
      }
    });
  }

  public async handleAddAccountOAuth(): Promise<void> {
    await this.withOperating(t('msg.requestingOAuth'), 'err.oauthFailed', async () => {
      const account = await this.oauthService.loginAndSave(this.store, {
        domain: detectHostEdition(),
        onAuthUrl: (url) => {
          vscode.env.openExternal(vscode.Uri.parse(url));
          this.setOperating(true, t('msg.oauthPageOpened'));
        }
      });
      this.sendNotify('success', t('msg.oauthSuccess', this.displayLabel(account)));
      this.checkinService.syncAccountStatus(account, this.store).catch(() => {});
    });
  }

  public async handleDeleteAccount(accountId: string, confirmed: boolean = false): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) return;
    const label = this.displayLabel(target);
    if (!confirmed) {
      const confirmBtn = t('ui.confirmRemoveBtn');
      const choice = await vscode.window.showWarningMessage(t('ui.confirmRemove', label), { modal: true }, confirmBtn);
      if (choice !== confirmBtn) return;
    }
    await this.store.delete(accountId);
    this.sendNotify('success', t('msg.accountRemoved', label));
  }

  public refreshUsageStats(force: boolean = false): void {
    if (!this.usageTracker) return;
    const usageItems = (this.store.getAll?.() ?? [])
      .filter((a) => isCnAccount(a.domain) && typeof a.totalCredits === 'number')
      .map((a) => ({ id: a.id, credits: a.totalCredits as number, token: a.accessToken || '', uid: a.uid || '' }));
    const changedIds = new Set(this.usageTracker.detectChangedAccounts(usageItems) || []);
    const eligible = usageItems.filter((i) => i.token && i.uid);
    const targets = force ? eligible : eligible.filter((i) => changedIds.has(i.id));
    if (!targets.length) return;

    void this.usageTracker.refreshOfficialStats(targets, { force }).then((changed) => { if (changed) this.postStateToWebview(); }).catch(() => {});
    void this.usageTracker.refreshModelStats(eligible, { force }).then((changed) => { if (changed) this.postStateToWebview(); }).catch(() => {});
  }

  private async handleRefreshModelStats(days: number, force: boolean): Promise<void> {
    if (!this.usageTracker) return;
    const eligible = (this.store.getAll?.() ?? [])
      .filter((a) => isCnAccount(a.domain) && a.accessToken && a.uid)
      .map((a) => ({ id: a.id, token: a.accessToken || '', uid: a.uid || '' }));
    if (!eligible.length) return;
    try {
      const changed = await this.usageTracker.refreshModelStats(eligible, { days, force });
      if (changed) this.postStateToWebview();
    } catch (err: any) {
      console.warn('[SidebarProvider] 模型统计拉取失败:', err?.message || err);
    }
  }

  public async handleRefreshAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) { this.sendNotify('error', t('err.targetMissing')); return; }
    try {
      await this.checkinService.syncAccountStatus(target, this.store);
      this.refreshUsageStats(false);
      this.postStateToWebview();
      this.sendNotify('success', t('msg.refreshOneDone', this.displayLabel(target)));
    } catch (err: any) {
      this.sendNotify('error', t('err.refreshFailed', err?.message || String(err)));
    }
  }

  private async handleRefreshTokenLedger(): Promise<void> {
    if (!this.tokenLedger) return;
    try {
      await this.tokenLedger.getSummary(true);
      this.postStateToWebview();
    } catch (err: any) {
      console.warn('[SidebarProvider] Token 账本刷新失败:', err?.message || err);
    }
  }

  public async handleRefreshStatus(): Promise<void> {
    await this.withOperating(t('msg.refreshing'), 'err.refreshFailed', async () => {
      await this.checkinService.batchSyncStatus(this.store.getAll(), this.store);
      this.refreshUsageStats(true);
      void this.tokenLedger?.getSummary(true).then(() => this.schedulePostState(50)).catch(() => {});
      this.sendNotify('success', t('msg.refreshDone'));
    });
  }

  public async handleTaskRunAuto(accountIds?: string[] | null): Promise<void> { await this.taskOrchestrator.handleTaskRunAuto(accountIds); }
  private async syncBalancesAfterTasks(targets: CodeBuddyAccount[]): Promise<void> { await this.taskOrchestrator.syncBalancesAfterTasks(targets); }

  private setOperating(isOperating: boolean, message: string = ''): void {
    this.isOperating = isOperating;
    this.currentOperationMessage = message;
    this.postStateToWebview();
  }

  public sendNotify(level: 'success' | 'error' | 'warn', message: string, detail?: string): void {
    if (!this._view) return;
    this._view.webview.postMessage({ command: 'notify', level, message, detail: detail || '' });
  }

  public notifySwitchFailure(message: string, detail?: string): void {
    if (!this._view) { void showFailureWithActions(message, detail); return; }
    this.sendNotify('error', message, buildDiagnostic(message, detail));
  }

  private parseJwtPayload(token: string): Record<string, any> | null { return parseJwtPayloadHelper(token); }
  public normalizeImportedAccount(raw: any): CodeBuddyAccount | null { return normalizeImportedAccountHelper(raw); }

  private getImportExportCallbacks() {
    return {
      setOperating: (active: boolean, msg = '') => this.setOperating(active, msg),
      sendNotify: (level: 'success' | 'error' | 'warn', message: string, detail?: string) => this.sendNotify(level, message, detail)
    };
  }

  public async handleImportLocal(): Promise<void> { await readLocalHostAccount(this.importer, this.store, this.checkinService, this.getImportExportCallbacks()); }
  public async handleImportAccountsFile(): Promise<void> { await importFromFileDialog(this.store, this.checkinService, this.getImportExportCallbacks()); }
  public async handleImportJson(text: string): Promise<void> { await importAccountsFromText(text, this.store, this.checkinService, this.getImportExportCallbacks()); }
  public async handleExportAccounts(mode: 'full' | 'masked' = 'full'): Promise<void> {
    await exportAccounts(this.store, mode, (level, message, detail) => this.sendNotify(level, message, detail));
  }

  public async handleToggleAccountStatus(accountId: string): Promise<void> {
    const acc = await this.store.toggleStatus(accountId);
    if (!acc) return;
    const label = this.displayLabel(acc);
    this.sendNotify('success', acc.status === 'disabled' ? t('msg.accountDisabled', label) : t('msg.accountEnabled', label));
    this.postStateToWebview();
  }

  public async handleSaveSettings(settings: Record<string, any>): Promise<void> {
    if (!settings || typeof settings !== 'object') return;
    const parseIntClamped = (raw: unknown, fallback: number, min: number, max: number): number => {
      const n = Number(raw);
      if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, Math.round(n)));
    };
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    try {
      for (const [k, cfgKey] of BOOL_SETTING_MAP) {
        if (k in settings) await cfg.update(cfgKey, Boolean(settings[k]), vscode.ConfigurationTarget.Global);
      }
      for (const [k, cfgKey, def, min, max] of NUM_SETTING_MAP) {
        if (k in settings) await cfg.update(cfgKey, parseIntClamped(settings[k], def, min, max), vscode.ConfigurationTarget.Global);
      }
      for (const [k, cfgKey, def] of STR_SETTING_MAP) {
        if (k in settings) await cfg.update(cfgKey, String(settings[k] || def), vscode.ConfigurationTarget.Global);
      }
      this.sendNotify('success', t('msg.settingsSaved'));
      this.postStateToWebview();
    } catch (err: any) {
      this.sendNotify('error', t('err.saveSettingsFailed', err?.message || String(err)));
    }
  }

  public async handleReauthAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) { this.sendNotify('error', t('err.accountMissing')); return; }
    await this.withOperating(t('msg.reauthRunning', this.displayLabel(target)), 'err.reauthFailed', async () => {
      const refreshed = await this.oauthService.loginAndSave(this.store, {
        domain: target.domain || detectHostEdition(),
        onAuthUrl: (url) => { vscode.env.openExternal(vscode.Uri.parse(url)); this.sendNotify('success', t('msg.reauthPageOpened')); }
      });
      this.sendNotify('success', t('msg.reauthDone', this.displayLabel(refreshed)));
    });
  }

  private async handleUpdateAccountMeta(
    accountId: string,
    displayName: string | undefined,
    notes: string,
    tags: string[]
  ): Promise<void> {
    if (!accountId) return;
    if (typeof (this.store as any).updateMeta === 'function') {
      const ok = await (this.store as any).updateMeta(accountId, { displayName, notes, tags });
      if (ok === false) { this.sendNotify('error', t('err.accountMissing')); return; }
    } else {
      if (displayName !== undefined) await (this.store as any).updateDisplayName?.(accountId, displayName);
      await this.store.updateNotes?.(accountId, notes);
      await this.store.updateTags?.(accountId, tags);
    }
    this.sendNotify('success', t('msg.metaSaved'));
    this.postStateToWebview();
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'main.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview', 'sidebar.js'));
    const htmlPath = path.join(this._extensionUri.fsPath, 'resources', 'webview', 'sidebar.html');
    if (!fs.existsSync(htmlPath)) return `<!DOCTYPE html><html><body><h3>${t('err.htmlMissing')}: ${htmlPath}</h3></body></html>`;

    const cacheBust = Date.now();
    const dict = getLangDict();
    const dictJson = JSON.stringify(dict).replace(/<\//g, '<\\/');
    return fs.readFileSync(htmlPath, 'utf8')
      .replaceAll('{{NONCE}}', () => nonce)
      .replaceAll('{{CSP_SOURCE}}', () => webview.cspSource)
      .replaceAll('{{STYLE_URI}}', () => `${styleUri.toString()}?v=${cacheBust}`)
      .replaceAll('{{SCRIPT_URI}}', () => `${scriptUri.toString()}?v=${cacheBust}`)
      .replaceAll('{{I18N_JSON}}', () => dictJson)
      .replace(/\{\{i:([\w.]+)\}\}/g, (full, key: string) => dict[key] !== undefined ? dict[key] : (console.warn(`[BuddyRelay][i18n] missing webview key: ${key}`), full));
  }

  public reloadWebview(): void {
    if (this._view) this._view.webview.html = this.getHtmlForWebview(this._view.webview);
  }
}
