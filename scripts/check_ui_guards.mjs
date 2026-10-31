#!/usr/bin/env node
/**
 * BuddyRelay UI 门控检查（devloop 方法论：可机器验证的判据）
 * 用法: node scripts/check_ui_guards.mjs
 * 退出码: 0=全绿, 1=有失败
 * 打包前必须全绿；prepackage 钩子自动执行
 */
import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
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

// ── G7: 文案口径 — 已删除的冗余文本不得回流 (i18n 后活动来源走 zh 字典) ──
const zhDictPath = path.join(ROOT, 'src', 'i18n', 'zh.ts');
const zhDict = fs.existsSync(zhDictPath) ? fs.readFileSync(zhDictPath, 'utf8') : '';
gate('G7 文案: 无「每日自动发放」', !html.includes('每日自动发放'));
gate('G7 文案: 无「Buddy加油站活动签到获得」', !html.includes('Buddy加油站活动签到获得'));
gate('G7 文案: 无「账号 UID」标签', !html.includes('>账号 UID<'));
gate('G7 文案: 活动来源为「WorkBuddy加油站活动」(js.actReset 字典项)', zhDict.includes("'js.actReset': 'WorkBuddy加油站活动'") && html.includes("t('js.actReset')"));

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

// ── G16: 诚实透明执行结果面板 (i18n 后标题走 js.noGainTitle / js.failTitle) ──
gate('G16 诚实执行: 无收益明确提示任务进行中', html.includes("t('js.noGainTitle')") && zhDict.includes("'js.noGainTitle': '暂无新可领收益 (任务进行中)'"));
gate('G16 诚实执行: 失败任务异常标题与红图标', html.includes("t('js.failTitle')") && zhDict.includes("'js.failTitle': '任务执行遇到异常'"));

// ── G17: 网页内确认模态框（替代系统原生窗口） ──
gate('G17 确认模态框: #confirmOverlay DOM 存在', html.includes('id="confirmOverlay"'));
gate('G17 确认模态框: showConfirm 函数定义存在', html.includes('function showConfirm('));
gate('G17 确认模态框: onDelete 使用 showConfirm 确认', html.includes('await showConfirm('));

// ── G18: 全局悬浮 Toast 通知系统 ──
gate('G18 Toast 悬浮通知: fixed 定位与浮层层级存在', /\.toast-container\s*\{[^}]*position:\s*fixed !important[^}]*z-index:\s*99999 !important/.test(html));
gate('G18 Toast 悬浮通知: 卡片阴影与圆角存在', /\.toast\s*\{[^}]*border-radius:\s*var\(--radius-md[^}]*box-shadow:\s*0 4px 18px/.test(html));

// ── G19: 状态栏点数/卡片图标与数字无逗号 ──
const statusBarTs = fs.readFileSync(path.join(ROOT, 'src', 'statusBar.ts'), 'utf8');
gate('G19 状态栏: 使用点数/卡片图标 $(credit-card)', statusBarTs.includes('$(credit-card) Buddy:'));
gate('G19 状态栏: 彻底禁用 toLocaleString 千分位逗号', !statusBarTs.includes('toLocaleString'));

// ── G20: README 社区图链与合规门控 ──
const readmeMd = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
gate('G20 README: 彻底去除 Linux.do 宣传', !readmeMd.toLowerCase().includes('linux.do') && !readmeMd.includes('Linux.do'));
gate('G20 README: 社区图源指向官方 GitHub 仓库', readmeMd.includes('https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/qq-group-qrcode.webp') && readmeMd.includes('https://raw.githubusercontent.com/soulvon/BuddyRelay/main/resources/wechat-reward.webp'));

// ── G21: 版本一致性门控 ──
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
gate('G21 版本一致性: package.json 版本为 1.0.3', packageJson.version === '1.0.3');
gate('G21 版本一致性: README 徽标版本对齐 1.0.3', readmeMd.includes('version-1.0.3'));
gate('G21 版本一致性: README 安装说明版本对齐 1.0.3', readmeMd.includes('buddy-relay-1.0.3.vsix'));
gate('G21 互推五件套: 同系列作品区含 Antigravity-Kite', readmeMd.includes('Antigravity-Kite'));

// ── G22: 全局隐私模式贯通门控 (侧栏 / 状态栏 / QuickPick) ──
const accountStoreTs = fs.readFileSync(path.join(ROOT, 'src', 'accountStore.ts'), 'utf8');
const sidebarProviderTs = fs.readFileSync(path.join(ROOT, 'src', 'sidebarProvider.ts'), 'utf8');
gate('G22 隐私全贯通: accountStore 提供 getPrivacyMode 与 setPrivacyMode', accountStoreTs.includes('getPrivacyMode()') && accountStoreTs.includes('setPrivacyMode('));
gate('G22 隐私全贯通: sidebar.html 点击眼睛向后端广播 togglePrivacyMode', html.includes("vscode.postMessage({ command: 'togglePrivacyMode', enabled: privacyMode })"));
gate('G22 隐私全贯通: sidebarProvider 响应 togglePrivacyMode 消息', sidebarProviderTs.includes("case 'togglePrivacyMode':"));
gate('G22 隐私全贯通: 状态栏文本与 Tooltip 支持隐私脱敏', statusBarTs.includes('isPrivacy ? maskName(rawName) : rawName') && statusBarTs.includes('isPrivacy ? maskUid(active.uid) : active.uid'));
gate('G22 隐私全贯通: QuickPick 列表与快捷开关支持隐私模式', statusBarTs.includes('isPrivacy ? maskName(rawName) : rawName') && statusBarTs.includes('togglePrivacy'));

// ── G23: Git 仓库纯净与合规门控 ──
try {
  const trackedFiles = child_process.execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const forbiddenPatterns = [/\.vsix$/, /^docs\//, /^AGENTS\.md$/, /^CLAUDE\.md$/, /\.env/, /\.db$/, /^tmp\//, /^node_modules\//, /^out\//, /^dist\//];
  const leaked = trackedFiles.filter(f => forbiddenPatterns.some(p => p.test(f)));
  gate('G23 Git 纯净门控: 无敏感文件与冗余构建产物入库', leaked.length === 0, `违规跟踪文件: ${leaked.join(', ')}`);
} catch (_) {}

// ── G24: README 核心标语与配图门控 ──
gate(
  'G24 README 强调五大核心标语',
  readmeMd.includes('切号不关窗口') &&
  readmeMd.includes('不重启编辑器') &&
  readmeMd.includes('历史会话完全互通') &&
  readmeMd.includes('一键签到') &&
  readmeMd.includes('一键做任务')
);
gate(
  'G24 README 包含实机配图 (webp 压缩版)',
  readmeMd.includes('preview-dashboard.webp') &&
  readmeMd.includes('preview-import.webp') &&
  readmeMd.includes('preview-tasks.webp')
);

// ── G25: 账号启用/禁用门控 ──
gate('G25 账号启停: 卡片提供 onToggleStatus 按钮', html.includes("onToggleStatus('") && html.includes("window.onToggleStatus = function"));
gate('G25 账号启停: 启停控件为开关形态 (status-switch 开/关双色与滑块)', html.includes('status-switch ${isDisabled') && html.includes('.status-switch.is-on') && html.includes('.status-switch.is-off') && html.includes('status-switch-thumb'));
gate('G25 账号启停: 开关位于底栏最右端 (删除按钮之后)', html.indexOf('${statusToggleBtn}') > html.indexOf("t('js.removeTitle')"));
gate('G25 账号启停: 开关启用态为低饱和灰调绿 (color-mix 降饱和)', html.includes('color-mix(in srgb, var(--gh-green, #3fb950) 45%, #8b9a90)'));
gate('G25 账号启停: 禁用账号样式与标签存在', html.includes("grid-disabled-tag") && html.includes("is-disabled"));
gate('G25 账号启停: accountStore 提供 toggleStatus 方法', accountStoreTs.includes('toggleStatus('));

// ── G26: 偏好与规则设置模态框门控 ──
gate('G26 设置面板: 工具栏齿轮按钮存在', html.includes('id="btnSettings"'));
gate('G26 设置面板: 规则设置模态框 #settingsModalOverlay 存在', html.includes('id="settingsModalOverlay"'));
gate('G26 设置面板: 签到与切号表单控件完备', html.includes('id="setCheckinEnabled"') && html.includes('id="setAutoSwitchEnabled"') && html.includes('id="setQuotaThreshold"') && html.includes('id="setRefreshInterval"') && html.includes('id="setAutoSwitchOn429"'));
gate('G26 设置面板: 后端支持 saveSettings 指令', sidebarProviderTs.includes("case 'saveSettings':"));

// ── G27: Kite 智能匹配导入中枢门控 ──
gate('G27 智能导入: 文件选择导入按钮存在', html.includes('id="btnImportAccountsFile"'));
gate('G27 智能导入: 后端支持 importAccountsFile 对话框指令', sidebarProviderTs.includes("case 'importAccountsFile':"));
gate('G27 智能导入: 后端支持 JWT Payload 智能解码提取元数据', sidebarProviderTs.includes('parseJwtPayload('));
gate('G27 智能导入: 后端支持已有账号 Token 智能覆盖更新', sidebarProviderTs.includes('existing.accessToken = acc.accessToken') || sidebarProviderTs.includes('existing.lastUsed = Date.now()'));

// ── G28: 零 Emoji 违规扫描门控 ──
const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u;
const filesToAuditForEmoji = [
  'resources/webview/sidebar.html',
  'src/statusBar.ts',
  'src/sidebarProvider.ts',
  'src/accountStore.ts',
  'src/extension.ts'
];
let emojiFound = false;
let emojiHitInfo = '';
for (const rel of filesToAuditForEmoji) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) {
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split('\n');
    for (let li = 0; li < lines.length; li++) {
      if (emojiRegex.test(lines[li])) {
        emojiFound = true;
        emojiHitInfo = `${rel}:${li + 1}: ${lines[li].trim()}`;
        break;
      }
    }
    if (emojiFound) break;
  }
}
gate('G28 视觉规范: 彻底杜绝 Emoji，100% 采用专业 SVG/Codicon 图标', !emojiFound, emojiHitInfo);

// ── G29: 共享号池文件中枢 (多窗口同步) 门控 ──
gate('G29 号池中枢: AccountStore 使用共享 pool.json (与宿主指令同区)', accountStoreTs.includes('PATHS.POOL_FILE'));
gate('G29 号池中枢: fs.watch 目录监听跨窗口变更', accountStoreTs.includes('fs.watch(') && accountStoreTs.includes('reloadFromDisk'));
gate('G29 号池中枢: 串行写队列防并发丢数据', accountStoreTs.includes('_writeQueue') && accountStoreTs.includes('enqueueWrite'));
gate('G29 号池中枢: 禁止再向 globalState 写入账号池 (防 last-writer-wins)', !accountStoreTs.includes('globalState.update(STORAGE_KEY'));
gate('G29 号池中枢: 外部读失败保留内存现状不当空池', accountStoreTs.includes('保留内存现状'));

// ── G30: 切换回执闭环 (诚实执行) 门控 ──
const seamlessSwitcherTs = fs.readFileSync(path.join(ROOT, 'src', 'seamlessSwitcher.ts'), 'utf8');
const constantsTs = fs.readFileSync(path.join(ROOT, 'src', 'constants.ts'), 'utf8');
gate('G30 回执闭环: Patch v5 特征码与回执方法注入', constantsTs.includes('PATCH_V5') && constantsTs.includes('__byokReceipt') && constantsTs.includes('V5_MARKER'));
gate('G30 回执闭环: 宿主回执文件路径已定义', constantsTs.includes('BYOK_SWITCH_RESULT_FILE'));
gate('G30 回执闭环: 扩展轮询回执后才判定成功', seamlessSwitcherTs.includes('waitForSwitchReceipt'));
gate('G30 回执闭环: 指令携带 ts 防旧回执误读', seamlessSwitcherTs.includes('Number(data.ts) === Number(cmdTs)'));
gate('G30 回执闭环: v4 宿主降级如实标注 legacyHost', seamlessSwitcherTs.includes('legacyHost'));
gate('G30 回执闭环: 切号指令窗口内串行化', seamlessSwitcherTs.includes('_switchQueue'));

// ── G31: 跨窗口账号锁 门控 ──
const accountLockPath = path.join(ROOT, 'src', 'accountLock.ts');
const accountLockTs = fs.existsSync(accountLockPath) ? fs.readFileSync(accountLockPath, 'utf8') : '';
const extensionTs = fs.readFileSync(path.join(ROOT, 'src', 'extension.ts'), 'utf8');
const autoSwitcherTs = fs.readFileSync(path.join(ROOT, 'src', 'autoSwitcher.ts'), 'utf8');
gate('G31 账号锁: 心跳 + 过期清理 + pid 判活三件套', accountLockTs.includes('startHeartbeat') && accountLockTs.includes('cleanStaleLocks') && accountLockTs.includes('isPidAlive'));
gate('G31 账号锁: 释放只删自己 pid 的锁', accountLockTs.includes('entry.pid === process.pid'));
gate('G31 账号锁: 扩展挂载初始化与心跳，退出释放', extensionTs.includes('initAccountLock') && extensionTs.includes('startHeartbeat()') && extensionTs.includes('releaseLock()'));
gate('G31 账号锁: 自动切号候选排除他窗持有账号', autoSwitcherTs.includes('getOtherLockedUids'));
gate('G31 账号锁: 侧栏推送他窗占用列表', sidebarProviderTs.includes('lockedUids'));

// ── G32: 语法自检健壮性与现代 Node 扩展名规范门控 ──
gate('G32 语法自检: 临时写入文件以 .js 结尾防 ERR_UNKNOWN_FILE_EXTENSION', seamlessSwitcherTs.includes("tmp_${Date.now()}.js`"));
gate('G32 语法自检: validateSyntax 支持 ELECTRON_RUN_AS_NODE 降级', seamlessSwitcherTs.includes('ELECTRON_RUN_AS_NODE'));
gate('G32 语法自检: validateSyntax 返回错误信息对象', seamlessSwitcherTs.includes('checkRes.error'));

// ── G33: 卡片底栏尺寸固化与切换中状态安全门控 ──
gate('G33 按钮防截断: .grid-card-actions 强锁 nowrap 且禁止 overflow hidden 裁剪', html.includes('.grid-card-actions') && html.includes('white-space: nowrap !important') && !html.includes('.grid-card-actions {\n      display: flex !important;\n      align-items: center !important;\n      justify-content: space-between !important;\n      gap: 3px !important;\n      margin-top: 4px !important;\n      padding-top: 6px !important;\n      border-top: 1px solid var(--card-border) !important;\n      flex-wrap: nowrap !important;\n      white-space: nowrap !important;\n      height: 26px !important'));
gate('G33 按钮原色彩: .grid-switch-btn 继承 main.css 渐变且不设硬编码纯色与高度截断', html.includes('.grid-switch-btn') && html.includes('white-space: nowrap !important') && !html.includes('background: var(--ac-emerald, #10b981) !important;'));
gate('G33 切换提示: 切号成功一律发送 success 纯净通知杜绝误报红框', sidebarProviderTs.includes("this.sendNotify('success',") && !sidebarProviderTs.includes("res.message`"));
gate('G33 状态释放: switchingId 具备超时保护与 notify/updateState 自动重置', html.includes("switchingId = ''") && html.includes('_switchTimeout'));

// ── G34: 更新系统透明度与操作完备性门控 ──
const updaterTs = fs.readFileSync(path.join(ROOT, 'src', 'updater.ts'), 'utf8');
gate('G34 更新体系: updater 支持更新日志摘要提取 (formatChangelogSummary)', updaterTs.includes('formatChangelogSummary('));
gate('G34 更新体系: updater 支持查看完整日志与仅下载安装包', updaterTs.includes('showFullChangelog(') && updaterTs.includes('downloadOnly('));
gate('G34 更新体系: 设置面板提供手动检查更新入口与版本展示', html.includes('id="btnManualCheckUpdate"') && html.includes('id="currentVersionTag"'));
gate('G34 更新体系: 后端 sidebarProvider 响应 checkUpdate 指令', sidebarProviderTs.includes("case 'checkUpdate':"));

// ── G35: 开关隐形防复选框穿透泄露门控 ──
gate('G35 开关隐形: .as-switch input 绝对隐形杜绝复选框泄露', html.includes('.as-switch input[type="checkbox"]') && html.includes('display: none !important'));

// ── G36: 资产安全出口 (号池备份导出/Token复制/失效号重授) 门控 ──
gate('G36 资产出口: sidebarProvider 提供 handleExportAccounts (支持 full 与 masked 模式)', sidebarProviderTs.includes('handleExportAccounts(') && sidebarProviderTs.includes("mode: 'full' | 'masked'"));
gate('G36 资产出口: sidebar.html 提供备份导出模态框与按钮', html.includes('id="btnExportPool"') && html.includes('id="exportModalOverlay"'));
gate('G36 资产出口: sidebar.html 卡片提供失效号重新授权操作', html.includes('onReauth('))

// ── G37: 业务标签 (Tags) 与账号备注 (Notes) 门控 ──
gate('G37 标签备注: AccountStore 支持 updateNotes, updateTags 与 getAllTags', accountStoreTs.includes('updateNotes(') && accountStoreTs.includes('updateTags(') && accountStoreTs.includes('getAllTags('));
gate('G37 标签备注: sidebar.html 卡片展示标签与备注', html.includes('grid-card-tags') && html.includes('grid-card-notes'));
gate('G37 标签备注: sidebar.html 提供标签与备注编辑模态框', html.includes('id="editMetaModalOverlay"') && html.includes('onEditMeta('));
gate('G37 标签备注: 顶部标签栏动态合并自定义业务标签并支持筛选', html.includes('getEffectiveTagDefs(') && html.includes("activeTag.startsWith('custom:')"));

// ── G38: 自动切号候选探针预检与频率熔断保护 门控 ──
gate('G38 调度防线: autoSwitcher 提供候选账号轻量探针预检 (probeAccount)', autoSwitcherTs.includes('probeAccount('));
gate('G38 调度防线: autoSwitcher 提供智能预检挑选 (findAndVerifyNextAccount)', autoSwitcherTs.includes('findAndVerifyNextAccount('));
gate('G38 调度防线: autoSwitcher 内置频率熔断器 (checkCircuitBreaker)', autoSwitcherTs.includes('checkCircuitBreaker()') && autoSwitcherTs.includes('breakerTrippedUntil'));

// ── G39: 算力流水对账与调度审计引擎 (UsageTracker) 门控 ──
const usageTrackerPath = path.join(ROOT, 'src', 'usageTracker.ts');
const usageTrackerTs = fs.existsSync(usageTrackerPath) ? fs.readFileSync(usageTrackerPath, 'utf8') : '';
gate('G39 流水引擎: usageTracker.ts 存在且支持 Delta 快照差值对账', usageTrackerTs.includes('recordSnapshot(') && usageTrackerTs.includes('deltaCredits'));
gate('G39 流水引擎: usageTracker 提供今日经营总账 (getDailySummary) 与流水查询', usageTrackerTs.includes('getDailySummary(') && usageTrackerTs.includes('getRecentRecords('));

// ── G40: 侧栏【统计】抽屉面板与状态推流 门控 ──
gate('G40 流水面板: sidebar.html 包含统计折叠抽屉与列表容器', html.includes('id="usageDetails"') && html.includes('id="usageRecordsList"') && html.includes("{{i:ui.stats}}"));
gate('G40 流水面板: sidebar.html 包含新增与消耗双色汇总徽标', html.includes('id="usageAwardedBadge"') && html.includes('id="usageConsumedBadge"'));
gate('G40 流水面板: sidebarProvider 向 Webview 实时推送流水与总账数据', sidebarProviderTs.includes('usageSummary:') && sidebarProviderTs.includes('recentRecords:'));

// ── G41: 高质量字体体系与无衬线/等宽数字门控 ──
gate('G41 字体系统: 定义全局高质量无衬线体 (--font-sans)', html.includes('--font-sans:') && html.includes('body, button, input, select, textarea, .app'));
gate('G41 字体系统: 西文栈含 Segoe UI Variable 且中文优先 YaHei UI 紧凑变体 (纯系统字体零回退惊喜)', html.includes('"Segoe UI Variable Display"') && html.includes('"Microsoft YaHei UI"'));
gate('G41 字体系统: 定义现代优雅等宽字体 (--font-mono)', html.includes('--font-mono:') && html.includes('Cascadia Code'));
gate('G41 字体系统: 数值与大盘指标声明 tabular-nums 等宽对齐', html.includes('font-variant-numeric: tabular-nums !important') && html.includes('.summary-status-val'));
gate('G41 字体系统: 抽屉统计徽标采用无衬线胶囊药丸 .usage-badge-pill', html.includes('.usage-badge-pill') && html.includes('.usage-summary-badges'));

// ── G42: 包体瘦身与轻量化门控 ──
const vscodeIgnore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
gate('G42 包体瘦身: .vscodeignore 严格排除非运行时大图与二维码', vscodeIgnore.includes('resources/preview-*.png') && vscodeIgnore.includes('resources/qq-group-qrcode.png'));
gate('G42 包体瘦身: .vscodeignore 排除本地临时产物 tmp/ 严禁混入发布包', vscodeIgnore.includes('tmp/**'));

// ── G44: i18n 字典文案纪律 门控 (防止徽章类短文案被括号劣化) ──
const zhDictG44 = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'zh.ts'), 'utf8');
const enDictG44 = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'en.ts'), 'utf8');
gate('G44 i18n 纪律: 「当前」徽章回归纯文本 (禁全角括号劣化)', zhDictG44.includes("'js.currentSuffix': '当前'") && enDictG44.includes("'js.currentSuffix': 'Current'"));
gate('G44 i18n 纪律: chip 摘要用半角空格短后缀', zhDictG44.includes("'js.currentSuffixShort': ' (当前)'"));
gate('G44 i18n 纪律: 未解锁标签回归纯文本', zhDictG44.includes("'task.lockedSuffix': '未解锁'"));
gate('G44 i18n 纪律: 统计值保持半角括号格式', zhDictG44.includes("'ui.highQuotaVal': '{0} 个 (≥ 80%)'") && zhDictG44.includes("'ui.lowQuotaVal': '{0} 个 (≤ 30%)'"));

// ── G43: 算力总览口径与流水徽标语义 门控 ──
const mainCss = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'main.css'), 'utf8');
gate('G43 算力口径: 汇总分母包含基础体验包容量 (basePackage.total)', /a\.basePackage && a\.basePackage\.total/.test(html));
gate('G43 算力口径: 汇总排除已禁用账号 (status !== disabled)', html.includes("currentAccounts.filter(a => a.status !== 'disabled')"));
gate('G43 算力口径: 百分比带「剩」前缀明示剩余率语义', html.includes("t('js.pctRemaining', creditPct)") && zhDict.includes("'js.pctRemaining': '剩 {0}%'"));
gate('G43 算力口径: 汇总条具备风险色阶变体 (is-warn/is-danger)', mainCss.includes('.summary-bar-fill.is-warn') && mainCss.includes('.summary-bar-fill.is-danger'));
gate('G43 流水徽标: 具备新增与消耗语义文案', html.includes("t('js.gainedBadge', fmtNum") && html.includes("t('js.consumedBadge'"));
gate('G43 标点统一: 数值语境禁用全角括号混排 (杜绝双字体拼贴)', !html.includes('个（') && !html.includes('（≥') && !html.includes('（≤'));
gate('G43 模态框滚动: 全局 modal-box 三段式 flex (header固定/body内滚/footer常驻)', /\.modal-box \{[^}]*display: flex/.test(mainCss) && /\.modal-body \{[^}]*min-height: 0/.test(mainCss) && /\.modal-body \{[^}]*overflow-y: auto/.test(mainCss) && /\.modal-footer \{/.test(mainCss));
gate('G43 模态框滚动: 设置框操作区独立于滚动区 (modal-footer 在 body 外、overlay 内)', html.includes('<div class="modal-footer">') && html.indexOf('btnSettingsSave') > html.indexOf('class="modal-footer"') && html.indexOf('btnSettingsSave') < html.indexOf('全局 Toast 容器'));
gate('G43 字体去污: 统计数值无等宽字体残留 (main.css)', !/\.summary-status-val \{[^}]*editor-font-family/.test(mainCss) && !/\.summary-count \{[^}]*editor-font-family/.test(mainCss));
gate('G43 图标纪律: 清空流水按钮用 Lucide 官方 eraser 权威路径 (逐字节, 禁垃圾桶残留在该槽位)', /id="btnClearUsage"[\s\S]{0,400}M21 21H8a2 2 0 0 1-1\.42-\.587l-3\.994-3\.999/.test(html) && !/id="btnClearUsage"[\s\S]{0,400}polyline points="3 6 5 6 21 6"/.test(html));
gate('G43 药丽数字: 「N 个」胶囊 12px 加粗 + sans 等宽数字覆盖', /\.grid-count \{[^}]*font-size: 12px !important/.test(html) && /\.grid-count \{[^}]*font-family: var\(--font-sans\) !important/.test(html));
gate('G43 图标热区: 清空流水按钮吃全局 24px 规格 (禁内联缩小)', !/id="btnClearUsage"[^>]*width:20px/.test(html) && /id="btnClearUsage"[^>]*style="margin-left:4px;"/.test(html));

console.log('');
console.log(`门控结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
