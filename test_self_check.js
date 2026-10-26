/**
 * BuddyRelay 核心底层引擎端到端自测试验脚本
 */

const fs = require('fs');
const path = require('path');
const {
  PATHS,
  PATCH_V4,
  API_ENDPOINTS,
  AccountStore,
  CockpitImporter,
  OAuthService,
  CheckinService,
  SeamlessSwitcher,
  AutoSwitcher
} = require('./out/index.js');

async function runSelfTest() {
  console.log('====================================================');
  console.log('🚀 开始 BuddyRelay 核心底层引擎全面自测');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, desc) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${desc}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${desc}`);
      throw new Error(`Test failed: ${desc}`);
    }
  }

  // ----------------------------------------------------------------
  // 1. 测试 constants.ts
  // ----------------------------------------------------------------
  console.log('--- 1. 测试 constants.ts ---');
  assert(API_ENDPOINTS.CODEBUDDY_CN_BASE === 'https://www.codebuddy.cn', 'API 基础路径正确');
  assert(API_ENDPOINTS.OAUTH_STATE === '/v2/plugin/auth/state', 'OAuth state 路径正确');
  assert(API_ENDPOINTS.CHECKIN_ACTIVITY_STATUS === '/v2/billing/meter/checkin-activity-status', '签到状态路径正确');
  assert(PATCH_V4.PATCH_FLAG === '__byokApplySwitch', 'Patch v4 标志位正确');
  assert(typeof PATHS.COCKPIT_KEY_FILE === 'string', 'Cockpit Key 路径已解析');
  assert(PATHS.MASTER_SESSION_UID === '69719899-bf05-4822-9e20-d4e7437a2edd', '黄金母号 UID 正确');

  // ----------------------------------------------------------------
  // 2. 测试 accountStore.ts
  // ----------------------------------------------------------------
  console.log('\n--- 2. 测试 accountStore.ts ---');
  const tempStoreFile = path.join(process.env.TEMP || '.', `test_store_${Date.now()}.json`);
  const store = new AccountStore(undefined, tempStoreFile);

  const mockAcc1 = {
    id: 'test_acc_01',
    uid: 'uid-test-01',
    email: 'test01@example.com',
    nickname: '测试用户1',
    accessToken: 'tok_01',
    refreshToken: 'ref_01',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600000,
    domain: 'www.codebuddy.cn',
    status: 'idle',
    createdAt: Date.now(),
    lastUsed: Date.now() - 5000
  };
  const mockAcc2 = {
    id: 'test_acc_02',
    uid: 'uid-test-02',
    email: 'test02@example.com',
    nickname: '测试用户2',
    accessToken: 'tok_02',
    refreshToken: 'ref_02',
    tokenType: 'Bearer',
    expiresAt: Date.now() + 3600000,
    domain: 'www.codebuddy.cn',
    status: 'idle',
    createdAt: Date.now(),
    lastUsed: Date.now()
  };

  await store.upsert(mockAcc1);
  await store.upsert(mockAcc2);
  assert(store.count() === 2, '成功插入 2 个测试账号');

  await store.setActive(mockAcc1.id);
  assert(store.getActive().id === mockAcc1.id, '成功将 mockAcc1 设为 active');
  assert(store.get(mockAcc2.id).status === 'idle', 'mockAcc2 状态为 idle');

  await store.markRateLimited(mockAcc1.id, 60000);
  assert(store.get(mockAcc1.id).status === 'rate_limited', '成功标记 429 速率限制');

  await store.clearRateLimit(mockAcc1.id);
  assert(store.get(mockAcc1.id).status === 'active', '成功解除 429 限制并恢复');

  // 清理临时文件
  if (fs.existsSync(tempStoreFile)) fs.unlinkSync(tempStoreFile);

  // ----------------------------------------------------------------
  // 3. 测试 cockpitImporter.ts (真实环境实测)
  // ----------------------------------------------------------------
  console.log('\n--- 3. 测试 cockpitImporter.ts ---');
  const importer = new CockpitImporter();
  const verify = importer.verifyCockpitStorage();
  console.log('  Cockpit 环境探测:', verify.message);
  assert(verify.hasKey === true, 'Cockpit 密钥文件存在');
  assert(verify.hasAccountsDir === true, 'Cockpit 账号目录存在');
  assert(verify.accountFilesCount > 0, `发现 Cockpit 账号文件 (${verify.accountFilesCount} 个)`);
  assert(verify.verified === true, 'AES-256-GCM 探针解密实测通过');

  const importResult = await importer.importToStore();
  assert(importResult.success === true, 'Cockpit 全量账号导入成功');
  assert(importResult.decryptedCount >= 5, `成功解密 ${importResult.decryptedCount} 个真实账号`);
  for (const acc of importResult.importedAccounts) {
    console.log(`    ↳ [${acc.nickname}] email: ${acc.email}, uid: ${acc.uid.slice(0, 8)}..., streak: ${acc.checkinStreak}`);
  }

  // ----------------------------------------------------------------
  // 4. 测试 oauthService.ts (实时连网实测)
  // ----------------------------------------------------------------
  console.log('\n--- 4. 测试 oauthService.ts ---');
  const oauth = new OAuthService();
  const authState = await oauth.createAuthState();
  assert(typeof authState.state === 'string' && authState.state.length > 0, `成功获取 OAuth state: ${authState.state}`);
  assert(authState.authUrl.includes('platform=ide'), `成功获取官方扫码授权链接: ${authState.authUrl}`);

  // ----------------------------------------------------------------
  // 5. 测试 checkinService.ts (实时连网实测)
  // ----------------------------------------------------------------
  console.log('\n--- 5. 测试 checkinService.ts ---');
  const checkinService = new CheckinService();
  const testAcc = importResult.importedAccounts[0];
  const queryStatus = await checkinService.queryStatus(testAcc);
  assert(queryStatus.active === true, 'Buddy加油站活动处于 active 状态');
  assert(typeof queryStatus.streakDays === 'number', `查询到连续签到天数: ${queryStatus.streakDays} 天`);
  assert(queryStatus.todayCheckedIn === true || queryStatus.todayCheckedIn === false, '签到状态标志明确');

  const checkinRes = await checkinService.checkinAccount(testAcc);
  assert(checkinRes.success === true, `单账号签到执行结果成功: ${checkinRes.message}`);

  // ----------------------------------------------------------------
  // 6. 测试 seamlessSwitcher.ts
  // ----------------------------------------------------------------
  console.log('\n--- 6. 测试 seamlessSwitcher.ts ---');
  const switcher = new SeamlessSwitcher();
  const mainJs = switcher.locateMainJs();
  assert(mainJs !== null && fs.existsSync(mainJs), `成功定位 CodeBuddy main.js: ${mainJs}`);

  const patchCheck = switcher.checkPatch();
  assert(patchCheck.isPatched === true, 'main.js 已确认打上 Patch v4 补丁');
  assert(patchCheck.hasOriginBackup === true, 'main.js.byok-origin 原始备份文件存在');
  assert(patchCheck.anchorsValid === true, 'Patch v4 锚点校验通过');

  const junctionRes = switcher.ensureJunction(testAcc.uid);
  assert(junctionRes.success === true, `NTFS Junction 穿透映射成功: ${junctionRes.message}`);

  // 测试写入 byok-switch.json 指令
  const tempCmdFile = path.join(process.env.TEMP || '.', `test_byok_switch_${Date.now()}.json`);
  const cmdFile = await switcher.writeSwitchCommand(testAcc, tempCmdFile);
  assert(fs.existsSync(cmdFile), 'byok-switch.json 指令文件生成成功');
  const cmdData = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
  assert(cmdData.session && cmdData.session.account.uid === testAcc.uid, '指令中包含正确的目标 UID');
  if (fs.existsSync(tempCmdFile)) fs.unlinkSync(tempCmdFile);

  // ----------------------------------------------------------------
  // 7. 测试 autoSwitcher.ts
  // ----------------------------------------------------------------
  console.log('\n--- 7. 测试 autoSwitcher.ts ---');
  const poolStore = new AccountStore(undefined, path.join(process.env.TEMP || '.', `test_pool_${Date.now()}.json`));
  await poolStore.upsertBatch(importResult.importedAccounts);

  const autoSwitcher = new AutoSwitcher(poolStore, switcher, oauth);
  const curAcc = poolStore.getActive();
  assert(curAcc !== undefined, `当前活跃账号: ${curAcc.nickname}`);

  const nextAcc = autoSwitcher.getNextAvailableAccount(curAcc.uid);
  assert(nextAcc !== null && nextAcc.uid !== curAcc.uid, `成功自动筛选出下一轮换账号: ${nextAcc.nickname} (UID: ${nextAcc.uid.slice(0, 8)}...)`);

  // 模拟 429 速率限制触发轮换
  const currentUidBefore = curAcc.uid;
  const rotationPromise = new Promise(resolve => {
    autoSwitcher.once('rotation', ev => resolve(ev));
  });

  const rotateRes = await autoSwitcher.handleRateLimit429(currentUidBefore, 60000);
  assert(rotateRes.success === true, '429 自动轮换调度执行成功');
  const event = await rotationPromise;
  assert(event.reason === 'rate_limited_429', '轮换事件触发且原因为 rate_limited_429');
  assert(event.fromUid === currentUidBefore, '从被限制账号成功迁出');
  assert(poolStore.get(currentUidBefore).status === 'rate_limited', '旧账号状态成功更新为 rate_limited');

  // 健康巡检测试
  const healthRes = await autoSwitcher.runHealthCycle();
  assert(typeof healthRes.recoveredCount === 'number', '健康巡检周期正常运行');

  console.log('\n====================================================');
  console.log(`🎉 全部 ${passedTests}/${totalTests} 项端到端自测用例通过！`);
  console.log('====================================================\n');
}

runSelfTest().catch(err => {
  console.error('\n❌ 自测试验出现异常:', err);
  process.exit(1);
});
