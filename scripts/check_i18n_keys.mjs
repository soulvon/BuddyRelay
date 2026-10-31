#!/usr/bin/env node
/**
 * BuddyRelay i18n 字典对账门禁
 * - zh.ts 与 en.ts key 集合必须一致 (缺失即 FAIL)
 * - 源码 t('key') 调用与 sidebar.html {{i:key}} 占位符的 key 必须存在于字典 (缺失即 FAIL)
 * - 字典中未被引用的 key 仅提示 (保留 common.* 等预置 key)
 * 用法: node scripts/check_i18n_keys.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZH = path.join(ROOT, 'src', 'i18n', 'zh.ts');
const EN = path.join(ROOT, 'src', 'i18n', 'en.ts');
const HTML = path.join(ROOT, 'resources', 'webview', 'sidebar.html');

let failed = 0;
let passed = 0;

function gate(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function extractKeys(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const keys = new Set();
  const re = /['"]([\w.]+)['"]\s*:\s*['"`]/g;
  let m;
  while ((m = re.exec(txt))) {
    keys.add(m[1]);
  }
  return keys;
}

const zhKeys = extractKeys(ZH);
const enKeys = extractKeys(EN);

const zhOnly = [...zhKeys].filter(k => !enKeys.has(k));
const enOnly = [...enKeys].filter(k => !zhKeys.has(k));
gate('i18n 对账: zh/en 字典 key 完全一致', zhOnly.length === 0 && enOnly.length === 0,
  `zh 独有: ${zhOnly.join(', ') || '无'} | en 独有: ${enOnly.join(', ') || '无'}`);

// 收集引用: src/**/*.ts 的 t('key') + sidebar.html 的 {{i:key}} 与 t('key')
const used = new Set();
const missing = [];

function scanRefs(txt, file) {
  // 去掉注释行, 避免把文档示例 (如 t('key')) 与占位符说明误判为引用
  const code = txt.split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  const callRe = /\bt\(\s*['"]([\w.]+)['"]/g;
  let m;
  while ((m = callRe.exec(code))) {
    used.add(m[1]);
    if (!zhKeys.has(m[1])) missing.push(`${file}: t('${m[1]}')`);
  }
  const phRe = /\{\{i:([\w.]+)\}\}/g;
  while ((m = phRe.exec(code))) {
    used.add(m[1]);
    if (!zhKeys.has(m[1])) missing.push(`${file}: {{i:${m[1]}}}`);
  }
}

const srcDir = path.join(ROOT, 'src');
for (const f of fs.readdirSync(srcDir, { recursive: true })) {
  const p = path.join(srcDir, f.toString());
  if (f.toString().endsWith('.ts') && fs.statSync(p).isFile()) {
    scanRefs(fs.readFileSync(p, 'utf8'), `src/${f}`);
  }
}
scanRefs(fs.readFileSync(HTML, 'utf8'), 'sidebar.html');

gate('i18n 对账: 引用 key 均存在于字典', missing.length === 0, missing.slice(0, 12).join(' | '));

const unused = [...zhKeys].filter(k => !used.has(k) && k !== '__lang__');
if (unused.length > 0) {
  console.log(`  HINT  字典中未被引用的 key (${unused.length}): ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? ' ...' : ''}`);
}

console.log('');
console.log(`i18n 对账结果: ${passed} 通过, ${failed} 失败, 字典 ${zhKeys.size} keys, 引用 ${used.size} keys`);
process.exit(failed > 0 ? 1 : 0);
