/**
 * UI 交互设计回归测试（表单零值/校验、模态框 Esc、单卡真刷新、看门狗对齐、失败保护期、指纹去重与搜索增强）
 */
import fs from 'node:fs';
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

async function run() {
  console.log('=== 开始 BuddyRelay UI 交互设计回归测试 ===\n');

  const html = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.js'), 'utf8');
  const spTs = fs.readFileSync(path.join(ROOT, 'src', 'sidebarProvider.ts'), 'utf8');
  const statusBarTs = fs.readFileSync(path.join(ROOT, 'src', 'statusBar.ts'), 'utf8');

  // 1. 设置表单零值不被吞 & 时间格式校验 & 无硬编码中文副标题
  console.log('[测试 1/6] 设置表单校验与 i18n 完整度');
  check(
    '设置表单保存 quotaThreshold 不再用 || 10 吞掉 0 值',
    !/parseInt\(setQuotaThreshold\.value,\s*10\)\s*\|\|\s*10/.test(js)
  );
  check(
    '设置表单保存 randomJitter 不再用 || 30 吞掉 0 值',
    !/parseInt\(setRandomJitter\.value,\s*10\)\s*\|\|\s*30/.test(js)
  );
  check(
    '设置表单支持 HH:mm 格式校验与错误提示',
    js.includes('js.invalidDailyTime') && /\^\(\[01\]\?\\d\|2\[0-3\]\):\(\[0-5\]\\d\)\$/.test(js)
  );
  check(
    '设置面板不再硬编码未国际化中文副标题',
    !html.includes('>界面语言与隐私脱敏设置<') && !html.includes('>自动检测与安装 GitHub 最新发布版本<') &&
    !js.includes('>界面语言与隐私脱敏设置<') && !js.includes('>自动检测与安装 GitHub 最新发布版本<')
  );

  // 2. 切号看门狗 >= 10000ms（大于后端 8s 超时）且带耗时读秒
  console.log('[测试 2/6] 切号看门狗与经过秒数反馈');
  const timeoutMatch = js.match(/window\.onSwitch\s*=\s*function[\s\S]{0,900}setTimeout\([\s\S]*?,\s*(\d+)\s*\)/);
  const watchdogMs = timeoutMatch ? Number(timeoutMatch[1]) : 0;
  check(
    '切号前端看门狗超时 >= 12000ms（不早于后端 8s 回执提前假解锁）',
    watchdogMs >= 12000,
    `actual=${watchdogMs}`
  );
  check(
    '切号中状态支持读秒耗时显示',
    js.includes('switchElapsed') && js.includes('js.switchingElapsed')
  );

  // 3. 单卡真刷新与按钮等待态
  console.log('[测试 3/6] 单卡真刷新与按钮级等待反馈');
  check(
    'window.onRefresh 发送单卡 refreshAccount 且携带 accountId',
    /window\.onRefresh\s*=\s*function\s*\(\s*id\s*\)[\s\S]{0,400}command:\s*['"]refreshAccount['"][\s\S]{0,120}accountId:\s*id/.test(js)
  );
  check(
    'SidebarProvider 实现 case refreshAccount 与 handleRefreshAccount',
    spTs.includes("case 'refreshAccount':") && spTs.includes('async handleRefreshAccount(')
  );
  check(
    '主工具栏 refreshAllBtn 与单卡刷新具备 is-spinning 等待反馈',
    js.includes("refreshAllBtn.classList.add('is-spinning')") &&
    js.includes('refreshingIds')
  );

  // 4. 全模态框 Escape 关闭 & 搜索增强
  console.log('[测试 4/6] 全模态框 Escape 支持与搜索/空筛选恢复');
  const escModals = [
    'confirmOverlay',
    'restartModalOverlay',
    'editMetaModalOverlay',
    'exportModalOverlay',
    'addAccountOverlay',
    'usageModalOverlay',
    'settingsModalOverlay',
    'taskModalOverlay'
  ];
  const escBlockMatch = js.match(/if\s*\(\s*e\.key\s*!==\s*'Escape'\s*\)\s*return;([\s\S]{0,1400})\}\);/);
  const escBlock = escBlockMatch ? escBlockMatch[1] : '';
  for (const id of escModals) {
    const ok = id === 'addAccountOverlay'
      ? (escBlock.includes('addAccountOverlay') || escBlock.includes('addOverlay'))
      : escBlock.includes(id);
    check(`Escape 统一关闭覆盖 ${id}`, ok);
  }
  const clampedMatch = js.match(/function readClampedInt[\s\S]*?\n\s*\}/);
  if (clampedMatch) {
    const fn = new Function(`${clampedMatch[0]}; return readClampedInt;`)();
    check('readClampedInt 保留合法 0 值而不回退默认值', fn({ value: '0' }, 10, 0, 90) === 0);
    check('readClampedInt 非法输入回退默认值', fn({ value: 'abc' }, 10, 0, 90) === 10);
    check('readClampedInt 越界输入钳位到上限', fn({ value: '999' }, 10, 0, 90) === 90);
  } else {
    check('readClampedInt 辅助函数存在', false);
  }
  check(
    '搜索匹配包含备注 notes 与自定义标签 tags',
    /searchQuery[\s\S]{0,500}\.notes[\s\S]{0,300}\.tags/.test(js)
  );
  check(
    '搜索框支持按 Escape 一键清空',
    /searchInput\.addEventListener\(['"]keydown['"][\s\S]{0,300}Escape/.test(js)
  );
  check(
    '筛选无结果时提供清除筛选恢复按钮',
    js.includes('btnResetFilter') && js.includes('js.clearFilterBtn')
  );

  // 5. 错误 Toast 保护期与卡片渲染指纹去重 & UID 复制 & 删除防误触
  console.log('[测试 5/6] 错误 Toast 保护期、渲染指纹、UID 复制与防误触');
  check(
    '无 detail 的错误/警告 Toast 保护期 >= 10000ms',
    /level\s*===\s*['"]error['"]\s*\|\|\s*msg\.level\s*===\s*['"]warn['"][\s\S]{0,80}10000/.test(js) ||
    /\(msg\.level\s*===\s*['"]error['"]\s*\|\|\s*msg\.level\s*===\s*['"]warn['"]\)\s*\?\s*10000/.test(js)
  );
  check(
    'accountGrid 支持指纹去重与滚动位置保护',
    js.includes('lastCardsFingerprint')
  );
  check(
    '支持点击卡片 UID 复制（事件委托不破坏 G7 DOM 字面量）',
    js.includes("closest('[data-field=\"uid\"]')") && js.includes('js.uidCopied')
  );
  check(
    '删除按钮具备独立 danger 视觉修饰类防误触',
    js.includes('is-danger-icon')
  );

  // 6. StatusBar QuickPick 展示他窗占用标识，且运行期 handleRefreshAccount 真实只同步目标账号
  console.log('[测试 6/6] QuickPick 他窗状态提示与单卡后端刷新实测');
  check(
    'StatusBar QuickPick 引入 getOtherLockedUids 标记他窗占用',
    statusBarTs.includes('getOtherLockedUids')
  );

  const mockVscode = {
    env: { appName: 'CodeBuddy CN', appRoot: '', sessionId: 's1', language: 'zh-cn', clipboard: { writeText: async () => {} }, openExternal: async () => true },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => ({ dispose: () => {} }) },
    window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined },
    commands: { executeCommand: async () => {} },
    Uri: { file: (p) => ({ fsPath: p }), joinPath: (b, ...s) => ({ fsPath: path.join(b?.fsPath || '', ...s) }), parse: (s) => ({ toString: () => s }) }
  };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'vscode') return mockVscode;
    return origLoad.apply(this, arguments);
  };
  try {
    const { SidebarProvider } = require(path.join(ROOT, 'out', 'sidebarProvider.js'));
    const syncedIds = [];
    const stubStore = {
      on: () => {},
      get: (id) => (id === 'a1' ? { id: 'a1', uid: 'u1', nickname: 'N1', email: '1@t.cn', accessToken: 'tok' } : undefined),
      getAll: () => [],
      getActive: () => undefined,
      getPrivacyMode: () => false,
      getAllTags: () => []
    };
    const stubCheckin = {
      syncAccountStatus: async (acc) => {
        syncedIds.push(acc.id);
        return { success: true };
      }
    };
    const sp = new SidebarProvider({ fsPath: ROOT }, stubStore, {}, stubCheckin, {}, {});
    const notified = [];
    sp.sendNotify = (level, message) => notified.push({ level, message });
    sp.postStateToWebview = () => {};
    if (typeof sp.handleRefreshAccount === 'function') {
      await sp.handleRefreshAccount('a1');
    }
    check('handleRefreshAccount 只同步单个目标账号 a1', syncedIds.length === 1 && syncedIds[0] === 'a1', JSON.stringify(syncedIds));
    check('handleRefreshAccount 完成后发出 success 通知', notified.some((n) => n.level === 'success'), JSON.stringify(notified));
  } finally {
    Module._load = origLoad;
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
