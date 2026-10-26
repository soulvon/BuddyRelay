/**
 * BuddyRelay 界面与交互体系全面自测脚本
 * 深度验证 StatusBar、SidebarProvider (Webview 6项交互铁律) 与 Extension 生命周期
 */

const fs = require('fs');
const path = require('path');

// 构造 VS Code 完整 Mock 运行沙箱
class MockStatusBarItem {
  constructor(alignment, priority) {
    this.alignment = alignment;
    this.priority = priority;
    this.text = '';
    this.tooltip = '';
    this.command = '';
    this.backgroundColor = undefined;
    this.visible = false;
  }
  show() { this.visible = true; }
  hide() { this.visible = false; }
  dispose() { this.visible = false; }
}

class MockEventEmitter {
  constructor() {
    this.listeners = [];
  }
  event = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data) {
    for (const l of this.listeners) l(data);
  }
}

class MockWebview {
  constructor() {
    this.options = {};
    this.html = '';
    this._onDidReceiveMessage = new MockEventEmitter();
    this.postedMessages = [];
  }
  get onDidReceiveMessage() {
    return this._onDidReceiveMessage.event;
  }
  postMessage(msg) {
    this.postedMessages.push(msg);
    return Promise.resolve(true);
  }
}

class MockWebviewView {
  constructor() {
    this.webview = new MockWebview();
    this.visible = true;
    this._onDidChangeVisibility = new MockEventEmitter();
  }
  get onDidChangeVisibility() {
    return this._onDidChangeVisibility.event;
  }
}

const registeredCommands = new Map();
const registeredWebviewViewProviders = new Map();

const mockVscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ThemeColor: class ThemeColor {
    constructor(id) { this.id = id; }
  },
  ThemeIcon: class ThemeIcon {
    constructor(id) { this.id = id; }
  },
  MarkdownString: class MarkdownString {
    constructor(str) { this.value = str || ''; }
    appendMarkdown(str) { this.value += str; }
  },
  Uri: {
    parse: (str) => ({ toString: () => str, path: str }),
    file: (str) => ({ toString: () => str, fsPath: str })
  },
  env: {
    openExternal: async () => true
  },
  window: {
    createStatusBarItem: (alignment, priority) => new MockStatusBarItem(alignment, priority),
    registerWebviewViewProvider: (viewType, provider, options) => {
      registeredWebviewViewProviders.set(viewType, { provider, options });
      return { dispose: () => registeredWebviewViewProviders.delete(viewType) };
    },
    showQuickPick: async (items, options) => {
      mockVscode._lastQuickPickItems = items;
      mockVscode._lastQuickPickOptions = options;
      return null;
    },
    showInformationMessage: async (msg) => {
      mockVscode._lastInfoMessage = msg;
      return undefined;
    },
    showWarningMessage: async (msg, ...items) => {
      mockVscode._lastWarnMessage = msg;
      return undefined;
    },
    showErrorMessage: async (msg) => {
      mockVscode._lastErrorMessage = msg;
      return undefined;
    },
    withProgress: async (options, task) => {
      return await task({ report: () => {} });
    }
  },
  commands: {
    registerCommand: (command, callback) => {
      registeredCommands.set(command, callback);
      return { dispose: () => registeredCommands.delete(command) };
    },
    executeCommand: async (command, ...args) => {
      const handler = registeredCommands.get(command);
      if (handler) return await handler(...args);
      return undefined;
    }
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, defaultValue) => defaultValue
    })
  }
};

// 注入 Module Cache 劫持 'vscode'
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (specifier) {
  if (specifier === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};

// 载入待测模块
const { AccountStore } = require('./out/accountStore.js');
const { SeamlessSwitcher } = require('./out/seamlessSwitcher.js');
const { CheckinService } = require('./out/checkinService.js');
const { CockpitImporter } = require('./out/cockpitImporter.js');
const { OAuthService } = require('./out/oauthService.js');
const { StatusBarManager } = require('./out/statusBar.js');
const { SidebarProvider } = require('./out/sidebarProvider.js');
const extension = require('./out/extension.js');

async function runUITests() {
  console.log('====================================================');
  console.log('🎨 开始 BuddyRelay 界面与交互体系全面自测');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition, desc) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${desc}`);
      throw new Error(`Assertion failed: ${desc}`);
    }
  }

  // ----------------------------------------------------------------
  // 1. 测试 src/statusBar.ts
  // ----------------------------------------------------------------
  console.log('--- 1. 测试 src/statusBar.ts (左下角常驻状态栏 + QuickPick) ---');
  const tempStorePath = path.join(process.env.TEMP || '.', `test_ui_store_${Date.now()}.json`);
  const store = new AccountStore(undefined, tempStorePath);
  const switcher = new SeamlessSwitcher();

  const statusBar = new StatusBarManager(store, switcher);
  const rawItem = statusBar.statusBarItem;

  assert(rawItem.alignment === mockVscode.StatusBarAlignment.Left, '状态栏对齐模式为左对齐 (Left)');
  assert(rawItem.priority === 100, '状态栏优先级设定为 100 常驻');
  assert(rawItem.command === 'buddy-relay.showAccountQuickPick', '点击绑定命令为 buddy-relay.showAccountQuickPick');
  assert(rawItem.text.includes('未登录'), '无账号时显示未登录状态: ' + rawItem.text);
  assert(rawItem.visible === true, '状态栏已调用 show() 显示');

  // 添加测试账号并设为 active
  const testAcc1 = {
    id: 'codebuddy_cn_test1',
    uid: '8e47d7fa-39a9-4458-abfe-312041f07bf0',
    email: '177****8819',
    nickname: '苏文',
    accessToken: 'mock_token',
    refreshToken: 'mock_refresh',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600000,
    domain: 'www.codebuddy.cn',
    status: 'active',
    totalCredits: 2700,
    checkinStreak: 27,
    todayCheckedIn: true,
    createdAt: Date.now(),
    lastUsed: Date.now()
  };

  const testAcc2 = {
    id: 'codebuddy_cn_test2',
    uid: '5d81daec-a2d4-48ae-aecf-193c4c3884c3',
    email: '199****1234',
    nickname: '麦飞',
    accessToken: 'mock_token_2',
    refreshToken: 'mock_refresh_2',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600000,
    domain: 'www.codebuddy.cn',
    status: 'idle',
    totalCredits: 1200,
    checkinStreak: 12,
    todayCheckedIn: false,
    createdAt: Date.now(),
    lastUsed: Date.now() - 10000
  };

  await store.upsert(testAcc1);
  await store.upsert(testAcc2);
  await store.setActive(testAcc1.id);
  statusBar.update();

  assert(rawItem.text.includes('苏文'), `活跃账号名称正常展示: ${rawItem.text}`);
  assert(rawItem.text.includes('2,700点'), `额度积分正确格式化展示: ${rawItem.text}`);
  assert(rawItem.tooltip.value.includes('苏文'), '悬浮提示包含账号昵称');
  assert(rawItem.tooltip.value.includes('2,700 算力点'), '悬浮提示包含算力点');
  assert(rawItem.tooltip.value.includes('连续签到 27 天'), '悬浮提示包含签到天数');
  assert(rawItem.tooltip.value.includes('今日已签到'), '悬浮提示包含签到状态');

  // 测试 429 速率限制视觉反馈
  await store.markRateLimited(testAcc1.id, 60000);
  statusBar.update();
  assert(rawItem.text.includes('429冷却中'), `429 限制状态栏警示文本: ${rawItem.text}`);
  assert(rawItem.backgroundColor !== undefined, '429 限制设置了警示背景色');

  await store.clearRateLimit(testAcc1.id);
  statusBar.update();
  assert(rawItem.backgroundColor === undefined, '解除 429 后背景色恢复正常');

  // 测试 showQuickPick
  await statusBar.showQuickPick();
  const qpItems = mockVscode._lastQuickPickItems;
  assert(Array.isArray(qpItems) && qpItems.length >= 6, `QuickPick 生成了 ${qpItems.length} 个条目`);

  const accItems = qpItems.filter(i => i.actionType === 'account');
  const actionItems = qpItems.filter(i => i.actionType === 'action');
  assert(accItems.length === 2, '包含 2 个账号切号选项');
  assert(accItems[0].label.includes('$(check)'), '当前活跃账号带有勾选标识 $(check)');
  assert(accItems[0].description.includes('2,700 算力点'), '账号条目展示算力点数');

  const actionLabels = actionItems.map(i => i.label);
  assert(actionLabels.some(l => l.includes('添加账号 (OAuth 授权登录)')), '包含添加账号(OAuth)入口');
  assert(actionLabels.some(l => l.includes('从 Cockpit 导入账号')), '包含从 Cockpit 导入入口');
  assert(actionLabels.some(l => l.includes('一键全员签到')), '包含一键全员签到入口');
  assert(actionLabels.some(l => l.includes('刷新状态与配额')), '包含刷新状态入口');

  // ----------------------------------------------------------------
  // 2. 测试 src/sidebarProvider.ts (Kite 风格 Webview + 6 项交互铁律)
  // ----------------------------------------------------------------
  console.log('\n--- 2. 测试 src/sidebarProvider.ts (Webview 与 6 项交互铁律) ---');
  const checkinService = new CheckinService();
  const importer = new CockpitImporter();
  const oauthService = new OAuthService();

  const sidebar = new SidebarProvider(
    mockVscode.Uri.file(__dirname),
    store,
    switcher,
    checkinService,
    importer,
    oauthService
  );

  assert(SidebarProvider.viewType === 'buddy-relay.sidebarView', 'Webview ViewType 为 buddy-relay.sidebarView');

  const mockWebviewView = new MockWebviewView();
  sidebar.resolveWebviewView(mockWebviewView, {}, {});

  const html = mockWebviewView.webview.html;
  assert(typeof html === 'string' && html.length > 500, '成功生成 Webview HTML 内容');

  // 审查 6 项交互铁律
  console.log('  [审查] 严格检查 6 项交互铁律:');

  // 铁律 1: 禁廉价蓝紫渐变
  const hasPurpleGradient = /linear-gradient\([^)]*(purple|violet|#6366f1|#a855f7|#8b5cf6|#d946ef)/i.test(html);
  assert(!hasPurpleGradient, '铁律 1 通行: 无廉价蓝紫/霓虹渐变背景 (采用原生 VS Code 语义色与纯净中性暗色)');

  // 铁律 2: 禁雷达波纹与光晕呼吸
  const hasRadarRipple = /(@keyframes\s+(radar|ripple|pulse|wave)|animation:[^;]*(radar|ripple|pulse))/i.test(html);
  assert(!hasRadarRipple, '铁律 2 通行: 无雷达波纹、涟漪或脉冲动效 (仅保留利落的微过渡)');

  // 铁律 3: 自然中文
  assert(html.includes('添加账号 (OAuth)'), '铁律 3 通行: 顶部动作包含自然中文 "添加账号 (OAuth)"');
  assert(html.includes('从 Cockpit 导入'), '铁律 3 通行: 顶部动作包含自然中文 "从 Cockpit 导入"');
  assert(html.includes('一键全员签到'), '铁律 3 通行: 顶部动作包含自然中文 "一键全员签到"');
  assert(html.includes('算力点'), '铁律 3 通行: 单位采用标准 "算力点"');
  assert(html.includes('今日已签') && html.includes('今日未签'), '铁律 3 通行: 状态徽标自然中文');

  // 铁律 4: 骨架屏与明确加载反馈
  assert(html.includes('skeleton-card'), '铁律 4 通行: 具备防塌陷骨架屏卡片 (skeleton-card)');
  assert(html.includes('operation-status-bar'), '铁律 4 通行: 具备明确的操作中反馈浮条 (operation-status-bar)');
  assert(html.includes('setActionsDisabled'), '铁律 4 通行: 具备操作进行中按钮禁用防重试逻辑');

  // 铁律 5: 卡片圆角合理 (4px 规范圆角，贴合 VS Code 原生)
  const radiusMatch = html.match(/border-radius:\s*(\d+)px/g) || [];
  const allRadiiReasonable = radiusMatch.every(r => {
    const num = parseInt(r.replace(/\D/g, ''), 10);
    return num <= 8; // 绝不出现 16px/24px 夸张大圆角
  });
  assert(allRadiiReasonable, '铁律 5 通行: 卡片与按钮圆角规范 (<= 8px, 主体 4px)');

  // 铁律 6: 严禁多重套娃
  assert(html.includes('class="card-list"'), '铁律 6 通行: 具备直属账号卡片流容器 (card-list)');
  assert(html.includes('min-height: 112px'), '铁律 6 通行: 卡片具备 min-height: 112px 严格防塌设计');

  // 测试 postStateToWebview 数据契约
  sidebar.postStateToWebview();
  const posted = mockWebviewView.webview.postedMessages;
  assert(posted.length > 0, 'Webview 成功收到消息推送');
  const lastStateMsg = posted[posted.length - 1];
  assert(lastStateMsg.command === 'updateState', '消息命令为 updateState');
  assert(lastStateMsg.data.accounts.length === 2, '推流数据包含 2 个账号');
  assert(lastStateMsg.data.stats.totalCredits === 3900, '汇总总算力计算正确 (2700 + 1200 = 3900)');
  assert(lastStateMsg.data.stats.checkedTodayCount === 1, '今日已签到统计准确 (1/2)');

  // ----------------------------------------------------------------
  // 3. 测试 src/extension.ts 生命周期与调度任务
  // ----------------------------------------------------------------
  console.log('\n--- 3. 测试 src/extension.ts (生命周期与命令串联) ---');
  const mockContext = {
    subscriptions: [],
    extensionUri: mockVscode.Uri.file(__dirname),
    globalState: {
      get: () => undefined,
      update: async () => {}
    }
  };

  await extension.activate(mockContext);
  assert(mockContext.subscriptions.length >= 8, `成功注册 ${mockContext.subscriptions.length} 项生命周期订阅`);

  // 检查关键命令是否全部成功注册
  const expectedCommands = [
    'buddy-relay.showAccountQuickPick',
    'buddy-relay.switchAccount',
    'buddy-relay.checkin',
    'buddy-relay.importCockpit',
    'buddy-relay.addAccountOAuth',
    'buddy-relay.deleteAccount',
    'buddy-relay.refreshStatus'
  ];

  for (const cmd of expectedCommands) {
    assert(registeredCommands.has(cmd), `命令 ${cmd} 成功注册`);
  }

  // 检查 Webview View Provider 是否成功注册
  assert(registeredWebviewViewProviders.has('buddy-relay.sidebarView'), 'buddy-relay.sidebarView 成功向 VS Code 注册');

  // 测试 package.json 对齐
  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const pkgCommands = pkgJson.contributes.commands.map(c => c.command);
  for (const cmd of expectedCommands) {
    assert(pkgCommands.includes(cmd), `package.json contributes.commands 声明了 ${cmd}`);
  }

  const pkgViews = pkgJson.contributes.views['buddy-relay-sidebar'];
  assert(pkgViews.some(v => v.id === 'buddy-relay.sidebarView' && v.type === 'webview'), 'package.json 声明了 type: webview 侧栏视图');

  // 测试销毁
  extension.deactivate();
  statusBar.dispose();
  if (fs.existsSync(tempStorePath)) fs.unlinkSync(tempStorePath);

  console.log('\n====================================================');
  console.log(`🎉 全部 ${passed}/${total} 项界面与交互体系自测全部通过！`);
  console.log('====================================================\n');
}

runUITests().catch(err => {
  console.error('\n❌ 界面自测异常:', err);
  process.exit(1);
});
