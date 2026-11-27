#!/usr/bin/env node
/**
 * CodeBuddy 企业版账号识别、额度查询、防误签、自动切号与热切状态同步回归测试
 * （全隔离沙盒 + 本地 Mock HTTP Server + 零外网依赖 + 零真实身份信息）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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

function makeFakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.sig`;
}

async function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: bodyRaw
      });
      const auth = String(req.headers['authorization'] || '');
      const tok = auth.replace(/^Bearer\s+/i, '');

      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/v2/billing/meter/get-enterprise-user-usage') {
        if (!req.headers['x-enterprise-id'] || !req.headers['x-tenant-id']) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: 400, msg: 'missing enterprise headers' }));
          return;
        }
        if (tok === 'tok-finite') {
          res.end(JSON.stringify({
            code: 0,
            data: { limitNum: 2000, credit: 450.5, cycleResetTime: 1796083200000 }
          }));
          return;
        }
        if (tok === 'tok-unlim') {
          res.end(JSON.stringify({
            code: 0,
            data: { limitNum: -1, credit: 320, cycleEndTime: 1796083200 }
          }));
          return;
        }
        if (tok === 'tok-discover') {
          res.end(JSON.stringify({
            code: 0,
            data: { limitNum: 1000, credit: 100, cycleResetTime: 1796169600000 }
          }));
          return;
        }
      }

      if (req.url === '/v2/billing/meter/get-user-resource') {
        res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }));
        return;
      }

      if (req.url === '/v2/plugin/accounts') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            accounts: [
              {
                uid: 'uid-ent-disc',
                enterpriseId: 'ent-auto-002',
                enterpriseName: '示例科技Beta公司',
                type: 'ultimate',
                lastLogin: true
              }
            ]
          }
        }));
        return;
      }

      if (req.url === '/v2/billing/meter/checkin-activity-status') {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: 500, msg: 'enterprise no checkin' }));
        return;
      }

      if (req.url === '/v2/billing/meter/daily-checkin') {
        res.end(JSON.stringify({ code: 0, data: { credit: 30 } }));
        return;
      }

      if (req.url === '/billing/meter/get-user-request-usage') {
        if (!req.headers['x-enterprise-id'] || !req.headers['x-tenant-id']) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: 400, msg: 'missing enterprise headers' }));
          return;
        }
        res.end(JSON.stringify({
          code: 0,
          data: {
            total: 1,
            data: [{ requestId: 'req-ent-1', credit: 12.5, model: 'demo-model', client: 'ide', requestTime: '2026-11-23 10:00:00' }]
          }
        }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404 }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, requests };
}

async function main() {
  console.log('=== 开始企业版账号支持与防回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-ent-'));
  const { server, baseUrl, requests } = await startMockServer();

  try {
    const {
      extractEnterpriseInfo,
      isEnterpriseAccount,
      resolveEnterprisePaymentType,
      buildEnterpriseHeaders
    } = require(path.join(ROOT, 'out', 'domain.js'));
    const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
    const { CheckinService } = require(path.join(ROOT, 'out', 'checkinService.js'));
    const { UsageTracker } = require(path.join(ROOT, 'out', 'usageTracker.js'));
    const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));
    const { SeamlessSwitcher } = require(path.join(ROOT, 'out', 'seamlessSwitcher.js'));
    const { PATCH_V5 } = require(path.join(ROOT, 'out', 'constants.js'));
    const httpClient = require(path.join(ROOT, 'out', 'httpClient.js'));
    const { t } = require(path.join(ROOT, 'out', 'i18n', 'index.js'));

    // ── Group 1: domain.ts 企业身份解析与请求头构造 ───────────────────────────
    console.log('--- Group 1: domain 企业解析与请求头 ---');
    const entJwt = makeFakeJwt({ enterpriseId: 'ent-jwt-9', enterpriseName: '演示企业JWT', type: 'exclusive' });
    const jwtEnt = extractEnterpriseInfo({ accessToken: entJwt, domain: 'www.codebuddy.cn' });
    check(
      'JWT payload 提取 enterpriseId',
      jwtEnt.enterpriseId === 'ent-jwt-9',
      JSON.stringify(jwtEnt)
    );
    const profEnt = extractEnterpriseInfo({
      profileRaw: { enterpriseId: 'ent-prof-1', enterpriseName: '示例科技有限公司', type: 'ultimate' },
      paymentType: 'free'
    });
    check(
      'profileRaw 提取企业信息',
      profEnt.enterpriseId === 'ent-prof-1' && profEnt.enterpriseName === '示例科技有限公司' && profEnt.accountType === 'ultimate',
      JSON.stringify(profEnt)
    );
    check(
      'isEnterpriseAccount 准确区分企业与个人账号',
      isEnterpriseAccount({ enterpriseId: 'ent-1' }) === true &&
        isEnterpriseAccount({ profileRaw: { enterprise_id: 'ent-2' } }) === true &&
        isEnterpriseAccount({ accessToken: entJwt }) === true &&
        isEnterpriseAccount({ paymentType: 'free' }) === false &&
        isEnterpriseAccount({ profileRaw: { tenantId: 'personal' } }) === false
    );
    check(
      'resolveEnterprisePaymentType 映射 ultimate/exclusive/兜底 enterprise',
      resolveEnterprisePaymentType('ultimate', 'ent-1') === 'ultimate' &&
        resolveEnterprisePaymentType('exclusive', 'ent-1') === 'exclusive' &&
        resolveEnterprisePaymentType('member', 'ent-1') === 'enterprise'
    );
    const hdrs = buildEnterpriseHeaders('ent-hdr-77');
    check(
      'buildEnterpriseHeaders 输出双企业请求头',
      hdrs['X-Enterprise-Id'] === 'ent-hdr-77' && hdrs['X-Tenant-Id'] === 'ent-hdr-77' && Object.keys(buildEnterpriseHeaders('')).length === 0,
      JSON.stringify(hdrs)
    );

    // ── Group 2: CheckinService Mock HTTP 全流程验证 ───────────────────────────
    console.log('\n--- Group 2: CheckinService 企业额度与防误签 ---');
    const poolFile = path.join(tmpDir, 'accounts.json');
    const mockCtx = {
      globalStorageUri: { fsPath: tmpDir },
      globalState: { get: () => undefined, update: async () => {} }
    };
    const store = new AccountStore(mockCtx, poolFile);
    try {
      const checkinSvc = new CheckinService(baseUrl);

      // 2a. 有限额企业账号
      await store.upsert({
        id: 'id-ent-finite',
        uid: 'uid-ent-finite',
        email: '13900001111',
        nickname: '测试企业Alpha',
        accessToken: 'tok-finite',
        domain: 'www.codebuddy.cn',
        status: 'idle',
        enterpriseId: 'ent-alpha-01',
        enterpriseName: '示例科技有限公司',
        accountType: 'enterprise',
        paymentType: 'enterprise',
        totalCredits: 500
      });
      const accFinite = store.get('id-ent-finite');
      const finiteRes = await checkinSvc.syncAccountStatus(accFinite, store);
      const savedFinite = store.get(accFinite.id);
      check(
        '有限额企业账号查回 remain=limitNum-credit 并写入 resetAt 与 basePackage',
        approxEq(finiteRes?.totalCredits, 1549.5) &&
          approxEq(savedFinite?.totalCredits, 1549.5) &&
          savedFinite?.quotaUnlimited === false &&
          savedFinite?.quotaResetAt === 1796083200000 &&
          approxEq(savedFinite?.basePackage?.remain, 1549.5) &&
          approxEq(savedFinite?.basePackage?.total, 2000) &&
          approxEq(savedFinite?.basePackage?.percent, 77.5),
        JSON.stringify({ finiteRes, savedFinite })
      );

      // 2b. 不限额企业账号（验证从有 totalCredits 切换/刷新后能删除 totalCredits 键）
      await store.upsert({
        id: 'id-ent-unlim',
        uid: 'uid-ent-unlim',
        email: '13900002222',
        nickname: '测试企业无限',
        accessToken: 'tok-unlim',
        domain: 'www.codebuddy.cn',
        status: 'idle',
        enterpriseId: 'ent-unlim-01',
        enterpriseName: '示例无限企业',
        accountType: 'exclusive',
        paymentType: 'exclusive',
        totalCredits: 500
      });
      const accUnlim = store.get('id-ent-unlim');
      const unlimRes = await checkinSvc.syncAccountStatus(accUnlim, store);
      const savedUnlim = store.get(accUnlim.id);
      check(
        '不限额企业账号设置 quotaUnlimited=true 且清除 totalCredits，保留已用点数于 basePackage.remain',
        unlimRes?.totalCredits === 0 &&
          savedUnlim?.quotaUnlimited === true &&
          !('totalCredits' in savedUnlim) &&
          savedUnlim?.totalCredits === undefined &&
          approxEq(savedUnlim?.basePackage?.remain, 320) &&
          savedUnlim?.basePackage?.total === -1 &&
          savedUnlim?.basePackage?.percent === 100 &&
          Number(savedUnlim?.quotaResetAt) >= 1796083200000,
        JSON.stringify({ unlimRes, savedUnlim })
      );

      // 2c. 历史库导入账号无 enterpriseId -> 空包自动探测 GET /v2/plugin/accounts
      await store.upsert({
        id: 'id-ent-disc',
        uid: 'uid-ent-disc',
        email: '13900003333',
        nickname: '历史企业号',
        accessToken: 'tok-discover',
        domain: 'www.codebuddy.cn',
        status: 'idle',
        paymentType: 'free',
        totalCredits: 0
      });
      const accDiscover = store.get('id-ent-disc');
      const discRes = await checkinSvc.syncAccountStatus(accDiscover, store);
      const savedDisc = store.get(accDiscover.id);
      check(
        '空资源包自动探测企业身份并升级 paymentType=ultimate 与周期额度',
        approxEq(discRes?.totalCredits, 900) &&
          savedDisc?.enterpriseId === 'ent-auto-002' &&
          savedDisc?.enterpriseName === '示例科技Beta公司' &&
          savedDisc?.accountType === 'ultimate' &&
          savedDisc?.paymentType === 'ultimate' &&
          approxEq(savedDisc?.totalCredits, 900) &&
          savedDisc?.basePackage?.total === 1000,
        JSON.stringify({ discRes, savedDisc })
      );

      // 2d. 校验发往 get-enterprise-user-usage 的请求头完备，且 batchCheckin 跳过企业账号
      const usageReqs = requests.filter((r) => r.url === '/v2/billing/meter/get-enterprise-user-usage');
      const finiteReq = usageReqs.find((r) => r.headers['authorization'] === 'Bearer tok-finite');
      check(
        '企业额度请求携带 Authorization/X-User-Id/X-Enterprise-Id/X-Tenant-Id/X-Domain',
        Boolean(
          finiteReq &&
            finiteReq.headers['x-user-id'] === 'uid-ent-finite' &&
            finiteReq.headers['x-enterprise-id'] === 'ent-alpha-01' &&
            finiteReq.headers['x-tenant-id'] === 'ent-alpha-01' &&
            finiteReq.headers['x-domain'] === 'www.codebuddy.cn'
        ),
        JSON.stringify(finiteReq?.headers)
      );

      const batchCheckinRes = await checkinSvc.batchCheckin(store.getAll(), store);
      const dailyCheckinCalls = requests.filter((r) => r.url === '/v2/billing/meter/daily-checkin');
      check(
        'batchCheckin 跳过企业账号且零次调用 daily-checkin',
        dailyCheckinCalls.length === 0 &&
          batchCheckinRes.results.length === 3 &&
          batchCheckinRes.results.every((r) => r.success === true && r.alreadyCheckedIn === true && r.message === t('ci.skipEnterprise')),
        JSON.stringify(batchCheckinRes.results)
      );

      // ── Group 3: UsageTracker.fetchOfficialDaily 企业请求头 ─────────────────
      console.log('\n--- Group 3: UsageTracker 企业请求头 ---');
      const reqBeforeUt = requests.length;
      const usageDailyRes = await UsageTracker.fetchOfficialDaily('tok-finite', 'uid-ent-finite', '2026-11-23', 'ent-alpha-01', baseUrl);
      const utReq = requests.slice(reqBeforeUt).find((r) => r.url === '/billing/meter/get-user-request-usage');
      check(
        'UsageTracker.fetchOfficialDaily 转发 X-Enterprise-Id/X-Tenant-Id 并累计消耗',
        Boolean(
          usageDailyRes &&
            approxEq(usageDailyRes.consumed, 12.5) &&
            utReq?.headers?.['x-enterprise-id'] === 'ent-alpha-01' &&
            utReq?.headers?.['x-tenant-id'] === 'ent-alpha-01'
        ),
        JSON.stringify({ usageDailyRes, headers: utReq?.headers })
      );

      // ── Group 4: AutoSwitcher 无限额保护与探针路由 ─────────────────────────
      console.log('\n--- Group 4: AutoSwitcher 无限额优先与企业探针 ---');
      await store.upsert({
        id: 'id-personal-zero',
        uid: 'uid-personal-zero',
        email: '13900004444',
        nickname: '个人零额号',
        accessToken: 'tok-pzero',
        domain: 'www.codebuddy.cn',
        paymentType: 'free',
        status: 'idle',
        totalCredits: 0,
        basePackage: { title: '基础', count: 1, remain: 0, total: 500, percent: 0 },
        activityPackage: { title: '活动', count: 1, remain: 0, total: 3000, percent: 0 }
      });
      await store.setActive(accDiscover.id);

      const switcher = new AutoSwitcher(store, { switchAccount: async () => ({ success: true }) }, {}, { strategy: 'highest_quota' });
      const nextBest = switcher.getNextAvailableAccount(accDiscover.id);
      check(
        'highest_quota 策略下无限额企业账号满分(100%)优先被选为下一候选',
        nextBest?.id === accUnlim.id,
        JSON.stringify({ nextBestId: nextBest?.id, expectedId: accUnlim.id })
      );

      const probedCalls = [];
      const origHttpReq = httpClient.httpRequest;
      httpClient.httpRequest = async (url, opts) => {
        probedCalls.push({ url, headers: opts?.headers });
        return { status: 200, data: { code: 0, data: { limitNum: 2000, credit: 450 } } };
      };
      let probeEntRes = null;
      let probeIntlRes = null;
      try {
        probeEntRes = await switcher.probeAccount(savedFinite);
        probeIntlRes = await switcher.probeAccount({
          id: 'intl-1',
          uid: 'uid-intl',
          domain: 'www.codebuddy.ai',
          accessToken: 'tok-intl'
        });
      } finally {
        httpClient.httpRequest = origHttpReq;
      }
      check(
        'probeAccount 对企业账号路由至 ENTERPRISE_USER_USAGE 且带企业头，国际个人版安全跳过',
        probeEntRes?.valid === true &&
          probedCalls.length === 1 &&
          probedCalls[0].url.endsWith('/v2/billing/meter/get-enterprise-user-usage') &&
          probedCalls[0].headers['X-Enterprise-Id'] === 'ent-alpha-01' &&
          probeIntlRes?.valid === true &&
          probeIntlRes?.reason === 'intl_skip_probe',
        JSON.stringify({ probeEntRes, probedCalls, probeIntlRes })
      );

      // ── Group 5: SeamlessSwitcher 与 Patch v5 R6 ─────────────────────────
      console.log('\n--- Group 5: SeamlessSwitcher 与 PATCH_V5 R6 ---');
      const cmdFile = path.join(tmpDir, 'switch-cmd.json');
      const realSwitcher = new SeamlessSwitcher({ cmdPath: cmdFile });
      await realSwitcher.writeSwitchCommand(savedDisc, cmdFile);
      const writtenCmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
      check(
        'writeSwitchCommand 写入 enterpriseId/enterpriseName/type 至 session.account',
        writtenCmd?.session?.account?.enterpriseId === 'ent-auto-002' &&
          writtenCmd?.session?.account?.enterpriseName === '示例科技Beta公司' &&
          writtenCmd?.session?.account?.type === 'ultimate',
        JSON.stringify(writtenCmd?.session?.account)
      );
      check(
        'PATCH_V5 升级至 R6+ 并同步 genie.enterpriseId 与跨企业同 UID 检查',
        /^\/\*__BYOK_V5_R(?:[6-9]|\d{2,})__\*\/$/.test(PATCH_V5.V5_MARKER) &&
          PATCH_V5.WATCHER_METHODS.includes('genie.enterpriseId') &&
          PATCH_V5.WATCHER_METHODS.includes('curEnt===nextEnt')
      );

      // ── Group 6: SidebarProvider & StatusBarManager 集成与隐私脱敏 ─────────
      console.log('\n--- Group 6: SidebarProvider 透传与 StatusBar 隐私脱敏 ---');
      const statusItems = [];
      const mockVscode = {
        StatusBarAlignment: { Left: 1, Right: 2 },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        MarkdownString: class MarkdownString {
          constructor(v = '') { this.value = v; this.isTrusted = false; this.supportThemeIcons = false; }
          appendMarkdown(s) { this.value += s; return this; }
        },
        QuickPickItemKind: { Separator: -1 },
        env: { appName: 'CodeBuddy CN', appRoot: '', sessionId: 's1', language: 'zh-cn', clipboard: { writeText: async () => {} }, openExternal: async () => true },
        workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => ({ dispose: () => {} }) },
        window: {
          createStatusBarItem: () => {
            const it = { text: '', tooltip: '', command: '', color: undefined, backgroundColor: undefined, show() {}, dispose() {} };
            statusItems.push(it);
            return it;
          },
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
        await store.setActive(accFinite.id);
        await store.setPrivacyMode(false);

        const posted = [];
        const sp = new SidebarProvider({ fsPath: ROOT }, store, {}, {}, {}, {});
        sp._view = { webview: { postMessage: (m) => posted.push(m) } };
        sp.refreshUsageStats = () => {};
        sp.postStateToWebview();
        const webAccs = posted[0]?.data?.accounts || [];
        const webFinite = webAccs.find((a) => a.id === accFinite.id);
        const webUnlim = webAccs.find((a) => a.id === accUnlim.id);
        check(
          'SidebarProvider 向 Webview 透传 enterpriseId/enterpriseName/quotaUnlimited/quotaResetAt',
          Boolean(
            webFinite?.enterpriseId === 'ent-alpha-01' &&
              webFinite?.enterpriseName === '示例科技有限公司' &&
              webFinite?.quotaResetAt === 1796083200000 &&
              webUnlim?.quotaUnlimited === true
          ),
          JSON.stringify({ webFinite, webUnlim })
        );

        const sb = new StatusBarManager(store, {}, async () => {});
        const sbItem = statusItems[statusItems.length - 1];
        const tipOpen = sbItem?.tooltip?.value || '';
        await store.setPrivacyMode(true);
        sb.update();
        const tipMasked = sbItem?.tooltip?.value || '';
        await store.setPrivacyMode(false);
        await store.setActive(accUnlim.id);
        sb.update();
        const textUnlim = sbItem?.text || '';
        sb.dispose();
        sp.dispose();

        check(
          'StatusBar 非隐私含所属企业，隐私模式下脱敏企业名称/UID且无逗号分隔',
          tipOpen.includes('示例科技有限公司') &&
            !tipMasked.includes('示例科技有限公司') &&
            !tipMasked.includes('uid-ent-finite') &&
            !/\d,\d{3}/.test(tipOpen) &&
            textUnlim.includes(t('status.unlimited')),
          JSON.stringify({ tipOpen, tipMasked, textUnlim })
        );
      } finally {
        Module._load = origLoad;
      }
    } finally {
      store.dispose();
    }

    console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      console.log('失败明细:');
      for (const f of failures) console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
      process.exit(1);
    }
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
