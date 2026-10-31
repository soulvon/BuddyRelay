import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount } from './accountStore';
import { CheckinService, todayCN } from './checkinService';

/**
 * Cockpit Tools 式每日定时签到调度器
 * - 每日定点（HH:mm）+ 随机抖动窗口（错开整点更像真人）
 * - 多账号之间逐个随机间隔签到（拟人化）
 * - 失败自动重试（指数退避，最多 3 次）
 */
export class CheckinScheduler {
  private store: AccountStore;
  private checkinService: CheckinService;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private retryCount = 0;
  private onSummary:
    | ((success: number, total: number, awarded: number) => void)
    | null = null;

  constructor(store: AccountStore, checkinService: CheckinService) {
    this.store = store;
    this.checkinService = checkinService;
  }

  /**
   * 注册签到完成汇总回调（用于 toast 通知）
   */
  public onScheduleSummary(
    cb: (success: number, total: number, awarded: number) => void
  ): void {
    this.onSummary = cb;
  }

  /**
   * 启动调度器：计算下一次运行时间并挂载定时器
   */
  public start(): void {
    this.stop();
    const delayMs = this.computeNextRunDelayMs();
    if (delayMs === null) {
      return;
    }
    const nextAt = new Date(Date.now() + delayMs);
    console.log(
      `[BuddyRelay][CheckinScheduler] 下一次自动签到: ${nextAt.toLocaleString()}`
    );
    this.scheduleTimer = setTimeout(async () => {
      await this.runScheduledCheckin();
      // 运行完毕后自动调度下一天
      this.start();
    }, delayMs);
  }

  public stop(): void {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  /**
   * 计算距离下一次定点签到的毫秒数（含随机抖动）
   * 返回 null 表示配置关闭或非法
   */
  private computeNextRunDelayMs(): number | null {
    const cfg = this.getConfig();
    if (!cfg) {
      return null;
    }

    const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.dailyTime.trim());
    if (!m) {
      console.warn(
        `[BuddyRelay][CheckinScheduler] dailyTime 格式非法: ${cfg.dailyTime}`
      );
      return null;
    }
    const hh = Math.min(23, parseInt(m[1], 10));
    const mm = Math.min(59, parseInt(m[2], 10));

    const jitterMin =
      cfg.jitterMinutes > 0 ? Math.floor(Math.random() * cfg.jitterMinutes) : 0;

    const now = new Date();
    const target = new Date(now);
    target.setHours(hh, mm + jitterMin, Math.floor(Math.random() * 60), 0);

    // 若今日时点已过（含抖动），调度到明天
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  private getConfig(): {
    dailyTime: string;
    jitterMinutes: number;
    perAccountDelaySeconds: number;
  } | null {
    const cfg = vscode.workspace.getConfiguration('buddyRelay');
    if (!cfg.get<boolean>('autoCheckin', true)) {
      return null;
    }
    return {
      dailyTime: cfg.get<string>('autoCheckin.dailyTime', '00:10'),
      jitterMinutes: Math.max(
        0,
        cfg.get<number>('autoCheckin.randomJitterMinutes', 30)
      ),
      perAccountDelaySeconds: Math.max(
        0,
        cfg.get<number>('autoCheckin.perAccountDelaySeconds', 15)
      )
    };
  }

  /**
   * 执行一次定点签到（仅处理今日未签账号，账号间随机拟人化间隔）
   */
  public async runScheduledCheckin(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const cfg = this.getConfig();
      const accounts = this.store.getAll();
      const today = todayCN();
      const pending = accounts.filter(
        (acc: CodeBuddyAccount) =>
          acc.status !== 'disabled' &&
          acc.status !== 'expired' &&
          (!acc.todayCheckedIn || acc.lastCheckinDate !== today)
      );

      if (pending.length === 0) {
        return;
      }

      console.log(
        `[BuddyRelay][CheckinScheduler] 定点签到启动: ${pending.length} 个账号待签`
      );

      let success = 0;
      let awarded = 0;
      const failed: CodeBuddyAccount[] = [];

      for (let i = 0; i < pending.length; i++) {
        const acc = pending[i];
        try {
          const res = await this.checkinService.checkinAccount(acc, this.store);
          if (res.success) {
            success++;
            awarded += res.creditAwarded || 0;
          } else {
            failed.push(acc);
          }
        } catch (_) {
          failed.push(acc);
        }

        // 账号间拟人化随机间隔（最后一个不等）
        if (i < pending.length - 1 && cfg && cfg.perAccountDelaySeconds > 0) {
          const delaySec = cfg.perAccountDelaySeconds * (0.3 + Math.random() * 0.7);
          await new Promise(r => setTimeout(r, Math.round(delaySec * 1000)));
        }
      }

      if (success > 0 && this.onSummary) {
        this.onSummary(success, pending.length, awarded);
      }

      // 失败重试（指数退避：5/10/15 分钟）
      if (failed.length > 0 && this.retryCount < 3) {
        this.retryCount++;
        const backoffMin = 5 * this.retryCount;
        console.log(
          `[BuddyRelay][CheckinScheduler] ${failed.length} 个账号签到失败，${backoffMin} 分钟后重试 (${this.retryCount}/3)`
        );
        setTimeout(async () => {
          await this.runScheduledCheckin();
        }, backoffMin * 60 * 1000);
      } else {
        this.retryCount = 0;
      }
    } finally {
      this.running = false;
    }
  }
}
