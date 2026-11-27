import { API_ENDPOINTS, getCodeBuddyBaseUrl } from './constants';
import { httpRequest, HttpCompatResponse } from './httpClient';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { OAuthService } from './oauthService';
import { t } from './i18n';
import {
  buildEnterpriseHeaders,
  EnterpriseIdentity,
  extractEnterpriseInfo,
  isCnAccount,
  isEnterpriseAccount
} from './domain';
import {
  buildEmptyPersonalQuota,
  DetailedQuotaResult,
  parseEnterpriseQuotaPayload,
  parseLegacyUserResourceAccounts,
  parseUserResourceSummary,
  QuotaLabels
} from './quotaParser';

export type { DetailedQuotaResult } from './quotaParser';

/**
 * 北京时间 (UTC+8) 的今日日期 YYYY-MM-DD。
 * 签到是国内 (codebuddy.cn) 活动，服务端按北京日期判定"今日"。
 */
export function todayCN(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * "今日已签"唯一权威口径：布尔值必须配合 lastCheckinDate 是北京今日才可信。
 */
export function isTodayCheckedIn(acc: {
  todayCheckedIn?: boolean;
  lastCheckinDate?: string;
}): boolean {
  return Boolean(acc.todayCheckedIn) && acc.lastCheckinDate === todayCN();
}

function resolveDomainHost(domain?: string, fallbackBase?: string): string {
  const d = String(domain || '').trim();
  if (d && d !== 'cn' && d !== 'intl' && !/^https?:\/\//i.test(d)) return d;
  if (/^https?:\/\//i.test(d)) {
    try { return new URL(d).hostname; } catch { /* ignore */ }
  }
  try { return new URL(fallbackBase || API_ENDPOINTS.CODEBUDDY_CN_BASE).hostname; } catch { return 'www.codebuddy.cn'; }
}

function isExplicitPersonalAccount(account: CodeBuddyAccount): boolean {
  if (extractEnterpriseInfo(account).enterpriseId) return false;
  const t1 = String(account.accountType || '').trim().toLowerCase();
  const t2 = String(account.profileRaw?.type || account.profileRaw?.accountType || '').trim().toLowerCase();
  return t1 === 'personal' || t2 === 'personal';
}

function isUnauthorizedResponse(res: HttpCompatResponse<any>): boolean {
  if (res.status === 401) return true;
  const code = res.data?.code;
  if (code === 401 || code === 10002) return true;
  const msg = String(res.data?.msg || res.data?.message || '');
  return /unauthorized|token.*expir|invalid.*token|not.*login|login.*expir/i.test(msg);
}

export interface CheckinStatusResult {
  active: boolean;
  todayCheckedIn: boolean;
  streakDays: number;
  dailyCredit: number;
  todayCredit: number;
  totalCredits: number;
  lastCheckinDate?: string;
  themeName?: string;
  raw?: any;
}

export interface CheckinExecutionResult {
  accountId: string;
  email: string;
  uid: string;
  success: boolean;
  alreadyCheckedIn: boolean;
  creditAwarded: number;
  streakDays: number;
  message: string;
  error?: string;
  raw?: any;
}

export interface BatchCheckinReport {
  total: number;
  successCount: number;
  alreadyCheckedInCount: number;
  failedCount: number;
  totalCreditsAwarded: number;
  results: CheckinExecutionResult[];
}

export interface BatchSyncReport {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  errors: string[];
}

interface QuotaQueryOutcome {
  quota: DetailedQuotaResult | null;
  unauthorized: boolean;
  error?: string;
}

/**
 * CodeBuddy 每日签到与配额对账服务
 * - 个人额度优先使用 CodeBuddy 5.0.0 聚合接口 /billing/meter/get-user-resource-summary，旧接口 /v2/billing/meter/get-user-resource 兜底
 * - 企业额度走 /v2/billing/meter/get-enterprise-user-usage
 * - 令牌过期或遇 401 时自动经 refreshToken 续期重试，避免个人号闲置后刷新死锁
 */
export class CheckinService {
  private baseUrl: string;
  private oauthService?: OAuthService;

  constructor(baseUrl: string = API_ENDPOINTS.CODEBUDDY_CN_BASE, oauthService?: OAuthService) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.oauthService = oauthService;
  }

  private getOAuthService(): OAuthService {
    if (!this.oauthService) {
      this.oauthService = new OAuthService(
        this.baseUrl !== API_ENDPOINTS.CODEBUDDY_CN_BASE ? this.baseUrl : undefined
      );
    }
    return this.oauthService;
  }

  private resolveEndpointBase(domain?: string): string {
    if (this.baseUrl !== API_ENDPOINTS.CODEBUDDY_CN_BASE) {
      return this.baseUrl;
    }
    return getCodeBuddyBaseUrl(domain).replace(/\/+$/, '');
  }

  private getQuotaLabels(): QuotaLabels {
    return {
      base: t('pkg.base'),
      activity: t('pkg.activity'),
      enterprise: t('pkg.enterpriseQuota')
    };
  }

  /**
   * 尝试使用 refreshToken 续期并写回 Store；若原状态为 expired 则自动恢复为 idle（不覆写并发切换后的 active）。
   */
  public async tryRefreshAccountToken(
    account: CodeBuddyAccount,
    store?: AccountStore
  ): Promise<CodeBuddyAccount | null> {
    if (!account.refreshToken) return null;
    try {
      const domainArg = this.baseUrl !== API_ENDPOINTS.CODEBUDDY_CN_BASE ? this.baseUrl : account.domain;
      const entId = extractEnterpriseInfo(account).enterpriseId || undefined;
      const refreshed = await this.getOAuthService().refreshAccessToken(account.refreshToken, domainArg, entId);
      if (!refreshed?.accessToken) return null;
      const nextExpiresAt = Date.now() + (refreshed.expiresIn || 7200) * 1000;
      const tokenPatch: Partial<Omit<CodeBuddyAccount, 'id'>> = {
        accessToken: refreshed.accessToken,
        ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
        expiresAt: nextExpiresAt
      };
      const updated: CodeBuddyAccount = {
        ...account,
        ...tokenPatch,
        status: account.status === 'expired' ? 'idle' : account.status
      };
      if (store) {
        const latest = typeof store.get === 'function' ? store.get(account.id) : undefined;
        if (latest?.status === 'expired' && typeof store.updateStatus === 'function') {
          await store.updateStatus(account.id, 'idle', tokenPatch);
        } else {
          await this.persistCheckedFields(store, account, tokenPatch);
        }
      }
      return updated;
    } catch {
      return null;
    }
  }

  /**
   * 1.0a 从 /v2/plugin/accounts 探测历史存量账号绑定的企业租户身份。
   * 严格防护：显式个人号或同 UID 在列表中存在个人条目时绝不误判为企业号。
   */
  public async discoverEnterpriseIdentity(account: CodeBuddyAccount): Promise<EnterpriseIdentity | null> {
    if (!account.accessToken || isExplicitPersonalAccount(account)) return null;
    const base = this.resolveEndpointBase(account.domain);
    const url = base + API_ENDPOINTS.OAUTH_ACCOUNTS;
    try {
      const res = await httpRequest<{ code: number; data?: { accounts?: Array<Record<string, any>> } }>(url, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + account.accessToken,
          'X-Domain': resolveDomainHost(account.domain, base),
          ...buildEnterpriseHeaders(account)
        },
        timeout: 8000
      });
      const list = res.status === 200 && res.data?.code === 0 ? res.data?.data?.accounts : null;
      if (!Array.isArray(list) || list.length === 0) return null;

      const hasPersonalSameUid = list.some(
        (a) => a && String(a.uid || '') === account.uid && !a.enterpriseId
      );
      if (hasPersonalSameUid) return null;

      const byUid = list.find((a) => a && String(a.uid || '') === account.uid && a.enterpriseId);
      const hasAnyPersonal = list.some((a) => a && !a.enterpriseId);
      const entOnly = list.filter((a) => a && a.enterpriseId && a.pluginEnabled !== false);
      const picked = byUid || (!hasAnyPersonal && entOnly.length === 1 ? entOnly[0] : null);
      if (!picked || !picked.enterpriseId) return null;

      return {
        enterpriseId: String(picked.enterpriseId).trim(),
        enterpriseName: String(picked.enterpriseName || picked.enterprise_name || '').trim(),
        accountType: String(picked.type || picked.accountType || '').trim()
      };
    } catch {
      return null;
    }
  }

  private async queryEnterpriseQuotaWithState(
    account: CodeBuddyAccount,
    ent: EnterpriseIdentity
  ): Promise<QuotaQueryOutcome> {
    if (!account.accessToken || !account.uid || !ent.enterpriseId) {
      return { quota: null, unauthorized: false, error: t('err.ciNoToken', account.email) };
    }
    const base = this.resolveEndpointBase(account.domain);
    const url = base + API_ENDPOINTS.ENTERPRISE_USER_USAGE;
    try {
      const res = await httpRequest<any>(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + account.accessToken,
          'X-User-Id': account.uid,
          ...buildEnterpriseHeaders(ent.enterpriseId),
          'X-Domain': resolveDomainHost(account.domain, base),
          'Content-Type': 'application/json'
        },
        body: {},
        timeout: 10000,
        retries: 2
      });
      if (isUnauthorizedResponse(res)) {
        return { quota: null, unauthorized: true, error: res.data?.msg || `HTTP ${res.status}` };
      }
      if (res.status !== 200 || !res.data || (res.data.code !== undefined && res.data.code !== 0)) {
        return { quota: null, unauthorized: false, error: res.data?.msg || `HTTP ${res.status}` };
      }
      const raw = res.data?.data?.data || res.data?.data || res.data;
      const parsed = parseEnterpriseQuotaPayload(raw, ent, this.getQuotaLabels());
      return { quota: parsed, unauthorized: false, error: parsed ? undefined : 'invalid enterprise quota payload' };
    } catch (err: any) {
      return { quota: null, unauthorized: false, error: err?.message || String(err) };
    }
  }

  /**
   * 1.0b 查询企业版周期额度 (/v2/billing/meter/get-enterprise-user-usage)
   */
  public async queryEnterpriseRemainingQuota(
    account: CodeBuddyAccount,
    ent: EnterpriseIdentity
  ): Promise<DetailedQuotaResult | null> {
    const out = await this.queryEnterpriseQuotaWithState(account, ent);
    return out.quota;
  }

  private async queryQuotaWithState(account: CodeBuddyAccount): Promise<QuotaQueryOutcome> {
    if (!account.accessToken || !account.uid) {
      return { quota: null, unauthorized: false, error: t('err.ciNoToken', account.email) };
    }

    const existingEnt = extractEnterpriseInfo(account);
    if (existingEnt.enterpriseId) {
      return await this.queryEnterpriseQuotaWithState(account, existingEnt);
    }

    const base = this.resolveEndpointBase(account.domain);
    const labels = this.getQuotaLabels();
    const headers: Record<string, string> = {
      'Authorization': 'Bearer ' + account.accessToken,
      'X-User-Id': account.uid,
      'X-Domain': resolveDomainHost(account.domain, base),
      'Content-Type': 'application/json'
    };

    let emptyPersonalQuota: DetailedQuotaResult | null = null;
    let lastError: string | undefined;

    // 通道 1（首选）：CodeBuddy 5.0.0 官方聚合接口（国内/国际、付费/免费全覆盖，无分页截断）
    try {
      const res = await httpRequest<any>(base + API_ENDPOINTS.USER_RESOURCE_SUMMARY, {
        method: 'POST',
        headers,
        body: {},
        timeout: 10000,
        retries: 2
      });
      if (isUnauthorizedResponse(res)) {
        return { quota: null, unauthorized: true, error: res.data?.msg || `HTTP ${res.status}` };
      }
      if (res.status === 200 && res.data?.code === 0 && res.data?.data) {
        const parsed = parseUserResourceSummary(res.data.data, labels);
        if (parsed) {
          if (!parsed.empty) return { quota: parsed.quota, unauthorized: false };
          emptyPersonalQuota = parsed.quota;
        }
      } else if (res.status !== 404) {
        lastError = res.data?.msg || `HTTP ${res.status}`;
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    }

    // 通道 2（兼容兜底）：旧分页接口 /v2/billing/meter/get-user-resource
    try {
      const res = await httpRequest<any>(base + API_ENDPOINTS.USER_RESOURCE, {
        method: 'POST',
        headers,
        body: { PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] },
        timeout: 10000,
        retries: 2
      });
      if (isUnauthorizedResponse(res)) {
        return { quota: null, unauthorized: true, error: res.data?.msg || `HTTP ${res.status}` };
      }
      if (res.status === 200 && res.data?.code === 0) {
        const pkgs = res.data?.data?.Response?.Data?.Accounts || [];
        const parsed = parseLegacyUserResourceAccounts(pkgs, labels);
        if (parsed) return { quota: parsed, unauthorized: false };
        if (!emptyPersonalQuota) emptyPersonalQuota = buildEmptyPersonalQuota(labels, 0);
      } else {
        lastError = res.data?.msg || `HTTP ${res.status}`;
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
    }

    // 通道 3：历史无 enterpriseId 存量企业号回溯探测（显式个人号自动跳过，防串企）
    const discovered = await this.discoverEnterpriseIdentity(account);
    if (discovered?.enterpriseId) {
      return await this.queryEnterpriseQuotaWithState(account, discovered);
    }

    // 通道 4：官方接口确认有效但当前 0 资源包的个人号，如实返回 0 额度
    if (emptyPersonalQuota) {
      return { quota: emptyPersonalQuota, unauthorized: false };
    }
    return { quota: null, unauthorized: false, error: lastError };
  }

  /**
   * 1.0 查询账号真实可用算力点数
   */
  public async queryRealRemainingQuota(account: CodeBuddyAccount): Promise<DetailedQuotaResult | null> {
    const out = await this.queryQuotaWithState(account);
    return out.quota;
  }

  public async queryStatus(account: CodeBuddyAccount): Promise<CheckinStatusResult> {
    if (!account.accessToken) {
      throw new Error(t('err.ciNoToken', account.email));
    }

    const base = this.resolveEndpointBase(account.domain);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${account.accessToken}`,
      'X-Domain': resolveDomainHost(account.domain, base),
      'Content-Type': 'application/json',
      ...buildEnterpriseHeaders(account)
    };
    if (account.uid) {
      headers['X-User-Id'] = account.uid;
    }

    let rawData: any = null;
    let sawUnauthorized = false;

    // 首选官方 Buddy 加油站最新活动接口
    try {
      const primaryUrl = `${base}${API_ENDPOINTS.CHECKIN_ACTIVITY_STATUS}`;
      const res = await httpRequest<{ code: number; msg: string; data?: Record<string, any> }>(primaryUrl, {
        method: 'POST',
        headers,
        body: {},
        timeout: 10000,
        retries: 2
      });
      if (isUnauthorizedResponse(res)) sawUnauthorized = true;
      if (res.status === 200 && res.data && res.data.code === 0 && res.data.data) {
        rawData = res.data.data;
      }
    } catch (_) {
      // 失败降级到 legacy 接口
    }

    // 降级回退到 legacy 签到状态接口
    if (!rawData && !sawUnauthorized) {
      try {
        const fallbackUrl = `${base}${API_ENDPOINTS.CHECKIN_STATUS_LEGACY}`;
        const res = await httpRequest<{ code: number; msg: string; data?: Record<string, any> }>(fallbackUrl, {
          method: 'POST',
          headers,
          body: {},
          timeout: 10000,
          retries: 2
        });
        if (isUnauthorizedResponse(res)) sawUnauthorized = true;
        if (res.status === 200 && res.data && res.data.code === 0 && res.data.data) {
          rawData = res.data.data;
        }
      } catch (err: any) {
        throw new Error(t('err.statusQueryFailed', err.message));
      }
    }

    if (sawUnauthorized) {
      const authErr: any = new Error(t('err.tokenExpiredReauth'));
      authErr.unauthorized = true;
      throw authErr;
    }

    if (!rawData) {
      throw new Error(t('err.statusUnavailable'));
    }

    const todayCheckedIn = Boolean(rawData.today_checked_in ?? rawData.todayCheckedIn);
    const streakDays = rawData.streak_days ?? rawData.streakDays ?? 0;
    const dailyCredit = rawData.daily_credit ?? rawData.dailyCredit ?? 100;
    const todayCredit = rawData.today_credit ?? rawData.todayCredit ?? (todayCheckedIn ? dailyCredit : 0);
    const totalCredits = rawData.total_credits ?? rawData.totalCredits ?? 0;

    let lastCheckinDate: string | undefined;
    if (Array.isArray(rawData.checkin_dates) && rawData.checkin_dates.length > 0) {
      lastCheckinDate = rawData.checkin_dates[0];
    } else if (todayCheckedIn) {
      lastCheckinDate = todayCN();
    }

    return {
      active: Boolean(rawData.active ?? true),
      todayCheckedIn,
      streakDays,
      dailyCredit,
      todayCredit,
      totalCredits,
      lastCheckinDate,
      themeName: rawData.theme_name || t('ci.activityName'),
      raw: rawData
    };
  }

  /**
   * 2. 执行单次签到领算力
   */
  public async executeDailyCheckin(account: CodeBuddyAccount): Promise<CheckinExecutionResult> {
    const resBase: CheckinExecutionResult = {
      accountId: account.id,
      email: account.email,
      uid: account.uid,
      success: false,
      alreadyCheckedIn: false,
      creditAwarded: 0,
      streakDays: account.checkinStreak || 0,
      message: ''
    };

    if (!account.accessToken) {
      resBase.error = t('err.ciNoToken', account.email);
      resBase.message = t('err.checkinNoCred');
      return resBase;
    }

    const base = this.resolveEndpointBase(account.domain);
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${account.accessToken}`,
      'X-Domain': resolveDomainHost(account.domain, base),
      'Content-Type': 'application/json',
      ...buildEnterpriseHeaders(account)
    };
    if (account.uid) {
      headers['X-User-Id'] = account.uid;
    }

    const checkinUrl = `${base}${API_ENDPOINTS.DAILY_CHECKIN}`;

    try {
      const res = await httpRequest<{ code: number; msg: string; data?: Record<string, any> }>(checkinUrl, {
        method: 'POST',
        headers,
        body: {},
        timeout: 10000
      });

      if (res.status === 200 && res.data && res.data.code === 0) {
        const d = res.data.data || {};
        const credit = d.today_credit ?? d.reward ?? 100;
        const streak = d.streak_days ?? d.streakDays ?? (account.checkinStreak || 0) + 1;

        resBase.success = true;
        resBase.creditAwarded = credit;
        resBase.streakDays = streak;
        resBase.message = t('ci.checkinOk', credit, streak);
        resBase.raw = d;
        return resBase;
      }

      const errMsg = res.data?.msg || `HTTP ${res.status}`;
      if (
        errMsg.includes('已签到') ||
        errMsg.includes('已领取') ||
        errMsg.includes('repeat') ||
        errMsg.includes('already')
      ) {
        resBase.success = true;
        resBase.alreadyCheckedIn = true;
        resBase.message = t('ci.alreadyChecked', errMsg);
        return resBase;
      }

      resBase.error = errMsg;
      resBase.message = t('ci.checkinFailed', errMsg);
      return resBase;
    } catch (err: any) {
      resBase.error = err.message;
      resBase.message = t('ci.checkinError', err.message);
      return resBase;
    }
  }

  private buildQuotaPatch(realQuota: DetailedQuotaResult | null): Partial<CodeBuddyAccount> {
    if (!realQuota) return {};
    return {
      totalCredits: realQuota.quotaUnlimited ? undefined : (realQuota.totalCredits ?? 0),
      quotaUnlimited: Boolean(realQuota.quotaUnlimited),
      ...(realQuota.quotaResetAt !== undefined ? { quotaResetAt: realQuota.quotaResetAt } : {}),
      ...(realQuota.enterpriseId ? { enterpriseId: realQuota.enterpriseId } : {}),
      ...(realQuota.enterpriseName ? { enterpriseName: realQuota.enterpriseName } : {}),
      ...(realQuota.accountType ? { accountType: realQuota.accountType } : {}),
      ...(realQuota.paymentType ? { paymentType: realQuota.paymentType } : {}),
      basePackage: realQuota.basePackage,
      activityPackage: realQuota.activityPackage
    };
  }

  private async persistCheckedFields(
    store: AccountStore,
    account: CodeBuddyAccount,
    fields: Partial<Omit<CodeBuddyAccount, 'id'>>
  ): Promise<void> {
    if (typeof store.updateAccountFields === 'function') {
      await store.updateAccountFields(account.id, fields);
      return;
    }
    const latestStatus = typeof store.get === 'function'
      ? (store.get(account.id)?.status ?? account.status)
      : account.status;
    await store.updateStatus(account.id, latestStatus, fields);
  }

  /**
   * 3. 智能单账号签到：先查后签，同步更新 Store
   */
  public async checkinAccount(
    account: CodeBuddyAccount,
    store?: AccountStore
  ): Promise<CheckinExecutionResult> {
    const resBase: CheckinExecutionResult = {
      accountId: account.id,
      email: account.email,
      uid: account.uid,
      success: false,
      alreadyCheckedIn: false,
      creditAwarded: 0,
      streakDays: account.checkinStreak || 0,
      message: ''
    };

    if (!isCnAccount(account.domain)) {
      resBase.error = t('intl.cnOnlyTitle');
      resBase.message = t('intl.cnOnlyDetail');
      return resBase;
    }

    let workingAcc = account;
    if (workingAcc.expiresAt && workingAcc.expiresAt <= Date.now() + 60_000 && workingAcc.refreshToken) {
      workingAcc = (await this.tryRefreshAccountToken(workingAcc, store)) || workingAcc;
    }

    try {
      const status = await this.queryStatus(workingAcc);

      if (status.todayCheckedIn) {
        const result: CheckinExecutionResult = {
          accountId: workingAcc.id,
          email: workingAcc.email,
          uid: workingAcc.uid,
          success: true,
          alreadyCheckedIn: true,
          creditAwarded: 0,
          streakDays: status.streakDays,
          message: t('ci.syncAlreadyChecked', status.streakDays)
        };

        if (store) {
          const realQuota = await this.queryRealRemainingQuota(workingAcc);
          await this.persistCheckedFields(store, workingAcc, {
            todayCheckedIn: true,
            checkinStreak: status.streakDays,
            ...this.buildQuotaPatch(realQuota),
            lastCheckinDate: status.lastCheckinDate || todayCN(),
            lastCheckinTime: Date.now()
          });
        }
        return result;
      }

      const execResult = await this.executeDailyCheckin(workingAcc);

      if (execResult.success && store) {
        const realQuota = await this.queryRealRemainingQuota(workingAcc);
        await this.persistCheckedFields(store, workingAcc, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays || status.streakDays + 1,
          ...this.buildQuotaPatch(realQuota),
          lastCheckinDate: todayCN(),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    } catch {
      const execResult = await this.executeDailyCheckin(workingAcc);
      if (execResult.success && store) {
        const realQuota = await this.queryRealRemainingQuota(workingAcc);
        await this.persistCheckedFields(store, workingAcc, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays,
          ...this.buildQuotaPatch(realQuota),
          lastCheckinDate: todayCN(),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    }
  }

  /**
   * 4. 同步单个账号状态与额度积分至 Store
   * - 令牌已过期或接口 401 时自动续期重试一次；续期失败则标 expired 并明确报错
   * - 国内/国际个人号与企业号统一查真实额度，个人号拿到额度后不再被签到接口失败阻断
   */
  public async syncAccountStatus(
    account: CodeBuddyAccount,
    store?: AccountStore
  ): Promise<CheckinStatusResult> {
    if (!account.accessToken) {
      throw new Error(t('err.ciNoToken', account.email));
    }

    let workingAcc = account;
    let refreshedInCycle = false;
    if (workingAcc.expiresAt && workingAcc.expiresAt <= Date.now() + 60_000 && workingAcc.refreshToken) {
      const refreshed = await this.tryRefreshAccountToken(workingAcc, store);
      if (refreshed) {
        workingAcc = refreshed;
        refreshedInCycle = true;
      }
    }

    const hasCustomQuotaOverride = this.queryRealRemainingQuota !== CheckinService.prototype.queryRealRemainingQuota;
    let quotaOut: QuotaQueryOutcome = hasCustomQuotaOverride
      ? { quota: await this.queryRealRemainingQuota(workingAcc), unauthorized: false }
      : await this.queryQuotaWithState(workingAcc);

    if (quotaOut.unauthorized && !refreshedInCycle && workingAcc.refreshToken) {
      const refreshed = await this.tryRefreshAccountToken(workingAcc, store);
      if (refreshed) {
        workingAcc = refreshed;
        refreshedInCycle = true;
        quotaOut = await this.queryQuotaWithState(workingAcc);
      }
    }

    if (quotaOut.unauthorized) {
      if (store && typeof store.updateStatus === 'function') {
        await store.updateStatus(account.id, 'expired');
      }
      throw new Error(t('err.tokenExpiredReauth'));
    }

    const realQuota = quotaOut.quota;
    const isEnt = Boolean(realQuota?.isEnterprise || isEnterpriseAccount(workingAcc));
    const isCn = isCnAccount(workingAcc.domain);

    let status: CheckinStatusResult | null = null;
    if (isCn && !isEnt) {
      try {
        status = await this.queryStatus(workingAcc);
      } catch (err: any) {
        if (err?.unauthorized && !refreshedInCycle && workingAcc.refreshToken) {
          const refreshed = await this.tryRefreshAccountToken(workingAcc, store);
          if (refreshed) {
            workingAcc = refreshed;
            refreshedInCycle = true;
            try { status = await this.queryStatus(workingAcc); } catch { /* fall through */ }
          }
        }
        if (!status && !realQuota) {
          if (err?.unauthorized && store && typeof store.updateStatus === 'function') {
            await store.updateStatus(account.id, 'expired');
          }
          throw err;
        }
      }
    } else if (!realQuota) {
      throw new Error(quotaOut.error || t('err.statusUnavailable'));
    }

    const quotaPatch = this.buildQuotaPatch(realQuota);
    const finalCredits = realQuota
      ? (realQuota.totalCredits ?? 0)
      : (typeof workingAcc.totalCredits === 'number' ? workingAcc.totalCredits : 0);

    const effectiveStatus: CheckinStatusResult = status || {
      active: !isEnt,
      todayCheckedIn: Boolean(workingAcc.todayCheckedIn),
      streakDays: workingAcc.checkinStreak || 0,
      dailyCredit: 0,
      todayCredit: 0,
      totalCredits: finalCredits,
      lastCheckinDate: workingAcc.lastCheckinDate
    };

    if (store) {
      const fields: Partial<Omit<CodeBuddyAccount, 'id'>> = {
        ...quotaPatch,
        lastCheckinTime: Date.now(),
        ...(status ? {
          todayCheckedIn: status.todayCheckedIn,
          checkinStreak: status.streakDays,
          lastCheckinDate: status.lastCheckinDate
        } : {})
      };
      await this.persistCheckedFields(store, workingAcc, fields);
    }
    if (!realQuota && quotaOut.error) {
      throw new Error(quotaOut.error);
    }
    return {
      ...effectiveStatus,
      totalCredits: finalCredits
    };
  }

  /**
   * 5a. 批量同步号池状态与额度积分（返回结构化汇总，允许有 refreshToken 的 expired 账号自动续期救活）
   */
  public async batchSyncStatusDetailed(
    accounts: CodeBuddyAccount[],
    store?: AccountStore
  ): Promise<BatchSyncReport> {
    const report: BatchSyncReport = { total: accounts.length, synced: 0, skipped: 0, failed: 0, errors: [] };
    for (const acc of accounts) {
      if (acc.status === 'disabled' || (acc.status === 'expired' && !acc.refreshToken)) {
        report.skipped++;
        continue;
      }
      try {
        await this.syncAccountStatus(acc, store);
        report.synced++;
      } catch (err: any) {
        report.failed++;
        const label = acc.displayName || acc.nickname || acc.email || acc.id;
        report.errors.push(`${label}: ${err?.message || String(err)}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return report;
  }

  /**
   * 5. 批量同步号池状态与额度积分（返回成功数）
   */
  public async batchSyncStatus(
    accounts: CodeBuddyAccount[],
    store?: AccountStore
  ): Promise<number> {
    const report = await this.batchSyncStatusDetailed(accounts, store);
    return report.synced;
  }

  /**
   * 6. 批量为号池中全量账号执行签到
   */
  public async batchCheckin(
    accounts: CodeBuddyAccount[],
    store?: AccountStore
  ): Promise<BatchCheckinReport> {
    const report: BatchCheckinReport = {
      total: accounts.length,
      successCount: 0,
      alreadyCheckedInCount: 0,
      failedCount: 0,
      totalCreditsAwarded: 0,
      results: []
    };

    const cnAccounts = accounts.filter(acc => isCnAccount(acc.domain));
    const intlSkipped = accounts.length - cnAccounts.length;
    if (intlSkipped > 0) {
      for (const acc of accounts) {
        if (!isCnAccount(acc.domain)) {
          report.failedCount++;
          report.results.push({
            accountId: acc.id,
            email: acc.email,
            uid: acc.uid,
            success: false,
            alreadyCheckedIn: false,
            creditAwarded: 0,
            streakDays: acc.checkinStreak || 0,
            message: t('intl.skipIntl')
          });
        }
      }
    }

    for (const acc of cnAccounts) {
      if (acc.status === 'disabled' || (acc.status === 'expired' && !acc.refreshToken)) {
        report.failedCount++;
        report.results.push({
          accountId: acc.id,
          email: acc.email,
          uid: acc.uid,
          success: false,
          alreadyCheckedIn: false,
          creditAwarded: 0,
          streakDays: acc.checkinStreak || 0,
          message: t('ci.skipUnavailable', acc.status)
        });
        continue;
      }
      if (isEnterpriseAccount(acc)) {
        report.alreadyCheckedInCount++;
        report.results.push({
          accountId: acc.id,
          email: acc.email,
          uid: acc.uid,
          success: true,
          alreadyCheckedIn: true,
          creditAwarded: 0,
          streakDays: acc.checkinStreak || 0,
          message: t('ci.skipEnterprise')
        });
        continue;
      }

      const res = await this.checkinAccount(acc, store);
      report.results.push(res);

      if (res.success) {
        if (res.alreadyCheckedIn) {
          report.alreadyCheckedInCount++;
        } else {
          report.successCount++;
          report.totalCreditsAwarded += res.creditAwarded;
        }
      } else {
        report.failedCount++;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    return report;
  }
}
