import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { API_ENDPOINTS, DEFAULT_HEADERS } from './constants';
import { CodeBuddyAccount, AccountStore } from './accountStore';

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
  uin?: string;
  [key: string]: any;
}

/**
 * 原生通用 HTTP/HTTPS JSON 请求助手
 */
export function httpRequest<T = any>(
  targetUrl: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers?: Record<string, string>;
    body?: any;
    timeout?: number;
  } = {}
): Promise<{ status: number; data: T; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;

    const reqHeaders: Record<string, string | number> = {
      'User-Agent': DEFAULT_HEADERS.USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      ...(options.headers || {})
    };

    let bodyData: string | Buffer | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
        bodyData = options.body;
      } else {
        bodyData = JSON.stringify(options.body);
        if (!reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const reqOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: reqHeaders,
      timeout: options.timeout || 15000
    };

    const req = client.request(reqOptions, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsedData: any = raw;
        try {
          parsedData = JSON.parse(raw);
        } catch (_) {
          // 非 JSON 原样返回
        }
        resolve({
          status: res.statusCode || 200,
          data: parsedData,
          headers: res.headers
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`[OAuthService] 请求超时 (${options.timeout || 15000}ms): ${targetUrl}`));
    });

    req.on('error', err => {
      reject(err);
    });

    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

/**
 * CodeBuddy 官方 OAuth 认证服务
 */
export class OAuthService {
  private baseUrl: string;

  constructor(baseUrl: string = API_ENDPOINTS.CODEBUDDY_CN_BASE) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 1. 发起 OAuth 授权流程，获取 state 和授权登录 URL (支持生成二维码或在浏览器中打开)
   */
  public async createAuthState(platform: string = 'ide'): Promise<OAuthStateResult> {
    const url = `${this.baseUrl}${API_ENDPOINTS.OAUTH_STATE}?platform=${encodeURIComponent(platform)}`;
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
      body: {}
    });

    if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data?.state) {
      throw new Error(`[OAuthService] 请求 auth/state 失败: ${JSON.stringify(res.data)}`);
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
    }
  ): Promise<OAuthTokenData> {
    const timeout = options?.timeoutMs || 120000; // 默认 2 分钟
    const interval = options?.intervalMs || 1500;
    const startTime = Date.now();
    const tokenUrl = `${this.baseUrl}${API_ENDPOINTS.OAUTH_TOKEN}?state=${encodeURIComponent(state)}`;

    while (Date.now() - startTime < timeout) {
      if (options?.abortSignal?.aborted) {
        throw new Error('[OAuthService] 轮询已手动中止');
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
            domain: d.domain || new URL(this.baseUrl).hostname,
            scope: d.scope,
            sessionState: d.sessionState,
            ...d
          };
        }

        // 11217 为官方 "login ing..." 等待扫码/确认状态码
        if (res.data && res.data.code === 11217) {
          // 继续轮询
        } else if (res.data && res.data.code !== 0) {
          // 其他明确错误
          throw new Error(`[OAuthService] 授权返回异常: [${res.data.code}] ${res.data.msg}`);
        }
      } catch (err: any) {
        if (err.message && err.message.includes('授权返回异常')) {
          throw err;
        }
        // 网络抖动时等待重试
      }

      await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`[OAuthService] 登录等待超时 (${timeout / 1000}秒未完成登录)`);
  }

  /**
   * 3. 根据 state 与 accessToken 获取用户 Profile 详情
   */
  public async fetchAccountProfile(state: string, accessToken: string): Promise<OAuthAccountProfile> {
    const url = `${this.baseUrl}${API_ENDPOINTS.OAUTH_ACCOUNT}?state=${encodeURIComponent(state)}`;
    const res = await httpRequest<{
      code: number;
      msg: string;
      data?: Record<string, any>;
    }>(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-Domain': new URL(this.baseUrl).hostname
      }
    });

    if (res.status !== 200 || !res.data || res.data.code !== 0 || !res.data.data) {
      throw new Error(`[OAuthService] 获取用户信息失败: ${JSON.stringify(res.data)}`);
    }

    const p = res.data.data;
    return {
      uid: p.uid || p.oneidAccountId || '',
      nickname: p.nickname || p.phoneNumber || 'CodeBuddy用户',
      phoneNumber: p.phoneNumber,
      email: p.phoneNumber || p.nickname || p.uid,
      accountType: p.type || p.accountType || 'personal',
      uin: p.uin,
      ...p
    };
  }

  /**
   * 4. 刷新 Access Token
   */
  public async refreshAccessToken(refreshToken: string, domain?: string): Promise<OAuthTokenData> {
    const url = `${this.baseUrl}${API_ENDPOINTS.OAUTH_REFRESH}`;
    const dom = domain || new URL(this.baseUrl).hostname;

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
      throw new Error(`[OAuthService] 刷新 Token 失败: ${JSON.stringify(res.data)}`);
    }

    const d = res.data.data;
    return {
      accessToken: d.accessToken || d.access_token,
      refreshToken: d.refreshToken || d.refresh_token || refreshToken,
      tokenType: d.tokenType || 'Bearer',
      expiresIn: d.expiresIn || 7200,
      domain: dom,
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
      onAuthUrl?: (url: string, state: string) => void;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
    }
  ): Promise<CodeBuddyAccount> {
    // 1. 获取 state 与登录链接
    const { state, authUrl } = await this.createAuthState(options?.platform || 'ide');
    if (options?.onAuthUrl) {
      options.onAuthUrl(authUrl, state);
    }

    // 2. 轮询直到扫码或网页确认
    const tokenData = await this.pollToken(state, {
      timeoutMs: options?.timeoutMs,
      abortSignal: options?.abortSignal
    });

    // 3. 获取用户基本信息
    const profile = await this.fetchAccountProfile(state, tokenData.accessToken);

    // 4. 组装 CodeBuddyAccount 模型
    const now = Date.now();
    const expiresAt = now + (tokenData.expiresIn || 7200) * 1000;
    const account: CodeBuddyAccount = {
      id: `codebuddy_cn_${profile.uid.replace(/-/g, '')}`,
      uid: profile.uid,
      email: profile.email || profile.phoneNumber || profile.nickname,
      nickname: profile.nickname,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenType: tokenData.tokenType || 'Bearer',
      expiresAt,
      domain: tokenData.domain || new URL(this.baseUrl).hostname,
      paymentType: 'free',
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
