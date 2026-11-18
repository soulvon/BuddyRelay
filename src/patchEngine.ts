import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V5 } from './constants';
import { atomicWriteFileSync } from './atomicFile';
import { t } from './i18n';

export interface PatchCheckResult {
  mainJsFound: boolean;
  mainJsPath?: string;
  isPatched: boolean;
  hasOriginBackup: boolean;
  version?: string;
  anchorsValid: boolean;
  details?: Record<string, any>;
  message: string;
}

export interface ElevationPlan {
  mainJsPath: string;
  originPath?: string;
  stagedMainPath: string;
  stagedOriginPath?: string;
  backupCreated: boolean;
}

export interface ElevatedApplyResult {
  success: boolean;
  cancelled?: boolean;
  mainJsPath: string;
  message: string;
  detail?: string;
  error?: string;
}

export interface ElevateRunResult { code: number; cancelled?: boolean; stdout?: string; stderr?: string; }
export type ElevateRunner = (plan: ElevationPlan) => Promise<ElevateRunResult>;

export interface ElevationArtifacts {
  scriptPath: string;
  scriptContent: string;
  errLogPath: string;
  command: string;
  commandArgs: string[];
}

export interface PatchApplyResult {
  success: boolean;
  mainJsPath: string;
  backupCreated: boolean;
  repatched?: boolean;
  needsElevation?: boolean;
  elevationPlan?: ElevationPlan;
  message: string;
  error?: string;
  detail?: string;
}

/** 语法校验结论：syntax=补丁本身有问题，no_runtime=本机没有可用校验运行时，timeout=校验超时 */
export interface SyntaxCheckResult {
  valid: boolean;
  error?: string;
  reason?: 'syntax' | 'no_runtime' | 'timeout';
}

export interface PatchEngineOptions {
  mainJsPath?: string;
  appRoot?: string;
  stagedPatchDir?: string;
  elevateRunner?: ElevateRunner;
}

interface SyntaxRunner { label: string; exe: string; env: NodeJS.ProcessEnv; }
interface LoadedCleanSource { src: string; originToWrite: string | null; backupCreated: boolean; originExisted: boolean; }

const escapePsSingle = (s: string) => String(s).replace(/'/g, "''");
const escapeShSingle = (s: string) => String(s).replace(/'/g, "'\\''");
const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isPermissionError(err: any): boolean {
  const code = String(err?.code || '');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') return true;
  return /operation not permitted|permission denied|拒绝访问|另一个程序正在使用/i.test(String(err?.message || ''));
}

function decodeOutput(buf?: Buffer): string {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.trim();
  try { return new TextDecoder('gbk').decode(buf).trim(); } catch { return utf8.trim(); }
}

function patchFail(
  mainJsPath: string,
  message: string,
  error: string,
  detail?: string,
  extra?: Partial<PatchApplyResult>
): PatchApplyResult {
  return { success: false, mainJsPath, backupCreated: false, message, error, detail, ...extra };
}

function elevateFail(
  mainJsPath: string,
  message: string,
  error: string,
  detail?: string,
  cancelled?: boolean
): ElevatedApplyResult {
  return { success: false, mainJsPath, message, error, detail, ...(cancelled ? { cancelled: true } : {}) };
}

/**
 * 构造跨平台系统原生单次提权复制脚本与启动参数。
 * 仅复制已完成语法校验的暂存文件至目标宿主目录，绝不以管理员权限运行整个 IDE。
 */
export function buildElevationArtifacts(platform: NodeJS.Platform, plan: ElevationPlan, scriptDir: string): ElevationArtifacts {
  const errLogPath = path.join(scriptDir, 'elevate-error.log');
  if (platform === 'win32') {
    const scriptPath = path.join(scriptDir, 'elevate-copy.ps1');
    const sOrigin = plan.stagedOriginPath && plan.originPath ? escapePsSingle(plan.stagedOriginPath) : '';
    const dOrigin = plan.stagedOriginPath && plan.originPath ? escapePsSingle(plan.originPath) : '';
    const sMain = escapePsSingle(plan.stagedMainPath);
    const dMain = escapePsSingle(plan.mainJsPath);
    const scriptContent = [
      "$ErrorActionPreference = 'Stop'",
      `$errFile = '${escapePsSingle(errLogPath)}'`,
      'try {',
      `  if ('${sOrigin}' -ne '' -and '${dOrigin}' -ne '') {`,
      `    if (Test-Path -LiteralPath '${dOrigin}') { Set-ItemProperty -LiteralPath '${dOrigin}' -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue }`,
      `    Copy-Item -LiteralPath '${sOrigin}' -Destination '${dOrigin}' -Force`,
      '  }',
      `  if (Test-Path -LiteralPath '${dMain}') { Set-ItemProperty -LiteralPath '${dMain}' -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue }`,
      `  Copy-Item -LiteralPath '${sMain}' -Destination '${dMain}' -Force`,
      '} catch {',
      '  try { [System.IO.File]::WriteAllText($errFile, $_.Exception.Message, [System.Text.Encoding]::UTF8) } catch {}',
      '  exit 1',
      '}',
      ''
    ].join('\r\n');

    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const resolvedPs = fs.existsSync(psExe) ? psExe : 'powershell.exe';
    const runnerCmd =
      `$p = Start-Process -FilePath '${escapePsSingle(resolvedPs)}' ` +
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${escapePsSingle(scriptPath)}') ` +
      `-Verb RunAs -Wait -PassThru; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
    return {
      scriptPath, scriptContent, errLogPath, command: resolvedPs,
      commandArgs: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', runnerCmd]
    };
  }

  const scriptPath = path.join(scriptDir, 'elevate-copy.sh');
  const lines = ['#!/bin/sh', 'set -e'];
  if (plan.stagedOriginPath && plan.originPath) {
    lines.push(`cp -f '${escapeShSingle(plan.stagedOriginPath)}' '${escapeShSingle(plan.originPath)}'`);
  }
  lines.push(`cp -f '${escapeShSingle(plan.stagedMainPath)}' '${escapeShSingle(plan.mainJsPath)}'`, '');
  const scriptContent = lines.join('\n');

  if (platform === 'darwin') {
    return {
      scriptPath, scriptContent, errLogPath, command: 'osascript',
      commandArgs: ['-e', `do shell script "/bin/sh '${escapeShSingle(scriptPath)}'" with administrator privileges`]
    };
  }
  return { scriptPath, scriptContent, errLogPath, command: 'pkexec', commandArgs: ['/bin/sh', scriptPath] };
}

/** CodeBuddy main.js 补丁注入、语法校验、原文件还原与按需系统提权引擎 */
export class PatchEngine {
  private readonly customMainJsPath?: string;
  private readonly appRootPath?: string;
  private readonly stagedPatchDir?: string;
  private readonly customElevateRunner?: ElevateRunner;
  private static _preferredRunner = '';

  constructor(options?: PatchEngineOptions) {
    this.customMainJsPath = options?.mainJsPath;
    this.appRootPath = options?.appRoot;
    this.stagedPatchDir = options?.stagedPatchDir;
    this.customElevateRunner = options?.elevateRunner;
  }

  /** 定位 CodeBuddy main.js 入口文件 */
  public locateMainJs(): string | null {
    if (this.customMainJsPath && fs.existsSync(this.customMainJsPath)) return this.customMainJsPath;
    if (this.appRootPath) {
      const runningMain = path.join(this.appRootPath, 'out', 'main.js');
      if (fs.existsSync(runningMain)) return runningMain;
    }
    return PATHS.CANDIDATE_MAIN_JS_PATHS.find(p => fs.existsSync(p)) || null;
  }

  private hasInjectedPatch(content: string): boolean {
    return content.includes(PATCH_V5.PATCH_FLAG);
  }

  /** 动态发现会话服务类构造函数锚点（优先 GV_OLD 完整体，漂移时退化为语义签名） */
  public resolveSessionClassAnchor(src: string): string | null {
    let idx = src.indexOf(PATCH_V5.GV_OLD);
    if (idx < 0) {
      const sigMatches = src.match(/getV2ReconcileData\([^)]*\)\{/g) || [];
      if (sigMatches.length !== 1) return null;
      idx = src.indexOf(sigMatches[0]);
    }
    const win = src.slice(Math.max(0, idx - 20000), idx);
    const classDefRe = /[A-Za-z_$][\w$]*=class\{constructor\([^)]*\)\{/g;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = classDefRe.exec(win)) !== null) last = m;
    return last ? last[0] : null;
  }

  /** 从已注入过历史结构的主程序文件中还原干净源码 */
  public stripInjectedPatch(content: string): string | null {
    const markerIdx = content.search(/\/\*__BYOK_V5[\s\S]*?\*\//);
    const logIdx = content.indexOf('__byokLog(m){');
    const starts = [markerIdx, logIdx].filter(i => i >= 0);
    if (starts.length === 0) return null;
    const start = Math.min(...starts);
    const tail = content.slice(start).match(/async restoreSession\(|scheduleRefresh\(e=0\)\{/);
    if (!tail || tail.index === undefined || tail.index <= 0) return null;

    const restored = (content.slice(0, start) + content.slice(start + tail.index))
      .split('globalThis.__cbSession=this;').join('')
      .split('this.startByokWatcher();').join('');

    if (this.hasInjectedPatch(restored) || !this.resolveSessionClassAnchor(restored)) return null;
    if ((restored.match(/async restoreSession\([^)]*\)\{/g) || []).length !== 1) return null;
    if ((restored.match(/constructor\([^)]*\)\{(?=this\.instantiationService=)/g) || []).length !== 1) return null;
    return restored;
  }

  /** 检查 main.js 当前 Patch v5 状态 */
  public checkPatch(targetPath?: string): PatchCheckResult {
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) {
      return { mainJsFound: false, isPatched: false, hasOriginBackup: false, anchorsValid: false, message: t('sw.mainJsNotFound') };
    }
    const originPath = `${mainPath}.byok-origin`;
    const hasOriginBackup = fs.existsSync(originPath);
    let content: string;
    try { content = fs.readFileSync(mainPath, 'utf8'); } catch (err: any) {
      return { mainJsFound: true, mainJsPath: mainPath, isPatched: false, hasOriginBackup, anchorsValid: false, message: t('doctor.mainUnreadable', err.message) };
    }

    const hasFlag = this.hasInjectedPatch(content);
    const isPatched = hasFlag && content.includes(PATCH_V5.V5_MARKER);
    const isLegacyV4 = hasFlag && !isPatched;

    let checkTargetContent = content;
    let originUnusable = false;
    let originReadError = '';
    if (isLegacyV4) {
      try {
        const originSrc = fs.readFileSync(originPath, 'utf8');
        if (this.hasInjectedPatch(originSrc)) {
          originUnusable = true;
          originReadError = 'origin contains injected patch';
        } else {
          checkTargetContent = originSrc;
        }
      } catch (err: any) { originUnusable = true; originReadError = err.message; }
    }

    const amCount = this.resolveSessionClassAnchor(checkTargetContent) ? 1 : 0;
    const gvCount = (checkTargetContent.match(new RegExp(escapeRegExp(PATCH_V5.GV_OLD), 'g')) || []).length;
    const gsCount = (checkTargetContent.match(new RegExp(escapeRegExp(PATCH_V5.GS_OLD), 'g')) || []).length;
    const restoreCount = (checkTargetContent.match(/async restoreSession\([^)]*\)\{/g) || []).length;
    const anchorsValid = isPatched || (!originUnusable && amCount === 1 && restoreCount === 1);

    return {
      mainJsFound: true, mainJsPath: mainPath, isPatched, hasOriginBackup,
      version: isPatched ? PATCH_V5.VERSION : undefined,
      anchorsValid,
      details: { amCount, gvCount, gsCount, restoreCount, isLegacyV4, originUnusable, originReadError },
      message: isPatched ? t('sw.patched', PATCH_V5.VERSION)
        : isLegacyV4 ? t('sw.upgradeFromV4') : anchorsValid ? t('sw.originalOk') : t('sw.anchorTampered')
    };
  }

  /** 使用宿主 Electron (ELECTRON_RUN_AS_NODE) 或系统 node --check 验证 JS 语法 */
  public validateSyntax(filePath: string): SyntaxCheckResult {
    const runners: SyntaxRunner[] = [];
    if (process.execPath) {
      runners.push({ label: '宿主运行时', exe: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    }
    runners.push({ label: '系统 node', exe: 'node', env: process.env });

    const preferred = PatchEngine._preferredRunner;
    const idx = preferred ? runners.findIndex(r => r.label === preferred) : -1;
    if (idx > 0) runners.unshift(runners.splice(idx, 1)[0]);

    const unavailable: string[] = [];
    for (const runner of runners) {
      try {
        child_process.execFileSync(runner.exe, ['--check', filePath], { stdio: 'pipe', timeout: 20000, env: runner.env });
        PatchEngine._preferredRunner = runner.label;
        return { valid: true };
      } catch (err: any) {
        if (err.code === 'ENOENT' || err.code === 'EACCES') { unavailable.push(`${runner.label}: ${err.code}`); continue; }
        if (err.signal === 'SIGTERM') return { valid: false, reason: 'timeout', error: `${runner.label} --check 超时（20s）` };
        const output = decodeOutput(err.stderr) || decodeOutput(err.stdout) || String(err.message || '').trim();
        if (/SyntaxError|MODULE_NOT_FOUND/.test(output)) return { valid: false, reason: 'syntax', error: output };
        unavailable.push(`${runner.label}: ${output.split('\n')[0] || '未知输出'}`);
      }
    }
    return { valid: false, reason: 'no_runtime', error: unavailable.join('; ') || '无可用的 JavaScript 运行时' };
  }

  private validateSourceInTemp(src: string, mainPath: string, allowNoRuntime: boolean = false): PatchApplyResult | null {
    const validateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddyrelay-validate-'));
    const validateJsPath = path.join(validateDir, `main.tmp_${Date.now()}.js`);
    try {
      fs.writeFileSync(validateJsPath, src, 'utf8');
      const checkRes = this.validateSyntax(validateJsPath);
      if (checkRes.valid || (allowNoRuntime && checkRes.reason === 'no_runtime')) return null;
      const msg = checkRes.reason === 'no_runtime' ? t('sw.checkNoRuntime')
        : checkRes.reason === 'timeout' ? t('sw.checkTimeout') : t('sw.syntaxCheckFailed');
      const errCode = checkRes.reason === 'no_runtime' ? 'CHECK_RUNTIME_MISSING' : 'SYNTAX_CHECK_FAILED';
      return patchFail(mainPath, msg, errCode, checkRes.error);
    } catch (err: any) {
      return patchFail(mainPath, t('sw.writeFailed', err.message), err.code || 'TMP_WRITE_FAILED', err.message);
    } finally {
      try { fs.rmSync(validateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private loadCleanSource(mainPath: string, originPath: string): LoadedCleanSource | PatchApplyResult {
    const originExisted = fs.existsSync(originPath);
    let originReadError = '';
    try {
      const content = fs.readFileSync(mainPath, 'utf8');
      let cleanBackup: string | null = null;
      if (originExisted) {
        try {
          const candidate = fs.readFileSync(originPath, 'utf8');
          if (!this.hasInjectedPatch(candidate)) cleanBackup = candidate;
        } catch (err: any) { originReadError = err.message; }
      }
      if (!this.hasInjectedPatch(content)) {
        return { src: content, originToWrite: content, backupCreated: !originExisted, originExisted };
      }
      if (cleanBackup !== null) {
        return { src: cleanBackup, originToWrite: null, backupCreated: false, originExisted };
      }
      const restored = this.stripInjectedPatch(content);
      if (restored === null) {
        return patchFail(mainPath, t('sw.sourceRestoreFailed'), 'SOURCE_RESTORE_FAILED', originReadError || undefined);
      }
      return { src: restored, originToWrite: restored, backupCreated: !originExisted, originExisted };
    } catch (err: any) {
      const msg = isPermissionError(err) ? t('sw.writePermissionDenied') : t('sw.backupFailed', err.message);
      return patchFail(mainPath, msg, err.code || 'ORIGIN_BACKUP_FAILED', err.message);
    }
  }

  private applyPatchTransforms(cleanSrc: string, mainPath: string): { patchedSrc: string; skipNotes: string[] } | PatchApplyResult {
    let src = cleanSrc;
    const sessionAnchor = this.resolveSessionClassAnchor(src);
    if (!sessionAnchor || src.split(sessionAnchor).length - 1 !== 1) {
      return patchFail(mainPath, t('sw.anchorAmMissing'), 'AM_ANCHOR_MISSING');
    }
    src = src.replace(sessionAnchor, () => sessionAnchor + PATCH_V5.SESSION_HOOK);

    const optionalMissing: string[] = [];
    if (src.includes(PATCH_V5.GV_OLD)) src = src.replace(PATCH_V5.GV_OLD, () => PATCH_V5.GV_NEW);
    else optionalMissing.push('getV2ReconcileData');
    if (src.includes(PATCH_V5.GS_OLD)) src = src.replace(PATCH_V5.GS_OLD, () => PATCH_V5.GS_NEW);
    else optionalMissing.push('getSessions');
    const skipNotes = optionalMissing.length > 0 ? [t('sw.optionalAnchorSkipped', optionalMissing.join(', '))] : [];

    const restoreMatches = src.match(/async restoreSession\([^)]*\)\{/g) || [];
    if (restoreMatches.length !== 1) return patchFail(mainPath, t('sw.anchorRestoreMissing'), 'RESTORE_ANCHOR_MISSING');
    src = src.replace(restoreMatches[0], () => PATCH_V5.WATCHER_METHODS + restoreMatches[0]);

    const bootRe = /constructor\([^)]*\)\{(?=this\.instantiationService=)/g;
    if ((src.match(bootRe) || []).length !== 1) return patchFail(mainPath, t('sw.anchorRestoreMissing'), 'WATCHER_BOOT_ANCHOR_MISSING');
    src = src.replace(bootRe, (m0) => m0 + 'this.startByokWatcher();');
    return { patchedSrc: src, skipNotes };
  }

  private resolveStageRoot(): string {
    if (this.stagedPatchDir) return this.stagedPatchDir;
    try {
      fs.mkdirSync(PATHS.RELAY_DIR, { recursive: true });
      return path.join(PATHS.RELAY_DIR, 'pending-patch');
    } catch {
      return path.join(os.tmpdir(), 'buddyrelay-pending-patch');
    }
  }

  /** 将已校验补丁原子暂存到用户可写目录，生成单次提权复制计划 */
  public buildElevationPlan(
    mainPath: string,
    originPath: string,
    originToWrite: string | null,
    patchedSrc: string,
    backupCreated: boolean
  ): ElevationPlan {
    const dir = this.resolveStageRoot();
    fs.mkdirSync(dir, { recursive: true });
    const stagedMainPath = path.join(dir, 'main.patched.js');
    atomicWriteFileSync(stagedMainPath, patchedSrc);

    let stagedOriginPath: string | undefined;
    if (originToWrite !== null) {
      stagedOriginPath = path.join(dir, 'main.byok-origin');
      atomicWriteFileSync(stagedOriginPath, originToWrite);
    }
    return { mainJsPath: mainPath, originPath: stagedOriginPath ? originPath : undefined, stagedMainPath, stagedOriginPath, backupCreated };
  }

  private commitOrStage(
    mainPath: string,
    originPath: string,
    originToWrite: string | null,
    targetSrc: string,
    backupCreated: boolean,
    originExisted: boolean
  ): PatchApplyResult | null {
    let wroteNewOrigin = false;
    try {
      if (originToWrite !== null) {
        atomicWriteFileSync(originPath, originToWrite);
        wroteNewOrigin = !originExisted;
      }
      atomicWriteFileSync(mainPath, targetSrc);
      return null;
    } catch (err: any) {
      if (wroteNewOrigin) { try { if (fs.existsSync(originPath)) fs.unlinkSync(originPath); } catch { /* ignore */ } }
      if (isPermissionError(err)) {
        try {
          const plan = this.buildElevationPlan(mainPath, originPath, originToWrite, targetSrc, backupCreated);
          return patchFail(mainPath, t('sw.writePermissionDenied'), 'NEEDS_ELEVATION', err.message, { needsElevation: true, elevationPlan: plan });
        } catch (stageErr: any) {
          return patchFail(mainPath, t('sw.writePermissionDenied'), 'NEEDS_ELEVATION_STAGE_FAILED', `${err.message} | stage: ${stageErr.message}`);
        }
      }
      return patchFail(mainPath, t('sw.writeFailed', err.message), err.code || 'MAIN_WRITE_FAILED', err.message, { backupCreated });
    }
  }

  /** 检查并自愈 main.js Patch v5 */
  public healPatch(targetPath?: string): PatchApplyResult {
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) return patchFail(mainPath || '', t('sw.cannotLocate'), 'MAIN_JS_NOT_FOUND');

    const check = this.checkPatch(mainPath);
    if (check.isPatched) {
      const syntaxCheck = this.validateSyntax(mainPath);
      if (syntaxCheck.valid || syntaxCheck.reason === 'no_runtime') {
        return {
          success: true, mainJsPath: mainPath, backupCreated: check.hasOriginBackup, repatched: false,
          message: syntaxCheck.valid ? t('sw.patchHealthy') : t('sw.patchHealthyNoCheck'),
          detail: syntaxCheck.valid ? undefined : syntaxCheck.error
        };
      }
    }

    const originPath = `${mainPath}.byok-origin`;
    const loaded = this.loadCleanSource(mainPath, originPath);
    if ('success' in loaded) return loaded;

    const transformed = this.applyPatchTransforms(loaded.src, mainPath);
    if ('success' in transformed) return transformed;

    const syntaxErr = this.validateSourceInTemp(transformed.patchedSrc, mainPath, false);
    if (syntaxErr) return syntaxErr;

    const writeErr = this.commitOrStage(mainPath, originPath, loaded.originToWrite, transformed.patchedSrc, loaded.backupCreated, loaded.originExisted);
    if (writeErr) return writeErr;

    return {
      success: true, mainJsPath: mainPath, backupCreated: loaded.backupCreated, repatched: true,
      message: transformed.skipNotes.length > 0 ? `${t('sw.patchDone')} ${transformed.skipNotes.join(' ')}` : t('sw.patchDone')
    };
  }

  /** 从 .byok-origin 备份或剥离注入体还原干净 main.js */
  public restoreOriginal(targetPath?: string): PatchApplyResult {
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) return patchFail(mainPath || '', t('sw.cannotLocate'), 'MAIN_JS_NOT_FOUND');
    const originPath = `${mainPath}.byok-origin`;
    const originExisted = fs.existsSync(originPath);
    let content: string;
    try { content = fs.readFileSync(mainPath, 'utf8'); } catch (err: any) {
      return patchFail(mainPath, t('doctor.mainUnreadable', err.message), err.code || 'MAIN_READ_FAILED', err.message, { backupCreated: originExisted });
    }
    if (!this.hasInjectedPatch(content)) {
      return { success: true, mainJsPath: mainPath, backupCreated: originExisted, repatched: false, message: t('sw.originalOk') };
    }

    let cleanSrc: string | null = null;
    if (originExisted) {
      try {
        const candidate = fs.readFileSync(originPath, 'utf8');
        if (!this.hasInjectedPatch(candidate)) cleanSrc = candidate;
      } catch { /* fallback below */ }
    }
    if (cleanSrc === null) cleanSrc = this.stripInjectedPatch(content);
    if (cleanSrc === null) {
      return patchFail(mainPath, t('sw.sourceRestoreFailed'), 'SOURCE_RESTORE_FAILED', undefined, { backupCreated: originExisted });
    }

    const syntaxErr = this.validateSourceInTemp(cleanSrc, mainPath, true);
    if (syntaxErr) return syntaxErr;

    const writeErr = this.commitOrStage(mainPath, originPath, null, cleanSrc, originExisted, originExisted);
    if (writeErr) return writeErr;
    return { success: true, mainJsPath: mainPath, backupCreated: originExisted, repatched: true, message: t('sw.originalOk') };
  }

  /** 按需单次系统原生提权落地补丁并做磁盘字节级核验 */
  public async applyElevatedPatch(plan: ElevationPlan): Promise<ElevatedApplyResult> {
    if (!plan || !plan.mainJsPath || !plan.stagedMainPath || !fs.existsSync(plan.stagedMainPath)) {
      return elevateFail(plan?.mainJsPath || '', t('sw.elevateFailed', 'staged patch missing'), 'STAGED_PATCH_MISSING');
    }

    let expectedBytes: Buffer;
    try {
      expectedBytes = fs.readFileSync(plan.stagedMainPath);
      const text = expectedBytes.toString('utf8');
      if (!text.includes(PATCH_V5.PATCH_FLAG) || !text.includes(PATCH_V5.V5_MARKER)) {
        return elevateFail(plan.mainJsPath, t('sw.elevateFailed', 'staged patch missing V5 marker'), 'STAGED_PATCH_INVALID');
      }
      const syntaxRes = this.validateSyntax(plan.stagedMainPath);
      if (!syntaxRes.valid && syntaxRes.reason !== 'no_runtime') {
        return elevateFail(plan.mainJsPath, t('sw.syntaxCheckFailed'), 'SYNTAX_CHECK_FAILED', syntaxRes.error);
      }
    } catch (err: any) {
      return elevateFail(plan.mainJsPath, t('sw.elevateFailed', err.message), 'STAGED_PATCH_READ_FAILED', err.message);
    }

    const runRes = await this.executeElevation(plan);
    if ('success' in runRes) return runRes;
    if (runRes.cancelled) return elevateFail(plan.mainJsPath, t('sw.elevateCancelled'), 'ELEVATION_CANCELLED', undefined, true);
    if (runRes.stderr?.startsWith('ENOENT:')) {
      return elevateFail(plan.mainJsPath, t('sw.elevateUnsupported', runRes.stderr.slice(7)), 'ELEVATION_TOOL_MISSING', runRes.stderr);
    }
    if (runRes.code !== 0) {
      return elevateFail(plan.mainJsPath, t('sw.elevateFailed', runRes.stderr || `exit ${runRes.code}`), 'ELEVATION_FAILED', runRes.stderr || runRes.stdout);
    }

    try {
      const actualBytes = fs.readFileSync(plan.mainJsPath);
      const patchedCheck = this.checkPatch(plan.mainJsPath);
      const originReady = !plan.stagedOriginPath || !plan.originPath || fs.existsSync(plan.originPath);
      if (Buffer.compare(actualBytes, expectedBytes) !== 0 || !patchedCheck.isPatched || !originReady) {
        return elevateFail(
          plan.mainJsPath, t('sw.elevateVerifyFailed'), 'ELEVATION_VERIFY_FAILED',
          `byteMatch=${Buffer.compare(actualBytes, expectedBytes) === 0}, isPatched=${patchedCheck.isPatched}, originReady=${originReady}`
        );
      }
    } catch (err: any) {
      return elevateFail(plan.mainJsPath, t('sw.elevateVerifyFailed'), 'ELEVATION_VERIFY_FAILED', err.message);
    }

    for (const f of [plan.stagedMainPath, plan.stagedOriginPath]) {
      if (f) try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    }
    return { success: true, mainJsPath: plan.mainJsPath, message: t('sw.elevateSuccess') };
  }

  private async executeElevation(plan: ElevationPlan): Promise<ElevateRunResult | ElevatedApplyResult> {
    if (this.customElevateRunner) {
      try { return await this.customElevateRunner(plan); } catch (err: any) {
        return elevateFail(plan.mainJsPath, t('sw.elevateFailed', err.message), 'ELEVATE_RUNNER_THROW', err.message);
      }
    }
    const runDir = fs.mkdtempSync(path.join(path.dirname(plan.stagedMainPath), 'elevate-run-'));
    const artifacts = buildElevationArtifacts(process.platform, plan, runDir);
    try {
      atomicWriteFileSync(
        artifacts.scriptPath,
        process.platform === 'win32' ? '\uFEFF' + artifacts.scriptContent : artifacts.scriptContent,
        { encoding: 'utf8', mode: process.platform === 'win32' ? 0o644 : 0o700 }
      );
      return await new Promise<ElevateRunResult>((resolve) => {
        child_process.execFile(artifacts.command, artifacts.commandArgs, { timeout: 120_000, windowsHide: true }, (err: any, stdout, stderr) => {
          let errLog = '';
          try { if (fs.existsSync(artifacts.errLogPath)) errLog = fs.readFileSync(artifacts.errLogPath, 'utf8').trim(); } catch { /* ignore */ }
          const outStr = String(stdout || '').trim();
          const errStr = [String(stderr || '').trim(), errLog, String(err?.message || '').trim()].filter(Boolean).join(' | ');
          if (!err) { resolve({ code: 0, stdout: outStr, stderr: errStr }); return; }
          if (err.code === 'ENOENT') { resolve({ code: -1, stdout: outStr, stderr: `ENOENT:${artifacts.command}` }); return; }
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          const cancelled = exitCode === 126 || /canceled|cancelled|用户已取消|操作已被用户取消|-128/i.test(errStr);
          resolve({ code: exitCode, cancelled, stdout: outStr, stderr: errStr });
        });
      });
    } finally {
      try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
