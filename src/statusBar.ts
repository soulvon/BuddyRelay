import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount, maskName, maskUid } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { t } from './i18n';
import { detectHostEdition } from './host';

interface AccountQuickPickItem extends vscode.QuickPickItem {
  actionType: 'account' | 'action';
  account?: CodeBuddyAccount;
  actionId?: string;
}

function fmtNum(n: any): string {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
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
    this.store.on('privacyChange', storeChangeListener);
    this.disposables.push({
      dispose: () => {
        this.store.removeListener('change', storeChangeListener);
        this.store.removeListener('privacyChange', storeChangeListener);
      }
    });

    this.update();
    this.statusBarItem.show();
  }

  /**
   * 刷新状态栏文本与悬浮提示
   */
  public update(): void {
    const active = this.store.getActive();
    const isPrivacy = this.store.getPrivacyMode();

    if (!active) {
      this.statusBarItem.text = `$(credit-card) Buddy: ${t('status.notLoggedIn')}`;
      const emptyMd = new vscode.MarkdownString(t('status.tooltipNone'));
      emptyMd.supportThemeIcons = true;
      this.statusBarItem.tooltip = emptyMd;
      this.statusBarItem.backgroundColor = undefined;
      return;
    }

    const rawName = active.nickname || active.email || t('status.unnamedAccount');
    const name = isPrivacy ? maskName(rawName) : rawName;
    const creditsText =
      typeof active.totalCredits === 'number'
        ? t('status.creditsUnit', fmtNum(active.totalCredits))
        : active.paymentType === 'free'
        ? t('status.freePlan')
        : t('status.ready');

    if (active.status === 'rate_limited') {
      this.statusBarItem.text = `$(warning) Buddy: ${name} (${t('status.rateLimited')})`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.text = `$(credit-card) Buddy: ${name} (${creditsText})`;
      this.statusBarItem.backgroundColor = undefined;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(t('status.tooltipHeader', isPrivacy ? t('status.privacyOn') : ''));
    md.appendMarkdown(t('status.tooltipAccount', name));
    md.appendMarkdown(t('status.tooltipUid', isPrivacy ? maskUid(active.uid) : active.uid));
    md.appendMarkdown(t('status.tooltipCredits', typeof active.totalCredits === 'number' ? t('status.creditsReady', fmtNum(active.totalCredits)) : t('status.ready')));
    md.appendMarkdown(t('status.tooltipCheckin', active.todayCheckedIn ? t('status.checked') : t('status.unchecked'), active.checkinStreak || 0));
    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`$(arrow-swap) ${t('status.tooltipClick')}`);

    this.statusBarItem.tooltip = md;
  }

  /**
   * 弹出 QuickPick 快速切号下拉菜单
   */
  public async showQuickPick(): Promise<void> {
    const accounts = this.store.getAll();
    const isPrivacy = this.store.getPrivacyMode();
    const isCnHost = detectHostEdition() === 'cn';

    const items: AccountQuickPickItem[] = [];

    if (accounts.length > 0) {
      for (const acc of accounts) {
        const isActive = acc.status === 'active';
        const rawName = acc.nickname || acc.email;
        const labelName = isPrivacy ? maskName(rawName) : rawName;
        const displayUid = isPrivacy ? maskUid(acc.uid) : `${acc.uid.slice(0, 8)}...`;
        const icon = isActive
          ? '$(check)'
          : acc.status === 'rate_limited'
          ? '$(watch)'
          : acc.status === 'expired'
          ? '$(error)'
          : '$(account)';

        const statusLabel =
          acc.status === 'active'
            ? t('qp.statusActive')
            : acc.status === 'rate_limited'
            ? t('status.rateLimited')
            : acc.status === 'idle'
            ? t('status.ready')
            : acc.status;

        const creditsStr =
          typeof acc.totalCredits === 'number'
            ? t('qp.creditsUnit', fmtNum(acc.totalCredits))
            : acc.paymentType || t('qp.free');

        items.push({
          label: `${icon} ${labelName}`,
          description: `[${statusLabel}] ${creditsStr}`,
          detail: t('qp.detailStreak', displayUid, acc.checkinStreak || 0, acc.todayCheckedIn ? t('qp.checkedToday') : t('qp.notCheckedToday')),
          actionType: 'account',
          account: acc
        });
      }
    }

    // 分隔线与快捷操作
    items.push({
      label: t('qp.quickActions'),
      kind: vscode.QuickPickItemKind.Separator,
      actionType: 'action'
    });

    items.push({
      label: isPrivacy ? `$(eye-closed) ${t('qp.privacyExit')}` : `$(eye) ${t('qp.privacyEnter')}`,
      description: isPrivacy ? t('qp.privacyExitDesc') : t('qp.privacyEnterDesc'),
      detail: t('qp.privacyDetail'),
      actionType: 'action',
      actionId: 'togglePrivacy'
    });

    items.push({
      label: `$(add) ${t('qp.addOAuth')}`,
      description: t('qp.addOAuthDesc'),
      detail: t('qp.addOAuthDetail'),
      actionType: 'action',
      actionId: 'addOAuth'
    });

    items.push({
      label: `$(cloud-download) ${t('qp.importCockpit')}`,
      description: t('qp.importCockpitDesc'),
      detail: t('qp.importCockpitDetail'),
      actionType: 'action',
      actionId: 'importCockpit'
    });

    // 签到为国内版 (codebuddy.cn) 专属活动, 国际宿主下不出现
    if (isCnHost) {
      items.push({
        label: `$(check-all) ${t('qp.batchCheckin')}`,
        description: t('qp.batchCheckinDesc'),
        detail: t('qp.batchCheckinDetail'),
        actionType: 'action',
        actionId: 'batchCheckin'
      });
    }

    items.push({
      label: `$(refresh) ${t('qp.refresh')}`,
      description: t('qp.refreshDesc'),
      detail: t('qp.refreshDetail'),
      actionType: 'action',
      actionId: 'refresh'
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: t('qp.title'),
      placeHolder: t('qp.placeholder'),
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
        case 'togglePrivacy':
          await this.store.setPrivacyMode(!isPrivacy);
          vscode.window.showInformationMessage(!isPrivacy ? t('qp.privacyEnabled') : t('qp.privacyDisabled'));
          break;
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
        title: t('msg.switchingTo', target.nickname || target.email),
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: t('msg.progressPatch') });
        const res = await this.switcher.switchAccount(target, this.store);
        if (res.success) {
          this.update();
          vscode.window.showInformationMessage(t('msg.switched', target.nickname || target.email));
        } else {
          vscode.window.showErrorMessage(t('msg.switchFailed', res.message));
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
