import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CockpitImporter } from './cockpitImporter';
import { CheckinService } from './checkinService';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { AutoSwitcher } from './autoSwitcher';
import { OAuthService } from './oauthService';

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly account: CodeBuddyAccount,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(account.nickname || account.email, collapsibleState);
    const streak = account.checkinStreak || 0;
    const checkedToday = account.todayCheckedIn ? '今日已签' : '今日未签';
    this.tooltip = `昵称: ${account.nickname}\n账号: ${account.email}\nUID: ${account.uid}\n状态: ${account.status}\n加油站: 连续 ${streak} 天 (${checkedToday})`;
    this.description = `${account.email} [${account.status}]`;
    this.contextValue = 'sessionItem';

    if (account.status === 'active') {
      this.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    } else if (account.status === 'rate_limited') {
      this.iconPath = new vscode.ThemeIcon('watch', new vscode.ThemeColor('editorWarning.foreground'));
    } else if (account.status === 'expired' || account.status === 'disabled') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }
  }
}

class EnvironmentItem extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly nodeCount: number,
    public readonly detailText: string
  ) {
    super(envName, vscode.TreeItemCollapsibleState.None);
    this.description = `${nodeCount} 个会话节点`;
    this.tooltip = detailText;
    this.iconPath = new vscode.ThemeIcon('server-environment');
  }
}

class SessionTreeDataProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: AccountStore) {
    this.store.on('change', () => this.refresh());
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<SessionItem[]> {
    const list = this.store.getAll();
    return Promise.resolve(
      list.map(acc => new SessionItem(acc, vscode.TreeItemCollapsibleState.None))
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getActiveAccount(): CodeBuddyAccount | undefined {
    return this.store.getActive();
  }
}

class EnvironmentTreeDataProvider implements vscode.TreeDataProvider<EnvironmentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EnvironmentItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: AccountStore) {
    this.store.on('change', () => this.refresh());
  }

  getTreeItem(element: EnvironmentItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<EnvironmentItem[]> {
    const all = this.store.getAll();
    const activeCount = all.filter(a => a.status === 'active').length;
    const idleCount = all.filter(a => a.status === 'idle').length;
    const limitedCount = all.filter(a => a.status === 'rate_limited').length;

    const items = [
      new EnvironmentItem('生产热切池 (Active & Ready)', activeCount + idleCount, `活跃: ${activeCount}, 就绪待命: ${idleCount}`),
      new EnvironmentItem('429 冷却缓冲队列', limitedCount, `当前冷却中节点: ${limitedCount}`),
      new EnvironmentItem('5.7GB 物理穿透联结', all.length, `NTFS Junction 映射节点数: ${all.length}`)
    ];
    return Promise.resolve(items);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  // 1. 初始化核心模块
  const store = new AccountStore(context);
  const switcher = new SeamlessSwitcher();
  const oauthService = new OAuthService();
  const checkinService = new CheckinService();
  const autoSwitcher = new AutoSwitcher(store, switcher, oauthService);

  // 2. 自动检查并打底载入 Cockpit 账号池
  if (store.count() === 0) {
    try {
      const importer = new CockpitImporter();
      const importRes = await importer.importToStore(store);
      if (importRes.success) {
        vscode.window.showInformationMessage(`BuddyRelay: 自动初始化成功导入 ${importRes.decryptedCount} 个 Cockpit Tools 账号`);
      }
    } catch (_) {}
  }

  // 3. 自愈检查 main.js Patch v4
  try {
    const patchRes = switcher.healPatch();
    if (patchRes.success) {
      console.log('[BuddyRelay] ' + patchRes.message);
    }
  } catch (err: any) {
    console.warn('[BuddyRelay] Patch v4 自愈警告: ' + err.message);
  }

  // 4. 注册视图
  const sessionProvider = new SessionTreeDataProvider(store);
  const environmentProvider = new EnvironmentTreeDataProvider(store);

  vscode.window.registerTreeDataProvider('buddy-relay.sessionView', sessionProvider);
  vscode.window.registerTreeDataProvider('buddy-relay.environmentView', environmentProvider);

  // 5. 注册状态栏
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'buddy-relay.switchAccount';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(sessionProvider);
  statusBarItem.show();

  store.on('change', () => {
    updateStatusBar(sessionProvider);
  });

  // 6. 命令：切换账号
  const switchAccountCmd = vscode.commands.registerCommand('buddy-relay.switchAccount', async (item?: SessionItem) => {
    let target: CodeBuddyAccount | undefined;

    if (item && item.account) {
      target = item.account;
    } else {
      const accounts = store.getAll();
      if (accounts.length === 0) {
        const act = await vscode.window.showWarningMessage('号池为空，是否立即从 Cockpit Tools 导入？', '一键导入', '取消');
        if (act === '一键导入') {
          await vscode.commands.executeCommand('buddy-relay.importCockpit');
        }
        return;
      }

      const picks = accounts.map(a => ({
        label: a.nickname || a.email,
        description: `[${a.status}] ${a.email}`,
        detail: `UID: ${a.uid.slice(0, 8)}... | 连续签到: ${a.checkinStreak || 0}天 ${a.status === 'active' ? '(当前活跃)' : ''}`,
        account: a
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: '选择要无感热切的目标 CodeBuddy 账号'
      });
      if (selected) {
        target = selected.account;
      }
    }

    if (target) {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `BuddyRelay: 正在无缝热切至 ${target.nickname || target.email}...`,
        cancellable: false
      }, async (progress) => {
        progress.report({ message: '检查 Patch v4 与会话物理穿透...' });
        const res = await switcher.switchAccount(target!, store);
        if (res.success) {
          vscode.window.showInformationMessage(`BuddyRelay: 已平滑切换至账号 ${target!.nickname} (${target!.email})`);
        } else {
          vscode.window.showErrorMessage(`BuddyRelay: 热切失败 - ${res.message}`);
        }
      });
    }
  });

  // 7. 命令：一键签到
  const checkinCmd = vscode.commands.registerCommand('buddy-relay.checkin', async () => {
    const accounts = store.getAll();
    if (accounts.length === 0) {
      vscode.window.showWarningMessage('BuddyRelay: 号池中暂无账号可供签到');
      return;
    }

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'BuddyRelay: 正在执行 Buddy 加油站批量签到...',
      cancellable: false
    }, async (progress) => {
      progress.report({ message: `正在为 ${accounts.length} 个账号同步状态并领算力...` });
      const report = await checkinService.batchCheckin(accounts, store);
      vscode.window.showInformationMessage(
        `BuddyRelay: 签到完成！新领算力: ${report.totalCreditsAwarded}点 | 成功: ${report.successCount} | 今日已领: ${report.alreadyCheckedInCount} | 失败: ${report.failedCount}`
      );
    });
  });

  // 8. 命令：一键从 Cockpit Tools 导入
  const importCockpitCmd = vscode.commands.registerCommand('buddy-relay.importCockpit', async () => {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'BuddyRelay: 正在读取 Cockpit Tools 安全凭据并解密...',
      cancellable: false
    }, async () => {
      const importer = new CockpitImporter();
      const check = importer.verifyCockpitStorage();
      if (!check.hasKey) {
        vscode.window.showErrorMessage(`BuddyRelay: 未找到 Cockpit 存储密钥 (${check.message})`);
        return;
      }

      const res = await importer.importToStore(store);
      if (res.success) {
        vscode.window.showInformationMessage(`BuddyRelay: 成功解密并导入 ${res.decryptedCount} 个 Cockpit Tools 账号！`);
      } else {
        vscode.window.showErrorMessage(`BuddyRelay: 导入失败 - ${res.errors.map(e => e.error).join('; ')}`);
      }
    });
  });

  // 9. 命令：刷新状态
  const refreshStatusCmd = vscode.commands.registerCommand('buddy-relay.refreshStatus', async () => {
    store.load();
    sessionProvider.refresh();
    environmentProvider.refresh();
    updateStatusBar(sessionProvider);
    vscode.window.showInformationMessage('BuddyRelay: 状态与号池已刷新');
  });

  // 10. 启动 429 与健康调度监视器
  autoSwitcher.startMonitor(60 * 1000);

  context.subscriptions.push(
    switchAccountCmd,
    checkinCmd,
    importCockpitCmd,
    refreshStatusCmd,
    {
      dispose: () => autoSwitcher.stopMonitor()
    }
  );
}

function updateStatusBar(sessionProvider: SessionTreeDataProvider) {
  const active = sessionProvider.getActiveAccount();
  if (active) {
    statusBarItem.text = `$(shield) Buddy: ${active.nickname || active.email}`;
    statusBarItem.tooltip = `当前活跃账号: ${active.nickname} (${active.email})\nUID: ${active.uid}\n连续签到: ${active.checkinStreak || 0}天\n点击切换账号`;
  } else {
    statusBarItem.text = `$(shield) Buddy: 未就绪`;
    statusBarItem.tooltip = '点击切换或导入账号';
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
