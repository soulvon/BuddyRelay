/**
 * BuddyRelay v0.4.0 核心能力深度测试套件
 * 严格验证：
 * 1. UsageTracker 算力流水对账 (Delta 快照差值算力计算、今日经营总报表、切号事件审计)
 * 2. AutoSwitcher 调度安全防线 (切号频率熔断器滑动窗口拦截、熔断冷却、候选账号排序)
 * 3. AccountStore 业务标签 (Tags) 与备注说明 (Notes) 数据模型与动态去重
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

async function runTests() {
  console.log('=== 开始 BuddyRelay v0.4.0 核心功能与安全防线深度测试 ===\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-v040-'));
  const usageFile = path.join(tmpDir, 'usage-records.json');
  const poolFile = path.join(tmpDir, 'pool.json');

  const { UsageTracker } = require(path.join(ROOT, 'out', 'usageTracker.js'));
  const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
  const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));

  // ──────────────────────────────────────────────────────────
  // 1. UsageTracker 算力流水对账测试
  // ──────────────────────────────────────────────────────────
  console.log('[测试 1/3] UsageTracker 算力流水对账与经营审计');
  const tracker = new UsageTracker(usageFile);

  const mockAcc = {
    id: 'test-acc-1',
    uid: 'uid-1',
    nickname: '测试主力号',
    email: '18888888888',
    status: 'active'
  };

  // 打底快照（初次不产生差值流水）
  tracker.recordSnapshot(mockAcc, 1000, '初次加载');
  check('流水打底: 初次记录不产生虚假流水', tracker.getRecentRecords().length === 0);

  // 模拟 AI 写代码消费 25.5 点
  tracker.recordSnapshot(mockAcc, 974.5, '代码补全');
  let records = tracker.getRecentRecords();
  check('算力消耗抓取: 正确识别 delta < 0 产生 consume 流水', records.length === 1 && records[0].type === 'consume');
  check('算力消耗数值: 准确计算消耗 -25.5 点', records[0].deltaCredits === -25.5);
  check('算力结存记录: 准确记录变动后余额 974.5 点', records[0].balanceAfter === 974.5);

  // 模拟每日签到到账 10 点
  tracker.recordSnapshot(mockAcc, 984.5, '每日签到');
  records = tracker.getRecentRecords();
  check('算力入账抓取: 正确识别 delta > 0 产生 reward 流水', records.length === 2 && records[0].type === 'reward');
  check('算力入账数值: 准确记录新增 +10 点', records[0].deltaCredits === 10);

  // 记录切号动作
  tracker.recordAction({
    type: 'switch',
    accountId: 'test-acc-1',
    accountName: '测试主力号',
    title: '自动无感热切',
    detail: '额度见底(≤10%)，平滑切换至测试备用号'
  });
  records = tracker.getRecentRecords();
  check('切号审计: 正确记录 switch 事件流水', records.length === 3 && records[0].type === 'switch');

  // 今日经营总账对账汇总
  const summary = tracker.getDailySummary();
  check('今日经营总账: 正确统计今日累计消耗 25.5 点', summary.totalConsumed === 25.5);
  check('今日经营总账: 正确统计今日累计新增 10 点', summary.totalAwarded === 10);
  check('今日经营总账: 正确统计今日切号次数 1 次', summary.switchCount === 1);

  console.log('');

  // ──────────────────────────────────────────────────────────
  // 2. AutoSwitcher 调度安全防线与频率熔断器测试
  // ──────────────────────────────────────────────────────────
  console.log('[测试 2/3] AutoSwitcher 频率熔断器与候选预检');
  const store = new AccountStore(undefined, poolFile);

  await store.upsert({
    id: 'a1', uid: 'u1', nickname: '号A', email: 'a1@test.com',
    accessToken: 'tok1', refreshToken: 'ref1', tokenType: 'Bearer',
    expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
    status: 'idle', createdAt: Date.now(), lastUsed: 10, totalCredits: 500,
    activityPackage: { title: '包', count: 1, remain: 500, total: 1000, percent: 50 }
  });

  await store.upsert({
    id: 'a2', uid: 'u2', nickname: '号B', email: 'a2@test.com',
    accessToken: 'tok2', refreshToken: 'ref2', tokenType: 'Bearer',
    expiresAt: Date.now() + 7200e3, domain: 'www.codebuddy.cn',
    status: 'idle', createdAt: Date.now(), lastUsed: 20, totalCredits: 800,
    activityPackage: { title: '包', count: 1, remain: 800, total: 1000, percent: 80 }
  });

  const autoSwitcher = new AutoSwitcher(store, undefined, undefined, { usageTracker: tracker, strategy: 'highest_quota' });

  // 候选账号按 highest_quota 排序测试
  const candidates = autoSwitcher.getCandidateAccounts('u1');
  check('候选策略: 正确排除当前使用中的账号 u1', !candidates.some(c => c.uid === 'u1'));
  check('候选策略: 优先挑选剩余算力占比最高的健康账号', candidates.length > 0 && candidates[0].uid === 'u2');

  // 熔断器测试：模拟 60 秒内连续切号 5 次放行，第 6 次超出上限触发熔断
  check('熔断器初始: 状态正常未熔断', !autoSwitcher.isCircuitBreakerTripped());
  for (let i = 0; i < 5; i++) {
    autoSwitcher.checkCircuitBreaker();
  }
  check('熔断器阈值前: 5次切号正常放行', !autoSwitcher.isCircuitBreakerTripped());

  // 第 6 次超出上限触发熔断拦截
  let tripped = false;
  try {
    autoSwitcher.checkCircuitBreaker();
  } catch (err) {
    tripped = true;
  }
  check('熔断器拦截: 超出5次连续切号正确触发熔断抛出异常', tripped);
  check('熔断器状态: 熔断器进入冷却锁定状态', autoSwitcher.isCircuitBreakerTripped());

  // 熔断期间再次调用直接拦截
  let rejectedDuringTrip = false;
  try {
    autoSwitcher.checkCircuitBreaker();
  } catch (err) {
    rejectedDuringTrip = true;
  }
  check('熔断冷却防护: 熔断期内严禁发起新的自动切号', rejectedDuringTrip);

  console.log('');

  // ──────────────────────────────────────────────────────────
  // 3. AccountStore 业务标签 (Tags) 与账号备注 (Notes) 测试
  // ──────────────────────────────────────────────────────────
  console.log('[测试 3/3] AccountStore 业务标签 (Tags) 与账号备注 (Notes)');

  // 备注编辑与持久化
  await store.updateNotes('a1', '腾讯云主力白嫖号，用于出海A组开发');
  check('备注保存: 账号备注成功更新', store.get('a1')?.notes === '腾讯云主力白嫖号，用于出海A组开发');

  // 标签编辑与自动去重
  await store.updateTags('a1', ['主力', '出海A', '主力', '  挂机  ']);
  const tagsA1 = store.get('a1')?.tags || [];
  check('标签更新: 标签成功更新且自动去重去空格', tagsA1.includes('主力') && tagsA1.includes('出海A') && tagsA1.includes('挂机') && tagsA1.length === 3);

  await store.updateTags('a2', ['备用', '出海A']);
  const allTags = store.getAllTags();
  check('全局标签聚合: 正确提取号池中所有不重复标签', allTags.includes('主力') && allTags.includes('出海A') && allTags.includes('挂机') && allTags.includes('备用') && allTags.length === 4);

  // 清理临时文件
  store.dispose();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log('');
  console.log(`v0.4.0 核心能力测试结果: ${passed} 项全部通过, ${failed} 项失败`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
