// ── BuddyRelay 发版就绪门控 (check:release) ──
// 补 G 系列缺口: vsix 内 README 快照过期 / 打包垃圾混入 / CSP 自声明 / tag 对账 / 发布渠道
// 发版流程: npm run build -> vsce package -> **npm run check:release** -> git tag -> push (CI 发版)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0, skipped = 0;
function gate(name, ok, skip = false) {
  console.log((skip ? '  SKIP  ' : ok ? '  PASS  ' : '  FAIL  ') + name);
  if (skip) skipped++; else ok ? passed++ : failed++;
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const V = pkg.version;
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

console.log(`\n═══ 发版就绪门控 — buddy-relay v${V} ═══\n`);

// ── R1 tag 对账 ──
let tag = '';
try { tag = execSync('git describe --tags --abbrev=0', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 无 tag */ }
gate('R1.1 最新 git tag == package.json 版本 (防更新引擎死循环)', tag === `v${V}`, tag === '');

// ── R1.2 版本号必须严格大于历史所有已打包 vsix（防同版本覆盖，2026-11-02 事故） ──
const parseVer = (s) => {
  const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmpVer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const curVer = parseVer(V) || [0, 0, 0];
const historyVsix = fs.readdirSync(ROOT).filter((f) => /^buddy-relay-\d+\.\d+\.\d+\.vsix$/.test(f));
const olderVersions = historyVsix
  .map((f) => ({ f, v: parseVer(f.replace(/^buddy-relay-/, '').replace(/\.vsix$/, '')) }))
  .filter((x) => x.v && cmpVer(curVer, x.v) > 0);
const sameVersionOthers = historyVsix.filter((f) => f === `buddy-relay-${V}.vsix`);
const newerPackages = historyVsix.filter(
  (f) => !olderVersions.some((x) => x.f === f) && f !== `buddy-relay-${V}.vsix`
);
gate(
  'R1.2 版本号递增: 当前版本是历史最高（同版本重复打包须走 package:same）' +
    (newerPackages.length ? ` — 存在更高版本包: ${newerPackages.join(', ')}` : ''),
  newerPackages.length === 0
);

// ── R2 打包卫生 (对当前版本 vsix) ──
const vsixPath = path.join(ROOT, `buddy-relay-${V}.vsix`);
if (fs.existsSync(vsixPath)) {
  const zip = new AdmZip(vsixPath);
  const names = zip.getEntries().map(e => e.entryName);
  const extNames = names.filter(n => n.startsWith('extension/'));
  gate('R2.1 vsix 无 tmp/ 混入', !names.some(n => /(^|\/)tmp\//.test(n)));
  gate('R2.2 vsix 无 docs/草稿 混入', !names.some(n => /\/docs\//.test(n)));
  const readmeName = extNames.find(n => /readme\.md$/i.test(n) && !/readme_en\.md$/i.test(n));
  const readmeInVsix = readmeName ? zip.readAsText(readmeName) : '';
  gate('R2.3 vsix 内 README 徽章 == package.json 版本 (快照过期治理)', readmeInVsix.includes(`version-${V}-blue`));
  gate('R2.4 vsix 内 README 无旧版本徽章残留', !/version-0\.\d+\.\d+-blue/.test(readmeInVsix) && !/version-1\.0\.[01]-blue/.test(readmeInVsix.replace(`version-${V}-blue`, '')));
  gate('R2.5 vsix 内 CSP 自声明 (sidebar.html)', /Content-Security-Policy/.test(zip.readAsText(extNames.find(n => /sidebar\.html$/i.test(n)) || '')));
  gate('R2.6 vsix 内互推五件套 (Antigravity-Kite)', readmeInVsix.includes('Antigravity-Kite'));
  gate('R2.7 包体瘦身: vsix 严格排除 node_modules (零打包依赖)', !names.some(n => /(^|\/)node_modules\//.test(n)));
  gate('R2.8 包体瘦身: vsix 严格排除非运行时预览/打赏大图 resources/(preview-*|qq-group|wechat)', !names.some(n => /resources\/(preview-|qq-group|wechat)/.test(n)));
  gate('R2.9 包体瘦身: vsix 严格排除 .github/ 与 AGENTS.md', !names.some(n => /(^|\/)(\.github|AGENTS\.md)/.test(n)));

  // R2.10 包体新鲜度：源码改动必须晚于 vsix 打包时间之前（防"改了没重打"）
  const vsixMtime = fs.statSync(vsixPath).mtimeMs;
  const watchedDirs = [path.join(ROOT, 'src'), path.join(ROOT, 'resources', 'webview')];
  let newestSrc = { file: '', mtime: 0 };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      const m = fs.statSync(p).mtimeMs;
      if (m > newestSrc.mtime) newestSrc = { file: path.relative(ROOT, p), mtime: m };
    }
  };
  watchedDirs.forEach((d) => { if (fs.existsSync(d)) walk(d); });
  gate(
    'R2.10 包体新鲜度: vsix 不早于源码最后修改（改了代码必须重打包）' +
      (newestSrc.mtime > vsixMtime ? ` — 源码 ${newestSrc.file} 比 vsix 新` : ''),
    newestSrc.mtime <= vsixMtime
  );
} else {
  gate(`R2.* vsix buddy-relay-${V}.vsix 不存在 (先 vsce package)`, false);
}

// ── R3 webview 加固 (源文件) ──
const html = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.html'), 'utf8');
const sp = fs.readFileSync(path.join(ROOT, 'src', 'sidebarProvider.ts'), 'utf8');
gate('R3.1 sidebar.html 自声明 CSP meta', /Content-Security-Policy/.test(html) && html.includes('{{CSP_SOURCE}}'));
gate('R3.2 sidebarProvider 注入 cspSource', sp.includes('cspSource'));
gate('R3.3 modal-body flex-basis auto (纵向塌陷防御)', /flex:\s*1\s+1\s+auto/.test(fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'main.css'), 'utf8')));

// ── R4 i18n 纪律 (G44 同源复核) ──
const zh = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'zh.ts'), 'utf8');
gate('R4.1 徽章纯文本 (当前)', zh.includes("'js.currentSuffix': '当前'"));
gate('R4.2 nls zh/en key 集一致', JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.zh-cn.json'), 'utf8'))).sort()) === JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'))).sort()));

// ── R5 发布渠道 (依赖 gh/网络, 失败 SKIP) ──
try {
  const rel = JSON.parse(execSync(`gh release view v${V} -R soulvon/BuddyRelay --json assets`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim());
  const assets = rel.assets.map(a => a.name).join(',');
  gate('R5.1 GitHub Release v' + V + ' 存在且挂 vsix (自动更新链)', assets.includes(`buddy-relay-${V}.vsix`));
} catch { gate('R5.1 GitHub Release v' + V + ' 存在且挂 vsix', false, true); }
try {
  const store = JSON.parse(execSync('curl -s --max-time 15 "https://open-vsx.org/api/soulvon/buddy-relay"', { encoding: 'utf8' }));
  gate('R5.2 Open VSX latest == ' + V, store.version === V);
} catch { gate('R5.2 Open VSX latest 校验', false, true); }

console.log(`\n═══ 结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过 ═══`);
process.exit(failed > 0 ? 1 : 0);
