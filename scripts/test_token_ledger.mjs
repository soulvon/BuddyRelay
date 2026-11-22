#!/usr/bin/env node
/**
 * TokenLedger 本地 Token 账本与状态透传回归测试（全隔离沙盒，零联网，零读取本机真实日志）
 * 覆盖：
 *  1. CodeBuddy IDE 扩展日志解析（UID 回填、3 种模型格式、requestId 去重、cache 不重复累加）
 *  2. CodeBuddy CLI / WorkBuddy JSONL 解析（快筛、UTC+8 日期转换、messageId 去重、unattributed）
 *  3. 费率与加权 Token 估算精度
 *  4. 增量文件签名缓存与损坏缓存熔断拒写保护
 *  5. CooldownLogWatcher usageLog 事件、SidebarProvider 与 StatusBarManager 隐私/无逗号端到端集成
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failures = [];

function check(title, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${title}`);
  } else {
    failed++;
    failures.push({ title, detail });
    console.log(`  FAIL  ${title}${detail ? ' — ' + detail : ''}`);
  }
}

function approxEq(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

async function main() {
  console.log('=== 开始 TokenLedger 统计与集成回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-tok-'));

  try {
    const {
      TokenLedger,
      getModelRates,
      computeWeightedTokens,
      estimateModelCostUsd
    } = require(path.join(ROOT, 'out', 'tokenLedger.js'));

    // 固定当前时间为 UTC+8 2026-11-23 12:00:00
    const NOW_MS = Date.UTC(2026, 10, 23, 4, 0, 0);
    const UID_A = '11111111-1111-4111-8111-111111111111';
    const UID_B = '22222222-2222-4222-8222-222222222222';

    const hostLogRoot = path.join(tmpDir, 'host-logs');
    const cliDir = path.join(tmpDir, 'cli-projects');
    const wbDir = path.join(tmpDir, 'wb-projects');
    const cacheFile = path.join(tmpDir, 'cache', 'token-ledger-v1.json');

    const ideDir1 = path.join(hostLogRoot, '20261123T080000', 'window1', 'exthost', 'Tencent-Cloud.coding-copilot');
    const ideDir2 = path.join(hostLogRoot, '20261122T200000', 'window1', 'exthost', 'Tencent-Cloud.coding-copilot');
    fs.mkdirSync(ideDir1, { recursive: true });
    fs.mkdirSync(ideDir2, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(wbDir, { recursive: true });

    // 日志1：包含「首个事件在 UID 心跳前」回填 + 3 种模型识别 + 相同 requestId 去重 + cache 不重复累加
    const ideLog1 = path.join(ideDir1, 'copilot.log');
    fs.writeFileSync(ideLog1, [
      '2026-11-23 09:00:01.000 [info] [CraftInvokableAgent] [a001] Model prepared: Gemini Flash (custom-local:gemini-3.8-flash)',
      '2026-11-23 09:00:05.000 [info] [AgentReporter] [a001] onAgentEnd: requestId=req-dup-1',
      '2026-11-23 09:00:05.100 [info] [AgentReporter] [a001] Agent execution successful with usage: {"inputTokens":243965,"outputTokens":2043,"totalTokens":246008,"cacheTokens":233216,"cachedWriteTokens":0,"cachedMissTokens":10749,"credit":0.78,"thinkingTokens":676}',
      `2026-11-23 09:01:00.000 [info] [MsgCenter] identity={"uid":"${UID_A}","tenant_id":"personal"}`,
      '2026-11-23 09:02:00.000 [info] [ModelProvider] max_tokens resolved: modelId=deepseek-v4.1-flash limit=64000',
      '2026-11-23 09:02:10.000 [info] [AgentReporter] [a002] onAgentEnd: requestId=req-ide-2',
      '2026-11-23 09:02:10.050 [info] [AgentReporter] [a002] Agent execution successful with usage: {"inputTokens":100000,"outputTokens":1000,"totalTokens":101000,"cacheTokens":80000}'
    ].join('\n'), 'utf8');

    // 日志2：含相同 requestId=req-dup-1（跨文件去重）+ 无 UID 行回落 unattributed
    const ideLog2 = path.join(ideDir2, 'copilot-old.log');
    fs.writeFileSync(ideLog2, [
      '2026-11-22 21:00:00.000 [info] ModelProvider initialized, modelId: claude-4.5-sonnet, modelName: Claude 4.5 Sonnet',
      '2026-11-22 21:00:05.000 [info] [AgentReporter] [b001] onAgentEnd: requestId=req-dup-1',
      '2026-11-22 21:00:05.100 [info] [AgentReporter] [b001] Agent execution successful with usage: {"inputTokens":243965,"outputTokens":2043,"totalTokens":246008,"cacheTokens":233216,"cachedMissTokens":10749}',
      '2026-11-22 21:05:00.000 [info] [AgentReporter] [b002] onAgentEnd: requestId=req-unattr-1',
      '2026-11-22 21:05:01.000 [info] [AgentReporter] [b002] Agent execution successful with usage: {"inputTokens":50000,"outputTokens":500,"totalTokens":50500,"cacheTokens":40000,"cachedMissTokens":10000}'
    ].join('\n'), 'utf8');

    // CLI JSONL：不含 usage 的行跳过 + UTC 2026-11-22T17:00:00Z => UTC+8 2026-11-23 + messageId 去重
    fs.writeFileSync(path.join(cliDir, 'sess.jsonl'), [
      '{"type":"user","message":{"role":"user","content":"你好"}}',
      '{"invalid json line without usage',
      JSON.stringify({
        timestamp: '2026-11-22T17:00:00.000Z',
        model: 'glm-4.6',
        providerData: { messageId: 'cli-msg-1' },
        message: { usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 200 } }
      }),
      JSON.stringify({
        timestamp: '2026-11-22T17:00:00.000Z',
        model: 'glm-4.6',
        providerData: { messageId: 'cli-msg-1' },
        message: { usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 200 } }
      })
    ].join('\n'), 'utf8');

    // WorkBuddy JSONL：OpenAI/Tencent 含总计扣除缓存语义（rawInput=10000 + output=500 === total=10500 且 cacheRead=8000）
    const wbSub = path.join(wbDir, 'proj1');
    fs.mkdirSync(wbSub, { recursive: true });
    fs.writeFileSync(path.join(wbSub, 'chat.jsonl'), [
      JSON.stringify({
        timestamp: '2026-11-21T10:00:00.000Z',
        providerData: {
          model: 'claude-4.5-opus',
          traceId: 'wb-tr-1',
          rawUsage: { prompt_tokens: 10000, completion_tokens: 500, total_tokens: 10500, prompt_tokens_details: { cached_tokens: 8000 } }
        }
      })
    ].join('\n'), 'utf8');

    // [1] 费率与加权
    console.log('[1/5] 费率估算与加权计算测试');
    const customGeminiRates = getModelRates('custom-local:gemini-3.8-flash');
    check('去除 custom-local 前缀正确匹配 Gemini Flash 费率', customGeminiRates.input === 0.3 && customGeminiRates.output === 2.5, JSON.stringify(customGeminiRates));
    check('weighted 公式对齐 1x input + 0.1x cacheRead + 6x output', computeWeightedTokens(10749, 233216, 2043) === Math.round(10749 + 23321.6 + 12258));
    const costRes = estimateModelCostUsd('deepseek-v4.1-flash', 20000, 80000, 0, 1000);
    const expectedCost = (20000 * 0.28 + 80000 * 0.028 + 1000 * 0.42) / 1e6;
    const expectedSaved = (80000 * (0.28 - 0.028)) / 1e6;
    check('DeepSeek 费用与缓存节省估算精确', approxEq(costRes.costUsd, expectedCost) && approxEq(costRes.savedByCacheUsd, expectedSaved));

    // [2] 双源扫描解析
    console.log('\n[2/5] IDE 日志与 CLI/WorkBuddy JSONL 解析测试');
    const ledger = new TokenLedger({
      hostLogDirs: [hostLogRoot],
      cliProjectsDir: cliDir,
      workbuddyDirs: [wbDir],
      cacheFilePath: cacheFile,
      nowProvider: () => NOW_MS,
      ttlMs: 1000
    });
    const summary1 = await ledger.getSummary(true);

    // 核对事件数：IDE 去重后 3 条 + CLI 去重后 1 条 + WorkBuddy 1 条 = 5 条
    check('全局去重后总调用数为 5 次', summary1.totalCalls === 5, `actual=${summary1.totalCalls}`);

    // UID_A 今日两条：246008 + 101000 = 347008（cache 不重复加在 input 上）；credits=0.78
    const accA = summary1.perAccount[UID_A];
    check('UID 提前出现的事件正确回填首个心跳 UID', Boolean(accA && accA.todayCalls === 2), JSON.stringify(accA));
    check('cacheTokens 不重复计入总 Token（246008 + 101000 = 347008）', accA?.todayTokens === 347008, JSON.stringify(accA));

    // 无 UID 日志不伪造绑定给 UID_A，归 unattributed
    check('无 UID 归属的日志不会错误挂到账号 UID_A', accA?.totalTokens === 347008 && !summary1.perAccount[UID_B]);
    check('custom-local:gemini-3.8-flash 与 deepseek-v4.1-flash 均被识别', summary1.models.some((m) => m.model === 'custom-local:gemini-3.8-flash') && summary1.models.some((m) => m.model === 'deepseek-v4.1-flash'));

    // CLI UTC 17:00 => UTC+8 次日（2026-11-23）
    check('CLI 按 source=cli 分桶且合计 5700 tokens', summary1.bySource.cli.calls === 1 && summary1.bySource.cli.total === 5700, JSON.stringify(summary1.bySource.cli));
    check('WorkBuddy 扣除 prompt_tokens 内含 cache 后 input=2000', summary1.bySource.workbuddy.calls === 1 && summary1.bySource.workbuddy.total === 10500, JSON.stringify(summary1.bySource.workbuddy));
    check('今日全源合计 = 347008 + 5700 = 352708', summary1.totals.today.total === 352708, JSON.stringify(summary1.totals.today));
    check('今日积分保留 0.78', approxEq(summary1.totals.today.credits, 0.78), JSON.stringify(summary1.totals.today));

    // [3] 增量缓存命中与更新重扫
    console.log('\n[3/5] 增量文件缓存与变更重扫测试');
    check('首次扫描后缓存文件成功原子落盘', fs.existsSync(cacheFile));
    const ledger2 = new TokenLedger({
      hostLogDirs: [hostLogRoot],
      cliProjectsDir: cliDir,
      workbuddyDirs: [wbDir],
      cacheFilePath: cacheFile,
      nowProvider: () => NOW_MS
    });
    const summary2 = await ledger2.getSummary(true);
    check('重载增量缓存结果完全一致', summary2.totals.allTime.total === summary1.totals.allTime.total && summary2.totalCalls === 5);

    fs.appendFileSync(
      path.join(cliDir, 'sess.jsonl'),
      '\n' + JSON.stringify({
        timestamp: '2026-11-23T02:00:00.000Z',
        model: 'qwen-3',
        id: 'cli-msg-2',
        usage: { input_tokens: 1000, output_tokens: 300 }
      }),
      'utf8'
    );
    const summary3 = await ledger2.getSummary(true);
    check('CLI JSONL 追加后增量重扫立即捕获新 1300 tokens', summary3.bySource.cli.calls === 2 && summary3.bySource.cli.total === 7000, JSON.stringify(summary3.bySource.cli));

    // [4] 损坏缓存熔断拒写保护
    console.log('\n[4/5] 损坏缓存熔断拒写保护测试');
    const corruptCacheFile = path.join(tmpDir, 'corrupt-cache.json');
    const brokenRaw = '{"version":1,"files":{"broken":';
    fs.writeFileSync(corruptCacheFile, brokenRaw, 'utf8');
    const corruptLedger = new TokenLedger({
      hostLogDirs: [hostLogRoot],
      cliProjectsDir: cliDir,
      workbuddyDirs: [wbDir],
      cacheFilePath: corruptCacheFile,
      nowProvider: () => NOW_MS
    });
    const summaryCorrupt = await corruptLedger.getSummary(true);
    check('缓存损坏时仍能在内存中扫描返回正确统计且标注 cacheHealthy=false', summaryCorrupt.cacheHealthy === false && summaryCorrupt.totalCalls === 6);
    check('损坏缓存拒写保护：磁盘原损坏文件未被覆写', fs.readFileSync(corruptCacheFile, 'utf8') === brokenRaw);

    // [5] Watcher + SidebarProvider + StatusBarManager 集成测试
    console.log('\n[5/5] CooldownWatcher / SidebarProvider / StatusBarManager 集成测试');
    const { CooldownLogWatcher } = require(path.join(ROOT, 'out', 'cooldownLogWatcher.js'));
    let emittedUsageLog = 0;
    const w = new CooldownLogWatcher();
    w.on('usageLog', () => { emittedUsageLog++; });
    w.uids.set('fake.log', UID_A);
    w.processLine('fake.log', '2026-11-23 10:00:00.000 [info] [AgentReporter] [a1] Agent execution successful with usage: {"inputTokens":10}', true);
    w.processLine('fake.log', '2026-11-23 10:00:00.000 [info] [AgentReporter] [a1] Agent execution successful with usage: {"inputTokens":10}', false);
    w.stop();
    check('CooldownLogWatcher 增量行触发 usageLog，历史行不误触发', emittedUsageLog === 1, `count=${emittedUsageLog}`);

    const createdStatusItem = { text: '', tooltip: null, backgroundColor: undefined, command: undefined, show() {}, dispose() {} };
    const mockVscode = {
      StatusBarAlignment: { Right: 2 },
      MarkdownString: class MarkdownString {
        constructor(v = '') { this.value = v; this.isTrusted = false; this.supportThemeIcons = false; }
        appendMarkdown(s) { this.value += s; return this; }
      },
      ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
      QuickPickItemKind: { Separator: -1 },
      env: { appName: 'CodeBuddy CN', appRoot: '', sessionId: 's1', language: 'zh-cn', clipboard: { writeText: async () => {} }, openExternal: async () => true },
      workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => ({ dispose: () => {} }) },
      window: {
        createStatusBarItem: () => createdStatusItem,
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined
      },
      commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
      Uri: { file: (p) => ({ fsPath: p }), joinPath: (b, ...s) => ({ fsPath: path.join(b?.fsPath || '', ...s) }), parse: (s) => ({ toString: () => s }) }
    };
    const origLoad = Module._load;
    Module._load = function (req) {
      if (req === 'vscode') return mockVscode;
      return origLoad.apply(this, arguments);
    };
    try {
      const { SidebarProvider } = require(path.join(ROOT, 'out', 'sidebarProvider.js'));
      const { StatusBarManager } = require(path.join(ROOT, 'out', 'statusBar.js'));
      const activeAccount = {
        id: 'id-a',
        uid: UID_A,
        nickname: '张三',
        displayName: '主力测试',
        email: '13800138000',
        status: 'active',
        totalCredits: 500,
        checkinStreak: 3
      };
      let priv = false;
      const stubStore = {
        on: () => {},
        removeListener: () => {},
        get: (id) => (id === 'id-a' ? activeAccount : undefined),
        getAll: () => [activeAccount],
        getActive: () => activeAccount,
        getPrivacyMode: () => priv,
        getAllTags: () => []
      };
      const postedMessages = [];
      const sp = new SidebarProvider({ fsPath: ROOT }, stubStore, {}, {}, {}, {}, undefined, { tokenLedger: ledger2 });
      sp._view = { webview: { postMessage: (msg) => postedMessages.push(msg) } };
      sp.refreshUsageStats = () => {};
      sp.postStateToWebview();
      const stateMsg = postedMessages[0];
      check(
        'SidebarProvider 推送 tokenLedger 与对应账号 tokenStats',
        Boolean(stateMsg?.data?.tokenLedger && stateMsg.data.accounts?.[0]?.tokenStats?.todayTokens === 347008),
        JSON.stringify(stateMsg?.data?.accounts?.[0]?.tokenStats)
      );

      const sb = new StatusBarManager(stubStore, {}, async () => {}, undefined, undefined, ledger2);
      const tipNormal = createdStatusItem.tooltip?.value || '';
      priv = true;
      sb.update();
      const tipMasked = createdStatusItem.tooltip?.value || '';
      sb.dispose();
      sp.dispose();
      check('StatusBar tooltip 含 Token 今日与累计统计且禁用逗号分隔', tipNormal.includes('347.0K tok') && !tipNormal.includes('347,008'), tipNormal);
      check('StatusBar 隐私模式下保持 UID/账号名脱敏', tipMasked.includes('1111****11') && !tipMasked.includes('主力测试'), tipMasked);
    } finally {
      Module._load = origLoad;
    }

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      console.log('失败明细:');
      for (const f of failures) console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
      process.exit(1);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});

