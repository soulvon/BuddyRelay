import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount, QuotaPackageItem } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { CheckinService } from './checkinService';
import { CockpitImporter } from './cockpitImporter';
import { OAuthService } from './oauthService';
import { GrowthTaskService, GrowthTask } from './growthTaskService';
import { getOtherLockedUids } from './accountLock';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'buddy-relay.sidebarView';

  private _view?: vscode.WebviewView;
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private checkinService: CheckinService;
  private importer: CockpitImporter;
  private oauthService: OAuthService;
  private growthTasks: GrowthTaskService;
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
    oauthService: OAuthService
  ) {
    this.extensionUri = extensionUri;
    this.store = store;
    this.switcher = switcher;
    this.checkinService = checkinService;
    this.importer = importer;
    this.oauthService = oauthService;
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
          this.sendNotify('error', '已请求中止任务批处理');
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
    const checkedTodayCount = accounts.filter((a) => a.todayCheckedIn).length;
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
      autoSwitchEnabled: cfg.get<boolean>('autoSwitch.enabled', true),
      quotaThresholdPercent: cfg.get<number>('autoSwitch.quotaThresholdPercent', 10),
      autoSwitchStrategy: cfg.get<string>('autoSwitch.strategy', 'highest_quota'),
      cooldownMinutes: cfg.get<number>('autoSwitch.cooldownMinutes', 5),
      growthTasksAutoAfterCheckin: cfg.get<boolean>('growthTasks.autoAfterCheckin', true),
      updateAutoCheck: cfg.get<boolean>('update.autoCheck', true),
      updateAutoInstall: cfg.get<boolean>('update.autoInstall', false)
    };

    this._view.webview.postMessage({
      command: 'updateState',
      data: {
        accounts: accounts.map((acc) => {
          const actRemain = typeof acc.totalCredits === 'number' ? acc.totalCredits : 0;
          const basePkg: QuotaPackageItem = acc.basePackage || {
            title: '基础体验包',
            count: 1,
            remain: 0,
            total: 500,
            percent: 0
          };

          const actPkg: QuotaPackageItem = acc.activityPackage || {
            title: '活动赠送包',
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
            basePackage: basePkg,
            activityPackage: actPkg,
            checkinStreak: acc.checkinStreak ?? 0,
            todayCheckedIn: Boolean(acc.todayCheckedIn),
            rateLimitUntil: acc.rateLimitUntil,
            lastUsed: acc.lastUsed
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
        lockedUids
      }
    });
  }

  /**
   * 1. 切换账号
   */
  public async handleSwitchAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      this.sendNotify('error', '目标账号不存在或已被移除');
      return;
    }

    this.setOperating(true, `正在热切至账号 ${target.nickname || target.email}...`);

    try {
      const res = await this.switcher.switchAccount(target, this.store);
      if (res.success && res.receipt?.verified) {
        this.sendNotify('success',
          `BuddyRelay: 已平滑切换至账号 ${target.nickname || target.email} (宿主回执确认)`
        );
      } else if (res.success) {
        this.sendNotify('error',
          `BuddyRelay: 已切换至 ${target.nickname || target.email}，${res.message}`
        );
      } else {
        this.sendNotify('error', `切号异常: ${res.message}`);
      }
    } catch (err: any) {
      this.sendNotify('error', `切号失败: ${err.message}`);
    } finally {
      this.setOperating(false);
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

    this.setOperating(true, `正在为 ${target.nickname || target.email} 签到...`);
    try {
      const res = await this.checkinService.checkinAccount(target, this.store);
      if (res.success) {
        this.sendNotify('success', 
          `[${target.nickname || target.email}] ${res.message}`
        );
      } else {
        this.sendNotify('error', 
          `[${target.nickname || target.email}] 签到失败: ${res.error || res.message}`
        );
      }
    } catch (err: any) {
      this.sendNotify('error', `签到异常: ${err.message}`);
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
      this.sendNotify('success', '号池为空，暂无需要签到的账号');
      return;
    }

    this.setOperating(true, `正在执行一键全员签到 (共 ${accounts.length} 个账号)...`);
    try {
      const report = await this.checkinService.batchCheckin(accounts, this.store);
      this.sendNotify('success', 
        `BuddyRelay: 签到完成！新领积分: ${report.totalCreditsAwarded}点 | 成功: ${report.successCount} | 今日已签: ${report.alreadyCheckedInCount} | 失败: ${report.failedCount}`
      );
    } catch (err: any) {
      this.sendNotify('error', `批量签到异常: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 4. 从 Cockpit 导入账号
   */
  public async handleImportCockpit(): Promise<void> {
    this.setOperating(true, '正在扫描并解密 Cockpit Tools 账号池...');
    try {
      const res = await this.importer.importToStore(this.store);
      if (res.success) {
        this.sendNotify('success', 
          `BuddyRelay: 成功从 Cockpit 导入 ${res.decryptedCount} 个可用账号`
        );
        this.checkinService.batchSyncStatus(this.store.getAll(), this.store).catch(() => {});
      } else {
        this.sendNotify('error', `从 Cockpit 导入完成: 导入 ${res.decryptedCount}/${res.totalFound} 个账号`);
      }
    } catch (err: any) {
      this.sendNotify('error', `导入 Cockpit 异常: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 5. 官方 OAuth 登录添加账号
   */
  public async handleAddAccountOAuth(): Promise<void> {
    this.setOperating(true, '正在请求 CodeBuddy 官方登录授权...');
    try {
      const account = await this.oauthService.loginAndSave(this.store, {
        onAuthUrl: (url) => {
          // 唤起系统默认浏览器打开官方授权页
          vscode.env.openExternal(vscode.Uri.parse(url));
          this.setOperating(true, '已打开授权页，请在浏览器中扫码或确认登录...');
        }
      });
      this.sendNotify('success', 
        `BuddyRelay: 账号 [${account.nickname || account.email}] 授权成功并加入号池！`
      );
      this.checkinService.syncAccountStatus(account, this.store).catch(() => {});
    } catch (err: any) {
      this.sendNotify('error', `OAuth 授权登录失败: ${err.message}`);
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
      const confirm = await vscode.window.showWarningMessage(
        `确定要从号池中移除账号 [${target.nickname || target.email}] 吗？`,
        { modal: true },
        '确定移除'
      );
      if (confirm !== '确定移除') {
        return;
      }
    }

    await this.store.delete(accountId);
    this.sendNotify('success', `已移除账号 [${target.nickname || target.email}]`);
  }

  /**
   * 7. 刷新状态与额度
   */
  public async handleRefreshStatus(): Promise<void> {
    this.setOperating(true, '正在刷新号池状态与实时配额...');
    try {
      await this.checkinService.batchSyncStatus(this.store.getAll(), this.store);
      this.sendNotify('success', 'BuddyRelay: 全量账号额度与签到状态刷新完毕');
    } catch (err: any) {
      this.sendNotify('error', `刷新状态失败: ${err.message}`);
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
      this.sendNotify('error', '号池为空，无法读取成长任务');
      return;
    }
    const name = target.nickname || target.email;
    this.setOperating(true, `正在读取 [${name}] 的成长任务与资产...`);
    try {
      const [tasks, assetSummary] = await Promise.all([
        this.growthTasks.listTasks(target),
        this.growthTasks.getGrowthAssetSummary(target)
      ]);
      this.pushTasksToWebview(tasks, target.id, name, assetSummary);
    } catch (err: any) {
      this.sendNotify('error', `读取任务失败: ${err.message}`);
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

    if (targets.length === 0) {
      this.sendNotify('error', '没有可执行的账号');
      return;
    }

    this.setOperating(true, `正在批量执行成长任务（共 ${targets.length} 个账号）...`);
    let totalClaimed = 0;
    let totalCredits = 0;
    let totalEnergy = 0;
    let totalAccepted = 0;
    let totalSkipped = 0;
    let totalFailures = 0;
    let processedAccounts = 0;
    let wasStopped = false;
    const details: Array<{ accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string }> = [];

    this.sendTaskProgress(`开始批量执行，共 ${targets.length} 个账号...`, 'doing', 0, 0, targets.length);

    try {
      for (let i = 0; i < targets.length; i++) {
        if (this._abortTaskBatch) {
          wasStopped = true;
          this.sendTaskProgress('用户已中止后续批处理', 'fail', Math.round((i / targets.length) * 100), i, targets.length);
          details.push({
            accountName: targets[i].nickname || targets[i].email,
            status: 'stopped',
            message: '用户主动中止'
          });
          break;
        }

        const acc = targets[i];
        const name = acc.nickname || acc.email;
        const currentPct = Math.round((i / targets.length) * 100);
        this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: 执行中...`, 'doing', currentPct, i + 1, targets.length);

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
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: 账号受限，已跳过`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: '账号受限 (11140)' });
            continue;
          }

          const parts: string[] = [];
          if (report.buddyAdopted) {
            parts.push('领养Buddy(+300分)');
          }
          if (report.accepted > 0) {
            parts.push(`新报${report.accepted}项`);
          }
          if (report.claimed > 0) {
            parts.push(`领取${report.claimed}项(+${report.claimedCredits}分)`);
          }
          if (report.travelClaimed) {
            parts.push('领旅行礼物');
          }
          if (report.travelDeparted) {
            parts.push(`派去${report.travelLocation || '旅行打工'}`);
          }
          if (report.streakRedeemedCredits > 0) {
            parts.push(`连登兑换(+${report.streakRedeemedCredits}分)`);
          }
          if (report.madeUpDays > 0) {
            parts.push(`补登${report.madeUpDays}天`);
          }
          if (report.buddyBoxesOpened > 0) {
            parts.push(`开出「${report.newBuddyName || '新Buddy'}」`);
          }
          if (report.lotteryDraws > 0) {
            parts.push(`抽奖${report.lotteryDraws}次`);
          }

          if (parts.length > 0) {
            const detailMsg = parts.join('，');
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${detailMsg}`, 'ok', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'ok', message: detailMsg });
          } else if (report.failures.length > 0) {
            const failMsg = `执行异常: ${report.failures.join('; ')}`;
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${failMsg}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: failMsg });
          } else {
            const infoMsg = `无可领奖任务（${report.inProgressTasks}项进行中需在客户端操作达成，${report.skipped.length}项限微信扫码）`;
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${infoMsg}`, 'doing', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'skipped', message: infoMsg });
          }
        } catch (err: any) {
          processedAccounts++;
          totalFailures++;
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: 失败 (${err.message})`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
          details.push({ accountName: name, status: 'fail', message: err.message });
        }

        // 账号间拟人化随机间隔（最后一个不等；支持随时被中止打断）
        if (i < targets.length - 1 && !this._abortTaskBatch) {
          await this.cancellableSleep(Math.round((3 + Math.random() * 5) * 1000));
        }
      }

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      this.sendTaskProgress(
        wasStopped ? '批处理已中止' : '所有账号执行完毕！',
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
        `批量任务完成：共处理 ${processedAccounts}/${targets.length} 个账号，新领 ${totalClaimed} 项 (+${totalCredits}分)`
      );

      // 刷新展示的目标账号任务列表（所见即所操作）
      const primaryTarget = targets[0] || this.store.getActive();
      if (primaryTarget) {
        const tasks = await this.growthTasks.listTasks(primaryTarget);
        this.pushTasksToWebview(tasks, primaryTarget.id, primaryTarget.nickname || primaryTarget.email);
      }
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 领取单个任务奖励（支持指定目标账号）
   */
  public async handleTaskClaim(taskCode: string, accountId?: string): Promise<void> {
    const target = accountId ? this.store.get(accountId) : this.store.getActive();
    if (!target) {
      this.sendNotify('error', '未找到目标账号，无法领取奖励');
      return;
    }
    const name = target.nickname || target.email;
    try {
      const r = await this.growthTasks.claimTask(target, taskCode);
      if (r.ok && !r.already) {
        this.sendNotify('success', `[${name}] 领取成功 +${r.credit}分+${r.energy}能`);
      } else if (r.already) {
        this.sendNotify('error', `[${name}] 该任务奖励此前已领取`);
      } else {
        this.sendNotify('error', `[${name}] 领取失败（任务进度未达标）`);
      }
      const tasks = await this.growthTasks.listTasks(target);
      this.pushTasksToWebview(tasks, target.id, name);
    } catch (err: any) {
      this.sendNotify('error', `领取失败: ${err.message}`);
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

    if (targets.length === 0) {
      this.sendNotify('error', '没有可执行的账号');
      return;
    }

    this.setOperating(true, `正在批量报名任务（共 ${targets.length} 个账号）...`);
    let totalAccepted = 0;
    let totalFailures = 0;
    let processedAccounts = 0;
    let wasStopped = false;
    const details: Array<{ accountName: string; status: 'ok' | 'fail' | 'skipped' | 'stopped'; message: string }> = [];

    this.sendTaskProgress(`开始批量报名，共 ${targets.length} 个账号...`, 'doing', 0, 0, targets.length);

    try {
      for (let i = 0; i < targets.length; i++) {
        if (this._abortTaskBatch) {
          wasStopped = true;
          this.sendTaskProgress('用户已中止批量报名', 'fail', Math.round((i / targets.length) * 100), i, targets.length);
          details.push({
            accountName: targets[i].nickname || targets[i].email,
            status: 'stopped',
            message: '用户主动中止'
          });
          break;
        }

        const acc = targets[i];
        const name = acc.nickname || acc.email;
        const currentPct = Math.round((i / targets.length) * 100);
        this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: 报名中...`, 'doing', currentPct, i + 1, targets.length);

        try {
          const tasks = await this.growthTasks.listTasks(acc);
          const res = await this.growthTasks.acceptAll(acc, tasks);
          processedAccounts++;
          totalAccepted += res.accepted;
          totalFailures += res.failed;

          if (res.failed > 0) {
            const failMsg = res.accepted > 0
              ? `报名 ${res.accepted} 项，失败 ${res.failed} 项 (${res.failures.join('; ')})`
              : `报名失败: ${res.failures.join('; ')}`;
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${failMsg}`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'fail', message: failMsg });
          } else {
            const okMsg = res.accepted > 0
              ? `已报名 ${res.accepted} 项任务`
              : (res.alreadyAccepted > 0 ? '无可报名任务（均已报名）' : '当前无可报名任务');
            this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: ${okMsg}`, res.accepted > 0 ? 'ok' : 'doing', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
            details.push({ accountName: name, status: 'ok', message: okMsg });
          }
        } catch (err: any) {
          processedAccounts++;
          totalFailures++;
          this.sendTaskProgress(`[${i + 1}/${targets.length}] ${name}: 报名异常 (${err.message})`, 'fail', Math.round(((i + 1) / targets.length) * 100), i + 1, targets.length);
          details.push({ accountName: name, status: 'fail', message: err.message });
        }

        if (i < targets.length - 1 && !this._abortTaskBatch) {
          await this.cancellableSleep(Math.round((3 + Math.random() * 5) * 1000));
        }
      }

      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      this.sendTaskProgress(
        wasStopped ? '批量报名已中止' : '所有账号报名处理完毕！',
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
        `批量报名完成：共报名 ${totalAccepted} 项任务${totalFailures > 0 ? `，失败 ${totalFailures} 项` : ''}`
      );

      // 刷新展示的目标账号任务列表
      const primaryTarget = targets[0] || this.store.getActive();
      if (primaryTarget) {
        const fresh = await this.growthTasks.listTasks(primaryTarget);
        this.pushTasksToWebview(fresh, primaryTarget.id, primaryTarget.nickname || primaryTarget.email);
      }
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
   */
  public sendNotify(level: 'success' | 'error' | 'warn', message: string): void {
    if (!this._view) {
      return;
    }
    this._view.webview.postMessage({ command: 'notify', level, message });
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
   */
  public async handleImportLocal(): Promise<void> {
    this.setOperating(true, '正在读取本机已登录会话...');
    try {
      const session = await vscode.authentication.getSession('CodeBuddy-auth', [], {
        createIfNone: false
      });

      if (!session || !session.accessToken) {
        this.sendNotify('error', '未检测到本机登录会话，请先用 OAuth 授权登录');
        return;
      }

      const uid = session.account.id;
      const nickname = session.account.label || uid;

      if (this.store.get(uid)) {
        this.sendNotify('error', '该账号已在号池中，无需重复导入');
        return;
      }

      const now = Date.now();
      const account: CodeBuddyAccount = {
        id: `local_${String(uid).replace(/-/g, '')}`,
        uid: String(uid),
        email: nickname,
        nickname,
        accessToken: session.accessToken,
        refreshToken: '',
        tokenType: 'Bearer',
        expiresAt: 0,
        domain: 'www.codebuddy.cn',
        paymentType: 'free',
        status: 'idle',
        createdAt: now,
        lastUsed: now,
        notes: '从本机已登录会话导入（无 refreshToken）'
      };

      await this.store.upsert(account);
      this.checkinService.syncAccountStatus(account, this.store).catch(() => {});
      this.sendNotify('success', `已导入本机登录账号 [${nickname}]`);
    } catch (err: any) {
      this.sendNotify('error', `本地导入失败：${err.message}`);
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
      this.sendNotify('success', `账号 [${acc.nickname || acc.email}] 已${isDis ? '禁用' : '启用'}`);
      this.postStateToWebview();
    }
  }

  /**
   * 从文件选择导入账号 (.json)
   */
  public async handleImportAccountsFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'JSON 账号文件 (*.json)': ['json'], '所有文件 (*.*)': ['*'] },
      openLabel: '导入账号数据'
    });
    if (uris && uris[0]) {
      this.setOperating(true, '正在读取账号文件...');
      try {
        const text = await fs.promises.readFile(uris[0].fsPath, 'utf8');
        await this.handleImportJson(text);
      } catch (err: any) {
        this.sendNotify('error', `读取文件失败: ${err.message}`);
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
      if ('autoSwitchEnabled' in settings) await cfg.update('autoSwitch.enabled', Boolean(settings.autoSwitchEnabled), vscode.ConfigurationTarget.Global);
      if ('quotaThresholdPercent' in settings) await cfg.update('autoSwitch.quotaThresholdPercent', Number(settings.quotaThresholdPercent || 10), vscode.ConfigurationTarget.Global);
      if ('autoSwitchStrategy' in settings) await cfg.update('autoSwitch.strategy', String(settings.autoSwitchStrategy || 'highest_quota'), vscode.ConfigurationTarget.Global);
      if ('cooldownMinutes' in settings) await cfg.update('autoSwitch.cooldownMinutes', Number(settings.cooldownMinutes || 5), vscode.ConfigurationTarget.Global);
      if ('growthTasksAutoAfterCheckin' in settings) await cfg.update('growthTasks.autoAfterCheckin', Boolean(settings.growthTasksAutoAfterCheckin), vscode.ConfigurationTarget.Global);
      if ('updateAutoCheck' in settings) await cfg.update('update.autoCheck', Boolean(settings.updateAutoCheck), vscode.ConfigurationTarget.Global);
      if ('updateAutoInstall' in settings) await cfg.update('update.autoInstall', Boolean(settings.updateAutoInstall), vscode.ConfigurationTarget.Global);
      this.sendNotify('success', 'BuddyRelay: 规则设置已更新并实时生效');
      this.postStateToWebview();
    } catch (e: any) {
      this.sendNotify('error', `保存设置失败: ${e.message}`);
    }
  }

  /**
   * 智能匹配批量导入：JSON / JWT Token智能提取 / 分隔符多行 / 已有号覆盖更新
   */
  public async handleImportJson(text: string): Promise<void> {
    const raw = text.trim();
    if (!raw) {
      this.sendNotify('error', '导入失败：内容为空');
      return;
    }

    this.setOperating(true, '正在智能匹配解析账号数据...');

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
        this.sendNotify('error', '导入失败：未识别出有效的账号或 Token 数据');
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
        if (freshCount > 0) parts.push(`新增 ${freshCount} 个`);
        if (updatedCount > 0) parts.push(`更新 ${updatedCount} 个 (Token已覆盖更新)`);
        if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个无效数据`);
        this.sendNotify('success', `智能导入完成：${parts.join('，')}`);
      } else {
        this.sendNotify('error', `导入失败：跳过 ${skippedCount} 项无效数据（缺少有效 Token）`);
      }
    } catch (err: any) {
      this.sendNotify('error', `智能导入失败：${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 核心 Webview HTML 结构模板
   * 1:1 深度复刻 Kite 经典卡片 (.grid-card) 质感 + Cockpit 配额进度条 + 隐私脱敏
   */
      private getHtmlForWebview(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'main.css')
    );
    const htmlPath = path.join(this.extensionUri.fsPath, 'resources', 'webview', 'sidebar.html');
    if (fs.existsSync(htmlPath)) {
      let content = fs.readFileSync(htmlPath, 'utf8');
      content = content.replace('{{CSS_URI}}', `${cssUri.toString()}?v=${Date.now()}`);
      return content;
    }
    return `<!DOCTYPE html><html><body><h3>未找到侧栏资源: ${htmlPath}</h3></body></html>`;
  }
}
