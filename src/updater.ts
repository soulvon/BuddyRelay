import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
    return packageJson.version || "0.5.1";
  } catch (_) {
    return "0.5.1";
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
      reject(new Error('请求 GitHub API 超时'));
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
      reject(new Error('重定向次数过多'));
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
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
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
      reject(new Error('下载超时'));
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
    `# BuddyRelay v${version} 更新说明`,
    '',
    `> 官方发布页面: ${releaseUrl}`,
    '',
    '---',
    '',
    body ? body.trim() : '（本次发布未附带详细说明）',
    '',
    '---',
    '*提示：可在命令面板运行「BuddyRelay: 检查新版本更新」或在设置面板点击「检查更新」安装最新版。*'
  ].join('\n');

  try {
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (err: any) {
    vscode.window.showErrorMessage(`打开更新日志失败: ${err.message}`);
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
      title: `正在下载 BuddyRelay v${version} 安装包...`,
      cancellable: false
    },
    async () => {
      await downloadFile(downloadUrl, vsixPath);
    }
  );

  const choice = await vscode.window.showInformationMessage(
    `BuddyRelay v${version} 安装包下载完成: ${vsixPath}`,
    '打开所在文件夹'
  );

  if (choice === '打开所在文件夹') {
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
        vscode.window.showInformationMessage(`BuddyRelay 已是最新版本 (v${currentVersion})`);
      }
      return false;
    }

    const vsixAsset = release.assets?.find(a => a.name.endsWith('.vsix'));
    if (!vsixAsset) {
      if (!silent) {
        vscode.window.showWarningMessage(`发现新版本 v${latestVersion}，但未找到 .vsix 安装包`);
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
    const changelogBlock = summary ? `\n\n更新内容：\n${summary}` : '';
    const message = `BuddyRelay 发现新版本 v${latestVersion} (当前: v${currentVersion})${changelogBlock}`;

    const actions = config.autoInstall
      ? ['立即更新', '稍后']
      : ['立即更新', '查看完整日志', '仅下载安装包', '打开发布页', '稍后'];

    const choice = await vscode.window.showInformationMessage(message, ...actions);

    if (choice === '立即更新') {
      await downloadAndInstall(vsixAsset.browser_download_url, latestVersion);
    } else if (choice === '仅下载安装包') {
      await downloadOnly(vsixAsset.browser_download_url, latestVersion);
    } else if (choice === '查看完整日志') {
      await showFullChangelog(latestVersion, release.body, release.html_url);
      // 日志打开后提示是否进一步更新
      const nextChoice = await vscode.window.showInformationMessage(
        `已打开 v${latestVersion} 完整更新说明，是否现在更新？`,
        '立即更新',
        '仅下载安装包',
        '稍后'
      );
      if (nextChoice === '立即更新') {
        await downloadAndInstall(vsixAsset.browser_download_url, latestVersion);
      } else if (nextChoice === '仅下载安装包') {
        await downloadOnly(vsixAsset.browser_download_url, latestVersion);
      }
    } else if (choice === '打开发布页') {
      vscode.env.openExternal(vscode.Uri.parse(release.html_url));
    }

    return true;
  } catch (err: any) {
    if (!silent) {
      vscode.window.showErrorMessage(`检查更新失败: ${err.message}`);
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
      title: `正在下载 BuddyRelay v${version}...`,
      cancellable: false
    },
    async () => {
      await downloadFile(downloadUrl, vsixPath);
    }
  );

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在安装更新...',
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
    ? `BuddyRelay 已自动更新至 v${version}，重新加载窗口后生效`
    : `BuddyRelay v${version} 更新已安装，重新加载窗口后生效`;

  const reload = await vscode.window.showInformationMessage(
    promptMsg,
    '立即重载',
    '稍后'
  );

  if (reload === '立即重载') {
    vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  try {
    fs.unlinkSync(vsixPath);
  } catch (_) {}
}
