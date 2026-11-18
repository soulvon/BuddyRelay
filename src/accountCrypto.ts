/**
 * 账号凭据磁盘静态加密（AES-256-GCM，零 vscode 依赖）
 *
 * 密文格式：enc:v1:<ivHex>:<tagHex>:<cipherHex>
 * 主密钥路径：process.env.BUDDYRELAY_MASTER_KEY_FILE || path.join(PATHS.RELAY_DIR, 'master.key')
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from './constants';
import { atomicWriteFileSync, withFileLockSync } from './atomicFile';

export const ENC_PREFIX = 'enc:v1:';

const KEY_FILENAME = 'master.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEX_RE = /^[0-9a-f]+$/i;

const masterKeyCache = new Map<string, Buffer>();

function normalizeCacheKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveMasterKeyPath(): string {
  const envKeyFile = process.env.BUDDYRELAY_MASTER_KEY_FILE?.trim();
  return path.resolve(envKeyFile || path.join(PATHS.RELAY_DIR, KEY_FILENAME));
}

function parseMasterKeyFile(keyPath: string): Buffer {
  const raw = fs.readFileSync(keyPath, 'utf8').trim();
  const key = raw.length === KEY_BYTES * 2 && HEX_RE.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid master key length (${key.length} bytes) at ${keyPath}`);
  }
  return key;
}

function readExistingMasterKey(): Buffer {
  const keyPath = resolveMasterKeyPath();
  const cacheKey = normalizeCacheKey(keyPath);
  if (!fs.existsSync(keyPath)) {
    masterKeyCache.delete(cacheKey);
    throw new Error(`Master key file not found: ${keyPath}`);
  }
  const cached = masterKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const key = parseMasterKeyFile(keyPath);
  masterKeyCache.set(cacheKey, key);
  return key;
}

function getOrCreateMasterKey(): Buffer {
  const keyPath = resolveMasterKeyPath();
  const cacheKey = normalizeCacheKey(keyPath);
  if (fs.existsSync(keyPath)) {
    const cached = masterKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const existing = parseMasterKeyFile(keyPath);
    masterKeyCache.set(cacheKey, existing);
    return existing;
  }

  return withFileLockSync(keyPath, () => {
    if (fs.existsSync(keyPath)) {
      const existing = parseMasterKeyFile(keyPath);
      masterKeyCache.set(cacheKey, existing);
      return existing;
    }
    const key = crypto.randomBytes(KEY_BYTES);
    atomicWriteFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    masterKeyCache.set(cacheKey, key);
    return key;
  });
}

function encryptWithKey(plain: string, key: Buffer): string {
  if (!plain) return '';
  if (isEncryptedSecret(plain)) return plain;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptWithKey(stored: string, key: Buffer): string {
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) return stored;

  const payload = stored.slice(ENC_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Malformed encrypted credential payload');
  }

  const [ivHex, tagHex, cipherHex] = parts;
  if (
    !HEX_RE.test(ivHex) ||
    !HEX_RE.test(tagHex) ||
    !HEX_RE.test(cipherHex) ||
    cipherHex.length % 2 !== 0
  ) {
    throw new Error('Invalid hex encoding in encrypted credential payload');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const cipherBuf = Buffer.from(cipherHex, 'hex');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Invalid encrypted credential IV or auth tag length');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  return plainBuf.toString('utf8');
}

/**
 * 判断字符串是否已是 enc:v1: 密文格式
 */
export function isEncryptedSecret(v: string): boolean {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX);
}

/**
 * 加密单个敏感凭据字符串。空串返回 ''，已加密密文原样返回。
 */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  if (isEncryptedSecret(plain)) return plain;
  const key = getOrCreateMasterKey();
  return encryptWithKey(plain, key);
}

/**
 * 解密单个敏感凭据字符串。空串返回 ''，明文原样返回；密文解密失败必须抛错。
 */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!isEncryptedSecret(stored)) return stored;
  const key = readExistingMasterKey();
  return decryptWithKey(stored, key);
}

const RAW_TOKEN_KEYS = ['accessToken', 'access_token', 'refreshToken', 'refresh_token'] as const;

function hasNonEmptyPlainSecret(acc: { accessToken?: string; refreshToken?: string; authRaw?: Record<string, any> }): boolean {
  if (typeof acc.accessToken === 'string' && acc.accessToken.length > 0 && !isEncryptedSecret(acc.accessToken)) {
    return true;
  }
  if (typeof acc.refreshToken === 'string' && acc.refreshToken.length > 0 && !isEncryptedSecret(acc.refreshToken)) {
    return true;
  }
  if (acc.authRaw && typeof acc.authRaw === 'object') {
    for (const k of RAW_TOKEN_KEYS) {
      const val = acc.authRaw[k];
      if (typeof val === 'string' && val.length > 0 && !isEncryptedSecret(val)) {
        return true;
      }
    }
  }
  return false;
}

function hasEncryptedSecret(acc: { accessToken?: string; refreshToken?: string; authRaw?: Record<string, any> }): boolean {
  if (typeof acc.accessToken === 'string' && isEncryptedSecret(acc.accessToken)) {
    return true;
  }
  if (typeof acc.refreshToken === 'string' && isEncryptedSecret(acc.refreshToken)) {
    return true;
  }
  if (acc.authRaw && typeof acc.authRaw === 'object') {
    for (const k of RAW_TOKEN_KEYS) {
      const val = acc.authRaw[k];
      if (typeof val === 'string' && isEncryptedSecret(val)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 加密账号对象中的令牌字段（返回新对象，不修改原对象）
 */
export function encryptAccountSecrets<T extends { accessToken?: string; refreshToken?: string }>(acc: T): T {
  const withRaw = acc as T & { authRaw?: Record<string, any> };
  const out = { ...acc } as T & { authRaw?: Record<string, any> };
  if (withRaw.authRaw && typeof withRaw.authRaw === 'object') {
    out.authRaw = { ...withRaw.authRaw };
  }

  if (!hasNonEmptyPlainSecret(out)) {
    return out;
  }

  const key = getOrCreateMasterKey();
  if (typeof out.accessToken === 'string' && out.accessToken.length > 0) {
    out.accessToken = encryptWithKey(out.accessToken, key);
  }
  if (typeof out.refreshToken === 'string' && out.refreshToken.length > 0) {
    out.refreshToken = encryptWithKey(out.refreshToken, key);
  }
  if (out.authRaw && typeof out.authRaw === 'object') {
    for (const k of RAW_TOKEN_KEYS) {
      const val = out.authRaw[k];
      if (typeof val === 'string' && val.length > 0) {
        out.authRaw[k] = encryptWithKey(val, key);
      }
    }
  }
  return out;
}

/**
 * 解密账号对象中的令牌字段（返回新对象，不修改原对象）
 */
export function decryptAccountSecrets<T extends { accessToken?: string; refreshToken?: string }>(acc: T): T {
  const withRaw = acc as T & { authRaw?: Record<string, any> };
  const out = { ...acc } as T & { authRaw?: Record<string, any> };
  if (withRaw.authRaw && typeof withRaw.authRaw === 'object') {
    out.authRaw = { ...withRaw.authRaw };
  }

  if (!hasEncryptedSecret(out)) {
    return out;
  }

  const key = readExistingMasterKey();
  if (typeof out.accessToken === 'string' && isEncryptedSecret(out.accessToken)) {
    out.accessToken = decryptWithKey(out.accessToken, key);
  }
  if (typeof out.refreshToken === 'string' && isEncryptedSecret(out.refreshToken)) {
    out.refreshToken = decryptWithKey(out.refreshToken, key);
  }
  if (out.authRaw && typeof out.authRaw === 'object') {
    for (const k of RAW_TOKEN_KEYS) {
      const val = out.authRaw[k];
      if (typeof val === 'string' && isEncryptedSecret(val)) {
        out.authRaw[k] = decryptWithKey(val, key);
      }
    }
  }
  return out;
}
