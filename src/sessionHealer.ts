/**
 * 会话母体自愈中枢
 *
 * 背景事故（2026-11-03）：`ensureJunction` 把母体 uid 硬编码成作者本人的账号 uid。
 * 在作者机器上该目录恰好是真实数据目录，一切正常；在用户机器上该 uid 从未登录过，
 * 于是"新建一个空母体 → 把用户真实会话目录改名成 .bak_时间戳 → 建链指向空目录"，
 * 表现为切号后右侧会话记录全部消失、只剩 New Chat，切回原账号也看不到（原路径已被替换）。
 *
 * 本模块做三件事：
 *   1. 母体不再硬编码：优先用已登记母体，其次当前登录 uid，最后选内容最丰富的实体目录；
 *   2. 升级后自愈：把被误接的 junction 摘掉、把 .bak_ 备份里的数据合并回母体并复原路径；
 *   3. 建链前强校验：母体不存在或为空一律拒绝改名，宁可切号失败也不动用户数据。
 *
 * 铁律：备份目录永不删除；任何删除动作前必须确认目标为空目录或内容已合并。
 */
import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';

export interface UidDirInfo {
  uid: string;
  /** Data\<uid>\CodeBuddyIDE\<uid> */
  innerPath: string;
  exists: boolean;
  isLink: boolean;
  /** 目录内一级条目数（history / plan-task / check-point / file-tree 各自算一个） */
  itemCount: number;
  hasHistory: boolean;
  /** 同父目录下 <uid>.bak_<时间戳> 备份 */
  backups: string[];
}

export interface HealResult {
  /** 是否实际改动了磁盘 */
  healed: boolean;
  /** 自愈后的母体 uid；null 表示没有可用数据 */
  masterUid: string | null;
  /** 数据从哪个备份/目录合并而来 */
  restoredFrom: string | null;
  /** 重建/修复的链接数量 */
  repairedLinks: number;
  /** 发现的异常（不阻断，但必须让用户看到） */
  warnings: string[];
  message: string;
  error?: string;
}

/** 递归复制目录；已存在的文件不覆盖，返回跳过的文件数 */
export function copyDirMerge(src: string, dest: string): number {
  let skipped = 0;
  const stack: Array<{ from: string; to: string }> = [{ from: src, to: dest }];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (!fs.existsSync(cur.to)) {
      fs.mkdirSync(cur.to, { recursive: true });
    }
    for (const entry of fs.readdirSync(cur.from, { withFileTypes: true })) {
      const fromPath = path.join(cur.from, entry.name);
      const toPath = path.join(cur.to, entry.name);
      if (entry.isDirectory()) {
        stack.push({ from: fromPath, to: toPath });
        continue;
      }
      if (fs.existsSync(toPath)) {
        skipped += 1;
        continue;
      }
      fs.copyFileSync(fromPath, toPath);
    }
  }
  return skipped;
}

/** 目录是否为空（不存在也算空） */
function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/** 删除链接本身（Windows junction / POSIX symlink），绝不递归删目标内容 */
function removeLink(linkPath: string): void {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    fs.rmdirSync(linkPath);
  }
}

/**
 * 归一化链接目标：剥掉 Windows 设备命名空间前缀（\\?\ 与 \??\）并统一小写。
 * cmd mklink 与 Node symlinkSync 产物的前缀不同，不剥离会把"指向正确"误判成 stale link 反复重建。
 */
export function normalizeLinkTarget(target: string): string {
  return target.replace(/^\\{1,2}\?\?\\|^\\{1,2}\?\\/i, '').toLowerCase();
}

export class SessionHealer {
  private readonly root: string;
  private readonly masterFile: string;
  private readonly logFile: string;

  constructor(options?: { dataRoot?: string; masterFile?: string; logFile?: string }) {
    this.root = options?.dataRoot || PATHS.EXTENSION_DATA_DIR;
    this.masterFile = options?.masterFile || PATHS.SESSION_MASTER_FILE;
    this.logFile = options?.logFile || PATHS.SESSION_HEAL_LOG;
  }

  /** 读取已登记母体 uid；文件损坏或字段非法返回 null，不猜 */
  public readRegisteredMaster(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.masterFile, 'utf8'));
      const uid = String(raw?.masterUid || '').trim();
      return uid || null;
    } catch {
      return null;
    }
  }

  /** 登记母体 uid（原子写） */
  public registerMaster(uid: string): void {
    const dir = path.dirname(this.masterFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${this.masterFile}.tmp_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ masterUid: uid, updatedAt: Date.now() }, null, 2), 'utf8');
    fs.renameSync(tmp, this.masterFile);
  }

  /** 当前登录 uid（宿主 globalStorage/storage.json 明文） */
  public readCurrentUid(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(PATHS.CODEBUDDY_STORAGE_JSON, 'utf8'));
      const uid = String(raw?.['genie.userId'] || '').trim();
      return uid || null;
    } catch {
      return null;
    }
  }

  /** 扫描 Data 下所有 uid 目录与备份 */
  public scan(): UidDirInfo[] {
    let uids: string[] = [];
    try {
      uids = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }

    const infos: UidDirInfo[] = [];
    for (const uid of uids) {
      const parent = path.join(this.root, uid, 'CodeBuddyIDE');
      const inner = path.join(parent, uid);
      const info: UidDirInfo = {
        uid,
        innerPath: inner,
        exists: false,
        isLink: false,
        itemCount: 0,
        hasHistory: false,
        backups: []
      };

      try {
        const lstat = fs.lstatSync(inner);
        info.exists = true;
        info.isLink = lstat.isSymbolicLink();
        if (!info.isLink) {
          const entries = fs.readdirSync(inner);
          info.itemCount = entries.length;
          info.hasHistory = entries.includes('history');
        }
      } catch {
        // inner 不存在：账号尚未产生本地会话数据，正常状态
      }

      try {
        const bakPrefix = `${uid}.bak_`;
        info.backups = fs
          .readdirSync(parent)
          .filter(name => name.startsWith(bakPrefix) && /^\d+$/.test(name.slice(bakPrefix.length)))
          .map(name => path.join(parent, name))
          .filter(p => {
            try {
              return fs.statSync(p).isDirectory();
            } catch {
              return false;
            }
          });
      } catch {
        // 父目录不存在
      }

      infos.push(info);
    }
    return infos;
  }

  /** 母体是否可用：必须是真实目录且内有内容 */
  private isUsableMaster(info: UidDirInfo | undefined): boolean {
    return Boolean(info && info.exists && !info.isLink && (info.itemCount > 0 || info.hasHistory));
  }

  /**
   * 选出母体 uid。顺序：已登记 → 当前登录 → 内容最丰富的实体目录。
   * 只返回"可用"母体；没有可用母体时返回 null，由 heal() 尝试从备份复原。
   */
  public pickMaster(infos: UidDirInfo[]): string | null {
    const registered = this.readRegisteredMaster();
    if (registered) {
      const hit = infos.find(i => i.uid === registered);
      if (this.isUsableMaster(hit)) {
        return registered;
      }
    }

    const current = this.readCurrentUid();
    if (current) {
      const hit = infos.find(i => i.uid === current);
      if (this.isUsableMaster(hit)) {
        return current;
      }
    }

    const candidates = infos.filter(i => this.isUsableMaster(i)).sort((a, b) => b.itemCount - a.itemCount);
    return candidates.length > 0 ? candidates[0].uid : null;
  }

  /** 备份里内容最多的那个（用于数据全丢时的复原） */
  private pickRichestBackup(infos: UidDirInfo[]): { uid: string; backup: string; count: number } | null {
    let best: { uid: string; backup: string; count: number } | null = null;
    for (const info of infos) {
      for (const backup of info.backups) {
        let count = 0;
        try {
          count = fs.readdirSync(backup).length;
        } catch {
          continue;
        }
        if (count > 0 && (!best || count > best.count)) {
          best = { uid: info.uid, backup, count };
        }
      }
    }
    return best;
  }

  private appendLog(line: string): void {
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // 日志写不进去不影响自愈本身
    }
  }

  /**
   * 升级后自愈：修复被错误指向空母体的链接，并把 .bak_ 备份里的数据合并回母体。
   * 幂等：没有问题时不改动任何文件，返回 healed=false。
   */
  public heal(): HealResult {
    const warnings: string[] = [];
    let repairedLinks = 0;
    let restoredFrom: string | null = null;
    let healed = false;

    let infos = this.scan();
    if (infos.length === 0) {
      return {
        healed: false,
        masterUid: null,
        restoredFrom: null,
        repairedLinks: 0,
        warnings,
        message: '未发现本机会话数据目录，跳过自愈',
        error: 'NO_DATA_ROOT'
      };
    }

    let masterUid = this.pickMaster(infos);

    // 所有实体目录都空/不存在：尝试把最丰富的备份改名回原位，认作母体
    if (!masterUid) {
      const richest = this.pickRichestBackup(infos);
      if (!richest) {
        return {
          healed: false,
          masterUid: null,
          restoredFrom: null,
          repairedLinks: 0,
          warnings,
          message: '本机无可用会话数据，无需自愈',
          error: 'NO_USABLE_DATA'
        };
      }
      const target = infos.find(i => i.uid === richest.uid)!.innerPath;
      try {
        if (fs.existsSync(target)) {
          if (isEmptyDir(target)) {
            removeLink(target);
          } else {
            warnings.push(`目标路径已有非空目录，未覆盖: ${target}`);
          }
        }
        fs.renameSync(richest.backup, target);
        masterUid = richest.uid;
        restoredFrom = richest.backup;
        healed = true;
        this.appendLog(`restored backup ${richest.backup} -> ${target}`);
      } catch (err: any) {
        return {
          healed: false,
          masterUid: null,
          restoredFrom: richest.backup,
          repairedLinks: 0,
          warnings,
          message: `备份复原失败: ${err.message}`,
          error: 'RESTORE_FAILED'
        };
      }
      infos = this.scan();
    }

    const masterInfo = infos.find(i => i.uid === masterUid);
    if (!masterInfo) {
      return {
        healed,
        masterUid,
        restoredFrom,
        repairedLinks,
        warnings,
        message: '母体目录定位失败',
        error: 'MASTER_NOT_FOUND'
      };
    }
    const masterPath = masterInfo.innerPath;

    // 母体为空但存在备份：把备份内容合并进母体（不覆盖已有文件）
    if (isEmptyDir(masterPath)) {
      const richest = this.pickRichestBackup(infos);
      if (richest) {
        try {
          const skipped = copyDirMerge(richest.backup, masterPath);
          restoredFrom = richest.backup;
          healed = true;
          this.appendLog(`merged backup ${richest.backup} -> ${masterPath} (skipped=${skipped})`);
          if (skipped > 0) {
            warnings.push(`合并时跳过 ${skipped} 个已存在文件`);
          }
        } catch (err: any) {
          warnings.push(`备份合并失败: ${err.message}`);
        }
      }
    }

    // 逐个 uid 修正链接
    for (const info of infos) {
      const { uid, innerPath } = info;
      if (uid === masterUid) {
        continue;
      }

      // 已正确指向母体的链接：不动
      if (info.isLink) {
        let target = '';
        try {
          target = fs.readlinkSync(innerPath);
        } catch {
          target = '';
        }
        if (target && normalizeLinkTarget(path.resolve(target)) === normalizeLinkTarget(path.resolve(masterPath))) {
          continue;
        }
        try {
          removeLink(innerPath);
          fs.symlinkSync(masterPath, innerPath, process.platform === 'win32' ? 'junction' : 'dir');
          repairedLinks += 1;
          healed = true;
          this.appendLog(`repaired link ${innerPath} -> ${masterPath}`);
        } catch (err: any) {
          warnings.push(`修复链接失败 ${innerPath}: ${err.message}`);
        }
        continue;
      }

      // 实体目录：先把它自己的数据合并进母体，再改名备份并建链
      if (info.exists && info.itemCount > 0) {
        try {
          const skipped = copyDirMerge(innerPath, masterPath);
          this.appendLog(`merged uid dir ${innerPath} -> ${masterPath} (skipped=${skipped})`);
          if (skipped > 0) {
            warnings.push(`${uid} 目录有 ${skipped} 个同名文件未覆盖，已保留原目录备份`);
          }
        } catch (err: any) {
          warnings.push(`合并 ${uid} 失败，保留原目录未建链: ${err.message}`);
          continue;
        }
        const backup = `${innerPath}.bak_${Date.now()}`;
        try {
          fs.renameSync(innerPath, backup);
          this.appendLog(`renamed ${innerPath} -> ${backup}`);
        } catch (err: any) {
          warnings.push(`备份 ${uid} 目录失败，未建链: ${err.message}`);
          continue;
        }
      } else if (info.exists) {
        try {
          fs.rmdirSync(innerPath);
        } catch (err: any) {
          warnings.push(`清理空目录失败 ${innerPath}: ${err.message}`);
          continue;
        }
      }

      try {
        if (!fs.existsSync(path.dirname(innerPath))) {
          fs.mkdirSync(path.dirname(innerPath), { recursive: true });
        }
        fs.symlinkSync(masterPath, innerPath, process.platform === 'win32' ? 'junction' : 'dir');
        repairedLinks += 1;
        healed = true;
        this.appendLog(`linked ${innerPath} -> ${masterPath}`);
      } catch (err: any) {
        warnings.push(`建链接失败 ${innerPath}: ${err.message}`);
      }
    }

    if (masterUid) {
      const prev = this.readRegisteredMaster();
      if (prev !== masterUid) {
        try {
          this.registerMaster(masterUid);
          this.appendLog(`registered master uid=${masterUid}`);
        } catch (err: any) {
          warnings.push(`登记母体失败: ${err.message}`);
        }
      }
    }

    return {
      healed,
      masterUid,
      restoredFrom,
      repairedLinks,
      warnings,
      message: healed
        ? `会话数据已自愈（母体 ${masterUid}，修复链接 ${repairedLinks} 个）`
        : `会话数据正常（母体 ${masterUid}）`
    };
  }

  /**
   * 切号前取母体：母体必须真实存在且非空。
   * 返回 null 时调用方必须中止切号——绝不允许再造一个空母体把用户目录换走。
   */
  public resolveMasterForSwitch(): { masterUid: string; masterPath: string } | null {
    const registered = this.readRegisteredMaster();
    const infos = this.scan();
    const masterUid = registered || this.pickMaster(infos);
    if (!masterUid) {
      return null;
    }
    const info = infos.find(i => i.uid === masterUid);
    if (!this.isUsableMaster(info)) {
      return null;
    }
    return { masterUid, masterPath: info!.innerPath };
  }

  /**
   * 接管一个实体会话目录：先把内容合并进母体，再改名成 .bak_时间戳 留底。
   * 合并失败直接抛错——调用方不得继续改名，否则就是数据丢失。
   */
  public adoptIntoMaster(innerPath: string, masterPath: string): void {
    const skipped = copyDirMerge(innerPath, masterPath);
    this.appendLog(`adopt ${innerPath} -> ${masterPath} (skipped=${skipped})`);
  }

  /** 把实体目录改名备份（永不删除），返回备份路径 */
  public backupDir(innerPath: string): string {
    const backup = `${innerPath}.bak_${Date.now()}`;
    fs.renameSync(innerPath, backup);
    this.appendLog(`renamed ${innerPath} -> ${backup}`);
    return backup;
  }

  /** 写一条自愈日志（供切号流程留痕） */
  public log(line: string): void {
    this.appendLog(line);
  }
}
