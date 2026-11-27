import type { QuotaPackageItem } from './types';
import { EnterpriseIdentity, resolveEnterprisePaymentType } from './domain';

/**
 * 账号配额响应纯解析引擎（零 vscode 依赖）
 * 对齐 CodeBuddy 5.0.0 新聚合端点 /billing/meter/get-user-resource-summary、
 * 旧分页端点 /v2/billing/meter/get-user-resource 与企业端点 /v2/billing/meter/get-enterprise-user-usage。
 */

export interface DetailedQuotaResult {
  totalCredits?: number;
  basePackage: QuotaPackageItem;
  activityPackage: QuotaPackageItem;
  isEnterprise?: boolean;
  quotaUnlimited?: boolean;
  quotaResetAt?: number;
  enterpriseId?: string;
  enterpriseName?: string;
  accountType?: string;
  paymentType?: string;
}

export interface QuotaLabels {
  base: string;
  activity: string;
  enterprise: string;
}

const BASE_FREE_CODES = new Set([
  'TCACA_code_001_PqouKr6QWV', // free
  'TCACA_code_006_DbXS0lrypC', // gift
  'TCACA_code_008_cfWoLwvjU4', // freeMon
  'TCACA_code_035_ArVxJcGDsm'  // freeMonIntl
]);

const PAID_PLAN_CODES = new Set([
  'TCACA_code_002_AkiJS3ZHF5', // proMon
  'TCACA_code_005_maRGyrHhw1', // proMonPlus
  'TCACA_code_003_FAnt7lcmRT', // proYear
  'TCACA_code_023_4xbGhMrE6q', // youth
  'TCACA_code_026_BaESVICNoi', // advanced
  'TCACA_code_027_0FCGVA6vSa', // flagship
  'TCACA_code_043_6oIkxT7Z0S'  // buddyOneVip
]);

const TRIAL_PLAN_CODES = new Set([
  'TCACA_code_039_KRcQj7wUat', // proTrialMon
  'TCACA_code_040_mi9rCYg46x'  // proTrialYear
]);

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function toNum(v: unknown): number {
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function isBaseOrPlanPackage(code: string, name: string = ''): boolean {
  if (BASE_FREE_CODES.has(code) || PAID_PLAN_CODES.has(code) || TRIAL_PLAN_CODES.has(code)) return true;
  return name.includes('基础') || name.includes('体验');
}

export function parseResetTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 10_000_000_000 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return num < 10_000_000_000 ? num * 1000 : num;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return undefined;
}

export function buildEmptyPersonalQuota(labels: QuotaLabels, totalCredits: number = 0): DetailedQuotaResult {
  return {
    totalCredits: round2(Math.max(0, totalCredits)),
    quotaUnlimited: false,
    basePackage: { title: labels.base, count: 0, remain: 0, total: 0, percent: 0 },
    activityPackage: { title: labels.activity, count: 0, remain: 0, total: 0, percent: 0 }
  };
}

function inferPersonalPaymentType(subCode: string, isPaidUser: boolean, pkgCodes: Set<string>): string | undefined {
  if (PAID_PLAN_CODES.has(subCode)) return 'pro';
  if (TRIAL_PLAN_CODES.has(subCode)) return 'trial';
  for (const c of pkgCodes) {
    if (PAID_PLAN_CODES.has(c)) return 'pro';
  }
  for (const c of pkgCodes) {
    if (TRIAL_PLAN_CODES.has(c)) return 'trial';
  }
  if (isPaidUser) return 'pro';
  return undefined;
}

/**
 * 解析 CodeBuddy 5.0.0 新聚合接口 POST /billing/meter/get-user-resource-summary 的 data 体
 */
export function parseUserResourceSummary(
  data: any,
  labels: QuotaLabels
): { quota: DetailedQuotaResult; empty: boolean } | null {
  if (!data || typeof data !== 'object') return null;
  const pkgs = Array.isArray(data.Packages) ? data.Packages : [];
  const rawTotal = data.TotalCredits !== undefined && data.TotalCredits !== null ? toNum(data.TotalCredits) : NaN;
  const subCode = String(data.SubscriptionPackageCode || '').trim();
  const isPaidUser = Boolean(data.IsPaidUser);

  if (pkgs.length === 0) {
    const fallbackTotal = Number.isFinite(rawTotal) ? Math.max(0, rawTotal) : 0;
    const inferredPay = inferPersonalPaymentType(subCode, isPaidUser, new Set());
    return {
      empty: true,
      quota: {
        ...buildEmptyPersonalQuota(labels, fallbackTotal),
        ...(inferredPay ? { paymentType: inferredPay } : {})
      }
    };
  }

  let bRemain = 0;
  let bTotal = 0;
  let bCount = 0;
  let aRemain = 0;
  let aTotal = 0;
  let aCount = 0;
  const seenCodes = new Set<string>();

  for (const pkg of pkgs) {
    if (!pkg || typeof pkg !== 'object') continue;
    const code = String(pkg.PackageCode || '').trim();
    if (code) seenCodes.add(code);
    const remain = Math.max(0, toNum(pkg.CycleRemainCapacity));
    const total = Math.max(0, toNum(pkg.CycleTotalCapacity));
    const cnt = Math.max(1, Math.floor(toNum(pkg.TotalCount)) || 1);
    if (isBaseOrPlanPackage(code)) {
      bRemain += remain;
      bTotal += total;
      bCount += cnt;
    } else {
      aRemain += remain;
      aTotal += total;
      aCount += cnt;
    }
  }

  const finalBTotal = bCount > 0 ? (bTotal > 0 ? bTotal : 500) : 0;
  const bPercent = finalBTotal > 0 ? Math.max(0, Math.min(100, (bRemain / finalBTotal) * 100)) : 0;
  const aPercent = aTotal > 0 ? Math.max(0, Math.min(100, (aRemain / aTotal) * 100)) : 0;
  const totalCredits = Number.isFinite(rawTotal) && rawTotal >= 0 ? round2(rawTotal) : round2(bRemain + aRemain);
  const inferredPay = inferPersonalPaymentType(subCode, isPaidUser, seenCodes);

  return {
    empty: false,
    quota: {
      totalCredits,
      quotaUnlimited: false,
      ...(inferredPay ? { paymentType: inferredPay } : {}),
      basePackage: {
        title: labels.base,
        count: bCount,
        remain: round2(bRemain),
        total: round2(finalBTotal),
        percent: round1(bPercent)
      },
      activityPackage: {
        title: labels.activity,
        count: aCount,
        remain: round2(aRemain),
        total: round2(aTotal),
        percent: round1(aPercent)
      }
    }
  };
}

/**
 * 解析旧分页接口 POST /v2/billing/meter/get-user-resource 的 Accounts 数组
 */
export function parseLegacyUserResourceAccounts(
  pkgs: any[],
  labels: QuotaLabels
): DetailedQuotaResult | null {
  if (!Array.isArray(pkgs) || pkgs.length === 0) return null;
  const basePkgs: any[] = [];
  const actPkgs: any[] = [];
  const seenCodes = new Set<string>();

  for (const pkg of pkgs) {
    const code = String(pkg?.PackageCode || '').trim();
    const name = String(pkg?.PackageName || '');
    if (code) seenCodes.add(code);
    if (isBaseOrPlanPackage(code, name)) basePkgs.push(pkg);
    else actPkgs.push(pkg);
  }

  const bRemain = basePkgs.reduce((s, p) => s + Math.max(0, toNum(p.CycleCapacityRemainPrecise)), 0);
  const bTotal = basePkgs.reduce((s, p) => s + Math.max(0, toNum(p.CycleCapacitySizePrecise)), 0);
  const bCount = basePkgs.length || 1;
  const finalBTotal = bTotal > 0 ? bTotal : 500;
  const bPercent = finalBTotal > 0 ? Math.max(0, Math.min(100, (bRemain / finalBTotal) * 100)) : 0;

  const aRemain = actPkgs.reduce((s, p) => s + Math.max(0, toNum(p.CycleCapacityRemainPrecise)), 0);
  const aTotal = actPkgs.reduce((s, p) => s + Math.max(0, toNum(p.CycleCapacitySizePrecise)), 0);
  const aCount = actPkgs.length;
  const aPercent = aTotal > 0 ? Math.max(0, Math.min(100, (aRemain / aTotal) * 100)) : 0;
  const inferredPay = inferPersonalPaymentType('', false, seenCodes);

  return {
    totalCredits: round2(bRemain + aRemain),
    quotaUnlimited: false,
    ...(inferredPay ? { paymentType: inferredPay } : {}),
    basePackage: {
      title: labels.base,
      count: bCount,
      remain: round2(bRemain),
      total: round2(finalBTotal),
      percent: round1(bPercent)
    },
    activityPackage: {
      title: labels.activity,
      count: aCount,
      remain: round2(aRemain),
      total: round2(aTotal),
      percent: round1(aPercent)
    }
  };
}

/**
 * 解析企业版周期额度接口 /v2/billing/meter/get-enterprise-user-usage
 */
export function parseEnterpriseQuotaPayload(
  raw: any,
  ent: EnterpriseIdentity,
  labels: QuotaLabels
): DetailedQuotaResult | null {
  if (!raw || typeof raw.limitNum !== 'number') return null;
  const used = typeof raw.credit === 'number' && Number.isFinite(raw.credit)
    ? Math.max(0, round2(raw.credit))
    : 0;
  const quotaResetAt = parseResetTimestamp(raw.cycleResetTime ?? raw.cycleEndTime);
  const paymentType = resolveEnterprisePaymentType(ent.accountType, ent.enterpriseId);
  const baseMeta = {
    isEnterprise: true,
    quotaResetAt,
    enterpriseId: ent.enterpriseId,
    ...(ent.enterpriseName ? { enterpriseName: ent.enterpriseName } : {}),
    ...(ent.accountType ? { accountType: ent.accountType } : {}),
    paymentType
  };

  if (raw.limitNum === -1) {
    return {
      ...baseMeta,
      totalCredits: undefined,
      quotaUnlimited: true,
      basePackage: { title: labels.enterprise, count: 1, remain: used, total: -1, percent: 100 },
      activityPackage: { title: labels.activity, count: 0, remain: 0, total: 0, percent: 100 }
    };
  }

  const limit = Math.max(0, round2(raw.limitNum));
  const remain = Math.max(0, round2(raw.limitNum - used));
  const percent = limit > 0 ? Math.max(0, Math.min(100, round1((remain / limit) * 100))) : 0;
  return {
    ...baseMeta,
    totalCredits: remain,
    quotaUnlimited: false,
    basePackage: { title: labels.enterprise, count: 1, remain, total: limit, percent },
    activityPackage: { title: labels.activity, count: 0, remain: 0, total: 0, percent }
  };
}
