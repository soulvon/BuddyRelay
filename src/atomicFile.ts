/**
 * 原子文件读写与跨进程可重入文件锁原语（零 vscode 依赖）
 *
 * 原则：
 * - 读失败 = 未知（区分 missing 与 error），绝不伪造为空默认值
 * - 写操作一律走同目录唯一临时文件 + fsync + renameSync（Windows 退避重试），严禁降级非原子直接覆写
 * - 跨进程 read-modify-write 一律经由 wx 排他锁文件序列化，支持同进程重入与死锁/超龄清理
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type SafeJsonReadResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'missing' }
  | { status: 'error'; error: Error; rawPreview?: string };

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

const READ_RETRY_DELAYS_MS = [15, 30, 60] as const;
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_IO_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const STALE_LOCK_AGE_MS = 10_000;
const activeInProcessLocks = new Map<string, number>();

let tmpSeq = 0;

interface LockRecord {
  pid: number;
  ts: number;
  token: string;
}

function normalizeLockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // 极少数禁用 SharedArrayBuffer 环境的短退避兜底
    }
  }
}

function getErrnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as NodeJS.ErrnoException).code || '');
  }
  return '';
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存活但当前无权限发信号
    return getErrnoCode(err) === 'EPERM';
  }
}

function safeUnlinkTmp(tmpPath: string): void {
  try {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  } catch (err) {
    if (getErrnoCode(err) !== 'ENOENT') {
      console.warn(`[atomicFile] 清理临时文件失败 ${tmpPath}: ${toError(err).message}`);
    }
  }
}

function fsyncBestEffort(filePath: string, mode: number): void {
  if ((mode & 0o200) === 0) return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r+');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EROFS' && code !== 'EBADF') {
      throw err;
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

function readLockMetadata(lockPath: string): { record: Partial<LockRecord> | null; ageMs: number; missing: boolean } {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    let record: Partial<LockRecord> | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          record = parsed as Partial<LockRecord>;
        }
      } catch {
        // 锁文件可能正在写入或已损坏，由锁龄判定兜底接管
      }
    }
    const ts = typeof record?.ts === 'number' && Number.isFinite(record.ts) ? record.ts : stat.mtimeMs;
    return { record, ageMs: Date.now() - ts, missing: false };
  } catch (err) {
    if (getErrnoCode(err) === 'ENOENT') {
      return { record: null, ageMs: 0, missing: true };
    }
    return { record: null, ageMs: 0, missing: false };
  }
}

/**
 * 安全读取并解析 JSON 文件（最多重试 3 次），严格区分缺失与损坏/权限异常。
 */
export function readJsonFileSafe<T = unknown>(filePath: string): SafeJsonReadResult<T> {
  let buf: Buffer | null = null;

  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      buf = fs.readFileSync(filePath);
      break;
    } catch (err) {
      const code = getErrnoCode(err);
      if (code === 'ENOENT') {
        return { status: 'missing' };
      }
      if (RETRYABLE_IO_CODES.has(code) && attempt < READ_RETRY_DELAYS_MS.length) {
        sleepSync(READ_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'error', error: toError(err) };
    }
  }

  if (!buf) {
    return { status: 'error', error: new Error('Read retries exhausted without buffer') };
  }

  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  try {
    const data = JSON.parse(text) as T;
    return { status: 'ok', data };
  } catch (err) {
    return {
      status: 'error',
      error: toError(err),
      rawPreview: text.slice(0, 200)
    };
  }
}

/**
 * Windows EPERM/EBUSY/EACCES 退避重试的原子重命名；严禁降级为直接 writeFileSync，失败清理 tmp 并抛错。
 */
export function renameWithRetrySync(tmpFile: string, targetPath: string, maxRetries: number = 5): void {
  const retries = Math.max(0, maxRetries);
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      fs.renameSync(tmpFile, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = getErrnoCode(err);
      if (RETRYABLE_IO_CODES.has(code) && attempt < retries) {
        const delay = RENAME_RETRY_DELAYS_MS[Math.min(attempt, RENAME_RETRY_DELAYS_MS.length - 1)];
        sleepSync(delay);
        continue;
      }
      break;
    }
  }

  safeUnlinkTmp(tmpFile);
  throw lastErr;
}

/**
 * 进程安全原子写：写同目录唯一临时文件 (.tmp_${pid}_${ts}_${seq}) -> fsync -> renameWithRetrySync。
 * 失败自动清理临时文件并抛错，默认文件权限 0o600。
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): void {
  const encoding = options.encoding ?? 'utf8';
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${targetPath}.tmp_${process.pid}_${Date.now()}_${++tmpSeq}`;
  try {
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(tmpPath, content, { mode });
    } else {
      fs.writeFileSync(tmpPath, content, { encoding, mode });
    }
    fsyncBestEffort(tmpPath, mode);
    renameWithRetrySync(tmpPath, targetPath);
  } finally {
    safeUnlinkTmp(tmpPath);
  }
}

/**
 * 原子写 JSON 文件（默认缩进 2 空格、权限 0o600）。
 */
export function atomicWriteJsonSync(targetPath: string, value: unknown, indent: number = 2): void {
  atomicWriteFileSync(targetPath, JSON.stringify(value, null, indent), { encoding: 'utf8', mode: 0o600 });
}

/**
 * 跨进程 + 同进程可重入排他文件锁（基于 ${targetPath}.lock + O_EXCL 'wx'）。
 */
export function withFileLockSync<T>(targetPath: string, fn: () => T, timeoutMs: number = 5000): T {
  const lockKey = normalizeLockKey(targetPath);
  const currentDepth = activeInProcessLocks.get(lockKey) || 0;
  if (currentDepth > 0) {
    activeInProcessLocks.set(lockKey, currentDepth + 1);
    try {
      return fn();
    } finally {
      activeInProcessLocks.set(lockKey, currentDepth);
    }
  }

  const lockPath = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const deadline = Date.now() + Math.max(0, timeoutMs);
  const myRecord: LockRecord = {
    pid: process.pid,
    ts: Date.now(),
    token: crypto.randomBytes(8).toString('hex')
  };

  let acquired = false;
  let lastCode = '';

  while (!acquired) {
    let fd: number | null = null;
    try {
      myRecord.ts = Date.now();
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(myRecord), 0, 'utf8');
      acquired = true;
    } catch (err) {
      lastCode = getErrnoCode(err);
      if (lastCode === 'EEXIST') {
        const meta = readLockMetadata(lockPath);
        if (meta.missing) {
          continue;
        }
        const holderPid = typeof meta.record?.pid === 'number' ? meta.record.pid : 0;
        const pidDead = holderPid > 0 && !isProcessAlive(holderPid);
        const isStale = meta.ageMs > STALE_LOCK_AGE_MS;

        if (isStale || pidDead) {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch (unlinkErr) {
            if (getErrnoCode(unlinkErr) === 'ENOENT') {
              continue;
            }
          }
        }
      } else if (!RETRYABLE_IO_CODES.has(lastCode)) {
        throw err;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for file lock: ${lockPath} (${lastCode || 'LOCK_BUSY'})`);
      }
      sleepSync(Math.min(25, remaining));
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }

  activeInProcessLocks.set(lockKey, 1);
  try {
    return fn();
  } finally {
    activeInProcessLocks.delete(lockKey);
    try {
      const currentRaw = fs.readFileSync(lockPath, 'utf8').trim();
      const current = JSON.parse(currentRaw) as Partial<LockRecord>;
      if (current.pid === myRecord.pid && current.token === myRecord.token) {
        fs.unlinkSync(lockPath);
      }
    } catch (err) {
      if (getErrnoCode(err) !== 'ENOENT') {
        console.warn(`[atomicFile] 释放文件锁失败 ${lockPath}: ${toError(err).message}`);
      }
    }
  }
}

/**
 * 清理指定目录下超龄的残留临时文件（.tmp_* / .tmp.* / .part_*）。
 */
export function cleanStaleTempFiles(
  dirPath: string,
  baseFileName?: string,
  maxAgeMs: number = 10 * 60 * 1000
): number {
  let removed = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const prefixUnder = baseFileName ? `${baseFileName}.tmp_` : '';
    const prefixDot = baseFileName ? `${baseFileName}.tmp.` : '';
    const prefixPart = baseFileName ? `${baseFileName}.part_` : '';

    for (const name of fs.readdirSync(dirPath)) {
      const matched = baseFileName
        ? name.startsWith(prefixUnder) || name.startsWith(prefixDot) || name.startsWith(prefixPart)
        : name.includes('.tmp_') || name.includes('.tmp.') || name.includes('.part_');
      if (!matched) continue;

      const fullPath = path.join(dirPath, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile() && st.mtimeMs <= cutoff) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      } catch {
        // 已被其他窗口清理或正被占用，跳过
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
  return removed;
}
