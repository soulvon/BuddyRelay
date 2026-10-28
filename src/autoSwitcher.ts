import { EventEmitter } from 'events';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { SeamlessSwitcher, SwitchResult } from './seamlessSwitcher';
import { OAuthService } from './oauthService';
import { getOtherLockedUids } from './accountLock';

export type RotationStrategy = 'highest_quota' | 'lru' | 'round_robin' | 'health_priority';

export interface RotationEvent {
  fromUid: string;
  toUid: string;
  targetAccount: CodeBuddyAccount;
  reason: 'quota_exhausted' | 'rate_limited_429' | 'token_expired' | 'manual';
  timestamp: number;
}

export interface AutoSwitcherOptions {
  strategy?: RotationStrategy;
  defaultCooldownMs?: number; // 429 默认冷却时间 (默认 5 分钟)
  autoRefreshTokens?: boolean;
}

/**
 * 额度见底 / 429 速率限制自动轮换调度器
 * 负责号池健康度监控、智能轮换与平滑调度
 */
export class AutoSwitcher extends EventEmitter {
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private oauthService: OAuthService;
  private strategy: RotationStrategy;
  private defaultCooldownMs: number;
  private autoRefreshTokens: boolean;
  private monitorTimer: NodeJS.Timeout | null = null;
  private quotaGuardTimer: NodeJS.Timeout | null = null;
  private isRotating: boolean = false;
  private lastAutoSwitchAt: number = 0;
  private getConfig: (() => { enabled: boolean; thresholdPercent: number; cooldownMinutes: number } | null) | null = null;

  constructor(
    store: AccountStore,
    switcher?: SeamlessSwitcher,
    oauthService?: OAuthService,
    options?: AutoSwitcherOptions
  ) {
    super();
    this.store = store;
    this.switcher = switcher || new SeamlessSwitcher();
    this.oauthService = oauthService || new OAuthService();
    this.strategy = options?.strategy || 'lru';
    this.defaultCooldownMs = options?.defaultCooldownMs || 5 * 60 * 1000;
    this.autoRefreshTokens = options?.autoRefreshTokens ?? true;
  }

  /**
   * 筛选并获取下一个可用账号
   */
  public getNextAvailableAccount(currentUid?: string): CodeBuddyAccount | null {
    const all = this.store.getAll();
    const now = Date.now();
    // 跨窗口互斥：读取其他存活窗口正持有的账号
    const otherLocked = getOtherLockedUids();

    // 1. 过滤并自愈到期的 rate_limited 账号
    const candidates: CodeBuddyAccount[] = [];
    for (const acc of all) {
      // 检查 429 冷却是否已到期，到期则恢复
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil <= now) {
        acc.status = 'idle';
        delete acc.rateLimitUntil;
        this.store.upsert(acc).catch(() => {});
      }

      // 排除禁用与已失效的账号
      if (acc.status === 'disabled' || acc.status === 'expired') {
        continue;
      }

      // 排除仍在 429 冷却中的账号
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil > now) {
        continue;
      }

      // 排除当前正在使用的账号
      if (currentUid && (acc.uid === currentUid || acc.id === currentUid)) {
        continue;
      }

      // 排除被其他存活窗口占用的账号（防止双窗口抢号横跳）
      if (otherLocked.has(acc.uid)) {
        continue;
      }

      candidates.push(acc);
    }

    if (candidates.length === 0) {
      return null;
    }

    // 2. 根据调度策略选出最佳账号
    if (this.strategy === 'highest_quota') {
      // 优先剩余算力占比最高的账号（无配额数据时退回 LRU）
      candidates.sort((a, b) => {
        const aPct = a.activityPackage
          ? a.activityPackage.percent
          : a.totalCredits != null
          ? -1
          : -2;
        const bPct = b.activityPackage
          ? b.activityPackage.percent
          : b.totalCredits != null
          ? -1
          : -2;
        if (bPct !== aPct) {
          return bPct - aPct;
        }
        return (a.lastUsed || 0) - (b.lastUsed || 0);
      });
      return candidates[0];
    } else if (this.strategy === 'round_robin') {
      // 取第一个
      return candidates[0];
    } else if (this.strategy === 'health_priority') {
      // 优先选未被限制过且连续签到天数多的账号
      candidates.sort((a, b) => {
        const aStreak = a.checkinStreak || 0;
        const bStreak = b.checkinStreak || 0;
        return bStreak - aStreak;
      });
      return candidates[0];
    } else {
      // 默认 LRU: 选最近最少使用的账号 (lastUsed 最小)
      candidates.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
      return candidates[0];
    }
  }

  /**
   * 触发因额度耗尽引起的平滑热切
   */
  public async handleQuotaExhausted(
    currentUid: string,
    reasonMessage: string = '会话额度已见底'
  ): Promise<SwitchResult> {
    if (this.isRotating) {
      throw new Error('[AutoSwitcher] 调度器正在切号中，请勿重复并发调用');
    }
    this.isRotating = true;

    try {
      const current = this.store.get(currentUid);
      if (current) {
        await this.store.updateStatus(current.id, 'idle', {
          notes: `[${new Date().toLocaleString()}] 额度见底标记: ${reasonMessage}`
        });
      }

      const next = this.getNextAvailableAccount(currentUid);
      if (!next) {
        throw new Error('[AutoSwitcher] 号池告急：已无可用的备用就绪账号');
      }

      // 执行底层热切
      const res = await this.switcher.switchAccount(next, this.store);

      this.emit('rotation', {
        fromUid: currentUid,
        toUid: next.uid,
        targetAccount: next,
        reason: 'quota_exhausted',
        timestamp: Date.now()
      } as RotationEvent);

      return res;
    } finally {
      this.isRotating = false;
    }
  }

  /**
   * 触发因 429 速率限制引起的自动轮换
   */
  public async handleRateLimit429(
    currentUid: string,
    cooldownMs?: number,
    reasonMessage: string = '触发上游 429 Too Many Requests'
  ): Promise<SwitchResult> {
    if (this.isRotating) {
      throw new Error('[AutoSwitcher] 调度器正在切号中，请勿重复并发调用');
    }
    this.isRotating = true;

    try {
      const cooldown = cooldownMs || this.defaultCooldownMs;
      await this.store.markRateLimited(currentUid, cooldown);

      const next = this.getNextAvailableAccount(currentUid);
      if (!next) {
        throw new Error(`[AutoSwitcher] 当前账号触发 429，且号池无其它就绪账号可供轮换 (冷却 ${cooldown / 1000}秒)`);
      }

      // 执行底层热切
      const res = await this.switcher.switchAccount(next, this.store);

      this.emit('rotation', {
        fromUid: currentUid,
        toUid: next.uid,
        targetAccount: next,
        reason: 'rate_limited_429',
        timestamp: Date.now()
      } as RotationEvent);

      return res;
    } finally {
      this.isRotating = false;
    }
  }

  /**
   * 启动后台状态监视器 (检查 429 冷却恢复与 Token 即将过期自动续期)
   */
  public startMonitor(intervalMs: number = 60 * 1000): void {
    if (this.monitorTimer) {
      return;
    }

    this.monitorTimer = setInterval(async () => {
      try {
        await this.runHealthCycle();
      } catch (err) {
        // 监控异常静默防护
      }
    }, intervalMs);
  }

  /**
   * 停止后台监视器
   */
  public stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.stopQuotaGuard();
  }

  /**
   * 主动额度守卫：周期性检查当前账号剩余算力，低于阈值自动无感切换
   * 条件可通过 VS Code 设置自定义（buddyRelay.autoSwitch.*）
   */
  public startQuotaGuard(getConfig: () => { enabled: boolean; thresholdPercent: number; cooldownMinutes: number } | null): void {
    if (this.quotaGuardTimer) {
      return;
    }
    this.getConfig = getConfig;

    this.quotaGuardTimer = setInterval(async () => {
      try {
        const cfg = this.getConfig ? this.getConfig() : null;
        if (!cfg || !cfg.enabled) {
          return;
        }

        // 冷却期防抖
        if (this.lastAutoSwitchAt && Date.now() - this.lastAutoSwitchAt < cfg.cooldownMinutes * 60 * 1000) {
          return;
        }

        const active = this.store.getActive();
        if (!active || !active.uid) {
          return;
        }

        // 计算当前账号剩余算力占比
        const pct = active.activityPackage
          ? active.activityPackage.percent
          : null;
        if (pct == null || isNaN(pct)) {
          return;
        }

        if (pct <= cfg.thresholdPercent) {
          console.log(
            `[BuddyRelay][QuotaGuard] 账号 ${active.nickname || active.email} 剩余 ${pct}% ≤ 阈值 ${cfg.thresholdPercent}%，触发自动无感切换`
          );
          const res = await this.handleQuotaExhausted(
            active.uid,
            `剩余算力 ${pct}% 低于阈值 ${cfg.thresholdPercent}%`
          );
          if (res.success) {
            this.lastAutoSwitchAt = Date.now();
          }
        }
      } catch (err: any) {
        // 号池告急等错误静默记录，等待下轮
        console.warn(`[BuddyRelay][QuotaGuard] 巡检异常: ${err.message}`);
      }
    }, 60 * 1000);
  }

  public stopQuotaGuard(): void {
    if (this.quotaGuardTimer) {
      clearInterval(this.quotaGuardTimer);
      this.quotaGuardTimer = null;
    }
  }

  /**
   * 手动/外部触发 429 轮换的便捷入口
   */
  public async autoSwitchOn429(cooldownMs?: number): Promise<SwitchResult | null> {
    const active = this.store.getActive();
    if (!active || !active.uid) {
      return null;
    }
    return await this.handleRateLimit429(active.uid, cooldownMs);
  }

  /**
   * 单次健康巡检周期
   */
  public async runHealthCycle(): Promise<{ recoveredCount: number; refreshedCount: number }> {
    const all = this.store.getAll();
    const now = Date.now();
    let recoveredCount = 0;
    let refreshedCount = 0;

    for (const acc of all) {
      // 1. 恢复 429 到期账号
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil <= now) {
        await this.store.clearRateLimit(acc.id);
        recoveredCount++;
      }

      // 2. 检查 Token 过期并在临近过期时（剩余小于 1 小时）自动刷新
      if (this.autoRefreshTokens && acc.refreshToken && acc.expiresAt) {
        const remainingMs = acc.expiresAt - now;
        if (remainingMs > 0 && remainingMs < 60 * 60 * 1000) {
          try {
            const refreshed = await this.oauthService.refreshAccessToken(acc.refreshToken, acc.domain);
            acc.accessToken = refreshed.accessToken;
            if (refreshed.refreshToken) {
              acc.refreshToken = refreshed.refreshToken;
            }
            acc.expiresAt = now + (refreshed.expiresIn || 7200) * 1000;
            await this.store.upsert(acc);
            refreshedCount++;
          } catch (_) {
            // 刷新失败待下次重试
          }
        }
      }
    }

    return { recoveredCount, refreshedCount };
  }
}
