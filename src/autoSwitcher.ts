import { EventEmitter } from 'events';
import type * as vscode from 'vscode';
import { CodeBuddyAccount, AccountStore, resolveAccountDisplayName } from './accountStore';
import { SeamlessSwitcher, SwitchResult } from './seamlessSwitcher';
import { OAuthService } from './oauthService';
import { httpRequest } from './httpClient';
import { getOtherLockedUids } from './accountLock';
import { API_ENDPOINTS } from './constants';
import { UsageTracker } from './usageTracker';
import { t } from './i18n';
import { isCnAccount } from './domain';

export type RotationStrategy = 'highest_quota' | 'lru' | 'round_robin' | 'health_priority';

const VALID_STRATEGIES = new Set<RotationStrategy>(['highest_quota', 'lru', 'round_robin', 'health_priority']);

function getVscodeSafe(): typeof vscode | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('vscode') as typeof vscode;
  } catch {
    return undefined;
  }
}

function combinedQuotaPercent(acc: CodeBuddyAccount): number | null {
  const base = acc.basePackage;
  const act = acc.activityPackage;
  if (base && act) {
    const total = (base.total || 0) + (act.total || 0);
    if (total > 0) {
      return Math.max(0, Math.min(100, ((base.remain || 0) + (act.remain || 0)) / total * 100));
    }
  }
  if (act && act.total > 0) {
    return act.percent ?? Math.max(0, Math.min(100, (act.remain || 0) / act.total * 100));
  }
  return null;
}

export interface RotationEvent {
  fromUid: string;
  toUid: string;
  targetAccount: CodeBuddyAccount;
  reason: 'quota_exhausted' | 'rate_limited_429' | 'token_expired' | 'manual';
  timestamp: number;
}

export interface AutoSwitcherOptions {
  strategy?: RotationStrategy;
  defaultCooldownMs?: number;
  autoRefreshTokens?: boolean;
  usageTracker?: UsageTracker;
}

/**
 * 额度见底 / 429 速率限制自动轮换调度器
 */
export class AutoSwitcher extends EventEmitter {
  private store: AccountStore;
  private switcher: SeamlessSwitcher;
  private oauthService: OAuthService;
  private usageTracker?: UsageTracker;
  private lockedStrategy?: RotationStrategy;
  private _lastRoundRobinId: string | null = null;
  private defaultCooldownMs: number;
  private autoRefreshTokens: boolean;
  private monitorTimer: NodeJS.Timeout | null = null;
  private quotaGuardTimer: NodeJS.Timeout | null = null;
  private isRotating: boolean = false;
  private lastAutoSwitchAt: number = 0;
  private getConfig: (() => { enabled: boolean; thresholdPercent: number; cooldownMinutes: number } | null) | null = null;
  private tokenRefreshLeaderCheck: (() => boolean) | null = null;

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
    this.lockedStrategy = options?.strategy;
    this.defaultCooldownMs = options?.defaultCooldownMs || 5 * 60 * 1000;
    this.autoRefreshTokens = options?.autoRefreshTokens ?? true;
  }

  /** 显式设定或解除策略锁定；传 undefined 恢复跟随设置 */
  public setStrategy(strategy?: RotationStrategy): void {
    this.lockedStrategy = strategy;
  }

  /** 获取当前生效的轮换策略（显式锁定优先，否则实时读配置，默认 highest_quota） */
  public getEffectiveStrategy(): RotationStrategy {
    if (this.lockedStrategy && VALID_STRATEGIES.has(this.lockedStrategy)) {
      return this.lockedStrategy;
    }
    const vs = getVscodeSafe();
    if (vs) {
      const configured = vs.workspace
        .getConfiguration('buddyRelay')
        .get<RotationStrategy>('autoSwitch.strategy', 'highest_quota');
      if (configured && VALID_STRATEGIES.has(configured)) {
        return configured;
      }
    }
    return 'highest_quota';
  }

  /** 设置多窗口 Token 全局刷新 Leader 检查回调 */
  public setTokenRefreshLeaderCheck(check: (() => boolean) | null): void {
    this.tokenRefreshLeaderCheck = check;
  }

  public isCircuitBreakerTripped(): boolean {
    return Date.now() < this.breakerTrippedUntil;
  }

  public checkCircuitBreaker(): void {
    const now = Date.now();
    if (now < this.breakerTrippedUntil) {
      const remainSec = Math.ceil((this.breakerTrippedUntil - now) / 1000);
      throw new Error(`[AutoSwitcher] ${t('act.breakerTripped')} (剩余冷却 ${remainSec} 秒)`);
    }

    this.switchTimestamps = this.switchTimestamps.filter(ts => now - ts <= 60_000);
    if (this.switchTimestamps.length >= 5) {
      this.breakerTrippedUntil = now + 120_000;
      if (this.usageTracker) {
        this.usageTracker.recordAction({
          type: 'warn',
          accountId: 'system',
          accountName: t('act.scheduler'),
          title: t('act.breakerTripped'),
          detail: t('act.breakerDetail', this.switchTimestamps.length)
        });
      }
      this.emit('circuit_breaker', { trippedUntil: this.breakerTrippedUntil, count: this.switchTimestamps.length });
      throw new Error(`[AutoSwitcher] 触发切号频率熔断器：60秒内切号已达 ${this.switchTimestamps.length} 次，暂停自动切号 2 分钟以保护号池`);
    }

    this.switchTimestamps.push(now);
  }

  /** 候选账号轻量探针预检（国际版 codebuddy.ai 不走国内接口，不误判 401） */
  public async probeAccount(account: CodeBuddyAccount): Promise<{ valid: boolean; reason?: string }> {
    if (!isCnAccount(account.domain)) {
      return { valid: true, reason: 'intl_skip_probe' };
    }
    const url = `${API_ENDPOINTS.CODEBUDDY_CN_BASE}${API_ENDPOINTS.CHECKIN_ACTIVITY_STATUS}`;
    try {
      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${account.accessToken}`,
          'X-User-Id': account.uid,
          'Content-Type': 'application/json'
        },
        body: {},
        timeout: 6000
      });
      if (res.status === 401 || res.data?.code === 401) {
        await this.store.updateStatus(account.id, 'expired');
        return { valid: false, reason: t('err.probeUnauthorized') };
      }
      if (res.status === 429 || res.data?.code === 429) {
        await this.store.markRateLimited(account.id, this.defaultCooldownMs);
        return { valid: false, reason: t('err.probeRateLimited') };
      }
      if (res.status === 200 && res.data?.code === 0) {
        return { valid: true };
      }
      return { valid: true, reason: `HTTP ${res.status}` };
    } catch {
      return { valid: true, reason: 'network_warn' };
    }
  }

  private sortCandidates(
    candidates: CodeBuddyAccount[],
    all: CodeBuddyAccount[],
    anchorUid?: string
  ): void {
    const strategy = this.getEffectiveStrategy();
    if (strategy === 'highest_quota') {
      candidates.sort((a, b) => {
        const aPct = combinedQuotaPercent(a) ?? (a.totalCredits != null ? -1 : -2);
        const bPct = combinedQuotaPercent(b) ?? (b.totalCredits != null ? -1 : -2);
        return bPct !== aPct ? bPct - aPct : (a.lastUsed || 0) - (b.lastUsed || 0);
      });
      return;
    }
    if (strategy === 'health_priority') {
      candidates.sort((a, b) => {
        const streakDiff = (b.checkinStreak || 0) - (a.checkinStreak || 0);
        if (streakDiff !== 0) return streakDiff;
        const aPct = combinedQuotaPercent(a) ?? -1;
        const bPct = combinedQuotaPercent(b) ?? -1;
        return bPct !== aPct ? bPct - aPct : (a.lastUsed || 0) - (b.lastUsed || 0);
      });
      return;
    }
    if (strategy === 'round_robin') {
      const byStableOrder = (a: CodeBuddyAccount, b: CodeBuddyAccount) =>
        (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id);
      candidates.sort(byStableOrder);
      if (candidates.length <= 1) return;
      const anchor = this._lastRoundRobinId || anchorUid;
      if (!anchor) return;

      const candIdx = candidates.findIndex(c => c.id === anchor || c.uid === anchor);
      if (candIdx >= 0) {
        candidates.splice(0, candidates.length, ...candidates.slice(candIdx + 1), ...candidates.slice(0, candIdx + 1));
        return;
      }
      const orderedAll = [...all].sort(byStableOrder);
      const anchorIdx = orderedAll.findIndex(c => c.id === anchor || c.uid === anchor);
      if (anchorIdx >= 0) {
        const rank = new Map<string, number>();
        orderedAll.forEach((item, idx) => {
          rank.set(item.id, idx > anchorIdx ? idx - anchorIdx : orderedAll.length + idx - anchorIdx);
        });
        candidates.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      }
      return;
    }
    candidates.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  }

  public getCandidateAccounts(currentUid?: string): CodeBuddyAccount[] {
    const all = this.store.getAll();
    const now = Date.now();
    const otherLocked = getOtherLockedUids();
    const activeId = this.store.getActive()?.id;
    const candidates: CodeBuddyAccount[] = [];

    for (const acc of all) {
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil <= now) {
        acc.status = activeId === acc.id ? 'active' : 'idle';
        delete acc.rateLimitUntil;
        this.store.clearRateLimit(acc.id).catch(() => {});
      }
      if (acc.status === 'disabled' || acc.status === 'expired') continue;
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil > now) continue;
      if (currentUid && (acc.uid === currentUid || acc.id === currentUid)) continue;
      if (otherLocked.has(acc.uid)) continue;
      candidates.push(acc);
    }

    this.sortCandidates(candidates, all, currentUid || activeId);
    return candidates;
  }

  public getNextAvailableAccount(currentUid?: string): CodeBuddyAccount | null {
    const cands = this.getCandidateAccounts(currentUid);
    return cands.length > 0 ? cands[0] : null;
  }

  public async findAndVerifyNextAccount(currentUid?: string): Promise<CodeBuddyAccount | null> {
    const candidates = this.getCandidateAccounts(currentUid);
    for (const cand of candidates) {
      const probe = await this.probeAccount(cand);
      if (probe.valid) return cand;
      console.log(`[AutoSwitcher][Probe] 候选 ${resolveAccountDisplayName(cand)} 未通过预检: ${probe.reason}，顺延下一位`);
    }
    return null;
  }

  private recordAndEmitSwitchResult(
    fromUid: string,
    next: CodeBuddyAccount,
    reason: RotationEvent['reason'],
    res: SwitchResult
  ): void {
    const baseEv = { fromUid, toUid: next.uid, targetAccount: next, reason, timestamp: Date.now() };
    if (res.needsElevation) {
      this.emit('needs_elevation', { ...baseEv, res });
      return;
    }
    if (res.needsFullRestart) {
      this.emit('needs_restart', { ...baseEv, res });
      return;
    }
    if (res.success) {
      this._lastRoundRobinId = next.id;
      if (this.usageTracker) {
        const current = this.store.get(fromUid) || this.store.find(fromUid);
        const fromLabel = current ? resolveAccountDisplayName(current) : fromUid;
        const toLabel = resolveAccountDisplayName(next);
        const is429 = reason === 'rate_limited_429';
        this.usageTracker.recordAction({
          type: 'switch',
          accountId: next.id,
          accountName: toLabel,
          title: is429 ? t('act.autoSwitch429') : t('act.autoSwitchQuota'),
          detail: is429
            ? t('act.autoSwitch429Detail', fromLabel, toLabel)
            : t('act.autoSwitchQuotaDetail', fromLabel, toLabel)
        });
      }
      this.emit('rotation', baseEv as RotationEvent);
      return;
    }
    this.emit('rotation_failed', { ...baseEv, res });
  }

  private async executeRotation(
    currentUid: string,
    reason: 'quota_exhausted' | 'rate_limited_429',
    emptyMsg: string,
    beforePick?: () => Promise<void>
  ): Promise<SwitchResult> {
    if (this.isRotating) {
      throw new Error(t('err.concurrentSwitch'));
    }
    this.checkCircuitBreaker();
    this.isRotating = true;
    try {
      if (beforePick) await beforePick();
      const next = await this.findAndVerifyNextAccount(currentUid);
      if (!next) {
        throw new Error(emptyMsg);
      }
      const res = await this.switcher.switchAccount(next, this.store);
      this.recordAndEmitSwitchResult(currentUid, next, reason, res);
      return res;
    } finally {
      this.isRotating = false;
    }
  }

  public async handleQuotaExhausted(
    currentUid: string,
    _reasonMessage: string = t('err.quotaExhausted')
  ): Promise<SwitchResult> {
    return this.executeRotation(currentUid, 'quota_exhausted', t('err.noHealthyBackup'));
  }

  public async handleRateLimit429(
    currentUid: string,
    cooldownMs?: number,
    _reasonMessage: string = t('err.upstream429')
  ): Promise<SwitchResult> {
    const cooldown = cooldownMs || this.defaultCooldownMs;
    return this.executeRotation(
      currentUid,
      'rate_limited_429',
      t('err.noBackupOn429', Math.round(cooldown / 1000)),
      () => this.store.markRateLimited(currentUid, cooldown)
    );
  }

  /** 响应宿主日志被动捕获的 6004 限流事件（校验开关、活跃账号与防抖冷却） */
  public async handlePassiveRateLimit(uid: string, model: string, resetAt: number): Promise<void> {
    const vs = getVscodeSafe();
    let enabled = true;
    let on429 = true;
    let cooldownMinutes = 5;
    if (vs) {
      const cfg = vs.workspace.getConfiguration('buddyRelay');
      enabled = cfg.get<boolean>('autoSwitch.enabled', true);
      on429 = cfg.get<boolean>('autoSwitch.on429', true);
      cooldownMinutes = Math.max(1, cfg.get<number>('autoSwitch.cooldownMinutes', 5));
    }
    if (!enabled || !on429) return;

    const active = this.store.getActive();
    if (!active || active.uid !== uid) return;
    if (this.lastAutoSwitchAt && Date.now() - this.lastAutoSwitchAt < cooldownMinutes * 60_000) return;
    if (this.isRotating || this.isCircuitBreakerTripped()) return;

    if (this.usageTracker) {
      this.usageTracker.recordAction({
        type: 'warn',
        accountId: active.id,
        accountName: resolveAccountDisplayName(active),
        title: t('act.autoSwitch429'),
        detail: `${model || 'unknown'} (${t('status.rateLimited')})`
      });
    }

    try {
      const res = await this.handleRateLimit429(uid, Math.max(60_000, resetAt - Date.now()), model);
      if (res.success && !res.needsElevation && !res.needsFullRestart) {
        this.lastAutoSwitchAt = Date.now();
      }
    } catch (err: any) {
      console.warn(`[AutoSwitcher][429] 被动限流自动切换失败: ${err?.message || err}`);
    }
  }

  public startMonitor(intervalMs: number = 60 * 1000): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(async () => {
      try {
        await this.runHealthCycle();
      } catch {
        // 监控异常静默防护
      }
    }, intervalMs);
  }

  public stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.stopQuotaGuard();
  }

  public startQuotaGuard(getConfig: () => { enabled: boolean; thresholdPercent: number; cooldownMinutes: number } | null): void {
    if (this.quotaGuardTimer) return;
    this.getConfig = getConfig;

    this.quotaGuardTimer = setInterval(async () => {
      try {
        const cfg = this.getConfig ? this.getConfig() : null;
        if (!cfg || !cfg.enabled) return;
        if (this.lastAutoSwitchAt && Date.now() - this.lastAutoSwitchAt < cfg.cooldownMinutes * 60 * 1000) return;
        const active = this.store.getActive();
        if (!active || !active.uid) return;
        const pct = combinedQuotaPercent(active);
        if (pct == null || isNaN(pct) || pct > cfg.thresholdPercent) return;

        console.log(
          `[BuddyRelay][QuotaGuard] 账号 ${resolveAccountDisplayName(active)} 剩余 ${pct}% ≤ 阈值 ${cfg.thresholdPercent}%，触发自动无感切换`
        );
        const res = await this.handleQuotaExhausted(active.uid, `剩余算力 ${pct}% 低于阈值 ${cfg.thresholdPercent}%`);
        if (res.success && !res.needsElevation && !res.needsFullRestart) {
          this.lastAutoSwitchAt = Date.now();
        }
      } catch (err: any) {
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

  public async autoSwitchOn429(cooldownMs?: number): Promise<SwitchResult | null> {
    const vs = getVscodeSafe();
    if (vs && !vs.workspace.getConfiguration('buddyRelay').get<boolean>('autoSwitch.on429', true)) {
      return null;
    }
    const active = this.store.getActive();
    if (!active || !active.uid) return null;
    return this.handleRateLimit429(active.uid, cooldownMs);
  }

  public async runHealthCycle(): Promise<{ recoveredCount: number; refreshedCount: number }> {
    const all = this.store.getAll();
    const now = Date.now();
    let recoveredCount = 0;
    let refreshedCount = 0;
    const canRefreshNetwork = !this.tokenRefreshLeaderCheck || this.tokenRefreshLeaderCheck();

    for (const acc of all) {
      if (acc.status === 'rate_limited' && acc.rateLimitUntil && acc.rateLimitUntil <= now) {
        await this.store.clearRateLimit(acc.id);
        recoveredCount++;
      }
      if (canRefreshNetwork && this.autoRefreshTokens && acc.refreshToken && acc.expiresAt) {
        const remainingMs = acc.expiresAt - now;
        if (remainingMs > 0 && remainingMs < 60 * 60 * 1000) {
          try {
            const refreshed = await this.oauthService.refreshAccessToken(acc.refreshToken, acc.domain);
            acc.accessToken = refreshed.accessToken;
            if (refreshed.refreshToken) acc.refreshToken = refreshed.refreshToken;
            acc.expiresAt = now + (refreshed.expiresIn || 7200) * 1000;
            await this.store.upsert(acc);
            refreshedCount++;
          } catch {
            // 刷新失败待下次重试
          }
        }
      }
    }

    return { recoveredCount, refreshedCount };
  }
}
