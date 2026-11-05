import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';
import { readHostLoginUid } from './hostSession';

/**
 * 模型级 429 冷却的被动记录。
 *
 * 宿主在聊天真的撞到限流时，会往扩展宿主日志追加一行：
 *   [error] [ResultHandler.handleError] errorMessage {"...","error":{"code":6004,
 *     "message":"…将在 YYYY-MM-DD HH:mm:ss UTC+8 重置…","model":"deepseek-v4.1-flash",
 *     "requestId":"…"},"createTime":…}
 * 日志里另有 identity={"uid":"…"} / currentUid: … 标记当前窗口登录账号。
 *
 * 因此这里只监听日志文件追加、解析新增行、按 uid + model 落盘，
 * 不向服务端发任何探测请求，也不轮询账号。宿主日志格式若变化，解析失败会显式报错。
 *
 * 2026-11-05 死循环事故：genie 会话会把聊天内容（含我们回复里的日志示例文本）原样写进
 * 这份日志，仅用「行内包含 errorMessage 标记」判断会把对话复述行误判成 429 事件，
 * 解析抛错未被隔离 → uncaughtException → 扩展宿主崩溃重启 → 重新全量扫描又撞同一条 → 循环。
 * 因此事件行必须锚定「时间戳 [error] 模块名」的完整行首格式，且所有解析错误只打日志、绝不冒泡。
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
  /** 模型 ID → 宿主展示名（如 deepseek-v4.1-flash → Deepseek-V4.1-Flash），从日志在线学习 */
  modelNames: Record<string, string>;
}

const ERROR_MARKER = '[ResultHandler.handleError] errorMessage ';
/** 事件行的完整行首锚定：对话复述的示例文本（[info]/markdown/工具参数）一律不匹配。 */
const EVENT_LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \[error\] \[ResultHandler\.handleError\] errorMessage /;
const RATE_LIMIT_CODE = 6004;
const MAX_SEEN = 200;
const RESET_PATTERN = /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?/;
const UID_PATTERNS = [/identity=\{"uid":"([0-9a-f-]{36})"/, /currentUid:\s*([0-9a-f-]{36})/];
const SESSION_DIR_PATTERN = /^\d{8}T\d{6}$/;

export interface ParsedErrorLine {
  code: number;
  model: string;
  message: string;
  requestId: string;
  hitAt: number;
}

/** 把「2026-11-05 22:48:00 UTC+8」换算成 epoch 毫秒；解析不出来必须抛错，绝不猜冷却时长。 */
export function parseResetAt(msg: string): number {
  const m = RESET_PATTERN.exec(msg || '');
  if (!m) {
    throw new Error(`429 响应里没有可解析的重置时刻: ${msg}`);
  }
  const [, ys, mos, ds, hs, mis, ss, sign, offH, offM] = m;
  const offsetMinutes = (Number(offH) * 60 + Number(offM || 0)) * (sign === '+' ? 1 : -1);
  const epoch = Date.UTC(
    Number(ys), Number(mos) - 1, Number(ds),
    Number(hs), Number(mis), Number(ss)
  ) - offsetMinutes * 60_000;
  if (!Number.isFinite(epoch)) {
    throw new Error(`429 响应里的重置时刻不是有效时间: ${msg}`);
  }
  return epoch;
}

/** 解析宿主日志里的 errorMessage 行；行首不是标准 [error] 事件格式（含对话复述文本）一律返回 null，
 *  JSON 损坏则抛错暴露——但调用方必须捕获隔离，绝不允许解析错误终止扩展宿主。 */
export function parseErrorLine(line: string): ParsedErrorLine | null {
  if (!EVENT_LINE_RE.test(line)) {
    return null;
  }
  const raw = line.slice(line.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`宿主日志 errorMessage 不是合法 JSON: ${err.message} | ${raw.slice(0, 160)}`);
  }
  const e = obj && obj.error;
  if (!e || typeof e !== 'object') {
    return null;
  }
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
    if (m) {
      return m[1];
    }
  }
  return '';
}

export function loadCooldownEvents(): CooldownEventFile {
  if (!fs.existsSync(PATHS.COOLDOWN_EVENTS_FILE)) {
    return { byUid: {}, seenRequestIds: [], updatedAt: 0, modelNames: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(PATHS.COOLDOWN_EVENTS_FILE, 'utf8'));
  if (
    !parsed || typeof parsed !== 'object' ||
    !parsed.byUid || typeof parsed.byUid !== 'object' ||
    !Array.isArray(parsed.seenRequestIds) || typeof parsed.updatedAt !== 'number'
  ) {
    throw new Error('模型冷却记录文件结构异常');
  }
  // 旧版本文件没有 modelNames 字段，按空表迁移；结构非法仍按损坏处理
  if (parsed.modelNames !== undefined && (!parsed.modelNames || typeof parsed.modelNames !== 'object')) {
    throw new Error('模型冷却记录里的显示名表结构异常');
  }
  parsed.modelNames = parsed.modelNames || {};
  return parsed as CooldownEventFile;
}

function saveCooldownEvents(file: CooldownEventFile): void {
  const now = Date.now();
  for (const uid of Object.keys(file.byUid)) {
    for (const model of Object.keys(file.byUid[uid])) {
      if (!(file.byUid[uid][model].resetAt > now)) {
        delete file.byUid[uid][model];
      }
    }
    if (Object.keys(file.byUid[uid]).length === 0) {
      delete file.byUid[uid];
    }
  }
  file.seenRequestIds = file.seenRequestIds.slice(-MAX_SEEN);
  file.updatedAt = now;
  fs.mkdirSync(path.dirname(PATHS.COOLDOWN_EVENTS_FILE), { recursive: true });
  const tmp = `${PATHS.COOLDOWN_EVENTS_FILE}.tmp_${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  fs.renameSync(tmp, PATHS.COOLDOWN_EVENTS_FILE);
}

export class CooldownLogWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = [];
  private offsets = new Map<string, number>();
  private tails = new Map<string, string>();
  private uids = new Map<string, string>();
  private knownFiles = new Set<string>();
  private pendingFiles = new Set<string>();
  private pendingTimer: NodeJS.Timeout | null = null;
  private started = false;
  private modelNames: Record<string, string> = {};

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      const root = PATHS.HOST_LOGS_DIR;
      if (!fs.existsSync(root)) {
        console.warn('[BuddyRelay] 宿主日志目录不存在，模型冷却被动记录未启动:', root);
        return;
      }
      const sessions = this.activeSessionDirs();
      if (sessions.length === 0) {
        console.warn('[BuddyRelay] 宿主日志目录里没有近期会话，模型冷却被动记录未启动:', root);
        return;
      }
      this.modelNames = loadCooldownEvents().modelNames;
      for (const dir of sessions) {
        this.refreshLogFiles(dir);
      }
    } catch (err: any) {
      // 监听器是辅助能力：扫描失败只降级为不可用并暴露，绝不允许拖垮扩展激活
      console.warn('[BuddyRelay] 模型冷却被动记录启动失败:', err.message);
    }
  }

  /** 最近 4 次启动的会话（多窗口 / 未重启的旧窗口都要覆盖）。
   *  按目录名时间戳取，不能用目录 mtime：日志写在深层子目录，父目录 mtime 不会随追加更新。 */
  private activeSessionDirs(): string[] {
    const root = PATHS.HOST_LOGS_DIR;
    return fs.readdirSync(root)
      .filter(n => SESSION_DIR_PATTERN.test(n))
      .sort()
      .slice(-4)
      .map(n => path.join(root, n));
  }

  /** 扫描当前会话所有窗口日志；新出现的窗口文件在后续事件里也能被发现。 */
  private refreshLogFiles(sessionDir: string): void {
    if (!fs.existsSync(sessionDir)) {
      return;
    }
    for (const w of fs.readdirSync(sessionDir)) {
      const dir = path.join(sessionDir, w, 'exthost', 'Tencent-Cloud.coding-copilot');
      if (!fs.existsSync(dir)) {
        continue;
      }
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.log')) {
          continue;
        }
        const file = path.join(dir, name);
        if (this.knownFiles.has(file)) {
          continue;
        }
        this.knownFiles.add(file);
        try {
          this.consumeFile(file, true);
        } catch (err: any) {
          // 单个文件损坏不拖累其他窗口的监听
          console.warn('[BuddyRelay] 冷却日志文件初次扫描失败:', file, err.message);
        }
        this.watchFile(file);
      }
    }
  }

  private watchFile(file: string): void {
    try {
      const watcher = fs.watch(path.dirname(file), (_evt, filename) => {
        if (!filename || filename === path.basename(file) || filename.endsWith('.log')) {
          this.scheduleConsume(file);
        }
      });
      watcher.on('error', err => console.warn('[BuddyRelay] 冷却日志监听出错:', err));
      this.watchers.push(watcher);
    } catch (err: any) {
      console.warn('[BuddyRelay] 冷却日志 watch 启动失败:', err.message);
    }
  }

  private scheduleConsume(file: string): void {
    this.pendingFiles.add(file);
    if (this.pendingTimer) {
      return;
    }
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const files = Array.from(this.pendingFiles);
      this.pendingFiles.clear();
      try {
        if (fs.existsSync(PATHS.HOST_LOGS_DIR)) {
          for (const dir of this.activeSessionDirs()) {
            this.refreshLogFiles(dir);
          }
        }
      } catch (err: any) {
        // 这里的异常若冒泡会成为 uncaughtException 直接杀死扩展宿主（2026-11-05 死循环事故）
        console.warn('[BuddyRelay] 冷却日志文件扫描失败:', err.message);
      }
      for (const f of files) {
        try {
          this.consumeFile(f, false);
        } catch (err: any) {
          console.warn('[BuddyRelay] 冷却日志解析失败:', err.message);
        }
      }
    }, 150);
  }

  /** 只读上次 offset 之后的新增字节；尾部不完整的半行留到下次拼接。
   *  首次扫描只读尾部 2MB：扩展宿主反复重启时每次都会全量重扫，必须把同步 IO 压到最低。 */
  private consumeFile(file: string, initial: boolean): void {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const START_LIMIT = 2 * 1024 * 1024;
    let prev = this.offsets.get(file);
    if (prev === undefined) {
      prev = initial ? Math.max(0, size - START_LIMIT) : size;
    }
    if (size <= prev) {
      this.offsets.set(file, size);
      return;
    }
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - prev);
    let read = 0;
    try {
      read = fs.readSync(fd, buf, 0, buf.length, prev);
    } finally {
      fs.closeSync(fd);
    }
    this.offsets.set(file, prev + read);

    const combined = (this.tails.get(file) || '') + buf.subarray(0, read).toString('utf8');
    const lines = combined.split(/\r?\n/);
    const tail = lines.pop() || '';
    this.tails.set(file, tail.length > 16384 ? '' : tail);
    for (const line of lines) {
      this.processLine(file, line);
    }
    // 首次扫描时，文件末尾若恰好是一条完整但无换行符的 429 行，立即补记
    if (initial && EVENT_LINE_RE.test(tail) && /\}\s*$/.test(tail)) {
      this.processLine(file, tail);
      this.tails.set(file, '');
    }
  }

  private processLine(file: string, line: string): void {
    const uid = extractUid(line);
    if (uid) {
      this.uids.set(file, uid);
    }
    this.learnModelName(line);
    if (!EVENT_LINE_RE.test(line)) {
      return;
    }
    let parsed: ParsedErrorLine | null;
    try {
      parsed = parseErrorLine(line);
    } catch (err: any) {
      console.warn('[BuddyRelay] 宿主 429 事件行解析失败（已跳过，不影响其他行）:', err.message);
      return;
    }
    if (!parsed || parsed.code !== RATE_LIMIT_CODE) {
      return;
    }
    try {
      this.record(parsed, file);
    } catch (err: any) {
      console.warn('[BuddyRelay] 429 记录写入失败（已跳过）:', err.message);
    }
  }

  /**
   * 从日志在线学习「模型 ID → 展示名」，两种形态都见过：
   *   [FillToolCallContent] model=deepseek-v4.1-flash (Deepseek-V4.1-Flash)
   *   [CraftInvokableAgent] Preparing model: Deepseek-V4.1-Flash (deepseek-v4.1-flash)
   * 学不到就回退显示 ID 本身，不编造名字。
   */
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
    if (!id || !name || this.modelNames[id] === name) {
      return;
    }
    this.modelNames[id] = name;
    try {
      const events = loadCooldownEvents();
      events.modelNames = this.modelNames;
      saveCooldownEvents(events);
    } catch (err: any) {
      console.warn('[BuddyRelay] 模型显示名保存失败:', err.message);
    }
  }

  private record(parsed: ParsedErrorLine, file: string): void {
    const events = loadCooldownEvents();
    if (parsed.requestId && events.seenRequestIds.includes(parsed.requestId)) {
      return;
    }
    let resetAt: number;
    try {
      resetAt = parseResetAt(parsed.message);
    } catch (err: any) {
      // 6004 但文案里没有可解析的重置时刻：无法给出可信的冷却时间，跳过并暴露，绝不猜时长
      console.warn('[BuddyRelay] 429 记录缺少可解析的重置时刻，已跳过:', err.message);
      return;
    }
    let uid = this.uids.get(file) || '';
    if (!uid) {
      try {
        uid = readHostLoginUid();
      } catch (err: any) {
        console.warn('[BuddyRelay] 读取宿主登录态失败，无法归属 429 记录:', err.message);
      }
    }
    if (!uid || !parsed.model) {
      console.warn(
        `[BuddyRelay] 429 记录缺少账号或模型标识，已跳过: uid=${uid || '未知'} model=${parsed.model || '未知'} requestId=${parsed.requestId}`
      );
      return;
    }
    events.byUid[uid] = events.byUid[uid] || {};
    events.byUid[uid][parsed.model] = {
      modelId: parsed.model,
      resetAt,
      hitAt: parsed.hitAt,
      requestId: parsed.requestId
    };
    if (parsed.requestId) {
      events.seenRequestIds.push(parsed.requestId);
    }
    events.modelNames = this.modelNames;
    saveCooldownEvents(events);
    this.emit('change', events);
  }

  public stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch { /* 已关闭 */ }
    }
    this.watchers = [];
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.started = false;
  }
}
