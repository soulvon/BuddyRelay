import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import type * as vscode from 'vscode';

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

const STORAGE_KEY = 'buddyrelay.accounts.pool';
const ACTIVE_ACCOUNT_KEY = 'buddyrelay.accounts.active';

/**
 * 账号安全存储中枢
 * 支持 VSCode ExtensionContext.globalState 安全持久化，同时兼备离线本地文件自愈 fallback
 */
export class AccountStore extends EventEmitter {
  private accounts: Map<string, CodeBuddyAccount> = new Map();
  private activeId: string | null = null;
  private fallbackFilePath: string;
  private context?: vscode.ExtensionContext;

  constructor(context?: vscode.ExtensionContext, customFallbackPath?: string) {
    super();
    this.context = context;

    const defaultDataDir = process.env.APPDATA
      || (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.config'));
    const baseDir = customFallbackPath
      ? path.dirname(customFallbackPath)
      : path.join(defaultDataDir, 'BuddyRelay');
    this.fallbackFilePath = customFallbackPath || path.join(baseDir, 'accounts.json');

    this.load();
  }

  /**
   * 从持久化存储载入账号池
   */
  public load(): void {
    let loaded = false;

    // 优先从 VSCode globalState 载入
    if (this.context && this.context.globalState) {
      try {
        const stored = this.context.globalState.get<CodeBuddyAccount[]>(STORAGE_KEY);
        const storedActive = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        if (Array.isArray(stored)) {
          this.accounts.clear();
          for (const acc of stored) {
            this.accounts.set(acc.id, acc);
          }
          this.activeId = storedActive || null;
          loaded = true;
        }
      } catch (err) {
        // globalState 读取失败时降级
      }
    }

    // 降级：从本地文件载入
    if (!loaded && fs.existsSync(this.fallbackFilePath)) {
      try {
        const raw = fs.readFileSync(this.fallbackFilePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.accounts)) {
          this.accounts.clear();
          for (const acc of data.accounts) {
            this.accounts.set(acc.id, acc);
          }
          this.activeId = data.activeId || null;
          loaded = true;
        }
      } catch (err) {
        // 本地文件解析失败
      }
    }

    // 保证至少有一个 activeId 或标记准确
    this.normalizeActiveStatus();
  }

  /**
   * 将账号池保存到持久化存储
   */
  public async persist(): Promise<void> {
    const list = this.getAll();

    // 1. 保存到 globalState
    if (this.context && this.context.globalState) {
      try {
        await this.context.globalState.update(STORAGE_KEY, list);
        await this.context.globalState.update(ACTIVE_ACCOUNT_KEY, this.activeId);
      } catch (err) {
        // 继续落盘本地
      }
    }

    // 2. 双保险：原子落盘本地文件
    try {
      const dir = path.dirname(this.fallbackFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.fallbackFilePath}.tmp_${Date.now()}`;
      const payload = {
        version: '1.0',
        updatedAt: Date.now(),
        activeId: this.activeId,
        accounts: list
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.fallbackFilePath);
    } catch (err) {
      // 本地存储异常
    }

    this.emit('change', list);
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
