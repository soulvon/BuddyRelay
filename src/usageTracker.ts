import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';
import { CodeBuddyAccount } from './accountStore';

export interface UsageRecord {
  id: string;
  ts: number;
  timeStr: string;
  dateStr: string;
  type: 'consume' | 'reward' | 'switch' | 'warn';
  accountId: string;
  accountName: string;
  deltaCredits?: number;
  balanceAfter?: number;
  title: string;
  detail?: string;
}

export interface DailySummary {
  date: string;
  totalConsumed: number;
  totalAwarded: number;
  switchCount: number;
}

const MAX_RECORDS = 200;

/**
 * 算力流水对账与调度审计追踪引擎
 * 负责：
 * 1. 周期快照差值计算 (Delta Snapshot) 抓取真实代码补全/会话算力消耗
 * 2. 签到、出游打工、盲盒礼包到账流水记录
 * 3. 手动切号、额度见底自动切号、429 限流切号事件审计
 * 4. 跨窗口共享流水文件 %APPDATA%/CodeBuddy CN/buddy-relay/usage-records.json
 */
export class UsageTracker {
  private filePath: string;
  private records: UsageRecord[] = [];
  private lastCreditsMap: Map<string, number> = new Map();
  private switchTimestamps: number[] = [];

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || path.join(PATHS.RELAY_DIR, 'usage-records.json');
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.records = [];
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.records)) {
        this.records = data.records;
      }
    } catch (_) {
      this.records = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 保持最新 MAX_RECORDS 条
      if (this.records.length > MAX_RECORDS) {
        this.records = this.records.slice(-MAX_RECORDS);
      }
      const tmp = `${this.filePath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: '1.0', updatedAt: Date.now(), records: this.records }, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, this.filePath);
      } catch (_) {
        fs.writeFileSync(this.filePath, JSON.stringify({ version: '1.0', updatedAt: Date.now(), records: this.records }, null, 2), 'utf8');
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (err: any) {
      console.warn('[UsageTracker] 保存流水记录失败:', err.message);
    }
  }

  private formatTime(ts: number): { timeStr: string; dateStr: string } {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return { timeStr, dateStr };
  }

  /**
   * 记录配额快照差值 (Delta Snapshot)
   * 当从云端刷新拿到新的总可用积分时调用，自动计算净消耗或新增
   */
  public recordSnapshot(account: CodeBuddyAccount, newCredits: number, source: string = '巡检对账'): void {
    const aid = account.id || account.uid;
    const name = account.nickname || account.email || account.uid;
    const prev = this.lastCreditsMap.get(aid);

    // 首次载入仅打底，不产生虚假流水
    if (prev === undefined) {
      this.lastCreditsMap.set(aid, newCredits);
      return;
    }

    this.lastCreditsMap.set(aid, newCredits);
    const delta = Math.round((newCredits - prev) * 100) / 100;

    // 忽略小于 0.05 的微小浮点抖动
    if (Math.abs(delta) < 0.05) {
      return;
    }

    const ts = Date.now();
    const { timeStr, dateStr } = this.formatTime(ts);

    if (delta < 0) {
      // 算力消耗 (写代码 / AI 对话)
      this.records.push({
        id: `rec_${ts}_${Math.random().toString(36).slice(2, 6)}`,
        ts,
        timeStr,
        dateStr,
        type: 'consume',
        accountId: aid,
        accountName: name,
        deltaCredits: delta,
        balanceAfter: newCredits,
        title: '会话/代码补全消耗',
        detail: `[${source}] 算力变动 ${delta} 点，剩余可用: ${newCredits} 点`
      });
      this.save();
    } else {
      // 算力增加 (签到或任务奖励到账)
      this.records.push({
        id: `rec_${ts}_${Math.random().toString(36).slice(2, 6)}`,
        ts,
        timeStr,
        dateStr,
        type: 'reward',
        accountId: aid,
        accountName: name,
        deltaCredits: delta,
        balanceAfter: newCredits,
        title: '算力增长到账',
        detail: `[${source}] 新增入账 +${delta} 点，累计结存: ${newCredits} 点`
      });
      this.save();
    }
  }

  /**
   * 记录明确的业务动作 (签到、打工、切号、告警)
   */
  public recordAction(entry: {
    type: 'consume' | 'reward' | 'switch' | 'warn';
    accountId: string;
    accountName: string;
    deltaCredits?: number;
    balanceAfter?: number;
    title: string;
    detail?: string;
  }): void {
    const ts = Date.now();
    const { timeStr, dateStr } = this.formatTime(ts);
    this.records.push({
      id: `rec_${ts}_${Math.random().toString(36).slice(2, 6)}`,
      ts,
      timeStr,
      dateStr,
      ...entry
    });

    if (entry.type === 'switch') {
      this.switchTimestamps.push(ts);
    }

    this.save();
  }

  /**
   * 获取最近时间窗口内的切号次数 (用于熔断器判定)
   */
  public getRecentSwitchCount(windowMs: number = 60_000): number {
    const now = Date.now();
    this.switchTimestamps = this.switchTimestamps.filter(t => now - t <= windowMs);
    return this.switchTimestamps.length;
  }

  /**
   * 获取时间倒序排列的流水列表
   * 注意：仅在构造时加载一次磁盘状态；运行期以内存为权威（save 为全量原子写），
   * 避免读取动作覆盖本窗口刚写入的记录（跨平台文件时序差异防线）
   */
  public getRecentRecords(limit: number = 50): UsageRecord[] {
    return [...this.records].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /**
   * 获取今日经营对账总报表
   */
  public getDailySummary(targetDate?: string): DailySummary {
    const today = targetDate || this.formatTime(Date.now()).dateStr;
    let totalConsumed = 0;
    let totalAwarded = 0;
    let switchCount = 0;

    for (const r of this.records) {
      if (r.dateStr === today) {
        if (r.type === 'consume' && r.deltaCredits) {
          totalConsumed += Math.abs(r.deltaCredits);
        } else if (r.type === 'reward' && r.deltaCredits) {
          totalAwarded += Math.abs(r.deltaCredits);
        } else if (r.type === 'switch') {
          switchCount++;
        }
      }
    }

    return {
      date: today,
      totalConsumed: Math.round(totalConsumed * 100) / 100,
      totalAwarded: Math.round(totalAwarded * 100) / 100,
      switchCount
    };
  }

  /**
   * 清空流水历史记录
   */
  public clearRecords(): void {
    this.records = [];
    this.save();
  }
}
