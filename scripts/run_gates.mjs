#!/usr/bin/env node
/**
 * BuddyRelay 门禁与回归测试并发调度器
 * - 并发池运行全部本地门禁与离线回归测试（含架构与安全门控，排除需外网/真号源的 test_growth_flow.mjs）
 * - 打印各脚本 PASS/FAIL 与耗时及总耗时
 * - 任意一项失败立即终止并输出该项完整错误日志，返回非零退出码
 * 用法: node scripts/run_gates.mjs [--concurrency=6]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  'scripts/test_patch_anchor.mjs',
  'scripts/test_elevated_patch.mjs',
  'scripts/test_switch_resilience.mjs',
  'scripts/test_multiwindow_sync.mjs',
  'scripts/check_i18n_keys.mjs',
  'scripts/check_webview_injection.mjs',
  'scripts/check_ui_guards.mjs',
  'scripts/check_button_gates.mjs',
  'scripts/check_icon_gates.mjs',
  'scripts/check_architecture_and_security.mjs',
  'scripts/verify_card_actions_e2e.mjs',
  'scripts/test_v040_features.mjs',
  'scripts/test_model_cooldown.mjs',
  'scripts/test_ui_interactions.mjs',
  'scripts/test_bugfix_regression.mjs'
];

const concArg = process.argv.find((a) => a.startsWith('--concurrency='));
const parsedConc = concArg ? Number(concArg.split('=')[1]) : 6;
const CONCURRENCY = Number.isFinite(parsedConc) && parsedConc > 0 ? Math.min(parsedConc, GATES.length) : 6;

function runOne(relPath) {
  const start = Date.now();
  const fullPath = path.join(ROOT, relPath);
  const child = spawn(process.execPath, [fullPath], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const promise = new Promise((resolve) => {
    child.on('error', (err) => {
      resolve({
        relPath,
        code: 1,
        durationMs: Date.now() - start,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + (err?.stack || String(err))
      });
    });
    child.on('close', (code) => {
      resolve({
        relPath,
        code: code ?? 1,
        durationMs: Date.now() - start,
        stdout,
        stderr
      });
    });
  });

  return { child, promise };
}

async function main() {
  const totalStart = Date.now();
  console.log(`\n═══ BuddyRelay 并行门禁 (${GATES.length} 项, 并发度=${CONCURRENCY}) ═══\n`);

  const results = new Array(GATES.length);
  const activeChildren = new Set();
  let nextIdx = 0;
  let aborted = false;

  async function worker() {
    while (!aborted) {
      const idx = nextIdx++;
      if (idx >= GATES.length) return;

      const relPath = GATES[idx];
      const { child, promise } = runOne(relPath);
      activeChildren.add(child);
      const res = await promise;
      activeChildren.delete(child);
      results[idx] = res;

      if (aborted) return;

      if (res.code !== 0) {
        aborted = true;
        console.log(`  FAIL  ${relPath} (${res.durationMs}ms, exit=${res.code})`);
        console.log('\n────────── 失败脚本完整日志 ──────────');
        console.log(`脚本: ${relPath}`);
        if (res.stdout.trim()) {
          console.log('[stdout]');
          console.log(res.stdout.trimEnd());
        }
        if (res.stderr.trim()) {
          console.error('[stderr]');
          console.error(res.stderr.trimEnd());
        }
        console.log('──────────────────────────────────────\n');
        for (const c of activeChildren) {
          try {
            c.kill();
          } catch {
            // ignore kill error
          }
        }
        process.exit(1);
      } else {
        console.log(`  PASS  ${relPath} (${res.durationMs}ms)`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const totalMs = Date.now() - totalStart;
  console.log('\n═══ 并行门禁汇总 ═══');
  for (const r of results) {
    if (!r) continue;
    console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.relPath.padEnd(44)} ${String(r.durationMs).padStart(5)}ms`);
  }
  console.log(`\n全部 ${GATES.length} 项门禁与回归测试通过，总耗时 ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s)\n`);
}

main().catch((err) => {
  console.error('并行门禁调度异常:', err);
  process.exit(1);
});
