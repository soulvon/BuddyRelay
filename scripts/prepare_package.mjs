#!/usr/bin/env node
/**
 * 打包前版本守卫：确保本次打出的包版本号严格大于历史已有的 vsix，并同步 README 与 package-lock.json 版本。
 *
 * 背景（2026-11-02 事故）：改完界面直接 `vsce package`，版本号未提升，
 * 生成的新 vsix 与已安装/已发布的同名同版本号，安装端无法判断是否真更新，
 * 也失去“哪一版对应哪次改动”的可追溯性。
 *
 * 规则：
 *   - 扫描仓库根目录所有 buddy-relay-<x.y.z>.vsix，取最大版本
 *   - package.json 版本 <= 最大已有版本时，自动 patch 递增
 *   - 无论是否递增，都把 package-lock.json（顶层 version 与 packages[""].version）及 README 双语徽章与安装命令里的版本号对齐到当前版本（G21 门控）
 *   - 只有显式 --allow-same 才跳过递增（本地反复试打包用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');
const PKG_LOCK = path.join(ROOT, 'package-lock.json');
const ALLOW_SAME = process.argv.includes('--allow-same');

function parseVer(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 同步 package-lock.json 顶层 version 与 packages[""].version */
function syncPackageLock(ver) {
  if (!fs.existsSync(PKG_LOCK)) return false;
  const raw = fs.readFileSync(PKG_LOCK, 'utf8');
  const lock = JSON.parse(raw);
  let dirty = false;
  if (lock.version !== ver) {
    lock.version = ver;
    dirty = true;
  }
  if (lock.packages && lock.packages[''] && lock.packages[''].version !== ver) {
    lock.packages[''].version = ver;
    dirty = true;
  }
  if (dirty) {
    fs.writeFileSync(PKG_LOCK, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
  return dirty;
}

/** README 双语徽章与安装命令版本对齐到指定版本，并同步 lockfile / sidebar.html / 功能地图 */
function syncDocsAndLock(ver) {
  const changed = [];
  if (syncPackageLock(ver)) {
    changed.push('package-lock.json');
  }
  for (const name of ['README.md', 'README_en.md']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8');
    const nextTxt = txt
      .replace(/version-\d+\.\d+\.\d+-blue/g, `version-${ver}-blue`)
      .replace(/buddy-relay-\d+\.\d+\.\d+\.vsix/g, `buddy-relay-${ver}.vsix`);
    if (nextTxt !== txt) {
      fs.writeFileSync(p, nextTxt, 'utf8');
      changed.push(name);
    }
  }
  const htmlPath = path.join(ROOT, 'resources', 'webview', 'sidebar.html');
  if (fs.existsSync(htmlPath)) {
    const rawHtml = fs.readFileSync(htmlPath, 'utf8');
    const nextHtml = rawHtml.replace(
      /(<span\b[^>]*id="currentVersionTag"[^>]*>)v\d+\.\d+\.\d+(<\/span>)/,
      `$1v${ver}$2`
    );
    if (nextHtml !== rawHtml) {
      fs.writeFileSync(htmlPath, nextHtml, 'utf8');
      changed.push('resources/webview/sidebar.html');
    }
  }
  const mapPath = path.join(ROOT, 'docs', '功能地图.md');
  if (fs.existsSync(mapPath)) {
    const rawMap = fs.readFileSync(mapPath, 'utf8');
    const nextMap = rawMap.replace(/（v\d+\.\d+\.\d+）/g, `（v${ver}）`);
    if (nextMap !== rawMap) {
      fs.writeFileSync(mapPath, nextMap, 'utf8');
      changed.push('docs/功能地图.md');
    }
  }
  return changed;
}

const pkgRaw = fs.readFileSync(PKG, 'utf8');
const pkg = JSON.parse(pkgRaw);
const current = parseVer(pkg.version);
if (!current) {
  console.error(`[prepare-package] package.json 版本号非法: ${pkg.version}`);
  process.exit(1);
}

// 扫描历史 vsix 版本
const vsixFiles = fs.readdirSync(ROOT).filter((f) => /^buddy-relay-\d+\.\d+\.\d+\.vsix$/.test(f));
let maxSeen = [0, 0, 0];
let maxFile = '';
for (const f of vsixFiles) {
  const v = parseVer(f.replace(/^buddy-relay-/, '').replace(/\.vsix$/, ''));
  if (v && cmp(v, maxSeen) > 0) {
    maxSeen = v;
    maxFile = f;
  }
}

if (!maxFile) {
  const synced0 = syncDocsAndLock(pkg.version);
  console.log(`[prepare-package] 首次打包 v${pkg.version}，无需递增${synced0.length ? '，已同步 ' + synced0.join(', ') : ''}`);
  process.exit(0);
}

if (cmp(current, maxSeen) > 0) {
  const synced1 = syncDocsAndLock(pkg.version);
  console.log(
    `[prepare-package] v${pkg.version} > 历史最大 v${maxSeen.join('.')}（${maxFile}），版本合法` +
      (synced1.length ? `，已同步 ${synced1.join(', ')}` : '')
  );
  process.exit(0);
}

if (ALLOW_SAME) {
  const syncedSame = syncDocsAndLock(pkg.version);
  console.log(
    `[prepare-package] --allow-same 显式放行：v${pkg.version} 与 ${maxFile} 同版本重复打包` +
      (syncedSame.length ? `，已同步 ${syncedSame.join(', ')}` : '')
  );
  process.exit(0);
}

// 自动 patch 递增
const oldVer = pkg.version;
const nextStr = [maxSeen[0], maxSeen[1], maxSeen[2] + 1].join('.');
pkg.version = nextStr;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

const synced = syncDocsAndLock(nextStr);
console.log(`[prepare-package] 检测到 v${oldVer} 已打包过（${maxFile}），已自动递增到 v${nextStr}`);
if (synced.length) {
  console.log(`[prepare-package] 已同步版本号: ${synced.join(', ')}`);
}
