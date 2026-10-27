import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V4 } from './constants';
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

export interface SwitchResult {
  success: boolean;
  account: CodeBuddyAccount;
  patchResult: PatchApplyResult;
  junctionResult: JunctionResult;
  message: string;
  error?: string;
}

/**
 * BuddyRelay 热切中枢与底层通信引擎
 * 负责 main.js Patch v4 检查自愈、NTFS Junction 5.7GB 物理会话文件穿透映射与 byok-switch.json 动态指令注入
 */
export class SeamlessSwitcher {
  private customMainJsPath?: string;
  private customCmdPath?: string;

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
   * 检查 main.js 当前 Patch v4 状态
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
    const isPatched = content.includes(PATCH_V4.PATCH_FLAG);

    // 检查基础锚点
    const checkTargetContent = hasOriginBackup
      ? fs.readFileSync(originPath, 'utf8')
      : content;

    const amCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V4.AM_ANCHOR), 'g')) || []).length;
    const gvCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V4.GV_OLD), 'g')) || []).length;
    const gsCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V4.GS_OLD), 'g')) || []).length;
    const restoreCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V4.ANCHOR_RESTORE), 'g')) || []).length;

    const anchorsValid = isPatched || (amCount === 1 && gvCount === 1 && gsCount === 1 && restoreCount === 1);

    return {
      mainJsFound: true,
      mainJsPath: mainPath,
      isPatched,
      hasOriginBackup,
      version: isPatched ? PATCH_V4.VERSION : undefined,
      anchorsValid,
      details: {
        amCount,
        gvCount,
        gsCount,
        restoreCount
      },
      message: isPatched
        ? `main.js 已成功打上 ${PATCH_V4.VERSION} 热切补丁`
        : anchorsValid
          ? 'main.js 为原始状态，所有 Patch v4 锚点校验通过，可安全注入'
          : 'main.js 锚点特征串不唯一或已被第三方修改'
    };
  }

  /**
   * 检查并自愈 main.js Patch v4
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
      const syntaxValid = this.validateSyntax(mainPath);
      if (syntaxValid) {
        return {
          success: true,
          mainJsPath: mainPath,
          backupCreated: check.hasOriginBackup,
          message: 'main.js Patch v4 运行状态正常且语法校验通过'
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

    // 3. 逐级注入 Patch v4
    // (1) AM 构造函数注入全局会话
    if (!src.includes(PATCH_V4.AM_ANCHOR)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'AM 构造函数锚点缺失',
        error: 'AM_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V4.AM_ANCHOR, PATCH_V4.AM_REPLACEMENT);

    // (2) 放开 getV2ReconcileData 隔离
    if (!src.includes(PATCH_V4.GV_OLD)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'getV2ReconcileData 锚点缺失',
        error: 'GV_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V4.GV_OLD, PATCH_V4.GV_NEW);

    // (3) 放开 getSessions 隔离
    if (!src.includes(PATCH_V4.GS_OLD)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'getSessions 锚点缺失',
        error: 'GS_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V4.GS_OLD, PATCH_V4.GS_NEW);

    // (4) 注入 WATCHER_METHODS (getStorageKey 之后)
    const expectedMethodEnd = PATCH_V4.ANCHOR_METHOD_END + PATCH_V4.NEXT_METHOD;
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
      PATCH_V4.ANCHOR_METHOD_END + PATCH_V4.WATCHER_METHODS + PATCH_V4.NEXT_METHOD
    );

    // (5) 注入 restoreSession 启动 watcher
    if (!src.includes(PATCH_V4.ANCHOR_RESTORE)) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'restoreSession 启动锚点缺失',
        error: 'RESTORE_ANCHOR_MISSING'
      };
    }
    src = src.replace(PATCH_V4.ANCHOR_RESTORE, PATCH_V4.RESTORE_REPLACEMENT);

    // 4. 原子安全写入
    const tmpWritePath = `${mainPath}.tmp_${Date.now()}`;
    fs.writeFileSync(tmpWritePath, src, 'utf8');

    // 5. Node 语法自检
    const valid = this.validateSyntax(tmpWritePath);
    if (!valid) {
      if (fs.existsSync(tmpWritePath)) {
        fs.unlinkSync(tmpWritePath);
      }
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: 'Patch v4 语法自检失败，已中止写入以防损坏 IDE',
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
      message: 'main.js Patch v4 注入与语法自愈成功完成'
    };
  }

  /**
   * 使用 node --check 验证 JS 语法合法性
   */
  public validateSyntax(filePath: string): boolean {
    try {
      child_process.execSync(`node --check "${filePath}"`, {
        stdio: 'pipe',
        timeout: 5000
      });
      return true;
    } catch (err) {
      return false;
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
   */
  public async writeSwitchCommand(
    account: CodeBuddyAccount,
    customPath?: string
  ): Promise<string> {
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

    return targetFile;
  }

  /**
   * 完整热切执行：检查自愈 Patch v4 -> 建立 Junction -> 写入指令 -> 更新 Store
   */
  public async switchAccount(
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

    // 1. 检查并自愈 Patch v4
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
          message: 'Patch v4 检查自愈失败，中止后续步骤'
        },
        message: `Patch v4 注入或语法自愈失败: ${patchResult.message}`,
        error: patchResult.error
      };
    }

    // 2. 确保目标 UID 的 NTFS Junction 穿透
    const junctionResult = this.ensureJunction(account.uid);

    // 3. 写入 byok-switch.json 指令
    try {
      await this.writeSwitchCommand(account);
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

    // 4. 更新 Store 中活跃状态
    if (store) {
      await store.setActive(account.id);
    }

    return {
      success: true,
      account,
      patchResult,
      junctionResult,
      message: `已成功向 CodeBuddy CN 发出热切指令: ${account.nickname} (UID: ${account.uid})`
    };
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
