#!/usr/bin/env node
/**
 * BuddyRelay webview 注入冒烟门禁
 * 模拟 sidebarProvider.getHtmlForWebview 的 zh/en 双语替换产物，校验 HTML 与 JS 三件套注入与语法：
 * - 模拟注入 {{NONCE}}、{{CSP_SOURCE}}、{{STYLE_URI}}、{{SCRIPT_URI}}、{{I18N_JSON}} 及 {{i:key}}
 * - 断言替换后 HTML 与 JS 无任何 {{...}} 模板占位符残留
 * - {{i:key}} 占位符 key 必须全部存在于字典
 * - 用 new vm.Script 分别校验 HTML 内联 <script nonce="..."> 块与外部 resources/webview/sidebar.js 语法 100% 合法
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
const js = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.js'), 'utf8');
let failed = 0;

function gate(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const TEST_NONCE = 'dGVzdC1ub25jZS0xMjM0NTY=';
const TEST_CSP_SOURCE = 'vscode-webview://test-origin';
const TEST_STYLE_URI = 'vscode-webview://test-origin/resources/webview/main.css?v=1';
const TEST_SCRIPT_URI = 'vscode-webview://test-origin/resources/webview/sidebar.js?v=1';

for (const [tag, dict] of [['zh', zh], ['en', en]]) {
  const dictJson = JSON.stringify(dict).replace(/<\//g, '<\\/');
  const missing = [];
  const replaceTemplates = (raw) => raw
    .replaceAll('{{NONCE}}', () => TEST_NONCE)
    .replaceAll('{{CSP_SOURCE}}', () => TEST_CSP_SOURCE)
    .replaceAll('{{STYLE_URI}}', () => TEST_STYLE_URI)
    .replaceAll('{{SCRIPT_URI}}', () => TEST_SCRIPT_URI)
    .replaceAll('{{I18N_JSON}}', () => dictJson)
    .replace(/\{\{i:([\w.]+)\}\}/g, (full, key) => {
      if (!(key in dict)) missing.push(key);
      return dict[key] !== undefined ? dict[key] : full;
    });

  const htmlContent = replaceTemplates(html);
  const jsContent = replaceTemplates(js);

  const htmlLeftover = htmlContent.match(/\{\{[^}]+\}\}/g) || [];
  const jsLeftover = jsContent.match(/\{\{[^}]+\}\}/g) || [];
  gate(`${tag}: HTML 无模板占位符残留`, htmlLeftover.length === 0, htmlLeftover.slice(0, 5).join(', '));
  gate(`${tag}: JS 无模板占位符残留`, jsLeftover.length === 0, jsLeftover.slice(0, 5).join(', '));
  gate(`${tag}: {{i:}} 占位符 key 均存在`, missing.length === 0, missing.join(', '));
  gate(
    `${tag}: 外链 <script nonce="..." src="..."> 注入完整`,
    htmlContent.includes(`<script nonce="${TEST_NONCE}" src="${TEST_SCRIPT_URI}"></script>`)
  );

  // 校验 HTML 中所有内联 <script nonce="..."> 块（无 src 属性）
  const scriptTagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const inlineBlocks = [];
  let match;
  while ((match = scriptTagRe.exec(htmlContent)) !== null) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    inlineBlocks.push({ attrs, code: match[2] });
  }
  gate(
    `${tag}: HTML 内联 <script nonce="..."> 块存在且全部携带 nonce`,
    inlineBlocks.length > 0 && inlineBlocks.every((b) => b.attrs.includes(`nonce="${TEST_NONCE}"`)),
    `count=${inlineBlocks.length}`
  );
  for (let i = 0; i < inlineBlocks.length; i++) {
    try {
      new vm.Script(inlineBlocks[i].code, { filename: `sidebar-${tag}-inline-${i}.js` });
      gate(`${tag}: HTML 内联脚本 #${i + 1} 语法解析`, true);
    } catch (e) {
      gate(`${tag}: HTML 内联脚本 #${i + 1} 语法解析`, false, e.message.split('\n').slice(0, 4).join(' | '));
    }
  }

  // 校验整个外部 sidebar.js 语法
  try {
    new vm.Script(jsContent, { filename: `sidebar-${tag}.js` });
    gate(`${tag}: 外部 sidebar.js 语法解析`, true);
  } catch (e) {
    gate(`${tag}: 外部 sidebar.js 语法解析`, false, e.message.split('\n').slice(0, 4).join(' | '));
  }
}

console.log(`\nwebview 注入冒烟: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed > 0 ? 1 : 0);
