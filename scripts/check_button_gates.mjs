#!/usr/bin/env node
/**
 * G10: 任务模态框动作按钮统一规格门控
 * 检查: 1) 无内联 flex 样式  2) 统一规格 CSS 存在且含 !important  3) .add-area .primary 用 margin-left:auto 右对齐
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'resources', 'webview', 'sidebar.html'), 'utf8');

let failed = 0;
function gate(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + (detail || '')}`);
  if (!ok) failed++;
}

// 1. 任务模态框三按钮无内联 flex
gate('G10a 无内联 flex', !/id="btn(?:TaskRefresh|TaskAcceptAll|TaskRunAuto)"[^>]*style=/.test(html));

// 2. 统一规格 CSS 存在
gate(
  'G10b 统一规格 CSS',
  /#taskModalOverlay \.action-row button \{[^}]*height: 30px !important[^}]*padding: 0 12px !important[^}]*font-size: 11px !important[^}]*\}/.test(html)
);

// 3. 右对齐使用 margin-left:auto（不依赖父容器 flex）
gate(
  'G10c 动作按钮右对齐 margin-left:auto',
  /\.add-area \.primary\s*{[^}]*margin-left:\s*auto/.test(html)
);

process.exit(failed > 0 ? 1 : 0);
