import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as constants from './constants';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { readHostLoginUid } from './hostSession';

const { PATHS } = constants;

/**
 * 模型级 429 冷却的被动记录。
 * 监听宿主日志追加、解析新增行、按 uid + model 加锁原子落盘；
 * 不向服务端发任何探测请求，事件行严格锚定「时间戳 [error] 模块名」行首防对话复述误判。
 */

export interface CooldownEvent {
  modelId: string;
  resetAt: number;
  hitAt: number;
  requestId: string;
}

export interface CooldownEventFile {
  byUid: Record<string, Record<string, CooldownEvent>>;
  seenRequestIds: string[];
  updatedAt: number;
  modelNames: Record<string, string>;
}

export interface ParsedErrorLine {
  code: number;
  model: string;
  message: string;
  requestId: string;
  hitAt: number;
}

const ERROR_MARKER = '[ResultHandler.handleError] errorMessage ';
const USAGE_LOG_MARKER = 'Agent execution successful with usage:';
const EVENT_LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \[error\] \[ResultHandler\.handleError\] errorMessage /;
const RATE_LIMIT_CODE = 6004;
const MAX_SEEN = 200;
const RATE_LIMIT_NOTIFY_MAX_AGE_MS = 5 * 60 * 1000;
const RESET_PATTERN = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?/;
const UID_PATTERNS = [/identity=\{"uid":"([0-9a-f-]{36})"/, /currentUid:\s*([0-9a-f-]{36})/];
const SESSION_DIR_PATTERN = /^\d{8}T\d{6}$/;

/** 把「2026-11-05 22:48:00 UTC+8」换算成 epoch 毫秒；解析不出来必须抛错 */
export function parseResetAt(msg: string): number {
  const m = RESET_PATTERN.exec(msg || '');
  if (!m) throw new Error(`429 响应里没有可解析的重置时刻: ${msg}`);
  const [, ys, mos, ds, hs, mis, ss, sign, offH, offM] = m;
  const offsetMinutes = (Number(offH) * 60 + Number(offM || 0)) * (sign === '+' ? 1 : -1);
  const epoch = Date.UTC(Number(ys), Number(mos) - 1, Number(ds), Number(hs), Number(mis), Number(ss)) - offsetMinutes * 60_000;
  if (!Number.isFinite(epoch)) throw new Error(`429 响应里的重置时刻不是有效时间: ${msg}`);
  return epoch;
}

/** 解析宿主日志 errorMessage 行；非标准 [error] 行首返回 null，损坏 JSON 抛错 */
export function parseErrorLine(line: string): ParsedErrorLine | null {
  if (!EVENT_LINE_RE.test(line)) return null;
  const raw = line.slice(line.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`宿主日志 errorMessage 不是合法 JSON: ${err.message} | ${raw.slice(0, 160)}`);
  }
  const e = obj && obj.error;
  if (!e || typeof e !== 'object') return null;
  return {
    code: Number(e.code),
    model: String(e.model || ''),
    message: String(e.message || ''),
    requestId: String(e.requestId || obj.requestId || ''),
    hitAt: Number(obj.createTime) || Date.now()
  };
}

export function extractUid(line: string): string {
  for (const re of UID_PATTERNS) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return '';
}

function validateCooldownFile(parsed: any): CooldownEventFile {
  if (
    !parsed || typeof parsed !== 'object' ||
    !parsed.byUid || typeof parsed.byUid !== 'object' ||
    !Array.isArray(parsed.seenRequestIds) || typeof parsed.updatedAt !== 'number'
  ) {
    throw new Error('模型冷却记录文件结构异常');
  }
  if (parsed.modelNames !== undefined && (!parsed.modelNames || typeof parsed.modelNames !== 'object')) {
    throw new Error('模型冷却记录里的显示名表结构异常');
  }
  parsed.modelNames = parsed.modelNames || {};
  return parsed as CooldownEventFile;
}

export function loadCooldownEvents(): CooldownEventFile {
  const res = readJsonFileSafe<any>(PATHS.COOLDOWN_EVENTS_FILE);
  if (res.status === 'missing') return { byUid: {}, seenRequestIds: [], updatedAt: 0, modelNames: {} };
  if (res.status === 'error') throw res.error;
  return validateCooldownFile(res.data);
}

function pruneAndSaveCooldownEvents(file: CooldownEventFile): CooldownEventFile {
  const now = Date.now();
  for (const uid of Object.keys(file.byUid)) {
    for (const model of Object.keys(file.byUid[uid])) {
      if (!(file.byUid[uid][model].resetAt > now)) delete file.byUid[uid][model];
    }
    if (Object.keys(file.byUid[uid]).length === 0) delete file.byUid[uid];
  }
  file.seenRequestIds = file.seenRequestIds.slice(-MAX_SEEN);
  file.updatedAt = now;
  atomicWriteJsonSync(PATHS.COOLDOWN_EVENTS_FILE, file, 2);
  return file;
}

function resolveHostLogDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    if (!dir) return;
    const norm = path.resolve(dir);
    if (!seen.has(norm)) { seen.add(norm); dirs.push(dir); }
  };
  try {
    const dataDirs: unknown = typeof (constants as any).resolveHostDataDirs === 'function'
      ? (constants as any).resolveHostDataDirs()
      : null;
    if (Array.isArray(dataDirs)) {
      for (const d of dataDirs) {
        if (typeof d === 'string' && d.trim()) {
          const t = d.trim();
          add(path.basename(t).toLowerCase() === 'logs' ? t : path.join(t, 'logs'));
        }
      }
    }
  } catch { /* fallback below */ }
  add(PATHS.HOST_LOGS_DIR);
  return dirs.length > 0 ? dirs : [PATHS.HOST_LOGS_DIR];
}

export class CooldownLogWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private watchedDirs = new Set<string>();
  private offsets = new Map<string, number>();
  private tails = new Map<string, string>();
  private uids = new Map<string, string>();
  private knownFiles = new Set<string>();
  private pendingFiles = new Set<string>();
  private pendingTimer: NodeJS.Timeout | null = null;
  private started = false;
  private modelNames: Record<string, string> = {};

  public start(): void {
    if (this.started) return;
    this.started = true;
    try {
      const logRoots = resolveHostLogDirs().filter(dir => fs.existsSync(dir));
      if (logRoots.length === 0) {
        console.warn('[BuddyRelay] 宿主日志目录不存在，模型冷却被动记录未启动:', resolveHostLogDirs().join(', '));
        return;
      }
      const sessions = this.collectActiveSessionDirs(logRoots);
      if (sessions.length === 0) {
        console.warn('[BuddyRelay] 宿主日志目录里没有近期会话，模型冷却被动记录未启动:', logRoots.join(', '));
        return;
      }
      this.modelNames = loadCooldownEvents().modelNames;
      for (const dir of sessions) this.refreshLogFiles(dir, true);
    } catch (err: any) {
      console.warn('[BuddyRelay] 模型冷却被动记录启动失败:', err.message);
    }
  }

  private collectActiveSessionDirs(logRoots: string[]): string[] {
    const dirs: string[] = [];
    for (const root of logRoots) {
      try {
        const recent = fs.readdirSync(root).filter(n => SESSION_DIR_PATTERN.test(n)).sort().slice(-4).map(n => path.join(root, n));
        dirs.push(...recent);
      } catch { /* ignore unreadable root */ }
    }
    return dirs;
  }

  private refreshLogFiles(sessionDir: string, isStartup: boolean): void {
    if (!fs.existsSync(sessionDir)) return;
    for (const w of fs.readdirSync(sessionDir)) {
      const dir = path.join(sessionDir, w, 'exthost', 'Tencent-Cloud.coding-copilot');
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.log')) continue;
        const file = path.join(dir, name);
        if (this.knownFiles.has(file)) continue;
        this.knownFiles.add(file);
        try {
          this.consumeFile(file, true, !isStartup);
        } catch (err: any) {
          console.warn('[BuddyRelay] 冷却日志文件初次扫描失败:', file, err.message);
        }
        this.watchFile(file);
      }
    }
  }

  private watchFile(file: string): void {
    const dir = path.dirname(file);
    if (this.watchedDirs.has(dir)) return;
    this.watchedDirs.add(dir);
    try {
      const watcher = fs.watch(dir, (_evt, filename) => {
        if (!filename || filename.endsWith('.log')) {
          this.scheduleConsume(filename ? path.join(dir, filename) : file);
        }
      });
      watcher.on('error', err => console.warn('[BuddyRelay] 冷却日志监听出错:', err));
      this.watchers.push(watcher);
    } catch (err: any) {
      this.watchedDirs.delete(dir);
      console.warn('[BuddyRelay] 冷却日志 watch 启动失败:', err.message);
    }
  }

  private scheduleConsume(file: string): void {
    this.pendingFiles.add(file);
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      try {
        const logRoots = resolveHostLogDirs().filter(dir => fs.existsSync(dir));
        for (const dir of this.collectActiveSessionDirs(logRoots)) this.refreshLogFiles(dir, false);
      } catch (err: any) {
        console.warn('[BuddyRelay] 冷却日志文件扫描失败:', err.message);
      }
      for (const f of files) {
        try {
          if (!this.knownFiles.has(f)) {
            this.knownFiles.add(f);
            this.consumeFile(f, true, true);
          } else {
            this.consumeFile(f, false, true);
          }
        } catch (err: any) {
          console.warn('[BuddyRelay] 冷却日志解析失败:', err.message);
        }
      }
    }, 150);
  }

  private consumeFile(file: string, initial: boolean, allowRateLimitEmit: boolean): void {
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    const START_LIMIT = 2 * 1024 * 1024;
    let prev = this.offsets.get(file);
    if (prev === undefined) prev = initial ? Math.max(0, size - START_LIMIT) : size;
    if (size <= prev) {
      this.offsets.set(file, size);
      return;
    }
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - prev);
    let read = 0;
    try { read = fs.readSync(fd, buf, 0, buf.length, prev); } finally { fs.closeSync(fd); }
    this.offsets.set(file, prev + read);

    const combined = (this.tails.get(file) || '') + buf.subarray(0, read).toString('utf8');
    const lines = combined.split(/\r?\n/);
    const tail = lines.pop() || '';
    this.tails.set(file, tail.length > 16384 ? '' : tail);
    for (const line of lines) this.processLine(file, line, allowRateLimitEmit);
    if (initial && EVENT_LINE_RE.test(tail) && /\}\s*$/.test(tail)) {
      this.processLine(file, tail, allowRateLimitEmit);
      this.tails.set(file, '');
    }
  }

  private processLine(file: string, line: string, allowRateLimitEmit: boolean): void {
    const uid = extractUid(line);
    if (uid) this.uids.set(file, uid);
    this.learnModelName(line);
    if (allowRateLimitEmit && line.includes(USAGE_LOG_MARKER)) {
      this.emit('usageLog', { file, uid: this.uids.get(file) || '' });
    }
    if (!EVENT_LINE_RE.test(line)) return;

    let parsed: ParsedErrorLine | null;
    try {
      parsed = parseErrorLine(line);
    } catch (err: any) {
      console.warn('[BuddyRelay] 宿主 429 事件行解析失败（已跳过，不影响其他行）:', err.message);
      return;
    }
    if (!parsed || parsed.code !== RATE_LIMIT_CODE) return;
    try {
      this.record(parsed, file, allowRateLimitEmit);
    } catch (err: any) {
      console.warn('[BuddyRelay] 429 记录写入失败（已跳过）:', err.message);
    }
  }

  private learnModelName(line: string): void {
    let id = '';
    let name = '';
    const byId = /model=([a-z0-9._-]+) \(([^)]+)\)/i.exec(line);
    const byName = /model: ([A-Za-z0-9._-]+) \(([a-z0-9._-]+)\)/.exec(line);
    if (byId) {
      id = byId[1];
      name = byId[2].trim();
    } else if (byName) {
      name = byName[1].trim();
      id = byName[2];
    }
    if (!id || !name || this.modelNames[id] === name) return;
    this.modelNames[id] = name;
    try {
      withFileLockSync(PATHS.COOLDOWN_EVENTS_FILE, () => {
        const events = loadCooldownEvents();
        events.modelNames = { ...events.modelNames, ...this.modelNames };
        this.modelNames = events.modelNames;
        pruneAndSaveCooldownEvents(events);
      });
    } catch (err: any) {
      console.warn('[BuddyRelay] 模型显示名保存失败:', err.message);
    }
  }

  private record(parsed: ParsedErrorLine, file: string, allowRateLimitEmit: boolean): void {
    let resetAt: number;
    try {
      resetAt = parseResetAt(parsed.message);
    } catch (err: any) {
      console.warn('[BuddyRelay] 429 记录缺少可解析的重置时刻，已跳过:', err.message);
      return;
    }
    let uid = this.uids.get(file) || '';
    if (!uid) {
      try { uid = readHostLoginUid(); } catch (err: any) { console.warn('[BuddyRelay] 读取宿主登录态失败:', err.message); }
    }
    if (!uid || !parsed.model) {
      console.warn(`[BuddyRelay] 429 记录缺少账号或模型标识，已跳过: uid=${uid || '未知'} model=${parsed.model || '未知'}`);
      return;
    }

    const updated = withFileLockSync<CooldownEventFile | null>(PATHS.COOLDOWN_EVENTS_FILE, () => {
      const events = loadCooldownEvents();
      if (parsed.requestId && events.seenRequestIds.includes(parsed.requestId)) return null;
      events.byUid[uid] = events.byUid[uid] || {};
      events.byUid[uid][parsed.model] = { modelId: parsed.model, resetAt, hitAt: parsed.hitAt, requestId: parsed.requestId };
      if (parsed.requestId) events.seenRequestIds.push(parsed.requestId);
      events.modelNames = { ...events.modelNames, ...this.modelNames };
      this.modelNames = events.modelNames;
      return pruneAndSaveCooldownEvents(events);
    });
    if (!updated) return;

    this.emit('change', updated);

    const now = Date.now();
    const ageMs = now - parsed.hitAt;
    if (allowRateLimitEmit && ageMs <= RATE_LIMIT_NOTIFY_MAX_AGE_MS && ageMs >= -RATE_LIMIT_NOTIFY_MAX_AGE_MS && resetAt > now) {
      this.emit('rateLimit', { uid, model: parsed.model, resetAt, hitAt: parsed.hitAt });
    }
  }

  public stop(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* 已关闭 */ }
    }
    this.watchers = [];
    this.watchedDirs.clear();
    this.knownFiles.clear();
    this.offsets.clear();
    this.tails.clear();
    this.uids.clear();
    this.pendingFiles.clear();
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    this.started = false;
  }
}
