/**
 * 账号域名判定 (纯函数, 零依赖, 可被测试脚本直接 require)
 * 国内域名 (codebuddy.cn / copilot.tencent.com / 缺省) 可参与签到与成长任务,
 * 国际域名 (codebuddy.ai) 的对应活动不存在。
 */
export function isCnAccount(domain?: string): boolean {
  if (!domain) {
    return true;
  }
  return !domain.includes('codebuddy.ai');
}
