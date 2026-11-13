/**
 * BuddyRelay Patch v5 锚点动态发现测试
 * 背景：宿主每次构建混淆类名漂移（AM -> HM），硬编码类名锚点必失效。
 * 健壮化设计（免维护目标）：
 *   - 必需锚点全部基于宿主语义命名（非混淆产物）：
 *     1) 会话服务类头（getV2ReconcileData 完整体 -> 语义签名正则兜底）构造函数注入 SESSION_HOOK
 *     2) restoreSession 语义签名正则（参数漂移免疫）挂载 WATCHER_METHODS
 *     3) AuthMainService 构造函数（instantiationService 语义字段）注入 startByokWatcher 启动
 *        —— restoreSession 前置 await ensureInitialized 为网络初始化，挂起时 watcher 永不启动
 *        （2026-11-02 事故实证），构造函数实例化必然执行
 *   - GV/GS 会话隔离放开为可选步骤：宿主改动实现体时跳过并显式标注，
 *     由 __byokApplySwitch 的会话迁移兜底（切换时全量改写 userId）
 *   - watcher 内置诊断黑匣子 byok-watcher.log（boot/watch/cmd-in/err 埋点）
 * 验证：新/旧类名、实现体漂移降级、签名漂移、boot 锚点缺失显式失败、真实 main.js 副本端到端、
 *        宿主升级覆盖 main.js 后不回写旧构建、首次安装、历史补丁结构升级、切换结果确认。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

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

/**
 * 合成宿主骨架（模拟真实双类结构与不同宿主版本形态）
 * @param {object} PATCH_V5 编译产物常量
 * @param {{cls?: string, gvBody?: string, restoreSig?: string, restoreCount?: number, bootless?: boolean}} opts
 */
function buildFakeHost(PATCH_V5, opts = {}) {
  const {
    cls = 'HM',
    gvBody = PATCH_V5.GV_OLD,          // 传自定义串模拟宿主改动实现体
    restoreSig = 'async restoreSession(){', // 可传带参数签名模拟签名漂移
    restoreCount = 1,                   // 传 2 模拟多类同名方法
    bootless = false                    // true 模拟 AuthMain 构造特征缺失
  } = opts;
  const restoreDef = `${restoreSig}try{await this.storageService.whenReady;return 1}catch(_){}}`;
  const restores = restoreCount === 1 ? restoreDef : restoreDef + `,Xx=class{${restoreDef}}`;
  const ctor = bootless
    ? `Am=class{constructor(e,i,s,n){this.logService=i,this.storageService=s}`
    : `Am=class{constructor(e,i,s,n){this.instantiationService=e,this.logService=i,this.storageService=s}`;
  // 类表达式闭合必须带分号（同行无换行时 ASI 不生效）
  return [
    'const boot=1;',
    `Zx=class{constructor(q){this.v=q}};`,
    // 会话服务类
    `${cls}=class{constructor(t,e,i){this._sessions=new Map();}`,
    'getV2Compat(){return 1}',
    gvBody,
    PATCH_V5.GS_OLD,
    '};',
    // AuthMainService 类（watcher 挂载点 + 构造启动锚点）
    ctor,
    'getStorageKey(){const e="tencent-cloud.coding-copilot",i=this.apiClient.storageKey;return`secret://${JSON.stringify({extensionId:e,key:i})}`}',
    'scheduleRefresh(e=0){const a=1}',
    restores,
    '};',
    'const after=2;'
  ].join('');
}

async function runTests() {
  console.log('=== 开始 BuddyRelay Patch v5 锚点动态发现测试 ===\n');

  const { SeamlessSwitcher } = require(path.join(ROOT, 'out', 'seamlessSwitcher.js'));
  const { PATCH_V5 } = require(path.join(ROOT, 'out', 'constants.js'));

  const sw = new SeamlessSwitcher();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-anchor-'));

  // ──────────────────────────────────────────────────────────
  // 1. 新版宿主（HM 类名）完整打补丁
  // ──────────────────────────────────────────────────────────
  console.log('[测试 1/9] 新版宿主（HM 类名）healPatch 完整注入');
  const f1 = path.join(tmpDir, 'main.js');
  fs.writeFileSync(f1, buildFakeHost(PATCH_V5), 'utf8');
  const r1 = sw.healPatch(f1);
  check('healPatch 成功', r1.success === true, `${r1.message} / ${r1.error || ''}`);
  check('message 无降级标注', !(r1.message || '').includes('可选锚点'), r1.message);
  const patched1 = fs.readFileSync(f1, 'utf8');
  check('会话钩子注入 HM 构造函数', patched1.includes(`HM=class{constructor(t,e,i){${PATCH_V5.SESSION_HOOK}`));
  check('V5 标记存在', patched1.includes(PATCH_V5.V5_MARKER));
  check('GV 隔离放开', patched1.includes(PATCH_V5.GV_NEW));
  check('GS 隔离放开', patched1.includes(PATCH_V5.GS_NEW));
  check('WATCHER_METHODS 挂载于 restoreSession 前', patched1.includes(`${PATCH_V5.WATCHER_METHODS}async restoreSession(`));
  check('watcher 启动注入构造函数首句', patched1.includes(`constructor(e,i,s,n){this.startByokWatcher();this.instantiationService=`));
  check('诊断黑匣子存在', patched1.includes('byok-watcher.log'));
  check('origin 备份创建', fs.existsSync(f1 + '.byok-origin'));
  check('重打路径 repatched=true', r1.repatched === true);
  const r1b = sw.healPatch(f1); // 已打补丁且语法正常：放行，非重打
  check('放行路径 repatched=false', r1b.success === true && r1b.repatched === false, `${r1b.message} / repatched=${r1b.repatched}`);

  // ──────────────────────────────────────────────────────────
  // 2. 旧版宿主（AM 类名）类名无关性
  // ──────────────────────────────────────────────────────────
  console.log('[测试 2/9] 旧版宿主（AM 类名）类名无关性');
  const f2 = path.join(tmpDir, 'main_am.js');
  fs.writeFileSync(f2, buildFakeHost(PATCH_V5, { cls: 'AM' }), 'utf8');
  const r2 = sw.healPatch(f2);
  check('旧类名 healPatch 成功', r2.success === true, `${r2.message} / ${r2.error || ''}`);
  check('会话钩子注入 AM 构造函数', fs.readFileSync(f2, 'utf8').includes(`AM=class{constructor(t,e,i){${PATCH_V5.SESSION_HOOK}`));

  // ──────────────────────────────────────────────────────────
  // 3. 锚点缺失显式失败（不静默兜底）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 3/9] 锚点缺失显式失败');
  const f3 = path.join(tmpDir, 'main_broken.js');
  fs.writeFileSync(f3, 'const a=1;' + PATCH_V5.GV_OLD, 'utf8');
  const r3 = sw.healPatch(f3);
  check('失败且错误码为 AM_ANCHOR_MISSING', r3.success === false && r3.error === 'AM_ANCHOR_MISSING', `${r3.message} / ${r3.error || ''}`);
  check('目标文件未被破坏', fs.readFileSync(f3, 'utf8') === 'const a=1;' + PATCH_V5.GV_OLD);

  // ──────────────────────────────────────────────────────────
  // 4. GV/GS 实现体漂移：可选降级 + 签名兜底定位
  // ──────────────────────────────────────────────────────────
  console.log('[测试 4/9] GV/GS 实现体漂移降级（签名兜底定位类头）');
  const f4 = path.join(tmpDir, 'main_drift.js');
  fs.writeFileSync(f4, buildFakeHost(PATCH_V5, {
    gvBody: 'getV2ReconcileData(t){return{enabled:!0,sessions:[]}}' // 宿主改动实现体，签名保留
  }), 'utf8');
  const r4 = sw.healPatch(f4);
  check('实现体漂移仍打补丁成功', r4.success === true, `${r4.message} / ${r4.error || ''}`);
  check('message 显式标注可选步骤跳过', (r4.message || '').includes('可选锚点'), r4.message);
  const patched4 = fs.readFileSync(f4, 'utf8');
  check('未误替换新实现体', !patched4.includes(PATCH_V5.GV_NEW));
  check('GS 仍正常放开', patched4.includes(PATCH_V5.GS_NEW));
  check('watcher 仍挂载并启动', patched4.includes(`${PATCH_V5.WATCHER_METHODS}async restoreSession(`) && patched4.includes('{this.startByokWatcher();this.instantiationService='));

  // ──────────────────────────────────────────────────────────
  // 5. restoreSession 签名漂移 + boot 锚点防线
  // ──────────────────────────────────────────────────────────
  console.log('[测试 5/9] restoreSession 签名漂移与 boot 锚点防线');
  const f5 = path.join(tmpDir, 'main_sig.js');
  fs.writeFileSync(f5, buildFakeHost(PATCH_V5, { restoreSig: 'async restoreSession(t){' }), 'utf8');
  const r5 = sw.healPatch(f5);
  check('带参数签名注入成功', r5.success === true, `${r5.message} / ${r5.error || ''}`);
  check('参数签名保留且不受启动注入影响', fs.readFileSync(f5, 'utf8').includes('async restoreSession(t){') && !fs.readFileSync(f5, 'utf8').includes('restoreSession(t){this.startByokWatcher'));

  const f5b = path.join(tmpDir, 'main_dup.js');
  fs.writeFileSync(f5b, buildFakeHost(PATCH_V5, { restoreCount: 2 }), 'utf8');
  const r5b = sw.healPatch(f5b);
  check('restoreSession 多匹配显式失败不误插', r5b.success === false && r5b.error === 'RESTORE_ANCHOR_MISSING', `${r5b.message} / ${r5b.error || ''}`);

  const f5c = path.join(tmpDir, 'main_bootless.js');
  fs.writeFileSync(f5c, buildFakeHost(PATCH_V5, { bootless: true }), 'utf8');
  const r5c = sw.healPatch(f5c);
  check('boot 锚点缺失显式失败', r5c.success === false && r5c.error === 'WATCHER_BOOT_ANCHOR_MISSING', `${r5c.message} / ${r5c.error || ''}`);

  // ──────────────────────────────────────────────────────────
  // 5c. 链路自检 runDoctor（watcher 活性判定：日志 mtime vs main.js mtime）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 5c] 链路自检 runDoctor');
  // 用例 A：副本已打补丁，无诊断日志 → needs_full_restart
  const fD1 = path.join(tmpDir, 'main_doctor_a.js');
  fs.writeFileSync(fD1, buildFakeHost(PATCH_V5), 'utf8');
  sw.healPatch(fD1);
  const dA = sw.runDoctor(fD1);
  check('补丁在但无 watcher 日志 → needs_full_restart', dA.status === 'needs_full_restart', `${dA.status} / ${dA.message}`);

  // 用例 B：诊断日志 mtime 晚于 main.js → healthy
  const logPath = path.join(path.dirname(fD1), 'byok-watcher.log');
  fs.utimesSync(fD1, new Date(Date.now() - 10000), new Date(Date.now() - 10000)); // main.js mtime 拨早
  fs.writeFileSync(logPath, `${Date.now()} boot\n`);
  const dB = sw.runDoctor(fD1, logPath);
  check('watcher 日志晚于补丁 → healthy', dB.status === 'healthy', `${dB.status} / ${dB.message}`);

  // 用例 C：未打补丁副本 → 自动重打 → repaired_needs_full_restart
  const fD2 = path.join(tmpDir, 'main_doctor_b.js');
  fs.writeFileSync(fD2, buildFakeHost(PATCH_V5), 'utf8');
  const dC = sw.runDoctor(fD2);
  check('补丁缺失 → 自动重打并引导重启', dC.status === 'repaired_needs_full_restart', `${dC.status} / ${dC.message}`);
  check('重打后文件含 R3 标记', fs.readFileSync(fD2, 'utf8').includes(PATCH_V5.V5_MARKER));

  // 用例 D：活性判定抽出后单独校验（切号主链路复用同一实现）
  const waMain = path.join(tmpDir, 'wa_main.js');
  const waLog = path.join(tmpDir, 'wa_watcher.log');
  fs.writeFileSync(waMain, 'const a=1;', 'utf8');
  check('无诊断日志 → watcher 未运行', sw.isWatcherAlive(waMain, waLog) === false);
  fs.writeFileSync(waLog, `${Date.now()} boot\n`, 'utf8');
  fs.utimesSync(waLog, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  check('日志早于 main.js → watcher 未运行', sw.isWatcherAlive(waMain, waLog) === false);
  fs.utimesSync(waMain, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  check('日志晚于 main.js → watcher 运行中', sw.isWatcherAlive(waMain, waLog) === true);

  // ──────────────────────────────────────────────────────────
  // 6. 真实宿主 main.js 副本端到端（存在才跑）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 6/9] 真实宿主 main.js 副本端到端');
  const REAL_MAIN = 'E:\\Program\\CodeBuddy CN\\resources\\app\\out\\main.js';
  if (fs.existsSync(REAL_MAIN)) {
    const f6 = path.join(tmpDir, 'real-main.js');
    // 优先用安装目录的 .byok-origin 干净原版：磁盘 main.js 可能已是旧结构补丁，
    // 直接拷补丁文件当源码会让 healPatch 二次注入。真实用户环境 healPatch 也是从干净 origin 重打。
    const cleanSource = fs.existsSync(`${REAL_MAIN}.byok-origin`) ? `${REAL_MAIN}.byok-origin` : REAL_MAIN;
    fs.copyFileSync(cleanSource, f6);
    const before = sw.checkPatch(f6);
    check('checkPatch 动态锚点识别有效', before.anchorsValid === true && before.details && before.details.amCount === 1,
      JSON.stringify(before.details || {}));
    const r6 = sw.healPatch(f6);
    check('真实 main.js healPatch 成功', r6.success === true, `${r6.message} / ${r6.error || ''}`);
    const patched6 = fs.readFileSync(f6, 'utf8');
    check('真实 main.js 会话钩子已注入', patched6.includes(PATCH_V5.SESSION_HOOK));
    check('真实 main.js watcher 挂载于 restoreSession 前', patched6.includes(`${PATCH_V5.WATCHER_METHODS}async restoreSession(`));
    check('真实 main.js watcher 构造启动注入', /constructor\([^)]*\)\{this\.startByokWatcher\(\);this\.instantiationService=/.test(patched6));
    check('真实 main.js V5 标记存在', patched6.includes(PATCH_V5.V5_MARKER));
  } else {
    console.log('  SKIP  真实宿主 main.js 不存在（非 CodeBuddy CN 机器），跳过端到端用例');
  }

  // ──────────────────────────────────────────────────────────
  // 7. 宿主升级覆盖 main.js：旧 .byok-origin 不得成为重打基准
  //    合成骨架即可运行，不依赖本机装了 CodeBuddy（新环境 / 全新用户）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 7/9] 宿主升级覆盖后按当前构建重打补丁');
  const OLD_TAG = '/*__HOST_BUILD_OLD__*/';
  const NEW_TAG = '/*__HOST_BUILD_NEW__*/';
  const oldClean = buildFakeHost(PATCH_V5) + '\n' + OLD_TAG;
  const newClean = buildFakeHost(PATCH_V5) + '\n' + NEW_TAG;

  // 7a 全新用户首次安装：无 origin，备份必须等于当前宿主源码
  const f7a = path.join(tmpDir, 'main_fresh.js');
  fs.writeFileSync(f7a, newClean, 'utf8');
  const r7a = sw.healPatch(f7a);
  check('首次安装打补丁成功', r7a.success === true && r7a.repatched === true, `${r7a.message} / ${r7a.error || ''}`);
  check('首次安装备份为当前干净源码', fs.readFileSync(f7a + '.byok-origin', 'utf8') === newClean);

  // 7b 升级器覆盖 main.js 但保留旧 origin：必须以新构建为准，不能写回旧版
  const f7b = path.join(tmpDir, 'main_upgraded.js');
  fs.writeFileSync(f7b, oldClean, 'utf8');
  sw.healPatch(f7b);                        // 旧构建曾打过补丁，留下旧 origin
  fs.writeFileSync(f7b, newClean, 'utf8');  // 升级覆盖为干净的新构建
  const r7b = sw.healPatch(f7b);
  check('升级后重打成功', r7b.success === true && r7b.repatched === true, `${r7b.message} / ${r7b.error || ''}`);
  const patched7b = fs.readFileSync(f7b, 'utf8');
  check('升级后保留新构建内容', patched7b.includes(NEW_TAG));
  check('升级后不回写旧构建内容', !patched7b.includes(OLD_TAG));
  check('升级后补丁结构完整', patched7b.includes(PATCH_V5.V5_MARKER) && patched7b.includes('this.startByokWatcher();'));
  check('升级后 origin 已刷新为新构建', fs.readFileSync(f7b + '.byok-origin', 'utf8') === newClean);

  // 7c 新构建锚点漂移：必须按新构建显式失败，不能拿旧 origin 糊弄成功
  const f7c = path.join(tmpDir, 'main_upgraded_drift.js');
  fs.writeFileSync(f7c, oldClean, 'utf8');
  sw.healPatch(f7c);
  const driftClean = buildFakeHost(PATCH_V5, { bootless: true }) + '\n' + NEW_TAG;
  fs.writeFileSync(f7c, driftClean, 'utf8');
  const r7c = sw.healPatch(f7c);
  check('新构建锚点缺失显式失败', r7c.success === false && r7c.error === 'WATCHER_BOOT_ANCHOR_MISSING', `${r7c.message} / ${r7c.error || ''}`);
  check('失败时新构建文件未被旧版覆盖', fs.readFileSync(f7c, 'utf8') === driftClean);

  // 7d 历史标记且无干净备份：还原当前 main.js 后重打，不叠加第二份结构
  const f7d = path.join(tmpDir, 'main_no_origin.js');
  fs.writeFileSync(f7d, oldClean, 'utf8');
  sw.healPatch(f7d);
  const legacyPatched = fs.readFileSync(f7d, 'utf8').replace(PATCH_V5.V5_MARKER, '/*__BYOK_V5_R3__*/');
  fs.writeFileSync(f7d, legacyPatched, 'utf8');
  fs.unlinkSync(f7d + '.byok-origin');
  const r7d = sw.healPatch(f7d);
  check('历史标记且无备份时自动还原重打', r7d.success === true && r7d.repatched === true, `${r7d.message} / ${r7d.error || ''}`);
  const patched7d = fs.readFileSync(f7d, 'utf8');
  check('还原后仅保留一份当前补丁结构', patched7d.includes(PATCH_V5.V5_MARKER) && (patched7d.match(/__byokApplySwitch/g) || []).length === 2);
  check('还原后备份为干净源码', fs.existsSync(f7d + '.byok-origin') && !fs.readFileSync(f7d + '.byok-origin', 'utf8').includes('__byokApplySwitch'));

  // 7e 多份安装 / 自定义目录：优先锁定当前运行宿主，不靠固定候选列表碰运气
  const fakeAppRoot = path.join(tmpDir, 'running-app');
  fs.mkdirSync(path.join(fakeAppRoot, 'out'), { recursive: true });
  const runningMain = path.join(fakeAppRoot, 'out', 'main.js');
  fs.writeFileSync(runningMain, newClean, 'utf8');
  const sw7e = new SeamlessSwitcher({ appRoot: fakeAppRoot });
  check('appRoot 优先定位当前运行宿主', sw7e.locateMainJs() === runningMain, String(sw7e.locateMainJs()));

  // ──────────────────────────────────────────────────────────
  // 8. 历史补丁结构：v4/R3 两种注入形态都能还原为干净源码再升级
  // ──────────────────────────────────────────────────────────
  console.log('[测试 8/9] 历史补丁结构升级与干净源码还原');
  const LEGACY_METHODS = '__byokLog(m){try{}catch(_){}}__byokApplySwitch(s){return s}startByokWatcher(){if(this.__byokStarted)return;this.__byokStarted=1}';
  function buildLegacyHost(flavor) {
    let out = buildFakeHost(PATCH_V5)
      .replace('HM=class{constructor(t,e,i){', 'HM=class{constructor(t,e,i){globalThis.__cbSession=this;');
    if (flavor === 'v4') {
      out = out
        .replace('scheduleRefresh(e=0){', LEGACY_METHODS + 'scheduleRefresh(e=0){')
        .replace('async restoreSession(){', 'async restoreSession(){this.startByokWatcher();');
    } else {
      out = out
        .replace('async restoreSession(){', '/*__BYOK_V5_R3__*/' + LEGACY_METHODS + 'async restoreSession(){')
        .replace('constructor(e,i,s,n){this.instantiationService=', 'constructor(e,i,s,n){this.startByokWatcher();this.instantiationService=');
    }
    return out;
  }
  function assertUpgraded(title, f, r) {
    check(`${title}: 升级成功`, r.success === true && r.repatched === true, `${r.message} / ${r.error || ''}`);
    const patched = fs.readFileSync(f, 'utf8');
    check(`${title}: 历史注入块已还原`, !patched.includes(LEGACY_METHODS));
    check(`${title}: 当前补丁结构唯一`, patched.includes(PATCH_V5.V5_MARKER) && (patched.match(/__byokApplySwitch/g) || []).length === 2);
    const originFile = f + '.byok-origin';
    check(`${title}: 干净备份已重建`, fs.existsSync(originFile) && !fs.readFileSync(originFile, 'utf8').includes('__byokApplySwitch'));
  }

  const f8a = path.join(tmpDir, 'main_v4.js');
  fs.writeFileSync(f8a, buildLegacyHost('v4'), 'utf8');
  assertUpgraded('v4 结构', f8a, sw.healPatch(f8a));

  const f8b = path.join(tmpDir, 'main_r3.js');
  const r3Legacy = buildLegacyHost('r3');
  fs.writeFileSync(f8b, r3Legacy, 'utf8');
  fs.writeFileSync(f8b + '.byok-origin', r3Legacy, 'utf8');
  assertUpgraded('R3 且备份带历史结构', f8b, sw.healPatch(f8b));

  // ──────────────────────────────────────────────────────────
  // 9. 切换结果：只有账号一致且宿主明确确认才算完成
  //    通过临时改写 PATHS 指向 tmp，完全不接触真实用户目录
  // ──────────────────────────────────────────────────────────
  console.log('[测试 9/9] 切换结果需宿主确认');
  const { PATHS } = require(path.join(ROOT, 'out', 'constants.js'));
  const savedCmd = PATHS.BYOK_SWITCH_FILE;
  const savedResult = PATHS.BYOK_SWITCH_RESULT_FILE;
  async function receiptCase(name, setup, expectedUid = 'u1') {
    const dir = path.join(tmpDir, 'receipt_' + name);
    fs.mkdirSync(dir, { recursive: true });
    const cmdFile = path.join(dir, 'byok-switch.json');
    const receiptFile = path.join(dir, 'byok-switch-result.json');
    PATHS.BYOK_SWITCH_FILE = cmdFile;
    PATHS.BYOK_SWITCH_RESULT_FILE = receiptFile;
    setup(cmdFile, receiptFile);
    try {
      return await sw.waitForSwitchReceipt(12345, 60, expectedUid);
    } finally {
      PATHS.BYOK_SWITCH_FILE = savedCmd;
      PATHS.BYOK_SWITCH_RESULT_FILE = savedResult;
    }
  }

  const r9a = await receiptCase('consumed', () => {});
  check('指令已消费但无确认时不宣告完成', r9a.ok === false && r9a.legacyHost === true, JSON.stringify(r9a));
  const r9b = await receiptCase('uid_mismatch', (_c, rf) => fs.writeFileSync(rf, JSON.stringify({ ok: true, uid: 'u2', ts: 12345 }), 'utf8'));
  check('回执账号与目标不一致时不宣告完成', r9b.ok === false, JSON.stringify(r9b));
  const r9c = await receiptCase('uid_match', (c, rf) => {
    fs.writeFileSync(c, '{}', 'utf8');
    fs.writeFileSync(rf, JSON.stringify({ ok: true, uid: 'u1', ts: 12345 }), 'utf8');
  });
  check('账号一致回执确认完成', r9c.ok === true && r9c.verified === true, JSON.stringify(r9c));
  const r9d = await receiptCase('host_fail', (c, rf) => {
    fs.writeFileSync(c, '{}', 'utf8');
    fs.writeFileSync(rf, JSON.stringify({ ok: false, uid: 'u1', ts: 12345, err: 'store_fail' }), 'utf8');
  });
  check('宿主明确失败时判失败', r9d.ok === false && r9d.verified === true, JSON.stringify(r9d));
  const r9e = await receiptCase('not_consumed', (c) => {
    fs.writeFileSync(c, JSON.stringify({ ts: 12345, session: {} }), 'utf8');
  });
  check('指令原样未动 → 标记 notConsumed', r9e.notConsumed === true && r9e.legacyHost === false, JSON.stringify(r9e));

  // ──────────────────────────────────────────────────────────
  // 10. 端到端回归（#1/#2）：补丁已就位但 watcher 未运行 → 必须判需完全重启
  //     旧实现落到 sw.noReceipt 普通失败；新实现转 needsFullRestart 并保留指令
  // ──────────────────────────────────────────────────────────
  console.log('[测试 10] watcher 未运行时切号必须判需重启');
  const e2eDir = path.join(tmpDir, 'e2e');
  const fakeRoot = path.join(e2eDir, 'app');
  fs.mkdirSync(path.join(fakeRoot, 'out'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'out', 'main.js'), buildFakeHost(PATCH_V5), 'utf8');

  const savedPaths = {
    EXTENSION_DATA_DIR: PATHS.EXTENSION_DATA_DIR,
    CODEBUDDY_APPDATA_DIR: PATHS.CODEBUDDY_APPDATA_DIR,
    BYOK_SWITCH_FILE: PATHS.BYOK_SWITCH_FILE,
    BYOK_SWITCH_RESULT_FILE: PATHS.BYOK_SWITCH_RESULT_FILE,
    SESSION_MASTER_FILE: PATHS.SESSION_MASTER_FILE,
    SESSION_HEAL_LOG: PATHS.SESSION_HEAL_LOG
  };
  PATHS.EXTENSION_DATA_DIR = path.join(e2eDir, 'ext-data');
  PATHS.CODEBUDDY_APPDATA_DIR = path.join(e2eDir, 'appdata');
  PATHS.BYOK_SWITCH_FILE = path.join(e2eDir, 'byok-switch.json');
  PATHS.BYOK_SWITCH_RESULT_FILE = path.join(e2eDir, 'byok-switch-result.json');
  PATHS.SESSION_MASTER_FILE = path.join(e2eDir, 'session-master.json');
  PATHS.SESSION_HEAL_LOG = path.join(e2eDir, 'session-heal.log');
  fs.mkdirSync(PATHS.EXTENSION_DATA_DIR, { recursive: true });
  fs.mkdirSync(PATHS.CODEBUDDY_APPDATA_DIR, { recursive: true });

  try {
    const swE2e = new SeamlessSwitcher({ appRoot: fakeRoot });
    const firstPatch = swE2e.healPatch();
    check(
      '端到端前置: 首次打补丁 repatched=true',
      firstPatch.success === true && firstPatch.repatched === true,
      `${firstPatch.message} / ${firstPatch.error || ''}`
    );

    // 无 byok-watcher.log：运行中的宿主没加载 watcher；指令写入后无人消费
    const r10 = await swE2e.switchAccount({
      id: 'e2e', uid: 'u-e2e', nickname: 'e2e', email: 'e2e@local', accessToken: 'tok-e2e'
    });
    check(
      'watcher 未运行时判需完全重启',
      r10.needsFullRestart === true && r10.error === 'NEEDS_FULL_RESTART',
      `${r10.message} / ${r10.error || ''}`
    );
    check('回执标记指令未被消费', Boolean(r10.receipt && r10.receipt.notConsumed === true), JSON.stringify(r10.receipt || {}));
    check('指令仍留在磁盘等待重启后消费', fs.existsSync(PATHS.BYOK_SWITCH_FILE));
  } finally {
    Object.assign(PATHS, savedPaths);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败明细:');
    for (const f of failures) {
      console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
    }
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
