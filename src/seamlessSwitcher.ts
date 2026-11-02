import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V5 } from './constants';
import { CodeBuddyAccount, AccountStore } from './accountStore';
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

export interface PatchApplyResult {
  success: boolean;
  mainJsPath: string;
  backupCreated: boolean;
  /** 本次是否实际重打了 main.js（true 时运行中的 main 进程仍是旧代码，需完全重启一次） */
  repatched?: boolean;
  message: string;
  error?: string;
}

export interface JunctionResult {
  success: boolean;
  masterPath: string;
  targetPath: string;
  alreadyExisted: boolean;
  message: string;
  error?: string;
}

export interface SwitchReceipt {
  /** 宿主回执确认 (ok:true 即宿主已应用或本就在目标账号) */
  verified: boolean;
  /** 宿主报告切换成功 */
  ok: boolean;
  /** 宿主报告 same-uid skip (本就已在目标账号) */
  skipped: boolean;
  /** 宿主是否为 v4 旧补丁 (消费了指令但无回执能力) */
  legacyHost: boolean;
  message: string;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export type DoctorStatus =
  | 'healthy'
  | 'needs_full_restart'
  | 'repaired_needs_full_restart'
  | 'main_missing'
  | 'repair_failed';

export interface DoctorReport {
  status: DoctorStatus;
  checks: DoctorCheck[];
  message: string;
}

export interface SwitchResult {
  success: boolean;
  account: CodeBuddyAccount;
  patchResult: PatchApplyResult;
  junctionResult: JunctionResult;
  receipt?: SwitchReceipt;
  /** 补丁本次重打：指令已就位，完全重启 CodeBuddy 后 watcher 自动消费完成切换 */
  needsFullRestart?: boolean;
  message: string;
  error?: string;
}

/**
 * BuddyRelay 热切中枢与底层通信引擎
 * 负责 main.js Patch v5 检查自愈、NTFS Junction 5.7GB 物理会话文件穿透映射与 byok-switch.json 动态指令注入
 * v5 新增切换回执闭环：宿主每种结局写回执 byok-switch-result.json，扩展轮询校验后才宣布成功
 */
export class SeamlessSwitcher {
  private customMainJsPath?: string;
  private customCmdPath?: string;
  // 窗口内切号串行队列：消除自动切号与手动切号在 2s 轮询窗口内的指令覆盖竞态
  private _switchQueue: Promise<unknown> = Promise.resolve();

  constructor(options?: {
    mainJsPath?: string;
    cmdPath?: string;
  }) {
    this.customMainJsPath = options?.mainJsPath;
    this.customCmdPath = options?.cmdPath;
  }

  /**
   * 定位 CodeBuddy CN 主程序入口 main.js
   */
  public locateMainJs(): string | null {
    if (this.customMainJsPath && fs.existsSync(this.customMainJsPath)) {
      return this.customMainJsPath;
    }

    for (const candidate of PATHS.CANDIDATE_MAIN_JS_PATHS) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * 检查 main.js 当前 Patch v5 状态
   */
  public checkPatch(targetPath?: string): PatchCheckResult {
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) {
      return {
        mainJsFound: false,
        isPatched: false,
        hasOriginBackup: false,
        anchorsValid: false,
        message: t('sw.mainJsNotFound')
      };
    }

    const originPath = `${mainPath}.byok-origin`;
    const hasOriginBackup = fs.existsSync(originPath);

    const content = fs.readFileSync(mainPath, 'utf8');
    const hasFlag = content.includes(PATCH_V5.PATCH_FLAG);
    const isPatched = hasFlag && content.includes(PATCH_V5.V5_MARKER);
    const isLegacyV4 = hasFlag && !isPatched;

    // 检查基础锚点
    const checkTargetContent = hasOriginBackup
      ? fs.readFileSync(originPath, 'utf8')
      : content;

    const amCount = this.resolveSessionClassAnchor(checkTargetContent) ? 1 : 0;
    const gvCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GV_OLD), 'g')) || []).length;
    const gsCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GS_OLD), 'g')) || []).length;
    const restoreCount = (checkTargetContent.match(/async restoreSession\([^)]*\)\{/g) || []).length;

    // 必需锚点 = 会话服务类头 + restoreSession 语义签名；GV/GS 为可选步骤不参与硬校验
    const anchorsValid = isPatched || (amCount === 1 && restoreCount === 1);

    return {
      mainJsFound: true,
      mainJsPath: mainPath,
      isPatched,
      hasOriginBackup,
      version: isPatched ? PATCH_V5.VERSION : undefined,
      anchorsValid,
      details: {
        amCount,
        gvCount,
        gsCount,
        restoreCount,
        isLegacyV4
      },
      message: isPatched
        ? t('sw.patched', PATCH_V5.VERSION)
        : isLegacyV4
          ? t('sw.upgradeFromV4')
          : anchorsValid
            ? t('sw.originalOk')
            : t('sw.anchorTampered')
    };
  }

  /**
   * 检查并自愈 main.js Patch v5
   */
  public healPatch(targetPath?: string): PatchApplyResult {
    const mainPath = targetPath || this.locateMainJs();
    if (!mainPath || !fs.existsSync(mainPath)) {
      return {
        success: false,
        mainJsPath: mainPath || '',
        backupCreated: false,
        message: t('sw.cannotLocate'),
        error: 'MAIN_JS_NOT_FOUND'
      };
    }

    const check = this.checkPatch(mainPath);

    // 若已经打好补丁且语法自检正常，直接放行（运行中的 main 进程与磁盘一致，无需重启）
    if (check.isPatched) {
      const syntaxCheck = this.validateSyntax(mainPath);
      if (syntaxCheck.valid) {
        return {
          success: true,
          mainJsPath: mainPath,
          backupCreated: check.hasOriginBackup,
          repatched: false,
          message: t('sw.patchHealthy')
        };
      }
      // 语法损坏，触发自愈回滚重打
    }

    const originPath = `${mainPath}.byok-origin`;
    let backupCreated = false;

    // 1. 若无 origin 备份，创建 origin 备份
    if (!fs.existsSync(originPath)) {
      fs.copyFileSync(mainPath, originPath);
      backupCreated = true;
    }

    // 2. 从干净的 origin 读取源码
    let src = fs.readFileSync(originPath, 'utf8');

    // 3. 逐级注入 Patch v5
    const skipNotes: string[] = [];

    // (1) 会话服务类构造函数注入全局会话（类名随宿主构建漂移 AM->HM，以特征方法动态发现类头；失败=阻断）
    const sessionAnchor = this.resolveSessionClassAnchor(src);
    if (!sessionAnchor || src.split(sessionAnchor).length - 1 !== 1) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: t('sw.anchorAmMissing'),
        error: 'AM_ANCHOR_MISSING'
      };
    }
    src = src.replace(sessionAnchor, () => sessionAnchor + PATCH_V5.SESSION_HOOK);

    // (2)(3) 放开会话隔离（可选步骤：宿主改动实现体时跳过并显式标注，
    // 由 __byokApplySwitch 的会话迁移兜底——切换时全量改写会话 userId 为目标 uid）
    const optionalMissing: string[] = [];
    if (src.includes(PATCH_V5.GV_OLD)) {
      src = src.replace(PATCH_V5.GV_OLD, () => PATCH_V5.GV_NEW);
    } else {
      optionalMissing.push('getV2ReconcileData');
    }
    if (src.includes(PATCH_V5.GS_OLD)) {
      src = src.replace(PATCH_V5.GS_OLD, () => PATCH_V5.GS_NEW);
    } else {
      optionalMissing.push('getSessions');
    }
    if (optionalMissing.length > 0) {
      skipNotes.push(t('sw.optionalAnchorSkipped', optionalMissing.join(', ')));
    }

    // (4) 挂载 WATCHER_METHODS（restoreSession 定义前即类体内方法边界，插入合法；失败=阻断）
    const restoreMatches = src.match(/async restoreSession\([^)]*\)\{/g) || [];
    if (restoreMatches.length !== 1) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: t('sw.anchorRestoreMissing'),
        error: 'RESTORE_ANCHOR_MISSING'
      };
    }
    src = src.replace(restoreMatches[0], () => PATCH_V5.WATCHER_METHODS + restoreMatches[0]);

    // (5) 构造函数注入 watcher 启动（restoreSession 前置 await ensureInitialized 为网络初始化，
    // 挂起或拒绝时 watcher 永不启动——2026-11-02 事故实证；构造函数实例化必然执行，__byokStarted 防重入）
    // lookahead 锚定：匹配止于 "{"，注入落在构造函数体首句，不破坏首个字段赋值。
    // 校验与替换必须用同一正则对象——lookahead 语义只存在于正则匹配中，
    // 若以匹配文本做字面 replace，会撞上同签名但特征不符的其他类（真实宿主含多个 constructor(e,i,s,n)）
    const bootRe = /constructor\([^)]*\)\{(?=this\.instantiationService=)/g;
    const bootMatches = src.match(bootRe) || [];
    if (bootMatches.length !== 1) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: t('sw.anchorRestoreMissing'),
        error: 'WATCHER_BOOT_ANCHOR_MISSING'
      };
    }
    src = src.replace(bootRe, (m0) => m0 + 'this.startByokWatcher();');

    // 4. 原子安全写入：文件名必须以 .js 结尾，兼容现代 Node.js ESM/CJS loader 扩展名校验规范
    const tmpWritePath = `${mainPath}.tmp_${Date.now()}.js`;
    fs.writeFileSync(tmpWritePath, src, 'utf8');

    // 5. Node 语法自检
    const checkRes = this.validateSyntax(tmpWritePath);
    if (!checkRes.valid) {
      if (fs.existsSync(tmpWritePath)) {
        fs.unlinkSync(tmpWritePath);
      }
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: t('sw.syntaxCheckFailed', checkRes.error || 'syntax error'),
        error: 'SYNTAX_CHECK_FAILED'
      };
    }

    // 替换目标文件
    try {
      fs.copyFileSync(tmpWritePath, mainPath);
      fs.unlinkSync(tmpWritePath);
    } catch (err: any) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: t('sw.writeFailed', err.message),
        error: err.message
      };
    }

    return {
      success: true,
      mainJsPath: mainPath,
      backupCreated,
      repatched: true,
      message: skipNotes.length > 0
        ? `${t('sw.patchDone')} ${skipNotes.join(' ')}`
        : t('sw.patchDone')
    };
  }

  /**
   * 使用 node --check 验证 JS 语法合法性
   * 优先使用全局 node，无全局 node 时回退至 CodeBuddy 内置 Electron 运行环境
   */
  public validateSyntax(filePath: string): { valid: boolean; error?: string } {
    // 1. 尝试全局 node
    try {
      child_process.execSync(`node --check "${filePath}"`, {
        stdio: 'pipe',
        timeout: 5000
      });
      return { valid: true };
    } catch (nodeErr: any) {
      // 2. 若无系统全局 node 或未加入 PATH，回退使用宿主 process.execPath (设置 ELECTRON_RUN_AS_NODE)
      const isMissingNode = nodeErr.code === 'ENOENT' ||
        (nodeErr.message && (nodeErr.message.includes('not recognized') || nodeErr.message.includes('找不到')));
      if (isMissingNode && process.execPath) {
        try {
          child_process.execSync(`"${process.execPath}" --check "${filePath}"`, {
            stdio: 'pipe',
            timeout: 5000,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          });
          return { valid: true };
        } catch (electronErr: any) {
          const errMsg = electronErr.stderr ? electronErr.stderr.toString().trim() : electronErr.message;
          return { valid: false, error: errMsg };
        }
      }
      const errMsg = nodeErr.stderr ? nodeErr.stderr.toString().trim() : nodeErr.message;
      return { valid: false, error: errMsg };
    }
  }

  /**
   * 自动创建并维系 NTFS Junction 映射
   * 穿透 Data\<uid>\CodeBuddyIDE\<uid> -> Data\<masterUid>\CodeBuddyIDE\<masterUid>
   * 确保切号后 5.7GB 历史会话物理文件完全共享穿透
   */
  public ensureJunction(
    targetUid: string,
    masterUid: string = PATHS.MASTER_SESSION_UID
  ): JunctionResult {
    const baseDir = PATHS.EXTENSION_DATA_DIR;
    const masterPath = path.join(baseDir, masterUid, 'CodeBuddyIDE', masterUid);
    const targetParent = path.join(baseDir, targetUid, 'CodeBuddyIDE');
    const targetLink = path.join(targetParent, targetUid);

    // 如果目标账号就是母账号本身，无需联结
    if (targetLink.toLowerCase() === masterPath.toLowerCase()) {
      return {
        success: true,
        masterPath,
        targetPath: targetLink,
        alreadyExisted: true,
        message: t('sw.junctionMaster')
      };
    }

    // 确保母体物理会话目录存在
    if (!fs.existsSync(masterPath)) {
      fs.mkdirSync(masterPath, { recursive: true });
    }

    // 确保目标父目录存在
    if (!fs.existsSync(targetParent)) {
      fs.mkdirSync(targetParent, { recursive: true });
    }

    // 检查 targetLink 是否已经是 Junction / 软链接
    let isJunction = false;
    try {
      const stat = fs.lstatSync(targetLink);
      isJunction = stat.isSymbolicLink();
    } catch (_) {
      // 路径尚不存在
    }

    if (isJunction) {
      return {
        success: true,
        masterPath,
        targetPath: targetLink,
        alreadyExisted: true,
        message: t('sw.junctionReady', targetLink, masterPath)
      };
    }

    // 若存在普通物理文件夹且非软链，先安全重命名备份
    if (fs.existsSync(targetLink)) {
      try {
        const backupTarget = `${targetLink}.bak_${Date.now()}`;
        fs.renameSync(targetLink, backupTarget);
      } catch (err: any) {
        return {
          success: false,
          masterPath,
          targetPath: targetLink,
          alreadyExisted: false,
          message: t('sw.backupFailed', err.message),
          error: err.message
        };
      }
    }

    // 创建目录链接 (Windows 走 NTFS Junction 免管理员权限; macOS/Linux 走标准 POSIX dir 软链接)
    const isWin = process.platform === 'win32';
    const symlinkType = isWin ? 'junction' : 'dir';

    try {
      fs.symlinkSync(masterPath, targetLink, symlinkType);
      return {
        success: true,
        masterPath,
        targetPath: targetLink,
        alreadyExisted: false,
        message: t('sw.symlinkCreated', targetLink, masterPath)
      };
    } catch (err: any) {
      if (isWin) {
        // Windows 降级尝试 cmd /c mklink /J
        try {
          child_process.execSync(`cmd /c mklink /J "${targetLink}" "${masterPath}"`, {
            stdio: 'pipe'
          });
          return {
            success: true,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: t('sw.junctionViaMklink', targetLink, masterPath)
          };
        } catch (cmdErr: any) {
          return {
            success: false,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: t('sw.junctionFailed', cmdErr.message),
            error: cmdErr.message
          };
        }
      } else {
        // macOS / Linux 降级尝试 ln -s
        try {
          child_process.execSync(`ln -s "${masterPath}" "${targetLink}"`, {
            stdio: 'pipe'
          });
          return {
            success: true,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: t('sw.symlinkViaLn', targetLink, masterPath)
          };
        } catch (lnErr: any) {
          return {
            success: false,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: t('sw.symlinkFailed', lnErr.message),
            error: lnErr.message
          };
        }
      }
    }
  }

  /**
   * 写入 byok-switch.json 动态指令，唤醒 CodeBuddy CN 宿主执行无缝热切
   * 返回写入文件与本次指令 ts（回执匹配凭据）
   */
  public async writeSwitchCommand(
    account: CodeBuddyAccount,
    customPath?: string
  ): Promise<{ file: string; ts: number }> {
    const targetFile = customPath || this.customCmdPath || PATHS.BYOK_SWITCH_FILE;
    const targetDir = path.dirname(targetFile);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const nowMs = Date.now();
    const uid = account.uid;
    const label = account.nickname || account.email || uid;
    const tok = account.accessToken;
    const refresh = account.refreshToken || (account.authRaw as any)?.refreshToken || '';
    const domain = account.domain || (account.authRaw as any)?.domain || 'www.codebuddy.cn';
    const expiresAt = account.expiresAt || (nowMs + 7200 * 1000);

    const accountObj = {
      id: uid,
      uid: uid,
      label: label,
      nickname: label,
      pluginEnabled: true,
      lastLogin: true
    };

    const sessionObj = {
      id: 'Tencent-Cloud.genie-ide',
      token: tok,
      refreshToken: refresh,
      expiresAt: expiresAt,
      domain: domain,
      accessToken: `${uid}+${tok}`,
      converted: true,
      account: accountObj,
      auth: {
        accessToken: tok,
        refreshToken: refresh,
        tokenType: account.tokenType || 'Bearer',
        domain: domain,
        expiresAt: expiresAt,
        expiresIn: (account.authRaw as any)?.expiresIn || 7200,
        refreshExpiresIn: (account.authRaw as any)?.refreshExpiresIn || 0,
        refreshExpiresAt: 0,
        lastRefreshTime: nowMs
      },
      accounts: [accountObj]
    };

    const commandPayload = {
      session: sessionObj,
      ts: nowMs,
      from: 'buddy-relay-hub'
    };

    // 原子写入：先写临时文件后重命名
    const tmpFile = `${targetFile}.tmp_${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(commandPayload, null, 2), 'utf8');
    fs.renameSync(tmpFile, targetFile);

    return { file: targetFile, ts: nowMs };
  }

  /**
   * 等待宿主切换回执 (v5 补丁闭环核心)
   * - 收到 ts 匹配的回执：按宿主真实结局返回 (成功 / skip / store失败)
   * - 指令文件被消费但无回执：宿主为 v4 旧补丁（无回执能力），如实标注 legacyHost
   * - 指令文件原样未动：宿主 watcher 未消费（未打补丁 / IDE 未重启），判失败
   * 严禁读到旧回执：ts 不匹配的回执文件清除后继续等待
   */
  private async waitForSwitchReceipt(cmdTs: number, timeoutMs: number = 8000): Promise<SwitchReceipt> {
    const cmdFile = PATHS.BYOK_SWITCH_FILE;
    const receiptFile = PATHS.BYOK_SWITCH_RESULT_FILE;
    const start = Date.now();
    let consumed = false;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 400));

      // 1. 检查指令文件是否已被宿主消费 (watcher unlink 即消费)
      if (!consumed && !fs.existsSync(cmdFile)) {
        consumed = true;
      }

      // 2. 检查回执
      try {
        if (fs.existsSync(receiptFile)) {
          let data: any = null;
          try {
            data = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
          } catch {
            // 回执写入中（原子写窗口期），下轮再读
            continue;
          }
          if (data && Number(data.ts) === Number(cmdTs)) {
            try { fs.unlinkSync(receiptFile); } catch { /* ignore */ }
            if (data.ok) {
              return {
                verified: true,
                ok: true,
                skipped: Boolean(data.skipped),
                legacyHost: false,
                message: data.skipped
                  ? t('sw.receiptSkipped')
                  : t('sw.receiptDone')
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
          // 旧回执（ts 不匹配）：清除防止后续误读
          try { fs.unlinkSync(receiptFile); } catch { /* ignore */ }
        }
      } catch { /* 读取失败继续轮询 */ }
    }

    if (consumed) {
      return {
        verified: false,
        ok: true,
        skipped: false,
        legacyHost: true,
        message: t('sw.legacyNoReceipt')
      };
    }
    return {
      verified: false,
      ok: false,
      skipped: false,
      legacyHost: false,
      message: t('sw.noReceipt')
    };
  }

  /**
   * 完整热切执行：检查自愈 Patch v5 -> 建立 Junction -> 写入指令 -> 回执校验 -> 更新 Store
   * 窗口内串行化执行，严禁并发指令互相覆盖
   */
  public switchAccount(
    accountOrUid: CodeBuddyAccount | string,
    store?: AccountStore
  ): Promise<SwitchResult> {
    const run = () => this.doSwitchAccount(accountOrUid, store);
    const next = this._switchQueue.then(run, run);
    // 队列只跟踪完成状态，错误经返回的 Promise 透传给调用方
    this._switchQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async doSwitchAccount(
    accountOrUid: CodeBuddyAccount | string,
    store?: AccountStore
  ): Promise<SwitchResult> {
    let account: CodeBuddyAccount | undefined;
    if (typeof accountOrUid === 'string') {
      if (!store) {
        throw new Error(t('err.uidNeedsStore'));
      }
      account = store.get(accountOrUid) || store.find(accountOrUid);
      if (!account) {
        throw new Error(t('err.notInPool', accountOrUid));
      }
    } else {
      account = accountOrUid;
    }

    // 1. 检查并自愈 Patch v5
    const patchResult = this.healPatch();
    if (!patchResult.success) {
      return {
        success: false,
        account,
        patchResult,
        junctionResult: {
          success: false,
          masterPath: '',
          targetPath: '',
          alreadyExisted: false,
          message: t('sw.patchHealFailed')
        },
        message: t('sw.patchInjectFailed', patchResult.message),
        error: patchResult.error
      };
    }

    // 2. 确保目标 UID 的 NTFS Junction 穿透
    const junctionResult = this.ensureJunction(account.uid);

    // 3. 写入 byok-switch.json 指令
    let cmdTs: number;
    try {
      const written = await this.writeSwitchCommand(account);
      cmdTs = written.ts;
    } catch (err: any) {
      return {
        success: false,
        account,
        patchResult,
        junctionResult,
        message: t('sw.cmdWriteFailed', err.message),
        error: err.message
      };
    }

    // 3.5 补丁本次重打：运行中的 main 进程仍是旧代码，等待回执必然超时。
    // 指令已写入磁盘，完全重启 CodeBuddy 后 watcher 自动消费完成切换；
    // needsFullRestart 标记供 UI 层弹引导模态框（确认/取消 + 帮用户直接退出）
    if (patchResult.repatched) {
      return {
        success: false,
        account,
        patchResult,
        junctionResult,
        needsFullRestart: true,
        message: t('sw.repatchPending', account.nickname || account.email || account.uid),
        error: 'NEEDS_FULL_RESTART'
      };
    }

    // 4. 等待宿主回执（v5 闭环；v4 宿主降级为消费确认）
    const receipt = await this.waitForSwitchReceipt(cmdTs);

    // 5. 按回执真实结局更新 Store 与返回
    if (receipt.ok && store) {
      // ok=true 含 skipped（宿主本就在目标账号，Store 状态对齐即可）
      await store.setActive(account.id);
    }

    return {
      success: receipt.ok,
      account,
      patchResult,
      junctionResult,
      receipt,
      message: receipt.ok
        ? (receipt.verified
            ? t('sw.switchedReceipt', account.nickname, receipt.skipped ? t('sw.receiptSkipSuffix') : '')
            : t('sw.switchedLegacy', account.nickname))
        : t('sw.notEffective', receipt.message),
      error: receipt.ok ? undefined : 'HOST_RECEIPT_FAILED'
    };
  }

  /**
   * 动态发现会话服务类构造函数锚点
   * 宿主每次构建混淆类名漂移（AM -> HM），硬编码类名必失效。
   * 会话服务类必含 getV2ReconcileData 特征方法（GV_OLD），取其前方最近的
   * "X=class{constructor(...)}{" 定义头即为该类锚点。
   * 返回 null 表示锚点缺失（宿主结构大改，显式失败，不做静默兜底）。
   */
  private resolveSessionClassAnchor(src: string): string | null {
    // 特征定位: GV_OLD 完整方法体优先; 宿主改动实现体时退化为语义方法签名（非混淆命名, 参数漂移免疫）
    let idx = src.indexOf(PATCH_V5.GV_OLD);
    if (idx < 0) {
      const sigMatches = src.match(/getV2ReconcileData\([^)]*\)\{/g) || [];
      if (sigMatches.length !== 1) {
        return null;
      }
      idx = src.indexOf(sigMatches[0]);
    }
    // 窗口须覆盖类头到特征方法的整个方法区（实测宿主 2026-10-30 版约 8.5K 字符），
    // 取窗口内最后一个类头即为所属类，窗口过大无副作用
    const window = src.slice(Math.max(0, idx - 20000), idx);
    const classDefRe = /[A-Za-z_$][\w$]*=class\{constructor\([^)]*\)\{/g;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = classDefRe.exec(window)) !== null) {
      last = m;
    }
    return last ? last[0] : null;
  }

  /**
   * 切号链路自检：main.js 定位 → 磁盘补丁 → watcher 运行痕迹 → 指令状态
   * watcher 活性判定：诊断日志 mtime 必须不早于 main.js mtime——
   * 日志不存在或比补丁旧，说明运行中的 main 进程没有加载当前补丁（需完全重启一次）
   */
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

    let watcherAlive = false;
    let logMtime = 0;
    const logPath = logOverridePath || path.join(PATHS.CODEBUDDY_APPDATA_DIR, 'byok-watcher.log');
    try {
      logMtime = fs.statSync(logPath).mtimeMs;
      const mainMtime = fs.statSync(mainPath).mtimeMs;
      // 1s 容差：吸收打补丁与重启之间秒级时钟/写入顺序抖动
      watcherAlive = logMtime >= mainMtime - 1000;
    } catch (_) {
      watcherAlive = false;
    }
    checks.push({
      id: 'watcher',
      ok: watcherAlive,
      detail: watcherAlive ? t('doctor.watcherAlive') : t('doctor.watcherDown')
    });

    const cmdPending = fs.existsSync(PATHS.BYOK_SWITCH_FILE);
    checks.push({
      id: 'command',
      ok: true,
      detail: cmdPending ? t('doctor.cmdPending') : t('doctor.cmdIdle')
    });

    if (!hasR3) {
      // 自动修复：重打补丁，随后同样需要完全重启加载
      const rep = this.healPatch(mainPath);
      if (!rep.success) {
        checks.push({ id: 'repair', ok: false, detail: rep.message });
        return { status: 'repair_failed', checks, message: rep.message };
      }
      checks.push({ id: 'repair', ok: true, detail: t('doctor.patchRepaired') });
      return { status: 'repaired_needs_full_restart', checks, message: t('doctor.repairedNeedsRestart') };
    }

    if (!watcherAlive) {
      return { status: 'needs_full_restart', checks, message: t('doctor.needsRestart') };
    }
    return { status: 'healthy', checks, message: t('doctor.healthy') };
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
