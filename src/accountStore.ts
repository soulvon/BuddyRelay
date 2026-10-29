import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type * as vscode from 'vscode';
import { PATHS } from './constants';

/**
 * CodeBuddy 账号数据模型
 */
export interface QuotaPackageItem {
  title: string;
  count: number;
  remain: number;
  total: number;
  percent: number;
}

export interface CodeBuddyAccount {
  /** 账号唯一标识 (Cockpit 格式如 codebuddy_cn_xxx 或 uid) */
  id: string;
  /** 官方用户 UUID (如 5d81daec-a2d4-48ae-aecf-193c4c3884c3) */
  uid: string;
  /** 手机号 / 邮箱 / 登录名 */
  email: string;
  /** 昵称 */
  nickname: string;
  /** JWT 访问令牌 */
  accessToken: string;
  /** 刷新令牌 */
  refreshToken: string;
  /** 令牌类型 (默认 Bearer) */
  tokenType: string;
  /** 过期时间戳 (毫秒) */
  expiresAt: number;
  /** 域名 */
  domain: string;
  /** 计费类型 (free / pro / enterprise) */
  paymentType?: string;
  /** 原始配额信息快照 */
  quotaRaw?: Record<string, any>;
  /** 官方 auth 原始结构 */
  authRaw?: Record<string, any>;
  /** 官方 profile 原始结构 */
  profileRaw?: Record<string, any>;
  /** 官方 usage 原始结构 */
  usageRaw?: Record<string, any>;
  /** 账号当前调度状态 */
  status: 'active' | 'idle' | 'expired' | 'rate_limited' | 'disabled';
  /** 连续签到天数 */
  checkinStreak?: number;
  /** 今日是否已完成签到 */
  todayCheckedIn?: boolean;
  /** 最近签到日期 (YYYY-MM-DD) */
  lastCheckinDate?: string;
  /** 最近签到时间戳 */
  lastCheckinTime?: number;
  /** 额度积分 / 算力点 */
  totalCredits?: number;
  /** 基础体验包配额信息 (Cockpit Tools 口径) */
  basePackage?: QuotaPackageItem;
  /** 活动赠送包配额信息 (Cockpit Tools 口径) */
  activityPackage?: QuotaPackageItem;
  /** 创建时间戳 */
  createdAt: number;
  /** 最近一次使用/切换时间戳 */
  lastUsed: number;
  /** 429 速率限制冷却截止时间戳 */
  rateLimitUntil?: number;
  /** 备注说明 */
  notes?: string;
}

const STORAGE_KEY = 'buddyrelay.accounts.pool';       // 旧 globalState 迁移源（只读迁移，不再写入）
const ACTIVE_ACCOUNT_KEY = 'buddyrelay.accounts.active'; // 旧 globalState 迁移源（只读迁移，不再写入）

/**
 * 账号名称脱敏
 */
export function maskName(name: string, privacyMode: boolean = true): string {
  if (!name) return '未知';
  if (!privacyMode) return name;
  if (/^1\d{10}$/.test(name)) return name.slice(0, 3) + '****' + name.slice(7);
  if (name.includes('@')) {
    const parts = name.split('@');
    const u = parts[0], h = parts[1];
    const maskedU = u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***';
    return maskedU + '@' + h;
  }
  if (name.length === 2) return name[0] + '*';
  if (name.length === 3) return name[0] + '**';
  if (name.length > 3) return name[0] + '***' + name.slice(-1);
  return name;
}

/**
 * 账号 UID 脱敏
 */
export function maskUid(uid: string, privacyMode: boolean = true): string {
  if (!uid) return '—';
  if (privacyMode) return uid.slice(0, 4) + '****' + uid.slice(-2);
  return uid.slice(0, 8) + '...' + uid.slice(-4);
}

/**
 * 账号安全存储中枢 (多窗口共享版)
 * 唯一权威：共享号池文件 %APPDATA%/CodeBuddy CN/buddy-relay/pool.json（与宿主指令同区，多窗口天然共享）
 * - fs.watch 目录监听：任一窗口变更，其余窗口自动重载并广播 change（Kite 同款跨窗口同步）
 * - 串行写队列：read-modify-write 串行化，杜绝并发丢数据
 * - 原子写：tmp + rename，Windows EPERM/EBUSY 降级覆写
 * - globalState 与旧 BuddyRelay/accounts.json 仅作首次启动迁移源，不再写入（防 last-writer-wins 互相覆盖）
 */
export class AccountStore extends EventEmitter {
  private accounts: Map<string, CodeBuddyAccount> = new Map();
  private activeId: string | null = null;
  private privacyMode: boolean = false;
  private poolFilePath: string;
  private legacyFallbackFilePath: string;
  private context?: vscode.ExtensionContext;

  // 串行写队列（前一次失败不阻塞后续任务，错误单独透传给调用方）
  private _writeQueue: Promise<void> = Promise.resolve();
  // 本窗口最近一次写入的 updatedAt（外部重载时用于识别并跳过自己写的版本）
  private _lastWrittenUpdatedAt: number = 0;
  private _reloadTimer: NodeJS.Timeout | null = null;
  private _retryTimer: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private _watchDesired: boolean = false;

  constructor(context?: vscode.ExtensionContext, customFallbackPath?: string) {
    super();
    this.context = context;

    // 主存储：共享号池文件
    this.poolFilePath = PATHS.POOL_FILE;
    // 旧版独立文件（v0.2 及之前），仅作迁移源
    const defaultDataDir = process.env.APPDATA
      || (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.config'));
    this.legacyFallbackFilePath = customFallbackPath || path.join(defaultDataDir, 'BuddyRelay', 'accounts.json');
    if (customFallbackPath) {
      // 测试场景显式指定路径时，以指定路径为主存储
      this.poolFilePath = customFallbackPath;
    }

    this.load();
    this.startWatcher();
  }

  /**
   * 获取当前全局隐私模式状态
   */
  public getPrivacyMode(): boolean {
    return this.privacyMode;
  }

  /**
   * 设置全局隐私模式状态并通知各订阅方 (状态栏/侧栏/菜单实时同步，跨窗口落盘)
   */
  public async setPrivacyMode(enabled: boolean): Promise<void> {
    this.privacyMode = enabled;
    await this.persist();
    this.emit('privacyChange', enabled);
  }

  /**
   * 从共享号池文件载入账号池（首次启动时从 globalState/旧文件迁移）
   */
  public load(): void {
    let loaded = false;

    // 1. 唯一权威：共享号池文件
    if (fs.existsSync(this.poolFilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.poolFilePath, 'utf8'));
        if (Array.isArray(data.accounts)) {
          this.accounts.clear();
          for (const acc of data.accounts) {
            this.accounts.set(acc.id, acc);
          }
          this.activeId = data.activeId || null;
          this.privacyMode = Boolean(data.privacyMode);
          this._lastWrittenUpdatedAt = data.updatedAt || 0;
          loaded = true;
        }
      } catch (err: any) {
        // 读失败 ≠ 空池：损坏文件留证改名，再走迁移源，严禁拿空池覆盖真实数据
        const backup = `${this.poolFilePath}.corrupt_${Date.now()}`;
        try { fs.renameSync(this.poolFilePath, backup); } catch (_) {}
        console.warn(`[AccountStore] 号池文件解析失败，已留证至 ${backup}: ${err.message}`);
      }
    }

    // 2. 迁移源 A：globalState（旧版本数据）
    if (!loaded && this.context && this.context.globalState) {
      try {
        const stored = this.context.globalState.get<CodeBuddyAccount[]>(STORAGE_KEY);
        const storedActive = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        if (Array.isArray(stored) && stored.length > 0) {
          this.accounts.clear();
          for (const acc of stored) {
            this.accounts.set(acc.id, acc);
          }
          this.activeId = storedActive || null;
          loaded = true;
          console.log(`[AccountStore] 已从 globalState 迁移 ${stored.length} 个账号至共享号池文件`);
        }
      } catch (err) {
        // 迁移源读取失败，继续尝试下一个
      }
    }

    // 3. 迁移源 B：旧版独立 accounts.json
    if (!loaded && fs.existsSync(this.legacyFallbackFilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.legacyFallbackFilePath, 'utf8'));
        if (Array.isArray(data.accounts) && data.accounts.length > 0) {
          this.accounts.clear();
          for (const acc of data.accounts) {
            this.accounts.set(acc.id, acc);
          }
          this.activeId = data.activeId || null;
          loaded = true;
          console.log(`[AccountStore] 已从旧版 accounts.json 迁移 ${data.accounts.length} 个账号至共享号池文件`);
        }
      } catch (err) {
        console.warn('[AccountStore] 旧版 accounts.json 迁移失败:', err);
      }
    }

    // 保证至少有一个 activeId 或标记准确
    this.normalizeActiveStatus();

    // 首次迁移（或池文件缺失）时立即落盘共享文件
    if (loaded) {
      this.persist().catch(err => {
        console.warn(`[AccountStore] 初始落盘失败: ${err.message}`);
      });
    }
  }

  /**
   * 将账号池保存到共享号池文件（唯一权威，跨窗口可见）
   */
  public async persist(): Promise<void> {
    const payload = {
      version: '2.0',
      updatedAt: Date.now(),
      activeId: this.activeId,
      privacyMode: this.privacyMode,
      accounts: this.getAll()
    };

    await this.enqueueWrite(async () => {
      const dir = path.dirname(this.poolFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(payload, null, 2);
      const tmpPath = `${this.poolFilePath}.tmp_${process.pid}_${Date.now()}`;
      fs.writeFileSync(tmpPath, json, 'utf8');
      try {
        fs.renameSync(tmpPath, this.poolFilePath);
      } catch (_) {
        // Windows 偶发 EPERM/EBUSY（另一窗口正在读取），降级直接覆写
        fs.writeFileSync(this.poolFilePath, json, 'utf8');
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      this._lastWrittenUpdatedAt = payload.updatedAt;
    });

    this.emit('change', this.getAll());
  }

  /**
   * 串行写队列：read-modify-write 串行化，避免并发丢数据
   * 队列只跟踪完成状态，不吞调用方错误（错误经返回的 Promise 透传）
   */
  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const ready = this._writeQueue.then(() => {}, () => {});
    const next = ready.then(task);
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 监听共享号池目录：任一窗口写入，本窗口自动重载并广播（跨窗口同步核心）
   */
  private startWatcher(): void {
    if (this.fileWatcher || this._watchDesired) return;
    this._watchDesired = true;
    try {
      const watchDir = path.dirname(this.poolFilePath);
      fs.mkdirSync(watchDir, { recursive: true });
      const base = path.basename(this.poolFilePath);
      // 监听目录而非文件本身：Windows/Linux 上 rename 替换会使文件级 watcher 失效
      this.fileWatcher = fs.watch(watchDir, (_evt, filename) => {
        // 兼容 Windows (filename为null/目标名) 与 Linux inotify (带tmp后缀或目标名)
        if (!filename || filename === base || filename.startsWith(base) || filename.includes(base)) {
          this.scheduleReload();
        }
      });
      this.fileWatcher.on('error', err => {
        console.warn('[AccountStore] 号池 watcher 出错，1 秒后重试:', err);
        try { this.fileWatcher?.close(); } catch { /* ignore */ }
        this.fileWatcher = null;
        setTimeout(() => {
          if (this._watchDesired) {
            this._watchDesired = false;
            this.startWatcher();
          }
        }, 1000);
      });
    } catch (e: any) {
      console.warn('[AccountStore] 号池 watch 启动失败:', e.message);
      this._watchDesired = false;
    }
  }

  private scheduleReload(): void {
    if (this._reloadTimer) return;
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this.reloadFromDisk();
    }, 150);
  }

  /**
   * 从磁盘重载共享号池（外部窗口写入时触发；自己写入的版本按 updatedAt 跳过）
   */
  private reloadFromDisk(): void {
    if (!fs.existsSync(this.poolFilePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.poolFilePath, 'utf8'));
      const incomingUpdatedAt = data.updatedAt || 0;
      if (incomingUpdatedAt === this._lastWrittenUpdatedAt) {
        return; // 自己刚写的版本，无需重载
      }
      if (!Array.isArray(data.accounts)) return;

      const prevPrivacy = this.privacyMode;
      this.accounts.clear();
      for (const acc of data.accounts) {
        this.accounts.set(acc.id, acc);
      }
      this.activeId = data.activeId || null;
      this.privacyMode = Boolean(data.privacyMode);
      this._lastWrittenUpdatedAt = incomingUpdatedAt;
      this.normalizeActiveStatus();

      if (prevPrivacy !== this.privacyMode) {
        this.emit('privacyChange', this.privacyMode);
      }
      this.emit('change', this.getAll());
    } catch (err: any) {
      // 读失败 = 未知：若处于写文件瞬间竞争，150ms 后兜底重试一次
      if (!this._retryTimer) {
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.reloadFromDisk();
        }, 150);
      }
      console.warn('[AccountStore] 外部号池变更读取失败，保留内存现状:', err.message);
    }
  }

  /**
   * 释放文件监听资源
   */
  public dispose(): void {
    this._watchDesired = false;
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch { /* ignore */ }
      this.fileWatcher = null;
    }
  }

  /**
   * 获取账号总数
   */
  public count(): number {
    return this.accounts.size;
  }

  /**
   * 获取全量账号列表
   */
  public getAll(): CodeBuddyAccount[] {
    return Array.from(this.accounts.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /**
   * 根据 ID 或 UID 精确检索账号
   */
  public get(idOrUid: string): CodeBuddyAccount | undefined {
    if (this.accounts.has(idOrUid)) {
      return this.accounts.get(idOrUid);
    }
    for (const acc of this.accounts.values()) {
      if (acc.uid === idOrUid) {
        return acc;
      }
    }
    return undefined;
  }

  /**
   * 模糊匹配账号 (匹配 ID、UID、邮箱、昵称)
   */
  public find(query: string): CodeBuddyAccount | undefined {
    const q = query.trim().toLowerCase();
    for (const acc of this.accounts.values()) {
      if (
        acc.id.toLowerCase().includes(q) ||
        acc.uid.toLowerCase().includes(q) ||
        acc.email.toLowerCase().includes(q) ||
        acc.nickname.toLowerCase().includes(q)
      ) {
        return acc;
      }
    }
    return undefined;
  }

  /**
   * 获取当前活跃账号
   */
  public getActive(): CodeBuddyAccount | undefined {
    if (this.activeId && this.accounts.has(this.activeId)) {
      return this.accounts.get(this.activeId);
    }
    for (const acc of this.accounts.values()) {
      if (acc.status === 'active') {
        this.activeId = acc.id;
        return acc;
      }
    }
    return undefined;
  }

  /**
   * 设置当前活跃账号
   */
  public async setActive(idOrUid: string): Promise<CodeBuddyAccount> {
    const acc = this.get(idOrUid);
    if (!acc) {
      throw new Error(`[AccountStore] 目标账号不存在: ${idOrUid}`);
    }

    for (const a of this.accounts.values()) {
      if (a.id === acc.id) {
        a.status = 'active';
        a.lastUsed = Date.now();
      } else if (a.status === 'active') {
        a.status = 'idle';
      }
    }
    this.activeId = acc.id;
    await this.persist();
    return acc;
  }

  /**
   * 保存或更新单个账号
   */
  public async upsert(acc: CodeBuddyAccount): Promise<void> {
    const existing = this.get(acc.id) || this.get(acc.uid);
    if (existing) {
      // 保持原有状态如果新状态未显式指定
      const merged: CodeBuddyAccount = {
        ...existing,
        ...acc,
        id: existing.id || acc.id,
        createdAt: existing.createdAt || acc.createdAt || Date.now(),
        lastUsed: acc.lastUsed || existing.lastUsed || Date.now()
      };
      this.accounts.set(merged.id, merged);
    } else {
      this.accounts.set(acc.id, acc);
    }

    this.normalizeActiveStatus();
    await this.persist();
  }

  /**
   * 批量保存/合并账号
   */
  public async upsertBatch(accounts: CodeBuddyAccount[]): Promise<number> {
    let count = 0;
    for (const acc of accounts) {
      const existing = this.get(acc.id) || this.get(acc.uid);
      if (existing) {
        const merged: CodeBuddyAccount = {
          ...existing,
          ...acc,
          id: existing.id || acc.id,
          createdAt: existing.createdAt || acc.createdAt || Date.now(),
          lastUsed: Math.max(existing.lastUsed || 0, acc.lastUsed || 0)
        };
        this.accounts.set(merged.id, merged);
      } else {
        this.accounts.set(acc.id, acc);
      }
      count++;
    }

    this.normalizeActiveStatus();
    await this.persist();
    return count;
  }

  /**
   * 删除账号
   */
  public async delete(idOrUid: string): Promise<boolean> {
    const acc = this.get(idOrUid);
    if (!acc) {
      return false;
    }
    this.accounts.delete(acc.id);
    if (this.activeId === acc.id) {
      this.activeId = null;
      this.normalizeActiveStatus();
    }
    await this.persist();
    return true;
  }

  /**
   * 更新账号状态
   */
  public async updateStatus(
    idOrUid: string,
    status: CodeBuddyAccount['status'],
    extra?: Partial<CodeBuddyAccount>
  ): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;

    acc.status = status;
    if (extra) {
      Object.assign(acc, extra);
    }
    if (status === 'active') {
      this.activeId = acc.id;
      for (const a of this.accounts.values()) {
        if (a.id !== acc.id && a.status === 'active') {
          a.status = 'idle';
        }
      }
    }
    await this.persist();
  }

  /**
   * 切换账号启用/禁用状态 (disabled <-> idle)
   */
  public async toggleStatus(idOrUid: string): Promise<CodeBuddyAccount | undefined> {
    const acc = this.get(idOrUid);
    if (!acc) return undefined;
    if (acc.status === 'disabled') {
      acc.status = 'idle';
    } else {
      acc.status = 'disabled';
      if (this.activeId === acc.id) {
        this.activeId = null;
      }
    }
    this.normalizeActiveStatus();
    await this.persist();
    return acc;
  }

  /**
   * 标记账号遭遇 429 速率限制
   */
  public async markRateLimited(idOrUid: string, durationMs: number = 5 * 60 * 1000): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;

    acc.status = 'rate_limited';
    acc.rateLimitUntil = Date.now() + durationMs;
    await this.persist();
  }

  /**
   * 解除账号 429 限制
   */
  public async clearRateLimit(idOrUid: string): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;

    if (acc.status === 'rate_limited') {
      acc.status = this.activeId === acc.id ? 'active' : 'idle';
      delete acc.rateLimitUntil;
      await this.persist();
    }
  }

  /**
   * 归一化活跃状态：若无活跃账号且号池非空，默认设置首个就绪账号为 active
   */
  private normalizeActiveStatus(): void {
    if (this.accounts.size === 0) {
      this.activeId = null;
      return;
    }

    const current = this.activeId ? this.accounts.get(this.activeId) : null;
    if (current && current.status === 'active') {
      return;
    }

    // 寻找已经为 active 的
    for (const acc of this.accounts.values()) {
      if (acc.status === 'active') {
        this.activeId = acc.id;
        return;
      }
    }

    // 否则取第一个非 disabled/expired 的作为 active
    for (const acc of this.accounts.values()) {
      if (acc.status !== 'disabled' && acc.status !== 'expired') {
        acc.status = 'active';
        this.activeId = acc.id;
        return;
      }
    }

    // 实在没有就取第一个
    const first = this.accounts.values().next().value;
    if (first) {
      first.status = 'active';
      this.activeId = first.id;
    }
  }
}
