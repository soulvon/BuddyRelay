/**
 * 多窗口同步行为测试（跨窗口号池中枢 + 账号锁）
 * 直接加载编译产物 out/，双实例模拟两个窗口共享同一 pool.json
 * 在 v0.2 旧实现（globalState 无 watch）上此脚本必然失败
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// 锁文件测试覆盖：必须在 require 模块前设置（模块加载时求值）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-sync-'));
const lockFile = path.join(tmpRoot, 'account-locks.json');
process.env.BUDDYRELAY_LOCK_FILE = lockFile;

let passed = 0;
let failed = 0;
function gate(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(interval);
  }
  return fn();
}

async function main() {
  // 双窗口共享的号池文件（临时目录）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-pool-'));
  const poolFile = path.join(tmpDir, 'pool.json');

  const { AccountStore } = require(path.join(root, 'out', 'accountStore.js'));
  const lockMod = require(path.join(root, 'out', 'accountLock.js'));

  // ── 场景 1: 窗口 A 写入 → 窗口 B 启动即见 ──
  const winA = new AccountStore(undefined, poolFile);
  await winA.upsert({
    id: 'acc-1', uid: 'uid-aaa', email: 'a@test.com', nickname: 'Alpha',
    accessToken: 't1', refreshToken: 'r1', tokenType: 'Bearer',
    expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
    status: 'idle', createdAt: Date.now(), lastUsed: 1
  });
  await winA.setActive('acc-1');
  gate('场景1: 窗口A写入后共享池文件存在', fs.existsSync(poolFile));
  const winB = new AccountStore(undefined, poolFile);
  gate('场景1: 窗口B启动即读到A写入的账号', winB.count() === 1 && Boolean(winB.getActive() && winB.getActive().id === 'acc-1'));

  // ── 场景 2: 窗口A切换 → 窗口B fs.watch 自动跟随（不重启） ──
  await winA.upsert({
    id: 'acc-2', uid: 'uid-bbb', email: 'b@test.com', nickname: 'Bravo',
    accessToken: 't2', refreshToken: 'r2', tokenType: 'Bearer',
    expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
    status: 'idle', createdAt: Date.now(), lastUsed: 2
  });
  await winA.setActive('acc-2');
  const winBDetectedSwitch = await waitFor(() => winB.getActive() && winB.getActive().id === 'acc-2');
  gate('场景2: 窗口B免重启感知A的切号', winBDetectedSwitch,
    `B.active=${winB.getActive() ? winB.getActive().id : 'null'}`);

  // ── 场景 3: 窗口B反向删除 → 窗口A同步 ──
  await winB.delete('acc-1');
  const winADetectedDelete = await waitFor(() => winA.count() === 1 && !winA.get('acc-1'));
  gate('场景3: 窗口A免重启感知B的删除', winADetectedDelete);

  // ── 场景 4: 隐私模式跨窗口同步 ──
  await winB.setPrivacyMode(true);
  const winADetectedPrivacy = await waitFor(() => winA.getPrivacyMode() === true);
  gate('场景4: 窗口A感知B的隐私模式切换', winADetectedPrivacy);
  await winA.setPrivacyMode(false);

  // ── 场景 5: 池文件损坏时严禁当空池覆盖（留证改名） ──
  fs.writeFileSync(poolFile, '{BROKEN JSON', 'utf8');
  const winC = new AccountStore(undefined, poolFile);
  const corruptLeft = fs.readdirSync(tmpDir).some(f => f.startsWith('pool.json.corrupt_'));
  gate('场景5: 损坏池文件留证改名', corruptLeft);
  gate('场景5: 损坏时不从损坏文件载入脏数据', winC.count() === 0);

  // ── 场景 6: 跨窗口账号锁（他窗 pid 持锁 → 判定占用；进程死 → 判定释放） ──
  lockMod.initAccountLock('win-TEST', '测试窗口');
  // 用真实存活子进程模拟另一窗口
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: false });
  await sleep(500); // 等子进程真正起来
  fs.writeFileSync(lockFile, JSON.stringify({
    locks: { 'uid-live': { windowId: 'win-OTHER', windowName: '另一窗口', pid: child.pid, ts: Date.now() } }
  }), 'utf8');
  gate('场景6: 他窗存活进程持锁判定占用', lockMod.isUidLocked('uid-live') === true);
  gate('场景6: getOtherLockedUids 返回他窗锁', lockMod.getOtherLockedUids().has('uid-live'));

  // ── 场景 7: 自己的锁可释放、别人的锁严禁误删 ──
  lockMod.acquireLock('uid-mine');
  gate('场景7: 本窗口持锁成功', fs.readFileSync(lockFile, 'utf8').includes('uid-mine'));
  lockMod.releaseLock('uid-live'); // 他窗的锁，绝不能删
  const lockAfterStealAttempt = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  gate('场景7: 他窗锁未被误删', Boolean(lockAfterStealAttempt.locks['uid-live']) && lockAfterStealAttempt.locks['uid-live'].pid === child.pid);
  lockMod.releaseLock('uid-mine');
  gate('场景7: 释放自己的锁生效', !Object.keys(JSON.parse(fs.readFileSync(lockFile, 'utf8')).locks).includes('uid-mine'));

  // 场景 8: 他窗进程死亡后锁自动判定失效
  child.kill();
  await sleep(300);
  gate('场景8: 他窗进程死亡后锁自动判定失效', lockMod.isUidLocked('uid-live') === false);

  // 清理
  winA.dispose(); winB.dispose(); winC.dispose();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('');
  console.log(`测试汇总: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
