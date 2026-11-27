import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from './i18n';
import { httpJsonRequest, httpRequestRaw, downloadToFile } from './httpClient';

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

const REPO_OWNER = 'soulvon';
const REPO_NAME = 'BuddyRelay';

interface UpdateConfig {
  autoCheck: boolean;
  autoInstall: boolean;
}

function getUpdateConfig(): UpdateConfig {
  const config = vscode.workspace.getConfiguration('buddyRelay.update');
  return {
    autoCheck: config.get('autoCheck', true),
    autoInstall: config.get('autoInstall', true)
  };
}

export function getCurrentVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return packageJson.version || '1.1.0';
  } catch (_) {
    return '1.1.0';
  }
}

async function fetchGitHubApi(url: string, token: string = ''): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': 'BuddyRelay-Updater',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  return httpJsonRequest<any>(url, { method: 'GET', headers, timeout: 12000 });
}

async function downloadFile(
  url: string,
  destPath: string,
  token: string = '',
  maxRedirects: number = 5
): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': 'BuddyRelay-Updater'
  };
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }
  await downloadToFile(url, destPath, {
    headers,
    timeout: 60000,
    maxRedirects
  });
}

/**
 * SemVer 版本比较（支持预发布标签：1.4.0 > 1.4.0-beta.10 > 1.4.0-beta.2）
 */
export function compareVersions(a: string, b: string): number {
  const splitVer = (v: string) => {
    const clean = String(v || '').trim().replace(/^v/i, '').split('+')[0];
    const dashIdx = clean.indexOf('-');
    return {
      core: dashIdx >= 0 ? clean.slice(0, dashIdx) : clean,
      pre: dashIdx >= 0 ? clean.slice(dashIdx + 1) : ''
    };
  };
  const { core: coreA, pre: preA } = splitVer(a);
  const { core: coreB, pre: preB } = splitVer(b);

  const pa = coreA.split('.').map(s => parseInt(s, 10) || 0);
  const pb = coreB.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }

  if (preA === '' && preB === '') return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;

  const segsA = preA.split('.');
  const segsB = preB.split('.');
  const isDigits = (s: string) => /^\d+$/.test(s);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    if (i >= segsA.length) return -1;
    if (i >= segsB.length) return 1;
    const sa = segsA[i];
    const sb = segsB[i];
    const numA = isDigits(sa);
    const numB = isDigits(sb);
    if (numA && numB) {
      const diff = Number(sa) - Number(sb);
      if (diff !== 0) return diff;
    } else if (numA !== numB) {
      return numA ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 格式化更新日志摘要，提取核心变更条目，过滤链接与噪音
 */
export function formatChangelogSummary(rawBody: string, maxItems: number = 5): string {
  if (!rawBody || typeof rawBody !== 'string') return '';
  const lines = rawBody
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.toLowerCase().includes('full changelog') && !l.startsWith('**Full Changelog**'));

  const items: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ') || line.startsWith('* ') || /^\d+\.\s/.test(line)) {
      items.push(line);
    } else if (line.startsWith('#')) {
      const title = line.replace(/^#+\s*/, '').trim();
      if (title && !title.toLowerCase().includes('changelog')) {
        items.push(`【${title}】`);
      }
    } else if (items.length < maxItems && line.length >= 4 && !line.startsWith('http')) {
      items.push(`- ${line}`);
    }
    if (items.length >= maxItems) break;
  }

  return items.slice(0, maxItems).join('\n');
}

/**
 * 在 VS Code 内部以 Markdown 预览文档打开完整更新说明
 */
export async function showFullChangelog(version: string, body: string, releaseUrl: string): Promise<void> {
  const content = [
    t('upd.changelogTitle', version),
    '',
    t('upd.changelogOfficial', releaseUrl),
    '',
    '---',
    '',
    body ? body.trim() : t('upd.noReleaseNotes'),
    '',
    '---',
    t('upd.changelogTip')
  ].join('\n');

  try {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err: any) {
    vscode.window.showErrorMessage(t('upd.openChangelogFailed', err.message));
  }
}

/**
 * 仅下载安装包到临时文件夹
 */
export async function downloadOnly(downloadUrl: string, version: string): Promise<void> {
  const tempDir = os.tmpdir();
  const vsixPath = path.join(tempDir, `buddy-relay-${version}.vsix`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('upd.downloading', version),
      cancellable: false
    },
    async () => {
      await downloadFile(downloadUrl, vsixPath);
    }
  );

  const openFolderLabel = t('upd.openFolder');
  const choice = await vscode.window.showInformationMessage(
    t('upd.downloaded', version, vsixPath),
    openFolderLabel
  );

  if (choice === openFolderLabel) {
    vscode.env.openExternal(vscode.Uri.file(tempDir));
  }
}

interface UnifiedReleaseInfo {
  version: string;
  downloadUrl: string;
  releaseUrl: string;
  body: string;
  source: 'github-api' | 'open-vsx' | 'github-web';
}

async function fetchOpenVsx(): Promise<UnifiedReleaseInfo> {
  const url = 'https://open-vsx.org/api/soulvon/buddy-relay';
  const json = await httpJsonRequest<any>(url, {
    method: 'GET',
    headers: { 'User-Agent': 'BuddyRelay-Updater' },
    timeout: 12000
  });
  const ver = String(json?.version || '').trim();
  const dl = json?.downloads?.universal || json?.files?.download || '';
  if (!ver || !dl) {
    throw new Error('Open VSX missing version or download url');
  }
  return {
    version: ver,
    downloadUrl: dl,
    releaseUrl: 'https://open-vsx.org/extension/soulvon/buddy-relay',
    body: json.description || '',
    source: 'open-vsx'
  };
}

async function fetchGitHubWebRedirect(): Promise<UnifiedReleaseInfo> {
  const latestUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
  const res = await httpRequestRaw(latestUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'BuddyRelay-Updater',
      'Accept': 'text/html,application/xhtml+xml'
    },
    timeout: 12000
  });
  if (res.statusCode < 200 || res.statusCode >= 400) {
    throw new Error(`GitHub Web HTTP ${res.statusCode}`);
  }
  const loc = String(res.headers.location || '');
  const fromLoc = loc.match(/\/releases\/tag\/v?([^\/?#]+)/);
  const fromBody =
    res.body.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/releases\/tag\/v?([^"\/?#]+)"/i) ||
    res.body.match(new RegExp(`/${REPO_OWNER}/${REPO_NAME}/releases/tag/v?([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)`));
  const ver = String(fromLoc?.[1] || fromBody?.[1] || '').trim();
  if (!ver) {
    throw new Error('GitHub Web release tag not found');
  }
  return {
    version: ver,
    downloadUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${ver}/buddy-relay-${ver}.vsix`,
    releaseUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${ver}`,
    body: '',
    source: 'github-web'
  };
}

async function getLatestReleaseWithFallback(): Promise<UnifiedReleaseInfo> {
  const channelErrors: string[] = [];
  const briefErr = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace(/\{[\s\S]*\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'unknown error';
  };

  // 1. 首选通道: Open VSX 官方市场（无 60 次/小时限频）
  try {
    return await fetchOpenVsx();
  } catch (err) {
    channelErrors.push(`OpenVSX: ${briefErr(err)}`);
  }

  // 2. 备用通道: GitHub Web Releases 网页路由（不计入 REST API 配额）
  try {
    return await fetchGitHubWebRedirect();
  } catch (err) {
    channelErrors.push(`GitHub Web: ${briefErr(err)}`);
  }

  // 3. 末级兜底: GitHub REST API
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    const release: GitHubRelease = await fetchGitHubApi(url);
    const latestVersion = release.tag_name.startsWith('v')
      ? release.tag_name.slice(1)
      : release.tag_name;
    const vsixAsset = release.assets?.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
      throw new Error(`no vsix asset in GitHub release ${latestVersion}`);
    }
    return {
      version: latestVersion,
      downloadUrl: vsixAsset.browser_download_url,
      releaseUrl: release.html_url,
      body: release.body || '',
      source: 'github-api'
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    channelErrors.push(`GitHub API: ${/rate limit/i.test(msg) ? 'rate limited' : briefErr(err)}`);
    throw new Error(channelErrors.join(' | '));
  }
}

async function enrichChangelog(info: UnifiedReleaseInfo): Promise<UnifiedReleaseInfo> {
  if (info.body || info.source === 'github-api') {
    return info;
  }
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${info.version}`;
    const release: GitHubRelease = await fetchGitHubApi(url);
    if (release.body) {
      info.body = release.body;
    }
  } catch {
    // 限频或超时直接放弃
  }
  return info;
}

function sanitizeErrMessage(msg: string): string {
  const raw = String(msg || '').trim();
  if (!raw) return 'Unknown network error';
  if (raw.includes('OpenVSX:') && raw.includes('GitHub Web:')) {
    return raw.slice(0, 240);
  }
  if (/rate limit/i.test(raw)) {
    return 'GitHub rate limited (fallback channels all failed)';
  }
  return raw.replace(/\{[\s\S]*\}/g, '').trim() || raw.slice(0, 120);
}

let isCheckingUpdate = false;
let isInstallingUpdate = false;

/**
 * 检查更新核心方法
 * @param silent 是否静默检查（启动时静默，手动点击时弹窗）
 */
export async function checkForUpdates(silent: boolean = false): Promise<boolean> {
  if (isCheckingUpdate) {
    return false;
  }
  isCheckingUpdate = true;

  const config = getUpdateConfig();
  const currentVersion = getCurrentVersion();

  try {
    let release = await getLatestReleaseWithFallback();
    const latestVersion = release.version;

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (!silent) {
        vscode.window.showInformationMessage(t('upd.upToDate', currentVersion));
      }
      return false;
    }

    if (!release.downloadUrl) {
      if (!silent) {
        vscode.window.showWarningMessage(t('upd.noVsix', latestVersion));
      }
      return false;
    }

    release = await enrichChangelog(release);

    if (config.autoInstall && silent) {
      await downloadAndInstall(release.downloadUrl, latestVersion, true);
      return true;
    }

    const summary = formatChangelogSummary(release.body);
    const changelogBlock = summary ? '\n\n' + t('upd.whatsNew', summary) : '';
    const message = t('upd.newVersionFound', latestVersion, currentVersion) + changelogBlock;

    const installLabel = t('upd.installNow');
    const laterLabel = t('common.later');
    const viewLogLabel = t('upd.viewFullLog');
    const downloadLabel = t('upd.downloadOnly');
    const openReleaseLabel = t('upd.openRelease');

    const actions = config.autoInstall
      ? [installLabel, laterLabel]
      : [installLabel, viewLogLabel, downloadLabel, openReleaseLabel, laterLabel];

    const choice = await vscode.window.showInformationMessage(message, ...actions);

    if (choice === installLabel) {
      await downloadAndInstall(release.downloadUrl, latestVersion);
    } else if (choice === downloadLabel) {
      await downloadOnly(release.downloadUrl, latestVersion);
    } else if (choice === viewLogLabel) {
      await showFullChangelog(latestVersion, release.body, release.releaseUrl);
      const nextChoice = await vscode.window.showInformationMessage(
        t('upd.fullLogOpened', latestVersion),
        installLabel,
        downloadLabel,
        laterLabel
      );
      if (nextChoice === installLabel) {
        await downloadAndInstall(release.downloadUrl, latestVersion);
      } else if (nextChoice === downloadLabel) {
        await downloadOnly(release.downloadUrl, latestVersion);
      }
    } else if (choice === openReleaseLabel) {
      vscode.env.openExternal(vscode.Uri.parse(release.releaseUrl));
    }

    return true;
  } catch (err: any) {
    if (!silent) {
      vscode.window.showErrorMessage(t('upd.checkFailed', sanitizeErrMessage(err.message)));
    }
    return false;
  } finally {
    isCheckingUpdate = false;
  }
}

async function downloadAndInstall(
  downloadUrl: string,
  version: string,
  isSilentAuto: boolean = false
): Promise<void> {
  if (isInstallingUpdate) {
    return;
  }
  isInstallingUpdate = true;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-relay-upd-'));
  const vsixPath = path.join(tempRoot, `buddy-relay-${version}.vsix`);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('upd.downloadingSilent', version),
        cancellable: false
      },
      async () => {
        await downloadFile(downloadUrl, vsixPath);
      }
    );

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('upd.installing'),
        cancellable: false
      },
      async () => {
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          vscode.Uri.file(vsixPath)
        );
      }
    );

    const promptMsg = isSilentAuto
      ? t('upd.autoInstalled', version)
      : t('upd.installed', version);

    const reloadLabel = t('upd.reloadNow');
    const reload = await vscode.window.showInformationMessage(
      promptMsg,
      reloadLabel,
      t('common.later')
    );

    if (reload === reloadLabel) {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } finally {
    isInstallingUpdate = false;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}
