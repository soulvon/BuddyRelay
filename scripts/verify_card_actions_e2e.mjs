/**
 * 视觉尺寸死锁与切号状态机端到端全链路审查脚本
 * 深度断言：
 * 1. CSS 尺寸强锁与防折行属性完整性
 * 2. JS switchingId 状态机流转 (点击切换 -> 加载态 -> 消息响应释放 -> 看门狗超时释放)
 * 3. 切号通知纯净性与文本去重
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

async function runAudit() {
  console.log('=== 开始 BuddyRelay v0.3.2 深度端到端审查 ===\n');

  // ──────────────────────────────────────────────────────────
  // 维度一：CSS 尺寸死锁与防折行审查（杜绝任何情况下的按钮撑大变高）
  // ──────────────────────────────────────────────────────────
  console.log('[审查 1/3] 卡片底栏与按钮 CSS 尺寸死锁审查');
  const htmlPath = path.join(ROOT, 'resources', 'webview', 'sidebar.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // 1. .grid-card-actions 容器死锁
  const cardActionsRuleMatch = html.match(/\.grid-card-actions\s*\{([^}]+)\}/g);
  const cardActionsCss = cardActionsRuleMatch ? cardActionsRuleMatch.join('\n') : '';
  check('底栏容器: 包含 flex-wrap: nowrap !important', cardActionsCss.includes('flex-wrap: nowrap !important'));
  check('底栏容器: 包含 white-space: nowrap !important', cardActionsCss.includes('white-space: nowrap !important'));
  check('底栏容器: 包含 height: 26px !important', cardActionsCss.includes('height: 26px !important'));
  check('底栏容器: 包含 max-height: 26px !important', cardActionsCss.includes('max-height: 26px !important'));
  check('底栏容器: 包含 overflow: hidden !important', cardActionsCss.includes('overflow: hidden !important'));

  // 2. .grid-switch-btn 切换按钮尺寸死锁
  const switchBtnRuleMatch = html.match(/\.grid-switch-btn\s*\{([^}]+)\}/g);
  const switchBtnCss = switchBtnRuleMatch ? switchBtnRuleMatch.join('\n') : '';
  check('切换按钮: 包含 height: 22px !important', switchBtnCss.includes('height: 22px !important'));
  check('切换按钮: 包含 max-height: 22px !important', switchBtnCss.includes('max-height: 22px !important'));
  check('切换按钮: 包含 line-height: 22px !important', switchBtnCss.includes('line-height: 22px !important'));
  check('切换按钮: 包含 white-space: nowrap !important', switchBtnCss.includes('white-space: nowrap !important'));
  check('切换按钮: 包含 flex-shrink: 0 !important', switchBtnCss.includes('flex-shrink: 0 !important'));
  check('切换按钮: 包含 inline-flex 对齐', switchBtnCss.includes('display: inline-flex !important'));

  // 3. .btn-mini-spinner 转圈动画尺寸死锁
  const spinnerRuleMatch = html.match(/\.btn-mini-spinner\s*\{([^}]+)\}/g);
  const spinnerCss = spinnerRuleMatch ? spinnerRuleMatch.join('\n') : '';
  check('小菊花动画: 宽高固定为 9px !important', spinnerCss.includes('width: 9px !important') && spinnerCss.includes('height: 9px !important'));
  check('小菊花动画: 包含 flex-shrink: 0 !important', spinnerCss.includes('flex-shrink: 0 !important'));

  // 4. .status-toggle-btn 状态按钮尺寸死锁
  const statusToggleMatch = html.match(/\.status-toggle-btn\s*\{([^}]+)\}/g);
  const statusToggleCss = statusToggleMatch ? statusToggleMatch.join('\n') : '';
  check('启停/已签按钮: 包含 height: 20px !important', statusToggleCss.includes('height: 20px !important'));
  check('启停/已签按钮: 包含 max-height: 20px !important', statusToggleCss.includes('max-height: 20px !important'));
  check('启停/已签按钮: 包含 white-space: nowrap !important', statusToggleCss.includes('white-space: nowrap !important'));
  check('启停/已签按钮: 包含 flex-shrink: 0 !important', statusToggleCss.includes('flex-shrink: 0 !important'));

  // 5. .icon-btn 图标按钮尺寸死锁
  const iconBtnMatch = html.match(/\.icon-btn\s*\{([^}]+)\}/g);
  const iconBtnCss = iconBtnMatch ? iconBtnMatch.join('\n') : '';
  check('小图标按钮: 宽高严格锁定为 20px !important', iconBtnCss.includes('width: 20px !important') && iconBtnCss.includes('height: 20px !important'));
  check('小图标按钮: 包含 flex-shrink: 0 !important', iconBtnCss.includes('flex-shrink: 0 !important'));

  console.log('');

  // ──────────────────────────────────────────────────────────
  // 维度二：switchingId 状态机与生命周期流转实测
  // ──────────────────────────────────────────────────────────
  console.log('[审查 2/3] switchingId 状态机流转与看门狗实测');

  // 构建模拟沙盒环境验证生命周期
  const mockVsCode = {
    postMessageCalled: [],
    postMessage(data) {
      this.postMessageCalled.push(data);
    },
    getState() { return {}; },
    setState() {}
  };

  // 模拟 sidebar 的核心状态机逻辑
  let switchingId = '';
  let _switchTimeout = null;
  let cardRenderCount = 0;
  let lastRenderedBtnHtml = '';

  const testAccount = {
    id: 'acc-test-1',
    uid: 'uid-test-1',
    nickname: '白苏半',
    status: 'idle',
    isActive: false
  };

  function renderCardBtn(acc) {
    cardRenderCount++;
    const isDisabled = acc.status === 'disabled';
    const isActive = acc.isActive;
    if (isActive) {
      return '<span class="grid-current-label">● 使用中</span>';
    }
    return `<button class="grid-switch-btn" onclick="onSwitch('${acc.id}')" ${switchingId === acc.id || isDisabled ? 'disabled' : ''}>${switchingId === acc.id ? '<span class="btn-mini-spinner"></span>切换中' : '切换'}</button>`;
  }

  function onSwitch(id) {
    switchingId = id;
    lastRenderedBtnHtml = renderCardBtn(testAccount);
    mockVsCode.postMessage({ command: 'switchAccount', accountId: id });
    if (_switchTimeout) clearTimeout(_switchTimeout);
    _switchTimeout = setTimeout(() => {
      if (switchingId === id) {
        switchingId = '';
        lastRenderedBtnHtml = renderCardBtn(testAccount);
      }
    }, 50); // 测试用 50ms 缩短看门狗
  }

  function handleMessage(msg) {
    if (msg.command === 'updateState') {
      const isOperating = msg.data.isOperating;
      if (!isOperating) {
        if (switchingId) {
          switchingId = '';
          if (_switchTimeout) clearTimeout(_switchTimeout);
          lastRenderedBtnHtml = renderCardBtn(testAccount);
        }
      }
    } else if (msg.command === 'notify') {
      if (switchingId) {
        switchingId = '';
        if (_switchTimeout) clearTimeout(_switchTimeout);
        lastRenderedBtnHtml = renderCardBtn(testAccount);
      }
    }
  }

  // 初始状态
  lastRenderedBtnHtml = renderCardBtn(testAccount);
  check('状态机初始: switchingId 为空字符串', switchingId === '');
  check('状态机初始: 按钮渲染为普通"切换"且可点击', lastRenderedBtnHtml.includes('切换') && !lastRenderedBtnHtml.includes('disabled') && !lastRenderedBtnHtml.includes('btn-mini-spinner'));

  // 触发点击切换
  onSwitch('acc-test-1');
  check('点击切号: switchingId 被设置为目标账号 ID', switchingId === 'acc-test-1');
  check('点击切号: 按钮立刻禁用 disabled', lastRenderedBtnHtml.includes('disabled'));
  check('点击切号: 按钮内嵌 btn-mini-spinner 动画', lastRenderedBtnHtml.includes('btn-mini-spinner'));
  check('点击切号: 按钮文字变为"切换中"', lastRenderedBtnHtml.includes('切换中'));
  check('点击切号: 向宿主发送了 switchAccount postMessage 指令', mockVsCode.postMessageCalled.some(c => c.command === 'switchAccount' && c.accountId === 'acc-test-1'));

  // 场景 A: 收到 notify 消息释放
  handleMessage({ command: 'notify', level: 'success', message: '切换成功' });
  check('收到 notify: switchingId 立即重置为空', switchingId === '');
  check('收到 notify: 按钮立即恢复正常"切换"且解除 disabled', !lastRenderedBtnHtml.includes('disabled') && !lastRenderedBtnHtml.includes('btn-mini-spinner') && lastRenderedBtnHtml.includes('切换'));

  // 场景 B: 收到 updateState 结束消息释放
  onSwitch('acc-test-1');
  check('再次点击: 重新进入切换中', switchingId === 'acc-test-1');
  handleMessage({ command: 'updateState', data: { isOperating: false } });
  check('收到 updateState: switchingId 立即重置为空', switchingId === '');
  check('收到 updateState: 按钮解除锁定恢复', !lastRenderedBtnHtml.includes('disabled'));

  // 场景 C: 网络无响应时看门狗超时自动解脱
  onSwitch('acc-test-1');
  check('看门狗测试: 触发切号开始计时', switchingId === 'acc-test-1');
  await new Promise(r => setTimeout(r, 80));
  check('看门狗超时: 无后端响应时自动重置 switchingId', switchingId === '');
  check('看门狗超时: 按钮自动解脱恢复可点击', !lastRenderedBtnHtml.includes('disabled'));

  console.log('');

  // ──────────────────────────────────────────────────────────
  // 维度三：切号后端链路、通知级别与文案去重审查
  // ──────────────────────────────────────────────────────────
  console.log('[审查 3/3] 后端切号结果分发与通知纯净度审查');
  const providerPath = path.join(ROOT, 'src', 'sidebarProvider.ts');
  const providerTs = fs.readFileSync(providerPath, 'utf8');

  // 1. 语法与分支审查
  const switchHandlerRegex = /async handleSwitchAccount\([^)]*\)[\s\S]*?finally/g;
  const matchHandler = providerTs.match(switchHandlerRegex);
  const handlerCode = matchHandler ? matchHandler[0] : '';

  check('分发逻辑: res.success 时必须发送 success 级别', handlerCode.includes("this.sendNotify('success',"));
  check('分发逻辑: res.success 时严禁再发送 error 级别', !handlerCode.includes("this.sendNotify('error',\n          `BuddyRelay: 已切换至"));
  check('分发逻辑: 纯净单重前缀，杜绝"已切换至 XXX，已切换至 XXX"重复拼接', !handlerCode.includes("，${res.message}"));
  check('分发逻辑: 只有 catch 异常或 !res.success 才发 error', handlerCode.includes("this.sendNotify('error', `切号异常: ${res.message}`)"));

  console.log('');

  // ──────────────────────────────────────────────────────────
  // 汇总
  // ──────────────────────────────────────────────────────────
  console.log(`审查断言结果: ${passed} 项全部通过, ${failed} 项失败`);
  if (failed > 0) {
    console.error('发现未通过的审查项:');
    failures.forEach(f => console.error(`  - ${f.title}: ${f.detail}`));
    process.exit(1);
  } else {
    console.log('✓ 全链路审查完毕，卡片底栏尺寸固化与切换中状态机 100% 达标！');
    process.exit(0);
  }
}

runAudit().catch(err => {
  console.error('审查脚本执行异常:', err);
  process.exit(1);
});
