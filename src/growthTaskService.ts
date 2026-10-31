import { CodeBuddyAccount } from './accountStore';
import { httpRequest } from './oauthService';
import { t } from './i18n';

/**
 * Buddy 成长中心任务模型（来源：/v2/activity/growth/tasks）
 * 字段契约对齐开源社区 WorkBuddy-Daily 的实测口径
 */
export interface GrowthTask {
  /** 任务代码（如 Hp_Appearance / skill_1 / first_buddy） */
  taskCode: string;
  /** 任务标题 */
  title: string;
  /** 报名状态：not_accepted / accepted / claimed */
  acceptStatus: string;
  /** 奖励是否已领取 */
  claimed: boolean;
  /** 是否未到上线时间（服务端下发 locked=true） */
  locked: boolean;
  /** 解锁提示（locked=true 时服务端给出的时间） */
  lockedHint?: string;
  /** 进度 */
  current: number;
  /** 进度目标 */
  target: number;
  /** 限人工任务（如关注公众号需真人扫码 24h） */
  manualOnly: boolean;
  /** 有效期截止（过期任务不再能领取） */
  validEnd?: string;
  /** 来源：desktop 桌面源 / mp 小程序源 */
  source: 'desktop' | 'mp';
}

export interface TaskAutoReport {
  /** 领养 Buddy 是否执行 */
  buddyAttempted: boolean;
  /** 领养 Buddy 是否成功（+300 分 +8 能） */
  buddyAdopted: boolean;
  /** 批量报名成功数 */
  accepted: number;
  /** 领奖成功数 */
  claimed: number;
  /** 领奖到账积分 */
  claimedCredits: number;
  /** 领奖到账能量 */
  claimedEnergy: number;
  /** 游历奖励是否领取 */
  travelClaimed: boolean;
  /** 游历是否成功出发 */
  travelDeparted: boolean;
  /** 游历目的地名称 */
  travelLocation?: string;
  /** 连登兑换到账积分 */
  streakRedeemedCredits: number;
  /** 补登天数 */
  madeUpDays: number;
  /** 能量开盲盒数 */
  buddyBoxesOpened: number;
  /** 开出的新Buddy名称 */
  newBuddyName?: string;
  /** 抽奖次数 */
  lotteryDraws: number;
  /** 进行中任务数 */
  inProgressTasks: number;
  /** 跳过说明 */
  skipped: string[];
  /** 失败明细 */
  failures: string[];
}

export interface GrowthAssetSummary {
  travelState: 'idle' | 'traveling' | 'arrived' | 'unknown';
  travelLocationName?: string;
  travelEtaHours?: number;
  travelExpectedCredits?: number;
  travelDailyLimit: boolean;
  streakDays: number;
  nextTier: string;
  nextTierRemaining: number;
  makeupCards: number;
  energyBalance: number;
  energyAffordableBoxes: number;
}

export interface AcceptResult {
  accepted: number;
  alreadyAccepted: number;
  failed: number;
  failures: string[];
}

/** 需真人操作的任务代码（脚本不自动完成） */
const MANUAL_TASK_CODES = new Set<string>(['wb_wechat_oa_subscribe_task']);

/**
 * Buddy 成长中心任务自动化服务
 * 接口契约移植自开源项目 WorkBuddy-Daily（MIT）的实测实现
 * WorkBuddy 与 CodeBuddy 共用成长中心与账号体系（认证均走 copilot.tencent.com）
 */
export class GrowthTaskService {
  private baseUrl: string;

  constructor(baseUrl: string = 'https://www.codebuddy.cn') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(account: CodeBuddyAccount, extra?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${account.accessToken}`,
      'X-User-Id': account.uid,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CodeBuddy/1.0.0',
      ...(extra || {})
    };
  }

  private asInt(v: any): number {
    const n = parseInt(String(v ?? 0), 10);
    return isNaN(n) ? 0 : n;
  }

  /**
   * 读取账号成长中心资产全景（旅行打工状态、连登进度条、盲盒能量余额）
   */
  public async getGrowthAssetSummary(account: CodeBuddyAccount): Promise<GrowthAssetSummary> {
    const summary: GrowthAssetSummary = {
      travelState: 'unknown',
      travelDailyLimit: false,
      streakDays: 0,
      nextTier: '7d',
      nextTierRemaining: 0,
      makeupCards: 0,
      energyBalance: 0,
      energyAffordableBoxes: 0
    };

    try {
      const [travelRes, streakRes, quotaRes] = await Promise.all([
        httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/travel/status`, {
          method: 'GET',
          headers: this.headers(account),
          timeout: 10000
        }).catch(() => null),
        httpRequest<any>(`${this.baseUrl}/activity/growth/streak`, {
          method: 'GET',
          headers: this.headers(account),
          timeout: 10000
        }).catch(() => null),
        httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/quota`, {
          method: 'GET',
          headers: this.headers(account),
          timeout: 10000
        }).catch(() => null)
      ]);

      if (travelRes?.data?.data) {
        const t = travelRes.data.data;
        summary.travelState = t.state || 'idle';
        summary.travelLocationName = t.location?.name;
        summary.travelDailyLimit = Boolean(t.daily_limit_reached);
        summary.travelExpectedCredits = this.asInt(t.reward_credit);
        const serverNow = t.server_now || Math.round(Date.now() / 1000);
        const arriveAt = t.arrive_at || 0;
        if (arriveAt > serverNow) {
          summary.travelEtaHours = Math.round(((arriveAt - serverNow) / 3600) * 10) / 10;
        }
      }

      if (streakRes?.data?.data) {
        const s = streakRes.data.data;
        summary.streakDays = this.asInt(s.streak?.days);
        summary.nextTier = s.streak?.next_tier || '7d';
        summary.nextTierRemaining = this.asInt(s.streak?.next_tier_remaining);
        summary.makeupCards = this.asInt(s.makeup_cards?.balance ?? s.makeup_cards);
      }

      if (quotaRes?.data?.data) {
        const q = quotaRes.data.data;
        summary.energyBalance = this.asInt(q.balance);
        summary.energyAffordableBoxes = this.asInt(q.affordable);
      }
    } catch (_) {}

    return summary;
  }

  /**
   * 拉取成长任务列表（桌面源 + 小程序源合并，按 task_code 去重）
   * @param errors 可选错误收集器：单源失败的真实原因（HTTP 状态/服务端 msg/网络异常）逐条穿透气，便于远程排查
   */
  public async listTasks(account: CodeBuddyAccount, errors?: string[]): Promise<GrowthTask[]> {
    const merged = new Map<string, GrowthTask>();

    const collect = async (source: 'desktop' | 'mp') => {
      const extra =
        source === 'mp'
          ? { 'X-Client-Platform': 'miniprogram' }
          : undefined;
      try {
        const res = await httpRequest<any>(
          `${this.baseUrl}/v2/activity/growth/tasks`,
          { method: 'GET', headers: this.headers(account, extra), timeout: 15000 }
        );
        if (res.status === 200 && res.data?.code === 0) {
          const rows: any[] = res.data?.data?.tasks || [];
          for (const row of rows) {
            if (!row || typeof row !== 'object') {
              continue;
            }
            const code = String(row.task_code || row.code || '').trim();
            if (!code) {
              continue;
            }
            const task: GrowthTask = {
              taskCode: code,
              title: String(row.title || row.task_title || row.task_name || code),
              acceptStatus: String(row.accept_status || ''),
              claimed: row.claimed === true || String(row.claimed).toLowerCase() === 'true',
              locked: row.locked === true,
              lockedHint: row.locked_hint || row.valid_start || undefined,
              current: this.asInt((row.progress || {}).current),
              target: this.asInt((row.progress || {}).target),
              manualOnly: MANUAL_TASK_CODES.has(code),
              validEnd: row.valid_end || undefined,
              source
            };
            const old = merged.get(code);
            // 同一任务双源都有时保留信息更全的一条（优先桌面源）
            if (!old || (old.source === 'mp' && source === 'desktop')) {
              merged.set(code, task);
            }
          }
        } else {
          errors?.push(`${source}: HTTP ${res.status} ${String(res.data?.msg || res.data?.code || '').trim()}`.trim());
        }
      } catch (err: any) {
        errors?.push(`${source}: ${err.message}`);
      }
    };

    await collect('desktop');
    await collect('mp');

    return Array.from(merged.values());
  }

  /**
   * 批量报名（「接受」）：仅处理未报名且非限人工/未锁定的任务
   * 核心增强：
   * 1. 自动前置领养 Buddy（腾讯服务端硬性前置，否则报错 prerequisite not met: first_buddy）
   * 2. 分离 desktop 源与 mp 源（mp 必须附带 X-Client-Platform: miniprogram，否则报错 task not found）
   * 3. 真实穿透每一项结果与错误原因，绝不静默吞错
   */
  public async acceptAll(account: CodeBuddyAccount, tasks: GrowthTask[]): Promise<AcceptResult> {
    // 1. 若 first_buddy 未完成，先自动自愈领养
    const firstBuddy = tasks.find(t => t.taskCode === 'first_buddy');
    if (firstBuddy && !firstBuddy.claimed && firstBuddy.acceptStatus !== 'claimed') {
      await this.adoptBuddyIfNeeded(account, tasks);
      tasks = await this.listTasks(account);
    }

    const todoTasks = tasks.filter(
      t => !t.locked && !t.manualOnly && t.acceptStatus === 'not_accepted'
    );

    if (todoTasks.length === 0) {
      return { accepted: 0, alreadyAccepted: 0, failed: 0, failures: [] };
    }

    // 分离桌面端源与小程序端源
    const desktopCodes = todoTasks.filter(t => t.source !== 'mp').map(t => t.taskCode);
    const mpCodes = todoTasks.filter(t => t.source === 'mp').map(t => t.taskCode);

    let accepted = 0;
    let alreadyAccepted = 0;
    const failures: string[] = [];

    const sendBatch = async (codes: string[], isMp: boolean) => {
      if (codes.length === 0) return;
      try {
        const extra = isMp ? { 'X-Client-Platform': 'miniprogram' } : undefined;
        const res = await httpRequest<any>(`${this.baseUrl}/v2/activity/growth/tasks/accept`, {
          method: 'POST',
          headers: this.headers(account, extra),
          body: { task_codes: codes },
          timeout: 20000
        });

        if (res.status === 200 && res.data?.code === 0) {
          const results: any[] = res.data?.data?.results || [];
          for (const r of results) {
            if (r?.status === 'accepted') {
              accepted++;
            } else if (r?.status === 'already_accepted') {
              alreadyAccepted++;
            } else {
              failures.push(`${r?.task_code || t('task.defaultName')}: ${r?.message || r?.status || t('err.acceptFailedShort')}`);
            }
          }
        } else {
          failures.push(t('err.acceptApiError', res.status, res.data?.msg || t('err.unknownError')));
        }
      } catch (err: any) {
        failures.push(t('err.networkError', err.message));
      }
    };

    await sendBatch(desktopCodes, false);
    await sendBatch(mpCodes, true);

    return {
      accepted,
      alreadyAccepted,
      failed: failures.length,
      failures
    };
  }

  /**
   * 领取单个达标任务奖励（chat 域 400 时自动降级 web 域）
   * 返回 { ok, credit, energy, already }
   */
  public async claimTask(
    account: CodeBuddyAccount,
    taskCode: string
  ): Promise<{ ok: boolean; credit: number; energy: number; already: boolean; detail?: string }> {
    const doClaim = async (webFallback: boolean) => {
      const headers = this.headers(
        account,
        webFallback
          ? { 'x-client-platform': 'web', Origin: this.baseUrl, Referer: `${this.baseUrl}/profile/growth-center` }
          : undefined
      );
      return httpRequest<any>(`${this.baseUrl}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`, {
        method: 'POST',
        headers,
        body: {},
        timeout: 20000
      });
    };

    let res = await doClaim(false);
    if (res.status === 400) {
      res = await doClaim(true);
    }

    const data = res.data?.data || {};
    const msg = String(res.data?.msg || '');
    const already = Boolean(data.already_claimed) || msg.includes('已领取') || msg.includes('已领过') || msg.toLowerCase().includes('already');
    const credit = this.asInt(data.credit);
    const energy = this.asInt(data.energy);
    const ok = res.status === 200 && res.data?.code === 0;
    const detail = ok
      ? undefined
      : `HTTP ${res.status} ${String(res.data?.msg || res.data?.code || '').trim()}`.trim();

    return { ok: ok || already, credit, energy, already, detail };
  }

  /**
   * 判断任务是否可领取：进度达标（current >= target 且 target>0）或服务端标记 completed
   */
  public isClaimable(task: GrowthTask): boolean {
    if (task.locked || task.claimed || task.acceptStatus === 'claimed') {
      return false;
    }
    if (task.target > 0 && task.current >= task.target) {
      return true;
    }
    return task.target <= 0 && task.acceptStatus === 'completed';
  }

  /**
   * 领养首只 Buddy（+300 分 +8 能，多数云端任务的前置）
   * 链路：buddy/agreement → buddy/first
   */
  public async adoptBuddyIfNeeded(
    account: CodeBuddyAccount,
    tasks: GrowthTask[]
  ): Promise<{ attempted: boolean; adopted: boolean; credit: number; energy: number }> {
    const firstBuddy = tasks.find(t => t.taskCode === 'first_buddy');
    // 已领养（任务已 claimed）则跳过
    if (!firstBuddy || firstBuddy.claimed || firstBuddy.acceptStatus === 'claimed') {
      return { attempted: false, adopted: false, credit: 0, energy: 0 };
    }

    try {
      await httpRequest<any>(`${this.baseUrl}/v2/activity/growth/buddy/agreement`, {
        method: 'POST',
        headers: this.headers(account),
        body: { agree: true },
        timeout: 20000
      });

      const res = await httpRequest<any>(`${this.baseUrl}/v2/activity/growth/buddy/first`, {
        method: 'POST',
        headers: this.headers(account),
        body: {},
        timeout: 20000
      });

      const ok = res.status === 200 && res.data?.code === 0;
      const data = res.data?.data || {};
      return {
        attempted: true,
        adopted: ok,
        credit: this.asInt(data.credit),
        energy: this.asInt(data.energy)
      };
    } catch (_) {
      return { attempted: true, adopted: false, credit: 0, energy: 0 };
    }
  }

  /**
   * 自动派空闲的 Buddy 出发旅行打工（带回 5~10 免费积分与礼物）
   */
  public async departTravelIfNeeded(
    account: CodeBuddyAccount
  ): Promise<{ attempted: boolean; departed: boolean; location?: string }> {
    try {
      const statusRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/travel/status`, {
        method: 'GET',
        headers: this.headers(account),
        timeout: 10000
      });
      const st = statusRes.data?.data;
      if (st && st.state === 'idle' && !st.daily_limit_reached) {
        const confRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/travel/config`, {
          method: 'GET',
          headers: this.headers(account),
          timeout: 10000
        });
        const locs: any[] = confRes.data?.data?.locations || [];
        if (locs.length > 0) {
          const loc = locs[0];
          const depRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/travel/depart`, {
            method: 'POST',
            headers: this.headers(account),
            body: { location_id: loc.id },
            timeout: 15000
          });
          if (depRes.status === 200 && depRes.data?.code === 0) {
            return { attempted: true, departed: true, location: loc.name || t('js.defaultLocation') };
          }
        }
      }
    } catch (_) {}
    return { attempted: false, departed: false };
  }

  /**
   * 连登达到 7天/14天/28天 自动兑换大额积分奖励（50~150分）
   */
  public async redeemStreakIfNeeded(account: CodeBuddyAccount): Promise<number> {
    let gained = 0;
    try {
      const summaryRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/redeem/summary`, {
        method: 'GET',
        headers: this.headers(account),
        timeout: 10000
      });
      if (summaryRes.status === 200 && summaryRes.data?.code === 0) {
        const d = summaryRes.data?.data || {};
        const tiers: Array<[string, string, number]> = [
          ['7d', 'starter_status', 0],
          ['14d', 'advanced_status', 50],
          ['28d', 'legendary_status', 150]
        ];
        for (const [tier, statusKey, defaultCr] of tiers) {
          const status = d[statusKey];
          if (status && status !== 'claimed' && status !== 'locked') {
            const r = await httpRequest<any>(`${this.baseUrl}/activity/growth/redeem`, {
              method: 'POST',
              headers: this.headers(account),
              body: { tier, client_token: `redeem_${tier}_${Date.now()}` },
              timeout: 15000
            });
            if (r.status === 200 && r.data?.code === 0) {
              const cr = this.asInt(r.data?.data?.credit_granted || r.data?.data?.credit || defaultCr);
              gained += cr;
            }
          }
        }
      }
    } catch (_) {}
    return gained;
  }

  /**
   * 自动消耗补登卡救回当月断登（保住连续签到与连登兑换资格）
   */
  public async useMakeupCardsIfNeeded(account: CodeBuddyAccount): Promise<number> {
    let madeUp = 0;
    try {
      const streakRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/streak`, {
        method: 'GET',
        headers: this.headers(account),
        timeout: 10000
      });
      const cards = this.asInt(streakRes.data?.data?.makeup_cards?.balance ?? streakRes.data?.data?.makeup_cards);
      if (cards > 0) {
        const heatRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/heatmap`, {
          method: 'GET',
          headers: this.headers(account),
          timeout: 10000
        });
        const dates: any[] = heatRes.data?.data?.heatmap || [];
        const brokenDates = dates
          .filter(x => x && x.score === 0 && x.is_current_month && x.is_past)
          .map(x => x.date);
        for (const d of brokenDates.slice(0, Math.min(cards, 1))) {
          const uRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/makeup-cards/use`, {
            method: 'POST',
            headers: this.headers(account),
            body: { target_date: d },
            timeout: 15000
          });
          if (uRes.status === 200 && uRes.data?.code === 0) {
            madeUp++;
          }
        }
      }
    } catch (_) {}
    return madeUp;
  }

  /**
   * 能量攒够 10 点自动开启 Buddy 盲盒（抽取专属新宠物）
   */
  public async openBuddyBoxIfNeeded(
    account: CodeBuddyAccount
  ): Promise<{ opened: number; name?: string }> {
    try {
      const quotaRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/quota`, {
        method: 'GET',
        headers: this.headers(account),
        timeout: 10000
      });
      const affordable = this.asInt(quotaRes.data?.data?.affordable);
      if (affordable > 0) {
        const openRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/open`, {
          method: 'POST',
          headers: this.headers(account),
          body: { count: 1, client_token: `box_${Date.now()}` },
          timeout: 15000
        });
        if (openRes.status === 200 && openRes.data?.code === 0) {
          const results = openRes.data?.data?.results || [];
          const firstName = results[0]?.template?.name || results[0]?.instance?.soul_desc || t('act.newBuddy');
          return { opened: 1, name: firstName };
        }
      }
    } catch (_) {}
    return { opened: 0 };
  }

  /**
   * 一键自动化流水线：领养Buddy → 批量双源报名 → 游历收成与派遣 → 连登兑换与补登 → 盲盒/抽奖 → 达标任务领奖
   */
  public async runAutoComplete(account: CodeBuddyAccount): Promise<TaskAutoReport> {
    const report: TaskAutoReport = {
      buddyAttempted: false,
      buddyAdopted: false,
      accepted: 0,
      claimed: 0,
      claimedCredits: 0,
      claimedEnergy: 0,
      travelClaimed: false,
      travelDeparted: false,
      streakRedeemedCredits: 0,
      madeUpDays: 0,
      buddyBoxesOpened: 0,
      lotteryDraws: 0,
      inProgressTasks: 0,
      skipped: [],
      failures: []
    };

    // 1. 首扫任务
    const firstScanErrors: string[] = [];
    let tasks = await this.listTasks(account, firstScanErrors);
    if (tasks.length === 0) {
      report.failures.push(t('task.noTaskList'));
      report.failures.push(...firstScanErrors);
      return report;
    }

    // 2. 领养 Buddy（前置自愈，成功可得 +300分+8能）
    const buddy = await this.adoptBuddyIfNeeded(account, tasks);
    report.buddyAttempted = buddy.attempted;
    report.buddyAdopted = buddy.adopted;
    if (buddy.adopted) {
      report.claimedCredits += buddy.credit;
      report.claimedEnergy += buddy.energy;
    }

    // 3. 批量双源报名（分离 desktop/mp 源，自动自愈前置）
    const acceptRes = await this.acceptAll(account, tasks);
    report.accepted = acceptRes.accepted;
    if (acceptRes.failed > 0) {
      report.failures.push(...acceptRes.failures);
    }

    // 4. 游历收成（带回上次打工礼包）
    try {
      const travelRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/buddy/travel/claim`, {
        method: 'POST',
        headers: this.headers(account),
        body: {},
        timeout: 10000
      });
      if (travelRes.status === 200 && travelRes.data?.code === 0) {
        report.travelClaimed = true;
        const cr = this.asInt(travelRes.data?.data?.reward_credit);
        const en = this.asInt(travelRes.data?.data?.reward_energy);
        report.claimedCredits += cr;
        report.claimedEnergy += en;
      }
    } catch (_) {}

    // 5. 游历出发打工派遣（只要空闲就派去咖啡馆等地点打工）
    const depRes = await this.departTravelIfNeeded(account);
    report.travelDeparted = depRes.departed;
    report.travelLocation = depRes.location;

    // 6. 连登大额兑换（7d/14d/28d 换 50~150 积分）
    const redeemGained = await this.redeemStreakIfNeeded(account);
    if (redeemGained > 0) {
      report.streakRedeemedCredits = redeemGained;
      report.claimedCredits += redeemGained;
    }

    // 7. 漏签自动补登卡
    report.madeUpDays = await this.useMakeupCardsIfNeeded(account);

    // 8. 能量开盲盒
    const boxRes = await this.openBuddyBoxIfNeeded(account);
    report.buddyBoxesOpened = boxRes.opened;
    report.newBuddyName = boxRes.name;

    // 9. 抽奖机会收益探测
    try {
      const chancesRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/lottery/chances`, {
        method: 'GET',
        headers: this.headers(account),
        timeout: 10000
      });
      const balance = this.asInt(chancesRes.data?.data?.balance);
      if (balance > 0) {
        const drawRes = await httpRequest<any>(`${this.baseUrl}/activity/growth/lottery/draw`, {
          method: 'POST',
          headers: this.headers(account),
          body: { client_token: `draw_${Date.now()}` },
          timeout: 15000
        });
        if (drawRes.status === 200 && drawRes.data?.code === 0) {
          report.lotteryDraws++;
          const cr = this.asInt(drawRes.data?.data?.reward_credit || drawRes.data?.data?.credit);
          const en = this.asInt(drawRes.data?.data?.reward_energy || drawRes.data?.data?.energy);
          report.claimedCredits += cr;
          report.claimedEnergy += en;
        }
      }
    } catch (_) {}

    // 10. 重新拉取最新任务状态
    const refetchErrors: string[] = [];
    tasks = await this.listTasks(account, refetchErrors);
    if (tasks.length === 0 && refetchErrors.length > 0) {
      // 复检双源全挂时明确报错，绝不让领奖阶段静默归零
      report.failures.push(t('task.noTaskList'));
      report.failures.push(...refetchErrors);
    }

    // 11. 逐个领取达标任务奖励
    let inProgress = 0;
    for (const task of tasks) {
      if (task.manualOnly) {
        report.skipped.push(task.title + t('task.wechatOnly'));
        continue;
      }
      if (task.locked) {
        report.skipped.push(task.title + t('task.lockedSuffix'));
        continue;
      }
      if (this.isClaimable(task)) {
        try {
          const r = await this.claimTask(account, task.taskCode);
          if (r.ok && !r.already) {
            report.claimed++;
            report.claimedCredits += r.credit;
            report.claimedEnergy += r.energy;
          } else if (!r.ok) {
            report.failures.push(`${task.title}: ${r.detail || t('err.claimFailedShort')}`);
          }
        } catch (e: any) {
          report.failures.push(`${task.title}: ${e.message}`);
        }
      } else if (task.acceptStatus === 'accepted' || task.acceptStatus === 'in_progress') {
        if (!task.claimed) {
          inProgress++;
        }
      }
    }
    report.inProgressTasks = inProgress;

    return report;
  }
}
