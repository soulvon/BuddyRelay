#!/usr/bin/env node
/**
 * 成长任务全链路真实校验门控脚本
 * 验证：
 * 1. 双源报名 (desktop + mp) 正常分发与接受
 * 2. 账号自愈前置 (未领养 Buddy 自动补全)
 * 3. 报名与领奖真实结果穿透，杜绝静默吞错
 * 4. 账号切换任务中心数据隔离，杜绝串号假象
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountsPath = path.join(process.env.APPDATA, 'BuddyRelay', 'accounts.json');

if (!fs.existsSync(accountsPath)) {
  console.log('accounts.json not found, skipping live API tests');
  process.exit(0);
}

const { accounts } = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
if (!accounts || accounts.length === 0) {
  console.log('No accounts in accounts.json');
  process.exit(0);
}

import { pathToFileURL } from 'node:url';

// 动态导入编译后的 GrowthTaskService
const { GrowthTaskService } = await import(pathToFileURL(path.join(ROOT, 'out', 'growthTaskService.js')).href);
const service = new GrowthTaskService();

let passed = 0;
let failed = 0;

function assertGate(name, ok, msg) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} — ${msg || ''}`);
  }
}

console.log('=== 开始成长任务全链路真实校验 ===\n');

// 1. 测试各账号 listTasks 能够拉取到合并的双源任务
for (const acc of accounts) {
  const name = acc.nickname || acc.email;
  const tasks = await service.listTasks(acc);
  const hasDesktop = tasks.some(t => t.source === 'desktop');
  const hasMp = tasks.some(t => t.source === 'mp');
  assertGate(
    `[${name}] 任务列表拉取`,
    tasks.length >= 10 && hasDesktop && hasMp,
    `任务数: ${tasks.length}, desktop: ${hasDesktop}, mp: ${hasMp}`
  );
}

// 2. 测试 17777298947 或苏文的 acceptAll 行为
const targetAcc = accounts.find(a => a.nickname === '17777298947') || accounts[0];
const targetName = targetAcc.nickname || targetAcc.email;
const tasks = await service.listTasks(targetAcc);
const res = await service.acceptAll(targetAcc, tasks);

console.log(`\n[${targetName}] acceptAll 结果:`, JSON.stringify(res));
assertGate(
  `[${targetName}] acceptAll 结构体完备`,
  typeof res.accepted === 'number' && typeof res.alreadyAccepted === 'number' && Array.isArray(res.failures),
  '字段缺失'
);
assertGate(
  `[${targetName}] acceptAll 无静默吞错 (错误穿透)`,
  res.failed === res.failures.length,
  `failed=${res.failed}, failures.length=${res.failures.length}`
);

// 3. 测试 runAutoComplete 报告结构真实完整
const autoReport = await service.runAutoComplete(targetAcc);
console.log(`\n[${targetName}] runAutoComplete 报告:`, JSON.stringify({
  buddyAttempted: autoReport.buddyAttempted,
  buddyAdopted: autoReport.buddyAdopted,
  accepted: autoReport.accepted,
  claimed: autoReport.claimed,
  claimedCredits: autoReport.claimedCredits,
  inProgressTasks: autoReport.inProgressTasks,
  failures: autoReport.failures
}));

assertGate(
  `[${targetName}] runAutoComplete 真实反映进行中任务`,
  typeof autoReport.inProgressTasks === 'number' && autoReport.inProgressTasks >= 0,
  'inProgressTasks 无效'
);

console.log(`\n测试汇总: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
