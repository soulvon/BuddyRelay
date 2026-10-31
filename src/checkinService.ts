import { API_ENDPOINTS } from './constants';
import { httpRequest } from './oauthService';
import { CodeBuddyAccount, AccountStore, QuotaPackageItem } from './accountStore';
import { t } from './i18n';
import { isCnAccount } from './domain';

export interface DetailedQuotaResult {
  totalCredits: number;
  basePackage: QuotaPackageItem;
  activityPackage: QuotaPackageItem;
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

/**
 * CodeBuddy 每日签到与加油站链路服务
 * 深度对齐 Cockpit Tools 与官方 Buddy加油站逻辑 (POST checkin-activity-status + daily-checkin)
 */
export class CheckinService {
  private baseUrl: string;

  constructor(baseUrl: string = API_ENDPOINTS.CODEBUDDY_CN_BASE) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 1. 查询账号签到活动状态
   */
  /**
   * 1.0 查询账号真实可用算力点数 (通过官方 get-user-resource 聚合 CycleCapacityRemainPrecise)
   */
  public async queryRealRemainingQuota(account: CodeBuddyAccount): Promise<DetailedQuotaResult | null> {
    if (!account.accessToken || !account.uid) {
      return null;
    }

    const now = new Date();
    const future = new Date(now.getTime() + 5 * 365 * 24 * 3600 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const fmt = (d: Date) =>
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());

    const headers: Record<string, string> = {
      'Authorization': 'Bearer ' + account.accessToken,
      'X-User-Id': account.uid,
      'Content-Type': 'application/json'
    };

    const url = this.baseUrl + API_ENDPOINTS.USER_RESOURCE;
    const body = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(future)
    };

    try {
      const res = await httpRequest<{
        code: number;
        msg: string;
        data?: {
          Response?: {
            Data?: {
              Accounts?: Array<{
                PackageCode?: string;
                PackageName?: string;
                CycleCapacityRemainPrecise?: string | number;
                CycleCapacitySizePrecise?: string | number;
              }>;
            };
          };
        };
      }>(url, {
        method: 'POST',
        headers,
        body,
        timeout: 10000
      });

      if (res.status === 200 && res.data?.code === 0) {
        const pkgs = res.data?.data?.Response?.Data?.Accounts || [];
        const basePkgs: any[] = [];
        const actPkgs: any[] = [];

        for (const pkg of pkgs) {
          const code = pkg.PackageCode || '';
          const name = pkg.PackageName || '';
          if (
            name.includes('基础') ||
            name.includes('体验') ||
            code === 'TCACA_code_001_PqouKr6QWV' ||
            code === 'TCACA_code_006_DbXS0lrypC' ||
            code === 'TCACA_code_008_cfWoLwvjU4'
          ) {
            basePkgs.push(pkg);
          } else {
            actPkgs.push(pkg);
          }
        }

        const bRemain = basePkgs.reduce((s, p) => s + (parseFloat(String(p.CycleCapacityRemainPrecise || 0)) || 0), 0);
        const bTotal = basePkgs.reduce((s, p) => s + (parseFloat(String(p.CycleCapacitySizePrecise || 0)) || 0), 0);
        const bCount = basePkgs.length || 1;
        const finalBTotal = bTotal > 0 ? bTotal : 500;
        const bPercent = finalBTotal > 0 ? Math.max(0, Math.min(100, (bRemain / finalBTotal) * 100)) : 0;

        const aRemain = actPkgs.reduce((s, p) => s + (parseFloat(String(p.CycleCapacityRemainPrecise || 0)) || 0), 0);
        const aTotal = actPkgs.reduce((s, p) => s + (parseFloat(String(p.CycleCapacitySizePrecise || 0)) || 0), 0);
        const aCount = actPkgs.length;
        const aPercent = aTotal > 0 ? Math.max(0, Math.min(100, (aRemain / aTotal) * 100)) : 0;

        const totalCredits = Math.round((bRemain + aRemain) * 100) / 100;

        return {
          totalCredits,
          basePackage: {
            title: t('pkg.base'),
            count: bCount,
            remain: Math.round(bRemain * 100) / 100,
            total: Math.round(finalBTotal * 100) / 100,
            percent: Math.round(bPercent * 10) / 10
          },
          activityPackage: {
            title: t('pkg.activity'),
            count: aCount,
            remain: Math.round(aRemain * 100) / 100,
            total: Math.round(aTotal * 100) / 100,
            percent: Math.round(aPercent * 10) / 10
          }
        };
      }
    } catch (_) {
      // 容错返回 null
    }

    return null;
  }

  public async queryStatus(account: CodeBuddyAccount): Promise<CheckinStatusResult> {
    if (!account.accessToken) {
      throw new Error(t('err.ciNoToken', account.email));
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json'
    };
    if (account.uid) {
      headers['X-User-Id'] = account.uid;
    }

    let rawData: any = null;

    // 首选官方 Buddy 加油站最新活动接口
    try {
      const primaryUrl = `${this.baseUrl}${API_ENDPOINTS.CHECKIN_ACTIVITY_STATUS}`;
      const res = await httpRequest<{
        code: number;
        msg: string;
        data?: Record<string, any>;
      }>(primaryUrl, {
        method: 'POST',
        headers,
        body: {},
        timeout: 10000
      });

      if (res.status === 200 && res.data && res.data.code === 0 && res.data.data) {
        rawData = res.data.data;
      }
    } catch (_) {
      // 失败降级到 legacy 接口
    }

    // 降级回退到 legacy 签到状态接口
    if (!rawData) {
      try {
        const fallbackUrl = `${this.baseUrl}${API_ENDPOINTS.CHECKIN_STATUS_LEGACY}`;
        const res = await httpRequest<{
          code: number;
          msg: string;
          data?: Record<string, any>;
        }>(fallbackUrl, {
          method: 'POST',
          headers,
          body: {},
          timeout: 10000
        });

        if (res.status === 200 && res.data && res.data.code === 0 && res.data.data) {
          rawData = res.data.data;
        }
      } catch (err: any) {
        throw new Error(t('err.statusQueryFailed', err.message));
      }
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
      lastCheckinDate = new Date().toISOString().slice(0, 10);
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

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json'
    };
    if (account.uid) {
      headers['X-User-Id'] = account.uid;
    }

    const checkinUrl = `${this.baseUrl}${API_ENDPOINTS.DAILY_CHECKIN}`;

    try {
      const res = await httpRequest<{
        code: number;
        msg: string;
        data?: Record<string, any>;
      }>(checkinUrl, {
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

      // 处理已签到或已领取的官方错误提示
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

    // 国际账号无签到活动, 明确拒绝而非打到国内接口吃 401
    if (!isCnAccount(account.domain)) {
      resBase.error = t('intl.cnOnlyTitle');
      resBase.message = t('intl.cnOnlyDetail');
      return resBase;
    }

    try {
      // 1. 先查状态
      const status = await this.queryStatus(account);

      if (status.todayCheckedIn) {
        const result: CheckinExecutionResult = {
          accountId: account.id,
          email: account.email,
          uid: account.uid,
          success: true,
          alreadyCheckedIn: true,
          creditAwarded: 0,
          streakDays: status.streakDays,
          message: t('ci.syncAlreadyChecked', status.streakDays)
        };

        if (store) {
          // 余额必须来自 get-user-resource 实时资源包，绝不用签到活动累计值覆盖
          const realQuota = await this.queryRealRemainingQuota(account);
          const quotaPatch = realQuota
            ? {
                totalCredits: realQuota.totalCredits,
                basePackage: realQuota.basePackage,
                activityPackage: realQuota.activityPackage
              }
            : {};
          await store.updateStatus(account.id, account.status, {
            todayCheckedIn: true,
            checkinStreak: status.streakDays,
            ...quotaPatch,
            lastCheckinDate: status.lastCheckinDate || new Date().toISOString().slice(0, 10),
            lastCheckinTime: Date.now()
          });
        }
        return result;
      }

      // 2. 未签到，执行签到
      const execResult = await this.executeDailyCheckin(account);

      if (execResult.success && store) {
        // 签到到账后重新拉取实时资源包余额（新领的算力会体现在资源包中）
        const realQuota = await this.queryRealRemainingQuota(account);
        const quotaPatch = realQuota
          ? {
              totalCredits: realQuota.totalCredits,
              basePackage: realQuota.basePackage,
              activityPackage: realQuota.activityPackage
            }
          : {};
        await store.updateStatus(account.id, account.status, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays || status.streakDays + 1,
          ...quotaPatch,
          lastCheckinDate: new Date().toISOString().slice(0, 10),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    } catch (err: any) {
      // 查询失败时直接尝试签到
      const execResult = await this.executeDailyCheckin(account);
      if (execResult.success && store) {
        const realQuota = await this.queryRealRemainingQuota(account);
        const quotaPatch = realQuota
          ? {
              totalCredits: realQuota.totalCredits,
              basePackage: realQuota.basePackage,
              activityPackage: realQuota.activityPackage
            }
          : {};
        await store.updateStatus(account.id, account.status, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays,
          ...quotaPatch,
          lastCheckinDate: new Date().toISOString().slice(0, 10),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    }
  }

  /**
   * 4. 同步单个账号状态与额度积分至 Store
   */
  public async syncAccountStatus(
    account: CodeBuddyAccount,
    store?: AccountStore
  ): Promise<CheckinStatusResult> {
    const status = await this.queryStatus(account);
    const realQuota = await this.queryRealRemainingQuota(account);
    const finalCredits = realQuota ? realQuota.totalCredits : status.totalCredits;

    if (store) {
      await store.updateStatus(account.id, account.status, {
        todayCheckedIn: status.todayCheckedIn,
        checkinStreak: status.streakDays,
        totalCredits: finalCredits,
        basePackage: realQuota?.basePackage,
        activityPackage: realQuota?.activityPackage,
        lastCheckinDate: status.lastCheckinDate,
        lastCheckinTime: Date.now()
      });
    }
    return {
      ...status,
      totalCredits: finalCredits
    };
  }

  /**
   * 5. 批量同步号池状态与额度积分
   */
  public async batchSyncStatus(
    accounts: CodeBuddyAccount[],
    store?: AccountStore
  ): Promise<number> {
    let synced = 0;
    for (const acc of accounts) {
      if (acc.status === 'disabled' || acc.status === 'expired') {
        continue;
      }
      // 状态/配额接口挂在国内域名, 国际账号无从查询, 直接跳过
      if (!isCnAccount(acc.domain)) {
        continue;
      }
      try {
        await this.syncAccountStatus(acc, store);
        synced++;
      } catch (_) {
        // 忽略单个网络超时
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return synced;
  }

  /**
   * 4. 批量为号池中全量账号执行签到
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

    // 签到活动挂在国内域名 (codebuddy.cn), 国际账号明确跳过并留痕, 不静默吞掉
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
      if (acc.status === 'disabled' || acc.status === 'expired') {
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

      // 礼貌延迟 300ms 避免并发触发风控
      await new Promise(r => setTimeout(r, 300));
    }

    return report;
  }
}
