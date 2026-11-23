/**
 * 账号域名与企业租户判定 (纯函数, 零依赖, 可被测试脚本直接 require)
 * 国内域名 (codebuddy.cn / copilot.tencent.com / 缺省) 可参与签到与成长任务,
 * 国际域名 (codebuddy.ai) 的对应活动不存在。
 */
export interface EnterpriseIdentity {
  enterpriseId: string;
  enterpriseName: string;
  accountType: string;
}

export interface EnterpriseAccountLike {
  enterpriseId?: string;
  enterpriseName?: string;
  accountType?: string;
  profileRaw?: Record<string, any>;
  authRaw?: Record<string, any>;
  accessToken?: string;
}

function parseJwtPayloadSafe(token?: string): Record<string, any> | null {
  if (!token || typeof token !== 'string') return null;
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

function pickNonEmptyStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s && s !== 'personal') return s;
    }
  }
  return '';
}

export function extractEnterpriseInfo(account?: EnterpriseAccountLike): EnterpriseIdentity {
  if (!account || typeof account !== 'object') {
    return { enterpriseId: '', enterpriseName: '', accountType: '' };
  }
  const p = account.profileRaw && typeof account.profileRaw === 'object' ? account.profileRaw : {};
  const a = account.authRaw && typeof account.authRaw === 'object' ? account.authRaw : {};
  const jwt = (!account.enterpriseId && !p.enterpriseId && !p.enterprise_id && !p.tenantId && !p.tenant_id && !a.enterpriseId && !a.enterprise_id)
    ? parseJwtPayloadSafe(account.accessToken)
    : null;

  const enterpriseId = pickNonEmptyStr(
    account.enterpriseId,
    p.enterpriseId, p.enterprise_id, p.tenantId, p.tenant_id,
    a.enterpriseId, a.enterprise_id, a.tenantId, a.tenant_id,
    jwt?.enterpriseId, jwt?.enterprise_id, jwt?.tenantId, jwt?.tenant_id
  );
  const enterpriseName = pickNonEmptyStr(
    account.enterpriseName,
    p.enterpriseName, p.enterprise_name,
    a.enterpriseName, a.enterprise_name
  );
  const accountType = pickNonEmptyStr(
    account.accountType,
    p.type, p.accountType, p.account_type,
    a.type, a.accountType, a.account_type
  ) || (typeof p.type === 'string' ? p.type.trim() : '');

  return { enterpriseId, enterpriseName, accountType };
}

export function isEnterpriseAccount(account?: EnterpriseAccountLike): boolean {
  return Boolean(extractEnterpriseInfo(account).enterpriseId);
}

export function resolveEnterprisePaymentType(accountType?: string, enterpriseId?: string): string {
  const t = String(accountType || '').trim().toLowerCase();
  if (t === 'ultimate' || t === 'exclusive') return t;
  if (enterpriseId && String(enterpriseId).trim()) return 'enterprise';
  return 'free';
}

export function buildEnterpriseHeaders(accountOrId?: EnterpriseAccountLike | string): Record<string, string> {
  const eid = typeof accountOrId === 'string'
    ? accountOrId.trim()
    : extractEnterpriseInfo(accountOrId).enterpriseId;
  if (!eid) return {};
  return {
    'X-Enterprise-Id': eid,
    'X-Tenant-Id': eid
  };
}

export function isCnAccount(domain?: string): boolean {
  if (!domain) {
    return true;
  }
  return !domain.includes('codebuddy.ai') && !domain.includes('workbuddy.ai');
}
