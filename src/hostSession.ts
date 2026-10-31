import * as fs from 'fs';
import { PATHS } from './constants';

/**
 * 宿主登录态读取
 * CodeBuddy CN 宿主把当前登录账号 UID 存在 globalStorage/storage.json 的 genie.userId（明文）。
 * 宿主 accessToken 存于 secret://（宿主进程系统级加密），扩展进程无法直接解密，
 * 因此"本地导入"的完整令牌需借助本机 Cockpit Tools 账号池密文（codebuddy_cn_<uid>.json）。
 */

/**
 * 读取本机 CodeBuddy 宿主当前登录的账号 UID（UUID 带横线格式）
 * - 未安装 / 未登录 / 未落盘：返回空串
 * - 文件存在但解析失败：直接抛错（数据损坏必须暴露，不做静默兜底）
 */
export function readHostLoginUid(): string {
  if (!fs.existsSync(PATHS.CODEBUDDY_STORAGE_JSON)) {
    return '';
  }
  const raw = fs.readFileSync(PATHS.CODEBUDDY_STORAGE_JSON, 'utf8');
  const data = JSON.parse(raw);
  return String(data['genie.userId'] || '');
}
