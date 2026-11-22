import * as path from 'path';
import { PATHS } from './constants';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { CodeBuddyAccount, resolveAccountDisplayName } from './accountStore';
import { todayCN } from './checkinService';
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
  source?: 'snapshot' | 'action';
  seq?: number;
}

export interface DailySummary {
  date: string;
  totalConsumed: number;
  totalAwarded: number;
  switchCount: number;
  perAccountConsumed: Record<string, number>;
  perAccountGrants: Record<string, number>;
}

export interface ModelDayStat { credits: number; count: number; }
export type ModelStatsDays = Record<string, Record<string, Record<string, ModelDayStat>>>;
export interface ModelStatsSnapshot { days: ModelStatsDays; syncedDays: Record<string, string[]>; }

export interface DailyStats {
  schema: number;
  date: string;
  consumed: number;
  grants: number;
  perAccountConsumed: Record<string, number>;
  perAccountGrants: Record<string, number>;
  recentRequests: Array<{
    requestId: string;
    accountId: string;
    credit: number;
    model: string;
    client: string;
    requestTime: string;
  }>;
  fetchState: Record<string, { ts: number; fails: number }>;
}

const DAILY_STATS_SCHEMA = 3;
const AUTO_FETCH_GAP_MS = 180_000;
const FORCE_FETCH_GAP_MS = 10_000;
const FAIL_BACKOFF_BASE_MS = 30_000;
const FAIL_BACKOFF_MAX_MS = 600_000;
const FETCH_CONCURRENCY = 2;
const OFFICIAL_MAX_PAGES = 25;
const MODEL_STATS_SCHEMA = 1;
const MODEL_STATS_MAX_DAYS = 7;
const MAX_RECORDS = 1000;
const CN_OFFSET_MS = 8 * 3600 * 1000;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const sumValues = (map: Record<string, number>): number =>
  round2(Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0));

function createEmptyDailyStats(date: string = ''): DailyStats {
  return {
    schema: DAILY_STATS_SCHEMA, date, consumed: 0, grants: 0,
    perAccountConsumed: {}, perAccountGrants: {}, recentRequests: [], fetchState: {}
  };
}

function mergeNumericMap(target: Record<string, number>, disk: Record<string, number>, dirtyIds: Set<string>): void {
  for (const [k, v] of Object.entries(disk)) {
    if (!dirtyIds.has(k) && typeof v === 'number') target[k] = v;
  }
}

/** 算力流水对账与调度审计追踪引擎 */
export class UsageTracker {
  private filePath: string;
  private records: UsageRecord[] = [];
  private lastCreditsMap: Map<string, number> = new Map();
  private switchTimestamps: number[] = [];
  private _seq: number = 0;
  private dailyStatsPath: string;
  private dailyStats: DailyStats = createEmptyDailyStats();
  private dirtyDailyIds: Set<string> = new Set();
  private dailyManualOverride: { consumed?: boolean; grants?: boolean; reset?: boolean } = {};
  private modelStatsPath: string;
  private modelStats: ModelStatsSnapshot = { days: {}, syncedDays: {} };
  private dirtyModelKeys: Set<string> = new Set();
  private modelStatsBusy: boolean = false;
  private lastModelStatsTodayTs: number = 0;
  private inFlight: Set<string> = new Set();
  private lastBalances: Map<string, number> = new Map();
  private changeListeners: Array<() => void> = [];

  public onChange(listener: () => void): () => void {
    this.changeListeners.push(listener);
    return () => { this.changeListeners = this.changeListeners.filter((fn) => fn !== listener); };
  }

  private notifyChange(): void {
    for (const fn of this.changeListeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  constructor(customFilePath?: string) {
    this.filePath = customFilePath || path.join(PATHS.RELAY_DIR, 'usage-records.json');
    this.dailyStatsPath = path.join(path.dirname(this.filePath), 'daily-stats.json');
    this.modelStatsPath = path.join(path.dirname(this.filePath), 'model-stats.json');
    this.load();
    this.loadDailyStats();
    this.loadModelStats();
  }

  private formatTime(ts: number): { timeStr: string; dateStr: string } {
    const iso = new Date(ts + CN_OFFSET_MS).toISOString();
    return { dateStr: iso.slice(0, 10), timeStr: iso.slice(11, 19) };
  }

  private load(): void {
    const res = readJsonFileSafe<{ records?: UsageRecord[] }>(this.filePath);
    if (res.status === 'ok' && Array.isArray(res.data?.records)) {
      this.records = res.data.records;
      this._seq = this.records.reduce((max, r) => Math.max(max, r.seq || 0), 0);
    } else {
      this.records = [];
    }
  }

  private parseDailyStats(data: any): DailyStats | null {
    if (!data || typeof data !== 'object' || typeof data.date !== 'string') return null;
    if (data.schema !== 2 && data.schema !== DAILY_STATS_SCHEMA) return null;
    return {
      schema: DAILY_STATS_SCHEMA,
      date: data.date,
      consumed: typeof data.consumed === 'number' ? data.consumed : 0,
      grants: typeof data.grants === 'number' ? data.grants : 0,
      perAccountConsumed: data.perAccountConsumed && typeof data.perAccountConsumed === 'object' ? { ...data.perAccountConsumed } : {},
      perAccountGrants: data.perAccountGrants && typeof data.perAccountGrants === 'object' ? { ...data.perAccountGrants } : {},
      recentRequests: Array.isArray(data.recentRequests) ? [...data.recentRequests] : [],
      fetchState: data.fetchState && typeof data.fetchState === 'object' ? { ...data.fetchState } : {}
    };
  }

  private loadDailyStats(): void {
    const res = readJsonFileSafe<DailyStats>(this.dailyStatsPath);
    if (res.status === 'ok') {
      const parsed = this.parseDailyStats(res.data);
      if (parsed) this.dailyStats = parsed;
    }
  }

  private saveDailyStats(): void {
    try {
      const dirtyIds = new Set(this.dirtyDailyIds);
      const overrides = { ...this.dailyManualOverride };
      this.dirtyDailyIds.clear();
      this.dailyManualOverride = {};

      withFileLockSync(this.dailyStatsPath, () => {
        const res = readJsonFileSafe<DailyStats>(this.dailyStatsPath);
        const disk = res.status === 'ok' ? this.parseDailyStats(res.data) : null;
        if (!overrides.reset && disk && disk.date === this.dailyStats.date) {
          if (!overrides.consumed) mergeNumericMap(this.dailyStats.perAccountConsumed, disk.perAccountConsumed, dirtyIds);
          if (!overrides.grants) mergeNumericMap(this.dailyStats.perAccountGrants, disk.perAccountGrants, dirtyIds);
          for (const [k, st] of Object.entries(disk.fetchState)) {
            if (!st || typeof st !== 'object') continue;
            const cur = this.dailyStats.fetchState[k];
            if (!cur || Number(st.ts || 0) > Number(cur.ts || 0)) {
              this.dailyStats.fetchState[k] = { ts: Number(st.ts || 0), fails: Number(st.fails || 0) };
            }
          }
          const byReq = new Map<string, DailyStats['recentRequests'][number]>();
          for (const r of disk.recentRequests) if (r?.requestId) byReq.set(r.requestId, r);
          for (const r of this.dailyStats.recentRequests) if (r?.requestId) byReq.set(r.requestId, r);
          this.dailyStats.recentRequests = Array.from(byReq.values())
            .sort((a, b) => String(b.requestTime || '').localeCompare(String(a.requestTime || '')))
            .slice(0, 200);

          if (!overrides.consumed) {
            if (Object.keys(this.dailyStats.perAccountConsumed).length > 0) {
              this.dailyStats.consumed = sumValues(this.dailyStats.perAccountConsumed);
            } else if (disk.consumed > 0 && this.dailyStats.consumed === 0) {
              this.dailyStats.consumed = disk.consumed;
            }
          }
          if (!overrides.grants) {
            if (Object.keys(this.dailyStats.perAccountGrants).length > 0) {
              this.dailyStats.grants = sumValues(this.dailyStats.perAccountGrants);
            } else if (disk.grants > 0 && this.dailyStats.grants === 0) {
              this.dailyStats.grants = disk.grants;
            }
          }
        }
        atomicWriteJsonSync(this.dailyStatsPath, this.dailyStats);
      });
      this.notifyChange();
    } catch (err: any) {
      console.warn('[UsageTracker] 保存今日统计失败:', err.message);
    }
  }

  public detectChangedAccounts(items: Array<{ id: string; credits: number }>): string[] {
    const today = todayCN();
    const changedIds: string[] = [];
    let valid = false;

    for (const item of items) {
      if (!item?.id || typeof item.credits !== 'number' || !isFinite(item.credits)) continue;
      valid = true;
      const prev = this.lastBalances.get(item.id);
      if (prev === undefined || Math.abs(prev - item.credits) >= 0.01) changedIds.push(item.id);
      this.lastBalances.set(item.id, item.credits);
    }
    if (!valid) return [];

    if (this.dailyStats.date !== today) {
      this.dailyStats = createEmptyDailyStats(today);
      this.dailyManualOverride.reset = true;
      this.saveDailyStats();
      return items.filter((i) => i && typeof i.credits === 'number').map((i) => i.id);
    }
    return changedIds;
  }

  public async refreshOfficialStats(
    items: Array<{ id: string; token: string; uid: string }>,
    opts?: { force?: boolean }
  ): Promise<boolean> {
    this.loadDailyStats();
    const now = Date.now();
    const gap = opts?.force === true ? FORCE_FETCH_GAP_MS : AUTO_FETCH_GAP_MS;

    const valid = (items || []).filter((i) => {
      if (!i?.id || !i.token || !i.uid || this.inFlight.has(i.id)) return false;
      const st = this.dailyStats.fetchState[i.id];
      const last = st ? Number(st.ts || 0) : 0;
      if (now - last < gap) return false;
      const fails = st ? Number(st.fails || 0) : 0;
      if (fails > 0 && now - last < Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_BASE_MS * Math.pow(2, fails - 1))) {
        return false;
      }
      return true;
    });
    if (!valid.length) return false;
    valid.forEach((i) => this.inFlight.add(i.id));

    try {
      const results: Array<{ consumed: number; grants: number; rows: Array<Record<string, any>> } | null> = [];
      for (let k = 0; k < valid.length; k += FETCH_CONCURRENCY) {
        const batch = valid.slice(k, k + FETCH_CONCURRENCY);
        results.push(...(await Promise.all(batch.map((i) => UsageTracker.fetchOfficialDaily(i.token, i.uid)))));
      }

      const today = todayCN();
      if (this.dailyStats.date !== today) {
        const prevFetchState = this.dailyStats.fetchState;
        this.dailyStats = createEmptyDailyStats(today);
        this.dailyStats.fetchState = prevFetchState;
        this.dailyManualOverride.reset = true;
      }

      let failedCount = 0;
      const seen = new Set(this.dailyStats.recentRequests.map((x) => x.requestId));
      for (let i = 0; i < valid.length; i++) {
        const r = results[i];
        this.dirtyDailyIds.add(valid[i].id);
        if (!r) {
          failedCount++;
          const prevFails = this.dailyStats.fetchState[valid[i].id]?.fails || 0;
          this.dailyStats.fetchState[valid[i].id] = { ts: now, fails: Math.min(10, prevFails + 1) };
          continue;
        }
        this.dailyStats.fetchState[valid[i].id] = { ts: now, fails: 0 };
        this.dailyStats.perAccountConsumed[valid[i].id] = r.consumed;
        this.dailyStats.perAccountGrants[valid[i].id] = r.grants;

        for (const row of r.rows) {
          if (!row.requestId || seen.has(row.requestId)) continue;
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

      const totalConsumed = sumValues(this.dailyStats.perAccountConsumed);
      const totalGrants = sumValues(this.dailyStats.perAccountGrants);
      const changed =
        Math.abs(this.dailyStats.consumed - totalConsumed) >= 0.01 ||
        Math.abs(this.dailyStats.grants - totalGrants) >= 0.01 ||
        failedCount > 0;
      this.dailyStats.consumed = totalConsumed;
      this.dailyStats.grants = totalGrants;
      this.saveDailyStats();
      return changed;
    } finally {
      valid.forEach((i) => this.inFlight.delete(i.id));
    }
  }

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
    const todayStr = todayCN();
    const dateStr = targetDate || todayStr;
    const dayStart = new Date(`${dateStr}T00:00:00+08:00`).getTime();
    const dayEnd = dayStart + 86400_000;

    let consumedSum = 0;
    const allRows: Array<Record<string, any>> = [];
    let pageNum = 1;
    try {
      for (let page = 0; page < OFFICIAL_MAX_PAGES; page++) {
        const res = await fetch('https://www.codebuddy.cn/billing/meter/get-user-request-usage', {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            startTime: dateStr + ' 00:00:00',
            endTime: dateStr + ' 23:59:59',
            pageNum,
            pageSize: 200
          })
        });
        if (!res.ok) return null;
        const json: any = await res.json().catch(() => null);
        if (!json || json.code !== 0 || !json.data) return null;
        const rows: Array<Record<string, any>> = json.data.data || [];
        consumedSum += rows.reduce((s, r) => s + Number(r.credit || 0), 0);
        allRows.push(...rows);
        if (pageNum * 200 >= Number(json.data.total || 0) || rows.length === 0) break;
        pageNum++;
      }
    } catch {
      return null;
    }

    let grantsSum = 0;
    if (dateStr === todayStr) {
      try {
        const res = await fetch('https://www.codebuddy.cn/v2/billing/meter/get-user-resource', {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] })
        });
        if (res.ok) {
          const json: any = await res.json().catch(() => null);
          const packs = json?.data?.Response?.Data?.Accounts || [];
          for (const p of packs) {
            const ct = Number(p.CreateTime || 0);
            if (ct >= dayStart && ct < dayEnd) grantsSum += Number(p.CapacitySize || 0);
          }
        }
      } catch {
        // 查包失败不阻断
      }
    }

    return { consumed: round2(consumedSum), grants: round2(grantsSum), rows: allRows };
  }

  private parseModelStats(data: any, cutoff: string): ModelStatsSnapshot | null {
    if (!data || data.schema !== MODEL_STATS_SCHEMA || !data.days || typeof data.days !== 'object') return null;
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
        syncedDays[acc] = list.filter((d): d is string => typeof d === 'string' && d >= cutoff);
      }
    }
    return { days, syncedDays };
  }

  private loadModelStats(): void {
    const res = readJsonFileSafe<any>(this.modelStatsPath);
    if (res.status !== 'ok') return;
    const cutoff = this.formatTime(Date.now() - (MODEL_STATS_MAX_DAYS - 1) * 86400_000).dateStr;
    const parsed = this.parseModelStats(res.data, cutoff);
    if (parsed) this.modelStats = parsed;
  }

  private saveModelStats(): void {
    try {
      const dirtyKeys = new Set(this.dirtyModelKeys);
      this.dirtyModelKeys.clear();
      const cutoff = this.formatTime(Date.now() - (MODEL_STATS_MAX_DAYS - 1) * 86400_000).dateStr;

      withFileLockSync(this.modelStatsPath, () => {
        const res = readJsonFileSafe<any>(this.modelStatsPath);
        const disk = res.status === 'ok' ? this.parseModelStats(res.data, cutoff) : null;
        if (disk) {
          for (const [date, accMap] of Object.entries(disk.days)) {
            if (!this.modelStats.days[date]) this.modelStats.days[date] = {};
            for (const [accId, models] of Object.entries(accMap)) {
              if (!dirtyKeys.has(`${date}::${accId}`)) this.modelStats.days[date][accId] = models;
            }
          }
          for (const [accId, dates] of Object.entries(disk.syncedDays)) {
            const merged = new Set([...(this.modelStats.syncedDays[accId] || []), ...dates]);
            this.modelStats.syncedDays[accId] = Array.from(merged).filter(d => d >= cutoff).sort();
          }
        }
        atomicWriteJsonSync(this.modelStatsPath, {
          schema: MODEL_STATS_SCHEMA, savedAt: Date.now(), days: this.modelStats.days, syncedDays: this.modelStats.syncedDays
        });
      });
    } catch (err: any) {
      console.warn('[UsageTracker] 保存模型统计失败:', err.message);
    }
  }

  public async refreshModelStats(
    items: Array<{ id: string; token: string; uid: string }>,
    opts?: { days?: number; force?: boolean }
  ): Promise<boolean> {
    if (this.modelStatsBusy) return false;
    this.loadModelStats();
    const wantDays = Math.min(MODEL_STATS_MAX_DAYS, Math.max(1, Math.floor(opts?.days ?? MODEL_STATS_MAX_DAYS)));
    const force = opts?.force === true;
    const now = Date.now();
    const today = todayCN();
    const wantDates = Array.from({ length: wantDays }, (_, i) => this.formatTime(now - i * 86400_000).dateStr);
    const todayBlocked = now - this.lastModelStatsTodayTs < (force ? FORCE_FETCH_GAP_MS : AUTO_FETCH_GAP_MS);
    const valid = (items || []).filter((i) => i?.id && i.token && i.uid);
    const jobs: Array<{ item: { id: string; token: string; uid: string }; date: string }> = [];
    for (const item of valid) {
      const synced = new Set(this.modelStats.syncedDays[item.id] || []);
      for (const date of wantDates) {
        if (date === today ? !todayBlocked : !synced.has(date)) jobs.push({ item, date });
      }
    }
    if (!jobs.length) return false;

    this.modelStatsBusy = true;
    try {
      let changed = false;
      for (let k = 0; k < jobs.length; k += FETCH_CONCURRENCY) {
        const batch = jobs.slice(k, k + FETCH_CONCURRENCY);
        await Promise.all(batch.map(async (job) => {
          const r = await UsageTracker.fetchOfficialDaily(job.item.token, job.item.uid, job.date);
          if (!r) return;
          const models: Record<string, ModelDayStat> = {};
          for (const row of r.rows) {
            const m = String(row.model || 'unknown');
            const cur = models[m] || { credits: 0, count: 0 };
            cur.credits += Number(row.credit || 0);
            cur.count += 1;
            models[m] = cur;
          }
          for (const m of Object.keys(models)) models[m].credits = round2(models[m].credits);
          if (!this.modelStats.days[job.date]) this.modelStats.days[job.date] = {};
          this.modelStats.days[job.date][job.item.id] = models;
          this.dirtyModelKeys.add(`${job.date}::${job.item.id}`);
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

  public getModelStatsSnapshot(): ModelStatsSnapshot {
    return {
      days: JSON.parse(JSON.stringify(this.modelStats.days)),
      syncedDays: JSON.parse(JSON.stringify(this.modelStats.syncedDays))
    };
  }

  public getRecentOfficialRequests(limit: number = 25): Array<Record<string, any>> {
    if (this.dailyStats.date !== todayCN()) return [];
    return this.dailyStats.recentRequests.slice(0, limit);
  }

  private saveRecords(replaceAll: boolean = false): void {
    try {
      withFileLockSync(this.filePath, () => {
        if (!replaceAll) {
          const disk = readJsonFileSafe<{ records?: UsageRecord[] }>(this.filePath);
          if (disk.status === 'ok' && Array.isArray(disk.data?.records)) {
            const byId = new Map<string, UsageRecord>();
            for (const r of disk.data.records) if (r?.id) byId.set(r.id, r);
            for (const r of this.records) if (r?.id) byId.set(r.id, r);
            this.records = Array.from(byId.values())
              .sort((a, b) => (a.ts - b.ts) || ((a.seq || 0) - (b.seq || 0)))
              .slice(-MAX_RECORDS);
            this._seq = this.records.reduce((max, r) => Math.max(max, r.seq || 0), this._seq);
          }
        }
        if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS);
        atomicWriteJsonSync(this.filePath, { version: '1.0', updatedAt: Date.now(), records: this.records });
      });
    } catch (err: any) {
      console.warn('[UsageTracker] 保存流水记录失败:', err.message);
    }
  }

  public recordSnapshot(account: CodeBuddyAccount, newCredits: number, source: string = t('ut.snapshotSource')): void {
    const aid = account.id || account.uid;
    const name = resolveAccountDisplayName(account);
    const prev = this.lastCreditsMap.get(aid);
    this.lastCreditsMap.set(aid, newCredits);
    if (prev === undefined) return;

    const delta = round2(newCredits - prev);
    if (Math.abs(delta) < 0.05) return;

    const ts = Date.now();
    const { timeStr, dateStr } = this.formatTime(ts);
    const isConsume = delta < 0;
    this.records.push({
      id: `rec_${ts}_${++this._seq}`,
      seq: this._seq,
      ts,
      timeStr,
      dateStr,
      type: isConsume ? 'consume' : 'reward',
      accountId: aid,
      accountName: name,
      deltaCredits: delta,
      balanceAfter: newCredits,
      title: isConsume ? t('ut.consumeTitle') : t('ut.gainTitle'),
      detail: isConsume ? t('ut.consumeDetail', source, delta, newCredits) : t('ut.gainDetail', source, delta, newCredits)
    });
    this.saveRecords();
  }

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
    this.records.push({ id: `rec_${ts}_${++this._seq}`, seq: this._seq, ts, timeStr, dateStr, ...entry });
    if (entry.type === 'switch') this.switchTimestamps.push(ts);
    this.saveRecords();
  }

  public getRecentSwitchCount(windowMs: number = 60_000): number {
    const now = Date.now();
    this.switchTimestamps = this.switchTimestamps.filter(ts => now - ts <= windowMs);
    return this.switchTimestamps.length;
  }

  public getRecentRecords(limit: number = 50): UsageRecord[] {
    return [...this.records].sort((a, b) => (b.ts - a.ts) || ((b.seq || 0) - (a.seq || 0))).slice(0, limit);
  }

  public getDailySummary(activeAccountCount: number = 0, targetDate?: string): DailySummary {
    const today = targetDate || todayCN();
    const sameDay = this.dailyStats.date === today;
    const switchCount = this.records.filter(r => r.dateStr === today && r.type === 'switch').length;
    const consumed = sameDay ? this.dailyStats.consumed : 0;
    const grants = sameDay ? this.dailyStats.grants : 0;
    const perAccountConsumed = sameDay ? { ...this.dailyStats.perAccountConsumed } : {};
    const perAccountGrants = sameDay ? { ...this.dailyStats.perAccountGrants } : {};

    const firstDayBonus = today.slice(8, 10) === '01' ? Math.max(0, activeAccountCount) * 500 : 0;
    return {
      date: today,
      totalConsumed: sameDay ? round2(consumed) : 0,
      totalAwarded: round2(grants + firstDayBonus),
      switchCount,
      perAccountConsumed,
      perAccountGrants
    };
  }

  private updateManualDailyField(field: 'consumed' | 'grants', total: number): void {
    const today = todayCN();
    const value = round2(total);
    if (this.dailyStats.date !== today) {
      this.dailyStats = createEmptyDailyStats(today);
      this.dailyManualOverride.reset = true;
    }
    this.dailyStats[field] = value;
    if (field === 'consumed') {
      this.dailyStats.perAccountConsumed = {};
      this.dailyManualOverride.consumed = true;
    } else {
      this.dailyStats.perAccountGrants = {};
      this.dailyManualOverride.grants = true;
    }
    this.saveDailyStats();
  }

  public updateTodayConsumed(total: number): void {
    this.updateManualDailyField('consumed', total);
  }

  public updateTodayGrants(total: number): void {
    this.updateManualDailyField('grants', total);
  }

  public clearRecords(): void {
    this.records = [];
    this.saveRecords(true);
  }
}
