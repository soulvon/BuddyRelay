import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V5 } from './constants';
import { atomicWriteJsonSync, readJsonFileSafe } from './atomicFile';
import { CodeBuddyAccount, AccountStore, resolveAccountDisplayName } from './accountStore';
import { extractEnterpriseInfo } from './domain';
import { SessionHealer, normalizeLinkTarget } from './sessionHealer';
import { t } from './i18n';
import {
  PatchEngine,
  PatchCheckResult,
  ElevationPlan,
  ElevatedApplyResult,
  ElevateRunner,
  PatchApplyResult,
  SyntaxCheckResult
} from './patchEngine';

export {
  buildElevationArtifacts,
  ElevationPlan,
  PatchCheckResult,
  ElevatedApplyResult,
  ElevateRunResult,
  ElevateRunner,
  ElevationArtifacts,
  PatchApplyResult,
  SyntaxCheckResult,
  PatchEngine
} from './patchEngine';

export interface JunctionResult {
  success: boolean;
  masterPath: string;
  targetPath: string;
  alreadyExisted: boolean;
  message: string;
  error?: string;
}

export interface SwitchReceipt {
  verified: boolean;
  ok: boolean;
  skipped: boolean;
  legacyHost: boolean;
  notConsumed?: boolean;
  message: string;
}

export interface DoctorCheck { id: string; ok: boolean; detail: string; }

export type DoctorStatus =
  | 'healthy'
  | 'needs_full_restart'
  | 'repaired_needs_full_restart'
  | 'needs_elevation'
  | 'main_missing'
  | 'repair_failed';

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  message: string;
  elevationPlan?: ElevationPlan;
}

export interface SwitchResult {
  success: boolean;
  account: CodeBuddyAccount;
  patchResult: PatchApplyResult;
  junctionResult: JunctionResult;
  receipt?: SwitchReceipt;
  needsFullRestart?: boolean;
  needsElevation?: boolean;
  elevationPlan?: ElevationPlan;
  message: string;
  error?: string;
  detail?: string;
}

function juncResult(
  success: boolean,
  targetPath: string,
  masterPath: string,
  message: string,
  alreadyExisted: boolean = false,
  error?: string
): JunctionResult {
  return { success, masterPath, targetPath, alreadyExisted, message, ...(error ? { error } : {}) };
}

function switchFail(
  account: CodeBuddyAccount,
  patchResult: PatchApplyResult,
  junctionResult: JunctionResult,
  message: string,
  extra?: Partial<SwitchResult>
): SwitchResult {
  return { success: false, account, patchResult, junctionResult, message, ...extra };
}

/**
 * BuddyRelay 热切中枢与底层通信引擎
 * 专职切号串行编排、NTFS Junction 物理会话穿透映射、byok-switch.json 指令投递与回执闭环；
 * main.js 补丁注入、语法校验与提权引擎已抽离至 PatchEngine。
 */
export class SeamlessSwitcher {
  private customCmdPath?: string;
  private readonly healer: SessionHealer;
  private readonly patchEngine: PatchEngine;
  private _switchQueue: Promise<unknown> = Promise.resolve();
  private _isSwitching: boolean = false;

  constructor(options?: {
    mainJsPath?: string;
    cmdPath?: string;
    healer?: SessionHealer;
    appRoot?: string;
    stagedPatchDir?: string;
    elevateRunner?: ElevateRunner;
  }) {
    this.customCmdPath = options?.cmdPath;
    this.healer = options?.healer || new SessionHealer();
    this.patchEngine = new PatchEngine({
      mainJsPath: options?.mainJsPath,
      appRoot: options?.appRoot,
      stagedPatchDir: options?.stagedPatchDir,
      elevateRunner: options?.elevateRunner
    });
  }

  public locateMainJs(): string | null { return this.patchEngine.locateMainJs(); }
  public checkPatch(targetPath?: string): PatchCheckResult { return this.patchEngine.checkPatch(targetPath); }
  public healPatch(targetPath?: string): PatchApplyResult { return this.patchEngine.healPatch(targetPath); }
  public restoreOriginal(targetPath?: string): PatchApplyResult { return this.patchEngine.restoreOriginal(targetPath); }
  public async applyElevatedPatch(plan: ElevationPlan): Promise<ElevatedApplyResult> { return this.patchEngine.applyElevatedPatch(plan); }

  /**
   * 委托 PatchEngine 使用 --check 验证 JS 语法：
   * 临时校验文件以 `tmp_${Date.now()}.js` 结尾，优先宿主 ELECTRON_RUN_AS_NODE 降级系统 node，
   * 错误信息经 checkRes.error 透传。
   */
  public validateSyntax(filePath: string): SyntaxCheckResult {
    return this.patchEngine.validateSyntax(filePath);
  }

  /** 提权写入补丁成功后一并准备会话映射与重启消费指令 */
  public async completeSwitchAfterElevation(
    plan: ElevationPlan,
    account?: CodeBuddyAccount,
    _store?: AccountStore
  ): Promise<ElevatedApplyResult & { switchReady?: boolean }> {
    const applied = await this.applyElevatedPatch(plan);
    if (!applied.success || !account) return applied;

    const junctionResult = this.ensureJunction(account.uid);
    if (!junctionResult.success) {
      return {
        success: false,
        mainJsPath: plan.mainJsPath,
        message: junctionResult.message,
        error: junctionResult.error || 'JUNCTION_FAILED'
      };
    }
    try {
      await this.writeSwitchCommand(account);
    } catch (err: any) {
      return {
        success: false,
        mainJsPath: plan.mainJsPath,
        message: t('sw.cmdWriteFailed', err.message),
        detail: err.message,
        error: 'CMD_WRITE_FAILED'
      };
    }
    return { ...applied, switchReady: true };
  }

  private resolveUsableMasterPath(
    targetLink: string,
    masterUid?: string
  ): { ok: true; masterPath: string } | { ok: false; earlyResult: JunctionResult } {
    const baseDir = PATHS.EXTENSION_DATA_DIR;
    let masterPath: string;
    if (masterUid) {
      masterPath = path.join(baseDir, masterUid, 'CodeBuddyIDE', masterUid);
    } else {
      let master = this.healer.resolveMasterForSwitch();
      if (!master) {
        try { this.healer.heal(); } catch (err: any) { this.healer.log(`switch-time heal failed: ${err.message}`); }
        master = this.healer.resolveMasterForSwitch();
      }
      if (!master) {
        return { ok: false, earlyResult: juncResult(true, targetLink, '', t('sw.junctionSkippedNoData')) };
      }
      masterPath = master.masterPath;
    }

    let masterUsable = false;
    try {
      const stat = fs.lstatSync(masterPath);
      masterUsable = stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(masterPath).length > 0;
    } catch {
      masterUsable = false;
    }
    if (!masterUsable) {
      return {
        ok: false,
        earlyResult: juncResult(false, targetLink, masterPath, t('sw.masterSessionUnavailable'), false, 'MASTER_SESSION_DIR_MISSING')
      };
    }
    return { ok: true, masterPath };
  }

  private prepareTargetLinkPath(targetLink: string, masterPath: string): JunctionResult | null {
    let isJunction = false;
    try { isJunction = fs.lstatSync(targetLink).isSymbolicLink(); } catch { isJunction = false; }

    if (isJunction) {
      let currentTarget = '';
      try { currentTarget = fs.readlinkSync(targetLink); } catch { currentTarget = ''; }
      const pointingHere =
        currentTarget &&
        normalizeLinkTarget(path.resolve(path.dirname(targetLink), currentTarget)) === normalizeLinkTarget(path.resolve(masterPath));
      if (pointingHere) {
        return juncResult(true, targetLink, masterPath, t('sw.junctionReady', targetLink, masterPath), true);
      }
      try {
        try { fs.unlinkSync(targetLink); } catch { fs.rmdirSync(targetLink); }
        this.healer.log(`drop stale link ${targetLink} (was -> ${currentTarget})`);
        return null;
      } catch (err: any) {
        return juncResult(false, targetLink, masterPath, t('sw.symlinkFailed', err.message), true, err.message);
      }
    }

    if (!fs.existsSync(targetLink)) return null;

    let targetStat: fs.Stats | null = null;
    try { targetStat = fs.lstatSync(targetLink); } catch { targetStat = null; }
    if (targetStat && !targetStat.isDirectory()) {
      return juncResult(false, targetLink, masterPath, t('sw.symlinkFailed', `目标路径已被非目录文件占用: ${targetLink}`), false, 'TARGET_NOT_DIRECTORY');
    }

    if (fs.readdirSync(targetLink).length > 0) {
      try { this.healer.adoptIntoMaster(targetLink, masterPath); }
      catch (err: any) { return juncResult(false, targetLink, masterPath, t('sw.mergeFailed', err.message), false, 'ADOPT_FAILED'); }
      try { this.healer.backupDir(targetLink); }
      catch (err: any) { return juncResult(false, targetLink, masterPath, t('sw.backupFailed', err.message), false, err.message); }
    } else {
      try { fs.rmdirSync(targetLink); }
      catch (err: any) { return juncResult(false, targetLink, masterPath, t('sw.backupFailed', err.message), false, err.message); }
    }
    return null;
  }

  /** 自动创建并维系 NTFS Junction / POSIX 软链接映射 */
  public ensureJunction(targetUid: string, masterUid?: string): JunctionResult {
    const baseDir = PATHS.EXTENSION_DATA_DIR;
    const targetParent = path.join(baseDir, targetUid, 'CodeBuddyIDE');
    const targetLink = path.join(targetParent, targetUid);

    const masterRes = this.resolveUsableMasterPath(targetLink, masterUid);
    if (!masterRes.ok) return masterRes.earlyResult;
    const masterPath = masterRes.masterPath;

    if (path.resolve(targetLink).toLowerCase() === path.resolve(masterPath).toLowerCase()) {
      return juncResult(true, targetLink, masterPath, t('sw.junctionMaster'), true);
    }
    if (!fs.existsSync(targetParent)) fs.mkdirSync(targetParent, { recursive: true });

    const prepResult = this.prepareTargetLinkPath(targetLink, masterPath);
    if (prepResult) return prepResult;

    const isWin = process.platform === 'win32';
    try {
      fs.symlinkSync(masterPath, targetLink, isWin ? 'junction' : 'dir');
      return juncResult(true, targetLink, masterPath, t('sw.symlinkCreated', targetLink, masterPath));
    } catch {
      if (isWin) {
        try {
          child_process.execSync(`cmd /c mklink /J "${targetLink}" "${masterPath}"`, { stdio: 'pipe' });
          return juncResult(true, targetLink, masterPath, t('sw.junctionViaMklink', targetLink, masterPath));
        } catch (cmdErr: any) {
          return juncResult(false, targetLink, masterPath, t('sw.junctionFailed', cmdErr.message), false, cmdErr.message);
        }
      }
      try {
        child_process.execFileSync('ln', ['-s', masterPath, targetLink], { stdio: 'pipe' });
        return juncResult(true, targetLink, masterPath, t('sw.symlinkViaLn', targetLink, masterPath));
      } catch (lnErr: any) {
        return juncResult(false, targetLink, masterPath, t('sw.symlinkFailed', lnErr.message), false, lnErr.message);
      }
    }
  }

  /** 写入 byok-switch.json 动态指令，唤醒 CodeBuddy 宿主执行无缝热切 */
  public async writeSwitchCommand(
    account: CodeBuddyAccount,
    customPath?: string
  ): Promise<{ file: string; ts: number }> {
    const targetFile = customPath || this.customCmdPath || PATHS.BYOK_SWITCH_FILE;
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const nowMs = Date.now();
    const uid = account.uid;
    const label = account.nickname || account.email || uid;
    const tok = account.accessToken;
    const refresh = account.refreshToken || (account.authRaw as any)?.refreshToken || '';
    const domain = account.domain || (account.authRaw as any)?.domain || 'www.codebuddy.cn';
    const expiresAt = account.expiresAt || (nowMs + 7200 * 1000);
    const ent = extractEnterpriseInfo(account);
    const accountObj = {
      id: uid,
      uid,
      label,
      nickname: label,
      pluginEnabled: true,
      lastLogin: true,
      ...(ent.enterpriseId ? { enterpriseId: ent.enterpriseId } : {}),
      ...(ent.enterpriseName ? { enterpriseName: ent.enterpriseName } : {}),
      ...(ent.accountType ? { type: ent.accountType } : {})
    };

    const commandPayload = {
      session: {
        id: 'Tencent-Cloud.genie-ide',
        token: tok,
        refreshToken: refresh,
        expiresAt,
        domain,
        accessToken: `${uid}+${tok}`,
        converted: true,
        account: accountObj,
        auth: {
          accessToken: tok,
          refreshToken: refresh,
          tokenType: account.tokenType || 'Bearer',
          domain,
          expiresAt,
          expiresIn: (account.authRaw as any)?.expiresIn || 7200,
          refreshExpiresIn: (account.authRaw as any)?.refreshExpiresIn || 0,
          refreshExpiresAt: 0,
          lastRefreshTime: nowMs
        },
        accounts: [accountObj]
      },
      ts: nowMs,
      from: 'buddy-relay-hub'
    };

    atomicWriteJsonSync(targetFile, commandPayload, 2);
    return { file: targetFile, ts: nowMs };
  }

  /** 等待宿主切换回执（ts 不匹配的旧回执清除后继续等待） */
  public async waitForSwitchReceipt(
    cmdTs: number,
    timeoutMs: number = 8000,
    expectedUid: string = ''
  ): Promise<SwitchReceipt> {
    const cmdFile = this.customCmdPath || PATHS.BYOK_SWITCH_FILE;
    const receiptFile = PATHS.BYOK_SWITCH_RESULT_FILE;
    const start = Date.now();
    let consumed = false;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 400));
      if (!consumed && !fs.existsSync(cmdFile)) consumed = true;

      const readRes = readJsonFileSafe<any>(receiptFile);
      if (readRes.status !== 'ok') continue;

      const data = readRes.data;
      if (data && Number(data.ts) === Number(cmdTs)) {
        try { fs.unlinkSync(receiptFile); } catch { /* ignore */ }
        if (data.ok) {
          const uidMatched = Boolean(data.uid) && (!expectedUid || String(data.uid) === String(expectedUid));
          if (!uidMatched) {
            return { verified: false, ok: false, skipped: false, legacyHost: false, message: t('sw.receiptUidMismatch') };
          }
          return {
            verified: true,
            ok: true,
            skipped: Boolean(data.skipped),
            legacyHost: false,
            message: data.skipped ? t('sw.receiptSkipped') : t('sw.receiptDone')
          };
        }
        return {
          verified: true,
          ok: false,
          skipped: false,
          legacyHost: false,
          message: t('sw.hostSwitchFailed', data.err || t('err.unknownError'))
        };
      }
      try { fs.unlinkSync(receiptFile); } catch { /* ignore */ }
    }

    if (consumed) {
      return { verified: false, ok: false, skipped: false, legacyHost: true, message: t('sw.legacyNoReceipt') };
    }
    return { verified: false, ok: false, skipped: false, legacyHost: false, notConsumed: true, message: t('sw.noReceipt') };
  }

  /** 完整热切执行（窗口内串行队列） */
  public switchAccount(accountOrUid: CodeBuddyAccount | string, store?: AccountStore): Promise<SwitchResult> {
    const run = async () => {
      this._isSwitching = true;
      try {
        return await this.doSwitchAccount(accountOrUid, store);
      } finally {
        this._isSwitching = false;
      }
    };
    const next = this._switchQueue.then(run, run);
    this._switchQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 读取当前磁盘上待宿主消费的切换指令时间戳 */
  public readPendingCommandTs(): number | null {
    const cmdFile = this.customCmdPath || PATHS.BYOK_SWITCH_FILE;
    const res = readJsonFileSafe<{ ts?: unknown }>(cmdFile);
    if (res.status !== 'ok') return null;
    const ts = Number(res.data?.ts);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }

  /** 启动后对齐重启前消费的切换回执 */
  public async reconcilePendingSwitch(store: AccountStore, expectedTs?: number): Promise<CodeBuddyAccount | null> {
    if (this._isSwitching) return null;
    const receiptFile = PATHS.BYOK_SWITCH_RESULT_FILE;
    const res = readJsonFileSafe<any>(receiptFile);
    if (res.status !== 'ok' || !res.data || typeof res.data !== 'object') return null;
    const data = res.data;

    const receiptTs = Number(data.ts || 0);
    if (expectedTs !== undefined && receiptTs !== Number(expectedTs)) return null;

    const pendingTs = this.readPendingCommandTs();
    if (pendingTs !== null && pendingTs !== receiptTs) return null;

    const isFresh = receiptTs > 0 && Date.now() - receiptTs < 24 * 60 * 60 * 1000;
    try { fs.unlinkSync(receiptFile); } catch { /* ignore */ }
    if (!isFresh || !data.ok || !data.uid) return null;

    const matched = store.get(String(data.uid));
    if (!matched) return null;
    if (store.getActive()?.uid !== matched.uid) await store.setActive(matched.id);
    return matched;
  }

  private async doSwitchAccount(accountOrUid: CodeBuddyAccount | string, store?: AccountStore): Promise<SwitchResult> {
    let account: CodeBuddyAccount | undefined;
    if (typeof accountOrUid === 'string') {
      if (!store) throw new Error(t('err.uidNeedsStore'));
      account = store.get(accountOrUid) || store.find(accountOrUid);
      if (!account) throw new Error(t('err.notInPool', accountOrUid));
    } else {
      account = accountOrUid;
    }

    const emptyJunction = juncResult(false, '', '', t('sw.patchHealFailed'));
    const patchResult = this.healPatch();
    if (!patchResult.success) {
      return switchFail(
        account,
        patchResult,
        emptyJunction,
        patchResult.needsElevation ? patchResult.message : t('sw.patchInjectFailed', patchResult.message),
        { needsElevation: patchResult.needsElevation, elevationPlan: patchResult.elevationPlan, error: patchResult.error, detail: patchResult.detail }
      );
    }

    const junctionResult = this.ensureJunction(account.uid);
    if (!junctionResult.success) {
      return switchFail(account, patchResult, junctionResult, junctionResult.message, { error: junctionResult.error || 'JUNCTION_FAILED' });
    }

    let cmdTs: number;
    try {
      cmdTs = (await this.writeSwitchCommand(account)).ts;
    } catch (err: any) {
      return switchFail(account, patchResult, junctionResult, t('sw.cmdWriteFailed', err.message), { error: err.message });
    }

    const label = resolveAccountDisplayName(account);
    if (patchResult.repatched) {
      return switchFail(account, patchResult, junctionResult, t('sw.repatchPending', label), { needsFullRestart: true, error: 'NEEDS_FULL_RESTART' });
    }

    const receipt = await this.waitForSwitchReceipt(cmdTs, 8000, account.uid);
    if (receipt.legacyHost) {
      await this.writeSwitchCommand(account);
      return switchFail(account, patchResult, junctionResult, t('sw.restartToComplete', label), { receipt, needsFullRestart: true, error: 'NEEDS_FULL_RESTART' });
    }
    if (receipt.notConsumed && !this.isWatcherAlive(patchResult.mainJsPath)) {
      return switchFail(account, patchResult, junctionResult, t('sw.watcherDownRestart', label), { receipt, needsFullRestart: true, error: 'NEEDS_FULL_RESTART' });
    }

    const confirmed = receipt.ok && receipt.verified;
    if (confirmed && store) await store.setActive(account.id);

    return {
      success: confirmed,
      account,
      patchResult,
      junctionResult,
      receipt,
      message: confirmed ? t('sw.switchedReceipt', label, receipt.skipped ? t('sw.receiptSkipSuffix') : '') : t('sw.notEffective', receipt.message),
      error: confirmed ? undefined : 'HOST_RECEIPT_UNCONFIRMED'
    };
  }

  /** watcher 活性判定（纯读）：诊断日志 mtime 必须不早于 main.js mtime */
  public isWatcherAlive(mainPath: string, logOverridePath?: string): boolean {
    const logPath = logOverridePath || path.join(PATHS.CODEBUDDY_APPDATA_DIR, 'byok-watcher.log');
    try {
      return fs.statSync(logPath).mtimeMs >= fs.statSync(mainPath).mtimeMs - 1000;
    } catch {
      return false;
    }
  }

  /** 切号链路自检：main.js 定位 -> 磁盘补丁 -> watcher 运行痕迹 -> 指令状态 */
  public runDoctor(targetPath?: string, logOverridePath?: string): DoctorReport {
    const checks: DoctorCheck[] = [];
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) {
      checks.push({ id: 'main_js', ok: false, detail: t('doctor.mainMissing') });
      return { status: 'main_missing', checks, message: t('doctor.mainMissing') };
    }
    checks.push({ id: 'main_js', ok: true, detail: mainPath });

    let src: string;
    try {
      src = fs.readFileSync(mainPath, 'utf8');
    } catch (err: any) {
      checks.push({ id: 'main_js', ok: false, detail: t('doctor.mainUnreadable', err.message) });
      return { status: 'main_missing', checks, message: t('doctor.mainUnreadable', err.message) };
    }
    const hasR3 = src.includes(PATCH_V5.V5_MARKER);
    checks.push({ id: 'patch', ok: hasR3, detail: hasR3 ? t('doctor.patchOk') : t('doctor.patchMissing') });

    const watcherAlive = this.isWatcherAlive(mainPath, logOverridePath);
    checks.push({ id: 'watcher', ok: watcherAlive, detail: watcherAlive ? t('doctor.watcherAlive') : t('doctor.watcherDown') });

    const cmdPending = fs.existsSync(this.customCmdPath || PATHS.BYOK_SWITCH_FILE);
    checks.push({ id: 'command', ok: true, detail: cmdPending ? t('doctor.cmdPending') : t('doctor.cmdIdle') });

    if (!hasR3) {
      const rep = this.healPatch(mainPath);
      if (!rep.success) {
        checks.push({ id: 'repair', ok: false, detail: rep.message });
        return {
          status: rep.needsElevation ? 'needs_elevation' : 'repair_failed',
          checks,
          message: rep.message,
          elevationPlan: rep.elevationPlan
        };
      }
      checks.push({ id: 'repair', ok: true, detail: t('doctor.patchRepaired') });
      return { status: 'repaired_needs_full_restart', checks, message: t('doctor.repairedNeedsRestart') };
    }

    if (!watcherAlive) {
      return { status: 'needs_full_restart', checks, message: t('doctor.needsRestart') };
    }
    return { status: 'healthy', checks, message: t('doctor.healthy') };
  }
}
