/**
 * BuddyRelay 核心底层引擎统一导出入口
 */

export * from './constants';
export * from './atomicFile';
export * from './accountCrypto';
export * from './accountLock';
export * from './accountStore';
export * from './cockpitImporter';
export * from './oauthService';
export * from './checkinService';
export * from './seamlessSwitcher';
export * from './autoSwitcher';
export { detectHostEdition, isCnAccount } from './host';
export {
  httpRequestRaw,
  httpJsonRequest,
  downloadToFile,
  formatNetworkError,
  resolveProxyForUrl
} from './httpClient';
export type {
  HttpMethod,
  HttpRequestOptions,
  HttpRawResponse,
  HttpCompatResponse,
  DownloadToFileOptions,
  ResolvedProxyInfo
} from './httpClient';
export type {
  AutoSwitchStrategy,
  HostEdition,
  PoolFilePayload
} from './types';
