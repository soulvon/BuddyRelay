import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { t } from './i18n';

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
    autoInstall: config.get('autoInstall', false)
  };
}

export function getCurrentVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return packageJson.version || "1.0.1";
  } catch (_) {
    return "1.0.1";
  }
}

function fetchGitHubApi(url: string, token: string = ''): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {
      'User-Agent': 'BuddyRelay-Updater',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const req = protocol.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`GitHub API HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e: any) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error(t('upd.githubTimeout')));
    });
  });
}

function downloadFile(
  url: string,
  destPath: string,
  token: string = '',
  maxRedirects: number = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error(t('upd.tooManyRedirects')));
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {
      'User-Agent': 'BuddyRelay-Updater'
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const req = protocol.get(url, { headers }, res => {
      if (
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        downloadFile(res.headers.location, destPath, token, maxRedirects - 1).then(
          resolve,
          reject
        );
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(t('upd.downloadFailed', res.statusCode ?? 0)));
        return;
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', err => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error(t('upd.downloadTimeout')));
    });
  });
}

function compareVersions(a: string, b: string): number {
  const splitVer = (v: string) => {
    const dashIdx = v.indexOf('-');
    return {
      core: dashIdx >= 0 ? v.slice(0, dashIdx) : v,
      pre: dashIdx >= 0 ? v.slice(dashIdx + 1) : ''
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
  return preA < preB ? -1 : preA > preB ? 1 : 0;
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
    // 过滤噪音行（如 Full Changelog 链接与空分隔线）
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
 * 仅下载安装包到临时文件夹（方便留底或分发，Kite 同款）
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

/**
 * 检查更新核心方法
 * @param silent 是否静默检查（启动时静默，手动点击时弹窗）
 */
export async function checkForUpdates(silent: boolean = false): Promise<boolean> {
  const config = getUpdateConfig();
  const currentVersion = getCurrentVersion();

  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
    const release: GitHubRelease = await fetchGitHubApi(url);

    const latestVersion = release.tag_name.startsWith('v')
      ? release.tag_name.slice(1)
      : release.tag_name;

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (!silent) {
        vscode.window.showInformationMessage(t('upd.upToDate', currentVersion));
      }
      return false;
    }

    const vsixAsset = release.assets?.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
      if (!silent) {
        vscode.window.showWarningMessage(t('upd.noVsix', latestVersion));
      }
      return false;
    }

    // 若开启了免确认静默安装且处于后台检查场景，直接静默更新
    if (config.autoInstall && silent) {
      await downloadAndInstall(vsixAsset.browser_download_url, latestVersion, true);
      return true;
    }

    // 格式化更新日志摘要，直观告诉用户更新了什么
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
      await downloadAndInstall(vsixAsset.browser_download_url, latestVersion);
    } else if (choice === downloadLabel) {
      await downloadOnly(vsixAsset.browser_download_url, latestVersion);
    } else if (choice === viewLogLabel) {
      await showFullChangelog(latestVersion, release.body, release.html_url);
      // 日志打开后提示是否进一步更新
      const nextChoice = await vscode.window.showInformationMessage(
        t('upd.fullLogOpened', latestVersion),
        installLabel,
        downloadLabel,
        laterLabel
      );
      if (nextChoice === installLabel) {
        await downloadAndInstall(vsixAsset.browser_download_url, latestVersion);
      } else if (nextChoice === downloadLabel) {
        await downloadOnly(vsixAsset.browser_download_url, latestVersion);
      }
    } else if (choice === openReleaseLabel) {
      vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    }

    return true;
  } catch (err: any) {
    if (!silent) {
      vscode.window.showErrorMessage(t('upd.checkFailed', err.message));
    }
    return false;
  }
}

async function downloadAndInstall(
  downloadUrl: string,
  version: string,
  isSilentAuto: boolean = false
): Promise<void> {
  const tempDir = os.tmpdir();
  const vsixPath = path.join(tempDir, `buddy-relay-${version}.vsix`);

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

  try {
    fs.unlinkSync(vsixPath);
  } catch (_) {}
}
