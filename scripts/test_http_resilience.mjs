#!/usr/bin/env node
/**
 * httpClient 代理穿透、瞬断重试、AggregateError 格式化与 UsageTracker 收口离线回归测试
 * （全隔离本地 Mock Server / Mock Proxy + 零外网依赖 + 零私钥字面量）
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import Module from 'node:module';
import net from 'node:net';
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

/** 构造内存自签 X.509 DER 证书与私钥（避免源码出现 PEM 私钥字面量触发安全门控） */
function createInMemoryTlsCreds(cn = '127.0.0.1') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const derLen = (n) => {
    if (n < 128) return Buffer.from([n]);
    const bytes = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const tag = (t, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([t]), derLen(body.length), body]);
  };
  const oid = (nums) => {
    const out = [nums[0] * 40 + nums[1]];
    for (let i = 2; i < nums.length; i++) {
      let v = nums[i];
      const seg = [v & 0x7f];
      v >>= 7;
      while (v > 0) {
        seg.unshift((v & 0x7f) | 0x80);
        v >>= 7;
      }
      out.push(...seg);
    }
    return tag(0x06, Buffer.from(out));
  };
  const utf8 = (s) => tag(0x0c, Buffer.from(s, 'utf8'));
  const utc = (d) => tag(0x17, Buffer.from(d, 'ascii'));
  const algId = tag(0x30, oid([1, 2, 840, 113549, 1, 1, 11]), tag(0x05));
  const name = tag(0x30, tag(0x31, tag(0x30, oid([2, 5, 4, 3]), utf8(cn))));
  const validity = tag(0x30, utc('250101000000Z'), utc('350101000000Z'));
  const tbs = tag(
    0x30,
    tag(0xa0, tag(0x02, Buffer.from([2]))),
    tag(0x02, crypto.randomBytes(8).map((b, i) => (i === 0 ? b & 0x7f : b))),
    algId,
    name,
    validity,
    name,
    spkiDer
  );
  const sig = crypto.sign('RSA-SHA256', tbs, privateKey);
  const certDer = tag(0x30, tbs, algId, tag(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const cert = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { cert, key };
}

function listenServer(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

async function main() {
  console.log('=== 开始 BuddyRelay 网络弹性与代理穿透测试 ===\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-http-resilience-'));
  const savedEnv = { ...process.env };
  const servers = [];

  try {
    const httpClient = require(path.join(ROOT, 'out', 'httpClient.js'));
    const { UsageTracker } = require(path.join(ROOT, 'out', 'usageTracker.js'));

    // ── 1. formatNetworkError & AggregateError ───────────────────────────────
    console.log('[1/8] AggregateError 与错误格式化');
    const hasFormat = typeof httpClient.formatNetworkError === 'function';
    check('httpClient 导出 formatNetworkError', hasFormat);
    if (hasFormat) {
      const sub1 = Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT', address: '1.2.3.4', port: 443 });
      const sub2 = Object.assign(new Error(''), { code: 'ENETUNREACH', address: '::1', port: 443 });
      const agg = new AggregateError([sub1, sub2], '');
      const formatted = httpClient.formatNetworkError(agg);
      check(
        'formatNetworkError 展开空消息 AggregateError 并保留子错误码',
        formatted.includes('ETIMEDOUT') && formatted.includes('ENETUNREACH') && formatted.length > 10,
        formatted
      );
    }

    // ── 2. NO_PROXY 与回环地址判定 ────────────────────────────────────────────
    console.log('\n[2/8] resolveProxyForUrl / NO_PROXY / 回环判定');
    const hasResolveProxy = typeof httpClient.resolveProxyForUrl === 'function';
    check('httpClient 导出 resolveProxyForUrl 与 isNoProxyMatch', hasResolveProxy && typeof httpClient.isNoProxyMatch === 'function');
    if (hasResolveProxy) {
      const envProxy = { HTTPS_PROXY: 'http://user:pass@proxy.local:8888', NO_PROXY: '.internal.corp,exact.host' };
      const pNormal = httpClient.resolveProxyForUrl(new URL('https://www.codebuddy.cn/v2/test'), { env: envProxy });
      const pSub = httpClient.resolveProxyForUrl(new URL('https://api.internal.corp/v1'), { env: envProxy });
      const pExact = httpClient.resolveProxyForUrl(new URL('https://exact.host/v1'), { env: envProxy });
      const pLoop = httpClient.resolveProxyForUrl(new URL('http://127.0.0.1:9999/test'), { env: envProxy });
      check(
        '正常公网域名命中 HTTPS_PROXY，子域/精确 NO_PROXY 与回环地址跳过代理',
        Boolean(pNormal && pNormal.proxyUrl.hostname === 'proxy.local' && !pSub && !pExact && !pLoop),
        JSON.stringify({ pNormal: pNormal?.proxyUrl?.href, pSub, pExact, pLoop })
      );
    }

    // ── 3. HTTP 目标经本地 HTTP Proxy + Proxy-Authorization ────────────────────
    console.log('\n[3/8] HTTP 目标经本地代理转发与鉴权');
    const proxyRequests = [];
    const targetHits = [];
    const targetHttpServer = http.createServer((req, res) => {
      targetHits.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'target' }));
    });
    servers.push(targetHttpServer);
    const targetHostPort = await listenServer(targetHttpServer);

    const proxyServer = http.createServer((req, res) => {
      proxyRequests.push({ method: req.method, url: req.url, proxyAuth: req.headers['proxy-authorization'] || '' });
      const parsed = new URL(req.url);
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders['proxy-authorization'];
      const fwd = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers: fwdHeaders
        },
        (tRes) => {
          res.writeHead(tRes.statusCode || 502, tRes.headers);
          tRes.pipe(res);
        }
      );
      fwd.on('error', (err) => {
        res.statusCode = 502;
        res.end(err.message);
      });
      req.pipe(fwd);
    });
    const connectRequests = [];
    let rejectConnectWith407 = false;
    proxyServer.on('connect', (req, clientSocket, head) => {
      connectRequests.push({ url: req.url, proxyAuth: req.headers['proxy-authorization'] || '' });
      if (rejectConnectWith407) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
        clientSocket.end();
        return;
      }
      const [h, p] = req.url.split(':');
      const serverSocket = net.connect(Number(p) || 443, h, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });
      serverSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => serverSocket.destroy());
    });
    servers.push(proxyServer);
    const proxyHostPort = await listenServer(proxyServer);
    const proxyAuthUrl = `http://alice:s%40cret@${proxyHostPort}`;

    const httpViaProxy = await httpClient.httpJsonRequest(`http://${targetHostPort}/api/ping`, {
      proxy: proxyAuthUrl,
      timeout: 5000,
      retries: 0
    });
    const expectedAuth = 'Basic ' + Buffer.from('alice:s@cret').toString('base64');
    check(
      'HTTP 请求经显式代理转发成功并携带正确 Proxy-Authorization',
      httpViaProxy?.ok === true &&
        proxyRequests.length === 1 &&
        proxyRequests[0].url === `http://${targetHostPort}/api/ping` &&
        proxyRequests[0].proxyAuth === expectedAuth,
      JSON.stringify({ httpViaProxy, proxyRequests })
    );

    // ── 4. HTTPS 目标经代理 CONNECT 隧道 + 407 拒连不重试 ─────────────────────
    console.log('\n[4/8] HTTPS 目标经代理 CONNECT 隧道与 407 拒绝不重试');
    const creds = createInMemoryTlsCreds('127.0.0.1');
    const httpsTarget = https.createServer({ cert: creds.cert, key: creds.key }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tls: true, url: req.url }));
    });
    servers.push(httpsTarget);
    const httpsHostPort = await listenServer(httpsTarget);

    // 使用 mock vscode 注入 proxyStrictSSL: false 以允许本地内存自签证书
    const origLoad = Module._load;
    let mockProxyConfig = {
      'http.proxy': proxyAuthUrl,
      'http.proxySupport': 'on',
      'http.proxyStrictSSL': false,
      'http.noProxy': []
    };
    const mockVscode = {
      workspace: {
        getConfiguration: (section) => ({
          get: (k, def) => {
            const full = `${section}.${k}`;
            return Object.prototype.hasOwnProperty.call(mockProxyConfig, full) ? mockProxyConfig[full] : def;
          }
        })
      }
    };
    Module._load = function (request) {
      if (request === 'vscode') return mockVscode;
      return origLoad.apply(this, arguments);
    };
    try {
      // 仅在显式 proxy 且 rejectUnauthorized=false 时放行自签；这里通过 env 清空后走 vscode http.proxy
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.http_proxy;
      delete process.env.https_proxy;
      delete process.env.all_proxy;

      // 注意：127.0.0.1 默认视为回环绕过，显式 proxy 强制经 CONNECT 隧道验证，此时通过 vscode 配置读取 strictSSL=false
      const httpsRes = await httpClient.httpJsonRequest(`https://${httpsHostPort}/tunnel-ok`, {
        proxy: proxyAuthUrl,
        timeout: 5000,
        retries: 0
      });
      check(
        'HTTPS 请求经 CONNECT 隧道完成 TLS 握手并收到 JSON 响应',
        httpsRes?.ok === true &&
          httpsRes?.tls === true &&
          connectRequests.some((c) => c.url === httpsHostPort && c.proxyAuth === expectedAuth),
        JSON.stringify({ httpsRes, connectRequests })
      );

      // 测试 407 拒连时即使 retries: 2 也不应重试
      const prevConnects = connectRequests.length;
      rejectConnectWith407 = true;
      let err407 = null;
      try {
        await httpClient.httpJsonRequest(`https://${httpsHostPort}/auth-fail`, {
          proxy: proxyAuthUrl,
          timeout: 5000,
          retries: 2,
          retryDelayMs: 20
        });
      } catch (e) {
        err407 = e;
      } finally {
        rejectConnectWith407 = false;
      }
      check(
        '代理 CONNECT 返回 407 立即失败且不触发重试',
        Boolean(err407 && /407/.test(err407.message) && connectRequests.length - prevConnects === 1),
        JSON.stringify({ msg: err407?.message, attempts: connectRequests.length - prevConnects })
      );

      // 测试 VS Code http.proxy 兜底与 proxySupport='off' 禁用
      mockProxyConfig['http.proxy'] = `http://${proxyHostPort}`;
      mockProxyConfig['http.proxySupport'] = 'on';
      const vsProxy = hasResolveProxy
        ? httpClient.resolveProxyForUrl(new URL('https://www.codebuddy.cn/v2/test'), { env: {} })
        : null;
      mockProxyConfig['http.proxySupport'] = 'off';
      const vsProxyOff = hasResolveProxy
        ? httpClient.resolveProxyForUrl(new URL('https://www.codebuddy.cn/v2/test'), { env: {} })
        : null;
      check(
        'VS Code http.proxy 兜底生效且 http.proxySupport="off" 时禁用代理',
        Boolean(vsProxy && vsProxy.source === 'vscode' && vsProxy.rejectUnauthorized === false && !vsProxyOff),
        JSON.stringify({ vsProxy: vsProxy?.source, vsProxyOff })
      );
    } finally {
      Module._load = origLoad;
    }

    // ── 5. 瞬时断连 ECONNRESET 与 503 重试（幂等 vs 非幂等）─────────────────────
    console.log('\n[5/8] 瞬断 ECONNRESET 与 503 重试策略');
    let getResetCount = 0;
    let postResetCount = 0;
    let postReadonly503Count = 0;
    const flakyServer = http.createServer((req, res) => {
      if (req.url === '/flaky-get') {
        getResetCount++;
        if (getResetCount < 3) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, attempts: getResetCount }));
        return;
      }
      if (req.url === '/flaky-post-default') {
        postResetCount++;
        req.socket.destroy();
        return;
      }
      if (req.url === '/flaky-post-readonly') {
        postReadonly503Count++;
        if (postReadonly503Count < 3) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 503, msg: 'busy' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, attempts: postReadonly503Count }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(flakyServer);
    const flakyHostPort = await listenServer(flakyServer);

    const getRes = await httpClient.httpJsonRequest(`http://${flakyHostPort}/flaky-get`, {
      proxy: false,
      timeout: 3000,
      retryDelayMs: 20
    });
    check(
      'GET 遇两次 ECONNRESET 自动重试至第 3 次成功',
      getRes?.ok === true && getResetCount === 3,
      JSON.stringify({ getRes, getResetCount })
    );

    let postDefaultErr = null;
    try {
      await httpClient.httpJsonRequest(`http://${flakyHostPort}/flaky-post-default`, {
        method: 'POST',
        body: { a: 1 },
        proxy: false,
        timeout: 3000,
        retryDelayMs: 20
      });
    } catch (e) {
      postDefaultErr = e;
    }
    check(
      'POST 默认 retries=0 遇断连绝不重放写请求 (hits=1)',
      Boolean(postDefaultErr && postResetCount === 1),
      JSON.stringify({ err: postDefaultErr?.message, postResetCount })
    );

    const postReadonlyRes = await httpClient.httpRequest(`http://${flakyHostPort}/flaky-post-readonly`, {
      method: 'POST',
      body: {},
      proxy: false,
      timeout: 3000,
      retries: 2,
      retryDelayMs: 20
    });
    check(
      '只读 POST 显式 retries:2 遇 503 自动退避重试至第 3 次成功',
      postReadonlyRes.status === 200 && postReadonlyRes.data?.code === 0 && postReadonly503Count === 3,
      JSON.stringify({ status: postReadonlyRes.status, data: postReadonlyRes.data, postReadonly503Count })
    );

    // ── 6. downloadToFile 503 重试与代理下载 + 零残留临时文件 ──────────────────
    console.log('\n[6/8] downloadToFile 503 重试与经代理下载');
    let dlAttempts = 0;
    const dlServer = http.createServer((req, res) => {
      if (req.url === '/file.vsix') {
        dlAttempts++;
        if (dlAttempts === 1) {
          res.writeHead(503);
          res.end('temporary unavailable');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('VSIX_PAYLOAD_OK');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    servers.push(dlServer);
    const dlHostPort = await listenServer(dlServer);
    const destPath = path.join(tmpDir, 'out.vsix');
    const dlRes = await httpClient.downloadToFile(`http://${dlHostPort}/file.vsix`, destPath, {
      proxy: proxyAuthUrl,
      timeout: 5000,
      retryDelayMs: 20
    });
    const partLeftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.part_'));
    check(
      'downloadToFile 经代理遇首包 503 自动重试成功且无残留 .part_ 临时文件',
      dlRes.bytes === 15 && fs.readFileSync(destPath, 'utf8') === 'VSIX_PAYLOAD_OK' && partLeftovers.length === 0,
      JSON.stringify({ dlRes, dlAttempts, partLeftovers })
    );

    // ── 7. UsageTracker.fetchOfficialDaily 统一收口到 httpClient ───────────────
    console.log('\n[7/8] UsageTracker 统一走 httpClient 与自定义 domain');
    let utAttempts = 0;
    let utEnterpriseHeader = '';
    const utServer = http.createServer((req, res) => {
      if (req.url === '/billing/meter/get-user-request-usage') {
        utAttempts++;
        utEnterpriseHeader = String(req.headers['x-enterprise-id'] || '');
        if (utAttempts === 1) {
          res.writeHead(502);
          res.end('bad gateway');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          data: { total: 1, data: [{ requestId: 'r-1', credit: 18.5, model: 'm1', client: 'ide', requestTime: '2026-11-27 10:00:00' }] }
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }));
    });
    servers.push(utServer);
    const utHostPort = await listenServer(utServer);
    const utRes = await UsageTracker.fetchOfficialDaily('tok-ut', 'uid-ut', '2026-11-27', 'ent-ut-1', `http://${utHostPort}`);
    check(
      'UsageTracker.fetchOfficialDaily 通过 httpClient 重试 502 成功并转发企业头',
      Boolean(utRes && Math.abs(utRes.consumed - 18.5) < 1e-6 && utAttempts === 2 && utEnterpriseHeader === 'ent-ut-1'),
      JSON.stringify({ utRes, utAttempts, utEnterpriseHeader })
    );

    // ── 8. getProxyDiagnosticSummary 脱敏状态 ────────────────────────────────
    console.log('\n[8/8] 代理诊断摘要脱敏');
    const hasDiag = typeof httpClient.getProxyDiagnosticSummary === 'function';
    check('httpClient 导出 getProxyDiagnosticSummary', hasDiag);
    if (hasDiag) {
      process.env.HTTPS_PROXY = 'http://secret_user:secret_pass@corp.internal.local:8080';
      const summary = httpClient.getProxyDiagnosticSummary();
      check(
        'getProxyDiagnosticSummary 返回脱敏标签且绝不泄露账密与内网主机名',
        summary === 'env' && !summary.includes('secret') && !summary.includes('corp.internal'),
        summary
      );
    }

    assert.ok(passed >= 0);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    await Promise.all(servers.map(closeServer));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log('失败明细:');
    for (const f of failures) {
      console.log(`  - ${f.title}${f.detail ? ' — ' + f.detail : ''}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
