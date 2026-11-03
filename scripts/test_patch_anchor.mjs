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
 * 验证：新/旧类名、实现体漂移降级、签名漂移、boot 锚点缺失显式失败、真实 main.js 副本端到端。
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
  console.log('[测试 1/6] 新版宿主（HM 类名）healPatch 完整注入');
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
  console.log('[测试 2/6] 旧版宿主（AM 类名）类名无关性');
  const f2 = path.join(tmpDir, 'main_am.js');
  fs.writeFileSync(f2, buildFakeHost(PATCH_V5, { cls: 'AM' }), 'utf8');
  const r2 = sw.healPatch(f2);
  check('旧类名 healPatch 成功', r2.success === true, `${r2.message} / ${r2.error || ''}`);
  check('会话钩子注入 AM 构造函数', fs.readFileSync(f2, 'utf8').includes(`AM=class{constructor(t,e,i){${PATCH_V5.SESSION_HOOK}`));

  // ──────────────────────────────────────────────────────────
  // 3. 锚点缺失显式失败（不静默兜底）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 3/6] 锚点缺失显式失败');
  const f3 = path.join(tmpDir, 'main_broken.js');
  fs.writeFileSync(f3, 'const a=1;' + PATCH_V5.GV_OLD, 'utf8');
  const r3 = sw.healPatch(f3);
  check('失败且错误码为 AM_ANCHOR_MISSING', r3.success === false && r3.error === 'AM_ANCHOR_MISSING', `${r3.message} / ${r3.error || ''}`);
  check('目标文件未被破坏', fs.readFileSync(f3, 'utf8') === 'const a=1;' + PATCH_V5.GV_OLD);

  // ──────────────────────────────────────────────────────────
  // 4. GV/GS 实现体漂移：可选降级 + 签名兜底定位
  // ──────────────────────────────────────────────────────────
  console.log('[测试 4/6] GV/GS 实现体漂移降级（签名兜底定位类头）');
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
  console.log('[测试 5/6] restoreSession 签名漂移与 boot 锚点防线');
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

  // ──────────────────────────────────────────────────────────
  // 6. 真实宿主 main.js 副本端到端（存在才跑）
  // ──────────────────────────────────────────────────────────
  console.log('[测试 6/6] 真实宿主 main.js 副本端到端');
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
