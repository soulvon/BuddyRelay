#!/usr/bin/env node
/**
 * 个人账号额度刷新全链路离线回归测试
 * 覆盖：
 *  1. CodeBuddy 5.0.0 新聚合接口 /billing/meter/get-user-resource-summary 优先解析
 *  2. 个人账号解绑国内签到接口强依赖（checkin-activity-status 500 不阻断额度写入、不抹掉已签状态）
 *  3. 过期/401 个人账号经 refreshToken 自动续期救活，真正失效标 expired 并明确报错
 *  4. AutoSwitcher.runHealthCycle 对 remainingMs <= 0 已过期账号续期与失败 10 分钟退避
 *  5. 国际版个人账号（www.codebuddy.ai）开放额度刷新且不误打国内签到接口
 *  6. 同手机号「个人 + 企业」双账号严格防串企，0 包个人号如实更新为 0
 *  7. 新聚合接口 404 时平滑降级旧 /v2/billing/meter/get-user-resource，以及 batchSyncStatusDetailed 失败透出
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

async function startMockServer() {
  const reqs = [];
  const state = {
    summary404For: new Set(),
    checkinShould500: false,
    refreshCalls: 0,
    accountsListCalls: 0
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = String(req.headers['authorization'] || '');
      const tok = auth.replace(/^Bearer\s+/i, '');
      const refreshTok = String(req.headers['x-refresh-token'] || '');
      reqs.push({ method: req.method, url: req.url, tok, refreshTok, headers: { ...req.headers } });
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/v2/plugin/auth/token/refresh') {
        state.refreshCalls++;
        if (refreshTok === 'ref-valid' || refreshTok === 'ref-401-retry' || refreshTok === 'ref-auto-ok') {
          res.end(JSON.stringify({
            code: 0,
            data: { accessToken: 'tok-refreshed-ok', refreshToken: refreshTok + '-next', expiresIn: 7200 }
          }));
          return;
        }
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 401, msg: 'refresh token expired' }));
        return;
      }

      if (req.url === '/billing/meter/get-user-resource-summary') {
        if (tok === 'tok-quota-500') {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, msg: 'quota service unavailable' }));
          return;
        }
        if (state.summary404For.has(tok)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 404, msg: 'not found' }));
          return;
        }
        if (tok === 'tok-expired-401' || tok === 'tok-dead-401') {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: 401, msg: 'token expired' }));
          return;
        }
        if (tok === 'tok-summary-cn') {
          res.end(JSON.stringify({
            code: 0,
            data: {
              Packages: [
                { PackageCode: 'TCACA_code_008_cfWoLwvjU4', CycleTotalCapacity: '500', CycleRemainCapacity: '0', CycleUsedCapacity: '500', TotalCount: 1 },
                { PackageCode: 'TCACA_code_007_nzdH5h4Nl0', CycleTotalCapacity: '3275', CycleRemainCapacity: '1475.97000351', CycleUsedCapacity: '1799.02999649', TotalCount: 54 }
              ],
              TotalCredits: '1475.97000351',
              SubscriptionPackageCode: '',
              IsPaidUser: false
            }
          }));
          return;
        }
        if (tok === 'tok-refreshed-ok') {
          res.end(JSON.stringify({
            code: 0,
            data: {
              Packages: [
                { PackageCode: 'TCACA_code_002_AkiJS3ZHF5', CycleTotalCapacity: '2000', CycleRemainCapacity: '1800.5', CycleUsedCapacity: '199.5', TotalCount: 1 }
              ],
              TotalCredits: '1800.5',
              SubscriptionPackageCode: 'TCACA_code_002_AkiJS3ZHF5',
              IsPaidUser: true
            }
          }));
          return;
        }
        if (tok === 'tok-intl-personal') {
          res.end(JSON.stringify({
            code: 0,
            data: {
              Packages: [
                { PackageCode: 'TCACA_code_035_ArVxJcGDsm', CycleTotalCapacity: '200', CycleRemainCapacity: '120', CycleUsedCapacity: '80', TotalCount: 1 },
                { PackageCode: 'TCACA_code_036_lupO5WgNdG', CycleTotalCapacity: '100', CycleRemainCapacity: '80', CycleUsedCapacity: '20', TotalCount: 1 }
              ],
              TotalCredits: '200',
              IsPaidUser: false
            }
          }));
          return;
        }
        if (tok === 'tok-empty-personal' || tok === 'tok-empty-legacy-personal') {
          res.end(JSON.stringify({ code: 0, data: { Packages: [], TotalCredits: '0', IsPaidUser: false } }));
          return;
        }
      }

      if (req.url === '/v2/billing/meter/get-user-resource') {
        if (tok === 'tok-quota-500') {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, msg: 'legacy quota service unavailable' }));
          return;
        }
        if (tok === 'tok-legacy-fallback') {
          res.end(JSON.stringify({
            code: 0,
            data: {
              Response: {
                Data: {
                  Accounts: [
                    { PackageCode: 'TCACA_code_008_cfWoLwvjU4', PackageName: '基础体验包', CycleCapacityRemainPrecise: '120', CycleCapacitySizePrecise: '500' },
                    { PackageCode: 'TCACA_code_007_nzdH5h4Nl0', PackageName: '活动赠送包', CycleCapacityRemainPrecise: '330.25', CycleCapacitySizePrecise: '600' }
                  ]
                }
              }
            }
          }));
          return;
        }
        res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }));
        return;
      }

      if (req.url === '/v2/plugin/accounts') {
        state.accountsListCalls++;
        res.end(JSON.stringify({
          code: 0,
          data: {
            accounts: [
              { uid: 'uid-dual-personal', type: 'personal', pluginEnabled: true },
              { uid: 'uid-dual-legacy', type: 'personal', pluginEnabled: true },
              { uid: 'uid-dual-ent', enterpriseId: 'ent-same-phone-99', enterpriseName: '同手机号企业', type: 'enterprise', pluginEnabled: true }
            ]
          }
        }));
        return;
      }

      if (req.url === '/v2/billing/meter/get-enterprise-user-usage') {
        if (tok === 'tok-ent-ok') {
          res.end(JSON.stringify({ code: 0, data: { limitNum: 1000, credit: 250 } }));
          return;
        }
        res.statusCode = 403;
        res.end(JSON.stringify({ code: 403, msg: 'forbidden' }));
        return;
      }

      if (req.url === '/v2/billing/meter/checkin-activity-status' || req.url === '/v2/billing/meter/checkin-status') {
        if (state.checkinShould500) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 500, msg: 'checkin activity maintenance' }));
          return;
        }
        res.end(JSON.stringify({ code: 0, data: { active: true, today_checked_in: true, streak_days: 15, daily_credit: 100, total_credits: 1500 } }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404 }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, reqs, state };
}

async function main() {
  console.log('=== 开始个人账号额度刷新全链路离线回归测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-personal-quota-'));
  const prevMasterEnv = process.env.BUDDYRELAY_MASTER_KEY_FILE;
  process.env.BUDDYRELAY_MASTER_KEY_FILE = path.join(tmpDir, 'master.key');

  const { server, baseUrl, reqs, state } = await startMockServer();
  const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
  const { CheckinService } = require(path.join(ROOT, 'out', 'checkinService.js'));
  const { OAuthService } = require(path.join(ROOT, 'out', 'oauthService.js'));
  const { AutoSwitcher } = require(path.join(ROOT, 'out', 'autoSwitcher.js'));

  const store = new AccountStore(undefined, path.join(tmpDir, 'pool.json'));
  const oauth = new OAuthService(baseUrl);
  const svc = new CheckinService(baseUrl, oauth);

  try {
    // ── 1. 5.0.0 新聚合接口优先 ──────────────────────────────────────────────
    console.log('[1/7] CodeBuddy 5.0.0 新聚合接口 get-user-resource-summary');
    await store.upsert({
      id: 'p-sum-1', uid: 'uid-sum-1', email: '13800000001', nickname: '个人聚合号',
      accessToken: 'tok-summary-cn', refreshToken: 'ref-valid', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'active', totalCredits: 100, createdAt: 1, lastUsed: 1
    });
    const reqIdxBefore1 = reqs.length;
    const r1 = await svc.syncAccountStatus(store.get('p-sum-1'), store);
    const s1 = store.get('p-sum-1');
    const hitLegacy1 = reqs.slice(reqIdxBefore1).some((r) => r.url === '/v2/billing/meter/get-user-resource');
    check(
      '新聚合接口精准写入 1475.97 / 54 个活动包且无需再打旧分页接口',
      approxEq(r1.totalCredits, 1475.97) && approxEq(s1.totalCredits, 1475.97) &&
        s1.basePackage?.total === 500 && s1.activityPackage?.count === 54 && !hitLegacy1,
      JSON.stringify({ r1, s1: { totalCredits: s1.totalCredits, base: s1.basePackage, act: s1.activityPackage }, hitLegacy1 })
    );

    // ── 2. 个人号解绑签到状态接口强依赖 ───────────────────────────────────────
    console.log('\n[2/7] 个人号解绑签到接口强依赖');
    state.checkinShould500 = true;
    await store.updateAccountFields('p-sum-1', { todayCheckedIn: true, checkinStreak: 12, lastCheckinDate: '2026-11-27', totalCredits: 50 });
    const r2 = await svc.syncAccountStatus(store.get('p-sum-1'), store);
    const s2 = store.get('p-sum-1');
    check(
      '签到接口 500 时个人号依然成功写入最新额度 1475.97 且保留原已签状态与连签天数',
      approxEq(r2.totalCredits, 1475.97) && approxEq(s2.totalCredits, 1475.97) &&
        s2.todayCheckedIn === true && s2.checkinStreak === 12,
      JSON.stringify({ r2, s2: { totalCredits: s2.totalCredits, todayCheckedIn: s2.todayCheckedIn, streak: s2.checkinStreak } })
    );
    state.checkinShould500 = false;

    // ── 3. 过期个人号 & 401 自动续期救活，真正失效标 expired ──────────────────
    console.log('\n[3/7] 过期与 401 个人账号自动续期救活');
    await store.upsert({
      id: 'p-exp-1', uid: 'uid-exp-1', email: '13800000002', nickname: '过期可续期号',
      accessToken: 'tok-expired-401', refreshToken: 'ref-valid', tokenType: 'Bearer',
      expiresAt: Date.now() - 3600_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'expired', totalCredits: 10, createdAt: 2, lastUsed: 2
    });
    const r3a = await svc.syncAccountStatus(store.get('p-exp-1'), store);
    const s3a = store.get('p-exp-1');
    check(
      '已过期个人号自动续期并拉回最新额度 1800.5、推断 paymentType=pro、恢复 idle',
      approxEq(r3a.totalCredits, 1800.5) && approxEq(s3a.totalCredits, 1800.5) &&
        s3a.accessToken === 'tok-refreshed-ok' && s3a.status === 'idle' && s3a.paymentType === 'pro',
      JSON.stringify({ status: s3a.status, credits: s3a.totalCredits, pay: s3a.paymentType, tok: s3a.accessToken })
    );

    await store.upsert({
      id: 'p-401-retry', uid: 'uid-401-retry', email: '13800000003', nickname: '遇401自动重试号',
      accessToken: 'tok-expired-401', refreshToken: 'ref-401-retry', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 0, createdAt: 3, lastUsed: 3
    });
    const r3b = await svc.syncAccountStatus(store.get('p-401-retry'), store);
    check(
      '未到本地过期时间但服务端返 401 时自动续期并重试拉回 1800.5',
      approxEq(r3b.totalCredits, 1800.5) && store.get('p-401-retry').accessToken === 'tok-refreshed-ok',
      JSON.stringify({ r3b })
    );

    await store.upsert({
      id: 'p-dead', uid: 'uid-dead', email: '13800000004', nickname: '彻底失效号',
      accessToken: 'tok-dead-401', refreshToken: 'ref-invalid', tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 99, createdAt: 4, lastUsed: 4
    });
    let deadErr = null;
    try { await svc.syncAccountStatus(store.get('p-dead'), store); } catch (e) { deadErr = e; }
    check(
      '401 且 refreshToken 也失效时标为 expired 并抛出明确登录过期错误',
      Boolean(deadErr) && store.get('p-dead').status === 'expired',
      JSON.stringify({ err: deadErr?.message, status: store.get('p-dead').status })
    );

    // ── 4. AutoSwitcher.runHealthCycle 解除 remainingMs > 0 死锁与失败退避 ────
    console.log('\n[4/7] AutoSwitcher.runHealthCycle 过期续期与失败退避');
    await store.upsert({
      id: 'p-auto-exp', uid: 'uid-auto-exp', email: '13800000005', nickname: '后台过期续期号',
      accessToken: 'tok-old', refreshToken: 'ref-auto-ok', tokenType: 'Bearer',
      expiresAt: Date.now() - 10_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'expired', totalCredits: 50, createdAt: 5, lastUsed: 5
    });
    await store.upsert({
      id: 'p-auto-fail', uid: 'uid-auto-fail', email: '13800000006', nickname: '后台续期失败号',
      accessToken: 'tok-old', refreshToken: 'ref-bad-auto', tokenType: 'Bearer',
      expiresAt: Date.now() - 10_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 50, createdAt: 6, lastUsed: 6
    });
    const autoSw = new AutoSwitcher(store, undefined, oauth);
    const cyc1 = await autoSw.runHealthCycle();
    const callsAfterCyc1 = state.refreshCalls;
    await autoSw.runHealthCycle();
    const callsAfterCyc2 = state.refreshCalls;
    check(
      'runHealthCycle 自动续期已过期账号并恢复 idle，失败账号进入 10 分钟退避不再重复请求',
      cyc1.refreshedCount >= 1 && store.get('p-auto-exp').accessToken === 'tok-refreshed-ok' &&
        store.get('p-auto-exp').status === 'idle' && callsAfterCyc2 === callsAfterCyc1,
      JSON.stringify({ cyc1, status: store.get('p-auto-exp').status, callsAfterCyc1, callsAfterCyc2 })
    );

    // ── 5. 国际版个人账号开放额度刷新且不打国内签到接口 ──────────────────────
    console.log('\n[5/7] 国际版个人账号刷新额度');
    await store.upsert({
      id: 'p-intl-1', uid: 'uid-intl-1', email: 'intl@example.com', nickname: '国际个人号',
      accessToken: 'tok-intl-personal', refreshToken: '', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.ai', accountType: 'personal',
      status: 'idle', totalCredits: 0, createdAt: 7, lastUsed: 7
    });
    const idxBeforeIntl = reqs.length;
    const r5 = await svc.syncAccountStatus(store.get('p-intl-1'), store);
    const hitCheckinIntl = reqs.slice(idxBeforeIntl).some((r) => r.url.includes('checkin'));
    check(
      '国际版个人号成功拉取 200 额度且不调用国内签到接口',
      approxEq(r5.totalCredits, 200) && approxEq(store.get('p-intl-1').totalCredits, 200) && !hitCheckinIntl,
      JSON.stringify({ r5, hitCheckinIntl })
    );

    // ── 6. 同手机号「个人 + 企业」双账号防串企 + 0 包如实写 0 ──────────────────
    console.log('\n[6/7] 同手机号个人+企业防串企与 0 包处理');
    const accCallsBefore6a = state.accountsListCalls;
    await store.upsert({
      id: 'p-dual-explicit', uid: 'uid-dual-personal', email: '13999990000', nickname: '显式个人0包',
      accessToken: 'tok-empty-personal', refreshToken: '', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 88, createdAt: 8, lastUsed: 8
    });
    const r6a = await svc.syncAccountStatus(store.get('p-dual-explicit'), store);
    const s6a = store.get('p-dual-explicit');
    check(
      '显式个人号遇空包不查 /v2/plugin/accounts、不被企业号污染，并如实更新为 0 额度',
      state.accountsListCalls === accCallsBefore6a && !s6a.enterpriseId && approxEq(r6a.totalCredits, 0) && approxEq(s6a.totalCredits, 0),
      JSON.stringify({ accountsListCalls: state.accountsListCalls - accCallsBefore6a, ent: s6a.enterpriseId, credits: s6a.totalCredits })
    );

    await store.upsert({
      id: 'p-dual-legacy', uid: 'uid-dual-legacy', email: '13999990000', nickname: '老导入无type个人号',
      accessToken: 'tok-empty-legacy-personal', refreshToken: '', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn',
      status: 'idle', totalCredits: 66, createdAt: 9, lastUsed: 9
    });
    const r6b = await svc.syncAccountStatus(store.get('p-dual-legacy'), store);
    const s6b = store.get('p-dual-legacy');
    check(
      '无 accountType 的同手机号个人号查回同 UID 个人条目时绝不串企，如实写 0 额度',
      !s6b.enterpriseId && approxEq(r6b.totalCredits, 0) && approxEq(s6b.totalCredits, 0),
      JSON.stringify({ ent: s6b.enterpriseId, credits: s6b.totalCredits })
    );

    // ── 7. 新接口 404 平滑降级旧接口 + batchSyncStatusDetailed 失败汇总 ───────
    console.log('\n[7/7] 新接口 404 降级旧接口与批量刷新失败透出');
    state.summary404For.add('tok-legacy-fallback');
    await store.upsert({
      id: 'p-legacy-fb', uid: 'uid-legacy-fb', email: '13800000009', nickname: '降级旧接口号',
      accessToken: 'tok-legacy-fallback', refreshToken: '', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 0, createdAt: 10, lastUsed: 10
    });
    const r7a = await svc.syncAccountStatus(store.get('p-legacy-fb'), store);
    check(
      'get-user-resource-summary 返回 404 时平滑降级到 get-user-resource 得到 450.25',
      approxEq(r7a.totalCredits, 450.25) && approxEq(store.get('p-legacy-fb').totalCredits, 450.25),
      JSON.stringify({ r7a })
    );

    const batchList = [
      {
        id: 'b-ent', uid: 'u-b-ent', email: 'ent@corp', nickname: '企业正常号',
        accessToken: 'tok-ent-ok', refreshToken: '', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', enterpriseId: 'ent-b-1',
        status: 'idle', createdAt: 11, lastUsed: 11
      },
      {
        id: 'b-exp-save', uid: 'u-b-exp', email: 'exp@cn', nickname: '过期可救活号',
        accessToken: 'tok-expired-401', refreshToken: 'ref-valid', tokenType: 'Bearer',
        expiresAt: Date.now() - 5000, domain: 'www.codebuddy.cn', accountType: 'personal',
        status: 'expired', createdAt: 12, lastUsed: 12
      },
      {
        id: 'b-dead', uid: 'u-b-dead', email: 'dead@cn', nickname: '彻底失效无ref号',
        accessToken: 'tok-dead-401', refreshToken: '', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', accountType: 'personal',
        status: 'idle', createdAt: 13, lastUsed: 13
      },
      {
        id: 'b-dis', uid: 'u-b-dis', email: 'dis@cn', nickname: '已停用号',
        accessToken: 'tok-summary-cn', refreshToken: '', tokenType: 'Bearer',
        expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn',
        status: 'disabled', createdAt: 14, lastUsed: 14
      }
    ];
    const batchRep = await svc.batchSyncStatusDetailed(batchList);
    check(
      'batchSyncStatusDetailed 救活过期可续期号、跳过停用号并准确汇总 1 条失败明细',
      batchRep.synced === 2 && batchRep.skipped === 1 && batchRep.failed === 1 && batchRep.errors.length === 1,
      JSON.stringify(batchRep)
    );

    await store.upsert({
      id: 'p-q500', uid: 'uid-q500', email: 'q500@cn', nickname: '额度双500号',
      accessToken: 'tok-quota-500', refreshToken: '', tokenType: 'Bearer',
      expiresAt: Date.now() + 7200_000, domain: 'www.codebuddy.cn', accountType: 'personal',
      status: 'idle', totalCredits: 123, createdAt: 15, lastUsed: 15
    });
    let q500Err = null;
    try { await svc.syncAccountStatus(store.get('p-q500'), store); } catch (e) { q500Err = e; }
    check(
      '个人号双额度接口 500 报错时即使签到接口 200 也必须抛错不假成功且保留原余额',
      Boolean(q500Err && /unavailable|500/i.test(q500Err.message)) && approxEq(store.get('p-q500').totalCredits, 123),
      JSON.stringify({ err: q500Err?.message, credits: store.get('p-q500').totalCredits })
    );
  } finally {
    store.dispose();
    await new Promise((r) => server.close(r));
    if (prevMasterEnv === undefined) delete process.env.BUDDYRELAY_MASTER_KEY_FILE;
    else process.env.BUDDYRELAY_MASTER_KEY_FILE = prevMasterEnv;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败明细:');
    for (const f of failures) console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
