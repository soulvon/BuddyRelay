/**
 * 故障诊断与反馈中枢
 * 报错卡上最缺的从来不是"错了"，而是版本、环境与原始输出——统一从这里组装，
 * 侧栏 toast 与原生通知两套入口共用同一份诊断文本，避免各写一份走样。
 */
import * as os from 'os';
import * as vscode from 'vscode';
import { getCurrentVersion } from './updater';
import { t } from './i18n';

/** GitHub 对新建 issue 的 URL 有长度上限，编码后超过这个值基本打不开 */
const ISSUE_URL_SAFE_LIMIT = 6000;

const ISSUE_BASE = 'https://github.com/soulvon/BuddyRelay/issues/new';

/** 家目录替换为 ~，避免把用户名路径带进公开 issue */
function stripHome(text: string): string {
  const home = os.homedir();
  return home ? text.split(home).join('~') : text;
}

/** 组装可复制的诊断信息：版本、宿主、系统与原始错误 */
export function buildDiagnostic(title: string, detail?: string): string {
  const lines = [
    `## ${title}`,
    '',
    `- BuddyRelay: ${getCurrentVersion()}`,
    `- CodeBuddy: ${vscode.version} (${vscode.env.appName})`,
    `- 系统: ${os.type()} ${os.release()} ${os.arch()}`,
    `- Electron: ${process.versions.electron || '-'}`,
    `- Node: ${process.versions.node}`
  ];
  const body = detail && detail.trim() ? detail.trim() : '';
  if (body) {
    lines.push('', '### 详情', '```', stripHome(body), '```');
  }
  return lines.join('\n');
}

/** 预填好标题与正文的反馈链接；按编码后长度裁剪，超长链接必然打不开 */
export function buildIssueUrl(text: string): string {
  const heading = text.split('\n').find(line => line.startsWith('## ')) || '## BuddyRelay 问题反馈';
  const title = heading.replace(/^##\s*/, '').trim().slice(0, 120);
  let body = text;
  while (encodeURIComponent(body).length > ISSUE_URL_SAFE_LIMIT) {
    const keep = Math.floor(body.length * 0.6);
    body = `${body.slice(0, keep)}\n…(内容过长已截断)`;
  }
  return `${ISSUE_BASE}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/** 写剪贴板；失败时明确报错，不静默 */
export async function copyDiagnostic(text: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(text);
    return true;
  } catch (err: any) {
    vscode.window.showErrorMessage(t('err.copyFailed', err?.message || String(err)));
    return false;
  }
}

/** 打开反馈页；浏览器不可用或被拦截时明确报错 */
export async function openIssueReport(text: string): Promise<boolean> {
  try {
    const opened = await vscode.env.openExternal(vscode.Uri.parse(buildIssueUrl(text)));
    if (!opened) {
      vscode.window.showWarningMessage(t('err.reportUnavailable'));
      return false;
    }
    return true;
  } catch (err: any) {
    vscode.window.showErrorMessage(t('err.reportFailed', err?.message || String(err)));
    return false;
  }
}

/**
 * 原生错误通知 + 复制详情/反馈问题按钮。
 * 给状态栏、命令面板这类没有侧栏 toast 的入口用，保证任何路径报错都能带环境信息走。
 */
export async function showFailureWithActions(message: string, detail?: string): Promise<void> {
  const diagnostic = buildDiagnostic(message, detail);
  const copyLabel = t('err.copyDetail');
  const reportLabel = t('err.reportIssue');
  const choice = await vscode.window.showErrorMessage(message, copyLabel, reportLabel);
  if (choice === copyLabel) {
    await copyDiagnostic(diagnostic);
  } else if (choice === reportLabel) {
    await openIssueReport(diagnostic);
  }
}
