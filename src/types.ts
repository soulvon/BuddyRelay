/**
 * BuddyRelay 核心共享类型定义（零 vscode 依赖）
 */

export interface QuotaPackageItem {
  title: string;
  count: number;
  remain: number;
  total: number;
  percent: number;
}

export type AccountStatus = 'active' | 'idle' | 'expired' | 'rate_limited' | 'disabled';

export interface CodeBuddyAccount {
  /** 账号唯一标识 (Cockpit 格式如 codebuddy_cn_xxx 或 uid) */
  id: string;
  /** 官方用户 UUID (如 5d81daec-a2d4-48ae-aecf-193c4c3884c3) */
  uid: string;
  /** 手机号 / 邮箱 / 登录名 */
  email: string;
  /** 昵称 */
  nickname: string;
  /** 用户自定义显示名称（留空时回退 nickname / email） */
  displayName?: string;
  /** JWT 访问令牌 */
  accessToken: string;
  /** 刷新令牌 */
  refreshToken: string;
  /** 令牌类型 (默认 Bearer) */
  tokenType: string;
  /** 过期时间戳 (毫秒) */
  expiresAt: number;
  /** 域名 */
  domain: string;
  /** 计费类型 (free / pro / enterprise / ultimate / exclusive) */
  paymentType?: string;
  /** 企业租户 ID（企业版账号必填，用于 X-Enterprise-Id / X-Tenant-Id 与独立额度接口） */
  enterpriseId?: string;
  /** 企业名称 */
  enterpriseName?: string;
  /** 账号类型 (personal / pro / ultimate / exclusive) */
  accountType?: string;
  /** 企业周期额度是否为不限额 (-1) */
  quotaUnlimited?: boolean;
  /** 企业周期额度重置时间戳 (毫秒) */
  quotaResetAt?: number;
  /** 原始配额信息快照 */
  quotaRaw?: Record<string, any>;
  /** 官方 auth 原始结构 */
  authRaw?: Record<string, any>;
  /** 官方 profile 原始结构 */
  profileRaw?: Record<string, any>;
  /** 官方 usage 原始结构 */
  usageRaw?: Record<string, any>;
  /** 账号当前调度状态 */
  status: AccountStatus;
  /** 连续签到天数 */
  checkinStreak?: number;
  /** 今日是否已完成签到 */
  todayCheckedIn?: boolean;
  /** 最近签到日期 (YYYY-MM-DD) */
  lastCheckinDate?: string;
  /** 最近签到时间戳 */
  lastCheckinTime?: number;
  /** 额度积分 / 算力点 */
  totalCredits?: number;
  /** 基础体验包配额信息 (Cockpit Tools 口径) */
  basePackage?: QuotaPackageItem;
  /** 活动赠送包配额信息 (Cockpit Tools 口径) */
  activityPackage?: QuotaPackageItem;
  /** 创建时间戳 */
  createdAt: number;
  /** 最近一次使用/切换时间戳 */
  lastUsed: number;
  /** 429 速率限制冷却截止时间戳 */
  rateLimitUntil?: number;
  /** 备注说明 */
  notes?: string;
  /** 自定义业务标签集合 (如 主力, 挂机, 出海A) */
  tags?: string[];
}

export type HostEdition = 'cn' | 'intl';

export type AutoSwitchStrategy = 'highest_quota' | 'lru' | 'round_robin' | 'health_priority';

export type RotationStrategy = AutoSwitchStrategy;

export interface PoolFilePayload {
  version?: string;
  updatedAt?: number;
  activeId?: string | null;
  privacyMode?: boolean;
  accounts: CodeBuddyAccount[];
  tombstones?: Record<string, number>;
}
