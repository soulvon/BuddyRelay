/**
 * BuddyRelay 国际化中枢
 * - 双语字典: zh.ts / en.ts, 扁平 key, {0}{1} 占位符插值
 * - 语言来源: buddyRelay.locale 配置 (auto / zh / en); auto 时跟随 vscode.env.language
 * - vscode 采用惰性获取: accountStore/usageTracker 等模块会被纯 Node 测试脚本 require,
 *   顶层 import 'vscode' 会直接炸掉测试链路
 */

import { zh } from './zh';
import { en } from './en';

export type Lang = 'zh' | 'en';

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

let currentLang: Lang = 'zh';
const listeners: Array<() => void> = [];

type VscodeLike = typeof import('vscode');
let cachedVscode: VscodeLike | null | undefined;

/** 纯 Node 环境 (测试脚本) 无 vscode 模块, 返回 undefined 走默认语言 */
function getVscode(): VscodeLike | undefined {
  if (cachedVscode !== undefined) {
    return cachedVscode || undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedVscode = require('vscode') as VscodeLike;
  } catch (_) {
    cachedVscode = null;
  }
  return cachedVscode || undefined;
}

function resolveConfiguredLang(): Lang {
  const vscode = getVscode();
  if (!vscode) {
    return 'zh';
  }
  const pref = vscode.workspace.getConfiguration('buddyRelay').get<string>('locale', 'auto');
  if (pref === 'zh' || pref === 'en') {
    return pref;
  }
  const vscLang = (vscode.env.language || 'en').toLowerCase();
  return vscLang.startsWith('zh') ? 'zh' : 'en';
}

/** 激活时初始化语言; 缺 key 时回退 zh, 再缺回退 key 本身 (暴露问题不静默) */
export function initI18n(): void {
  currentLang = resolveConfiguredLang();
}

export function getLang(): Lang {
  return currentLang;
}

/** 翻译: t('key') / t('key', arg0, arg1) → 字典值内 {0}{1} 依次替换 */
export function t(key: string, ...args: Array<string | number>): string {
  let s = DICTS[currentLang][key];
  if (s === undefined) {
    console.warn(`[BuddyRelay][i18n] missing key: ${key}`);
    s = DICTS.zh[key] !== undefined ? DICTS.zh[key] : key;
  }
  for (let i = 0; i < args.length; i++) {
    s = s.split(`{${i}}`).join(String(args[i]));
  }
  return s;
}

export function onLangChange(fn: () => void): void {
  listeners.push(fn);
}

/** 配置监听: buddyRelay.locale 变更且语言实际切换时广播 (状态栏/侧栏各处自行刷新) */
export function watchLocaleConfig(): { dispose(): void } {
  const vscode = getVscode();
  if (!vscode) {
    return { dispose: () => {} };
  }
  const d = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('buddyRelay.locale')) {
      const prev = currentLang;
      currentLang = resolveConfiguredLang();
      if (prev !== currentLang) {
        for (const fn of listeners) {
          try { fn(); } catch (err) {
            console.warn('[BuddyRelay][i18n] lang change listener failed:', err);
          }
        }
      }
    }
  });
  return { dispose: () => d.dispose() };
}

/** 供 webview 注入用的当前语言字典 */
export function getLangDict(): Record<string, string> {
  return DICTS[currentLang];
}
