import { API_ENDPOINTS } from './constants';
import { httpRequest } from './oauthService';
import { CodeBuddyAccount, AccountStore } from './accountStore';

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
  public async queryStatus(account: CodeBuddyAccount): Promise<CheckinStatusResult> {
    if (!account.accessToken) {
      throw new Error(`[CheckinService] 账号缺少 accessToken: ${account.email}`);
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
        throw new Error(`[CheckinService] 查询签到状态全部失败: ${err.message}`);
      }
    }

    if (!rawData) {
      throw new Error('[CheckinService] 无法获取签到状态数据');
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
      themeName: rawData.theme_name || 'Buddy加油站',
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
      resBase.error = '账号缺少 accessToken';
      resBase.message = '签到失败: 缺少凭据';
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
        resBase.message = `签到成功，获得 ${credit} 算力点 (连续 ${streak} 天)`;
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
        resBase.message = `今日已签到 (${errMsg})`;
        return resBase;
      }

      resBase.error = errMsg;
      resBase.message = `签到失败: ${errMsg}`;
      return resBase;
    } catch (err: any) {
      resBase.error = err.message;
      resBase.message = `签到异常: ${err.message}`;
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
          message: `今日已完成签到 (连续 ${status.streakDays} 天)`
        };

        if (store) {
          await store.updateStatus(account.id, account.status, {
            todayCheckedIn: true,
            checkinStreak: status.streakDays,
            lastCheckinDate: status.lastCheckinDate || new Date().toISOString().slice(0, 10),
            lastCheckinTime: Date.now()
          });
        }
        return result;
      }

      // 2. 未签到，执行签到
      const execResult = await this.executeDailyCheckin(account);

      if (execResult.success && store) {
        await store.updateStatus(account.id, account.status, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays || status.streakDays + 1,
          lastCheckinDate: new Date().toISOString().slice(0, 10),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    } catch (err: any) {
      // 查询失败时直接尝试签到
      const execResult = await this.executeDailyCheckin(account);
      if (execResult.success && store) {
        await store.updateStatus(account.id, account.status, {
          todayCheckedIn: true,
          checkinStreak: execResult.streakDays,
          lastCheckinDate: new Date().toISOString().slice(0, 10),
          lastCheckinTime: Date.now()
        });
      }
      return execResult;
    }
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

    for (const acc of accounts) {
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
          message: `跳过不可用账号 (状态: ${acc.status})`
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
