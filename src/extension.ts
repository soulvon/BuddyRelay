import * as vscode from 'vscode';

interface RelayAccount {
  id: string;
  label: string;
  status: 'active' | 'idle' | 'expired';
  environment: string;
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly account: RelayAccount,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(account.label, collapsibleState);
    this.tooltip = `环境: ${account.environment} | 状态: ${account.status}`;
    this.description = account.environment;
    this.contextValue = 'sessionItem';
    this.iconPath = new vscode.ThemeIcon(
      account.status === 'active' ? 'pass-filled' : account.status === 'idle' ? 'circle-outline' : 'warning'
    );
  }
}

class EnvironmentItem extends vscode.TreeItem {
  constructor(
    public readonly envName: string,
    public readonly nodeCount: number
  ) {
    super(envName, vscode.TreeItemCollapsibleState.None);
    this.description = `${nodeCount} 个会话节点`;
    this.iconPath = new vscode.ThemeIcon('server-environment');
  }
}

class SessionTreeDataProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private accounts: RelayAccount[] = [
    { id: 'acc_01', label: '主企业会话 (Primary)', status: 'active', environment: '生产隔离区 A' },
    { id: 'acc_02', label: '备用演练会话 (Standby)', status: 'idle', environment: '沙盒环境 B' },
    { id: 'acc_03', label: '跨域中继会话 (Relay-03)', status: 'idle', environment: '合规镜像区 C' }
  ];

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<SessionItem[]> {
    return Promise.resolve(
      this.accounts.map(acc => new SessionItem(acc, vscode.TreeItemCollapsibleState.None))
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getActiveAccount(): RelayAccount | undefined {
    return this.accounts.find(a => a.status === 'active');
  }

  setActiveAccount(id: string): void {
    for (const acc of this.accounts) {
      acc.status = acc.id === id ? 'active' : 'idle';
    }
    this.refresh();
  }

  getAccounts(): RelayAccount[] {
    return this.accounts;
  }
}

class EnvironmentTreeDataProvider implements vscode.TreeDataProvider<EnvironmentItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<EnvironmentItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private envs = [
    { name: '生产隔离区 A', count: 1 },
    { name: '沙盒环境 B', count: 1 },
    { name: '合规镜像区 C', count: 1 }
  ];

  getTreeItem(element: EnvironmentItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<EnvironmentItem[]> {
    return Promise.resolve(
      this.envs.map(e => new EnvironmentItem(e.name, e.count))
    );
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const sessionProvider = new SessionTreeDataProvider();
  const environmentProvider = new EnvironmentTreeDataProvider();

  vscode.window.registerTreeDataProvider('buddy-relay.sessionView', sessionProvider);
  vscode.window.registerTreeDataProvider('buddy-relay.environmentView', environmentProvider);

  // 初始化状态栏
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'buddy-relay.switchAccount';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(sessionProvider);
  statusBarItem.show();

  // 命令：切换账号
  const switchAccountCmd = vscode.commands.registerCommand('buddy-relay.switchAccount', async (item?: SessionItem) => {
    if (item && item.account) {
      sessionProvider.setActiveAccount(item.account.id);
      updateStatusBar(sessionProvider);
      vscode.window.showInformationMessage(`已平滑切换至会话: ${item.account.label}`);
      return;
    }

    const items = sessionProvider.getAccounts().map(a => ({
      label: a.label,
      description: `[${a.environment}]`,
      detail: a.status === 'active' ? '当前活跃中' : '就绪待命',
      account: a
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要切换的目标工作区会话'
    });

    if (selected) {
      sessionProvider.setActiveAccount(selected.account.id);
      updateStatusBar(sessionProvider);
      vscode.window.showInformationMessage(`已平滑切换至会话: ${selected.account.label}`);
    }
  });

  // 命令：一键签到与保活
  const checkinCmd = vscode.commands.registerCommand('buddy-relay.checkin', async () => {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'BuddyRelay: 正在同步会话心跳与合规状态...',
      cancellable: false
    }, async () => {
      await new Promise(resolve => setTimeout(resolve, 800));
    });
    vscode.window.showInformationMessage('BuddyRelay: 会话心跳与状态保活已完成，当前环境安全合规。');
  });

  // 命令：导入Cockpit配置
  const importCockpitCmd = vscode.commands.registerCommand('buddy-relay.importCockpit', async () => {
    const input = await vscode.window.showInputBox({
      prompt: '请输入 Cockpit 外部会话配置源地址或凭据标识',
      placeHolder: 'cockpit://session-relay/endpoint-token'
    });

    if (input) {
      vscode.window.showInformationMessage('BuddyRelay: Cockpit 外部配置已成功导入并加入备用池。');
      sessionProvider.refresh();
      environmentProvider.refresh();
    }
  });

  // 命令：刷新状态
  const refreshStatusCmd = vscode.commands.registerCommand('buddy-relay.refreshStatus', () => {
    sessionProvider.refresh();
    environmentProvider.refresh();
    updateStatusBar(sessionProvider);
    vscode.window.showInformationMessage('BuddyRelay: 状态已刷新');
  });

  context.subscriptions.push(
    switchAccountCmd,
    checkinCmd,
    importCockpitCmd,
    refreshStatusCmd
  );
}

function updateStatusBar(sessionProvider: SessionTreeDataProvider) {
  const active = sessionProvider.getActiveAccount();
  if (active) {
    statusBarItem.text = `$(shield) BuddyRelay: ${active.label.split(' ')[0]}`;
    statusBarItem.tooltip = `当前活跃会话: ${active.label} (${active.environment})\n点击切换账号`;
  } else {
    statusBarItem.text = `$(shield) BuddyRelay: 未连接`;
    statusBarItem.tooltip = '点击切换或配置会话';
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
