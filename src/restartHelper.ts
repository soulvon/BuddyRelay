import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS } from './constants';
import { atomicWriteFileSync } from './atomicFile';

/**
 * 收集重启后需等待退出的进程 PID（扩展宿主父进程、当前进程与 Electron 主进程 VSCODE_PID）。
 */
export function collectRestartWaitPids(
  env: NodeJS.ProcessEnv = process.env,
  currentPid: number = process.pid,
  parentPid: number = process.ppid
): number[] {
  const pids = new Set<number>();
  for (const raw of [parentPid, currentPid, Number(env?.VSCODE_PID)]) {
    if (Number.isInteger(raw) && raw > 1) {
      pids.add(raw);
    }
  }
  return Array.from(pids);
}

/**
 * 生成脱离宿主的 restart-helper.js 源码。
 * 关键：launcher 自身运行在 ELECTRON_RUN_AS_NODE=1 下，拉起新版 GUI 时必须删净
 * ELECTRON_RUN_AS_NODE 与旧宿主 VSCODE_* 运行时变量，否则 Electron 会当场以 Node 模式静默退出。
 */
export function buildRestartHelperSource(logPath?: string): string {
  const logPathExpr = logPath
    ? JSON.stringify(logPath)
    : "process.argv[5] || path.join(__dirname, 'restart-helper.log')";

  return [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const os = require('os');",
    "const pidList = String(process.argv[2] || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 1 && n !== process.pid);",
    'const exe = process.argv[3];',
    'const macBundle = process.argv[4] || "";',
    `const logPath = ${logPathExpr};`,
    'const pollMs = Math.max(50, Number(process.env.BUDDY_RELAY_HELPER_POLL_MS) || 400);',
    'const settleMs = Math.max(50, Number(process.env.BUDDY_RELAY_HELPER_SETTLE_MS) || 1500);',
    'const verifyMs = Math.max(100, Number(process.env.BUDDY_RELAY_HELPER_VERIFY_MS) || 2000);',
    'const retryDelayMs = Math.max(50, Number(process.env.BUDDY_RELAY_HELPER_RETRY_MS) || 2000);',
    'const STALE_ENV_KEYS = [',
    "  'ELECTRON_RUN_AS_NODE',",
    "  'ELECTRON_ENABLE_LOGGING',",
    "  'VSCODE_PID',",
    "  'VSCODE_IPC_HOOK',",
    "  'VSCODE_IPC_HOOK_EXTHOST',",
    "  'VSCODE_ESM_ENTRYPOINT',",
    "  'VSCODE_AMD_ENTRYPOINT',",
    "  'VSCODE_CODE_CACHE_PATH',",
    "  'VSCODE_NLS_CONFIG',",
    "  'VSCODE_L10N_BUNDLE_LOCATION',",
    "  'VSCODE_HANDLES_UNCAUGHT_ERRORS',",
    "  'VSCODE_CRASH_REPORTER_PROCESS_TYPE',",
    "  'VSCODE_CRASH_REPORTER_SANDBOX_SUPPORT',",
    "  'VSCODE_CWD',",
    "  'NODE_CHANNEL_FD',",
    "  'NODE_CHANNEL_SERIALIZATION_MODE'",
    '];',
    "const log = (m) => { try { fs.appendFileSync(logPath, Date.now() + ' ' + m + '\\n'); } catch (_) {} };",
    'const isPidAlive = (pid) => {',
    '  try { process.kill(pid, 0); return true; }',
    "  catch (e) { return Boolean(e && e.code === 'EPERM'); }",
    '};',
    'const buildCleanEnv = () => {',
    "  const env = { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' };",
    '  for (const k of STALE_ENV_KEYS) delete env[k];',
    "  for (const k of ['BUDDY_RELAY_HELPER_POLL_MS', 'BUDDY_RELAY_HELPER_SETTLE_MS', 'BUDDY_RELAY_HELPER_VERIFY_MS', 'BUDDY_RELAY_HELPER_RETRY_MS']) delete env[k];",
    '  return env;',
    '};',
    'const resolveCwd = () => {',
    '  if (!macBundle && exe) {',
    '    const dir = path.dirname(exe);',
    '    try { if (dir && fs.existsSync(dir)) return dir; } catch (_) {}',
    '  }',
    '  return os.homedir();',
    '};',
    'const launchApp = (attempt) => {',
    '  const spawnOpts = {',
    '    detached: true,',
    "    stdio: 'ignore',",
    '    windowsHide: false,',
    '    cwd: resolveCwd(),',
    '    env: buildCleanEnv()',
    '  };',
    '  let settled = false;',
    '  let appChild;',
    '  try {',
    '    if (macBundle) {',
    "      appChild = spawn('open', ['-n', '-a', macBundle], spawnOpts);",
    '    } else {',
    '      appChild = spawn(exe, [], spawnOpts);',
    '    }',
    '  } catch (e) {',
    "    log('relaunch-failed attempt=' + attempt + ' ' + e.message);",
    '    process.exit(1);',
    '    return;',
    '  }',
    '  const childPid = appChild && appChild.pid ? appChild.pid : 0;',
    '  if (macBundle) {',
    '    let macDone = false;',
    '    let macTimer;',
    '    const finishMac = (ok, msg) => {',
    '      if (macDone) return;',
    '      macDone = true;',
    '      if (macTimer) clearTimeout(macTimer);',
    '      try { appChild.unref(); } catch (_) {}',
    '      log(msg);',
    '      process.exit(ok ? 0 : 1);',
    '    };',
    "    macTimer = setTimeout(() => finishMac(true, 'relaunched-mac attempt=' + attempt), Math.min(verifyMs, 1000));",
    "    appChild.on('error', (err) => finishMac(false, 'relaunch-mac-error ' + err.message));",
    "    appChild.on('exit', (code) => {",
    "      if (code === 0) finishMac(true, 'relaunched-mac attempt=' + attempt);",
    "      else finishMac(false, 'relaunch-mac-exit code=' + code);",
    '    });',
    '    return;',
    '  }',
    '  const aliveTimer = setTimeout(() => {',
    '    if (settled) return;',
    '    settled = true;',
    '    try { appChild.unref(); } catch (_) {}',
    "    log('relaunched attempt=' + attempt + ' pid=' + childPid);",
    '    process.exit(0);',
    '  }, verifyMs);',
    "  appChild.on('error', (err) => {",
    '    if (settled) return;',
    '    settled = true;',
    '    clearTimeout(aliveTimer);',
    "    log('relaunch-error attempt=' + attempt + ' ' + err.message);",
    '    if (attempt < 2) setTimeout(() => launchApp(attempt + 1), retryDelayMs);',
    '    else process.exit(1);',
    '  });',
    "  appChild.on('exit', (code, signal) => {",
    '    if (settled) return;',
    '    settled = true;',
    '    clearTimeout(aliveTimer);',
    "    log('relaunch-early-exit attempt=' + attempt + ' code=' + code + ' signal=' + signal);",
    '    if (attempt < 2) setTimeout(() => launchApp(attempt + 1), retryDelayMs);',
    '    else process.exit(code === 0 ? 0 : 1);',
    '  });',
    '};',
    "log('wait pids=' + pidList.join(',') + ' exe=' + exe);",
    'const t0 = Date.now();',
    'const timer = setInterval(() => {',
    '  const anyAlive = pidList.some(isPidAlive);',
    '  if (anyAlive && Date.now() - t0 < 120000) return;',
    '  clearInterval(timer);',
    '  if (!anyAlive) {',
    '    setTimeout(() => launchApp(1), settleMs);',
    '  } else {',
    "    log('timeout waiting exit');",
    '    process.exit(0);',
    '  }',
    '}, pollMs);',
    ''
  ].join('\n');
}

/**
 * 派发完全重启守护助手（detached，待宿主相关进程全部退出后拉起新实例）。
 * helper 以 ELECTRON_RUN_AS_NODE 运行，拉起新版 GUI 时清除所有宿主遗留环境变量。
 */
export function spawnIdeRestartHelper(
  relayDir: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    appRoot?: string;
    onLog?: (msg: string) => void;
  }
): { helperPath: string; pid?: number } {
  const dir = relayDir || PATHS.RELAY_DIR;
  const helperPath = path.join(dir, 'restart-helper.js');
  const logPath = path.join(dir, 'restart-helper.log');
  try {
    const env = options?.env || process.env;
    const exe = options?.execPath || process.execPath;
    const waitPids = collectRestartWaitPids(env, process.pid, process.ppid);
    if (waitPids.length === 0 || !exe) {
      return { helperPath };
    }
    fs.mkdirSync(dir, { recursive: true });
    let macAppBundle = '';
    if (process.platform === 'darwin') {
      const target = exe.includes('.app/Contents/') ? exe : (options?.appRoot || '');
      const idx = target.indexOf('.app/Contents/');
      if (idx > 0) {
        macAppBundle = target.slice(0, idx + 4);
      }
    }
    atomicWriteFileSync(helperPath, buildRestartHelperSource(logPath), { encoding: 'utf8', mode: 0o600 });

    const child = child_process.spawn(exe, [helperPath, waitPids.join(','), exe, macAppBundle], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.unref();
    options?.onLog?.(`spawned restart helper pid=${child.pid ?? 'unknown'} waitPids=${waitPids.join(',')}`);
    return { helperPath, pid: child.pid };
  } catch (err: any) {
    options?.onLog?.(`spawn restart helper failed: ${err?.message || err}`);
    return { helperPath };
  }
}
