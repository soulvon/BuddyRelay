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

/** 单账号单日按模型聚合的消耗 */
export interface ModelDayStat {
  credits: number;
  count: number;
}

/** date -> accountId -> model -> stat */
export type ModelStatsDays = Record<string, Record<string, Record<string, ModelDayStat>>>;

export interface ModelStatsSnapshot {
  /** date -> accountId -> model -> stat（深拷贝，供 webview 端过滤渲染） */
  days: ModelStatsDays;
  /** accountId -> 已完整同步的历史天列表（不含今天，失败天留洞下次补拉） */
  syncedDays: Record<string, string[]>;
}

/**
 * 今日统计：完全基于官方数据源
 * - consumed: 官方请求明细求和 (get-user-request-usage)
 * - grants: 官方今日发放包容量求和 (get-user-resource, CreateTime 当日)
 * - 每月 1 号基础基数: 启用账号数 × 500（基础体验包月度重置）
 */
export interface DailyStats {
  /** 结构版本：3 = 明细带账号归属 + 跨窗口共享的拉取节流表。低版本文件整体重置，不迁移旧记录 */
  schema: number;
  date: string;
  consumed: number;
  grants: number;
  perAccountConsumed: Record<string, number>;
  perAccountGrants: Record<string, number>;
  recentRequests: Array<{
    requestId: string;
    /** 归属账号：官方明细行本身不带账号，靠逐号查询时打标 */
    accountId: string;
    credit: number;
    model: string;
    client: string;
    requestTime: string;
  }>;
  /** 每号拉取状态：ts=最后一次尝试时间，fails=连续失败次数（多窗口共享同一份节流） */
  fetchState: Record<string, { ts: number; fails: number }>;
}

const DAILY_STATS_SCHEMA = 3;
/** 自动拉取：单号 3 分钟内最多一次 */
const AUTO_FETCH_GAP_MS = 180_000;
/** 手动刷新：允许绕过自动节流，但保底 10 秒防连点 */
const FORCE_FETCH_GAP_MS = 10_000;
/** 连续失败退避：30s 起，指数翻倍，上限 10 分钟 */
const FAIL_BACKOFF_BASE_MS = 30_000;
const FAIL_BACKOFF_MAX_MS = 600_000;
/** 同时查询的账号数上限，避免一次刷新打出几十个请求 */
const FETCH_CONCURRENCY = 2;

/** 模型统计结构版本 */
const MODEL_STATS_SCHEMA = 1;
/** 模型统计保留天数（与面板可选范围一致，超窗数据直接丢弃） */
const MODEL_STATS_MAX_DAYS = 7;

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
  private dailyStats: DailyStats = { schema: DAILY_STATS_SCHEMA, date: '', consumed: 0, grants: 0, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: [], fetchState: {} };
  /** 模型统计：按天×账号×模型聚合，历史天同步一次后不再重拉 */
  private modelStatsPath: string;
  private modelStats: ModelStatsSnapshot = { days: {}, syncedDays: {} };
  private modelStatsBusy: boolean = false;
  private lastModelStatsTodayTs: number = 0;
  /** 同进程内的在途请求：防连续推送导致同一账号并发重复拉取 */
  private inFlight: Set<string> = new Set();
  private lastBalances: Map<string, number> = new Map();

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || path.join(PATHS.RELAY_DIR, 'usage-records.json');
    this.dailyStatsPath = path.join(path.dirname(this.filePath), 'daily-stats.json');
    this.modelStatsPath = path.join(path.dirname(this.filePath), 'model-stats.json');
    this.load();
    this.loadDailyStats();
    this.loadModelStats();
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
      // 无账号归属的旧结构（schema<=1）不迁移：整体重算，下次拉取从官方补回真实数据
      if (data.schema !== 2 && data.schema !== DAILY_STATS_SCHEMA) {
        return;
      }
      this.dailyStats = {
        schema: DAILY_STATS_SCHEMA,
        date: data.date,
        consumed: typeof data.consumed === 'number' ? data.consumed : 0,
        grants: typeof data.grants === 'number' ? data.grants : 0,
        perAccountConsumed: data.perAccountConsumed && typeof data.perAccountConsumed === 'object' ? data.perAccountConsumed : {},
        perAccountGrants: data.perAccountGrants && typeof data.perAccountGrants === 'object' ? data.perAccountGrants : {},
        recentRequests: Array.isArray(data.recentRequests) ? data.recentRequests : [],
        fetchState: data.fetchState && typeof data.fetchState === 'object' ? data.fetchState : {}
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
        schema: DAILY_STATS_SCHEMA,
        date: today,
        consumed: 0,
        grants: 0,
        perAccountConsumed: {},
        perAccountGrants: {},
        recentRequests: [],
        fetchState: {}
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
  public async refreshOfficialStats(
    items: Array<{ id: string; token: string; uid: string }>,
    opts?: { force?: boolean }
  ): Promise<boolean> {
    const now = Date.now();
    const force = opts?.force === true;
    const gap = force ? FORCE_FETCH_GAP_MS : AUTO_FETCH_GAP_MS;

    // 单号节流 + 失败退避 + 在途去重：节流表随 daily-stats 落盘，多窗口共享同一份窗口
    const valid = (items || []).filter((i) => {
      if (!i || !i.id || !i.token || !i.uid) return false;
      if (this.inFlight.has(i.id)) return false;
      const st = this.dailyStats.fetchState[i.id];
      const last = st ? Number(st.ts || 0) : 0;
      if (now - last < gap) return false;
      const fails = st ? Number(st.fails || 0) : 0;
      if (fails > 0) {
        const backoff = Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_BASE_MS * Math.pow(2, fails - 1));
        if (now - last < backoff) return false;
      }
      return true;
    });
    if (!valid.length) {
      return false;
    }
    valid.forEach((i) => this.inFlight.add(i.id));

    try {
      // 分批查询：单次刷新不会同时打出几十个请求
      const results: Array<{ consumed: number; grants: number; rows: Array<Record<string, any>> } | null> = [];
      for (let k = 0; k < valid.length; k += FETCH_CONCURRENCY) {
        const batch = valid.slice(k, k + FETCH_CONCURRENCY);
        results.push(...(await Promise.all(batch.map((i) => UsageTracker.fetchOfficialDaily(i.token, i.uid)))));
      }

      const today = this.formatTime(Date.now()).dateStr;
      if (this.dailyStats.date !== today) {
        this.dailyStats = {
          schema: DAILY_STATS_SCHEMA,
          date: today,
          consumed: 0,
          grants: 0,
          perAccountConsumed: {},
          perAccountGrants: {},
          recentRequests: [],
          fetchState: this.dailyStats.fetchState
        };
      }

      // 只覆盖本次成功查到的账号，其余沿用缓存；失败号记次数走退避
      let failedCount = 0;
      for (let i = 0; i < valid.length; i++) {
        const r = results[i];
        if (!r) {
          failedCount++;
          const prevFails = this.dailyStats.fetchState[valid[i].id]?.fails || 0;
          this.dailyStats.fetchState[valid[i].id] = { ts: now, fails: Math.min(10, prevFails + 1) };
          continue;
        }
        this.dailyStats.fetchState[valid[i].id] = { ts: now, fails: 0 };
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
            accountId: valid[i].id,
            credit: Number(row.credit || 0),
            model: row.model || '',
            client: row.client || '',
            requestTime: row.requestTime || ''
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

      const changed =
        Math.abs(this.dailyStats.consumed - totalConsumed) >= 0.01 ||
        Math.abs(this.dailyStats.grants - totalGrants) >= 0.01 ||
        failedCount > 0;
      this.dailyStats.consumed = totalConsumed;
      this.dailyStats.grants = totalGrants;
      // fetchState 变化同样要落盘，否则多窗口退避与节流失效
      this.saveDailyStats();
      return changed;
    } finally {
      valid.forEach((i) => this.inFlight.delete(i.id));
    }
  }

  /**
   * 拉取单账号指定日期的官方消耗与当日发包数据
   * @param targetDate 缺省拉今天；传具体日期（YYYY-MM-DD）时仅查消耗明细，不查发包
   */
  public static async fetchOfficialDaily(
    token: string,
    uid: string,
    targetDate?: string
  ): Promise<{ consumed: number; grants: number; rows: Array<Record<string, any>> } | null> {
    const headers = {
      Authorization: 'Bearer ' + token,
      'X-User-Id': uid,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const todayStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const dateStr = targetDate || todayStr;
    const isToday = dateStr === todayStr;
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

    // 2. 查当日新到账资源包（仅今天有意义：签到包 100 + 活动任务包；历史天跳过省一次请求）
    let grantsSum = 0;
    if (isToday) {
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
    }

    return {
      consumed: Math.round(consumedSum * 100) / 100,
      grants: Math.round(grantsSum * 100) / 100,
      rows: allRows
    };
  }

  // ════════ 模型用量统计（按天 × 账号 × 模型，供观察限流阈值与换号策略） ════════

  private loadModelStats(): void {
    try {
      if (!fs.existsSync(this.modelStatsPath)) {
        return;
      }
      const raw = fs.readFileSync(this.modelStatsPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.schema !== MODEL_STATS_SCHEMA || !data.days || typeof data.days !== 'object') {
        return;
      }
      const cutoff = this.formatTime(Date.now() - (MODEL_STATS_MAX_DAYS - 1) * 86400_000).dateStr;
      const days: ModelStatsDays = {};
      const syncedDays: Record<string, string[]> = {};
      for (const [date, accs] of Object.entries(data.days)) {
        if (date >= cutoff && accs && typeof accs === 'object') {
          days[date] = accs as Record<string, Record<string, ModelDayStat>>;
        }
      }
      const rawSynced = data.syncedDays && typeof data.syncedDays === 'object' ? data.syncedDays : {};
      for (const [acc, list] of Object.entries(rawSynced)) {
        if (Array.isArray(list)) {
          syncedDays[acc] = list.filter((d) => typeof d === 'string' && d >= cutoff);
        }
      }
      this.modelStats = { days, syncedDays };
    } catch (_) {
      // 文件损坏从零起算，不阻塞扩展
    }
  }

  private saveModelStats(): void {
    try {
      const dir = path.dirname(this.modelStatsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = JSON.stringify(
        { schema: MODEL_STATS_SCHEMA, savedAt: Date.now(), days: this.modelStats.days, syncedDays: this.modelStats.syncedDays },
        null, 2
      );
      const tmp = `${this.modelStatsPath}.tmp_${Date.now()}`;
      fs.writeFileSync(tmp, payload, 'utf8');
      try {
        fs.renameSync(tmp, this.modelStatsPath);
      } catch (_) {
        fs.writeFileSync(this.modelStatsPath, payload, 'utf8');
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (err: any) {
      console.warn('[UsageTracker] 保存模型统计失败:', err.message);
    }
  }

  /**
   * 拉取多天明细并聚合为 按天×账号×模型 消耗
   * 节流：历史天按账号只同步一次（syncedDays 记账，失败天留洞下次补拉）；今天跟随自动刷新 3 分钟节流
   */
  public async refreshModelStats(
    items: Array<{ id: string; token: string; uid: string }>,
    opts?: { days?: number; force?: boolean }
  ): Promise<boolean> {
    if (this.modelStatsBusy) {
      return false;
    }
    const wantDays = Math.min(MODEL_STATS_MAX_DAYS, Math.max(1, Math.floor(opts?.days ?? MODEL_STATS_MAX_DAYS)));
    const force = opts?.force === true;
    const now = Date.now();
    const today = this.formatTime(now).dateStr;

    // 生成请求窗口（从今天往旧排）
    const wantDates: string[] = [];
    for (let i = 0; i < wantDays; i++) {
      wantDates.push(this.formatTime(now - i * 86400_000).dateStr);
    }

    // 今天节流：自动链路 3 分钟一次；手动 force 保底 10 秒防连点
    const todayBlocked = now - this.lastModelStatsTodayTs < (force ? FORCE_FETCH_GAP_MS : AUTO_FETCH_GAP_MS);

    const valid = (items || []).filter((i) => i && i.id && i.token && i.uid);
    const jobs: Array<{ item: { id: string; token: string; uid: string }; date: string }> = [];
    for (const item of valid) {
      const synced = new Set(this.modelStats.syncedDays[item.id] || []);
      for (const date of wantDates) {
        if (date === today) {
          if (!todayBlocked) {
            jobs.push({ item, date });
          }
          continue;
        }
        if (!synced.has(date)) {
          jobs.push({ item, date });
        }
      }
    }
    if (!jobs.length) {
      return false;
    }

    this.modelStatsBusy = true;
    try {
      let changed = false;
      // 分批并发，节奏与今日明细拉取一致
      for (let k = 0; k < jobs.length; k += FETCH_CONCURRENCY) {
        const batch = jobs.slice(k, k + FETCH_CONCURRENCY);
        await Promise.all(batch.map(async (job) => {
          const r = await UsageTracker.fetchOfficialDaily(job.item.token, job.item.uid, job.date);
          if (!r) {
            return; // 失败：该天不写数据不入账，下次补拉
          }
          const models: Record<string, ModelDayStat> = {};
          for (const row of r.rows) {
            const m = String(row.model || 'unknown');
            const cur = models[m] || { credits: 0, count: 0 };
            cur.credits += Number(row.credit || 0);
            cur.count += 1;
            models[m] = cur;
          }
          for (const m of Object.keys(models)) {
            models[m].credits = Math.round(models[m].credits * 100) / 100;
          }
          if (!this.modelStats.days[job.date]) {
            this.modelStats.days[job.date] = {};
          }
          this.modelStats.days[job.date][job.item.id] = models;
          if (job.date !== today) {
            const set = new Set(this.modelStats.syncedDays[job.item.id] || []);
            set.add(job.date);
            this.modelStats.syncedDays[job.item.id] = Array.from(set).sort();
          }
          changed = true;
        }));
      }

      if (changed) {
        this.lastModelStatsTodayTs = now;
        this.saveModelStats();
      }
      return changed;
    } finally {
      this.modelStatsBusy = false;
    }
  }

  /** 模型统计快照（深拷贝），随 postStateToWebview 推给侧栏做过滤渲染 */
  public getModelStatsSnapshot(): ModelStatsSnapshot {
    return {
      days: JSON.parse(JSON.stringify(this.modelStats.days)),
      syncedDays: JSON.parse(JSON.stringify(this.modelStats.syncedDays))
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
      this.dailyStats = { schema: DAILY_STATS_SCHEMA, date: today, consumed: value, grants: 0, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: this.dailyStats.recentRequests, fetchState: {} };
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
      this.dailyStats = { schema: DAILY_STATS_SCHEMA, date: today, consumed: 0, grants: value, perAccountConsumed: {}, perAccountGrants: {}, recentRequests: this.dailyStats.recentRequests, fetchState: {} };
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
