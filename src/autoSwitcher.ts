import { EventEmitter } from 'events';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { SeamlessSwitcher, SwitchResult } from './seamlessSwitcher';
import { OAuthService, httpRequest } from './oauthService';
import { getOtherLockedUids } from './accountLock';
import { API_ENDPOINTS } from './constants';
import { UsageTracker } from './usageTracker';

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
  usageTracker?: UsageTracker;
}

/**
 * 额度见底 / 429 速率限制自动轮换调度器
 * 负责号池健康度监控、智能轮换与平滑调度
 */
export class AutoSwitcher extends EventEmitter {
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private oauthService: OAuthService;
  private usageTracker?: UsageTracker;
  private strategy: RotationStrategy;
  private defaultCooldownMs: number;
  private autoRefreshTokens: boolean;
  private monitorTimer: NodeJS.Timeout | null = null;
  private quotaGuardTimer: NodeJS.Timeout | null = null;
  private isRotating: boolean = false;
  private lastAutoSwitchAt: number = 0;
  private getConfig: (() => { enabled: boolean; thresholdPercent: number; cooldownMinutes: number } | null) | null = null;

  // 熔断保护器状态（60秒内连续切号上限 5 次，超限熔断 2 分钟）
  private breakerTrippedUntil: number = 0;
  private switchTimestamps: number[] = [];

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
    this.usageTracker = options?.usageTracker;
    this.strategy = options?.strategy || 'lru';
    this.defaultCooldownMs = options?.defaultCooldownMs || 5 * 60 * 1000;
    this.autoRefreshTokens = options?.autoRefreshTokens ?? true;
  }

  /**
   * 检查切号频率熔断器
   */
  public isCircuitBreakerTripped(): boolean {
    return Date.now() < this.breakerTrippedUntil;
  }

  /**
   * 熔断拦截检测并记录本次切号
   */
  public checkCircuitBreaker(): void {
    const now = Date.now();
    if (now < this.breakerTrippedUntil) {
      const remainSec = Math.ceil((this.breakerTrippedUntil - now) / 1000);
      throw new Error(`[AutoSwitcher] 自动切号频率熔断保护中，防止打爆号池 (剩余冷却 ${remainSec} 秒)`);
    }

    this.switchTimestamps = this.switchTimestamps.filter(t => now - t <= 60_000);
    if (this.switchTimestamps.length >= 5) {
      this.breakerTrippedUntil = now + 120_000; // 熔断 2 分钟
      if (this.usageTracker) {
        this.usageTracker.recordAction({
          type: 'warn',
          accountId: 'system',
          accountName: '调度中枢',
          title: '切号频率熔断触发',
          detail: `60秒内连续切号已达 ${this.switchTimestamps.length} 次，暂停自动切换 2 分钟以防号池连坐`
        });
      }
      this.emit('circuit_breaker', { trippedUntil: this.breakerTrippedUntil, count: this.switchTimestamps.length });
      throw new Error(`[AutoSwitcher] 触发切号频率熔断器：60秒内切号已达 ${this.switchTimestamps.length} 次，暂停自动切号 2 分钟以保护号池`);
    }

    this.switchTimestamps.push(now);
  }

  /**
   * 候选账号轻量探针预检（Tencent API 连通性与 Token 有效性检查）
   */
  public async probeAccount(account: CodeBuddyAccount): Promise<{ valid: boolean; reason?: string }> {
    const url = `${API_ENDPOINTS.CODEBUDDY_CN_BASE}${API_ENDPOINTS.CHECKIN_ACTIVITY_STATUS}`;
    try {
      const res = await httpRequest(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'X-User-Id': account.uid
        },
        timeout: 6000
      });

      if (res.status === 401 || (res.data && res.data.code === 401)) {
        await this.store.updateStatus(account.id, 'expired');
        return { valid: false, reason: '401 Unauthorized (已标记失效)' };
      }
      if (res.status === 429 || (res.data && res.data.code === 429)) {
        await this.store.markRateLimited(account.id, this.defaultCooldownMs);
        return { valid: false, reason: '429 Rate Limited (已进入冷却)' };
      }
      if (res.status === 200 && res.data && res.data.code === 0) {
        return { valid: true };
      }
      return { valid: true, reason: `HTTP ${res.status}` };
    } catch (err: any) {
      // 探针网络波动或超时，保守放行避免误伤
      return { valid: true, reason: 'network_warn' };
    }
  }

  /**
   * 筛选并排序候选账号列表
   */
  public getCandidateAccounts(currentUid?: string): CodeBuddyAccount[] {
    const all = this.store.getAll();
    const now = Date.now();
    const otherLocked = getOtherLockedUids();

    const candidates: CodeBuddyAccount[] = [];
    for (const acc of all) {
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil <= now) {
        acc.status = 'idle';
        delete acc.rateLimitUntil;
        this.store.upsert(acc).catch(() => {});
      }

      if (acc.status === 'disabled' || acc.status === 'expired') {
        continue;
      }
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil > now) {
        continue;
      }
      if (currentUid && (acc.uid === currentUid || acc.id === currentUid)) {
        continue;
      }
      if (otherLocked.has(acc.uid)) {
        continue;
      }

      candidates.push(acc);
    }

    if (this.strategy === 'highest_quota') {
      candidates.sort((a, b) => {
        const aPct = a.activityPackage ? a.activityPackage.percent : (a.totalCredits != null ? -1 : -2);
        const bPct = b.activityPackage ? b.activityPackage.percent : (b.totalCredits != null ? -1 : -2);
        if (bPct !== aPct) return bPct - aPct;
        return (a.lastUsed || 0) - (b.lastUsed || 0);
      });
    } else if (this.strategy === 'health_priority') {
      candidates.sort((a, b) => (b.checkinStreak || 0) - (a.checkinStreak || 0));
    } else if (this.strategy === 'lru') {
      candidates.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    }

    return candidates;
  }

  /**
   * 筛选并获取下一个可用账号 (同步挑选首个)
   */
  public getNextAvailableAccount(currentUid?: string): CodeBuddyAccount | null {
    const cands = this.getCandidateAccounts(currentUid);
    return cands.length > 0 ? cands[0] : null;
  }

  /**
   * 智能预检筛选：通过轻量探针逐个检验候选账号，找到首个真实可用的健康账号
   */
  public async findAndVerifyNextAccount(currentUid?: string): Promise<CodeBuddyAccount | null> {
    const candidates = this.getCandidateAccounts(currentUid);
    for (const cand of candidates) {
      const probe = await this.probeAccount(cand);
      if (probe.valid) {
        return cand;
      }
      console.log(`[AutoSwitcher][Probe] 候选 ${cand.nickname || cand.email} 未通过预检: ${probe.reason}，顺延下一位`);
    }
    return null;
  }

  /**
   * 触发因额度耗尽引起的平滑热切（带熔断保护与候选预检）
   */
  public async handleQuotaExhausted(
    currentUid: string,
    reasonMessage: string = '会话额度已见底'
  ): Promise<SwitchResult> {
    if (this.isRotating) {
      throw new Error('[AutoSwitcher] 调度器正在切号中，请勿重复并发调用');
    }

    // 1. 频率熔断检测
    this.checkCircuitBreaker();
    this.isRotating = true;

    try {
      const current = this.store.get(currentUid);
      if (current) {
        await this.store.updateStatus(current.id, 'idle');
      }

      // 2. 候选探针预检（跳过坏号）
      const next = await this.findAndVerifyNextAccount(currentUid);
      if (!next) {
        throw new Error('[AutoSwitcher] 号池告急：无健康且可用备用账号（其余账号可能已失效或在冷却中）');
      }

      // 3. 执行底层热切
      const res = await this.switcher.switchAccount(next, this.store);

      if (res.success && this.usageTracker) {
        this.usageTracker.recordAction({
          type: 'switch',
          accountId: next.id,
          accountName: next.nickname || next.email,
          title: '自动切号 (额度见底)',
          detail: `原账号 ${current?.nickname || currentUid} 额度见底，已平滑热切至 ${next.nickname || next.email}`
        });
      }

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
   * 触发因 429 速率限制引起的自动轮换（带熔断保护与候选预检）
   */
  public async handleRateLimit429(
    currentUid: string,
    cooldownMs?: number,
    reasonMessage: string = '触发上游 429 Too Many Requests'
  ): Promise<SwitchResult> {
    if (this.isRotating) {
      throw new Error('[AutoSwitcher] 调度器正在切号中，请勿重复并发调用');
    }

    // 1. 频率熔断检测
    this.checkCircuitBreaker();
    this.isRotating = true;

    try {
      const cooldown = cooldownMs || this.defaultCooldownMs;
      await this.store.markRateLimited(currentUid, cooldown);

      // 2. 候选探针预检
      const next = await this.findAndVerifyNextAccount(currentUid);
      if (!next) {
        throw new Error(`[AutoSwitcher] 当前账号触发 429，且号池无其它就绪账号可供轮换 (冷却 ${cooldown / 1000}秒)`);
      }

      // 3. 执行底层热切
      const res = await this.switcher.switchAccount(next, this.store);

      const current = this.store.get(currentUid);
      if (res.success && this.usageTracker) {
        this.usageTracker.recordAction({
          type: 'switch',
          accountId: next.id,
          accountName: next.nickname || next.email,
          title: '自动切号 (429 限流轮换)',
          detail: `原账号 ${current?.nickname || currentUid} 触发 429，已切换至 ${next.nickname || next.email}`
        });
      }

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
    try {
      const vscode = await import('vscode');
      const on429 = vscode.workspace.getConfiguration('buddyRelay').get<boolean>('autoSwitch.on429', true);
      if (!on429) {
        return null;
      }
    } catch (_) {}
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
