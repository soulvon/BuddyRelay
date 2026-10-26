import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { SeamlessSwitcher } from './seamlessSwitcher';
import { CheckinService } from './checkinService';
import { CockpitImporter } from './cockpitImporter';
import { OAuthService } from './oauthService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'buddy-relay.sidebarView';

  private _view?: vscode.WebviewView;
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private checkinService: CheckinService;
  private importer: CockpitImporter;
  private oauthService: OAuthService;
  private extensionUri: vscode.Uri;
  private isOperating: boolean = false;
  private currentOperationMessage: string = '';

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
          await this.handleDeleteAccount(message.accountId);
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

    this._view.webview.postMessage({
      command: 'updateState',
      data: {
        accounts: accounts.map((acc) => ({
          id: acc.id,
          uid: acc.uid,
          email: acc.email,
          nickname: acc.nickname || acc.email,
          paymentType: acc.paymentType || 'free',
          status: acc.status,
          isActive: active ? active.id === acc.id : false,
          totalCredits: acc.totalCredits ?? 0,
          checkinStreak: acc.checkinStreak ?? 0,
          todayCheckedIn: Boolean(acc.todayCheckedIn),
          rateLimitUntil: acc.rateLimitUntil,
          lastUsed: acc.lastUsed
        })),
        activeId: active?.id || null,
        stats: {
          total: accounts.length,
          activeCount: accounts.filter((a) => a.status === 'active').length,
          idleCount: accounts.filter((a) => a.status === 'idle').length,
          rateLimitedCount: accounts.filter((a) => a.status === 'rate_limited')
            .length,
          checkedTodayCount,
          totalCredits
        },
        isOperating: this.isOperating,
        operationMessage: this.currentOperationMessage
      }
    });
  }

  /**
   * 1. 切换账号
   */
  public async handleSwitchAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      vscode.window.showErrorMessage('目标账号不存在或已被移除');
      return;
    }

    this.setOperating(true, `正在热切至账号 ${target.nickname || target.email}...`);
    try {
      const res = await this.switcher.switchAccount(target, this.store);
      if (res.success) {
        vscode.window.showInformationMessage(
          `BuddyRelay: 已平滑切换至账号 ${target.nickname || target.email}`
        );
      } else {
        vscode.window.showErrorMessage(`BuddyRelay: 热切失败 - ${res.message}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`BuddyRelay: 切号异常: ${err.message}`);
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
      vscode.window.showErrorMessage('目标账号不存在');
      return;
    }

    this.setOperating(true, `正在为 ${target.nickname || target.email} 签到...`);
    try {
      const res = await this.checkinService.checkinAccount(target, this.store);
      if (res.success) {
        vscode.window.showInformationMessage(
          `BuddyRelay: ${target.nickname} - ${res.message}`
        );
      } else {
        vscode.window.showWarningMessage(
          `BuddyRelay: ${target.nickname} 签到异常: ${res.message}`
        );
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`BuddyRelay: 签到错误: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 3. 删除账号
   */
  public async handleDeleteAccount(accountId: string): Promise<void> {
    const target = this.store.get(accountId);
    if (!target) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定要从号池中移除账号 "${target.nickname || target.email}" 吗？`,
      { modal: true },
      '确认移除',
      '取消'
    );

    if (confirm === '确认移除') {
      await this.store.delete(accountId);
      vscode.window.showInformationMessage(
        `BuddyRelay: 已成功从号池中移除账号 ${target.nickname || target.email}`
      );
    }
  }

  /**
   * 4. 添加账号 (OAuth 授权登录)
   */
  public async handleAddAccountOAuth(): Promise<void> {
    this.setOperating(true, '正在初始化官方授权凭据...');
    try {
      const authState = await this.oauthService.createAuthState('ide');
      const uri = vscode.Uri.parse(authState.authUrl);

      // 唤起系统浏览器
      await vscode.env.openExternal(uri);

      this.setOperating(true, '已打开浏览器，等待您完成扫码或授权确认...');

      vscode.window.showInformationMessage(
        'BuddyRelay: 已在浏览器中打开官方授权页，请在网页中确认登录。',
        '再次打开授权页'
      ).then(action => {
        if (action === '再次打开授权页') {
          vscode.env.openExternal(uri);
        }
      });

      // 轮询等待登录结果
      const tokenData = await this.oauthService.pollToken(authState.state, {
        timeoutMs: 120000
      });

      this.setOperating(true, '已收到授权凭证，正在同步个人资料与加油站信息...');
      const profile = await this.oauthService.fetchAccountProfile(
        authState.state,
        tokenData.accessToken
      );

      const now = Date.now();
      const account: CodeBuddyAccount = {
        id: `codebuddy_cn_${profile.uid.replace(/-/g, '')}`,
        uid: profile.uid,
        email: profile.email || profile.phoneNumber || profile.nickname,
        nickname: profile.nickname,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        tokenType: tokenData.tokenType || 'Bearer',
        expiresAt: now + (tokenData.expiresIn || 7200) * 1000,
        domain: tokenData.domain || 'www.codebuddy.cn',
        paymentType: 'free',
        authRaw: tokenData,
        profileRaw: profile,
        status: 'idle',
        createdAt: now,
        lastUsed: now
      };

      await this.store.upsert(account);

      // 同步一次加油站状态与积分
      try {
        await this.checkinService.syncAccountStatus(account, this.store);
      } catch (_) {}

      vscode.window.showInformationMessage(
        `BuddyRelay: 账号 "${account.nickname}" 添加成功！`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`BuddyRelay: OAuth 登录失败: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 5. 从 Cockpit Tools 导入账号
   */
  public async handleImportCockpit(): Promise<void> {
    this.setOperating(true, '正在探测并解密 Cockpit Tools 账号池...');
    try {
      const check = this.importer.verifyCockpitStorage();
      if (!check.hasKey) {
        vscode.window.showErrorMessage(
          `未检测到 Cockpit 密钥文件 (${this.importer['keyFilePath']})`
        );
        return;
      }

      const res = await this.importer.importToStore(this.store);
      if (res.success) {
        // 同步积分状态
        const accounts = this.store.getAll();
        this.setOperating(true, `已导入 ${res.decryptedCount} 个账号，正在更新加油站额度...`);
        await this.checkinService.batchSyncStatus(accounts, this.store);

        vscode.window.showInformationMessage(
          `BuddyRelay: 成功导入 ${res.decryptedCount} 个 Cockpit 账号，额度已同步！`
        );
      } else {
        vscode.window.showErrorMessage(
          `Cockpit 导入失败: ${res.errors.map((e) => e.error).join('; ')}`
        );
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Cockpit 导入异常: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 6. 一键全员签到
   */
  public async handleBatchCheckin(): Promise<void> {
    const accounts = this.store.getAll();
    if (accounts.length === 0) {
      vscode.window.showWarningMessage('号池中暂无可用账号，请先添加或导入账号');
      return;
    }

    this.setOperating(true, `正在为 ${accounts.length} 个账号批量签到...`);
    try {
      const report = await this.checkinService.batchCheckin(accounts, this.store);
      vscode.window.showInformationMessage(
        `BuddyRelay: 签到完成！新领积分: ${report.totalCreditsAwarded}点 | 成功: ${report.successCount} | 今日已签: ${report.alreadyCheckedInCount} | 失败: ${report.failedCount}`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`批量签到异常: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  /**
   * 7. 刷新状态与配额
   */
  public async handleRefreshStatus(): Promise<void> {
    this.setOperating(true, '正在刷新号池与云端配额...');
    try {
      this.store.load();
      const accounts = this.store.getAll();
      await this.checkinService.batchSyncStatus(accounts, this.store);
      vscode.window.showInformationMessage('BuddyRelay: 账号状态与额度积分已全面刷新');
    } catch (err: any) {
      vscode.window.showErrorMessage(`刷新状态失败: ${err.message}`);
    } finally {
      this.setOperating(false);
    }
  }

  private setOperating(operating: boolean, message: string = ''): void {
    this.isOperating = operating;
    this.currentOperationMessage = message;
    this.postStateToWebview();
  }

  /**
   * 渲染 Webview HTML
   * 严格遵循 6 项交互铁律：
   * 1. 禁廉价蓝紫渐变：全盘采用 VS Code 原生语义色彩与中性高质感暗黑调
   * 2. 禁雷达波纹：无波纹扫描、无光晕呼吸，微交互在 0.12s 内利落完成
   * 3. 自然中文：标准工程师操盘手界面用语，无机器翻译腔
   * 4. 骨架屏与明确加载反馈：加载状态卡片占位防塌、操作禁用防护
   * 5. 合理圆角：4px 规范圆角，贴合 VS Code 原生视觉基调
   * 6. 严禁卡片套娃：单层扁平卡片流，统一高度防塌陷
   */
  private getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BuddyRelay 会话与账号中枢</title>
  <style>
    :root {
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --bg-color: var(--vscode-sideBar-background, #181818);
      --card-bg: var(--vscode-editor-background, #1f1f1f);
      --card-hover: var(--vscode-list-hoverBackground, #2a2a2a);
      --card-active-bg: var(--vscode-list-activeSelectionBackground, #222d36);
      --border-color: var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
      --text-main: var(--vscode-foreground, #cccccc);
      --text-muted: var(--vscode-descriptionForeground, #888888);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-sec-bg: var(--vscode-button-secondaryBackground, #313131);
      --btn-sec-hover: var(--vscode-button-secondaryHoverBackground, #3d3d3d);
      --btn-sec-fg: var(--vscode-button-secondaryForeground, #cccccc);
      --danger-color: var(--vscode-errorForeground, #e06c75);
      --success-color: var(--vscode-testing-iconPassed, #4ec9b0);
      --warning-color: var(--vscode-editorWarning-foreground, #cca700);
      --badge-bg: rgba(255, 255, 255, 0.06);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: var(--font-family);
      font-size: 12px;
      line-height: 1.4;
      padding: 10px;
      user-select: none;
      overflow-x: hidden;
    }

    /* 顶部动作栏 (Kite 风格扁平工具栏) */
    .top-action-bar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 10px;
    }

    .action-row {
      display: flex;
      gap: 6px;
    }

    button {
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 5px 8px;
      transition: background 0.12s ease, border-color 0.12s ease;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
      flex: 1;
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--btn-hover);
    }

    .btn-secondary {
      background: var(--btn-sec-bg);
      color: var(--btn-sec-fg);
      border-color: var(--border-color);
      flex: 1;
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--btn-sec-hover);
      color: var(--text-main);
    }

    .btn-icon-only {
      padding: 5px 7px;
      flex: 0 0 auto;
    }

    .btn-danger-ghost {
      background: transparent;
      color: var(--danger-color);
      border-color: rgba(224, 108, 117, 0.3);
      padding: 3px 6px;
      font-size: 10px;
    }

    .btn-danger-ghost:hover:not(:disabled) {
      background: rgba(224, 108, 117, 0.12);
      border-color: var(--danger-color);
    }

    /* 状态与统计摘要栏 */
    .summary-banner {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 6px 8px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
    }

    .summary-item {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--text-muted);
    }

    .summary-item strong {
      color: var(--text-main);
      font-weight: 600;
    }

    /* 加载操作反馈浮条 */
    .operation-status-bar {
      display: none;
      background: var(--card-hover);
      border-left: 3px solid var(--btn-bg);
      padding: 5px 8px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 10px;
      font-size: 11px;
      color: var(--text-main);
      align-items: center;
      gap: 6px;
    }

    .operation-status-bar.visible {
      display: flex;
    }

    .spinner {
      width: 10px;
      height: 10px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: var(--btn-bg);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* 账号卡片流 (单层扁平结构，严禁多重套娃) */
    .card-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .account-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 10px 12px;
      min-height: 112px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: background 0.12s ease, border-color 0.12s ease;
      position: relative;
    }

    .account-card:hover {
      background: var(--card-hover);
      border-color: rgba(255, 255, 255, 0.16);
    }

    .account-card.is-active {
      border-color: var(--success-color);
      background: var(--card-active-bg);
    }

    .account-card.is-active::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--success-color);
      border-radius: 4px 0 0 4px;
    }

    /* 卡片顶行：昵称与状态 */
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }

    .account-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
    }

    .status-indicator {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #777777;
      flex-shrink: 0;
    }

    .status-indicator.active {
      background: var(--success-color);
    }

    .status-indicator.rate-limited {
      background: var(--warning-color);
    }

    .account-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-main);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      display: inline-block;
      font-size: 10px;
      padding: 2px 5px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--text-muted);
      border: 1px solid var(--border-color);
      white-space: nowrap;
    }

    .badge.badge-success {
      color: var(--success-color);
      border-color: rgba(78, 201, 176, 0.3);
      background: rgba(78, 201, 176, 0.08);
    }

    .badge.badge-warning {
      color: var(--warning-color);
      border-color: rgba(204, 167, 0, 0.3);
      background: rgba(204, 167, 0, 0.08);
    }

    .badge.badge-active {
      color: #ffffff;
      background: var(--btn-bg);
      border-color: var(--btn-bg);
    }

    /* 卡片中行：积分、连续天数、标识 */
    .card-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
    }

    .metric-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
    }

    .credit-count {
      color: var(--text-main);
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .credit-count .unit {
      font-size: 10px;
      font-weight: normal;
      color: var(--text-muted);
    }

    .streak-text {
      color: var(--text-muted);
      font-size: 11px;
    }

    .uid-caption {
      font-size: 10px;
      color: var(--text-muted);
      font-family: monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 卡片底行：操作按钮栏 */
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }

    .footer-left-buttons {
      display: flex;
      gap: 5px;
      flex: 1;
    }

    .btn-card-action {
      padding: 3px 8px;
      font-size: 10px;
      font-weight: 500;
    }

    /* 骨架屏占位卡片 (平滑防塌) */
    .skeleton-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 12px;
      min-height: 112px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .skeleton-bar {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 3px;
    }

    .empty-state {
      text-align: center;
      padding: 30px 10px;
      color: var(--text-muted);
    }

    .empty-state p {
      margin-bottom: 12px;
      font-size: 12px;
    }
  </style>
</head>
<body>

  <!-- 顶部动作栏 -->
  <div class="top-action-bar">
    <div class="action-row">
      <button class="btn-primary" id="btnAddOAuth" title="发起官方扫码或网页登录">
        <span>+</span> 添加账号 (OAuth)
      </button>
      <button class="btn-secondary" id="btnImportCockpit" title="从本地安全凭据库解密导入">
        从 Cockpit 导入
      </button>
    </div>
    <div class="action-row">
      <button class="btn-secondary" id="btnBatchCheckin" title="为全员领取今日算力">
        ✓ 一键全员签到
      </button>
      <button class="btn-secondary btn-icon-only" id="btnRefresh" title="刷新状态与配额">
        ↻
      </button>
    </div>
  </div>

  <!-- 操作进度提示浮条 -->
  <div class="operation-status-bar" id="operationBar">
    <div class="spinner"></div>
    <span id="operationMessage">正在处理中...</span>
  </div>

  <!-- 汇总数据摘要 -->
  <div class="summary-banner" id="summaryBanner">
    <div class="summary-item">
      <span>账号:</span>
      <strong id="statTotal">0</strong>
    </div>
    <div class="summary-item">
      <span>已签:</span>
      <strong id="statChecked">0/0</strong>
    </div>
    <div class="summary-item">
      <span>总算力:</span>
      <strong id="statCredits">0</strong>
    </div>
  </div>

  <!-- 账号卡片流容器 -->
  <div class="card-list" id="cardList">
    <!-- 默认初次加载展示 2 个静态骨架屏防塌 -->
    <div class="skeleton-card">
      <div style="display:flex; justify-content:space-between;">
        <div class="skeleton-bar" style="width: 80px; height: 14px;"></div>
        <div class="skeleton-bar" style="width: 50px; height: 14px;"></div>
      </div>
      <div class="skeleton-bar" style="width: 140px; height: 12px;"></div>
      <div style="display:flex; gap:6px;">
        <div class="skeleton-bar" style="width: 50px; height: 20px;"></div>
        <div class="skeleton-bar" style="width: 50px; height: 20px;"></div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // DOM 元素引用
    const btnAddOAuth = document.getElementById('btnAddOAuth');
    const btnImportCockpit = document.getElementById('btnImportCockpit');
    const btnBatchCheckin = document.getElementById('btnBatchCheckin');
    const btnRefresh = document.getElementById('btnRefresh');
    const operationBar = document.getElementById('operationBar');
    const operationMessage = document.getElementById('operationMessage');
    const cardList = document.getElementById('cardList');
    const statTotal = document.getElementById('statTotal');
    const statChecked = document.getElementById('statChecked');
    const statCredits = document.getElementById('statCredits');

    // 事件绑定
    btnAddOAuth.addEventListener('click', () => {
      vscode.postMessage({ command: 'addAccountOAuth' });
    });

    btnImportCockpit.addEventListener('click', () => {
      vscode.postMessage({ command: 'importCockpit' });
    });

    btnBatchCheckin.addEventListener('click', () => {
      vscode.postMessage({ command: 'batchCheckin' });
    });

    btnRefresh.addEventListener('click', () => {
      vscode.postMessage({ command: 'refreshStatus' });
    });

    // 接收宿主发来的状态更新
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'updateState') {
        renderState(msg.data);
      }
    });

    function renderState(data) {
      const { accounts, activeId, stats, isOperating, operationMessage: opMsg } = data;

      // 更新操作状态条
      if (isOperating) {
        operationBar.classList.add('visible');
        operationMessage.textContent = opMsg || '正在处理中...';
        setActionsDisabled(true);
      } else {
        operationBar.classList.remove('visible');
        setActionsDisabled(false);
      }

      // 更新摘要
      if (stats) {
        statTotal.textContent = stats.total;
        statChecked.textContent = stats.checkedTodayCount + '/' + stats.total;
        statCredits.textContent = (stats.totalCredits || 0).toLocaleString();
      }

      // 渲染账号卡片
      if (!accounts || accounts.length === 0) {
        cardList.innerHTML = \`
          <div class="empty-state">
            <p>暂无账号数据</p>
            <button class="btn-primary" onclick="vscode.postMessage({ command: 'importCockpit' })">
              从 Cockpit 导入账号
            </button>
          </div>
        \`;
        return;
      }

      cardList.innerHTML = accounts.map(acc => {
        const isActive = acc.isActive;
        const isRateLimited = acc.status === 'rate_limited';
        const indicatorClass = isActive ? 'active' : (isRateLimited ? 'rate-limited' : '');
        
        let statusBadge = '';
        if (isActive) {
          statusBadge = '<span class="badge badge-active">当前激活</span>';
        } else if (isRateLimited) {
          statusBadge = '<span class="badge badge-warning">429冷却</span>';
        } else {
          statusBadge = '<span class="badge">就绪待命</span>';
        }

        const checkinBadge = acc.todayCheckedIn
          ? '<span class="badge badge-success">今日已签</span>'
          : '<span class="badge badge-warning">今日未签</span>';

        const credits = (acc.totalCredits || 0).toLocaleString();
        const streak = acc.checkinStreak || 0;
        const uidSnippet = acc.uid ? (acc.uid.slice(0, 8) + '...' + acc.uid.slice(-4)) : 'N/A';

        // 切换按钮状态
        const switchBtn = isActive
          ? '<button class="btn-secondary btn-card-action" disabled>✓ 激活中</button>'
          : \`<button class="btn-primary btn-card-action" onclick="onSwitch('\${acc.id}')">切换</button>\`;

        // 签到按钮状态
        const checkinBtnText = acc.todayCheckedIn ? '已签到' : '签到';
        const checkinBtnClass = acc.todayCheckedIn ? 'btn-secondary' : 'btn-secondary';
        const checkinBtn = \`<button class="\${checkinBtnClass} btn-card-action" onclick="onCheckin('\${acc.id}')">\${checkinBtnText}</button>\`;

        // 删除按钮
        const deleteBtn = \`<button class="btn-danger-ghost" onclick="onDelete('\${acc.id}')" title="从号池移除">删除</button>\`;

        return \`
          <div class="account-card \${isActive ? 'is-active' : ''}">
            <div class="card-header">
              <div class="account-title-group">
                <span class="status-indicator \${indicatorClass}"></span>
                <span class="account-name" title="\${escapeHtml(acc.nickname)} (\${escapeHtml(acc.email)})">
                  \${escapeHtml(acc.nickname)}
                </span>
              </div>
              <div style="display: flex; gap: 4px;">
                \${checkinBadge}
                \${statusBadge}
              </div>
            </div>

            <div class="card-body">
              <div class="metric-row">
                <div class="credit-count">
                  <span>\${credits}</span>
                  <span class="unit">算力点</span>
                </div>
                <div class="streak-text">
                  连续签到 <strong>\${streak}</strong> 天
                </div>
              </div>
              <div class="uid-caption" title="UID: \${escapeHtml(acc.uid)} | 绑定: \${escapeHtml(acc.email)}">
                UID: \${escapeHtml(uidSnippet)}
              </div>
            </div>

            <div class="card-footer">
              <div class="footer-left-buttons">
                \${switchBtn}
                \${checkinBtn}
              </div>
              \${deleteBtn}
            </div>
          </div>
        \`;
      }).join('');
    }

    function setActionsDisabled(disabled) {
      btnAddOAuth.disabled = disabled;
      btnImportCockpit.disabled = disabled;
      btnBatchCheckin.disabled = disabled;
      btnRefresh.disabled = disabled;
    }

    function onSwitch(id) {
      vscode.postMessage({ command: 'switchAccount', accountId: id });
    }

    function onCheckin(id) {
      vscode.postMessage({ command: 'checkinAccount', accountId: id });
    }

    function onDelete(id) {
      vscode.postMessage({ command: 'deleteAccount', accountId: id });
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // 页面就绪后立即请求最新状态
    vscode.postMessage({ command: 'webviewReady' });
  </script>
</body>
</html>`;
  }
}
