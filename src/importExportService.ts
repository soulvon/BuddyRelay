import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AccountStore, CodeBuddyAccount, cleanDisplayName, maskName, maskUid, resolveAccountDisplayName } from './accountStore';
import { CheckinService, todayCN } from './checkinService';
import { CockpitImporter } from './cockpitImporter';
import { extractEnterpriseInfo, resolveEnterprisePaymentType } from './domain';
import { readHostLoginUid } from './hostSession';
import { t } from './i18n';

export type NotifyFn = (level: 'success' | 'error' | 'warn', message: string, detail?: string) => void;
export type SetOperatingFn = (isOperating: boolean, message?: string) => void;

const SAFE_ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PAYMENT_TYPE_LEN = 32;
const JWT_LINE_RE = /\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)\b/;
const JWT_GLOBAL_RE = /\b(eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)\b/g;

/** 生成尊重隐私模式的账号展示名（自定义显示名称优先，邮箱同步掩码域名）。 */
export function formatAccountLabel(
  account: Pick<CodeBuddyAccount, 'nickname' | 'email' | 'uid'> & { displayName?: string },
  privacyMode: boolean = false
): string {
  const raw = resolveAccountDisplayName(account);
  if (!privacyMode || !raw) return raw;
  const masked = maskName(raw, true);
  if (raw.includes('@')) {
    const local = masked.split('@')[0] || raw.slice(0, 2) + '***';
    return `${local}@***`;
  }
  return masked;
}

/** 解码 JWT Payload（提取 sub, uid, nickname, preferred_username, exp）。 */
export function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 规范化外部导入账号字段并进行安全校验（ID 白名单、paymentType 过滤限长、秒级 expiresAt 转换）。 */
export function normalizeImportedAccount(raw: any): CodeBuddyAccount | null {
  if (!raw) return null;
  const data: Record<string, any> | null = typeof raw === 'string'
    ? { access_token: raw.trim() }
    : (typeof raw === 'object' ? raw : null);
  if (!data) return null;

  const accessToken = data.accessToken || data.access_token || data.token;
  if (!accessToken || typeof accessToken !== 'string') return null;

  const jwt = parseJwtPayload(accessToken);
  const uid = data.uid || data.id || jwt?.sub || jwt?.uid;
  if (!uid) return null;

  const now = Date.now();
  const uidStr = String(uid).trim();
  const rawId = typeof data.id === 'string' ? data.id.trim() : '';
  const safeUidPart = uidStr.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 24) || 'acc';
  const safeId = SAFE_ACCOUNT_ID_RE.test(rawId) ? rawId : `imported_${safeUidPart}_${now}`;

  const rawPayment = String(data.paymentType || data.payment_type || 'free')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_PAYMENT_TYPE_LEN);
  const ent = extractEnterpriseInfo({
    enterpriseId: data.enterpriseId ?? data.enterprise_id,
    enterpriseName: data.enterpriseName ?? data.enterprise_name,
    accountType: data.accountType ?? data.account_type,
    profileRaw: data.profileRaw || data.profile_raw,
    authRaw: data.authRaw || data.auth_raw,
    accessToken
  });
  const paymentType = (rawPayment === 'free' || !rawPayment) && ent.enterpriseId
    ? resolveEnterprisePaymentType(ent.accountType, ent.enterpriseId)
    : (rawPayment || 'free');

  const nickname = data.nickname || jwt?.nickname || data.email || jwt?.preferred_username || uidStr;
  const email = data.email || jwt?.preferred_username || data.nickname || uidStr;
  let expiresAt = Number(data.expiresAt ?? data.expires_at ?? (jwt?.exp ? Number(jwt.exp) * 1000 : 0));
  if (!Number.isFinite(expiresAt) || expiresAt < 0) expiresAt = 0;
  if (expiresAt > 0 && expiresAt < 10_000_000_000) expiresAt *= 1000;

  const cleanCustomDisplayName = cleanDisplayName(data.displayName ?? data.display_name);
  const cleanTags = Array.isArray(data.tags)
    ? Array.from(new Set(data.tags.map((v: any) => String(v).trim()).filter(Boolean)))
    : undefined;
  const cleanNotes = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : undefined;

  return {
    id: safeId,
    uid: uidStr,
    email: String(email),
    nickname: String(nickname),
    displayName: cleanCustomDisplayName,
    accessToken: accessToken.trim(),
    refreshToken: String(data.refreshToken || data.refresh_token || ''),
    tokenType: String(data.tokenType || data.token_type || 'Bearer'),
    expiresAt,
    domain: String(data.domain || 'www.codebuddy.cn'),
    paymentType,
    ...(ent.enterpriseId ? { enterpriseId: ent.enterpriseId } : {}),
    ...(ent.enterpriseName ? { enterpriseName: ent.enterpriseName } : {}),
    ...(ent.accountType ? { accountType: ent.accountType } : {}),
    ...(typeof data.quotaUnlimited === 'boolean' ? { quotaUnlimited: data.quotaUnlimited } : {}),
    ...(typeof data.quotaResetAt === 'number' ? { quotaResetAt: data.quotaResetAt } : {}),
    quotaRaw: data.quotaRaw || data.quota_raw,
    authRaw: data.authRaw || data.auth_raw,
    profileRaw: data.profileRaw || data.profile_raw,
    usageRaw: data.usageRaw || data.usage_raw,
    status: data.status === 'disabled' ? 'disabled' : 'idle',
    checkinStreak: typeof data.checkinStreak === 'number'
      ? data.checkinStreak
      : (typeof data.checkin_streak === 'number' ? data.checkin_streak : 0),
    todayCheckedIn: Boolean(data.todayCheckedIn ?? data.today_checked_in),
    lastCheckinDate: data.lastCheckinDate || data.last_checkin_date,
    lastCheckinTime: data.lastCheckinTime || data.last_checkin_time,
    totalCredits: typeof data.totalCredits === 'number' ? data.totalCredits : undefined,
    basePackage: data.basePackage,
    activityPackage: data.activityPackage,
    createdAt: Number(data.createdAt || now),
    lastUsed: Number(data.lastUsed || now),
    notes: cleanNotes,
    tags: cleanTags
  };
}

/** 智能解析多种输入格式（JSON 数组/对象、纯 JWT、分隔符行）。 */
export function parseSmartAccountsInput(text: string): any[] {
  const raw = text.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.accounts)) return parsed.accounts;
    return parsed && typeof parsed === 'object' ? [parsed] : [];
  } catch {
    // 非标准 JSON，走按行智能识别
  }

  const items: any[] = [];
  for (const line of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (line.startsWith('#') || line.startsWith('//')) continue;
    if (JWT_LINE_RE.test(line)) {
      const allJwts = line.match(JWT_GLOBAL_RE) || [];
      items.push({ access_token: allJwts[0], refresh_token: allJwts.length > 1 ? allJwts[1] : '' });
      continue;
    }
    const parts = line.split(/\s*[-]{2,}\s*|\s*[,|\t]\s*/).filter(Boolean);
    if (parts.length >= 2) {
      if (parts[1].startsWith('eyJ')) items.push({ uid: parts[0], access_token: parts[1] });
      else if (parts[0].startsWith('eyJ')) items.push({ access_token: parts[0], uid: parts[1] });
    }
  }
  return items;
}

/** 执行智能文本/JSON 导入并合并已有账号（保留既有 tags/notes）。 */
export async function importAccountsFromText(
  text: string,
  store: AccountStore,
  checkinService: CheckinService,
  callbacks: { setOperating: SetOperatingFn; sendNotify: NotifyFn }
): Promise<void> {
  const raw = text.trim();
  if (!raw) {
    callbacks.sendNotify('error', t('err.importEmpty'));
    return;
  }

  callbacks.setOperating(true, t('msg.parsingImport'));
  try {
    const items = parseSmartAccountsInput(raw);
    if (items.length === 0) {
      callbacks.sendNotify('error', t('err.importUnrecognized'));
      return;
    }

    let freshCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const allToSave: CodeBuddyAccount[] = [];

    for (const item of items) {
      const acc = normalizeImportedAccount(item);
      if (!acc) { skippedCount++; continue; }

      const existing = store.get(acc.id) || store.get(acc.uid);
      if (existing) {
        const preservedDisplayName = existing.displayName && existing.displayName.trim() ? existing.displayName : acc.displayName;
        const preservedTags = Array.isArray(existing.tags) && existing.tags.length > 0 ? existing.tags : acc.tags;
        const preservedNotes = existing.notes && existing.notes.trim() ? existing.notes : acc.notes;
        existing.accessToken = acc.accessToken;
        if (acc.refreshToken) existing.refreshToken = acc.refreshToken;
        if (acc.expiresAt) existing.expiresAt = acc.expiresAt;
        if (acc.quotaRaw) existing.quotaRaw = acc.quotaRaw;
        if (acc.enterpriseId) existing.enterpriseId = acc.enterpriseId;
        if (acc.enterpriseName) existing.enterpriseName = acc.enterpriseName;
        if (acc.accountType) existing.accountType = acc.accountType;
        if (acc.paymentType && acc.paymentType !== 'free') existing.paymentType = acc.paymentType;
        if (existing.status === 'expired') existing.status = 'idle';
        existing.displayName = preservedDisplayName;
        existing.tags = preservedTags;
        existing.notes = preservedNotes;
        existing.lastUsed = Date.now();
        allToSave.push(existing);
        updatedCount++;
      } else {
        allToSave.push(acc);
        freshCount++;
      }
    }

    if (allToSave.length > 0) {
      await store.upsertBatch(allToSave);
      checkinService.batchSyncStatus(allToSave, store).catch(() => {});
    }

    if (freshCount > 0 || updatedCount > 0) {
      const parts: string[] = [];
      if (freshCount > 0) parts.push(t('import.added', freshCount));
      if (updatedCount > 0) parts.push(t('import.updated', updatedCount));
      if (skippedCount > 0) parts.push(t('import.skipped', skippedCount));
      callbacks.sendNotify('success', t('msg.importDone', parts.join('，')));
    } else {
      callbacks.sendNotify('error', t('err.importAllInvalid', skippedCount));
    }
  } catch (err: any) {
    callbacks.sendNotify('error', t('err.importError', err?.message || String(err)));
  } finally {
    callbacks.setOperating(false);
  }
}

/** 通过文件选择对话框导入 JSON 账号池。 */
export async function importFromFileDialog(
  store: AccountStore,
  checkinService: CheckinService,
  callbacks: { setOperating: SetOperatingFn; sendNotify: NotifyFn }
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { [t('fileFilter.jsonAccounts')]: ['json'], [t('fileFilter.allFiles')]: ['*'] },
    openLabel: t('fileFilter.openLabel')
  });
  if (!uris || !uris[0]) return;

  callbacks.setOperating(true, t('msg.readingFile'));
  try {
    const text = await fs.promises.readFile(uris[0].fsPath, 'utf8');
    await importAccountsFromText(text, store, checkinService, callbacks);
  } catch (err: any) {
    callbacks.sendNotify('error', t('err.readFileFailed', err?.message || String(err)));
  } finally {
    callbacks.setOperating(false);
  }
}

/** 读取本机 CodeBuddy 登录态并从 Cockpit Tools 密文库导入该账号。 */
export async function readLocalHostAccount(
  importer: CockpitImporter,
  store: AccountStore,
  checkinService: CheckinService,
  callbacks: { setOperating: SetOperatingFn; sendNotify: NotifyFn }
): Promise<void> {
  callbacks.setOperating(true, t('msg.readingLocalSession'));
  try {
    const uid = readHostLoginUid();
    if (!uid) { callbacks.sendNotify('error', t('err.noLocalSession')); return; }
    if (store.get(uid)) { callbacks.sendNotify('error', t('err.duplicateAccount')); return; }

    let account: CodeBuddyAccount | undefined;
    try {
      account = importer.findAccountByUid(uid);
    } catch (err: any) {
      callbacks.sendNotify('error', t('err.localTokenLocked', uid, err?.message || String(err)));
      return;
    }

    if (!account) {
      callbacks.sendNotify('error', t('err.localTokenLocked', uid, t('err.localNoVaultMatch')));
      return;
    }

    await store.upsert(account);
    checkinService.syncAccountStatus(account, store).catch(() => {});
    const isPrivacy = store.getPrivacyMode?.() ?? false;
    callbacks.sendNotify('success', t('msg.localImported', formatAccountLabel(account, isPrivacy)));
  } catch (err: any) {
    callbacks.sendNotify('error', t('err.localImportFailed', err?.message || String(err)));
  } finally {
    callbacks.setOperating(false);
  }
}

/** 导出号池数据（支持完整凭证备份与剥离凭据的脱敏分享）。 */
export async function exportAccounts(
  store: AccountStore,
  mode: 'full' | 'masked' = 'full',
  sendNotify: NotifyFn
): Promise<void> {
  const list = store.getAll();
  if (list.length === 0) { sendNotify('error', t('err.exportEmpty')); return; }

  const isMasked = mode === 'masked';
  const exportData = list.map((acc) => (isMasked ? {
    id: acc.id,
    uid: maskUid(acc.uid, true),
    email: formatAccountLabel({ nickname: acc.email, email: acc.email, uid: acc.uid }, true),
    nickname: formatAccountLabel({ nickname: acc.nickname, email: acc.email, uid: acc.uid }, true),
    displayName: acc.displayName ? maskName(acc.displayName, true) : undefined,
    status: acc.status,
    totalCredits: acc.totalCredits ?? 0,
    paymentType: acc.paymentType || 'free',
    notes: acc.notes,
    tags: acc.tags
  } : acc));

  const dateTag = todayCN();
  const defaultFileName = isMasked
    ? `buddyrelay-accounts-masked-${dateTag}.json`
    : `buddyrelay-accounts-backup-${dateTag}.json`;

  const uri = await vscode.window.showSaveDialog({
    filters: { 'JSON Files': ['json'] },
    defaultUri: vscode.Uri.file(defaultFileName),
    title: isMasked ? t('saveTitle.masked') : t('saveTitle.full')
  });
  if (!uri) return;

  try {
    await fs.promises.writeFile(uri.fsPath, JSON.stringify(exportData, null, 2), {
      encoding: 'utf8',
      mode: isMasked ? 0o644 : 0o600
    });
    sendNotify(
      'success',
      t('msg.exported', isMasked ? t('exportMode.masked') : t('exportMode.full'), path.basename(uri.fsPath))
    );
  } catch (err: any) {
    sendNotify('error', t('err.exportWriteFailed', err?.message || String(err)));
  }
}
