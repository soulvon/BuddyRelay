import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type * as vscode from 'vscode';
import { PATHS } from './constants';
import { atomicWriteJsonSync, cleanStaleTempFiles, readJsonFileSafe, withFileLockSync } from './atomicFile';
import { decryptAccountSecrets, encryptAccountSecrets, isEncryptedSecret } from './accountCrypto';
import type { CodeBuddyAccount, PoolFilePayload } from './types';
import { t } from './i18n';

export type { AccountStatus, CodeBuddyAccount, QuotaPackageItem } from './types';

const STORAGE_KEY = 'buddyrelay.accounts.pool';       // 旧迁移源键名（只读迁移，不再写入）
const ACTIVE_ACCOUNT_KEY = 'buddyrelay.accounts.active'; // 旧迁移源键名（只读迁移，不再写入）
const SELF_WRITE_WINDOW_MS = 250;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

/** 账号名称脱敏（邮箱域名同步掩码为 ab***@***，长度<=2 为 u[0] + '***@***'） */
export function maskName(name: string, privacyMode: boolean = true): string {
  if (!name) return t('common.unknown');
  if (!privacyMode) return name;
  if (/^1\d{10}$/.test(name)) return name.slice(0, 3) + '****' + name.slice(7);
  if (name.includes('@')) {
    const u = name.slice(0, name.indexOf('@'));
    const prefix = u.length <= 2 ? (u[0] || '*') : u.slice(0, 2);
    return `${prefix}***@***`;
  }
  if (name.length === 2) return name[0] + '*';
  if (name.length === 3) return name[0] + '**';
  if (name.length > 3) return name[0] + '***' + name.slice(-1);
  return name;
}

/** 账号 UID 脱敏 */
export function maskUid(uid: string, privacyMode: boolean = true): string {
  if (!uid) return '—';
  if (privacyMode) return uid.slice(0, 4) + '****' + uid.slice(-2);
  return uid.slice(0, 8) + '...' + uid.slice(-4);
}

/** 清洗自定义显示名称（剥离控制字符并限制最大长度，空白返回 undefined） */
export function cleanDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  return cleaned || undefined;
}

/** 解析账号展示名称（自定义显示名称优先，留空回退昵称/邮箱/UID） */
export function resolveAccountDisplayName(
  account: Partial<Pick<CodeBuddyAccount, 'displayName' | 'nickname' | 'email' | 'uid'>>
): string {
  const custom = typeof account.displayName === 'string' ? account.displayName.trim() : '';
  return custom || account.nickname || account.email || account.uid || '';
}

function hasPlaintextToken(acc: CodeBuddyAccount): boolean {
  if (typeof acc.accessToken === 'string' && acc.accessToken.length > 0 && !isEncryptedSecret(acc.accessToken)) return true;
  if (typeof acc.refreshToken === 'string' && acc.refreshToken.length > 0 && !isEncryptedSecret(acc.refreshToken)) return true;
  if (acc.authRaw && typeof acc.authRaw === 'object') {
    for (const k of ['accessToken', 'access_token', 'refreshToken', 'refresh_token']) {
      const v = acc.authRaw[k];
      if (typeof v === 'string' && v.length > 0 && !isEncryptedSecret(v)) return true;
    }
  }
  return false;
}

function sanitizeLegacyNotes(acc: CodeBuddyAccount): void {
  if (acc.notes && (acc.notes.includes('额度见底标记') || acc.notes.includes('探针预检失败'))) {
    delete acc.notes;
  }
}

function cleanTagsList(tags: string[]): string[] {
  return Array.from(new Set(Array.isArray(tags) ? tags.map((item) => String(item).trim()).filter(Boolean) : []));
}

function pruneTombstones(raw: Record<string, number> | undefined, now: number): Record<string, number> {
  const next: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return next;
  for (const [id, ts] of Object.entries(raw)) {
    if (typeof ts === 'number' && Number.isFinite(ts) && now - ts < TOMBSTONE_TTL_MS) next[id] = ts;
  }
  return next;
}

/**
 * 账号安全存储中枢 (多窗口共享 + 静态加密 + 跨进程锁合并版)
 */
export class AccountStore extends EventEmitter {
  private accounts: Map<string, CodeBuddyAccount> = new Map();
  private activeId: string | null = null;
  private privacyMode: boolean = false;
  private poolFilePath: string;
  private legacyFallbackFilePath: string;
  private context?: vscode.ExtensionContext;
  private _loadHealthy: boolean = true;

  private _writeQueue: Promise<void> = Promise.resolve();
  private _pendingUpsertIds: Set<string> = new Set();
  private _pendingDeletes: Map<string, number> = new Map();
  private _dirtyActiveId: boolean = false;
  private _dirtyPrivacy: boolean = false;

  private _lastWrittenUpdatedAt: number = 0;
  private _lastSelfWriteMs: number = 0;
  private _lastContentFingerprint: string = '';
  private _reloadTimer: NodeJS.Timeout | null = null;
  private _retryTimer: NodeJS.Timeout | null = null;
  private _watchRetryTimer: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private _watchDesired: boolean = false;

  constructor(context?: vscode.ExtensionContext, customFallbackPath?: string) {
    super();
    this.context = context;
    this.poolFilePath = PATHS.POOL_FILE;
    const defaultDataDir = process.env.APPDATA
      || (process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : path.join(os.homedir(), '.config'));
    this.legacyFallbackFilePath = customFallbackPath || path.join(defaultDataDir, 'BuddyRelay', 'accounts.json');
    if (customFallbackPath) this.poolFilePath = customFallbackPath;

    this.load();
    this.startWatcher();
  }

  public isLoadHealthy(): boolean {
    return this._loadHealthy;
  }

  public getPrivacyMode(): boolean {
    return this.privacyMode;
  }

  public async setPrivacyMode(enabled: boolean): Promise<void> {
    this.privacyMode = enabled;
    this._dirtyPrivacy = true;
    await this.persist();
    this.emit('privacyChange', enabled);
  }

  private backupCorruptFile(): string | null {
    if (!fs.existsSync(this.poolFilePath)) return null;
    const backup = `${this.poolFilePath}.corrupt_${Date.now()}.bak`;
    try {
      fs.copyFileSync(this.poolFilePath, backup);
      return backup;
    } catch {
      return null;
    }
  }

  private markCorruptAndClear(reason: string): void {
    const backup = this.backupCorruptFile();
    this._loadHealthy = false;
    this.accounts.clear();
    this.activeId = null;
    console.warn(`[AccountStore] ${reason}，已保留现场至 ${backup || '原路径'}`);
  }

  private applyDecryptedAccounts(rawAccounts: CodeBuddyAccount[], markPending: boolean): boolean {
    let foundPlaintext = false;
    const decryptedList: CodeBuddyAccount[] = [];
    for (const rawAcc of rawAccounts) {
      if (hasPlaintextToken(rawAcc)) foundPlaintext = true;
      const dec = decryptAccountSecrets(rawAcc);
      sanitizeLegacyNotes(dec);
      decryptedList.push(dec);
    }
    this.accounts.clear();
    for (const acc of decryptedList) {
      this.accounts.set(acc.id, acc);
      if (markPending) this._pendingUpsertIds.add(acc.id);
    }
    return foundPlaintext;
  }

  private computeFingerprint(activeId: string | null, privacyMode: boolean, accounts: CodeBuddyAccount[]): string {
    const sorted = [...accounts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((acc) => ({ ...acc, tags: Array.isArray(acc.tags) ? [...acc.tags].sort() : undefined }));
    return crypto.createHash('sha1').update(JSON.stringify({ activeId, privacyMode, accounts: sorted })).digest('hex');
  }

  /** 从共享号池文件载入账号池（损坏态保留现场并拒绝空池覆写；明文 Token 备份后加密落盘） */
  public load(): void {
    let loaded = false;
    let needsMigrationWrite = false;
    cleanStaleTempFiles(path.dirname(this.poolFilePath), path.basename(this.poolFilePath));

    const poolRes = readJsonFileSafe<PoolFilePayload>(this.poolFilePath);
    if (poolRes.status === 'error') {
      this.markCorruptAndClear(`号池文件读取/解析失败 (${poolRes.error.message})`);
      return;
    }
    if (poolRes.status === 'ok') {
      const data = poolRes.data;
      if (!data || !Array.isArray(data.accounts)) {
        this.markCorruptAndClear('号池结构损坏（accounts 非数组）');
        return;
      }
      try {
        const foundPlaintext = this.applyDecryptedAccounts(data.accounts, false);
        this.activeId = data.activeId || null;
        this.privacyMode = Boolean(data.privacyMode);
        this._lastWrittenUpdatedAt = Number(data.updatedAt) || 0;
        this._loadHealthy = true;
        loaded = true;
        if (foundPlaintext) {
          const preBak = `${this.poolFilePath}.pre-encrypt.bak`;
          try {
            if (!fs.existsSync(preBak)) fs.copyFileSync(this.poolFilePath, preBak);
          } catch (bakErr: any) {
            console.warn(`[AccountStore] 明文迁移前备份失败: ${bakErr?.message || bakErr}`);
          }
          needsMigrationWrite = true;
        }
      } catch (err: any) {
        this.markCorruptAndClear(`号池凭据解密失败 (${err?.message || err})`);
        return;
      }
    }

    // 迁移源 A：旧版本扩展存储（仅在池文件 missing 时只读迁移）
    if (!loaded && this.context?.globalState) {
      try {
        const stored = this.context.globalState.get<CodeBuddyAccount[]>(STORAGE_KEY);
        const storedActive = this.context.globalState.get<string>(ACTIVE_ACCOUNT_KEY);
        if (Array.isArray(stored) && stored.length > 0) {
          this.applyDecryptedAccounts(stored, true);
          this.activeId = storedActive || null;
          this._dirtyActiveId = true;
          this._loadHealthy = true;
          loaded = true;
          needsMigrationWrite = true;
        }
      } catch { /* 迁移源读取失败，继续尝试下一个 */ }
    }

    // 迁移源 B：旧版独立 accounts.json
    if (!loaded && this.legacyFallbackFilePath !== this.poolFilePath) {
      const legacyRes = readJsonFileSafe<PoolFilePayload>(this.legacyFallbackFilePath);
      if (legacyRes.status === 'ok' && Array.isArray(legacyRes.data?.accounts) && legacyRes.data.accounts.length > 0) {
        try {
          this.applyDecryptedAccounts(legacyRes.data.accounts, true);
          this.activeId = legacyRes.data.activeId || null;
          this._dirtyActiveId = true;
          this._loadHealthy = true;
          loaded = true;
          needsMigrationWrite = true;
        } catch (err) {
          console.warn('[AccountStore] 旧版 accounts.json 迁移失败:', err);
        }
      }
    }

    this.normalizeActiveStatus();
    this._lastContentFingerprint = this.computeFingerprint(this.activeId, this.privacyMode, this.getAll());

    if (loaded && needsMigrationWrite) {
      try {
        for (const id of this.accounts.keys()) this._pendingUpsertIds.add(id);
        withFileLockSync(this.poolFilePath, () => this.flushToDiskLockedSync(true));
      } catch (err: any) {
        console.warn(`[AccountStore] 初始迁移加密落盘失败: ${err?.message || err}`);
      }
    }
  }

  /** 在文件锁保护下执行 read-merge-write 并原子落盘 */
  private flushToDiskLockedSync(isMigrationWrite: boolean): boolean {
    if (!this._loadHealthy && this.accounts.size === 0) {
      console.warn('[AccountStore] 当前处于损坏加载态，拒绝拿空池覆写磁盘');
      return false;
    }

    const now = Date.now();
    const diskRes = readJsonFileSafe<PoolFilePayload>(this.poolFilePath);
    const mergedMap = new Map<string, CodeBuddyAccount>();
    let diskTombstones: Record<string, number> = {};
    let diskActiveId: string | null = null;
    let diskPrivacy = this.privacyMode;
    let diskUpdatedAt = 0;
    let hasDiskFile = false;

    if (diskRes.status === 'error') {
      if (this.accounts.size === 0) {
        console.warn(`[AccountStore] 写前读盘失败且内存为空，拒绝覆写: ${diskRes.error.message}`);
        return false;
      }
      this.backupCorruptFile();
      for (const [id, acc] of this.accounts) mergedMap.set(id, { ...acc });
    } else if (diskRes.status === 'ok' && diskRes.data && Array.isArray(diskRes.data.accounts)) {
      hasDiskFile = true;
      diskUpdatedAt = Number(diskRes.data.updatedAt) || 0;
      diskActiveId = diskRes.data.activeId || null;
      diskPrivacy = typeof diskRes.data.privacyMode === 'boolean' ? diskRes.data.privacyMode : this.privacyMode;
      diskTombstones = pruneTombstones(diskRes.data.tombstones, now);

      for (const rawAcc of diskRes.data.accounts) {
        const dec = decryptAccountSecrets(rawAcc);
        sanitizeLegacyNotes(dec);
        mergedMap.set(dec.id, dec);
      }
      for (const [delId, delTs] of this._pendingDeletes) {
        mergedMap.delete(delId);
        diskTombstones[delId] = delTs;
      }
      if (this._pendingUpsertIds.size > 0) {
        for (const id of this._pendingUpsertIds) {
          const localAcc = this.accounts.get(id);
          if (localAcc) {
            mergedMap.set(id, { ...localAcc });
            delete diskTombstones[id];
          }
        }
      } else if (!isMigrationWrite && this._pendingDeletes.size === 0 && !this._dirtyActiveId && !this._dirtyPrivacy) {
        for (const [id, acc] of this.accounts) {
          if (!(id in diskTombstones)) mergedMap.set(id, { ...acc });
        }
      }
    } else {
      for (const [id, acc] of this.accounts) mergedMap.set(id, { ...acc });
    }

    const nextPrivacy = this._dirtyPrivacy || !hasDiskFile ? this.privacyMode : diskPrivacy;
    let nextActiveId = this._dirtyActiveId || !hasDiskFile ? this.activeId : diskActiveId;
    if (nextActiveId && !mergedMap.has(nextActiveId)) nextActiveId = null;

    if (this._dirtyActiveId) {
      for (const acc of mergedMap.values()) {
        if (acc.id === nextActiveId) acc.status = 'active';
        else if (acc.status === 'active') acc.status = 'idle';
      }
    }

    this.accounts = mergedMap;
    this.activeId = nextActiveId;
    this.privacyMode = nextPrivacy;
    this.normalizeActiveStatus();
    this._pendingUpsertIds.clear();
    this._pendingDeletes.clear();
    this._dirtyActiveId = false;
    this._dirtyPrivacy = false;
    this._loadHealthy = true;

    const sortedAccounts = this.getAll();
    const updatedAt = Math.max(Date.now(), this._lastWrittenUpdatedAt + 1, diskUpdatedAt + 1);
    const payload: PoolFilePayload = {
      version: '2.0',
      updatedAt,
      activeId: this.activeId,
      privacyMode: this.privacyMode,
      accounts: sortedAccounts.map((acc) => encryptAccountSecrets(acc))
    };
    if (Object.keys(diskTombstones).length > 0) payload.tombstones = diskTombstones;

    atomicWriteJsonSync(this.poolFilePath, payload, 2);
    this._lastWrittenUpdatedAt = updatedAt;
    this._lastSelfWriteMs = Date.now();
    this._lastContentFingerprint = this.computeFingerprint(this.activeId, this.privacyMode, sortedAccounts);
    return true;
  }

  public async persist(): Promise<void> {
    let wrote = false;
    await this.enqueueWrite(async () => {
      wrote = withFileLockSync(this.poolFilePath, () => this.flushToDiskLockedSync(false));
    });
    if (wrote) this.emit('change', this.getAll());
  }

  public async flushToDisk(): Promise<void> {
    await this.persist();
  }

  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const ready = this._writeQueue.then(() => {}, () => {});
    const next = ready.then(task);
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  private startWatcher(): void {
    if (this.fileWatcher || this._watchDesired) return;
    this._watchDesired = true;
    try {
      const watchDir = path.dirname(this.poolFilePath);
      fs.mkdirSync(watchDir, { recursive: true });
      const base = path.basename(this.poolFilePath);
      this.fileWatcher = fs.watch(watchDir, (_evt, filename) => {
        if (!filename || filename === base || filename.startsWith(base) || filename.includes(base)) {
          this.scheduleReload();
        }
      });
      this.fileWatcher.on('error', (err) => {
        console.warn('[AccountStore] 号池 watcher 出错，1 秒后重试:', err);
        try { this.fileWatcher?.close(); } catch { /* ignore */ }
        this.fileWatcher = null;
        if (this._watchRetryTimer) clearTimeout(this._watchRetryTimer);
        this._watchRetryTimer = setTimeout(() => {
          this._watchRetryTimer = null;
          if (this._watchDesired) {
            this._watchDesired = false;
            this.startWatcher();
          }
        }, 1000);
      });
    } catch (e: any) {
      console.warn('[AccountStore] 号池 watch 启动失败:', e.message);
      this._watchDesired = false;
    }
  }

  private scheduleReload(): void {
    if (this._reloadTimer) return;
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this.reloadFromDisk();
    }, 150);
  }

  /** 从磁盘重载共享号池（自写 250ms 内内容未变跳过；读失败保留内存现状） */
  private reloadFromDisk(): void {
    const res = readJsonFileSafe<PoolFilePayload>(this.poolFilePath);
    if (res.status === 'missing') return;
    if (res.status === 'error') {
      if (!this._retryTimer) {
        this._retryTimer = setTimeout(() => {
          this._retryTimer = null;
          this.reloadFromDisk();
        }, 150);
      }
      console.warn('[AccountStore] 外部号池变更读取失败，保留内存现状:', res.error.message);
      return;
    }

    const data = res.data;
    if (!data || !Array.isArray(data.accounts)) return;
    const incomingUpdatedAt = Number(data.updatedAt) || 0;
    if (incomingUpdatedAt === this._lastWrittenUpdatedAt) return;

    try {
      const decryptedList = data.accounts.map((acc) => {
        const dec = decryptAccountSecrets(acc);
        sanitizeLegacyNotes(dec);
        return dec;
      });
      const incomingActive = data.activeId || null;
      const incomingPrivacy = Boolean(data.privacyMode);
      const incomingFp = this.computeFingerprint(incomingActive, incomingPrivacy, decryptedList);

      if (Date.now() - this._lastSelfWriteMs <= SELF_WRITE_WINDOW_MS && incomingFp === this._lastContentFingerprint) {
        this._lastWrittenUpdatedAt = incomingUpdatedAt;
        return;
      }

      const prevPrivacy = this.privacyMode;
      const nextMap = new Map<string, CodeBuddyAccount>();
      for (const acc of decryptedList) nextMap.set(acc.id, acc);
      for (const delId of this._pendingDeletes.keys()) nextMap.delete(delId);
      for (const id of this._pendingUpsertIds) {
        const local = this.accounts.get(id);
        if (local) nextMap.set(id, { ...local });
      }

      this.accounts = nextMap;
      if (!this._dirtyActiveId) this.activeId = incomingActive;
      if (!this._dirtyPrivacy) this.privacyMode = incomingPrivacy;
      this._lastWrittenUpdatedAt = incomingUpdatedAt;
      this._loadHealthy = true;
      this.normalizeActiveStatus();
      this._lastContentFingerprint = this.computeFingerprint(this.activeId, this.privacyMode, this.getAll());

      if (prevPrivacy !== this.privacyMode) this.emit('privacyChange', this.privacyMode);
      this.emit('change', this.getAll());
    } catch (err: any) {
      console.warn('[AccountStore] 外部号池变更解密失败，保留内存现状:', err?.message || err);
    }
  }

  public dispose(): void {
    this._watchDesired = false;
    for (const timer of [this._reloadTimer, this._retryTimer, this._watchRetryTimer]) {
      if (timer) clearTimeout(timer);
    }
    this._reloadTimer = null;
    this._retryTimer = null;
    this._watchRetryTimer = null;
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch { /* ignore */ }
      this.fileWatcher = null;
    }
  }

  public count(): number {
    return this.accounts.size;
  }

  public getAll(): CodeBuddyAccount[] {
    return Array.from(this.accounts.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  public get(idOrUid: string): CodeBuddyAccount | undefined {
    if (this.accounts.has(idOrUid)) return this.accounts.get(idOrUid);
    for (const acc of this.accounts.values()) {
      if (acc.uid === idOrUid) return acc;
    }
    return undefined;
  }

  public find(query: string): CodeBuddyAccount | undefined {
    const q = query.trim().toLowerCase();
    for (const acc of this.accounts.values()) {
      if (
        acc.id.toLowerCase().includes(q) ||
        acc.uid.toLowerCase().includes(q) ||
        acc.email.toLowerCase().includes(q) ||
        acc.nickname.toLowerCase().includes(q) ||
        (acc.displayName || '').toLowerCase().includes(q)
      ) {
        return acc;
      }
    }
    return undefined;
  }

  public getActive(): CodeBuddyAccount | undefined {
    if (this.activeId && this.accounts.has(this.activeId)) return this.accounts.get(this.activeId);
    for (const acc of this.accounts.values()) {
      if (acc.status === 'active') {
        this.activeId = acc.id;
        return acc;
      }
    }
    return undefined;
  }

  public async setActive(idOrUid: string): Promise<CodeBuddyAccount> {
    const acc = this.get(idOrUid);
    if (!acc) throw new Error(`[AccountStore] ${t('err.targetMissing')}: ${idOrUid}`);

    for (const a of this.accounts.values()) {
      if (a.id === acc.id) {
        a.status = 'active';
        a.lastUsed = Date.now();
        this._pendingUpsertIds.add(a.id);
      } else if (a.status === 'active') {
        a.status = 'idle';
        this._pendingUpsertIds.add(a.id);
      }
    }
    this.activeId = acc.id;
    this._dirtyActiveId = true;
    await this.persist();
    return acc;
  }

  private mergeAccountRecord(existing: CodeBuddyAccount, acc: CodeBuddyAccount): CodeBuddyAccount {
    const incomingDisplayName = cleanDisplayName(acc.displayName);
    const mergedDisplayName = incomingDisplayName || existing.displayName;
    const incomingTags = Array.isArray(acc.tags) && acc.tags.length > 0 ? cleanTagsList(acc.tags) : null;
    const mergedTags = incomingTags
      ? Array.from(new Set([...(existing.tags || []), ...incomingTags]))
      : existing.tags;
    const mergedNotes = typeof acc.notes === 'string' && acc.notes.trim().length > 0 ? acc.notes.trim() : existing.notes;

    let mergedStatus = acc.status || existing.status;
    if (existing.status === 'disabled') {
      mergedStatus = 'disabled';
    } else if (existing.status === 'active') {
      mergedStatus = acc.status === 'disabled' || acc.status === 'expired' ? acc.status : 'active';
    } else if (existing.status === 'expired') {
      const hasValidToken = Boolean(acc.accessToken && (!acc.expiresAt || acc.expiresAt > Date.now()));
      mergedStatus = hasValidToken ? 'idle' : (acc.status || 'expired');
    }

    return {
      ...existing,
      ...acc,
      id: existing.id || acc.id,
      displayName: mergedDisplayName,
      tags: mergedTags,
      notes: mergedNotes,
      status: mergedStatus,
      createdAt: existing.createdAt || acc.createdAt || Date.now(),
      lastUsed: Math.max(existing.lastUsed || 0, acc.lastUsed || 0) || Date.now()
    };
  }

  public async upsert(acc: CodeBuddyAccount): Promise<void> {
    const existing = this.get(acc.id) || this.get(acc.uid);
    const target = existing ? this.mergeAccountRecord(existing, acc) : { ...acc };
    this.accounts.set(target.id, target);
    this._pendingDeletes.delete(target.id);
    this._pendingUpsertIds.add(target.id);
    if (target.status === 'active') {
      this.activeId = target.id;
      this._dirtyActiveId = true;
    }
    this.normalizeActiveStatus();
    await this.persist();
  }

  public async upsertBatch(accounts: CodeBuddyAccount[]): Promise<number> {
    let count = 0;
    for (const acc of accounts) {
      const existing = this.get(acc.id) || this.get(acc.uid);
      const target = existing ? this.mergeAccountRecord(existing, acc) : { ...acc };
      this.accounts.set(target.id, target);
      this._pendingDeletes.delete(target.id);
      this._pendingUpsertIds.add(target.id);
      if (target.status === 'active') {
        this.activeId = target.id;
        this._dirtyActiveId = true;
      }
      count++;
    }
    this.normalizeActiveStatus();
    await this.persist();
    return count;
  }

  public async delete(idOrUid: string): Promise<boolean> {
    const acc = this.get(idOrUid);
    if (!acc) return false;
    this.accounts.delete(acc.id);
    this._pendingUpsertIds.delete(acc.id);
    this._pendingDeletes.set(acc.id, Date.now());
    if (this.activeId === acc.id) {
      this.activeId = null;
      this._dirtyActiveId = true;
      this.normalizeActiveStatus();
    }
    await this.persist();
    return true;
  }

  public async updateStatus(
    idOrUid: string,
    status: CodeBuddyAccount['status'],
    extra?: Partial<CodeBuddyAccount>
  ): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;
    acc.status = status;
    if (extra) Object.assign(acc, extra);
    this._pendingUpsertIds.add(acc.id);
    if (status === 'active') {
      this.activeId = acc.id;
      this._dirtyActiveId = true;
      for (const a of this.accounts.values()) {
        if (a.id !== acc.id && a.status === 'active') {
          a.status = 'idle';
          this._pendingUpsertIds.add(a.id);
        }
      }
    } else if (this.activeId === acc.id) {
      this.activeId = null;
      this._dirtyActiveId = true;
    }
    await this.persist();
  }

  public async updateAccountFields(idOrUid: string, fields: Partial<Omit<CodeBuddyAccount, 'id'>>): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc || !fields) return;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id' || k === 'status' || v === undefined) continue;
      (acc as any)[k] = v;
    }
    if ((fields as any).quotaUnlimited === true && 'totalCredits' in fields && fields.totalCredits === undefined) {
      delete acc.totalCredits;
    }
    this._pendingUpsertIds.add(acc.id);
    await this.persist();
  }

  public async toggleStatus(idOrUid: string): Promise<CodeBuddyAccount | undefined> {
    const acc = this.get(idOrUid);
    if (!acc) return undefined;
    if (acc.status === 'disabled') {
      acc.status = 'idle';
    } else {
      acc.status = 'disabled';
      if (this.activeId === acc.id) {
        this.activeId = null;
        this._dirtyActiveId = true;
      }
    }
    this._pendingUpsertIds.add(acc.id);
    this.normalizeActiveStatus();
    await this.persist();
    return acc;
  }

  public async markRateLimited(idOrUid: string, durationMs: number = 5 * 60 * 1000): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;
    acc.status = 'rate_limited';
    acc.rateLimitUntil = Date.now() + durationMs;
    this._pendingUpsertIds.add(acc.id);
    await this.persist();
  }

  public async clearRateLimit(idOrUid: string): Promise<void> {
    const acc = this.get(idOrUid);
    if (!acc) return;
    if (acc.status === 'rate_limited') {
      acc.status = this.activeId === acc.id ? 'active' : 'idle';
      delete acc.rateLimitUntil;
      this._pendingUpsertIds.add(acc.id);
      await this.persist();
    }
  }

  /** 一次加锁写盘同时更新显示名称、备注和标签（只触发一次 change） */
  public async updateMeta(id: string, meta: { displayName?: string; notes?: string; tags?: string[] }): Promise<boolean> {
    const acc = this.get(id);
    if (!acc) return false;
    if (meta.displayName !== undefined) acc.displayName = cleanDisplayName(meta.displayName);
    if (meta.notes !== undefined) acc.notes = meta.notes ? meta.notes.trim() : undefined;
    if (meta.tags !== undefined) acc.tags = cleanTagsList(meta.tags);
    this._pendingUpsertIds.add(acc.id);
    await this.persist();
    return true;
  }

  public async updateDisplayName(idOrUid: string, displayName: string): Promise<void> {
    await this.updateMeta(idOrUid, { displayName });
  }

  public async updateNotes(idOrUid: string, notes: string): Promise<void> {
    await this.updateMeta(idOrUid, { notes });
  }

  public async updateTags(idOrUid: string, tags: string[]): Promise<void> {
    await this.updateMeta(idOrUid, { tags });
  }

  public getAllTags(): string[] {
    const set = new Set<string>();
    for (const acc of this.accounts.values()) {
      if (Array.isArray(acc.tags)) {
        for (const tag of acc.tags) {
          if (tag) set.add(tag);
        }
      }
    }
    return Array.from(set).sort();
  }

  private normalizeActiveStatus(): void {
    if (this.accounts.size === 0) {
      this.activeId = null;
      return;
    }
    const demoteOtherActives = (winnerId: string) => {
      for (const acc of this.accounts.values()) {
        if (acc.id !== winnerId && acc.status === 'active') {
          acc.status = 'idle';
          this._pendingUpsertIds.add(acc.id);
        }
      }
    };
    const current = this.activeId ? this.accounts.get(this.activeId) : null;
    if (current && current.status === 'active') {
      demoteOtherActives(current.id);
      return;
    }
    for (const acc of this.accounts.values()) {
      if (acc.status === 'active') {
        this.activeId = acc.id;
        demoteOtherActives(acc.id);
        return;
      }
    }
    for (const acc of this.accounts.values()) {
      if (acc.status !== 'disabled' && acc.status !== 'expired') {
        acc.status = 'active';
        this.activeId = acc.id;
        this._pendingUpsertIds.add(acc.id);
        return;
      }
    }
    this.activeId = null;
  }
}
