import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';

interface AccountQuickPickItem extends vscode.QuickPickItem {
  actionType: 'account' | 'action';
  account?: CodeBuddyAccount;
  actionId?: string;
}

/**
 * BuddyRelay 左下角常驻状态栏管理器
 * 遵循克制扁平、自然中文原则，展示当前账号名称与额度积分，点击唤起切号下拉菜单
 */
export class StatusBarManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private disposables: vscode.Disposable[] = [];

  constructor(store: AccountStore, switcher: SeamlessSwitcher) {
    this.store = store;
    this.switcher = switcher;

    // 右下角常驻 (vscode.StatusBarAlignment.Right, 优先级 100)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'buddy-relay.showAccountQuickPick';

    // 监听号池状态变化自动更新
    const storeChangeListener = () => this.update();
    this.store.on('change', storeChangeListener);
    this.disposables.push({
      dispose: () => this.store.removeListener('change', storeChangeListener)
    });

    this.update();
    this.statusBarItem.show();
  }

  /**
   * 刷新状态栏文本与悬浮提示
   */
  public update(): void {
    const active = this.store.getActive();

    if (!active) {
      this.statusBarItem.text = '$(shield) Buddy: 未登录';
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        '**BuddyRelay 会话保护中**\n\n当前号池中暂无活跃账号。\n\n点击立即切换、导入或添加账号。'
      );
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const name = active.nickname || active.email || '未命名账号';
    const creditsText =
      typeof active.totalCredits === 'number'
        ? `${Number(active.totalCredits).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}点`
        : active.paymentType === 'free'
        ? '免费版'
        : '就绪';

    if (active.status === 'rate_limited') {
      this.statusBarItem.text = `$(warning) Buddy: ${name} (429冷却中)`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.text = `$(shield) Buddy: ${name} (${creditsText})`;
      this.statusBarItem.backgroundColor = undefined;
    }

    const streakText = `连续签到 ${active.checkinStreak || 0} 天`;
    const checkinText = active.todayCheckedIn ? '今日已签到' : '今日未签到';
    const statusMap: Record<string, string> = {
      active: '当前活跃 (Active)',
      idle: '就绪待命 (Idle)',
      rate_limited: '429冷却中 (Rate Limited)',
      expired: '已失效 (Expired)',
      disabled: '已禁用 (Disabled)'
    };
    const statusDesc = statusMap[active.status] || active.status;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown('### $(shield) BuddyRelay 会话状态\n\n');
    md.appendMarkdown(`- **当前账号**: ${name}\n`);
    md.appendMarkdown(`- **账号标识**: \`${active.email}\`\n`);
    md.appendMarkdown(`- **用户 UID**: \`${active.uid}\`\n`);
    md.appendMarkdown(`- **额度积分**: **${typeof active.totalCredits === 'number' ? `${Number(active.totalCredits).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} 算力点` : '未同步'}**\n`);
    md.appendMarkdown(`- **加油站**: ${streakText} (${checkinText})\n`);
    md.appendMarkdown(`- **运行状态**: ${statusDesc}\n\n`);
    md.appendMarkdown('---\n\n');
    md.appendMarkdown('$(arrow-swap) *点击弹出快速切号下拉菜单*');

    this.statusBarItem.tooltip = md;
  }

  /**
   * 弹出 QuickPick 快速切号下拉菜单
   */
  public async showQuickPick(): Promise<void> {
    const accounts = this.store.getAll();

    const items: AccountQuickPickItem[] = [];

    if (accounts.length > 0) {
      for (const acc of accounts) {
        const isActive = acc.status === 'active';
        const labelName = acc.nickname || acc.email;
        const icon = isActive
          ? '$(check)'
          : acc.status === 'rate_limited'
          ? '$(watch)'
          : acc.status === 'expired'
          ? '$(error)'
          : '$(account)';

        const statusLabel =
          acc.status === 'active'
            ? '当前活跃'
            : acc.status === 'rate_limited'
            ? '429冷却'
            : acc.status === 'idle'
            ? '就绪'
            : acc.status;

        const creditsStr =
          typeof acc.totalCredits === 'number'
            ? `${Number(acc.totalCredits).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} 算力点`
            : acc.paymentType || '免费';

        items.push({
          label: `${icon} ${labelName}`,
          description: `[${statusLabel}] ${creditsStr}`,
          detail: `UID: ${acc.uid.slice(0, 8)}... | 连续签到: ${acc.checkinStreak || 0}天 | ${
            acc.todayCheckedIn ? '今日已签' : '今日未签'
          }`,
          actionType: 'account',
          account: acc
        });
      }
    }

    // 分隔线与快捷操作
    items.push({
      label: '快捷操作',
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'action'
    });

    items.push({
      label: '$(add) 添加账号 (OAuth 授权登录)',
      description: '发起官方授权流程',
      detail: '打开 CodeBuddy 官方网页或扫码登录，自动同步至本地号池',
      actionType: 'action',
      actionId: 'addOAuth'
    });

    items.push({
      label: '$(cloud-download) 从 Cockpit 导入账号',
      description: '本地 AES-256-GCM 安全导入',
      detail: '读取 %USERPROFILE%\\.antigravity_cockpit 密文账号池并解密',
      actionType: 'action',
      actionId: 'importCockpit'
    });

    items.push({
      label: '$(check-all) 一键全员签到',
      description: 'Buddy加油站批量领算力',
      detail: '自动同步全量账号状态并领取今日签到算力积分',
      actionType: 'action',
      actionId: 'batchCheckin'
    });

    items.push({
      label: '$(refresh) 刷新状态与配额',
      description: '重新载入号池与云端配额',
      detail: '更新账号列表与加油站积分状态',
      actionType: 'action',
      actionId: 'refresh'
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'BuddyRelay 快速切换与会话调度',
      placeHolder: '选择要无感热切的目标账号，或执行全局快捷操作',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selected) {
      return;
    }

    if (selected.actionType === 'account' && selected.account) {
      await this.handleSwitch(selected.account);
    } else if (selected.actionType === 'action' && selected.actionId) {
      switch (selected.actionId) {
        case 'addOAuth':
          await vscode.commands.executeCommand('buddy-relay.addAccountOAuth');
          break;
        case 'importCockpit':
          await vscode.commands.executeCommand('buddy-relay.importCockpit');
          break;
        case 'batchCheckin':
          await vscode.commands.executeCommand('buddy-relay.checkin');
          break;
        case 'refresh':
          await vscode.commands.executeCommand('buddy-relay.refreshStatus');
          break;
      }
    }
  }

  /**
   * 执行账号热切并反馈进度
   */
  private async handleSwitch(target: CodeBuddyAccount): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `BuddyRelay: 正在无缝热切至 ${target.nickname || target.email}...`,
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: '检查 Patch v4 与会话物理穿透...' });
        const res = await this.switcher.switchAccount(target, this.store);
        if (res.success) {
          this.update();
          vscode.window.showInformationMessage(
            `BuddyRelay: 已平滑切换至账号 ${target.nickname || target.email}`
          );
        } else {
          vscode.window.showErrorMessage(`BuddyRelay: 热切失败 - ${res.message}`);
        }
      }
    );
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
