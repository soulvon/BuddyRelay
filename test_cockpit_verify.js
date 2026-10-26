/**
 * 验证 CockpitImporter 解密与读取本机 5 个真实账号的轻量测试脚本
 */
const { CockpitImporter } = require('./out/cockpitImporter.js');

async function testCockpitImport() {
  console.log('================================================================');
  console.log('🔍 开始验证 CockpitImporter 真实凭据存储与 AES-256-GCM 解密能力');
  console.log('================================================================\n');

  const importer = new CockpitImporter();

  // 1. 验证存储环境探测
  console.log('[Step 1] 探测本地 Cockpit 凭据存储环境...');
  const verify = importer.verifyCockpitStorage();
  console.log(`  密钥文件检测: ${verify.hasKey ? '✅ 存在' : '❌ 缺失'}`);
  console.log(`  账号目录检测: ${verify.hasAccountsDir ? '✅ 存在' : '❌ 缺失'}`);
  console.log(`  账号文件统计: 发现 ${verify.accountFilesCount} 个有效 .json 账号文件`);
  console.log(`  首文件探针解密: ${verify.verified ? '✅ 成功' : '❌ 失败'} (${verify.message})\n`);

  if (!verify.verified) {
    throw new Error(`Cockpit 存储探测失败: ${verify.message}`);
  }

  // 2. 执行全量解密导入
  console.log('[Step 2] 执行全量账号读取与解密...');
  const result = await importer.importToStore();
  
  console.log(`  扫描文件总数: ${result.totalFound}`);
  console.log(`  成功解密数量: ${result.decryptedCount}`);
  console.log(`  解密失败数量: ${result.errors.length}\n`);

  if (result.errors.length > 0) {
    console.error('  ⚠️ 解密错误列表:');
    for (const err of result.errors) {
      console.error(`    - ${err.file}: ${err.error}`);
    }
  }

  // 3. 校验账号字段完整性
  console.log('[Step 3] 校验解密账号详细信息:');
  result.importedAccounts.forEach((acc, idx) => {
    const maskedUid = acc.uid ? `${acc.uid.slice(0, 8)}...${acc.uid.slice(-4)}` : 'N/A';
    const maskedToken = acc.accessToken ? `${acc.accessToken.slice(0, 10)}...${acc.accessToken.slice(-6)}` : 'EMPTY';
    const maskedRefresh = acc.refreshToken ? `${acc.refreshToken.slice(0, 10)}...` : 'EMPTY';
    console.log(`  [账号 #${idx + 1}]`);
    console.log(`    - ID:           ${acc.id}`);
    console.log(`    - 昵称:         ${acc.nickname}`);
    console.log(`    - 邮箱/账号:    ${acc.email}`);
    console.log(`    - UID:          ${maskedUid}`);
    console.log(`    - 订阅类型:     ${acc.paymentType}`);
    console.log(`    - 连续签到:     ${acc.checkinStreak} 天 (今日已签: ${acc.todayCheckedIn})`);
    console.log(`    - 状态:         ${acc.status}`);
    console.log(`    - AccessToken:  ${maskedToken}`);
    console.log(`    - RefreshToken: ${maskedRefresh}`);
    console.log(`    - Token 过期:   ${new Date(acc.expiresAt).toLocaleString()}`);
  });

  // 4. 断言验证
  console.log('\n[Step 4] 断言验证:');
  if (result.decryptedCount < 5) {
    throw new Error(`期望解密至少 5 个真实账号，实际解密 ${result.decryptedCount} 个`);
  }
  console.log(`  ✅ 成功解密并读取 ${result.decryptedCount} 个真实账号 (满足 >= 5 个账号要求)`);

  for (const acc of result.importedAccounts) {
    if (!acc.uid || !acc.accessToken || !acc.refreshToken) {
      throw new Error(`账号 [${acc.nickname || acc.id}] 缺少关键凭据字段 (uid, accessToken, refreshToken)`);
    }
  }
  console.log('  ✅ 所有账号均包含完整有效的 uid、accessToken 及 refreshToken 凭据');

  console.log('\n================================================================');
  console.log(`🎉 CockpitImporter 实测通过！真实账号数: ${result.decryptedCount}`);
  console.log('================================================================\n');

  return result;
}

testCockpitImport().catch(err => {
  console.error('\n❌ CockpitImporter 测试失败:', err);
  process.exit(1);
});
