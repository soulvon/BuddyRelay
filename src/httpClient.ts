/**
 * 安全 HTTP 客户端与文件下载原语（零 vscode 依赖）
 *
 * 特点：
 * - 统一使用 Buffer[] + Buffer.concat(chunks).toString('utf8') 收包，避免多字节 UTF-8 截断乱码
 * - 支持相对 Location 重定向（默认上限 5 次）；跳转前清除当前 timer 并 res.resume() 排空
 * - 默认阻止 https: -> http: 降级重定向，跨 origin 重定向自动剥离 Authorization 与 Cookie 头
 * - downloadToFile 流式写 .part_ 临时文件，校验状态码 200 与字节数 > 0 后原子 renameWithRetrySync
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
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
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

function stripCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const low = k.toLowerCase();
    if (low === 'authorization' || low === 'cookie') continue;
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
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[httpClient] 清理临时文件失败 ${filePath}:`, err instanceof Error ? err.message : String(err));
    }
  }
}

function serializeBody(
  body: any,
  headers: Record<string, string>
): { payloadBuf: Buffer | undefined; headers: Record<string, string> } {
  const nextHeaders = { ...headers };
  if (body === undefined || body === null) {
    return { payloadBuf: undefined, headers: nextHeaders };
  }
  let payloadBuf: Buffer;
  if (Buffer.isBuffer(body)) {
    payloadBuf = body;
  } else if (typeof body === 'string') {
    payloadBuf = Buffer.from(body, 'utf8');
  } else {
    payloadBuf = Buffer.from(JSON.stringify(body), 'utf8');
    if (!hasHeader(nextHeaders, 'content-type')) {
      nextHeaders['Content-Type'] = 'application/json';
    }
  }
  if (!hasHeader(nextHeaders, 'content-length')) {
    nextHeaders['Content-Length'] = String(payloadBuf.length);
  }
  return { payloadBuf, headers: nextHeaders };
}

/**
 * 底层 HTTP/HTTPS 请求，返回完整原始状态码、响应头、UTF-8 文本与原始 Buffer
 */
export async function httpRequestRaw(urlStr: string, opts: HttpRequestOptions = {}): Promise<HttpRawResponse> {
  const method: HttpMethod = opts.method ?? 'GET';
  const timeoutMs = opts.timeout ?? opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!hasHeader(baseHeaders, 'user-agent')) {
    baseHeaders['User-Agent'] = DEFAULT_HEADERS.USER_AGENT;
  }

  const execute = (
    targetUrl: URL,
    reqMethod: HttpMethod,
    reqHeaders: Record<string, string>,
    reqBody: any,
    redirectsLeft: number
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
      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finishOk = (val: HttpRawResponse) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(val);
      };
      const finishErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(err);
      };

      const onResponse = (res: http.IncomingMessage) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;
        if (REDIRECT_STATUSES.has(statusCode) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) {
            finishErr(new Error('Too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect);
          } catch (err) {
            finishErr(err);
            return;
          }
          let nextHeaders = nextUrl.origin !== targetUrl.origin
            ? stripCrossOriginHeaders(reqHeaders)
            : { ...reqHeaders };
          const switchToGet = reqMethod !== 'GET' && (statusCode === 301 || statusCode === 302 || statusCode === 303);
          const nextMethod: HttpMethod = switchToGet ? 'GET' : reqMethod;
          const nextBody = switchToGet ? undefined : reqBody;
          if (switchToGet) {
            nextHeaders = stripBodyHeaders(nextHeaders);
          }
          settled = true;
          execute(nextUrl, nextMethod, nextHeaders, nextBody, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          finishOk({
            statusCode,
            headers: res.headers,
            body: rawBuffer.toString('utf8'),
            rawBuffer
          });
        });
        res.on('error', finishErr);
      };

      const req = targetUrl.protocol === 'https:'
        ? https.request(targetUrl, { method: reqMethod, headers: headersToSend }, onResponse)
        : http.request(targetUrl, { method: reqMethod, headers: headersToSend }, onResponse);

      timer = setTimeout(() => {
        const timeoutErr = new Error(`Request timeout after ${timeoutMs}ms (${targetUrl.href})`);
        req.destroy(timeoutErr);
        finishErr(timeoutErr);
      }, timeoutMs);

      req.on('error', finishErr);
      if (payloadBuf !== undefined) {
        req.write(payloadBuf);
      }
      req.end();
    });
  };

  return execute(new URL(urlStr), method, baseHeaders, opts.body, maxRedirects);
}

/**
 * 兼容旧 oauthService.httpRequest 签名的通用 HTTP/HTTPS 请求助手：
 * 返回 { status, data, headers }；若响应体为合法 JSON 则自动解析，否则原样返回字符串。
 */
export async function httpRequest<T = any>(
  targetUrl: string,
  options: HttpRequestOptions = {}
): Promise<HttpCompatResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (!hasHeader(headers, 'accept')) {
    headers['Accept'] = 'application/json, text/plain, */*';
  }
  const raw = await httpRequestRaw(targetUrl, { ...options, headers });
  let parsedData: any = raw.body;
  try {
    parsedData = JSON.parse(raw.body);
  } catch {
    // 非 JSON 原样返回
  }
  return {
    status: raw.statusCode || 200,
    data: parsedData as T,
    headers: raw.headers
  };
}

/**
 * 严格 JSON 请求助手：校验 HTTP 2xx 并解析 JSON 返回 T，非 2xx 或 JSON 解析失败抛错。
 */
export async function httpJsonRequest<T = any>(urlStr: string, opts: HttpRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (!hasHeader(headers, 'accept')) {
    headers['Accept'] = 'application/json';
  }
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

/**
 * 安全文件下载：流式写入 .part_ 临时文件，校验 HTTP 200 与字节数 > 0 后原子 rename 替换目标文件。
 */
export async function downloadToFile(
  urlStr: string,
  destPath: string,
  opts: DownloadToFileOptions = {}
): Promise<{ bytes: number; filePath: string }> {
  const timeoutMs = opts.timeout ?? opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowHttpRedirect = opts.allowHttpRedirect ?? false;
  const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!hasHeader(baseHeaders, 'user-agent')) {
    baseHeaders['User-Agent'] = DEFAULT_HEADERS.USER_AGENT;
  }

  const execute = (
    targetUrl: URL,
    reqHeaders: Record<string, string>,
    redirectsLeft: number
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

      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const finishOk = (bytes: number) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve({ bytes, filePath: destPath });
      };
      const finishErr = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        const pathToClean = tmpPath;
        tmpPath = null;
        if (fileStream) {
          const streamToClose = fileStream;
          fileStream = null;
          streamToClose.once('close', () => {
            if (pathToClean) safeUnlink(pathToClean);
          });
          streamToClose.destroy();
        } else if (pathToClean) {
          safeUnlink(pathToClean);
        }
        reject(err);
      };

      const onResponse = (res: http.IncomingMessage) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (REDIRECT_STATUSES.has(status) && location) {
          clearTimer();
          res.resume();
          if (redirectsLeft <= 0) {
            finishErr(new Error('Too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = resolveRedirectTarget(targetUrl, location, allowHttpRedirect);
          } catch (err) {
            finishErr(err);
            return;
          }
          const nextHeaders = nextUrl.origin !== targetUrl.origin
            ? stripCrossOriginHeaders(reqHeaders)
            : { ...reqHeaders };
          settled = true;
          execute(nextUrl, nextHeaders, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          clearTimer();
          res.resume();
          finishErr(new Error(`Download failed: HTTP ${status}`));
          return;
        }

        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
        } catch (err) {
          res.resume();
          finishErr(err);
          return;
        }

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
            if (!tmpPath) {
              finishErr(new Error('Download temp path missing'));
              return;
            }
            if (receivedBytes <= 0) {
              finishErr(new Error('Downloaded file is empty (0 bytes)'));
              return;
            }
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
            streamRef.close((closeErr) => {
              if (closeErr) finishErr(closeErr);
              else finalize();
            });
          } else {
            finalize();
          }
        });
      };

      const req = targetUrl.protocol === 'https:'
        ? https.get(targetUrl, { headers: reqHeaders }, onResponse)
        : http.get(targetUrl, { headers: reqHeaders }, onResponse);

      timer = setTimeout(() => {
        const timeoutErr = new Error(`Download timeout after ${timeoutMs}ms (${targetUrl.href})`);
        req.destroy(timeoutErr);
        finishErr(timeoutErr);
      }, timeoutMs);

      req.on('error', finishErr);
    });
  };

  return execute(new URL(urlStr), baseHeaders, maxRedirects);
}
