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

function getCurrentVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    );
    return packageJson.version || '0.1.0';
  } catch (_) {
    return '0.1.0';
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

    const message = `BuddyRelay 发现新版本 v${latestVersion} (当前: v${currentVersion})`;
    const actions = config.autoInstall
      ? ['立即更新', '稍后']
      : ['立即更新', '查看发布页', '稍后'];

    const choice = await vscode.window.showInformationMessage(message, ...actions);

    if (choice === '立即更新') {
      await downloadAndInstall(vsixAsset.browser_download_url, latestVersion);
    } else if (choice === '查看发布页') {
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

async function downloadAndInstall(downloadUrl: string, version: string): Promise<void> {
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

  const reload = await vscode.window.showInformationMessage(
    `BuddyRelay v${version} 更新已安装，重新加载窗口后生效`,
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
