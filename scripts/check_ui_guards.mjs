#!/usr/bin/env node
/**
 * BuddyRelay UI 门控检查（devloop 方法论：可机器验证的判据）
 * 用法: node scripts/check_ui_guards.mjs
 * 退出码: 0=全绿, 1=有失败
 * 打包前必须全绿；prepackage 钩子自动执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDEBAR = path.join(ROOT, 'resources', 'webview', 'sidebar.html');

let failed = 0;
let passed = 0;

function gate(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const html = fs.readFileSync(SIDEBAR, 'utf8');

// ── G1: 图标纪律 — 动作按钮文本禁止 Emoji ──
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const buttonSegs = [...html.matchAll(/<button[^>]*class="(?:btn-outline|btn-primary|primary|add-account-btn|grid-switch-btn)"[^>]*>([\s\S]*?)<\/button>/g)];
const emojiHits = [];
for (const seg of buttonSegs) {
  const text = seg[1].replace(/<svg[\s\S]*?<\/svg>/g, '');
  const m = text.match(emojiRe);
  if (m) emojiHits.push(m[0]);
}
gate('G1 图标纪律: 动作按钮无 Emoji', emojiHits.length === 0, emojiHits.join(' '));

// ── G2: 搜索框 hover/focus 透明覆盖（权重须含 :hover 变体） ──
gate(
  'G2 搜索框悬浮灰底: 覆盖规则含 :hover/:focus 变体',
  /\.app \.search-bar \.search-input:hover[\s\S]{0,200}background:\s*transparent !important/.test(html),
  '缺少 .app .search-bar .search-input:hover 透明覆盖'
);

// ── G3: 眼睛图标 = Kite 生产验证版路径（逐字节特征匹配） ──
const KITE_EYE = 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z';
const KITE_EYE_OFF = 'M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a20.29 20.29 0 0 1 5.06-5.94';
gate('G3 眼睛图标: eye 为 Kite 生产路径', html.includes(KITE_EYE));
gate('G3 眼睛图标: eye-off 为 Kite 生产路径', html.includes(KITE_EYE_OFF));
gate('G3 眼睛图标: 无自造 Lucide 残留', !html.includes('M2.062 12.348') && !html.includes('M10.733 5.076'));
const eyeSvgMatch = html.match(/<svg class="privacy-eye"[\s\S]*?<\/svg>/);
const eyeSvg = eyeSvgMatch ? eyeSvgMatch[0] : '';
gate('G3 眼睛图标: 瞳孔坐标 cy=12（privacy-eye 块内）', eyeSvg.includes('cy="12"') && !eyeSvg.includes('cy="7"'));

// ── G4: TDZ 门控 — 事件绑定必须在 const 声明之后 ──
const controls = ['btnTaskRefresh', 'btnGrowthTasks', 'taskModalOverlay', 'btnBatchCheckin', 'privacyModeBtn'];
for (const c of controls) {
  const declPos = html.indexOf(`const ${c} =`);
  const bindPos = html.indexOf(`${c}.addEventListener`);
  if (bindPos === -1) {
    gate(`G4 TDZ: ${c} 无绑定(允许)`, true);
    continue;
  }
  gate(
    `G4 TDZ: ${c} 声明先于绑定`,
    declPos !== -1 && declPos < bindPos,
    `decl@${declPos} bind@${bindPos}`
  );
}

// ── G5: 数字格式 — 禁用 toLocaleString 千分位 ──
gate('G5 数字格式: fmtNum 无千分位分组', !html.includes('toLocaleString'));

// ── G6: 任务模态框骨架屏占位 ──
gate(
  'G6 骨架屏: 任务列表有加载占位',
  /task-list-skeleton|skeleton/i.test(html) && /taskList/.test(html),
  'taskList 容器缺骨架屏占位'
);

// ── G7: 文案口径 — 已删除的冗余文本不得回流 ──
gate('G7 文案: 无「每日自动发放」', !html.includes('每日自动发放'));
gate('G7 文案: 无「Buddy加油站活动签到获得」', !html.includes('Buddy加油站活动签到获得'));
gate('G7 文案: 无「账号 UID」标签', !html.includes('>账号 UID<'));
gate('G7 文案: 活动来源为「WorkBuddy加油站活动」', html.includes('WorkBuddy加油站活动'));

// ── G8: 总量积分中性色 ──
gate('G8 配色: 总量积分为 is-neutral 灰黑', html.includes('grid-quota-val is-neutral'));
gate('G8 配色: is-neutral 使用主题前景色', /\.grid-quota-val\.is-neutral\s*{[^}]*var\(--vscode-foreground/.test(html));

// ── G8.5: 任务模态框账号批量选择（防回归丢失） ──
gate('G8.5 批量选择: 账号芯片容器存在', html.includes('id="taskAcctList"') && html.includes('acct-chip'));
gate('G8.5 批量选择: 全选开关存在', html.includes('id="taskSelAll"'));
gate('G8.5 批量选择: 执行指令携带 accountIds', html.includes("accountIds: Array.from(selectedAccountIds)"));
gate('G8.5 批量选择: 进度推流通道存在', html.includes("msg.command === 'taskProgress'"));

// ── G9: 弹窗动作按钮右对齐（margin-left:auto，不依赖父容器 flex） ──
gate('G9 对齐: 模态框动作按钮 margin-left:auto 右对齐', /\.add-area \.primary\s*{[^}]*margin-left:\s*auto/.test(html));

// ── G12: 模态框 hidden 属性强行防穿透 ──
gate('G12 hidden 防穿透: #taskModalOverlay[hidden] 显式声明 display: none !important', html.includes('#taskModalOverlay[hidden]') && /#taskModalOverlay\[hidden\][\s\S]*?display:\s*none !important/.test(html));
gate('G12 hidden 防穿透: 模态框 flex 必须带 :not([hidden]) 限定', html.includes('#taskModalOverlay.modal-overlay:not([hidden])'));

// ── G13: 全屏模态框实心底色与毛玻璃清除 ──
gate('G13 全屏模态框: 禁用 backdrop-filter 避免毛玻璃透底', html.includes('backdrop-filter: none !important'));
gate('G13 全屏模态框: 无非法 var(--bg) 变量', !html.includes('var(--bg)'));

// ── G14: 纯扁平复选框规格（杜绝立体感、厚边框与原生削顶） ──
gate('G14 扁平复选框: 禁用原生 appearance', /input\[type="checkbox"\]\s*\{[^}]*-webkit-appearance:\s*none !important/.test(html));
gate('G14 扁平复选框: 1px纯平实线与box-shadow清除', /input\[type="checkbox"\]\s*\{[^}]*border:\s*1px solid/.test(html) && /box-shadow:\s*none !important/.test(html));

// ── G15: 任务中心与选中账号双向同步 ──
gate('G15 账号联动: viewingAccountId 状态存在', html.includes('let viewingAccountId = null'));
gate('G15 账号联动: 单选切号自动请求任务', html.includes("vscode.postMessage({ command: 'taskList', accountId: id })"));
gate('G15 账号联动: 任务推流携带目标账号', html.includes("viewingAccountId = msg.data.accountId"));

// ── G16: 诚实透明执行结果面板 ──
gate('G16 诚实执行: 无收益明确提示任务进行中', html.includes('暂无新可领收益 (任务进行中)'));
gate('G16 诚实执行: 失败任务异常标题与红图标', html.includes('任务执行遇到异常'));

// ── G17: 网页内确认模态框（替代系统原生窗口） ──
gate('G17 确认模态框: #confirmOverlay DOM 存在', html.includes('id="confirmOverlay"'));
gate('G17 确认模态框: showConfirm 函数定义存在', html.includes('function showConfirm('));
gate('G17 确认模态框: onDelete 使用 showConfirm 确认', html.includes('await showConfirm('));

// ── G18: 全局悬浮 Toast 通知系统 ──
gate('G18 Toast 悬浮通知: fixed 定位与浮层层级存在', /\.toast-container\s*\{[^}]*position:\s*fixed !important[^}]*z-index:\s*99999 !important/.test(html));
gate('G18 Toast 悬浮通知: 卡片阴影与圆角存在', /\.toast\s*\{[^}]*border-radius:\s*var\(--radius-md[^}]*box-shadow:\s*0 4px 18px/.test(html));

// ── G19: 状态栏金币图标与数字无逗号 ──
const statusBarTs = fs.readFileSync(path.join(ROOT, 'src', 'statusBar.ts'), 'utf8');
gate('G19 状态栏: 使用金币图标 🪙', statusBarTs.includes('🪙 Buddy:'));
gate('G19 状态栏: 彻底禁用 toLocaleString 千分位逗号', !statusBarTs.includes('toLocaleString'));

// ── G20: README 社区图链与合规门控 ──
const readmeMd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
gate('G20 README: 彻底去除 Linux.do 宣传', !readmeMd.toLowerCase().includes('linux.do') && !readmeMd.includes('Linux.do'));
gate('G20 README: 社区图链采用高可用 CDN 且非 404 死链', readmeMd.includes('https://cdn.jsdelivr.net/') && !readmeMd.includes('raw/HEAD'));

console.log('');
console.log(`门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
