import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PATHS, resolveHostDataDirs } from './constants';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';

/**
 * 本地 Token 消耗账本引擎（零 vscode 依赖）
 * - 只读扫描 CodeBuddy IDE 扩展日志与 CodeBuddy CLI / WorkBuddy JSONL 会话文件
 * - 按文件 size + mtimeMs 增量持久化缓存，损坏缓存自动熔断拒写
 * - 严格扣除 cacheRead 避免与包含缓存的 inputTokens 重复计算
 */

export type TokenSource = 'ide' | 'cli' | 'workbuddy';

export interface TokenModelRates {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite?: number;
}

export interface TokenPeriodBucket {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  weighted: number;
  total: number;
  calls: number;
  cacheHitPct: number;
  costUsd: number;
  savedByCacheUsd: number;
  credits: number;
}

export interface AccountTokenSummary {
  uid: string;
  todayTokens: number;
  todayWeighted: number;
  todayCostUsd: number;
  todayCalls: number;
  todayCacheHitPct: number;
  totalTokens: number;
  totalWeighted: number;
  totalCostUsd: number;
  totalCalls: number;
}

export interface TokenModelStat {
  model: string;
  displayName: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  weighted: number;
  total: number;
  calls: number;
  sharePct: number;
  cacheHitPct: number;
  costUsd: number;
  savedByCacheUsd: number;
}

export interface TokenDailyPoint {
  date: string;
  total: number;
  weighted: number;
  costUsd: number;
  calls: number;
  input: number;
  cacheRead: number;
  output: number;
}

export interface TokenSlice {
  date: string;
  uid: string;
  source: TokenSource;
  model: string;
  displayName: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  total: number;
  weighted: number;
  calls: number;
  costUsd: number;
  savedByCacheUsd: number;
}

export interface TokenLedgerSummary {
  scannedAt: number;
  scanElapsedMs: number;
  todayKey: string;
  totalCalls: number;
  cacheHealthy: boolean;
  totals: {
    today: TokenPeriodBucket;
    last7d: TokenPeriodBucket;
    last30d: TokenPeriodBucket;
    allTime: TokenPeriodBucket;
  };
  perAccount: Record<string, AccountTokenSummary>;
  bySource: Record<TokenSource, { total: number; weighted: number; calls: number; costUsd: number }>;
  models: TokenModelStat[];
  daily30: TokenDailyPoint[];
  slices: TokenSlice[];
}

export interface TokenLedgerOptions {
  hostLogDirs?: string[];
  cliProjectsDir?: string;
  workbuddyDirs?: string[];
  cacheFilePath?: string;
  nowProvider?: () => number;
  ttlMs?: number;
}

interface ParsedTokenEvent {
  date: string;
  uid: string;
  source: TokenSource;
  model: string;
  displayName: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  total: number;
  credits: number;
  dedupKey: string;
}

interface CachedFileEntry {
  size: number;
  mtimeMs: number;
  source: TokenSource;
  events: ParsedTokenEvent[];
}

interface PersistedLedgerCache {
  version: number;
  updatedAt: number;
  files: Record<string, CachedFileEntry>;
}

const DEFAULT_TTL_MS = 25_000;
const SESSION_DIR_RE = /^\d{8}T\d{6}$/;
const UID_PATTERNS = [/identity=\{"uid":"([0-9a-f-]{36})"/, /currentUid:\s*([0-9a-f-]{36})/];
const MODEL_PREPARED_RE = /\[CraftInvokableAgent\]\s*\[([0-9a-f]+)\]\s*Model prepared:\s*(.+?)\s*\(([^)]+)\)/;
const MODEL_INIT_RE = /ModelProvider initialized,\s*modelId:\s*([^\s,]+)(?:,\s*modelName:\s*([^,\r\n]+))?/;
const MODEL_MAX_TOKENS_RE = /max_tokens resolved:.*?\bmodelId=([^\s,]+)/;
const ON_AGENT_END_RE = /\[AgentReporter\]\s*\[([0-9a-f]+)\]\s*onAgentEnd:.*?\brequestId=([^\s,]+)/;
const USAGE_LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d+).*?\[AgentReporter\]\s*\[([0-9a-f]+)\]\s*Agent execution successful with usage:\s*(\{.*\})\s*$/;
const FALLBACK_RATES: TokenModelRates = { input: 0.5, cacheRead: 0.1, output: 2.0 };

export function getModelRates(modelId: string): TokenModelRates {
  const m = String(modelId || '').replace(/^(?:custom-local|custom):/i, '').trim().toLowerCase();
  if (m.includes('opus')) return { input: 5.0, cacheRead: 0.5, output: 25.0 };
  if (m.includes('sonnet') || m.includes('claude-4') || m.includes('claude-3.7') || m.includes('claude-3-5')) {
    return { input: 3.0, cacheRead: 0.3, output: 15.0 };
  }
  if (m.includes('haiku')) return { input: 1.0, cacheRead: 0.1, output: 5.0 };
  if (m.includes('gemini') && m.includes('pro')) return { input: 1.25, cacheRead: 0.125, output: 10.0 };
  if (m.includes('gemini')) return { input: 0.3, cacheRead: 0.03, output: 2.5 };
  if (m.includes('gpt-5') || m.includes('codex')) return { input: 1.25, cacheRead: 0.125, output: 10.0 };
  if (m.includes('gpt-4.1')) return { input: 2.0, cacheRead: 0.5, output: 8.0 };
  if (m.includes('gpt-4o')) return { input: 2.5, cacheRead: 1.25, output: 10.0 };
  if (/\bo[134](?:\b|-)/.test(m)) return { input: 2.0, cacheRead: 0.5, output: 8.0 };
  if (m.includes('deepseek')) return { input: 0.28, cacheRead: 0.028, output: 0.42 };
  if (m.includes('glm')) return { input: 0.5, cacheRead: 0.1, output: 2.0 };
  if (m.includes('kimi') || m.includes('moonshot')) return { input: 0.6, cacheRead: 0.15, output: 2.5 };
  if (m.includes('minimax')) return { input: 0.3, cacheRead: 0.03, output: 1.2 };
  if (m.includes('qwen')) return { input: 0.4, cacheRead: 0.08, output: 1.6 };
  if (m.includes('hunyuan') || /\bhy[34]\b|^hy-/.test(m)) return { input: 0.35, cacheRead: 0.07, output: 1.4 };
  return FALLBACK_RATES;
}

export function computeWeightedTokens(input: number, cacheRead: number, output: number): number {
  return Math.round(Math.max(0, input) + 0.1 * Math.max(0, cacheRead) + 6 * Math.max(0, output));
}

export function estimateModelCostUsd(
  modelId: string,
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number
): { costUsd: number; savedByCacheUsd: number } {
  const r = getModelRates(modelId);
  const writeRate = r.cacheWrite ?? r.input * 1.25;
  const costUsd = (
    Math.max(0, input) * r.input +
    Math.max(0, cacheRead) * r.cacheRead +
    Math.max(0, cacheWrite) * writeRate +
    Math.max(0, output) * r.output
  ) / 1_000_000;
  const savedByCacheUsd = (Math.max(0, cacheRead) * Math.max(0, r.input - r.cacheRead)) / 1_000_000;
  return { costUsd, savedByCacheUsd };
}

function toNonNegInt(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function toUtc8Date(epochMs: number): string {
  const d = new Date(epochMs + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function recentUtc8Dates(nowMs: number, days: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < days; i++) out.add(toUtc8Date(nowMs - i * 86_400_000));
  return out;
}

function parseTimestampMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return fallbackMs;
}

function safeStatFile(filePath: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return st;
  } catch {
    return null;
  }
}

function safeReaddirNames(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function isRealDir(dirPath: string): boolean {
  try {
    const st = fs.lstatSync(dirPath);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function emptyBucket(): TokenPeriodBucket {
  return {
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0,
    weighted: 0, total: 0, calls: 0, cacheHitPct: 0, costUsd: 0, savedByCacheUsd: 0, credits: 0
  };
}

function addToBucket(b: TokenPeriodBucket, ev: ParsedTokenEvent, weighted: number, costUsd: number, savedByCacheUsd: number): void {
  b.input += ev.input;
  b.cacheRead += ev.cacheRead;
  b.cacheWrite += ev.cacheWrite;
  b.output += ev.output;
  b.thinking += ev.thinking;
  b.weighted += weighted;
  b.total += ev.total;
  b.calls += 1;
  b.costUsd += costUsd;
  b.savedByCacheUsd += savedByCacheUsd;
  b.credits += ev.credits;
}

function finalizeBucket(b: TokenPeriodBucket): TokenPeriodBucket {
  const denom = b.input + b.cacheRead;
  b.cacheHitPct = denom > 0 ? Math.round((b.cacheRead / denom) * 1000) / 10 : 0;
  return b;
}

function collectIdeLogFiles(hostLogDirs: string[]): string[] {
  const files: string[] = [];
  const pushDirLogs = (dir: string) => {
    for (const name of safeReaddirNames(dir)) {
      if (!name.toLowerCase().endsWith('.log')) continue;
      const full = path.join(dir, name);
      if (safeStatFile(full)) files.push(full);
    }
  };
  for (const logRoot of hostLogDirs) {
    if (!isRealDir(logRoot)) continue;
    const directCopilot = path.join(logRoot, 'Tencent-Cloud.coding-copilot');
    if (isRealDir(directCopilot)) pushDirLogs(directCopilot);
    for (const sessName of safeReaddirNames(logRoot)) {
      if (!SESSION_DIR_RE.test(sessName)) continue;
      const sessDir = path.join(logRoot, sessName);
      if (!isRealDir(sessDir)) continue;
      for (const winName of safeReaddirNames(sessDir)) {
        const copilotDir = path.join(sessDir, winName, 'exthost', 'Tencent-Cloud.coding-copilot');
        if (isRealDir(copilotDir)) pushDirLogs(copilotDir);
      }
    }
  }
  return Array.from(new Set(files));
}

function collectJsonlFiles(roots: Array<{ dir: string; source: TokenSource }>): Array<{ file: string; source: TokenSource }> {
  const out: Array<{ file: string; source: TokenSource }> = [];
  const walk = (dir: string, source: TokenSource, depth: number) => {
    if (depth > 5 || !isRealDir(dir)) return;
    for (const name of safeReaddirNames(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(full, source, depth + 1);
        else if (st.isFile() && name.toLowerCase().endsWith('.jsonl')) out.push({ file: full, source });
      } catch {
        // skip unreadable entry
      }
    }
  };
  for (const { dir, source } of roots) walk(dir, source, 0);
  return out;
}

function parseIdeLogFile(filePath: string): ParsedTokenEvent[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }

  const lines = content.split(/\r?\n/);
  const events: ParsedTokenEvent[] = [];
  let firstUid = '';
  let currentUid = '';
  let lastModel = { id: 'unknown', name: 'unknown' };
  const agentModels = new Map<string, { id: string; name: string }>();
  const agentRequestIds = new Map<string, string>();

  for (const line of lines) {
    if (!line) continue;
    for (const re of UID_PATTERNS) {
      const um = re.exec(line);
      if (um) {
        currentUid = um[1];
        if (!firstUid) firstUid = um[1];
        break;
      }
    }
    const prep = MODEL_PREPARED_RE.exec(line);
    if (prep) {
      const info = { id: prep[3].trim(), name: prep[2].trim() || prep[3].trim() };
      agentModels.set(prep[1], info);
      lastModel = info;
      continue;
    }
    const init = MODEL_INIT_RE.exec(line);
    if (init) {
      const id = init[1].trim();
      lastModel = { id, name: (init[2] || '').trim() || id };
      continue;
    }
    const maxTok = MODEL_MAX_TOKENS_RE.exec(line);
    if (maxTok) {
      const id = maxTok[1].trim();
      lastModel = { id, name: lastModel.id === id ? lastModel.name : id };
      continue;
    }
    const endM = ON_AGENT_END_RE.exec(line);
    if (endM) {
      agentRequestIds.set(endM[1], endM[2].trim());
      continue;
    }
    if (!line.includes('Agent execution successful with usage:')) continue;
    const um = USAGE_LINE_RE.exec(line);
    if (!um) continue;

    let usage: any;
    try { usage = JSON.parse(um[4]); } catch { continue; }
    if (!usage || typeof usage !== 'object') continue;

    const agentId = um[3];
    const cacheRead = toNonNegInt(usage.cacheTokens ?? usage.cacheReadInputTokens ?? usage.cached_tokens);
    const cacheWrite = toNonNegInt(usage.cachedWriteTokens ?? usage.cacheCreationInputTokens);
    const rawInput = toNonNegInt(usage.inputTokens);
    const input = (usage.cachedMissTokens !== undefined && usage.cachedMissTokens !== null)
      ? toNonNegInt(usage.cachedMissTokens)
      : (rawInput >= cacheRead + cacheWrite ? rawInput - cacheRead - cacheWrite : rawInput);
    const output = toNonNegInt(usage.outputTokens);
    const thinking = toNonNegInt(usage.thinkingTokens ?? usage.reasoningTokens);
    const total = toNonNegInt(usage.totalTokens) || (input + cacheRead + cacheWrite + output);
    if (total <= 0) continue;

    const creditsNum = Number(usage.credit);
    const credits = Number.isFinite(creditsNum) && creditsNum > 0 ? creditsNum : 0;
    const modelInfo = agentModels.get(agentId) || lastModel;
    const reqId = agentRequestIds.get(agentId) || '';
    if (reqId) agentRequestIds.delete(agentId);

    events.push({
      date: um[1],
      uid: currentUid,
      source: 'ide',
      model: modelInfo.id,
      displayName: modelInfo.name,
      input,
      cacheRead,
      cacheWrite,
      output,
      thinking,
      total,
      credits,
      dedupKey: reqId ? `ide:${reqId}` : `ide:${um[1]}|${um[2]}|${agentId}|${total}`
    });
  }

  for (const ev of events) {
    if (!ev.uid) ev.uid = firstUid || 'unattributed';
  }
  return events;
}

function parseJsonlFile(filePath: string, source: TokenSource, fallbackMtimeMs: number): ParsedTokenEvent[] {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }

  const lines = content.split(/\r?\n/);
  const normPath = normalizeCacheKey(filePath);
  const events: ParsedTokenEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (!line.includes('"usage"') && !line.includes('"rawUsage"'))) continue;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    const u = obj.message?.usage || obj.providerData?.rawUsage || obj.providerData?.usage || obj.usage;
    if (!u || typeof u !== 'object') continue;

    const cacheRead = toNonNegInt(
      u.cacheTokens ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens
    );
    const cacheWrite = toNonNegInt(
      u.cachedWriteTokens ?? u.cache_creation_input_tokens ?? u.cacheCreationInputTokens
    );
    const rawInput = toNonNegInt(u.inputTokens ?? u.input_tokens ?? u.prompt_tokens);
    const output = toNonNegInt(u.outputTokens ?? u.output_tokens ?? u.completion_tokens);
    const thinking = toNonNegInt(u.thinkingTokens ?? u.reasoningTokens ?? u.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
    const reportedTotal = toNonNegInt(u.totalTokens ?? u.total_tokens);

    let input: number;
    if (u.cachedMissTokens !== undefined && u.cachedMissTokens !== null) {
      input = toNonNegInt(u.cachedMissTokens);
    } else if (u.cacheMissTokens !== undefined && u.cacheMissTokens !== null) {
      input = toNonNegInt(u.cacheMissTokens);
    } else if (reportedTotal > 0 && rawInput + output === reportedTotal && rawInput >= cacheRead + cacheWrite) {
      input = rawInput - cacheRead - cacheWrite;
    } else {
      input = rawInput;
    }

    const total = reportedTotal || (input + cacheRead + cacheWrite + output);
    if (total <= 0) continue;

    const model = String(
      obj.providerData?.model || obj.providerData?.requestModelId || obj.model || obj.message?.model || 'unknown'
    ).trim() || 'unknown';
    const tsMs = parseTimestampMs(obj.timestamp ?? obj.createdAt ?? obj.time, fallbackMtimeMs);
    const msgId = String(
      obj.providerData?.messageId || obj.providerData?.traceId || obj.message?.id || obj.requestId || obj.id || ''
    ).trim();

    events.push({
      date: toUtc8Date(tsMs),
      uid: 'unattributed',
      source,
      model,
      displayName: model,
      input,
      cacheRead,
      cacheWrite,
      output,
      thinking,
      total,
      credits: 0,
      dedupKey: msgId ? `${source}:${msgId}` : `${source}:${normPath}:${i}`
    });
  }
  return events;
}

function isValidPersistedCache(data: unknown): data is PersistedLedgerCache {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as Partial<PersistedLedgerCache>;
  return obj.version === 1 && Boolean(obj.files) && typeof obj.files === 'object' && !Array.isArray(obj.files);
}

export class TokenLedger {
  private options: TokenLedgerOptions;
  private cacheFilePath: string;
  private ttlMs: number;
  private cacheHealthy = true;
  private fileCache: Record<string, CachedFileEntry> | null = null;
  private lastSummary: TokenLedgerSummary | null = null;
  private lastSummaryAt = 0;
  private inFlight: Promise<TokenLedgerSummary> | null = null;
  private disposed = false;

  constructor(options: TokenLedgerOptions = {}) {
    this.options = options;
    this.cacheFilePath = options.cacheFilePath || PATHS.TOKEN_LEDGER_FILE;
    this.ttlMs = Math.max(1000, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  public getCachedSummary(): TokenLedgerSummary | null {
    return this.lastSummary;
  }

  public invalidate(): void {
    this.lastSummaryAt = 0;
  }

  public dispose(): void {
    this.disposed = true;
    this.inFlight = null;
  }

  public async getSummary(forceRescan: boolean = false): Promise<TokenLedgerSummary> {
    const now = this.nowMs();
    if (!forceRescan && this.lastSummary && now - this.lastSummaryAt < this.ttlMs) {
      return this.lastSummary;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.scanAndAggregate().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private nowMs(): number {
    return this.options.nowProvider ? this.options.nowProvider() : Date.now();
  }

  private resolveScanRoots(): {
    hostLogDirs: string[];
    jsonlRoots: Array<{ dir: string; source: TokenSource }>;
  } {
    const home = os.homedir();
    const hostLogDirs = this.options.hostLogDirs ?? resolveHostDataDirs().map((d) => path.join(d, 'logs'));
    const cliDir = this.options.cliProjectsDir ?? path.join(home, '.codebuddy', 'projects');
    const wbDirs = this.options.workbuddyDirs ?? [
      path.join(home, '.workbuddy', 'projects'),
      path.join(home, '.workbuddy-ai', 'projects')
    ];
    const jsonlRoots: Array<{ dir: string; source: TokenSource }> = [
      { dir: cliDir, source: 'cli' },
      ...wbDirs.map((dir) => ({ dir, source: 'workbuddy' as const }))
    ];
    return { hostLogDirs, jsonlRoots };
  }

  private ensureCacheLoaded(): Record<string, CachedFileEntry> {
    if (this.fileCache) return this.fileCache;
    const res = readJsonFileSafe<unknown>(this.cacheFilePath);
    if (res.status === 'missing') {
      this.cacheHealthy = true;
      this.fileCache = {};
    } else if (res.status === 'ok' && isValidPersistedCache(res.data)) {
      this.cacheHealthy = true;
      this.fileCache = { ...res.data.files };
    } else {
      const msg = res.status === 'error' ? res.error.message : '缓存结构无效';
      console.warn(`[BuddyRelay][TokenLedger] 缓存读取异常，已启用损坏拒写保护: ${msg}`);
      this.cacheHealthy = false;
      this.fileCache = {};
    }
    return this.fileCache;
  }

  private async scanAndAggregate(): Promise<TokenLedgerSummary> {
    const startMs = Date.now();
    const now = this.nowMs();
    const cache = this.ensureCacheLoaded();
    const { hostLogDirs, jsonlRoots } = this.resolveScanRoots();

    const targets: Array<{ file: string; source: TokenSource }> = [
      ...collectIdeLogFiles(hostLogDirs).map((file) => ({ file, source: 'ide' as const })),
      ...collectJsonlFiles(jsonlRoots)
    ];

    let dirty = false;
    const activeKeys = new Set<string>();
    const byDedup = new Map<string, ParsedTokenEvent>();

    for (const target of targets) {
      if (this.disposed) break;
      const st = safeStatFile(target.file);
      if (!st) continue;

      const key = normalizeCacheKey(target.file);
      activeKeys.add(key);
      const sigMtime = Math.floor(st.mtimeMs);
      const cached = cache[key];

      let events: ParsedTokenEvent[];
      if (cached && cached.size === st.size && cached.mtimeMs === sigMtime && cached.source === target.source) {
        events = cached.events;
      } else {
        events = target.source === 'ide'
          ? parseIdeLogFile(target.file)
          : parseJsonlFile(target.file, target.source, st.mtimeMs);
        cache[key] = { size: st.size, mtimeMs: sigMtime, source: target.source, events };
        dirty = true;
      }

      for (const ev of events) {
        const prev = byDedup.get(ev.dedupKey);
        if (!prev || ev.total >= prev.total) byDedup.set(ev.dedupKey, ev);
      }
    }

    for (const k of Object.keys(cache)) {
      if (!activeKeys.has(k)) {
        delete cache[k];
        dirty = true;
      }
    }

    if (dirty && this.cacheHealthy && !this.disposed) {
      try {
        const payload: PersistedLedgerCache = { version: 1, updatedAt: now, files: cache };
        withFileLockSync(this.cacheFilePath, () => {
          atomicWriteJsonSync(this.cacheFilePath, payload, 0);
        });
      } catch (err: any) {
        console.warn('[BuddyRelay][TokenLedger] 缓存写入失败:', err?.message || err);
      }
    }

    const summary = this.aggregateEvents(Array.from(byDedup.values()), now, Date.now() - startMs);
    this.lastSummary = summary;
    this.lastSummaryAt = now;
    return summary;
  }

  private aggregateEvents(events: ParsedTokenEvent[], now: number, scanElapsedMs: number): TokenLedgerSummary {
    const todayKey = toUtc8Date(now);
    const set7d = recentUtc8Dates(now, 7);
    const set30d = recentUtc8Dates(now, 30);

    const todayBucket = emptyBucket();
    const bucket7d = emptyBucket();
    const bucket30d = emptyBucket();
    const allBucket = emptyBucket();

    const bySource: TokenLedgerSummary['bySource'] = {
      ide: { total: 0, weighted: 0, calls: 0, costUsd: 0 },
      cli: { total: 0, weighted: 0, calls: 0, costUsd: 0 },
      workbuddy: { total: 0, weighted: 0, calls: 0, costUsd: 0 }
    };

    const accTotals = new Map<string, { acc: AccountTokenSummary; todayIn: number; todayCache: number }>();
    const modelMap = new Map<string, TokenModelStat>();
    const dailyMap = new Map<string, TokenDailyPoint>();
    const sliceMap = new Map<string, TokenSlice>();

    for (const ev of events) {
      const weighted = computeWeightedTokens(ev.input, ev.cacheRead, ev.output);
      const { costUsd, savedByCacheUsd } = estimateModelCostUsd(ev.model, ev.input, ev.cacheRead, ev.cacheWrite, ev.output);

      addToBucket(allBucket, ev, weighted, costUsd, savedByCacheUsd);
      if (set30d.has(ev.date)) addToBucket(bucket30d, ev, weighted, costUsd, savedByCacheUsd);
      if (set7d.has(ev.date)) addToBucket(bucket7d, ev, weighted, costUsd, savedByCacheUsd);
      if (ev.date === todayKey) addToBucket(todayBucket, ev, weighted, costUsd, savedByCacheUsd);

      const src = bySource[ev.source];
      src.total += ev.total;
      src.weighted += weighted;
      src.calls += 1;
      src.costUsd += costUsd;

      if (ev.uid && ev.uid !== 'unattributed') {
        let entry = accTotals.get(ev.uid);
        if (!entry) {
          entry = {
            acc: {
              uid: ev.uid, todayTokens: 0, todayWeighted: 0, todayCostUsd: 0, todayCalls: 0, todayCacheHitPct: 0,
              totalTokens: 0, totalWeighted: 0, totalCostUsd: 0, totalCalls: 0
            },
            todayIn: 0, todayCache: 0
          };
          accTotals.set(ev.uid, entry);
        }
        entry.acc.totalTokens += ev.total;
        entry.acc.totalWeighted += weighted;
        entry.acc.totalCostUsd += costUsd;
        entry.acc.totalCalls += 1;
        if (ev.date === todayKey) {
          entry.acc.todayTokens += ev.total;
          entry.acc.todayWeighted += weighted;
          entry.acc.todayCostUsd += costUsd;
          entry.acc.todayCalls += 1;
          entry.todayIn += ev.input;
          entry.todayCache += ev.cacheRead;
        }
      }

      let ms = modelMap.get(ev.model);
      if (!ms) {
        ms = {
          model: ev.model, displayName: ev.displayName,
          input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0,
          weighted: 0, total: 0, calls: 0, sharePct: 0, cacheHitPct: 0, costUsd: 0, savedByCacheUsd: 0
        };
        modelMap.set(ev.model, ms);
      }
      ms.input += ev.input;
      ms.cacheRead += ev.cacheRead;
      ms.cacheWrite += ev.cacheWrite;
      ms.output += ev.output;
      ms.thinking += ev.thinking;
      ms.weighted += weighted;
      ms.total += ev.total;
      ms.calls += 1;
      ms.costUsd += costUsd;
      ms.savedByCacheUsd += savedByCacheUsd;

      if (set30d.has(ev.date)) {
        let dp = dailyMap.get(ev.date);
        if (!dp) {
          dp = { date: ev.date, total: 0, weighted: 0, costUsd: 0, calls: 0, input: 0, cacheRead: 0, output: 0 };
          dailyMap.set(ev.date, dp);
        }
        dp.total += ev.total;
        dp.weighted += weighted;
        dp.costUsd += costUsd;
        dp.calls += 1;
        dp.input += ev.input;
        dp.cacheRead += ev.cacheRead;
        dp.output += ev.output;
      }

      const sk = `${ev.date}|${ev.uid}|${ev.source}|${ev.model}`;
      let sl = sliceMap.get(sk);
      if (!sl) {
        sl = {
          date: ev.date, uid: ev.uid, source: ev.source, model: ev.model, displayName: ev.displayName,
          input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0,
          total: 0, weighted: 0, calls: 0, costUsd: 0, savedByCacheUsd: 0
        };
        sliceMap.set(sk, sl);
      }
      sl.input += ev.input;
      sl.cacheRead += ev.cacheRead;
      sl.cacheWrite += ev.cacheWrite;
      sl.output += ev.output;
      sl.thinking += ev.thinking;
      sl.total += ev.total;
      sl.weighted += weighted;
      sl.calls += 1;
      sl.costUsd += costUsd;
      sl.savedByCacheUsd += savedByCacheUsd;
    }

    const perAccount: Record<string, AccountTokenSummary> = {};
    for (const [uid, entry] of accTotals) {
      const denom = entry.todayIn + entry.todayCache;
      entry.acc.todayCacheHitPct = denom > 0 ? Math.round((entry.todayCache / denom) * 1000) / 10 : 0;
      perAccount[uid] = entry.acc;
    }

    const models = Array.from(modelMap.values())
      .map((m) => {
        const denom = m.input + m.cacheRead;
        m.cacheHitPct = denom > 0 ? Math.round((m.cacheRead / denom) * 1000) / 10 : 0;
        m.sharePct = allBucket.total > 0 ? Math.round((m.total / allBucket.total) * 1000) / 10 : 0;
        return m;
      })
      .sort((a, b) => b.total - a.total);

    const daily30 = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const slices = Array.from(sliceMap.values()).sort((a, b) => b.date.localeCompare(a.date));

    return {
      scannedAt: now,
      scanElapsedMs,
      todayKey,
      totalCalls: events.length,
      cacheHealthy: this.cacheHealthy,
      totals: {
        today: finalizeBucket(todayBucket),
        last7d: finalizeBucket(bucket7d),
        last30d: finalizeBucket(bucket30d),
        allTime: finalizeBucket(allBucket)
      },
      perAccount,
      bySource,
      models,
      daily30,
      slices
    };
  }
}

