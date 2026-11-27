/**
 * 安全 HTTP 客户端与文件下载原语（零 vscode 强依赖）
 *
 * 特点：
 * - 统一使用 Buffer[] + Buffer.concat(chunks).toString('utf8') 收包，避免多字节 UTF-8 截断乱码
 * - 支持 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY 与惰性 VS Code http.proxy 代理穿透（含 HTTPS CONNECT 隧道）
 * - 幂等请求（GET 及下载）与显式声明 retries 的只读请求支持指数退避重试；写请求默认 retries=0 防重放
 * - 递归展开 Node 20/22 AggregateError 避免空错误消息；阻止 https->http 降级重定向并剥离跨域敏感头
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import { DEFAULT_HEADERS } from './constants';
import { renameWithRetrySync } from './atomicFile';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowHttpRedirect?: boolean;
  retries?: number;
  retryDelayMs?: number;
  proxy?: string | false;
}

export interface HttpRawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawBuffer: Buffer;
}

export interface HttpCompatResponse<T = any> {
  status: number;
  data: T;
  headers: http.IncomingHttpHeaders;
}

export interface DownloadToFileOptions {
  headers?: Record<string, string>;
  timeout?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  expectedSize?: number;
  allowHttpRedirect?: boolean;
  retries?: number;
  retryDelayMs?: number;
  proxy?: string | false;
}

export interface ResolvedProxyInfo {
  proxyUrl: URL;
  rejectUnauthorized: boolean;
  source: 'option' | 'env' | 'vscode';
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
  'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ERR_SOCKET_CLOSED', 'UND_ERR_CONNECT_TIMEOUT'
]);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RETRY_DELAY_MS = 400;

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

function isLoopbackHost(hostname: string): boolean {
  const h = stripBrackets(hostname).toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '127.0.0.1' || h.startsWith('127.');
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

function stripCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    if (low === 'authorization' || low === 'cookie' || low === 'proxy-authorization') continue;
    next[k] = v;
  }
  return next;
}

function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    if (low === 'content-length' || low === 'content-type') continue;
    next[k] = v;
  }
  return next;
}

function resolveRedirectTarget(currentUrl: URL, location: string, allowHttpRedirect: boolean): URL {
  const nextUrl = new URL(location, currentUrl);
  if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
    throw new Error(`Unsupported redirect protocol: ${nextUrl.protocol}`);
  }
  if (currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:' && !allowHttpRedirect) {
    throw new Error(`Blocked insecure HTTPS -> HTTP redirect to ${nextUrl.origin}`);
  }
  return nextUrl;
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[httpClient] 清理临时文件失败 ${filePath}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

/** 递归格式化网络异常，解决 Node 20/22 双栈连接失败时 AggregateError.message 为空串的问题 */
export function formatNetworkError(err: unknown): string {
  const seen = new Set<string>();
  const collect = (e: unknown): void => {
    if (!e || typeof e !== 'object') {
      const s = String(e ?? '').trim();
      if (s) seen.add(s);
      return;
    }
    const obj = e as Record<string, any>;
    if (Array.isArray(obj.errors) && obj.errors.length > 0) {
      const top = String(obj.message || '').trim();
      if (top) seen.add(top);
      for (const sub of obj.errors) collect(sub);
      return;
    }
    const code = typeof obj.code === 'string' ? obj.code.trim() : '';
    const msg = typeof obj.message === 'string' ? obj.message.trim() : '';
    const addr = typeof obj.address === 'string' ? obj.address.trim() : '';
    const port = obj.port ? `:${obj.port}` : '';
    if (msg) {
      seen.add(code && !msg.includes(code) ? `[${code}] ${msg}` : msg);
    } else if (code) {
      seen.add(addr ? `${code} ${addr}${port}` : code);
    } else {
      const s = String(e).trim();
      if (s && s !== '[object Object]') seen.add(s);
    }
  };
  collect(err);
  return seen.size > 0 ? Array.from(seen).join('; ') : 'Unknown network error';
}

function normalizeNetworkError(err: unknown): Error {
  const msg = formatNetworkError(err);
  const src = (err && typeof err === 'object' ? err : {}) as Record<string, any>;
  if (err instanceof Error && err.message === msg) return err;
  const out: any = new Error(msg);
  if (src.code) out.code = src.code;
  if (typeof src.proxyStatusCode === 'number') out.proxyStatusCode = src.proxyStatusCode;
  if (typeof src.httpStatusCode === 'number') out.httpStatusCode = src.httpStatusCode;
  if (src.errors) out.errors = src.errors;
  return out;
}

function isRetryableError(err: any): boolean {
  if (!err || typeof err !== 'object') return false;
  if (typeof err.httpStatusCode === 'number') return RETRYABLE_STATUSES.has(err.httpStatusCode);
  if (typeof err.proxyStatusCode === 'number') return RETRYABLE_STATUSES.has(err.proxyStatusCode);
  if (typeof err.code === 'string' && RETRYABLE_CODES.has(err.code)) return true;
  if (Array.isArray(err.errors) && err.errors.some((sub: unknown) => isRetryableError(sub))) return true;
  return /socket hang up|timeout|network socket disconnected|TLS connection was established/i.test(String(err.message || ''));
}

async function waitRetryBackoff(baseDelayMs: number, attempt: number): Promise<void> {
  const base = Math.max(10, baseDelayMs) * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
  await new Promise((r) => setTimeout(r, base + jitter));
}

/** 匹配 NO_PROXY 规则（支持 *、精确主机、.suffix/suffix 子域、host:port 与 IPv6） */
export function isNoProxyMatch(hostname: string, port: string, noProxy: string): boolean {
  if (!noProxy || !noProxy.trim()) return false;
  const host = stripBrackets(hostname).toLowerCase();
  for (const rawEntry of noProxy.split(/[,\s]+/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let ruleHost = entry;
    let rulePort = '';
    if (entry.startsWith('[')) {
      const closeIdx = entry.indexOf(']');
      if (closeIdx > 0) {
        ruleHost = entry.slice(1, closeIdx);
        if (entry[closeIdx + 1] === ':') rulePort = entry.slice(closeIdx + 2);
      }
    } else {
      const colonIdx = entry.lastIndexOf(':');
      if (colonIdx > 0 && entry.indexOf(':') === colonIdx) {
        ruleHost = entry.slice(0, colonIdx);
        rulePort = entry.slice(colonIdx + 1);
      }
    }
    if (rulePort && rulePort !== port) continue;
    const domain = ruleHost.replace(/^\.+/, '');
    if (!domain) continue;
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function readVscodeHttpConfig(): { proxySupport: string; proxy: string; strictSsl: boolean; noProxy: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vs = require('vscode');
    const cfg = vs?.workspace?.getConfiguration?.('http');
    if (!cfg || typeof cfg.get !== 'function') return null;
    const rawNoProxy = cfg.get('noProxy', []);
    const noProxy = Array.isArray(rawNoProxy) ? rawNoProxy.join(',') : String(rawNoProxy || '');
    return {
      proxySupport: String(cfg.get('proxySupport', 'override') || 'override').toLowerCase(),
      proxy: String(cfg.get('proxy', '') || '').trim(),
      strictSsl: cfg.get('proxyStrictSSL', true) !== false,
      noProxy
    };
  } catch {
    return null;
  }
}

/** 解析目标 URL 应当使用的代理配置；命中 NO_PROXY 或回环默认直连返回 null */
export function resolveProxyForUrl(
  targetUrl: URL,
  opts?: { proxy?: string | false; env?: NodeJS.ProcessEnv }
): ResolvedProxyInfo | null {
  if (opts?.proxy === false) return null;
  const vsCfg = readVscodeHttpConfig();
  const rejectUnauthorized = vsCfg ? vsCfg.strictSsl : true;
  const hasExplicit = typeof opts?.proxy === 'string' && opts.proxy.trim().length > 0;
  if (!hasExplicit && isLoopbackHost(targetUrl.hostname)) return null;

  const env = opts?.env ?? process.env;
  let rawProxy = '';
  let source: ResolvedProxyInfo['source'] = 'option';

  if (hasExplicit) {
    rawProxy = String(opts!.proxy).trim();
  } else {
    const noProxy = [env.NO_PROXY, env.no_proxy, vsCfg?.noProxy].filter(Boolean).join(',');
    if (isNoProxyMatch(targetUrl.hostname, effectivePort(targetUrl), noProxy)) return null;
    const keys = targetUrl.protocol === 'https:'
      ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
      : ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
    for (const k of keys) {
      const val = env[k];
      if (val && val.trim()) {
        rawProxy = val.trim();
        source = 'env';
        break;
      }
    }
    if (!rawProxy && vsCfg && vsCfg.proxySupport !== 'off' && vsCfg.proxy) {
      rawProxy = vsCfg.proxy;
      source = 'vscode';
    }
  }
  if (!rawProxy) return null;

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawProxy) ? rawProxy : `http://${rawProxy}`);
  } catch {
    console.warn('[httpClient] 忽略无效代理地址');
    return null;
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
    console.warn(`[httpClient] 暂不支持代理协议 ${proxyUrl.protocol}，将回退直连`);
    return null;
  }
  if (stripBrackets(proxyUrl.hostname).toLowerCase() === stripBrackets(targetUrl.hostname).toLowerCase() &&
      effectivePort(proxyUrl) === effectivePort(targetUrl)) {
    return null;
  }
  return { proxyUrl, rejectUnauthorized, source };
}

/** 返回脱敏的代理状态标签，绝不暴露账密或内网主机名 */
export function getProxyDiagnosticSummary(): string {
  try {
    const info = resolveProxyForUrl(new URL('https://www.codebuddy.cn'));
    return info ? info.source : 'direct';
  } catch {
    return 'direct';
  }
}

function buildProxyAuthHeader(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  const user = decodeURIComponent(proxyUrl.username || '');
  const pass = decodeURIComponent(proxyUrl.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

function openConnectTunnel(
  targetUrl: URL,
  proxyInfo: ResolvedProxyInfo,
  registerDestroyer: (fn: () => void) => void
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const { proxyUrl, rejectUnauthorized } = proxyInfo;
    const rawHost = stripBrackets(targetUrl.hostname);
    const connectAuthority = `${rawHost.includes(':') ? `[${rawHost}]` : rawHost}:${effectivePort(targetUrl)}`;
    const connectHeaders: Record<string, string> = { Host: connectAuthority };
    const proxyAuth = buildProxyAuthHeader(proxyUrl);
    if (proxyAuth) connectHeaders['Proxy-Authorization'] = proxyAuth;

    const reqOpts: http.RequestOptions = {
      hostname: stripBrackets(proxyUrl.hostname),
      port: Number(effectivePort(proxyUrl)),
      method: 'CONNECT',
      path: connectAuthority,
      headers: connectHeaders,
      agent: false
    };
    let done = false;
    let tlsSock: tls.TLSSocket | null = null;
    const proxyReq = proxyUrl.protocol === 'https:'
      ? https.request({ ...reqOpts, rejectUnauthorized })
      : http.request(reqOpts);

    registerDestroyer(() => {
      try { proxyReq.destroy(); } catch { /* ignore */ }
      try { tlsSock?.destroy(); } catch { /* ignore */ }
    });

    const fail = (err: unknown) => {
      if (done) return;
      done = true;
      reject(normalizeNetworkError(err));
    };

    proxyReq.on('connect', (res, socket, head) => {
      if (done) { socket.destroy(); return; }
      if (res.statusCode !== 200) {
        socket.destroy();
        const err: any = new Error(`Proxy CONNECT failed: HTTP ${res.statusCode || 0}`);
        err.proxyStatusCode = res.statusCode || 0;
        fail(err);
        return;
      }
      if (head && head.length > 0) socket.unshift(head);
      tlsSock = tls.connect({
        socket,
        servername: net.isIP(rawHost) ? undefined : rawHost,
        rejectUnauthorized
      });
      registerDestroyer(() => {
        try { tlsSock?.destroy(); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
      });
      tlsSock.once('secureConnect', () => {
        if (!done) { done = true; resolve(tlsSock!); }
      });
      tlsSock.once('error', fail);
    });
    proxyReq.on('response', (res) => {
      res.resume();
      const err: any = new Error(`Proxy CONNECT unexpected response: HTTP ${res.statusCode || 0}`);
      err.proxyStatusCode = res.statusCode || 0;
      fail(err);
    });
    proxyReq.on('error', fail);
    proxyReq.end();
  });
}

function dispatchOutgoingRequest(
  targetUrl: URL,
  method: HttpMethod,
  headersToSend: Record<string, string>,
  proxyInfo: ResolvedProxyInfo | null,
  registerDestroyer: (fn: () => void) => void,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: unknown) => void,
  payloadBuf?: Buffer
): void {
  const startReq = (req: http.ClientRequest) => {
    registerDestroyer(() => { try { req.destroy(); } catch { /* ignore */ } });
    req.on('error', onError);
    if (payloadBuf !== undefined) req.write(payloadBuf);
    req.end();
  };

  if (!proxyInfo) {
    const req = targetUrl.protocol === 'https:'
      ? https.request(targetUrl, { method, headers: headersToSend, autoSelectFamilyAttemptTimeout: 1000 } as any, onResponse)
      : http.request(targetUrl, { method, headers: headersToSend, autoSelectFamilyAttemptTimeout: 1000 } as any, onResponse);
    startReq(req);
    return;
  }

  if (targetUrl.protocol === 'http:') {
    const { proxyUrl, rejectUnauthorized } = proxyInfo;
    const fwdHeaders: Record<string, string> = { ...headersToSend };
    if (!hasHeader(fwdHeaders, 'host')) fwdHeaders['Host'] = targetUrl.host;
    const proxyAuth = buildProxyAuthHeader(proxyUrl);
    if (proxyAuth) fwdHeaders['Proxy-Authorization'] = proxyAuth;
    const reqOpts: http.RequestOptions = {
      hostname: stripBrackets(proxyUrl.hostname),
      port: Number(effectivePort(proxyUrl)),
      method,
      path: targetUrl.href,
      headers: fwdHeaders,
      agent: false
    };
    const req = proxyUrl.protocol === 'https:'
      ? https.request({ ...reqOpts, rejectUnauthorized }, onResponse)
      : http.request(reqOpts, onResponse);
    startReq(req);
    return;
  }

  openConnectTunnel(targetUrl, proxyInfo, registerDestroyer)
    .then((tlsSocket) => {
      const req = https.request(
        targetUrl,
        { method, headers: headersToSend, createConnection: () => tlsSocket } as any,
        onResponse
      );
      startReq(req);
    })
    .catch(onError);
}

function serializeBody(
  body: any,
  headers: Record<string, string>
): { payloadBuf: Buffer | undefined; headers: Record<string, string> } {
  const nextHeaders = { ...headers };
  if (body === undefined || body === null) return { payloadBuf: undefined, headers: nextHeaders };
  let payloadBuf: Buffer;
  if (Buffer.isBuffer(body)) {
    payloadBuf = body;
  } else if (typeof body === 'string') {
    payloadBuf = Buffer.from(body, 'utf8');
  } else {
    payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
    if (!hasHeader(nextHeaders, 'content-type')) nextHeaders['Content-Type'] = 'application/json';
  }
  if (!hasHeader(nextHeaders, 'content-length')) nextHeaders['Content-Length'] = String(payloadBuf.length);
  return { payloadBuf, headers: nextHeaders };
}

/** 底层 HTTP/HTTPS 请求，支持代理、Redirect 安全剥离与可配置退避重试 */
export async function httpRequestRaw(urlStr: string, opts: HttpRequestOptions = {}): Promise<HttpRawResponse> {
  const method: HttpMethod = opts.method ?? 'GET';
  const timeoutMs = opts.timeout ?? opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const maxRetries = Math.max(0, opts.retries ?? (method === 'GET' ? 2 : 0));
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!hasHeader(baseHeaders, 'user-agent')) baseHeaders['User-Agent'] = DEFAULT_HEADERS.USER_AGENT;

  const executeOnce = (
    targetUrl: URL,
    reqMethod: HttpMethod,
    reqHeaders: Record<string, string>,
    reqBody: any,
    redirectsLeft: number,
    canRetryStatus: boolean
  ): Promise<HttpRawResponse> => {
    return new Promise((resolve, reject) => {
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        reject(new Error(`Unsupported protocol: ${targetUrl.protocol}`));
        return;
      }
      const { payloadBuf, headers: headersToSend } =
        reqMethod === 'GET' ? { payloadBuf: undefined, headers: { ...reqHeaders } } : serializeBody(reqBody, reqHeaders);

      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const destroyers: Array<() => void> = [];
      const destroyAll = () => { while (destroyers.length) { try { destroyers.pop()!(); } catch { /* ignore */ } } };
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const finishOk = (val: HttpRawResponse) => { if (!settled) { settled = true; clearTimer(); resolve(val); } };
      const finishErr = (err: unknown) => { if (!settled) { settled = true; clearTimer(); destroyAll(); reject(normalizeNetworkError(err)); } };

      const onResponse = (res: http.IncomingMessage) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(statusCode) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) { finishErr(new Error('Too many redirects')); return; }
          let nextUrl: URL;
          try { nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect); }
          catch (err) { finishErr(err); return; }
          let nextHeaders = nextUrl.origin !== targetUrl.origin ? stripCrossOriginHeaders(reqHeaders) : { ...reqHeaders };
          const switchToGet = reqMethod !== 'GET' && (statusCode === 301 || statusCode === 302 || statusCode === 303);
          const nextMethod: HttpMethod = switchToGet ? 'GET' : reqMethod;
          const nextBody = switchToGet ? undefined : reqBody;
          if (switchToGet) nextHeaders = stripBodyHeaders(nextHeaders);
          settled = true;
          executeOnce(nextUrl, nextMethod, nextHeaders, nextBody, redirectsLeft - 1, canRetryStatus).then(resolve, reject);
          return;
        }
        if (canRetryStatus && RETRYABLE_STATUSES.has(statusCode)) {
          res.resume();
          const retryErr: any = new Error(`HTTP ${statusCode}`);
          retryErr.httpStatusCode = statusCode;
          finishErr(retryErr);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          finishOk({ statusCode, headers: res.headers, body: rawBuffer.toString('utf8'), rawBuffer });
        });
        res.on('error', finishErr);
      };

      timer = setTimeout(() => {
        const timeoutErr: any = new Error(`Request timeout after ${timeoutMs}ms (${targetUrl.href})`);
        timeoutErr.code = 'ETIMEDOUT';
        finishErr(timeoutErr);
      }, timeoutMs);

      const proxyInfo = resolveProxyForUrl(targetUrl, { proxy: opts.proxy });
      dispatchOutgoingRequest(
        targetUrl, reqMethod, headersToSend, proxyInfo,
        (fn) => destroyers.push(fn), onResponse, finishErr, payloadBuf
      );
    });
  };

  const parsedTarget = new URL(urlStr);
  for (let attempt = 0; ; attempt++) {
    try {
      return await executeOnce(parsedTarget, method, baseHeaders, opts.body, maxRedirects, attempt < maxRetries);
    } catch (err) {
      if (attempt < maxRetries && isRetryableError(err)) {
        await waitRetryBackoff(retryDelayMs, attempt);
        continue;
      }
      throw err;
    }
  }
}

/** 兼容通用 HTTP/HTTPS 请求助手：返回 { status, data, headers } */
export async function httpRequest<T = any>(
  targetUrl: string,
  options: HttpRequestOptions = {}
): Promise<HttpCompatResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (!hasHeader(headers, 'accept')) headers['Accept'] = 'application/json, text/plain, */*';
  const raw = await httpRequestRaw(targetUrl, { ...options, headers });
  let parsedData: any = raw.body;
  try { parsedData = JSON.parse(raw.body); } catch { /* 非 JSON 原样返回 */ }
  return { status: raw.statusCode || 200, data: parsedData as T, headers: raw.headers };
}

/** 严格 JSON 请求助手：校验 HTTP 2xx 并解析 JSON 返回 T */
export async function httpJsonRequest<T = any>(urlStr: string, opts: HttpRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (!hasHeader(headers, 'accept')) headers['Accept'] = 'application/json';
  const raw = await httpRequestRaw(urlStr, { ...opts, headers });
  if (raw.statusCode < 200 || raw.statusCode >= 300) {
    throw new Error(`HTTP ${raw.statusCode}: ${raw.body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(raw.body) as T;
  } catch (err) {
    throw new Error(`Invalid JSON response from ${urlStr}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 安全文件下载：流式写 .part_ 临时文件，支持代理与失败重试，校验后原子替换目标文件 */
export async function downloadToFile(
  urlStr: string,
  destPath: string,
  opts: DownloadToFileOptions = {}
): Promise<{ bytes: number; filePath: string }> {
  const timeoutMs = opts.timeout ?? opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const maxRetries = Math.max(0, opts.retries ?? 2);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!hasHeader(baseHeaders, 'user-agent')) baseHeaders['User-Agent'] = DEFAULT_HEADERS.USER_AGENT;

  const executeOnce = (
    targetUrl: URL,
    reqHeaders: Record<string, string>,
    redirectsLeft: number,
    canRetryStatus: boolean
  ): Promise<{ bytes: number; filePath: string }> => {
    return new Promise((resolve, reject) => {
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        reject(new Error(`Unsupported protocol: ${targetUrl.protocol}`));
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let tmpPath: string | null = null;
      let fileStream: fs.WriteStream | null = null;
      const destroyers: Array<() => void> = [];
      const destroyAll = () => { while (destroyers.length) { try { destroyers.pop()!(); } catch { /* ignore */ } } };
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const finishOk = (bytes: number) => { if (!settled) { settled = true; clearTimer(); resolve({ bytes, filePath: destPath }); } };
      const finishErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        destroyAll();
        const pathToClean = tmpPath;
        tmpPath = null;
        if (fileStream) {
          const streamToClose = fileStream;
          fileStream = null;
          streamToClose.once('close', () => { if (pathToClean) safeUnlink(pathToClean); });
          streamToClose.destroy();
        } else if (pathToClean) {
          safeUnlink(pathToClean);
        }
        reject(normalizeNetworkError(err));
      };

      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(status) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) { finishErr(new Error('Too many redirects')); return; }
          let nextUrl: URL;
          try { nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect); }
          catch (err) { finishErr(err); return; }
          const nextHeaders = nextUrl.origin !== targetUrl.origin ? stripCrossOriginHeaders(reqHeaders) : { ...reqHeaders };
          settled = true;
          executeOnce(nextUrl, nextHeaders, redirectsLeft - 1, canRetryStatus).then(resolve, reject);
          return;
        }
        if (canRetryStatus && RETRYABLE_STATUSES.has(status)) {
          res.resume();
          const retryErr: any = new Error(`Download failed: HTTP ${status}`);
          retryErr.httpStatusCode = status;
          finishErr(retryErr);
          return;
        }
        if (status !== 200) {
          res.resume();
          finishErr(new Error(`Download failed: HTTP ${status}`));
          return;
        }
        try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); }
        catch (err) { res.resume(); finishErr(err); return; }

        tmpPath = `${destPath}.part_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        fileStream = fs.createWriteStream(tmpPath);
        let receivedBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        });
        res.on('error', finishErr);
        fileStream.on('error', finishErr);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          clearTimer();
          const streamRef = fileStream;
          fileStream = null;
          const finalize = () => {
            if (settled) return;
            if (!tmpPath) { finishErr(new Error('Download temp path missing')); return; }
            if (receivedBytes <= 0) { finishErr(new Error('Downloaded file is empty (0 bytes)')); return; }
            if (typeof opts.expectedSize === 'number' && opts.expectedSize > 0 && receivedBytes !== opts.expectedSize) {
              finishErr(new Error(`Downloaded size mismatch: expected ${opts.expectedSize}, got ${receivedBytes}`));
              return;
            }
            try {
              renameWithRetrySync(tmpPath, destPath);
              tmpPath = null;
              finishOk(receivedBytes);
            } catch (err) {
              finishErr(err);
            }
          };
          if (streamRef) {
            streamRef.close((closeErr) => { if (closeErr) finishErr(closeErr); else finalize(); });
          } else {
            finalize();
          }
        });
      };

      timer = setTimeout(() => {
        const timeoutErr: any = new Error(`Download timeout after ${timeoutMs}ms (${targetUrl.href})`);
        timeoutErr.code = 'ETIMEDOUT';
        finishErr(timeoutErr);
      }, timeoutMs);

      const proxyInfo = resolveProxyForUrl(targetUrl, { proxy: opts.proxy });
      dispatchOutgoingRequest(
        targetUrl, 'GET', reqHeaders, proxyInfo,
        (fn) => destroyers.push(fn), onResponse, finishErr
      );
    });
  };

  const parsedTarget = new URL(urlStr);
  for (let attempt = 0; ; attempt++) {
    try {
      return await executeOnce(parsedTarget, baseHeaders, maxRedirects, attempt < maxRetries);
    } catch (err) {
      if (attempt < maxRetries && isRetryableError(err)) {
        await waitRetryBackoff(retryDelayMs, attempt);
        continue;
      }
      throw err;
    }
  }
}
