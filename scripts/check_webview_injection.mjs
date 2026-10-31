#!/usr/bin/env node
/**
 * BuddyRelay webview 注入冒烟门禁
 * 模拟 sidebarProvider.getHtmlForWebview 的 zh/en 双语替换产物, 对内联 <script> 做语法校验:
 * - {{I18N_JSON}} 必须全部注入 (残留即 FAIL — 曾因注释撞名只替换到第一个导致运行时白屏)
 * - {{i:key}} 占位符 key 必须全部存在于字典 (缺失即 FAIL)
 * - 替换后内联脚本必须通过 vm.Script 语法解析 (破坏即 FAIL)
 * 用法: node scripts/check_webview_injection.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const zh = require(path.join(ROOT, 'out', 'i18n', 'zh.js')).zh;
const en = require(path.join(ROOT, 'out', 'i18n', 'en.js')).en;

if (!zh || !en) {
  console.error('FAIL 无法加载编译产物字典 (先 npm run compile)');
  process.exit(1);
}

const html = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.html'), 'utf8');
let failed = 0;

function gate(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

for (const [tag, dict] of [['zh', zh], ['en', en]]) {
  // 与 sidebarProvider 相同的注入方式
  let content = html.replaceAll('{{I18N_JSON}}', () => JSON.stringify(dict).replace(/<\//g, '<\\/'));
  const missing = [];
  content = content.replace(/\{\{i:([\w.]+)\}\}/g, (full, key) => {
    if (!(key in dict)) missing.push(key);
    return dict[key] !== undefined ? dict[key] : full;
  });

  gate(`${tag}: {{I18N_JSON}} 全部注入`, !content.includes('{{I18N_JSON}}'));
  gate(`${tag}: {{i:}} 占位符 key 均存在`, missing.length === 0, missing.join(', '));

  const m = content.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) { gate(`${tag}: 内联脚本存在`, false); continue; }
  try {
    new vm.Script(m[1], { filename: `sidebar-${tag}.js` });
    gate(`${tag}: 内联脚本语法解析`, true);
  } catch (e) {
    gate(`${tag}: 内联脚本语法解析`, false, e.message.split('\n').slice(0, 4).join(' | '));
  }
}

console.log(`\nwebview 注入冒烟: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
