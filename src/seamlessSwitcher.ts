import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { PATHS, PATCH_V5 } from './constants';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { SessionHealer, normalizeLinkTarget } from './sessionHealer';
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
  /** 技术细节（语法校验原始输出、尝试过的运行时等）；仅供复制/上报，不直接展示给用户 */
  detail?: string;
}

/** 语法校验结论：syntax=补丁本身有问题，no_runtime=本机没有可用校验运行时，timeout=校验超时 */
export interface SyntaxCheckResult {
  valid: boolean;
  error?: string;
  reason?: 'syntax' | 'no_runtime' | 'timeout';
}

/**
 * 子进程输出解码：优先 UTF-8；出现替换字符说明是中文 Windows 的 GBK 输出，回退 GBK 重解。
 * 否则中文系统下的报错会整段变成乱码（历史事故：'node' 后面跟着一串问号）。
 */
/**
 * 权限类失败：IDE 装在 Program Files、只读介质、安全软件占着文件都归这里。
 * 这类错误对用户有明确解法（以管理员身份运行），必须单独翻译，不能直接甩 errno。
 */
function isPermissionError(err: any): boolean {
  const code = String(err?.code || '');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') {
    return true;
  }
  const msg = String(err?.message || '');
  return /operation not permitted|permission denied|拒绝访问|另一个程序正在使用/i.test(msg);
}

function decodeOutput(buf?: Buffer): string {
  if (!buf || buf.length === 0) {
    return '';
  }
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return utf8.trim();
  }
  try {
    return new TextDecoder('gbk').decode(buf).trim();
  } catch {
    return utf8.trim();
  }
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
  /** 指令文件原样未动：watcher 未消费（运行中的宿主尚未加载当前补丁） */
  notConsumed?: boolean;
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
  /** 技术细节（供复制/上报，不直接展示） */
  detail?: string;
}

/**
 * BuddyRelay 热切中枢与底层通信引擎
 * 负责 main.js Patch v5 检查自愈、NTFS Junction 5.7GB 物理会话文件穿透映射与 byok-switch.json 动态指令注入
 * v5 新增切换回执闭环：宿主每种结局写回执 byok-switch-result.json，扩展轮询校验后才宣布成功
 */
/** 语法校验运行时：宿主自带 Electron 或系统 node */
interface SyntaxRunner {
  label: string;
  exe: string;
  env: NodeJS.ProcessEnv;
}

export class SeamlessSwitcher {
  private customMainJsPath?: string;
  private appRootPath?: string;
  private customCmdPath?: string;
  private readonly healer: SessionHealer;
  // 上次校验成功的运行时：避免每次切号都先白跑一次失败分支（Electron 冷启动可达 1~2 秒）
  private static _preferredRunner = '';
  // 窗口内切号串行队列：消除自动切号与手动切号在 2s 轮询窗口内的指令覆盖竞态
  private _switchQueue: Promise<unknown> = Promise.resolve();

  constructor(options?: {
    mainJsPath?: string;
    cmdPath?: string;
    healer?: SessionHealer;
    appRoot?: string;
  }) {
    this.customMainJsPath = options?.mainJsPath;
    this.customCmdPath = options?.cmdPath;
    this.appRootPath = options?.appRoot;
    this.healer = options?.healer || new SessionHealer();
  }

  /**
   * 定位 CodeBuddy CN 主程序入口 main.js
   */
  public locateMainJs(): string | null {
    if (this.customMainJsPath && fs.existsSync(this.customMainJsPath)) {
      return this.customMainJsPath;
    }

    // 当前运行宿主的安装根目录优先：机器上装了多份或装在自定义目录时，
    // 固定候选列表可能指向没在运行的那份，补丁写对了文件却对本进程无效。
    if (this.appRootPath) {
      const runningMain = path.join(this.appRootPath, 'out', 'main.js');
      if (fs.existsSync(runningMain)) {
        return runningMain;
      }
    }

    for (const candidate of PATHS.CANDIDATE_MAIN_JS_PATHS) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** main.js 是否已被注入过任意版本结构（v4 / v5 各修订） */
  private hasInjectedPatch(content: string): boolean {
    return content.includes(PATCH_V5.PATCH_FLAG);
  }

  /**
   * 从已注入过历史结构的主程序文件中还原干净源码。
   * 历史结构有两类挂载位置，右边界都紧跟宿主语义方法签名，
   * 因此还原不依赖混淆类名，也不依赖各修订注入体的具体内容。
   * 还原结果必须不含任何注入特征且必需锚点完整，否则返回 null。
   */
  private stripInjectedPatch(content: string): string | null {
    const markerIdx = content.search(/\/\*__BYOK_V5[\s\S]*?\*\//);
    const logIdx = content.indexOf('__byokLog(m){');
    const starts = [markerIdx, logIdx].filter(i => i >= 0);
    if (starts.length === 0) {
      return null;
    }
    const start = Math.min(...starts);
    const tail = content.slice(start).match(/async restoreSession\(|scheduleRefresh\(e=0\)\{/);
    if (!tail || tail.index === undefined || tail.index <= 0) {
      return null;
    }

    let restored = content.slice(0, start) + content.slice(start + tail.index);
    restored = restored
      .split('globalThis.__cbSession=this;').join('')
      .split('this.startByokWatcher();').join('');

    if (this.hasInjectedPatch(restored) || !this.resolveSessionClassAnchor(restored)) {
      return null;
    }
    if ((restored.match(/async restoreSession\([^)]*\)\{/g) || []).length !== 1) {
      return null;
    }
    if ((restored.match(/constructor\([^)]*\)\{(?=this\.instantiationService=)/g) || []).length !== 1) {
      return null;
    }
    return restored;
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

    let content: string;
    try {
      content = fs.readFileSync(mainPath, 'utf8');
    } catch (err: any) {
      return {
        mainJsFound: true,
        mainJsPath: mainPath,
        isPatched: false,
        hasOriginBackup,
        anchorsValid: false,
        message: t('doctor.mainUnreadable', err.message)
      };
    }
    const hasFlag = this.hasInjectedPatch(content);
    const isPatched = hasFlag && content.includes(PATCH_V5.V5_MARKER);
    const isLegacyV4 = hasFlag && !isPatched;

    // 锚点体检必须针对本次真正会拿来重打的源码：干净的当前 main.js 就是基准，
    // 只有已被注入过的文件才回退到 origin。origin 不可读或本身带补丁时如实标记，
    // 绝不把"读不到"当成锚点齐全。
    let checkTargetContent = content;
    let originUnusable = false;
    let originReadError = '';
    if (hasFlag && !isPatched) {
      try {
        const originSrc = fs.readFileSync(originPath, 'utf8');
        if (this.hasInjectedPatch(originSrc)) {
          originUnusable = true;
          originReadError = 'origin contains injected patch';
        } else {
          checkTargetContent = originSrc;
        }
      } catch (err: any) {
        originUnusable = true;
        originReadError = err.message;
      }
    }

    const amCount = this.resolveSessionClassAnchor(checkTargetContent) ? 1 : 0;
    const gvCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GV_OLD), 'g')) || []).length;
    const gsCount = (checkTargetContent.match(new RegExp(this.escapeRegExp(PATCH_V5.GS_OLD), 'g')) || []).length;
    const restoreCount = (checkTargetContent.match(/async restoreSession\([^)]*\)\{/g) || []).length;

    // 必需锚点 = 会话服务类头 + restoreSession 语义签名；GV/GS 为可选步骤不参与硬校验
    const anchorsValid = isPatched || (!originUnusable && amCount === 1 && restoreCount === 1);

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
        isLegacyV4,
        originUnusable,
        originReadError
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
      // 校验运行时缺失时无法校验，但补丁特征完整且本次不写盘，直接放行。
      // 旧实现会把它当成"语法损坏"，导致没装 Node.js 的用户每次切号都被重打补丁并要求重启。
      if (syntaxCheck.valid || syntaxCheck.reason === 'no_runtime') {
        return {
          success: true,
          mainJsPath: mainPath,
          backupCreated: check.hasOriginBackup,
          repatched: false,
          // 校验跑不起来时如实说明，不谎报"语法校验通过"
          message: syntaxCheck.valid ? t('sw.patchHealthy') : t('sw.patchHealthyNoCheck'),
          detail: syntaxCheck.valid ? undefined : syntaxCheck.error
        };
      }
      // 语法损坏或校验超时，触发自愈回滚重打
    }

    const originPath = `${mainPath}.byok-origin`;
    let backupCreated = false;
    let src: string;
    let originReadError = '';

    // 1-2. 逐级取得当前宿主构建的干净源码，所有路径都尝试完成后才允许中止：
    //  a) 当前 main.js 未注入过结构：直接采用并刷新备份（全新安装 / 宿主升级覆盖 / 手动还原）；
    //  b) 备份干净：以备份为准（历史结构升级的标准路径）；
    //  c) 备份缺失或同样带结构：从当前 main.js 还原历史注入内容，校验通过后重建备份。
    // 装在 Program Files 的用户没有写权限时会直接 EACCES，需翻译成可照做的提示。
    const originExisted = fs.existsSync(originPath);
    try {
      const content = fs.readFileSync(mainPath, 'utf8');
      let cleanBackup: string | null = null;
      if (originExisted) {
        try {
          const candidate = fs.readFileSync(originPath, 'utf8');
          if (!this.hasInjectedPatch(candidate)) {
            cleanBackup = candidate;
          }
        } catch (err: any) {
          originReadError = err.message;
        }
      }

      if (!this.hasInjectedPatch(content)) {
        fs.copyFileSync(mainPath, originPath);
        backupCreated = !originExisted;
        src = content;
      } else if (cleanBackup !== null) {
        src = cleanBackup;
      } else {
        const restored = this.stripInjectedPatch(content);
        if (restored === null) {
          throw new Error('SOURCE_RESTORE_FAILED');
        }
        fs.writeFileSync(originPath, restored, 'utf8');
        backupCreated = !originExisted;
        src = restored;
      }
    } catch (err: any) {
      if (err.message === 'SOURCE_RESTORE_FAILED') {
        return {
          success: false,
          mainJsPath: mainPath,
          backupCreated: false,
          message: t('sw.sourceRestoreFailed'),
          detail: originReadError || undefined,
          error: 'SOURCE_RESTORE_FAILED'
        };
      }
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: isPermissionError(err) ? t('sw.writePermissionDenied') : t('sw.backupFailed', err.message),
        detail: err.message,
        error: err.code || 'ORIGIN_BACKUP_FAILED'
      };
    }

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
    try {
      fs.writeFileSync(tmpWritePath, src, 'utf8');
    } catch (err: any) {
      return {
        success: false,
        mainJsPath: mainPath,
        backupCreated,
        message: isPermissionError(err) ? t('sw.writePermissionDenied') : t('sw.writeFailed', err.message),
        detail: err.message,
        error: err.code || 'TMP_WRITE_FAILED'
      };
    }

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
        message: checkRes.reason === 'no_runtime'
          ? t('sw.checkNoRuntime')
          : checkRes.reason === 'timeout'
            ? t('sw.checkTimeout')
            : t('sw.syntaxCheckFailed'),
        detail: checkRes.error,
        error: checkRes.reason === 'no_runtime' ? 'CHECK_RUNTIME_MISSING' : 'SYNTAX_CHECK_FAILED'
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
        message: isPermissionError(err) ? t('sw.writePermissionDenied') : t('sw.writeFailed', err.message),
        detail: err.message,
        error: err.code || 'MAIN_WRITE_FAILED'
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
   * 首选宿主自带 Electron（ELECTRON_RUN_AS_NODE）：它永远存在，且与 main.js 同源，
   * 不再依赖用户本机是否装了 Node.js。只有宿主运行时不可用时才回退系统 node。
   *
   * 历史事故：旧实现先跑系统 node，用中英文案匹配判断"没装 node"，在中文 Windows 上
   * 该判断恒不成立（execSync 的 code 不是 ENOENT，中文原文也没有"找不到"三字），
   * 于是把 GBK 乱码当成补丁语法错误，报"已中止写入以防损坏 IDE"。
   */
  public validateSyntax(filePath: string): SyntaxCheckResult {
    const runners: SyntaxRunner[] = [];
    if (process.execPath) {
      runners.push({
        label: '宿主运行时',
        exe: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    }
    runners.push({ label: '系统 node', exe: 'node', env: process.env });

    // 上次成功的运行时提到最前，常见路径一次就中，不再每次白等一次失败
    const preferred = SeamlessSwitcher._preferredRunner;
    if (preferred) {
      const idx = runners.findIndex(r => r.label === preferred);
      if (idx > 0) {
        runners.unshift(runners.splice(idx, 1)[0]);
      }
    }

    const unavailable: string[] = [];
    for (const runner of runners) {
      try {
        child_process.execFileSync(runner.exe, ['--check', filePath], {
          stdio: 'pipe',
          timeout: 20000,
          env: runner.env
        });
        SeamlessSwitcher._preferredRunner = runner.label;
        return { valid: true };
      } catch (err: any) {
        // 运行时本身没跑起来：换下一个，绝不当作语法错误
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          unavailable.push(`${runner.label}: ${err.code}`);
          continue;
        }
        if (err.signal === 'SIGTERM') {
          return {
            valid: false,
            reason: 'timeout',
            error: `${runner.label} --check 超时（20s）`
          };
        }
        const output = decodeOutput(err.stderr) || decodeOutput(err.stdout) || String(err.message || '').trim();
        // node --check 报语法错误时必然带 SyntaxError；没有它说明是这个运行时自己出了问题
        // （包装脚本不认 --check、被安全软件拦下等），此时换下一个运行时，别冤枉补丁
        if (/SyntaxError|MODULE_NOT_FOUND/.test(output)) {
          return { valid: false, reason: 'syntax', error: output };
        }
        unavailable.push(`${runner.label}: ${output.split('\n')[0] || '未知输出'}`);
      }
    }

    return {
      valid: false,
      reason: 'no_runtime',
      error: unavailable.join('; ') || '无可用的 JavaScript 运行时'
    };
  }

  /**
   * 自动创建并维系 NTFS Junction 映射
   * 穿透 Data\<uid>\CodeBuddyIDE\<uid> -> Data\<masterUid>\CodeBuddyIDE\<masterUid>
   * 确保切号后历史会话物理文件完全共享穿透
   *
   * 2026-11-03 事故修复：母体不再硬编码成作者本人 uid。
   * 母体必须由 SessionHealer 解析出「真实存在且非空」的目录；
   * 解析不到一律中止切号——绝不新建空母体，也绝不把用户真实目录换走。
   */
  public ensureJunction(targetUid: string, masterUid?: string): JunctionResult {
    const baseDir = PATHS.EXTENSION_DATA_DIR;
    const targetParent = path.join(baseDir, targetUid, 'CodeBuddyIDE');
    const targetLink = path.join(targetParent, targetUid);

    // 解析母体：显式指定则校验，否则走自愈中枢的登记/发现逻辑。
    // 找不到母体时先自动自愈一次（合并 .bak_ 备份并登记母体），用户全程无感；
    // 自愈后仍无数据（全新机器/账号）则按"无历史可共享"直接放行切号，绝不阻塞用户。
    let masterPath: string;
    if (masterUid) {
      masterPath = path.join(baseDir, masterUid, 'CodeBuddyIDE', masterUid);
    } else {
      let master = this.healer.resolveMasterForSwitch();
      if (!master) {
        try {
          this.healer.heal();
        } catch (err: any) {
          this.healer.log(`switch-time heal failed: ${err.message}`);
        }
        master = this.healer.resolveMasterForSwitch();
      }
      if (!master) {
        // 本机确实没有任何会话数据：跳过建链，直接切号（宿主自然建新目录，无数据可丢）
        return {
          success: true,
          masterPath: '',
          targetPath: targetLink,
          alreadyExisted: false,
          message: t('sw.junctionSkippedNoData')
        };
      }
      masterPath = master.masterPath;
    }

    // 母体必须是真实目录且内有内容，否则拒绝建链
    let masterUsable = false;
    try {
      const stat = fs.lstatSync(masterPath);
      masterUsable = stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(masterPath).length > 0;
    } catch {
      masterUsable = false;
    }
    if (!masterUsable) {
      return {
        success: false,
        masterPath,
        targetPath: targetLink,
        alreadyExisted: false,
        message: t('sw.masterSessionUnavailable'),
        error: 'MASTER_SESSION_DIR_MISSING'
      };
    }

    // 如果目标账号就是母账号本身，无需联结
    if (path.resolve(targetLink).toLowerCase() === path.resolve(masterPath).toLowerCase()) {
      return {
        success: true,
        masterPath,
        targetPath: targetLink,
        alreadyExisted: true,
        message: t('sw.junctionMaster')
      };
    }

    // 确保目标父目录存在（只建父级，绝不预建 inner 空目录）
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
      let currentTarget = '';
      try {
        currentTarget = fs.readlinkSync(targetLink);
      } catch {
        currentTarget = '';
      }
      const pointingHere =
        currentTarget &&
        normalizeLinkTarget(path.resolve(currentTarget)) === normalizeLinkTarget(path.resolve(masterPath));
      if (pointingHere) {
        return {
          success: true,
          masterPath,
          targetPath: targetLink,
          alreadyExisted: true,
          message: t('sw.junctionReady', targetLink, masterPath)
        };
      }
      // 指向别处（多为旧版硬编码母体留下的错误链接）：摘掉重建，不动任何真实数据
      try {
        try {
          fs.unlinkSync(targetLink);
        } catch {
          fs.rmdirSync(targetLink);
        }
        this.healer.log(`drop stale link ${targetLink} (was -> ${currentTarget})`);
      } catch (err: any) {
        return {
          success: false,
          masterPath,
          targetPath: targetLink,
          alreadyExisted: true,
          message: t('sw.symlinkFailed', err.message),
          error: err.message
        };
      }
    } else if (fs.existsSync(targetLink)) {
      // 普通物理目录：先把内容合并进母体，再改名留底，最后才建链
      const entries = fs.readdirSync(targetLink);
      if (entries.length > 0) {
        try {
          this.healer.adoptIntoMaster(targetLink, masterPath);
        } catch (err: any) {
          return {
            success: false,
            masterPath,
            targetPath: targetLink,
            alreadyExisted: false,
            message: t('sw.mergeFailed', err.message),
            error: 'ADOPT_FAILED'
          };
        }
        try {
          this.healer.backupDir(targetLink);
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
      } else {
        try {
          fs.rmdirSync(targetLink);
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
   * 等待宿主切换回执
   * - 收到 ts 匹配且账号一致的回执：按宿主真实结局返回（完成 / 本就在目标账号 / 存储失败）
   * - 指令文件被消费但无回执：标记为需重启加载当前结构，由调用方继续完成切换
   * - 指令文件原样未动：宿主 watcher 未消费，判失败
   * ts 不匹配的回执文件清除后继续等待，避免读取到其他窗口的结果
   */
  private async waitForSwitchReceipt(
    cmdTs: number,
    timeoutMs: number = 8000,
    expectedUid: string = ''
  ): Promise<SwitchReceipt> {
    const cmdFile = PATHS.BYOK_SWITCH_FILE;
    const receiptFile = PATHS.BYOK_SWITCH_RESULT_FILE;
    const start = Date.now();
    let consumed = false;

    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 400));

      if (!consumed && !fs.existsSync(cmdFile)) {
        consumed = true;
      }

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
              const uidMatched = Boolean(data.uid) && (!expectedUid || String(data.uid) === String(expectedUid));
              if (!uidMatched) {
                return {
                  verified: false,
                  ok: false,
                  skipped: false,
                  legacyHost: false,
                  message: t('sw.receiptUidMismatch')
                };
              }
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
        ok: false,
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
      notConsumed: true,
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
        error: patchResult.error,
        detail: patchResult.detail
      };
    }

    // 2. 确保目标 UID 的 NTFS Junction 穿透
    // 建链失败必须中止：切过去也读不到会话，硬切只会让用户以为数据丢了
    const junctionResult = this.ensureJunction(account.uid);
    if (!junctionResult.success) {
      return {
        success: false,
        account,
        patchResult,
        junctionResult,
        message: junctionResult.message,
        error: junctionResult.error || 'JUNCTION_FAILED'
      };
    }

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

    // 4. 等待宿主回执
    const receipt = await this.waitForSwitchReceipt(cmdTs, 8000, account.uid);

    // 4.5 运行中的宿主仍加载历史结构：指令重新就位，重启后由当前结构完成切换
    if (receipt.legacyHost) {
      await this.writeSwitchCommand(account);
      return {
        success: false,
        account,
        patchResult,
        junctionResult,
        receipt,
        needsFullRestart: true,
        message: t('sw.restartToComplete', account.nickname || account.email || account.uid),
        error: 'NEEDS_FULL_RESTART'
      };
    }

    // 4.6 指令原样未动且 watcher 未运行：宿主主进程仍是未加载补丁的旧代码
    // （首次安装或宿主升级后，扩展激活时已把补丁写入磁盘，但尚未完全重启过）。
    // 指令留在原地，完全重启后 watcher 会自动消费完成切换，无需重写。
    // watcher 确实在跑却没消费属于异常，保持原样报错，不用"重启"掩盖。
    if (receipt.notConsumed && !this.isWatcherAlive(patchResult.mainJsPath)) {
      return {
        success: false,
        account,
        patchResult,
        junctionResult,
        receipt,
        needsFullRestart: true,
        message: t('sw.watcherDownRestart', account.nickname || account.email || account.uid),
        error: 'NEEDS_FULL_RESTART'
      };
    }

    // 5. 仅宿主明确确认且账号一致才更新号池与宣告完成
    const confirmed = receipt.ok && receipt.verified;
    if (confirmed && store) {
      await store.setActive(account.id);
    }

    return {
      success: confirmed,
      account,
      patchResult,
      junctionResult,
      receipt,
      message: confirmed
        ? t('sw.switchedReceipt', account.nickname, receipt.skipped ? t('sw.receiptSkipSuffix') : '')
        : t('sw.notEffective', receipt.message),
      error: confirmed ? undefined : 'HOST_RECEIPT_UNCONFIRMED'
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
   * watcher 活性判定（纯读）：诊断日志 mtime 必须不早于 main.js mtime。
   * 日志不存在或比补丁旧，说明运行中的 main 进程没有加载当前补丁。
   */
  private isWatcherAlive(mainPath: string, logOverridePath?: string): boolean {
    const logPath = logOverridePath || path.join(PATHS.CODEBUDDY_APPDATA_DIR, 'byok-watcher.log');
    try {
      const logMtime = fs.statSync(logPath).mtimeMs;
      const mainMtime = fs.statSync(mainPath).mtimeMs;
      // 1s 容差：吸收打补丁与重启之间秒级时钟/写入顺序抖动
      return logMtime >= mainMtime - 1000;
    } catch (_) {
      return false;
    }
  }

  /**
   * 切号链路自检：main.js 定位 → 磁盘补丁 → watcher 运行痕迹 → 指令状态
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

    const watcherAlive = this.isWatcherAlive(mainPath, logOverridePath);
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
