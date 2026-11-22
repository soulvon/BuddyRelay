import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CockpitImporter } from './cockpitImporter';
import { CheckinService } from './checkinService';
import { SeamlessSwitcher, ElevationPlan } from './seamlessSwitcher';
import { AutoSwitcher } from './autoSwitcher';
import { CheckinScheduler } from './checkinScheduler';
import { OAuthService } from './oauthService';
import { StatusBarManager } from './statusBar';
import { SidebarProvider } from './sidebarProvider';
import { checkForUpdates } from './updater';
import { initAccountLock, acquireLock, releaseLock, startHeartbeat, stopHeartbeat, releaseSchedulerLeader } from './accountLock';
import { UsageTracker } from './usageTracker';
import { SessionHealer } from './sessionHealer';
import { CooldownLogWatcher } from './cooldownLogWatcher';
import { SchedulerCoordinator } from './schedulerCoordinator';
import { TokenLedger } from './tokenLedger';
import { formatAccountLabel } from './importExportService';
import { t, initI18n, watchLocaleConfig, onLangChange } from './i18n';

let reconcileTimer: NodeJS.Timeout | null = null;
let checkinScheduler: CheckinScheduler | null = null;
let statusBarManager: StatusBarManager | null = null;
let autoSwitcherInstance: AutoSwitcher | null = null;
let schedulerCoordinator: SchedulerCoordinator | null = null;
let sidebarProviderInstance: SidebarProvider | null = null;
let tokenLedgerInstance: TokenLedger | null = null;

export async function activate(context: vscode.ExtensionContext) {
  initI18n();

  const store = new AccountStore(context);
  const switcher = new SeamlessSwitcher({
    mainJsPath: vscode.workspace.getConfiguration('buddyRelay').get<string>('mainJsPath', '').trim() || undefined,
    appRoot: vscode.env.appRoot
  });
  const oauthService = new OAuthService();
  const checkinService = new CheckinService();
  const importer = new CockpitImporter();
  const usageTracker = new UsageTracker();
  const tokenLedger = new TokenLedger();
  tokenLedgerInstance = tokenLedger;
  const autoSwitcher = new AutoSwitcher(store, switcher, oauthService, { usageTracker });
  autoSwitcherInstance = autoSwitcher;
  checkinScheduler = new CheckinScheduler(store, checkinService);

  const windowName = t('common.window', vscode.env.sessionId.slice(0, 8).toUpperCase());
  initAccountLock(`${vscode.env.sessionId}:${process.pid}`, windowName);
  const initialActiveUid = store.getActive()?.uid || null;
  if (initialActiveUid) acquireLock(initialActiveUid);
  startHeartbeat();

  const defaultPrivacy = vscode.workspace.getConfiguration('buddyRelay').get<boolean>('privacyModeDefault', false);
  if (defaultPrivacy && !store.getPrivacyMode()) store.setPrivacyMode(true).catch(() => {});

  const sidebarProvider = new SidebarProvider(
    context.extensionUri, store, switcher, checkinService, importer, oauthService, usageTracker, { tokenLedger }
  );
  sidebarProviderInstance = sidebarProvider;
  statusBarManager = new StatusBarManager(
    store, switcher, () => sidebarProvider.promptFullRestart(), usageTracker,
    (plan, account) => sidebarProvider.promptElevationAndApply(plan, account).then(() => {}),
    tokenLedger
  );

  // store.on('change') 仅做界面刷新，绝不抢占他窗账号锁
  const refreshUi = () => { sidebarProvider.schedulePostState(); statusBarManager?.update(); };
  store.on('change', refreshUi);

  const cooldownWatcher = new CooldownLogWatcher();

  context.subscriptions.push(
    { dispose: () => store.dispose() }, { dispose: () => sidebarProvider.dispose() },
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    statusBarManager, watchLocaleConfig()
  );
  onLangChange(() => { statusBarManager?.update(); sidebarProvider.reloadWebview(); });

  const pendingStartupTs = switcher.readPendingCommandTs();
  runStartupHealing(switcher, store, sidebarProvider, pendingStartupTs);
  bootstrapInitialPool(store, importer, checkinService, sidebarProvider);
  registerCommands(context, store, switcher, sidebarProvider);

  schedulerCoordinator = new SchedulerCoordinator({
    store, switcher, checkinService, autoSwitcher, checkinScheduler, cooldownWatcher, usageTracker, tokenLedger,
    onStateUpdated: refreshUi,
    onNotify: (level: 'success' | 'info' | 'warn' | 'error', message: string, detail?: string) =>
      sidebarProvider.sendNotify(level === 'info' ? 'success' : level, message, detail),
    onRequestTaskRunAuto: () => sidebarProvider.handleTaskRunAuto(),
    onPromptRestart: () => sidebarProvider.promptFullRestart(),
    onPromptElevation: (plan: ElevationPlan, acc?: CodeBuddyAccount) => sidebarProvider.promptElevationAndApply(plan, acc).then(() => {})
  });
  schedulerCoordinator.start();

  context.subscriptions.push(
    schedulerCoordinator,
    vscode.workspace.onDidChangeConfiguration((e) => schedulerCoordinator?.onConfigurationChanged(e))
  );
}

function runStartupHealing(switcher: SeamlessSwitcher, store: AccountStore, sidebarProvider: SidebarProvider, pendingStartupTs: number | null): void {
  try {
    const patchRes = switcher.healPatch();
    if (patchRes.success && patchRes.repatched) void sidebarProvider.promptNativeRestart(t('sw.restartHint'));
    else if (!patchRes.success && patchRes.needsElevation && patchRes.elevationPlan) void sidebarProvider.promptElevationAndApply(patchRes.elevationPlan);
  } catch {}

  const syncReconciledUi = (aligned: CodeBuddyAccount | null) => {
    if (!aligned) return;
    if (aligned.uid) acquireLock(aligned.uid);
    statusBarManager?.update();
    sidebarProvider.postStateToWebview();
  };
  void switcher.reconcilePendingSwitch(store, pendingStartupTs ?? undefined).then((firstAligned) => {
    syncReconciledUi(firstAligned);
    if (firstAligned || pendingStartupTs === null) return;
    let attempts = 0;
    reconcileTimer = setInterval(async () => {
      attempts++;
      try {
        const aligned = await switcher.reconcilePendingSwitch(store, pendingStartupTs);
        if (aligned || attempts >= 6) {
          if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
          syncReconciledUi(aligned);
        }
      } catch {
        if (attempts >= 6 && reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
      }
    }, 600);
  }).catch(() => {});

  try { if (new SessionHealer().heal().healed) vscode.window.showInformationMessage(t('heal.done')); } catch {}
}

function bootstrapInitialPool(store: AccountStore, importer: CockpitImporter, checkinService: CheckinService, sidebarProvider: SidebarProvider): void {
  if (store.count() !== 0) return;
  try {
    const verify = importer.verifyCockpitStorage();
    if (verify.hasKey && verify.accountFilesCount > 0) {
      void importer.importToStore(store).then((res) => {
        if (res.success) {
          sidebarProvider.sendNotify('success', t('msg.autoImported', res.decryptedCount));
          checkinService.batchSyncStatus(store.getAll(), store).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch {}
}

function registerCommands(context: vscode.ExtensionContext, store: AccountStore, switcher: SeamlessSwitcher, sidebarProvider: SidebarProvider): void {
  const cmds: Array<[string, (...args: any[]) => any]> = [
    ['buddy-relay.showAccountQuickPick', () => statusBarManager?.showQuickPick()],
    ['buddy-relay.switchAccount', async (accountOrId?: CodeBuddyAccount | string) => {
      if (!accountOrId) { await statusBarManager?.showQuickPick(); return; }
      const target = typeof accountOrId === 'string' ? (store.get(accountOrId) || store.find(accountOrId)) : accountOrId;
      if (!target) { vscode.window.showErrorMessage(t('err.accountNotFound')); return; }
      const label = formatAccountLabel(target, store.getPrivacyMode?.() ?? false);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('msg.switchingTo', label), cancellable: false }, async (progress) => {
        progress.report({ message: t('msg.progressPatch') });
        const res = await switcher.switchAccount(target, store);
        if (res.needsElevation && res.elevationPlan) { await sidebarProvider.promptElevationAndApply(res.elevationPlan, target); return; }
        if (res.needsFullRestart) { await sidebarProvider.promptFullRestart(); return; }
        if (res.success) { if (target.uid) acquireLock(target.uid); sidebarProvider.sendNotify('success', t('msg.switched', label)); }
        else sidebarProvider.notifySwitchFailure(t('msg.switchFailed', res.message), res.detail);
      });
    }],
    ['buddy-relay.checkin', () => sidebarProvider.handleBatchCheckin()],
    ['buddy-relay.importCockpit', () => sidebarProvider.handleImportCockpit()],
    ['buddy-relay.addAccountOAuth', () => sidebarProvider.handleAddAccountOAuth()],
    ['buddy-relay.deleteAccount', async (a?: CodeBuddyAccount | string) => { if (a) await sidebarProvider.handleDeleteAccount(typeof a === 'string' ? a : a.id); }],
    ['buddy-relay.refreshStatus', () => sidebarProvider.handleRefreshStatus()],
    ['buddy-relay.checkUpdate', () => checkForUpdates(false)],
    ['buddy-relay.repairSessions', async () => {
      try {
        const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('heal.running'), cancellable: false }, async () => new SessionHealer().heal());
        if (res.error === 'NO_DATA_ROOT' || res.error === 'NO_USABLE_DATA') { vscode.window.showWarningMessage(t('heal.nothing', res.message)); return; }
        vscode.window.showInformationMessage(t(res.healed ? 'heal.repairDone' : 'heal.noIssue'));
      } catch (err: any) { vscode.window.showErrorMessage(t('heal.failed', err?.message || String(err))); }
    }]
  ];
  for (const [id, fn] of cmds) context.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

export function deactivate() {
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  schedulerCoordinator?.dispose(); schedulerCoordinator = null;
  checkinScheduler?.stop(); checkinScheduler = null;
  autoSwitcherInstance?.stopMonitor(); autoSwitcherInstance = null;
  statusBarManager?.dispose(); statusBarManager = null;
  sidebarProviderInstance?.dispose(); sidebarProviderInstance = null;
  tokenLedgerInstance?.dispose(); tokenLedgerInstance = null;
  try { releaseLock(); stopHeartbeat(); releaseSchedulerLeader(); } catch {}
}
