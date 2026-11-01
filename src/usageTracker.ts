import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';
import { CodeBuddyAccount } from './accountStore';
import { t } from './i18n';

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
  /** 来源：snapshot=余额快照差值（仅明细展示），action=明确业务动作（计入今日到账） */
  source?: 'snapshot' | 'action';
  /** 单调递增写入序号：同一毫秒内多条记录的排序兜底键 */
  seq?: number;
}

export interface DailySummary {
  date: string;
  totalConsumed: number;
  totalAwarded: number;
  switchCount: number;
}

/**
 * 今日统计：完全基于官方数据源
 * - consumed: 官方请求明细求和 (get-user-request-usage)
 * - grants: 官方今日发放包容量求和 (get-user-resource, CreateTime 当日)
 * - 每月 1 号基础基数: 启用账号数 × 500（基础体验包月度重置）
 */
export interface DailyStats {
  date: string;
  consumed: number;
  grants: number;
  perAccountConsumed: Record<string, number>;
  perAccountGrants: Record<string, number>;
  recentRequests: Array<{
    requestId: string;
    credit: number;
    model: string;
    client: string;
    requestTime: string;
    input: string;
  }>;
}

const MAX_RECORDS = 1000;

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
  private _seq: number = 0;
  private dailyStatsPath: string;
  private dailyStats: DailyStats = { date: '', consumed: 0, grants: 0, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: [] };
  private lastFetchTsMap: Map<string, number> = new Map();
  private lastBalances: Map<string, number> = new Map();

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || path.join(PATHS.RELAY_DIR, 'usage-records.json');
    this.dailyStatsPath = path.join(path.dirname(this.filePath), 'daily-stats.json');
    this.load();
    this.loadDailyStats();
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
        // 恢复单调序号基线，保证重启后 seq 依旧递增
        this._seq = this.records.reduce((max, r) => Math.max(max, r.seq || 0), 0);
      }
    } catch (_) {
      this.records = [];
    }
  }

  private loadDailyStats(): void {
    try {
      if (!fs.existsSync(this.dailyStatsPath)) {
        return;
      }
      const raw = fs.readFileSync(this.dailyStatsPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.date !== 'string') {
        return;
      }
      this.dailyStats = {
        date: data.date,
        consumed: typeof data.consumed === 'number' ? data.consumed : 0,
        grants: typeof data.grants === 'number' ? data.grants : 0,
        perAccountConsumed: data.perAccountConsumed && typeof data.perAccountConsumed === 'object' ? data.perAccountConsumed : {},
        perAccountGrants: data.perAccountGrants && typeof data.perAccountGrants === 'object' ? data.perAccountGrants : {},
        recentRequests: Array.isArray(data.recentRequests) ? data.recentRequests : []
      };
    } catch (_) {
      // 文件损坏就从零起算，不阻塞扩展
    }
  }

  private saveDailyStats(): void {
    try {
      const dir = path.dirname(this.dailyStatsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = JSON.stringify(this.dailyStats, null, 2);
      const tmp = `${this.dailyStatsPath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmp, payload, 'utf8');
      try {
        fs.renameSync(tmp, this.dailyStatsPath);
      } catch (_) {
        fs.writeFileSync(this.dailyStatsPath, payload, 'utf8');
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (err: any) {
      console.warn('[UsageTracker] 保存今日统计失败:', err.message);
    }
  }

  /**
   * 检测余额变化的账号（每次向侧栏推送状态时调用，同步、零成本）
   * 变化的账号才需要去官方核对消耗与到账
   */
  public detectChangedAccounts(items: Array<{ id: string; credits: number }>): string[] {
    const today = this.formatTime(Date.now()).dateStr;
    const changedIds: string[] = [];
    let valid = false;

    for (const item of items) {
      if (!item || !item.id || typeof item.credits !== 'number' || !isFinite(item.credits)) {
        continue;
      }
      valid = true;
      const prev = this.lastBalances.get(item.id);
      if (prev === undefined || Math.abs(prev - item.credits) >= 0.01) {
        changedIds.push(item.id);
      }
      this.lastBalances.set(item.id, item.credits);
    }
    if (!valid) {
      return [];
    }

    if (this.dailyStats.date !== today) {
      // 跨天：消耗/到账统计清零，全部账号重新核对
      this.dailyStats = {
        date: today,
        consumed: 0,
        grants: 0,
        perAccountConsumed: {},
        perAccountGrants: {},
        recentRequests: []
      };
      this.saveDailyStats();
      return items.filter((i) => i && typeof i.credits === 'number').map((i) => i.id);
    }
    return changedIds;
  }

  /**
   * 拉取官方今日数据（每账号一次调用）
   * 包含：1. 消耗明细 2. 今日新发放资源包
   */
  public async refreshOfficialStats(items: Array<{ id: string; token: string; uid: string }>): Promise<boolean> {
    const now = Date.now();
    // 按账号 3 分钟节流：一次使用通常只有一个号在消耗，单号最多每 3 分钟请求一次
    const valid = (items || []).filter(
      (i) => i && i.id && i.token && i.uid && now - (this.lastFetchTsMap.get(i.id) || 0) >= 180_000
    );
    if (!valid.length) {
      return false;
    }
    for (const i of valid) {
      this.lastFetchTsMap.set(i.id, now);
    }

    const results = await Promise.all(valid.map((i) => UsageTracker.fetchOfficialDaily(i.token, i.uid)));

    const today = this.formatTime(Date.now()).dateStr;
    if (this.dailyStats.date !== today) {
      this.dailyStats = {
        date: today,
        consumed: 0,
        grants: 0,
        perAccountConsumed: {},
        perAccountGrants: {},
        recentRequests: []
      };
    }

    // 只覆盖本次成功查到的账号，其余沿用缓存
    for (let i = 0; i < valid.length; i++) {
      const r = results[i];
      if (!r) {
        continue;
      }
      this.dailyStats.perAccountConsumed[valid[i].id] = r.consumed;
      this.dailyStats.perAccountGrants[valid[i].id] = r.grants;

      const seen = new Set(this.dailyStats.recentRequests.map((x) => x.requestId));
      for (const row of r.rows) {
        if (!row.requestId || seen.has(row.requestId)) {
          continue;
        }
        seen.add(row.requestId);
        this.dailyStats.recentRequests.push({
          requestId: row.requestId,
          credit: Number(row.credit || 0),
          model: row.model || '',
          client: row.client || '',
          requestTime: row.requestTime || '',
          input: String(row.input || row.inputTrunc || '').slice(0, 120)
        });
      }
    }
    this.dailyStats.recentRequests.sort((a, b) => b.requestTime.localeCompare(a.requestTime));
    if (this.dailyStats.recentRequests.length > 200) {
      this.dailyStats.recentRequests = this.dailyStats.recentRequests.slice(0, 200);
    }

    const totalConsumed = Math.round(
      Object.keys(this.dailyStats.perAccountConsumed).reduce((s, k) => s + (Number(this.dailyStats.perAccountConsumed[k]) || 0), 0) * 100
    ) / 100;
    const totalGrants = Math.round(
      Object.keys(this.dailyStats.perAccountGrants).reduce((s, k) => s + (Number(this.dailyStats.perAccountGrants[k]) || 0), 0) * 100
    ) / 100;

    const changed = Math.abs(this.dailyStats.consumed - totalConsumed) >= 0.01 || Math.abs(this.dailyStats.grants - totalGrants) >= 0.01;
    this.dailyStats.consumed = totalConsumed;
    this.dailyStats.grants = totalGrants;
    if (changed) {
      this.saveDailyStats();
    }
    return changed;
  }

  /**
   * 拉取单账号官方今日消耗与今日发包数据
   */
  public static async fetchOfficialDaily(
    token: string,
    uid: string
  ): Promise<{ consumed: number; grants: number; rows: Array<Record<string, any>> } | null> {
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-User-Id': uid,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const dayStart = new Date(dateStr + ' 00:00:00').getTime();
    const dayEnd = dayStart + 86400_000;

    // 1. 查消耗明细（自动翻页）
    let consumedSum = 0;
    const allRows: Array<Record<string, any>> = [];
    let pageNum = 1;
    try {
      for (let page = 0; page < 5; page++) {
        const res = await fetch('https://www.codebuddy.cn/billing/meter/get-user-request-usage', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            startTime: dateStr + ' 00:00:00',
            endTime: dateStr + ' 23:59:59',
            pageNum,
            pageSize: 200
          })
        });
        if (!res.ok) {
          return null;
        }
        const json: any = await res.json().catch(() => null);
        if (!json || json.code !== 0 || !json.data) {
          return null;
        }
        const rows: Array<Record<string, any>> = json.data.data || [];
        consumedSum += rows.reduce((s, r) => s + Number(r.credit || 0), 0);
        allRows.push(...rows);
        const total = Number(json.data.total || 0);
        if (pageNum * 200 >= total || rows.length === 0) {
          break;
        }
        pageNum++;
      }
    } catch (_) {
      return null;
    }

    // 2. 查今日新到账资源包（签到包 100 + 活动任务包）
    let grantsSum = 0;
    try {
      const res = await fetch('https://www.codebuddy.cn/v2/billing/meter/get-user-resource', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3]
        })
      });
      if (res.ok) {
        const json: any = await res.json().catch(() => null);
        const packs = json?.data?.Response?.Data?.Accounts || [];
        for (const p of packs) {
          const ct = Number(p.CreateTime || 0);
          if (ct >= dayStart && ct < dayEnd) {
            grantsSum += Number(p.CapacitySize || 0);
          }
        }
      }
    } catch (_) {
      // 查包失败不阻断，grants 保持 0
    }

    return {
      consumed: Math.round(consumedSum * 100) / 100,
      grants: Math.round(grantsSum * 100) / 100,
      rows: allRows
    };
  }

  /** 官方请求明细（全账号合并，倒序），供侧栏明细列表展示 */
  public getRecentOfficialRequests(limit: number = 25): Array<Record<string, any>> {
    if (this.dailyStats.date !== this.formatTime(Date.now()).dateStr) {
      return [];
    }
    return this.dailyStats.recentRequests.slice(0, limit);
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
  public recordSnapshot(account: CodeBuddyAccount, newCredits: number, source: string = t('ut.snapshotSource')): void {
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
        id: `rec_${ts}_${++this._seq}`,
        seq: this._seq,
        ts,
        timeStr,
        dateStr,
        type: 'consume',
        accountId: aid,
        accountName: name,
        deltaCredits: delta,
        balanceAfter: newCredits,
        title: t('ut.consumeTitle'),
        detail: t('ut.consumeDetail', source, delta, newCredits)
      });
      this.save();
    } else {
      // 算力增加 (签到或任务奖励到账)
      this.records.push({
        id: `rec_${ts}_${++this._seq}`,
        seq: this._seq,
        ts,
        timeStr,
        dateStr,
        type: 'reward',
        accountId: aid,
        accountName: name,
        deltaCredits: delta,
        balanceAfter: newCredits,
        title: t('ut.gainTitle'),
        detail: t('ut.gainDetail', source, delta, newCredits)
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
      id: `rec_${ts}_${++this._seq}`,
        seq: this._seq,
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
    return [...this.records].sort((a, b) => (b.ts - a.ts) || ((b.seq || 0) - (a.seq || 0))).slice(0, limit);
  }

  /**
   * 获取今日经营对账总报表
   * - 消耗 = 官方明细求和（权威）
   * - 新增 = 官方今日发包容量求和 + （每月1号 ? activeAccountCount * 500 : 0）
   */
  public getDailySummary(activeAccountCount: number = 0, targetDate?: string): DailySummary {
    const today = targetDate || this.formatTime(Date.now()).dateStr;
    const sameDay = this.dailyStats.date === today;

    let switchCount = 0;
    for (const r of this.records) {
      if (r.dateStr === today && r.type === 'switch') {
        switchCount++;
      }
    }

    const consumed = sameDay ? this.dailyStats.consumed : 0;
    const grants = sameDay ? this.dailyStats.grants : 0;

    // 每月 1 号基础体验包重置基数：每号 500
    const dayOfMonth = new Date(today).getDate();
    const isFirstDayOfMonth = dayOfMonth === 1;
    const firstDayBonus = isFirstDayOfMonth ? Math.max(0, activeAccountCount) * 500 : 0;
    const totalAwarded = Math.round((grants + firstDayBonus) * 100) / 100;

    return {
      date: today,
      totalConsumed: sameDay ? Math.round(consumed * 100) / 100 : 0,
      totalAwarded,
      switchCount
    };
  }

  /** 手动写入今日消耗（测试与离线兜底） */
  public updateTodayConsumed(total: number): void {
    const today = this.formatTime(Date.now()).dateStr;
    const value = Math.round(total * 100) / 100;
    if (this.dailyStats.date !== today) {
      this.dailyStats = { date: today, consumed: value, grants: 0, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: this.dailyStats.recentRequests };
    } else {
      this.dailyStats.consumed = value;
      this.dailyStats.perAccountConsumed = {};
    }
    this.saveDailyStats();
  }

  /** 手动写入今日到账（测试与离线兜底） */
  public updateTodayGrants(total: number): void {
    const today = this.formatTime(Date.now()).dateStr;
    const value = Math.round(total * 100) / 100;
    if (this.dailyStats.date !== today) {
      this.dailyStats = { date: today, consumed: 0, grants: value, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: this.dailyStats.recentRequests };
    } else {
      this.dailyStats.grants = value;
      this.dailyStats.perAccountGrants = {};
    }
    this.saveDailyStats();
  }

  /**
   * 清空流水历史记录
   */
  public clearRecords(): void {
    this.records = [];
    this.save();
  }
}
