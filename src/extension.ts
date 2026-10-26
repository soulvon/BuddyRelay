import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CockpitImporter } from './cockpitImporter';
import { CheckinService } from './checkinService';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { AutoSwitcher } from './autoSwitcher';
import { OAuthService } from './oauthService';
import { StatusBarManager } from './statusBar';
import { SidebarProvider } from './sidebarProvider';

let checkinTimer: NodeJS.Timeout | null = null;
let quotaRefreshTimer: NodeJS.Timeout | null = null;
let statusBarManager: StatusBarManager | null = null;
let autoSwitcherInstance: AutoSwitcher | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[BuddyRelay] 正在启动会话保护与交互体系...');

  // 1. 初始化核心存储与调度服务
  const store = new AccountStore(context);
  const switcher = new SeamlessSwitcher();
  const oauthService = new OAuthService();
  const checkinService = new CheckinService();
  const importer = new CockpitImporter();
  const autoSwitcher = new AutoSwitcher(store, switcher, oauthService);
  autoSwitcherInstance = autoSwitcher;

  // 2. 初始化界面体系：左下角常驻状态栏与侧栏 Webview
  statusBarManager = new StatusBarManager(store, switcher);
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    store,
    switcher,
    checkinService,
    importer,
    oauthService
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
    statusBarManager
  );

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
          vscode.window.showInformationMessage(
            `BuddyRelay: 自动初始化成功导入 ${importRes.decryptedCount} 个 Cockpit 账号`
          );
          // 后台异步同步额度
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
        vscode.window.showErrorMessage('未找到指定的 CodeBuddy 账号');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `BuddyRelay: 正在无缝热切至 ${target.nickname || target.email}...`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: '检查 Patch v4 与会话物理穿透...' });
          const res = await switcher.switchAccount(target!, store);
          if (res.success) {
            vscode.window.showInformationMessage(
              `BuddyRelay: 已平滑切换至账号 ${target!.nickname || target!.email}`
            );
          } else {
            vscode.window.showErrorMessage(`BuddyRelay: 热切失败 - ${res.message}`);
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
      } else {
        const accounts = store.getAll();
        if (accounts.length === 0) {
          vscode.window.showInformationMessage('当前号池为空，无账号可删除');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          accounts.map((a) => ({
            label: a.nickname || a.email,
            description: a.email,
            detail: `UID: ${a.uid.slice(0, 8)}... | 状态: ${a.status}`,
            account: a
          })),
          { placeHolder: '选择要从号池中移除的账号' }
        );
        if (picked) {
          await sidebarProvider.handleDeleteAccount(picked.account.id);
        }
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

  context.subscriptions.push(
    showQuickPickCmd,
    switchAccountCmd,
    checkinCmd,
    importCockpitCmd,
    addAccountOAuthCmd,
    deleteAccountCmd,
    refreshStatusCmd
  );

  // 6. 启动后台 429 冷却自愈与 Token 自动续期监视器
  autoSwitcher.startMonitor(60 * 1000);

  // 监听自动轮换事件给操盘手明确反馈
  autoSwitcher.on('rotation', (ev) => {
    const reasonText =
      ev.reason === 'rate_limited_429'
        ? '触发 429 速率限制'
        : ev.reason === 'quota_exhausted'
        ? '额度见底'
        : '调度轮换';
    vscode.window.showWarningMessage(
      `BuddyRelay: ${reasonText}，已自动平滑轮换至备用账号: ${
        ev.targetAccount.nickname || ev.targetAccount.email
      }`
    );
    statusBarManager?.update();
    sidebarProvider.postStateToWebview();
  });

  // 7. 定时任务：自动签到任务与配额刷新任务
  setupScheduledTasks(store, checkinService);

  console.log('[BuddyRelay] 界面与调度体系已就绪');
}

/**
 * 配置定时自动签到与配额刷新守护任务
 */
function setupScheduledTasks(
  store: AccountStore,
  checkinService: CheckinService
): void {
  // 1. 启动时执行一次自动签到检测 (若开启)
  const config = vscode.workspace.getConfiguration('buddyRelay');
  const autoCheckinEnabled = config.get<boolean>('autoCheckin', true);
  if (autoCheckinEnabled) {
    setTimeout(async () => {
      await performDailyCheckinIfNeeded(store, checkinService);
    }, 5000);
  }

  // 2. 定时自动签到守护 (每 4 小时检查一次跨天漏签)
  checkinTimer = setInterval(async () => {
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    if (cfg.get<boolean>('autoCheckin', true)) {
      await performDailyCheckinIfNeeded(store, checkinService);
    }
  }, 4 * 60 * 60 * 1000);

  // 3. 定时配额与状态刷新任务 (默认每 15 分钟)
  const refreshMinutes = Math.max(
    5,
    config.get<number>('refreshIntervalMinutes', 15)
  );
  quotaRefreshTimer = setInterval(async () => {
    try {
      const active = store.getActive();
      if (active) {
        await checkinService.syncAccountStatus(active, store);
      }
      statusBarManager?.update();
    } catch (_) {}
  }, refreshMinutes * 60 * 1000);
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
      vscode.window.showInformationMessage(
        `BuddyRelay: 定时自动签到完成，为 ${report.successCount} 个账号共新领 ${report.totalCreditsAwarded} 点算力`
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
  if (autoSwitcherInstance) {
    autoSwitcherInstance.stopMonitor();
    autoSwitcherInstance = null;
  }
  if (statusBarManager) {
    statusBarManager.dispose();
    statusBarManager = null;
  }
}
