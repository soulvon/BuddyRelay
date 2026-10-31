import * as vscode from 'vscode';

export type HostEdition = 'cn' | 'intl';

/**
 * 宿主版本探测: "CodeBuddy CN" 与 WorkBuddy 为国内版, "CodeBuddy"(国际) 为国际版。
 * 无法判定时按国内处理 —— 功能降级只发生在"确认国际"分支, 不误伤主场景。
 */
export function detectHostEdition(): HostEdition {
  const name = (vscode.env.appName || '').toLowerCase();
  if (!name) {
    return 'cn';
  }
  if (name.includes('workbuddy')) {
    return 'cn';
  }
  if (name.includes('codebuddy')) {
    return name.includes('cn') ? 'cn' : 'intl';
  }
  return 'cn';
}

export { isCnAccount } from './domain';
