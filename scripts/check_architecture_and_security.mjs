#!/usr/bin/env node
/**
 * BuddyRelay 架构行数、Webview 安全硬化、DOM ID 闭合与存储加密/损坏熔断门控
 * 覆盖 5 组强断言：
 *  1. 架构行数门控 (src/** < 900, extension.ts < 250, main.css < 2500, sidebar.html < 700)
 *  2. Webview 安全硬化门控 (Strict Nonce CSP, 无 unsafe-inline script, 无 <style>, 零内联事件)
 *  3. DOM ID 闭合门控 (sidebar.js 所有 getElementById 静态 ID 100% 可闭合)
 *  4. 凭据 AES-256-GCM 迁移加密与损坏熔断拒写实测 (BUDDYRELAY_MASTER_KEY_FILE 沙盒隔离)
 *  5. atomicFile 可重入锁与 readJsonFileSafe 状态机实测
 */
import fs from 'node:fs';
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

function countLines(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  return txt.length === 0 ? 0 : txt.split(/\r?\n/).length;
}

async function main() {
  console.log('=== 开始 BuddyRelay 架构与安全硬化门控 ===\n');

  // ── 1. 架构行数门控 ──
  console.log('[1/5] 架构行数门控');
  const srcDir = path.join(ROOT, 'src');
  const oversizedTs = [];
  let maxTs = { file: '', lines: 0 };
  for (const entry of fs.readdirSync(srcDir, { recursive: true })) {
    const rel = entry.toString().replace(/\\/g, '/');
    if (!rel.endsWith('.ts')) continue;
    const full = path.join(srcDir, rel);
    if (!fs.statSync(full).isFile()) continue;
    const lines = countLines(full);
    if (lines > maxTs.lines) maxTs = { file: `src/${rel}`, lines };
    if (lines >= 900) oversizedTs.push(`src/${rel} (${lines})`);
  }
  check(
    `所有 src/**/*.ts 文件行数均 < 900 (最大 ${maxTs.file}: ${maxTs.lines} 行)`,
    oversizedTs.length === 0,
    oversizedTs.join(', ')
  );

  const extLines = countLines(path.join(srcDir, 'extension.ts'));
  check(`src/extension.ts 行数 < 250 (实际 ${extLines} 行)`, extLines < 250, `actual=${extLines}`);

  const cssLines = countLines(path.join(ROOT, 'resources', 'webview', 'main.css'));
  check(`resources/webview/main.css 行数 < 2500 (实际 ${cssLines} 行)`, cssLines < 2500, `actual=${cssLines}`);

  const htmlLines = countLines(path.join(ROOT, 'resources', 'webview', 'sidebar.html'));
  check(`resources/webview/sidebar.html 行数 < 700 (实际 ${htmlLines} 行)`, htmlLines < 700, `actual=${htmlLines}`);

  // ── 2. Webview 安全硬化门控 ──
  console.log('\n[2/5] Webview 安全硬化门控');
  const htmlPath = path.join(ROOT, 'resources', 'webview', 'sidebar.html');
  const jsPath = path.join(ROOT, 'resources', 'webview', 'sidebar.js');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  const cspMetaMatch = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  const cspContent = cspMetaMatch ? cspMetaMatch[1] : '';
  const scriptSrcMatch = cspContent.match(/script-src\s+([^;]+)/i);
  const scriptSrcDirective = scriptSrcMatch ? scriptSrcMatch[1] : '';

  check(
    "sidebar.html 声明 script-src 'nonce-{{NONCE}}'",
    cspContent.includes("script-src 'nonce-{{NONCE}}'"),
    scriptSrcDirective
  );
  check(
    "sidebar.html 的 script-src 严禁包含 'unsafe-inline'",
    Boolean(scriptSrcDirective) && !scriptSrcDirective.includes('unsafe-inline'),
    scriptSrcDirective
  );
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  check('sidebar.html 严禁内联 <style> 标签', !/<style\b/i.test(htmlNoComments));

  const inlineEventRe = /\bon(?:click|change|input|keydown|keyup|submit|mouseover|focus|blur)\s*=/gi;
  const htmlInlineHits = htmlNoComments.match(inlineEventRe) || [];
  const jsNoLineComments = js
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const jsInlineHits = jsNoLineComments.match(inlineEventRe) || [];
  check(
    'sidebar.html 与 sidebar.js 零内联事件属性 (onclick/onchange/oninput/...)',
    htmlInlineHits.length === 0 && jsInlineHits.length === 0,
    `html=${htmlInlineHits.join(',')} js=${jsInlineHits.join(',')}`
  );

  // ── 3. DOM ID 闭合门控 ──
  console.log('\n[3/5] DOM ID 闭合门控');
  const declaredIds = new Set();
  for (const m of htmlNoComments.matchAll(/\bid="([^"]+)"/g)) declaredIds.add(m[1]);
  for (const m of jsNoLineComments.matchAll(/\bid=\\"([^\\"]+)\\"|\bid="([^"]+)"/g)) {
    declaredIds.add(m[1] || m[2]);
  }
  const usedIds = Array.from(
    new Set([...jsNoLineComments.matchAll(/document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))
  );
  const missingDomIds = usedIds.filter((id) => !declaredIds.has(id));
  check(
    `sidebar.js 全部 ${usedIds.length} 个静态 getElementById ID 在模板中 100% 闭合`,
    usedIds.length > 0 && missingDomIds.length === 0,
    missingDomIds.join(', ')
  );

  // ── 4 & 5. 沙盒运行时检验（AccountStore 加解密与损坏熔断 + atomicFile 锁与读）──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-arch-sec-'));
  const prevMasterEnv = process.env.BUDDYRELAY_MASTER_KEY_FILE;
  try {
    console.log('\n[4/5] 凭据加密迁移与损坏熔断沙盒实测');
    const masterKeyFile = path.join(tmpDir, 'master.key');
    process.env.BUDDYRELAY_MASTER_KEY_FILE = masterKeyFile;

    const { AccountStore } = require(path.join(ROOT, 'out', 'accountStore.js'));
    const plainPoolPath = path.join(tmpDir, 'pool.json');
    const PLAIN_ACCESS = 'plain-access-token-secret-987654';
    const PLAIN_REFRESH = 'plain-refresh-token-secret-123456';

    fs.writeFileSync(
      plainPoolPath,
      JSON.stringify(
        {
          version: '2.0',
          updatedAt: Date.now(),
          activeId: 'acc-plain',
          privacyMode: false,
          accounts: [
            {
              id: 'acc-plain',
              uid: 'uid-plain-1',
              email: 'plain@test.cn',
              nickname: 'PlainUser',
              accessToken: PLAIN_ACCESS,
              refreshToken: PLAIN_REFRESH,
              tokenType: 'Bearer',
              expiresAt: Date.now() + 3600_000,
              domain: 'www.codebuddy.cn',
              status: 'active',
              createdAt: 1000,
              lastUsed: 2000,
              authRaw: { accessToken: PLAIN_ACCESS, refreshToken: PLAIN_REFRESH }
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    );

    const store1 = new AccountStore(undefined, plainPoolPath);
    try {
      const preBakExists = fs.existsSync(`${plainPoolPath}.pre-encrypt.bak`);
      const encryptedDiskText = fs.readFileSync(plainPoolPath, 'utf8');
      const memAcc = store1.get('acc-plain');
      check('明文旧格式迁移前自动产生 .pre-encrypt.bak', preBakExists);
      check(
        "落盘后 pool.json 含 'enc:v1:' 且彻底消除明文 Token",
        encryptedDiskText.includes('enc:v1:') &&
          !encryptedDiskText.includes(PLAIN_ACCESS) &&
          !encryptedDiskText.includes(PLAIN_REFRESH) &&
          fs.existsSync(masterKeyFile)
      );
      check(
        '内存中 store.get() 正确解密还原明文 Token',
        Boolean(memAcc && memAcc.accessToken === PLAIN_ACCESS && memAcc.refreshToken === PLAIN_REFRESH)
      );
    } finally {
      store1.dispose();
    }

    const storeReload = new AccountStore(undefined, plainPoolPath);
    try {
      const reloadedAcc = storeReload.get('acc-plain');
      check(
        '新实例重载加密 pool.json 正确解密还原 Token',
        Boolean(reloadedAcc && reloadedAcc.accessToken === PLAIN_ACCESS && reloadedAcc.refreshToken === PLAIN_REFRESH)
      );
    } finally {
      storeReload.dispose();
    }

    // 损坏 JSON 熔断与拒写测试
    const corruptDir = path.join(tmpDir, 'corrupt-case');
    fs.mkdirSync(corruptDir, { recursive: true });
    const corruptPoolPath = path.join(corruptDir, 'pool.json');
    const brokenContent = '{"version":"2.0","accounts":[{"id":"broken"';
    fs.writeFileSync(corruptPoolPath, brokenContent, 'utf8');

    const badStore = new AccountStore(undefined, corruptPoolPath);
    try {
      const corruptBak = fs.readdirSync(corruptDir).find((f) => f.startsWith('pool.json.corrupt_'));
      check('损坏 pool.json 自动生成 .corrupt 留证备份', Boolean(corruptBak));
      check('损坏态 store.isLoadHealthy() === false', badStore.isLoadHealthy() === false && badStore.count() === 0);
      await badStore.persist();
      await badStore.flushToDisk();
      const diskAfterPersist = fs.readFileSync(corruptPoolPath, 'utf8');
      check(
        '损坏态拒写保护：persist/flushToDisk 绝不拿空池覆盖损坏文件',
        diskAfterPersist === brokenContent,
        diskAfterPersist.slice(0, 80)
      );
    } finally {
      badStore.dispose();
    }

    console.log('\n[5/5] atomicFile 可重入锁与安全读实测');
    const atomicFile = require(path.join(ROOT, 'out', 'atomicFile.js'));
    const missingRes = atomicFile.readJsonFileSafe(path.join(tmpDir, 'does-not-exist.json'));
    check("readJsonFileSafe 缺失文件返回 status='missing'", missingRes.status === 'missing', JSON.stringify(missingRes));

    const brokenJsonPath = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(brokenJsonPath, '{invalid_json', 'utf8');
    const errorRes = atomicFile.readJsonFileSafe(brokenJsonPath);
    check(
      "readJsonFileSafe 损坏文件返回 status='error'",
      errorRes.status === 'error' && errorRes.error instanceof Error,
      JSON.stringify({ status: errorRes.status })
    );

    const lockedTarget = path.join(tmpDir, 'reentrant-target.json');
    const nestedResult = atomicFile.withFileLockSync(lockedTarget, () => {
      return atomicFile.withFileLockSync(lockedTarget, () => {
        atomicFile.atomicWriteJsonSync(lockedTarget, { nested: true, label: '可重入安全写' });
        return 'reentrant-ok';
      });
    });
    const okRes = atomicFile.readJsonFileSafe(lockedTarget);
    check(
      '嵌套 withFileLockSync 不死锁且释放后无残留 .lock 文件',
      nestedResult === 'reentrant-ok' && !fs.existsSync(`${lockedTarget}.lock`)
    );
    check(
      "readJsonFileSafe 读取正常 JSON 返回 status='ok' 且内容精确一致",
      okRes.status === 'ok' && okRes.data?.nested === true && okRes.data?.label === '可重入安全写',
      JSON.stringify(okRes)
    );
  } finally {
    if (prevMasterEnv === undefined) delete process.env.BUDDYRELAY_MASTER_KEY_FILE;
    else process.env.BUDDYRELAY_MASTER_KEY_FILE = prevMasterEnv;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }

  console.log(`\n架构与安全门控结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    failures.forEach((f) => console.error(`  - ${f.title}: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('架构与安全门控异常:', err);
  process.exit(1);
});
