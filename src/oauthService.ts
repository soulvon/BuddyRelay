import { URL } from 'url';
import { API_ENDPOINTS, DEFAULT_HEADERS, getCodeBuddyBaseUrl } from './constants';
import { resolveEnterprisePaymentType } from './domain';
import { httpRequest } from './httpClient';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { t } from './i18n';

export { httpRequest } from './httpClient';

export interface OAuthStateResult {
  state: string;
  authUrl: string;
}

export interface OAuthTokenData {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  refreshExpiresIn?: number;
  domain?: string;
  scope?: string;
  sessionState?: string;
  [key: string]: any;
}

export interface OAuthAccountProfile {
  uid: string;
  nickname: string;
  phoneNumber?: string;
  email?: string;
  accountType?: string;
  type?: string;
  enterpriseId?: string;
  enterpriseName?: string;
  uin?: string;
  [key: string]: any;
}

/**
 * CodeBuddy 官方 OAuth 认证服务（支持国内版 codebuddy.cn 与国际版 codebuddy.ai）
 */
export class OAuthService {
  private baseUrl: string;

  constructor(baseUrl: string = API_ENDPOINTS.CODEBUDDY_CN_BASE) {
    this.baseUrl = this.normalizeBase(baseUrl);
  }

  private normalizeBase(domainOrBaseUrl: string): string {
    if (/^https?:\/\//i.test(domainOrBaseUrl)) {
      return domainOrBaseUrl.replace(/\/+$/, '');
    }
    return getCodeBuddyBaseUrl(domainOrBaseUrl).replace(/\/+$/, '');
  }

  private resolveBaseUrl(domainOrBaseUrl?: string): string {
    if (!domainOrBaseUrl) {
      return this.baseUrl;
    }
    return this.normalizeBase(domainOrBaseUrl);
  }

  private resolveDomainHeader(baseUrl: string, domainOrEdition?: string): string {
    const resolvedHost = new URL(baseUrl).hostname;
    if (
      domainOrEdition &&
      !/^https?:\/\//i.test(domainOrEdition) &&
      domainOrEdition !== 'cn' &&
      domainOrEdition !== 'intl'
    ) {
      return domainOrEdition;
    }
    return resolvedHost;
  }

  /**
   * 1. 发起 OAuth 授权流程，获取 state 和授权登录 URL (支持生成二维码或在浏览器中打开)
   */
  public async createAuthState(platform: string = 'ide', domain?: string): Promise<OAuthStateResult> {
    const base = this.resolveBaseUrl(domain);
    const url = `${base}${API_ENDPOINTS.OAUTH_STATE}?platform=${encodeURIComponent(platform)}`;
    const res = await httpRequest<{
      code: number;
      msg: string;
      data?: { state: string; authUrl: string };
    }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...DEFAULT_HEADERS.NO_AUTH_HEADERS
      },
      body: {},
      timeout: 10000
    });

    if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data?.state) {
      throw new Error(t('err.oauthStateFailed', JSON.stringify(res.data)));
    }

    return {
      state: res.data.data.state,
      authUrl: res.data.data.authUrl
    };
  }

  /**
   * 2. 轮询授权状态获取 Access Token 与 Refresh Token
   */
  public async pollToken(
    state: string,
    options?: {
      timeoutMs?: number;
      intervalMs?: number;
      abortSignal?: AbortSignal;
      domain?: string;
    }
  ): Promise<OAuthTokenData> {
    const timeout = options?.timeoutMs || 120000; // 默认 2 分钟
    const interval = options?.intervalMs || 1500;
    const startTime = Date.now();
    const base = this.resolveBaseUrl(options?.domain);
    const tokenUrl = `${base}${API_ENDPOINTS.OAUTH_TOKEN}?state=${encodeURIComponent(state)}`;

    while (Date.now() - startTime < timeout) {
      if (options?.abortSignal?.aborted) {
        throw new Error(t('err.oauthPollAborted'));
      }

      try {
        const res = await httpRequest<{
          code: number;
          msg: string;
          data?: Record<string, any>;
        }>(tokenUrl, {
          method: 'GET',
          headers: {
            ...DEFAULT_HEADERS.NO_AUTH_HEADERS
          },
          timeout: 8000
        });

        // 成功取得 Token
        if (res.status === 200 && res.data && res.data.code === 0 && res.data.data) {
          const d = res.data.data;
          return {
            accessToken: d.accessToken || d.access_token,
            refreshToken: d.refreshToken || d.refresh_token,
            tokenType: d.tokenType || d.token_type || 'Bearer',
            expiresIn: d.expiresIn || d.expires_in || 7200,
            refreshExpiresIn: d.refreshExpiresIn || d.refresh_expires_in,
            domain: d.domain || new URL(base).hostname,
            scope: d.scope,
            sessionState: d.sessionState,
            ...d
          };
        }

        // 11217 为官方 "login ing..." 等待扫码/确认状态码
        if (res.data && res.data.code === 11217) {
          // 继续轮询
        } else if (res.data && res.data.code !== 0) {
          // 其他明确错误 (结构化错误码标记, 严禁依赖错误文本做控制流——i18n 会改文本)
          const e: any = new Error(t('err.oauthAbnormal', res.data.code, res.data.msg));
          e.code = 'OAUTH_AUTH_ABNORMAL';
          throw e;
        }
      } catch (err: any) {
        if (err && err.code === 'OAUTH_AUTH_ABNORMAL') {
          throw err;
        }
        // 网络抖动时等待重试
      }

      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(t('err.oauthLoginTimeout', timeout / 1000));
  }

  /**
   * 3. 根据 state 与 accessToken 获取用户 Profile 详情
   */
  public async fetchAccountProfile(state: string, accessToken: string, domain?: string): Promise<OAuthAccountProfile> {
    const base = this.resolveBaseUrl(domain);
    const url = `${base}${API_ENDPOINTS.OAUTH_ACCOUNT}?state=${encodeURIComponent(state)}`;
    const res = await httpRequest<{
      code: number;
      msg: string;
      data?: Record<string, any>;
    }>(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Domain': this.resolveDomainHeader(base, domain)
      }
    });

    if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data) {
      throw new Error(t('err.oauthProfileFailed', JSON.stringify(res.data)));
    }

    const p = res.data.data;
    const enterpriseId = typeof (p.enterpriseId || p.enterprise_id) === 'string'
      ? String(p.enterpriseId || p.enterprise_id).trim() || undefined
      : undefined;
    const enterpriseName = typeof (p.enterpriseName || p.enterprise_name) === 'string'
      ? String(p.enterpriseName || p.enterprise_name).trim() || undefined
      : undefined;
    return {
      uid: p.uid || p.oneidAccountId || '',
      nickname: p.nickname || p.phoneNumber || t('oauth.defaultNickname'),
      phoneNumber: p.phoneNumber,
      email: p.phoneNumber || p.nickname || p.uid,
      accountType: p.type || p.accountType || 'personal',
      enterpriseId,
      enterpriseName,
      uin: p.uin,
      ...p
    };
  }

  /**
   * 4. 刷新 Access Token（按账号 domain 自动路由国内/国际端点）
   */
  public async refreshAccessToken(refreshToken: string, domain?: string): Promise<OAuthTokenData> {
    const base = this.resolveBaseUrl(domain);
    const url = `${base}${API_ENDPOINTS.OAUTH_REFRESH}`;
    const dom = this.resolveDomainHeader(base, domain);

    const res = await httpRequest<{
      code: number;
      msg: string;
      data?: Record<string, any>;
    }>(url, {
      method: 'POST',
      headers: {
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Domain': dom,
        'Content-Type': 'application/json'
      },
      body: {}
    });

    if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data) {
      throw new Error(t('err.oauthRefreshFailed', JSON.stringify(res.data)));
    }

    const d = res.data.data;
    return {
      accessToken: d.accessToken || d.access_token,
      refreshToken: d.refreshToken || d.refresh_token || refreshToken,
      tokenType: d.tokenType || 'Bearer',
      expiresIn: d.expiresIn || 7200,
      domain: d.domain || dom,
      ...d
    };
  }

  /**
   * 5. 端到端完整登录链路并保存入库
   */
  public async loginAndSave(
    store: AccountStore,
    options?: {
      platform?: string;
      domain?: string;
      onAuthUrl?: (url: string, state: string) => void;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<CodeBuddyAccount> {
    const base = this.resolveBaseUrl(options?.domain);

    // 1. 获取 state 与登录链接
    const { state, authUrl } = await this.createAuthState(options?.platform || 'ide', options?.domain);
    if (options?.onAuthUrl) {
      options.onAuthUrl(authUrl, state);
    }

    // 2. 轮询直到扫码或网页确认
    const tokenData = await this.pollToken(state, {
      timeoutMs: options?.timeoutMs,
      abortSignal: options?.abortSignal,
      domain: options?.domain
    });

    const resolvedDomain = tokenData.domain || this.resolveDomainHeader(base, options?.domain);

    // 3. 获取用户基本信息
    const profile = await this.fetchAccountProfile(state, tokenData.accessToken, resolvedDomain);

    // 4. 组装 CodeBuddyAccount 模型
    const now = Date.now();
    const expiresAt = now + (tokenData.expiresIn || 7200) * 1000;
    const isIntl = resolvedDomain.includes('codebuddy.ai') || resolvedDomain.includes('workbuddy.ai');
    const idPrefix = isIntl ? 'codebuddy_ai' : 'codebuddy_cn';
    const account: CodeBuddyAccount = {
      id: `${idPrefix}_${profile.uid.replace(/-/g, '')}`,
      uid: profile.uid,
      email: profile.email || profile.phoneNumber || profile.nickname,
      nickname: profile.nickname,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenType: tokenData.tokenType || 'Bearer',
      expiresAt,
      domain: resolvedDomain,
      paymentType: resolveEnterprisePaymentType(profile.accountType, profile.enterpriseId),
      ...(profile.enterpriseId ? { enterpriseId: profile.enterpriseId } : {}),
      ...(profile.enterpriseName ? { enterpriseName: profile.enterpriseName } : {}),
      ...(profile.accountType ? { accountType: profile.accountType } : {}),
      authRaw: tokenData,
      profileRaw: profile,
      status: 'idle',
      createdAt: now,
      lastUsed: now
    };

    // 5. 存入账号池
    await store.upsert(account);
    return account;
  }
}
