import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PATHS } from './constants';
import { CodeBuddyAccount, AccountStore } from './accountStore';
import { t } from './i18n';

export interface CockpitEnvelope {
  version: number;
  kind: string;
  algorithm: string;
  key_id: string;
  nonce: string;
  ciphertext: string;
  encrypted_at?: number;
}

export interface CockpitImportResult {
  success: boolean;
  totalFound: number;
  decryptedCount: number;
  importedAccounts: CodeBuddyAccount[];
  errors: Array<{ file: string; error: string }>;
}

export interface CockpitVerificationResult {
  hasKey: boolean;
  hasAccountsDir: boolean;
  accountFilesCount: number;
  verified: boolean;
  message: string;
}

/**
 * Cockpit Tools 账号池读取与解密导入引擎
 * 支持从 %USERPROFILE%\.antigravity_cockpit 读取密钥与密文，执行 AES-256-GCM 解密与字段归一化
 */
export class CockpitImporter {
  private keyFilePath: string;
  private accountsDirPath: string;
  private indexFilePath: string;

  constructor(options?: {
    keyFilePath?: string;
    accountsDirPath?: string;
    indexFilePath?: string;
  }) {
    this.keyFilePath = options?.keyFilePath || PATHS.COCKPIT_KEY_FILE;
    this.accountsDirPath = options?.accountsDirPath || PATHS.COCKPIT_ACCOUNTS_DIR;
    this.indexFilePath = options?.indexFilePath || PATHS.COCKPIT_INDEX_FILE;
  }

  /**
   * 读取并解析 AES-256-GCM 32 字节主密钥
   */
  public readMasterKey(): Buffer {
    if (!fs.existsSync(this.keyFilePath)) {
      throw new Error(t('err.ckKeyMissing', this.keyFilePath));
    }

    const keyRaw = fs.readFileSync(this.keyFilePath, 'utf8').trim();
    const keyBuf = Buffer.from(keyRaw, 'base64');
    if (keyBuf.length !== 32) {
      throw new Error(t('err.ckKeyLength', keyBuf.length));
    }
    return keyBuf;
  }

  /**
   * 校验本地 Cockpit Tools 存储环境
   */
  public verifyCockpitStorage(): CockpitVerificationResult {
    const hasKey = fs.existsSync(this.keyFilePath);
    const hasAccountsDir = fs.existsSync(this.accountsDirPath);
    let accountFilesCount = 0;

    if (hasAccountsDir) {
      try {
        const files = fs.readdirSync(this.accountsDirPath);
        accountFilesCount = files.filter(f => f.endsWith('.json') && !f.endsWith('.bak')).length;
      } catch (err) {
        // 读取失败
      }
    }

    let verified = false;
    let message = '';

    if (!hasKey) {
      message = t('ck.verifyNoKey', this.keyFilePath);
    } else if (!hasAccountsDir || accountFilesCount === 0) {
      message = t('ck.verifyNoAccounts', this.accountsDirPath);
    } else {
      try {
        const key = this.readMasterKey();
        const files = fs.readdirSync(this.accountsDirPath).filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
        if (files.length > 0) {
          // 探针测试第一份文件解密
          this.decryptFile(path.join(this.accountsDirPath, files[0]), key);
          verified = true;
          message = t('ck.verifyOk', files.length);
        }
      } catch (err: any) {
        message = t('ck.verifyFailed', err.message);
      }
    }

    return {
      hasKey,
      hasAccountsDir,
      accountFilesCount,
      verified,
      message
    };
  }

  /**
   * 解密单个密文 Envelope 并反序列化为 CodeBuddyAccount
   */
  public decryptEnvelope(envelope: CockpitEnvelope, masterKey: Buffer): CodeBuddyAccount {
    if (envelope.algorithm !== 'AES-256-GCM') {
      throw new Error(t('err.ckAlgoUnsupported', envelope.algorithm));
    }

    const nonce = Buffer.from(envelope.nonce, 'base64');
    const rawCipher = Buffer.from(envelope.ciphertext, 'base64');

    if (rawCipher.length < 16) {
      throw new Error(t('err.ckCipherShort'));
    }

    // 后 16 字节为 GCM AuthTag，前面为实际密文
    const tag = rawCipher.subarray(rawCipher.length - 16);
    const ciphertext = rawCipher.subarray(0, rawCipher.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    const raw = JSON.parse(decrypted);
    return this.transformToAccountModel(raw);
  }

  /**
   * 解密指定 JSON 文件
   */
  public decryptFile(filePath: string, masterKey?: Buffer): CodeBuddyAccount {
    const key = masterKey || this.readMasterKey();
    const content = fs.readFileSync(filePath, 'utf8');
    const envelope: CockpitEnvelope = JSON.parse(content);
    return this.decryptEnvelope(envelope, key);
  }

  /**
   * 将 Cockpit 内部解密出的原生数据对象转换为 BuddyRelay 统一账号模型
   */
  private transformToAccountModel(raw: any): CodeBuddyAccount {
    const uid = raw.uid || raw.profile_raw?.uid || raw.id || '';
    const email = raw.email || raw.nickname || raw.profile_raw?.nickname || uid;
    const nickname = raw.nickname || raw.profile_raw?.nickname || email;
    const accessToken = raw.access_token || raw.auth_raw?.accessToken || '';
    const refreshToken = raw.refresh_token || raw.auth_raw?.refreshToken || '';
    const tokenType = raw.token_type || raw.auth_raw?.tokenType || 'Bearer';

    let expiresAt = raw.expires_at || 0;
    if (expiresAt > 0 && expiresAt < 10000000000) {
      expiresAt *= 1000;
    }
    if (!expiresAt) {
      // 默认续期 30 天
      expiresAt = Date.now() + 30 * 24 * 3600 * 1000;
    }

    let createdAt = raw.created_at || Date.now();
    if (createdAt > 0 && createdAt < 10000000000) {
      createdAt *= 1000;
    }

    let lastUsed = raw.last_used || Date.now();
    if (lastUsed > 0 && lastUsed < 10000000000) {
      lastUsed *= 1000;
    }

    return {
      id: raw.id || `codebuddy_cn_${uid.replace(/-/g, '')}`,
      uid,
      email,
      nickname,
      accessToken,
      refreshToken,
      tokenType,
      expiresAt,
      domain: raw.domain || raw.auth_raw?.domain || 'www.codebuddy.cn',
      paymentType: raw.payment_type || 'free',
      quotaRaw: raw.quota_raw,
      authRaw: raw.auth_raw,
      profileRaw: raw.profile_raw,
      usageRaw: raw.usage_raw,
      status: raw.status === 'normal' ? 'idle' : (raw.status || 'idle'),
      checkinStreak: typeof raw.checkin_streak === 'number' ? raw.checkin_streak : 0,
      todayCheckedIn: Boolean(raw.today_checked_in),
      createdAt,
      lastUsed
    };
  }

  /**
   * 一键从 Cockpit Tools 导入全量账号到 AccountStore
   */
  public async importToStore(store?: AccountStore): Promise<CockpitImportResult> {
    const result: CockpitImportResult = {
      success: false,
      totalFound: 0,
      decryptedCount: 0,
      importedAccounts: [],
      errors: []
    };

    if (!fs.existsSync(this.accountsDirPath)) {
      result.errors.push({
        file: this.accountsDirPath,
        error: t('ck.dirMissing')
      });
      return result;
    }

    let masterKey: Buffer;
    try {
      masterKey = this.readMasterKey();
    } catch (err: any) {
      result.errors.push({
        file: this.keyFilePath,
        error: t('ck.keyReadFailed', err.message)
      });
      return result;
    }

    const files = fs.readdirSync(this.accountsDirPath)
      .filter(f => f.endsWith('.json') && !f.endsWith('.bak'));

    result.totalFound = files.length;

    for (const filename of files) {
      const fullPath = path.join(this.accountsDirPath, filename);
      try {
        const account = this.decryptFile(fullPath, masterKey);
        result.importedAccounts.push(account);
        result.decryptedCount++;
      } catch (err: any) {
        result.errors.push({
          file: filename,
          error: err.message
        });
      }
    }

    if (store && result.importedAccounts.length > 0) {
      await store.upsertBatch(result.importedAccounts);
    }

    result.success = result.decryptedCount > 0;
    return result;
  }
}
