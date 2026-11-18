import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';
import { atomicWriteJsonSync, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { t } from './i18n';

/**
 * 跨窗口账号锁与调度 Leader 锁（withFileLockSync + atomicWriteJsonSync）
 */
interface LockEntry {
  windowId: string;
  windowName?: string;
  pid: number;
  ts: number;
}

interface LockFile {
  locks: Record<string, LockEntry>;
}

interface SchedulerLeaderEntry {
  sessionId: string;
  pid: number;
  ts: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 90_000;
const DEFAULT_LEADER_TTL_MS = 90_000;

let _heartbeatTimer: NodeJS.Timeout | null = null;
let _currentWindowId = '';
let _currentWindowName = '';
let _currentLockedUid: string | null = null;

function getLockFilePath(): string {
  return process.env.BUDDYRELAY_LOCK_FILE || PATHS.LOCK_FILE;
}

function getLeaderFilePath(): string {
  return process.env.BUDDYRELAY_LEADER_FILE || path.join(PATHS.RELAY_DIR, 'scheduler-leader.json');
}

function getMySessionId(): string {
  return _currentWindowId || `pid-${process.pid}`;
}

function readLockFile(): LockFile {
  const res = readJsonFileSafe<Partial<LockFile>>(getLockFilePath());
  if (res.status === 'ok' && res.data?.locks && typeof res.data.locks === 'object') {
    return { locks: res.data.locks as Record<string, LockEntry> };
  }
  return { locks: {} };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = 进程存活但拒绝信号，必须视为存活
    return Boolean(err && err.code === 'EPERM');
  }
}

function cleanStaleLocks(data: LockFile): boolean {
  const now = Date.now();
  let changed = false;
  for (const [uid, entry] of Object.entries(data.locks)) {
    if (!entry || typeof entry !== 'object' || now - entry.ts > STALE_THRESHOLD_MS || !isPidAlive(entry.pid)) {
      delete data.locks[uid];
      changed = true;
    }
  }
  return changed;
}

function getValidOtherLocks(): Array<[string, LockEntry]> {
  let data = readLockFile();
  if (cleanStaleLocks({ locks: { ...data.locks } })) {
    try {
      const lockFile = getLockFilePath();
      data = withFileLockSync(lockFile, () => {
        const latest = readLockFile();
        if (cleanStaleLocks(latest)) atomicWriteJsonSync(lockFile, latest);
        return latest;
      });
    } catch { /* ignore cleanup lock error */ }
  }
  const now = Date.now();
  return Object.entries(data.locks).filter(
    ([, entry]) => entry.pid !== process.pid && now - entry.ts <= STALE_THRESHOLD_MS && isPidAlive(entry.pid)
  );
}

/** 初始化锁模块，设置本窗口标识 */
export function initAccountLock(windowId: string, windowName?: string): void {
  _currentWindowId = windowId || `pid-${process.pid}`;
  _currentWindowName = windowName || '';
}

/** 锁定账号（切换成功/激活变更后调用） */
export function acquireLock(uid: string): void {
  if (!uid) return;
  const lockFile = getLockFilePath();
  try {
    withFileLockSync(lockFile, () => {
      const data = readLockFile();
      cleanStaleLocks(data);
      if (_currentLockedUid && _currentLockedUid !== uid) {
        const old = data.locks[_currentLockedUid];
        if (old && old.pid === process.pid) delete data.locks[_currentLockedUid];
      }
      data.locks[uid] = {
        windowId: _currentWindowId,
        windowName: _currentWindowName || undefined,
        pid: process.pid,
        ts: Date.now()
      };
      _currentLockedUid = uid;
      atomicWriteJsonSync(lockFile, data);
    });
  } catch (err) {
    console.warn('[accountLock] acquireLock error:', err);
  }
}

/** 释放本窗口持有的账号锁（只释放自己 pid 的锁，严禁误删他窗） */
export function releaseLock(uid?: string): void {
  const target = uid || _currentLockedUid;
  if (!target) return;
  const lockFile = getLockFilePath();
  try {
    withFileLockSync(lockFile, () => {
      const data = readLockFile();
      const entry = data.locks[target];
      if (entry && entry.pid === process.pid) {
        delete data.locks[target];
        atomicWriteJsonSync(lockFile, data);
      }
    });
  } catch (err) {
    console.warn('[accountLock] releaseLock error:', err);
  }
  if (_currentLockedUid === target) _currentLockedUid = null;
}

/** 获取被其他存活窗口占用的账号 UID 集合 */
export function getOtherLockedUids(): Set<string> {
  return new Set(getValidOtherLocks().map(([uid]) => uid));
}

/** 获取被其他存活窗口占用的账号映射（含窗口名，供 UI 展示占用方） */
export function getOtherLockedMap(): Record<string, { windowName: string; pid: number }> {
  const result: Record<string, { windowName: string; pid: number }> = {};
  for (const [uid, entry] of getValidOtherLocks()) {
    result[uid] = {
      windowName: entry.windowName || t('common.window', entry.windowId || entry.pid),
      pid: entry.pid
    };
  }
  return result;
}

/** 启动心跳（定期续期；锁被他窗抢走则让位防 ping-pong） */
export function startHeartbeat(): void {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    if (!_currentLockedUid) return;
    const lockFile = getLockFilePath();
    try {
      withFileLockSync(lockFile, () => {
        if (!_currentLockedUid) return;
        const data = readLockFile();
        cleanStaleLocks(data);
        const entry = data.locks[_currentLockedUid];
        if (entry && entry.pid === process.pid) {
          entry.ts = Date.now();
        } else if (!entry) {
          data.locks[_currentLockedUid] = {
            windowId: _currentWindowId,
            windowName: _currentWindowName || undefined,
            pid: process.pid,
            ts: Date.now()
          };
        } else {
          _currentLockedUid = null;
          atomicWriteJsonSync(lockFile, data);
          return;
        }
        atomicWriteJsonSync(lockFile, data);
      });
    } catch (err) {
      console.warn('[accountLock] heartbeat error:', err);
    }
  }, HEARTBEAT_INTERVAL_MS);
  _heartbeatTimer.unref?.();
}

export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/** 轻量判断账号当前是否被任意存活窗口持有锁（只读，不触发写回） */
export function isUidLocked(uid: string): boolean {
  if (!uid) return false;
  const entry = readLockFile().locks[uid];
  if (!entry) return false;
  return Date.now() - entry.ts <= STALE_THRESHOLD_MS && isPidAlive(entry.pid);
}

/** 抢占或续租跨窗口全局调度 Leader 锁（同 sessionId 可续租；死 PID 或超 ttlMs 自动接管） */
export function tryClaimSchedulerLeader(ttlMs: number = DEFAULT_LEADER_TTL_MS): boolean {
  const leaderFile = getLeaderFilePath();
  const mySessionId = getMySessionId();
  const effectiveTtl = Math.max(1_000, ttlMs);
  try {
    return withFileLockSync(leaderFile, () => {
      const now = Date.now();
      const res = readJsonFileSafe<Partial<SchedulerLeaderEntry>>(leaderFile);
      if (res.status === 'ok' && res.data && typeof res.data.pid === 'number' && typeof res.data.ts === 'number') {
        const isMine = res.data.sessionId === mySessionId && res.data.pid === process.pid;
        const isExpired = now - res.data.ts > effectiveTtl;
        if (!isMine && !isExpired && isPidAlive(res.data.pid)) {
          return false;
        }
      }
      atomicWriteJsonSync(leaderFile, { sessionId: mySessionId, pid: process.pid, ts: now });
      return true;
    });
  } catch (err) {
    console.warn('[accountLock] tryClaimSchedulerLeader error:', err);
    return false;
  }
}

/** 释放本窗口持有的调度 Leader 锁 */
export function releaseSchedulerLeader(): void {
  const leaderFile = getLeaderFilePath();
  const mySessionId = getMySessionId();
  try {
    withFileLockSync(leaderFile, () => {
      const res = readJsonFileSafe<Partial<SchedulerLeaderEntry>>(leaderFile);
      if (res.status === 'ok' && res.data?.sessionId === mySessionId && res.data?.pid === process.pid) {
        try {
          if (fs.existsSync(leaderFile)) fs.unlinkSync(leaderFile);
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err;
        }
      }
    });
  } catch (err) {
    console.warn('[accountLock] releaseSchedulerLeader error:', err);
  }
}

/** 判断当前窗口是否仍为有效调度 Leader（只读） */
export function isSchedulerLeader(ttlMs: number = DEFAULT_LEADER_TTL_MS): boolean {
  const res = readJsonFileSafe<Partial<SchedulerLeaderEntry>>(getLeaderFilePath());
  if (res.status !== 'ok' || !res.data || typeof res.data.ts !== 'number') return false;
  return (
    res.data.sessionId === getMySessionId() &&
    res.data.pid === process.pid &&
    Date.now() - res.data.ts <= Math.max(1_000, ttlMs)
  );
}
