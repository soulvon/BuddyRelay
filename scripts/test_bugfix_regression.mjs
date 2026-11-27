/**
 * 遗留 Bug 全量回归测试（Red-Green 驱动）
 * 覆盖：
 *  1. CheckinService / AccountStore：同步失败不清空资源包、并发切号不被旧状态回滚、disabled/expired 不被强行复活
 *  2. AutoSwitcher：国际账号不误走国内探针判失效
 *  3. SessionHealer / SeamlessSwitcher：过期 master 顺延发现、相对链接解析、customCmdPath 回执识别
 *  4. SidebarProvider：handleSaveSettings 保留 0 值、update.autoInstall 默认值对齐、秒级 expires_at 转换
 *  5. CheckinScheduler / extension.ts：重试 timer 可销毁、无变量遮蔽导致 deactivate 失效
 *  6. UsageTracker / Webview：fetch 带 signal 超时保护、无日期 UTC 偏移 Bug、标签防引号注入与重设筛选联动
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(title, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${title}`);
  } else {
    failed++;
    failures.push({ title, detail });
    console.log(`  FAIL  ${title}${detail ? ' — ' + detail : ''}`);
  }
}

const configUpdates = [];
const mockConfigStore = new Map();
let lastStatusBarItem = null;
let lastQuickPickItems = [];
const mockVscode = {
  env: {
    appName: 'CodeBuddy CN',
    appRoot: '',
    sessionId: 'test-bugfix-session',
    language: 'zh-cn',
    clipboard: { writeText: async () => {} },
    openExternal: async () => true
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  MarkdownString: class MarkdownString {
    constructor(val = '') { this.value = val; }
    appendMarkdown(str) { this.value += str; return this; }
  },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  workspace: {
    getConfiguration: (section) => ({
      get: (k, def) => {
        const full = `${section}.${k}`;
        return mockConfigStore.has(full) ? mockConfigStore.get(full) : def;
      },
      update: async (k, val, target) => {
        configUpdates.push({ k, val, target });
        mockConfigStore.set(`${section}.${k}`, val);
      }
    }),
    onDidChangeConfiguration: () => ({ dispose: () => {} })
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_opt, fn) => fn({ report: () => {} }),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: '', command: '', backgroundColor: undefined, show: () => {}, hide: () => {}, dispose: () => {} };
      lastStatusBarItem = item;
      return item;
    },
    showQuickPick: async (items) => {
      lastQuickPickItems = items || [];
      return undefined;
    },
    registerWebviewViewProvider: () => ({ dispose: () => {} })
  },
  commands: {
    executeCommand: async () => {},
    registerCommand: () => ({ dispose: () => {} })
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (b, ...s) => ({ fsPath: path.join(b?.fsPath || '', ...s) }),
    parse: (s) => ({ toString: () => s })
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 }
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return mockVscode;
  return origLoad.apply(this, arguments);
};

async function run() {
  console.log('=== 开始 BuddyRelay 遗留 Bug 全量回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-bugfix-'));

  try {
    const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
    const { CheckinService } = require(path.join(ROOT, 'out', 'checkinService.js'));
    const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));
    const { SessionHealer } = require(path.join(ROOT, 'out', 'sessionHealer.js'));
    const { SeamlessSwitcher } = require(path.join(ROOT, 'out', 'seamlessSwitcher.js'));
    const { SidebarProvider } = require(path.join(ROOT, 'out', 'sidebarProvider.js'));
    const { CheckinScheduler } = require(path.join(ROOT, 'out', 'checkinScheduler.js'));
    const { UsageTracker } = require(path.join(ROOT, 'out', 'usageTracker.js'));

    // ── 1. CheckinService & AccountStore 并发与空值保护 ──
    console.log('[测试 1/6] CheckinService 与 AccountStore 状态一致性和数据保护');
    const poolFile = path.join(tmpDir, 'pool-1.json');
    const store1 = new AccountStore(undefined, poolFile);
    await store1.upsertBatch([
      {
        id: 'acc-1', uid: 'uid-1', email: '1@t.cn', nickname: 'One',
        accessToken: 'tok1', refreshToken: 'r1', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
        status: 'idle', totalCredits: 888,
        basePackage: { title: '基础', count: 1, remain: 388, total: 500, percent: 77.6 },
        activityPackage: { title: '活动', count: 2, remain: 500, total: 1000, percent: 50 },
        createdAt: 1, lastUsed: 1
      },
      {
        id: 'acc-2', uid: 'uid-2', email: '2@t.cn', nickname: 'Two',
        accessToken: 'tok2', refreshToken: 'r2', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
        status: 'active', totalCredits: 500, createdAt: 2, lastUsed: 2
      }
    ]);

    const svc = new CheckinService();
    // 模拟在 syncAccountStatus 发起 HTTP 期间，外部并发把 acc-1 切成了 active
    svc.queryStatus = async () => {
      await store1.setActive('acc-1');
      return {
        active: true, todayCheckedIn: true, streakDays: 5,
        dailyCredit: 100, todayCredit: 100, totalCredits: 99999,
        lastCheckinDate: '2026-11-16'
      };
    };
    svc.queryRealRemainingQuota = async () => null; // 模拟资源包查询超时/失败

    const staleSnapshot = { ...store1.get('acc-1'), status: 'idle' };
    await svc.syncAccountStatus(staleSnapshot, store1);
    const updated1 = store1.get('acc-1');
    check(
      'syncAccountStatus 失败返回 null 时不得用活动累计分抹掉 totalCredits',
      updated1.totalCredits === 888,
      `totalCredits=${updated1.totalCredits}`
    );
    check(
      'syncAccountStatus 失败返回 null 时不得将 basePackage 抹成 undefined',
      Boolean(updated1.basePackage && updated1.basePackage.remain === 388),
      JSON.stringify(updated1.basePackage)
    );
    check(
      'syncAccountStatus 异步完成时不得拿过期快照把并发切换后的 active 盖回 idle',
      updated1.status === 'active' && store1.getActive()?.id === 'acc-1',
      `status=${updated1.status}, activeId=${store1.getActive()?.id}`
    );

    // 验证禁用/过期全池时不得强行复活为 active
    const poolDisabled = path.join(tmpDir, 'pool-disabled.json');
    const storeDis = new AccountStore(undefined, poolDisabled);
    await storeDis.upsertBatch([
      {
        id: 'd1', uid: 'u-d1', email: 'd1@t.cn', nickname: 'D1',
        accessToken: 'td1', refreshToken: '', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600e3, domain: 'www.codebuddy.cn',
        status: 'disabled', createdAt: 1, lastUsed: 1
      },
      {
        id: 'e1', uid: 'u-e1', email: 'e1@t.cn', nickname: 'E1',
        accessToken: 'te1', refreshToken: '', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600e3, domain: 'www.codebuddy.cn',
        status: 'expired', createdAt: 2, lastUsed: 2
      }
    ]);
    check(
      '全池均为 disabled/expired 时绝不强行篡改状态为 active',
      storeDis.get('d1').status === 'disabled' && storeDis.get('e1').status === 'expired' && !storeDis.getActive(),
      `d1=${storeDis.get('d1').status}, e1=${storeDis.get('e1').status}`
    );
    store1.dispose();
    storeDis.dispose();

    // ── 2. AutoSwitcher 国际账号探针 & 429 恢复 ──
    console.log('[测试 2/6] AutoSwitcher 国际账号探针隔离');
    const poolIntl = path.join(tmpDir, 'pool-intl.json');
    const storeIntl = new AccountStore(undefined, poolIntl);
    await storeIntl.upsertBatch([
      {
        id: 'cn-base', uid: 'u-cn-base', email: 'cn@t.cn', nickname: 'CnBase',
        accessToken: 'tok-cn', refreshToken: 'r-cn', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
        status: 'active', createdAt: 1, lastUsed: 2
      },
      {
        id: 'intl-1', uid: 'u-intl-1', email: 'i@t.ai', nickname: 'Intl',
        accessToken: 'tok-intl', refreshToken: 'r-intl', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.ai',
        status: 'idle', createdAt: 1, lastUsed: 1
      }
    ]);
    const autoSw = new AutoSwitcher(storeIntl, new SeamlessSwitcher());
    const probeIntl = await autoSw.probeAccount(storeIntl.get('intl-1'));
    check(
      'probeAccount 遇国际域名 (codebuddy.ai) 不向国内接口探针，不误标为 expired',
      probeIntl.valid === true && storeIntl.get('intl-1').status === 'idle',
      JSON.stringify({ probeIntl, status: storeIntl.get('intl-1').status })
    );
    storeIntl.dispose();

    // ── 3. SessionHealer & SeamlessSwitcher 相对链接与母体顺延 ──
    console.log('[测试 3/6] SessionHealer 母体失效顺延与 SeamlessSwitcher customCmdPath');
    const dataRoot = path.join(tmpDir, 'ext-data');
    const staleMaster = 'stale-empty-uid';
    const realMaster = 'real-rich-uid';
    fs.mkdirSync(path.join(dataRoot, staleMaster, 'CodeBuddyIDE', staleMaster), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, realMaster, 'CodeBuddyIDE', realMaster, 'history'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, realMaster, 'CodeBuddyIDE', realMaster, 'history', 'h1.json'), '{}', 'utf8');
    const masterFile = path.join(tmpDir, 'session-master.json');
    fs.writeFileSync(masterFile, JSON.stringify({ masterUid: staleMaster }), 'utf8');

    const healer = new SessionHealer({ dataRoot, masterFile, logFile: path.join(tmpDir, 'heal.log') });
    const resolved = healer.resolveMasterForSwitch();
    check(
      'resolveMasterForSwitch 当已登记旧母体失效/为空时能顺延选出真实非空母体',
      Boolean(resolved && resolved.masterUid === realMaster),
      JSON.stringify(resolved)
    );

    const sealerSrc = fs.readFileSync(path.join(ROOT, 'src', 'sessionHealer.ts'), 'utf8');
    const switcherSrc = fs.readFileSync(path.join(ROOT, 'src', 'seamlessSwitcher.ts'), 'utf8');
    check(
      'SessionHealer / SeamlessSwitcher 解析符号链接目标必须基于 path.dirname(link)',
      sealerSrc.includes('path.dirname(innerPath)') && switcherSrc.includes('path.dirname(targetLink)')
    );
    check(
      'waitForSwitchReceipt 使用 customCmdPath || PATHS.BYOK_SWITCH_FILE',
      /waitForSwitchReceipt[\s\S]{0,400}this\.customCmdPath\s*\|\|\s*PATHS\.BYOK_SWITCH_FILE/.test(switcherSrc)
    );

    // ── 4. SidebarProvider 设置 0 值保留、默认值一致性、JWT 秒级 exp ──
    console.log('[测试 4/6] SidebarProvider 后端保存 0 值、update.autoInstall 对齐与秒级时间戳');
    const poolSp = path.join(tmpDir, 'pool-sp.json');
    const storeSp = new AccountStore(undefined, poolSp);
    const sp = new SidebarProvider({ fsPath: ROOT }, storeSp, new SeamlessSwitcher(), {}, {}, {});
    const postedMsgs = [];
    sp._view = { visible: true, webview: { postMessage: (m) => postedMsgs.push(m) } };
    configUpdates.length = 0;
    mockConfigStore.clear();

    await sp.handleSaveSettings({
      quotaThresholdPercent: 0,
      randomJitterMinutes: 0,
      perAccountDelaySeconds: 0,
      cooldownMinutes: 1
    });
    const getUpdated = (key) => configUpdates.find((u) => u.k === key)?.val;
    check('后端 handleSaveSettings 保留 quotaThresholdPercent=0', getUpdated('autoSwitch.quotaThresholdPercent') === 0, String(getUpdated('autoSwitch.quotaThresholdPercent')));
    check('后端 handleSaveSettings 保留 randomJitterMinutes=0', getUpdated('autoCheckin.randomJitterMinutes') === 0, String(getUpdated('autoCheckin.randomJitterMinutes')));
    check('后端 handleSaveSettings 保留 perAccountDelaySeconds=0', getUpdated('autoCheckin.perAccountDelaySeconds') === 0, String(getUpdated('autoCheckin.perAccountDelaySeconds')));

    postedMsgs.length = 0;
    mockConfigStore.clear();
    sp.postStateToWebview();
    const stateMsg = postedMsgs.find((m) => m.command === 'updateState');
    check(
      'postStateToWebview 中 updateAutoInstall 默认值对齐 package.json/updater (true)',
      stateMsg && stateMsg.data?.settings?.updateAutoInstall === true,
      JSON.stringify(stateMsg?.data?.settings?.updateAutoInstall)
    );

    // 秒级 expires_at 导入转换校验
    const secAcc = sp.normalizeImportedAccount({ uid: 'u-sec', access_token: 'tok', expires_at: 1800000000 });
    check(
      'normalizeImportedAccount 将 10 位秒级 expires_at 正确转为毫秒时间戳',
      Boolean(secAcc && secAcc.expiresAt === 1800000000 * 1000),
      `expiresAt=${secAcc?.expiresAt}`
    );
    storeSp.dispose();

    // ── 5. CheckinScheduler stop 清理 & extension.ts 无遮蔽 ──
    console.log('[测试 5/6] CheckinScheduler 重试定时器销毁与 extension.ts 清理');
    const extSrc = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
    check(
      'extension.ts activate 中不再用 const checkinScheduler 遮蔽模块级变量',
      !/\bconst\s+checkinScheduler\s*=\s*new CheckinScheduler/.test(extSrc)
    );
    check(
      'extension.ts onDidChangeConfiguration 纳入 context.subscriptions 防泄漏',
      /subscriptions\.push\([\s\S]{0,120}onDidChangeConfiguration/.test(extSrc) ||
      /context\.subscriptions\.push\(\s*vscode\.workspace\.onDidChangeConfiguration/.test(extSrc)
    );
    const schedSrc = fs.readFileSync(path.join(ROOT, 'src', 'checkinScheduler.ts'), 'utf8');
    check(
      'CheckinScheduler stop() 显式清理 retryTimer 并阻止异步完成后继续挂起下日定时器',
      schedSrc.includes('retryTimer') && /clearTimeout\(this\.retryTimer\)/.test(schedSrc)
    );

    // ── 6. UsageTracker & Webview 安全和筛选同步 ──
    console.log('[测试 6/6] UsageTracker 超时/时区安全性与 Webview XSS/标签栏同步');
    const utSrc = fs.readFileSync(path.join(ROOT, 'src', 'usageTracker.ts'), 'utf8');
    check(
      'UsageTracker.fetchOfficialDaily 统一走 httpRequest 并配置 timeout 与 retries',
      !utSrc.includes('await fetch(') &&
      /httpRequest<any>\([\s\S]{0,300}timeout:\s*15000[\s\S]{0,80}retries:\s*2/.test(utSrc)
    );
    check(
      'UsageTracker 每月 1 号判断直接按字符串 YYYY-MM-DD 取日历日，不受 UTC 时区回退影响',
      !utSrc.includes('new Date(today).getDate()') && /today\.slice\(8,\s*10\)/.test(utSrc)
    );

    const js = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.js'), 'utf8');
    check(
      'renderFilterDropdown 对自定义 def.label 使用 escHtml 转义',
      js.includes('escHtml(def.label)')
    );
    check(
      '卡片显示名称 displayName 与标签使用 escHtml 转义，标签不使用带引号风险的内联 onclick 拼串',
      js.includes('>${escHtml(displayName)}</div>') && !js.includes("onFilterByTag('${escHtml(tag)}')")
    );
    check(
      '#btnResetFilter 清除筛选后同步调用 renderTagBar() 重置顶部标签高亮',
      /resetBtn[\s\S]{0,400}renderTagBar\(\)/.test(js)
    );

    // ── 7. Issue #3 自定义显示名称全链路回归测试 ──
    console.log('[测试 7/7] 自定义显示名称保存、合并保留、脱敏与状态栏/QuickPick/SidebarProvider 透传');
    const { formatAccountLabel, normalizeImportedAccount, importAccountsFromText } = require(path.join(ROOT, 'out', 'importExportService.js'));
    const { StatusBarManager } = require(path.join(ROOT, 'out', 'statusBar.js'));
    const { buildIssueUrl } = require(path.join(ROOT, 'out', 'diagnostics.js'));
    const issueUrl = buildIssueUrl('## 切号异常: 测试标题\n\n- BuddyRelay: 1.4.2\n\n### 详情\n```\nerr line\n```');
    check(
      'buildIssueUrl 剥离 # 标题防 VS Code openExternal 双重编码出现 %23%23',
      !issueUrl.includes('%23') && issueUrl.includes('title=') && issueUrl.includes('body='),
      issueUrl
    );

    const poolDisplay = path.join(tmpDir, 'pool-display.json');
    const storeDisplay = new AccountStore(undefined, poolDisplay);
    await storeDisplay.upsert({
      id: 'acc-dn-1', uid: 'uid-dn-1', email: '13800138000', nickname: '13800138000',
      accessToken: 'tok-dn-1', refreshToken: 'ref-dn-1', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
      status: 'active', totalCredits: 2300, createdAt: 1, lastUsed: 10
    });

    // updateMeta 控制字符清洗 + 64 字符截断
    const longRaw = ` \u0007${'张三测试名称'.repeat(20)}\u001b `;
    await storeDisplay.updateMeta('acc-dn-1', { displayName: longRaw, notes: '测试备注', tags: ['主力'] });
    const dnAcc1 = storeDisplay.get('acc-dn-1');
    check(
      'AccountStore.updateMeta 剥离控制字符并截断 displayName 到 64 字符',
      Boolean(dnAcc1 && dnAcc1.displayName && dnAcc1.displayName.length === 64 && !/[\x00-\x1f\x7f]/.test(dnAcc1.displayName)),
      `len=${dnAcc1?.displayName?.length}`
    );

    await storeDisplay.updateMeta('acc-dn-1', { displayName: '  王小明  ', notes: '测试备注', tags: ['主力'] });
    check('AccountStore.find 支持按自定义 displayName 搜索账号', storeDisplay.find('王小明')?.id === 'acc-dn-1');

    // OAuth/外部 upsert 不含 displayName 时保留已有自定义名称
    await storeDisplay.upsert({
      id: 'acc-dn-1', uid: 'uid-dn-1', email: '13800138000', nickname: '13800138000',
      accessToken: 'tok-dn-refreshed', refreshToken: 'ref-dn-1', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
      status: 'idle', createdAt: 1, lastUsed: 20
    });
    check('AccountStore.upsert 重授/刷新不含 displayName 时保留原有自定义显示名称', storeDisplay.get('acc-dn-1')?.displayName === '王小明');

    // formatAccountLabel 优先级与隐私脱敏
    const accObj = storeDisplay.get('acc-dn-1');
    check('formatAccountLabel 非隐私模式优先返回 displayName', formatAccountLabel(accObj, false) === '王小明');
    check('formatAccountLabel 隐私模式对自定义显示名称走 maskName 脱敏', formatAccountLabel(accObj, true) === '王**');
    check('formatAccountLabel 无 displayName 时回退 nickname/email', formatAccountLabel({ nickname: '13900139000', email: '13900139000', uid: 'u' }, true) === '139****9000');

    // normalizeImportedAccount & importAccountsFromText
    const normSnake = normalizeImportedAccount({ uid: 'u-imp-1', access_token: 'tok-imp', nickname: '13900139000', display_name: ' \x00张三\x01 ' });
    check('normalizeImportedAccount 兼容 display_name 并清洗控制字符', normSnake?.displayName === '张三', String(normSnake?.displayName));

    await importAccountsFromText(
      JSON.stringify([{ id: 'acc-dn-1', uid: 'uid-dn-1', access_token: 'tok-dn-new', nickname: '13800138000' }]),
      storeDisplay,
      { batchSyncStatus: async () => {} },
      { setOperating: () => {}, sendNotify: () => {} }
    );
    check('importAccountsFromText 覆盖更新 Token 时保留已有 displayName', storeDisplay.get('acc-dn-1')?.displayName === '王小明');

    // SidebarProvider 透传、保存与清空 displayName
    const spDisplay = new SidebarProvider({ fsPath: ROOT }, storeDisplay, new SeamlessSwitcher(), {}, {}, {});
    const spMsgs = [];
    spDisplay._view = { visible: true, webview: { postMessage: (m) => spMsgs.push(m) } };
    spDisplay.postStateToWebview();
    const initState = spMsgs.find((m) => m.command === 'updateState');
    check(
      'SidebarProvider.postStateToWebview 下发 displayName 字段',
      initState?.data?.accounts?.some((a) => a.id === 'acc-dn-1' && a.displayName === '王小明')
    );

    await spDisplay.dispatchWebviewMessage({ command: 'updateAccountMeta', accountId: 'acc-dn-1', displayName: '张三', notes: '后端备注', tags: ['团队'] });
    check('SidebarProvider updateAccountMeta 正确持久化 displayName', storeDisplay.get('acc-dn-1')?.displayName === '张三');

    // StatusBarManager & QuickPick 展示与脱敏
    const sbDisplay = new StatusBarManager(storeDisplay, new SeamlessSwitcher(), async () => {});
    check(
      'StatusBarManager 非隐私模式显示自定义 displayName 与原账号提示',
      lastStatusBarItem?.text.includes('张三') &&
      lastStatusBarItem?.tooltip?.value?.includes('张三') &&
      lastStatusBarItem?.tooltip?.value?.includes('13800138000'),
      JSON.stringify({ text: lastStatusBarItem?.text, tip: lastStatusBarItem?.tooltip?.value })
    );

    await sbDisplay.showQuickPick();
    const qpAccItem = lastQuickPickItems.find((i) => i.actionType === 'account' && i.account?.id === 'acc-dn-1');
    check(
      'StatusBar QuickPick 非隐私模式在 label 显示自定义名称并在 detail 显示原账号',
      Boolean(qpAccItem && qpAccItem.label.includes('张三') && qpAccItem.detail.includes('13800138000')),
      JSON.stringify(qpAccItem)
    );

    await storeDisplay.setPrivacyMode(true);
    sbDisplay.update();
    check(
      'StatusBarManager 隐私模式下对自定义 displayName 与原账号同时脱敏',
      Boolean(
        lastStatusBarItem?.text.includes('张*') &&
        !lastStatusBarItem?.text.includes('张三') &&
        lastStatusBarItem?.tooltip?.value?.includes('张*') &&
        lastStatusBarItem?.tooltip?.value?.includes('138****8000') &&
        !lastStatusBarItem?.tooltip?.value?.includes('13800138000')
      ),
      JSON.stringify({ text: lastStatusBarItem?.text, tip: lastStatusBarItem?.tooltip?.value })
    );

    await sbDisplay.showQuickPick();
    const qpMaskedItem = lastQuickPickItems.find((i) => i.actionType === 'account' && i.account?.id === 'acc-dn-1');
    check(
      'StatusBar QuickPick 隐私模式下对 label 与 detail 原账号同步脱敏',
      Boolean(qpMaskedItem && qpMaskedItem.label.includes('张*') && qpMaskedItem.detail.includes('138****8000') && !qpMaskedItem.detail.includes('13800138000')),
      JSON.stringify(qpMaskedItem)
    );

    // 清空 displayName 后自动回退 nickname
    await storeDisplay.setPrivacyMode(false);
    await spDisplay.dispatchWebviewMessage({ command: 'updateAccountMeta', accountId: 'acc-dn-1', displayName: '   ', notes: '', tags: [] });
    sbDisplay.update();
    check(
      '清空 displayName 后存储置 undefined 并回退展示原 nickname/email',
      storeDisplay.get('acc-dn-1')?.displayName === undefined &&
      Boolean(lastStatusBarItem?.text.includes('13800138000')) &&
      !lastStatusBarItem?.tooltip?.value?.includes('原账号：')
    );

    sbDisplay.dispose();
    spDisplay.dispose();
    storeDisplay.dispose();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败明细:');
    for (const f of failures) {
      console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
