import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';

/**
 * 跨窗口账号锁 (Kite 同款机理)
 * 多窗口共享 account-locks.json，心跳 + pid 判活 + 过期清理，保障多窗口下账号互斥：
 * - 每窗口为当前活跃账号持锁，UI 可展示"被另一窗口占用"
 * - 自动切号候选自动排除其他存活窗口正持有的账号
 * - 崩溃残留的僵尸锁靠 90s 过期 + pid 判活自动清理
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

const LOCK_FILE = process.env.BUDDYRELAY_LOCK_FILE || PATHS.LOCK_FILE;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s 心跳
const STALE_THRESHOLD_MS = 90_000;    // 90s 超时视为死锁

let _heartbeatTimer: NodeJS.Timeout | null = null;
let _currentWindowId = '';
let _currentWindowName = '';
let _currentLockedUid: string | null = null;

function readLockFile(): LockFile {
  if (!fs.existsSync(LOCK_FILE)) return { locks: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return { locks: parsed.locks && typeof parsed.locks === 'object' ? parsed.locks : {} };
  } catch {
    // 读失败 = 未知，按无锁处理（只读查询不阻塞业务）
    return { locks: {} };
  }
}

function writeLockFile(data: LockFile): void {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    const tmp = LOCK_FILE + '.tmp.' + process.pid + '.' + Date.now();
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, LOCK_FILE);
    } catch (_) {
      // Windows 下偶发 EPERM/EBUSY（文件被另一窗口读取中），降级直接覆写
      try { fs.writeFileSync(LOCK_FILE, json, 'utf8'); } catch (writeErr) {
        console.warn('[accountLock] writeLockFile fallback failed:', writeErr);
      }
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[accountLock] writeLockFile error:', err);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = 进程存活但拒绝信号，必须视为存活
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function cleanStaleLocks(data: LockFile): boolean {
  const now = Date.now();
  let changed = false;
  for (const [uid, entry] of Object.entries(data.locks)) {
    const isStale = now - entry.ts > STALE_THRESHOLD_MS;
    const isDead = !isPidAlive(entry.pid);
    if (isStale || isDead) {
      delete data.locks[uid];
      changed = true;
    }
  }
  return changed;
}

/**
 * 初始化锁模块，设置本窗口标识
 */
export function initAccountLock(windowId: string, windowName?: string): void {
  _currentWindowId = windowId || `pid-${process.pid}`;
  _currentWindowName = windowName || '';
}

/**
 * 锁定账号（切换成功/激活变更后调用）
 */
export function acquireLock(uid: string): void {
  if (!uid) return;
  const data = readLockFile();
  cleanStaleLocks(data);

  // 释放本窗口旧锁
  if (_currentLockedUid && _currentLockedUid !== uid) {
    const old = data.locks[_currentLockedUid];
    if (old && old.pid === process.pid) {
      delete data.locks[_currentLockedUid];
    }
  }

  data.locks[uid] = {
    windowId: _currentWindowId,
    windowName: _currentWindowName || undefined,
    pid: process.pid,
    ts: Date.now()
  };
  _currentLockedUid = uid;

  try { writeLockFile(data); } catch (err) {
    console.warn('[accountLock] acquireLock write error:', err);
  }
}

/**
 * 释放本窗口持有的账号锁（切走或退出时调用）
 */
export function releaseLock(uid?: string): void {
  const target = uid || _currentLockedUid;
  if (!target) return;

  const data = readLockFile();
  const entry = data.locks[target];
  // 只释放自己的锁（pid 校验，严禁误删他窗）
  if (entry && entry.pid === process.pid) {
    delete data.locks[target];
    try { writeLockFile(data); } catch (err) {
      console.warn('[accountLock] releaseLock write error:', err);
    }
  }
  if (_currentLockedUid === target) {
    _currentLockedUid = null;
  }
}

/**
 * 获取被其他存活窗口占用的账号 UID 集合
 */
export function getOtherLockedUids(): Set<string> {
  const data = readLockFile();
  if (cleanStaleLocks(data)) {
    try { writeLockFile(data); } catch { /* ignore */ }
  }

  const result = new Set<string>();
  for (const [uid, entry] of Object.entries(data.locks)) {
    if (entry.pid === process.pid) continue; // 排除自己
    if (isPidAlive(entry.pid)) {
      result.add(uid);
    }
  }
  return result;
}

/**
 * 获取被其他存活窗口占用的账号映射（含窗口名，供 UI 展示占用方）
 */
export function getOtherLockedMap(): Record<string, { windowName: string; pid: number }> {
  const data = readLockFile();
  if (cleanStaleLocks(data)) {
    try { writeLockFile(data); } catch { /* ignore */ }
  }

  const result: Record<string, { windowName: string; pid: number }> = {};
  for (const [uid, entry] of Object.entries(data.locks)) {
    if (entry.pid === process.pid) continue;
    if (isPidAlive(entry.pid)) {
      result[uid] = {
        windowName: entry.windowName || `窗口 ${entry.windowId || entry.pid}`,
        pid: entry.pid
      };
    }
  }
  return result;
}

/**
 * 启动心跳（定期刷新自己的锁时间戳；锁被抢走则让位防 ping-pong）
 */
export function startHeartbeat(): void {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    if (!_currentLockedUid) return;
    try {
      const data = readLockFile();
      cleanStaleLocks(data);

      const entry = data.locks[_currentLockedUid];
      if (entry && entry.pid === process.pid) {
        entry.ts = Date.now(); // 正常续期
      } else if (!entry) {
        // 锁被过期清理了（如文件被删），重新获取
        data.locks[_currentLockedUid] = {
          windowId: _currentWindowId,
          windowName: _currentWindowName || undefined,
          pid: process.pid,
          ts: Date.now()
        };
      } else {
        // 锁被另一个存活窗口抢走，放弃持有（防 ping-pong）
        _currentLockedUid = null;
        writeLockFile(data);
        return;
      }
      writeLockFile(data);
    } catch (err) {
      console.warn('[accountLock] heartbeat error:', err);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

/**
 * 轻量判断账号当前是否被任意存活窗口持有锁（只读，不触发清理写回，适合高频调用）
 */
export function isUidLocked(uid: string): boolean {
  if (!uid) return false;
  const data = readLockFile();
  const entry = data.locks[uid];
  if (!entry) return false;
  if (Date.now() - entry.ts > STALE_THRESHOLD_MS) return false;
  if (!isPidAlive(entry.pid)) return false;
  return true;
}
