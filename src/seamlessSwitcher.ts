import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V5 } from './constants';
import { CodeBuddyAccount, AccountStore } from './accountStore';

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

export interface SwitchResult {
  success: boolean;
  account: CodeBuddyAccount;
  patchResult: PatchApplyResult;
  junctionResult: JunctionResult;
  receipt?: SwitchReceipt;
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
        message: '未找到 CodeBuddy main.js 文件'
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

    const amCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.AM_ANCHOR), 'g')) || []).length;
    const gvCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GV_OLD), 'g')) || []).length;
    const gsCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GS_OLD), 'g')) || []).length;
    const restoreCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.ANCHOR_RESTORE), 'g')) || []).length;

    const anchorsValid = isPatched || (amCount === 1 && gvCount === 1 && gsCount === 1 && restoreCount === 1);

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
        ? `main.js 已成功打上 ${PATCH_V5.VERSION} 热切补丁 (含回执闭环)`
        : isLegacyV4
          ? '检测到旧版 v4 补丁 (无回执能力)，将自愈升级至 v5'
          : anchorsValid
            ? 'main.js 为原始状态，所有 Patch v5 锚点校验通过，可安全注入'
            : 'main.js 锚点特征串不唯一或已被第三方修改'
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
        message: '无法定位 CodeBuddy main.js',
        error: 'MAIN_JS_NOT_FOUND'
      };
    }

    const check = this.checkPatch(mainPath);

    // 若已经打好补丁且语法自检正常，直接放行
    if (check.isPatched) {
      const syntaxCheck = this.validateSyntax(mainPath);
      if (syntaxCheck.valid) {
        return {
          success: true,
          mainJsPath: mainPath,
          backupCreated: check.hasOriginBackup,
          message: 'main.js Patch v5 运行状态正常且语法校验通过'
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
    // (1) AM 构造函数注入全局会话
    if (!src.includes(PATCH_V5.AM_ANCHOR)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'AM 构造函数锚点缺失',
        error: 'AM_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V5.AM_ANCHOR, PATCH_V5.AM_REPLACEMENT);

    // (2) 放开 getV2ReconcileData 隔离
    if (!src.includes(PATCH_V5.GV_OLD)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'getV2ReconcileData 锚点缺失',
        error: 'GV_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V5.GV_OLD, PATCH_V5.GV_NEW);

    // (3) 放开 getSessions 隔离
    if (!src.includes(PATCH_V5.GS_OLD)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'getSessions 锚点缺失',
        error: 'GS_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V5.GS_OLD, PATCH_V5.GS_NEW);

    // (4) 注入 WATCHER_METHODS (getStorageKey 之后)
    const expectedMethodEnd = PATCH_V5.ANCHOR_METHOD_END + PATCH_V5.NEXT_METHOD;
    if (!src.includes(expectedMethodEnd)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: '方法插入点锚点缺失',
        error: 'WATCHER_ANCHOR_MISSING'
      };
    }
    src = src.replace(
      expectedMethodEnd,
      PATCH_V5.ANCHOR_METHOD_END + PATCH_V5.WATCHER_METHODS + PATCH_V5.NEXT_METHOD
    );

    // (5) 注入 restoreSession 启动 watcher
    if (!src.includes(PATCH_V5.ANCHOR_RESTORE)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'restoreSession 启动锚点缺失',
        error: 'RESTORE_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V5.ANCHOR_RESTORE, PATCH_V5.RESTORE_REPLACEMENT);

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
        message: `Patch v5 语法自检失败: ${checkRes.error || '语法错误'}，已中止写入以防损坏 IDE`,
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
        message: `写入 main.js 失败: ${err.message}`,
        error: err.message
      };
    }

    return {
      success: true,
      mainJsPath: mainPath,
      backupCreated,
      message: 'main.js Patch v5 注入与语法自愈成功完成'
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
        message: '当前账号为母号实体存储节点，无需创建 Junction'
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
        message: `NTFS Junction 已就绪: ${targetLink} -> ${masterPath}`
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
          message: `已有非 Junction 目录备份失败: ${err.message}`,
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
        message: `成功建立会话目录软链接: ${targetLink} -> ${masterPath}`
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
            message: `通过 mklink /J 建立会话穿透 Junction: ${targetLink} -> ${masterPath}`
          };
        } catch (cmdErr: any) {
          return {
            success: false,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: `建立 Junction 联结失败: ${cmdErr.message}`,
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
            message: `通过 ln -s 建立会话软链接: ${targetLink} -> ${masterPath}`
          };
        } catch (lnErr: any) {
          return {
            success: false,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: `建立符号链接失败: ${lnErr.message}`,
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
                  ? '宿主报告本就已在目标账号 (same-uid skip)'
                  : '宿主已确认完成切换'
              };
            }
            return {
              verified: true,
              ok: false,
              skipped: false,
              legacyHost: false,
              message: `宿主切换失败: ${data.err || '未知原因'}`
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
        message: '切换指令已被宿主消费，但当前宿主为 v4 旧补丁无回执能力；若界面账号未变更请重启 CodeBuddy 后重试'
      };
    }
    return {
      verified: false,
      ok: false,
      skipped: false,
      legacyHost: false,
      message: '宿主未消费切换指令 (watcher 未运行：main.js 未打补丁或 IDE 打补丁后未重启)'
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
        throw new Error('[SeamlessSwitcher] 提供 UID 时必须同时提供 AccountStore');
      }
      account = store.get(accountOrUid) || store.find(accountOrUid);
      if (!account) {
        throw new Error(`[SeamlessSwitcher] 未在号池中找到指定账号: ${accountOrUid}`);
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
          message: 'Patch v5 检查自愈失败，中止后续步骤'
        },
        message: `Patch v5 注入或语法自愈失败: ${patchResult.message}`,
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
        message: `写入热切指令失败: ${err.message}`,
        error: err.message
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
            ? `已切换至 ${account.nickname} (宿主回执确认${receipt.skipped ? '，本就在目标账号' : ''})`
            : `已切换至 ${account.nickname} (指令已消费，v4 宿主无回执，建议重启 IDE 以获得回执确认)`)
        : `热切未生效: ${receipt.message}`,
      error: receipt.ok ? undefined : 'HOST_RECEIPT_FAILED'
    };
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
