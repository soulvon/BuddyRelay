import * as path from 'path';
import * as os from 'os';

/**
 * BuddyRelay 核心常量定义
 * 包含官方接口地址、Patch v4 锚点特征串、本地数据与指令文件路径
 */

// ============================================================================
// 1. 接口地址与网络端点
// ============================================================================

export const API_ENDPOINTS = {
  // 基础服务器地址
  CODEBUDDY_CN_BASE: 'https://www.codebuddy.cn',
  CODEBUDDY_AI_BASE: 'https://www.codebuddy.ai',
  COPILOT_TENCENT_BASE: 'https://copilot.tencent.com',

  // OAuth 认证链路 (对齐 official ide-native-auth)
  OAUTH_STATE: '/v2/plugin/auth/state',
  OAUTH_TOKEN: '/v2/plugin/auth/token',
  OAUTH_REFRESH: '/v2/plugin/auth/token/refresh',
  OAUTH_ACCOUNT: '/v2/plugin/login/account',

  // 签到与活动链路 (对齐 Cockpit Tools / Buddy加油站)
  CHECKIN_ACTIVITY_STATUS: '/v2/billing/meter/checkin-activity-status',
  CHECKIN_STATUS_LEGACY: '/v2/billing/meter/checkin-status',
  DAILY_CHECKIN: '/v2/billing/meter/daily-checkin',

  // 计量与用量信息
  PAYMENT_TYPE: '/v2/billing/meter/get-payment-type',
  USER_RESOURCE: '/v2/billing/meter/get-user-resource',
  USAGE_STATUS: '/v2/billing/meter/usage-status'
} as const;

// 默认请求头
export const DEFAULT_HEADERS = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  NO_AUTH_HEADERS: {
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true'
  }
} as const;

// ============================================================================
// 2. 本地数据与物理指令文件路径
// ============================================================================

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const USER_PROFILE = process.env.USERPROFILE || process.env.HOME || os.homedir();

function resolveAppDataDir(): string {
  if (isWin) {
    return process.env.APPDATA || path.join(USER_PROFILE, 'AppData', 'Roaming');
  }
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function resolveLocalAppDataDir(): string {
  if (isWin) {
    return process.env.LOCALAPPDATA || path.join(USER_PROFILE, 'AppData', 'Local');
  }
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function resolveCandidateMainJsPaths(): string[] {
  const localApp = resolveLocalAppDataDir();
  const list: string[] = [];
  if (isWin) {
    list.push(
      'E:\\Program\\CodeBuddy CN\\resources\\app\\out\\main.js',
      path.join(localApp, 'Programs', 'CodeBuddy CN', 'resources', 'app', 'out', 'main.js'),
      'C:\\Program Files\\CodeBuddy CN\\resources\\app\\out\\main.js',
      'D:\\Program Files\\CodeBuddy CN\\resources\\app\\out\\main.js',
      'D:\\Program\\CodeBuddy CN\\resources\\app\\out\\main.js',
      // 国际版 CodeBuddy (codebuddy.ai) 安装目录不含 CN 后缀
      path.join(localApp, 'Programs', 'CodeBuddy', 'resources', 'app', 'out', 'main.js'),
      'C:\\Program Files\\CodeBuddy\\resources\\app\\out\\main.js',
      'D:\\Program Files\\CodeBuddy\\resources\\app\\out\\main.js'
    );
  } else if (isMac) {
    list.push(
      '/Applications/CodeBuddy CN.app/Contents/Resources/app/out/main.js',
      '/Applications/CodeBuddy.app/Contents/Resources/app/out/main.js',
      '/Applications/WorkBuddy.app/Contents/Resources/app/out/main.js',
      path.join(os.homedir(), 'Applications', 'CodeBuddy CN.app', 'Contents', 'Resources', 'app', 'out', 'main.js')
    );
  } else {
    list.push(
      '/usr/share/codebuddy-cn/resources/app/out/main.js',
      '/opt/codebuddy-cn/resources/app/out/main.js',
      '/usr/share/workbuddy/resources/app/out/main.js',
      '/opt/workbuddy/resources/app/out/main.js',
      // 国际版 CodeBuddy
      '/usr/share/codebuddy/resources/app/out/main.js',
      '/opt/codebuddy/resources/app/out/main.js'
    );
  }
  return list;
}

const APPDATA = resolveAppDataDir();
const LOCALAPPDATA = resolveLocalAppDataDir();

export const PATHS = {
  // Cockpit Tools 凭据存储规范
  COCKPIT_DIR: path.join(USER_PROFILE, '.antigravity_cockpit'),
  COCKPIT_KEY_FILE: path.join(USER_PROFILE, '.antigravity_cockpit', 'secure-account-storage.key'),
  COCKPIT_ACCOUNTS_DIR: path.join(USER_PROFILE, '.antigravity_cockpit', 'codebuddy_cn_accounts'),
  COCKPIT_INDEX_FILE: path.join(USER_PROFILE, '.antigravity_cockpit', 'codebuddy_cn_accounts.json'),

  // CodeBuddy CN 宿主指令与配置
  CODEBUDDY_APPDATA_DIR: path.join(APPDATA, 'CodeBuddy CN'),
  BYOK_SWITCH_FILE: path.join(APPDATA, 'CodeBuddy CN', 'byok-switch.json'),
  BYOK_SWITCH_RESULT_FILE: path.join(APPDATA, 'CodeBuddy CN', 'byok-switch-result.json'),
  CODEBUDDY_SESSIONS_DB: path.join(APPDATA, 'CodeBuddy CN', 'codebuddy-sessions.vscdb'),
  CODEBUDDY_STORAGE_JSON: path.join(APPDATA, 'CodeBuddy CN', 'User', 'globalStorage', 'storage.json'),

  // BuddyRelay 跨窗口共享中枢 (号池 / 账号锁，与宿主指令同区天然多窗口共享)
  RELAY_DIR: path.join(APPDATA, 'CodeBuddy CN', 'buddy-relay'),
  POOL_FILE: path.join(APPDATA, 'CodeBuddy CN', 'buddy-relay', 'pool.json'),
  LOCK_FILE: path.join(APPDATA, 'CodeBuddy CN', 'buddy-relay', 'account-locks.json'),

  // 会话物理存储与软链接联结点 (跨账号会话穿透)
  EXTENSION_DATA_DIR: path.join(LOCALAPPDATA, 'CodeBuddyExtension', 'Data'),
  MASTER_SESSION_UID: '69719899-bf05-4822-9e20-d4e7437a2edd',

  // 跨平台 CodeBuddy main.js 候选路径
  CANDIDATE_MAIN_JS_PATHS: resolveCandidateMainJsPaths()
} as const;

// ============================================================================
// 3. Patch v5 锚点与补丁特征码 (热切中枢自愈引擎核心 · v5 新增切换回执闭环)
// ============================================================================

export const PATCH_V5 = {
  VERSION: 'v5',
  PATCH_FLAG: '__byokApplySwitch',
  // v5 特征码：v4 补丁无此标记，用于强制自愈升级
  V5_MARKER: '/*__BYOK_V5_R2__*/',

  // 锚点 1: AM 构造函数注入全局会话实例
  AM_ANCHOR: 'AM=class{constructor(t,e,i){',
  AM_REPLACEMENT: 'AM=class{constructor(t,e,i){globalThis.__cbSession=this;',

  // 锚点 2: 放开 getV2ReconcileData 隔离，防止切号后历史会话丢失
  GV_OLD: 'getV2ReconcileData(t){const e=t?.userId;return e?{enabled:!0,sessions:Array.from(this._sessions.values()).filter(s=>s.userId===e||!s.userId).sort((s,n)=>n.updatedAt-s.updatedAt)}:{enabled:!0,sessions:[]}}',
  GV_NEW: 'getV2ReconcileData(t){return{enabled:!0,sessions:Array.from(this._sessions.values()).filter(s=>!this._isClawSession(s)&&s.deletedAt===void 0).sort((s,n)=>n.updatedAt-s.updatedAt)}}',

  // 锚点 3: 放开 getSessions 隔离，保证全量会话常驻
  GS_OLD: 'getSessions(t){const e=t?.limit??100,i=t?.offset??0,s=t?.userId;if(!s)return this.logService.trace("[CodeBuddySession] Get sessions: no userId provided, returning empty list"),{sessions:[],total:0,hasMore:!1};const n=Array.from(this._sessions.values()).filter(l=>l.deletedAt===void 0&&(l.userId===s||!l.userId)&&!this._isClawSession(l)).sort((l,d)=>d.updatedAt-l.updatedAt),r=n.length,o=n.slice(i,i+e),a=i+e<r,c=n.filter(l=>!l.userId).length;return c>0&&this.logService.info(`[CodeBuddySession] Get sessions: found ${c} legacy sessions without userId, will be migrated on next update`),this.logService.trace(`[CodeBuddySession] Get sessions: userId=${s}, limit=${e}, offset=${i}, total=${r}, returned=${o.length}, hasMore=${a}`),{sessions:o,total:r,hasMore:a}}',
  GS_NEW: 'getSessions(t){const e=t?.limit??100,i=t?.offset??0,s=t?.userId;const n=Array.from(this._sessions.values()).filter(l=>l.deletedAt===void 0&&!this._isClawSession(l)).sort((l,d)=>d.updatedAt-l.updatedAt),r=n.length,o=n.slice(i,i+e),a=i+e<r;return{sessions:o,total:r,hasMore:a}}',

  // 锚点 4: 方法插入点（AuthMainService 中 getStorageKey 之后）
  ANCHOR_METHOD_END: 'getStorageKey(){const e="tencent-cloud.coding-copilot",i=this.apiClient.storageKey;return`secret://${JSON.stringify({extensionId:e,key:i})}`}',
  NEXT_METHOD: 'scheduleRefresh(e=0){',

  // 锚点 5: 启动挂载 watcher
  ANCHOR_RESTORE: 'async restoreSession(){try{await this.storageService.whenReady;',
  RESTORE_REPLACEMENT: 'async restoreSession(){this.startByokWatcher();try{await this.storageService.whenReady;',

  // 注入的完整 WATCHER_METHODS 源码块 (v5 R2: 跨平台数据目录解析 / 非 Windows dir 软链 / 回执闭环)
  WATCHER_METHODS:
    '/*__BYOK_V5_R2__*/' +
    '__byokLog(m){try{this.logService.info("[BYOK-SWITCH] "+m)}catch(_){}}' +
    '__byokDir(k){try{const pm=globalThis.__byokPath;if(!pm)return "";const h=process.env.HOME||process.env.USERPROFILE||"";const mac=process.platform==="darwin";const win=process.platform==="win32";if(k==="data"){if(mac)return pm.join(h,"Library","Application Support");if(!win)return process.env.XDG_CONFIG_HOME||pm.join(h,".config");return process.env.APPDATA||pm.join(h,"AppData","Roaming")}if(mac)return pm.join(h,"Library","Application Support");if(!win)return process.env.XDG_DATA_HOME||pm.join(h,".local","share");return process.env.LOCALAPPDATA||pm.join(h,"AppData","Local")}catch(e){return ""}}' +
    '__byokReceipt(r){try{const fs=globalThis.__byokFs,pm=globalThis.__byokPath;if(!fs||!pm)return;const f=pm.join(this.__byokDir("data"),"CodeBuddy CN","byok-switch-result.json");const t=f+".tmp_"+Date.now();fs.writeFileSync(t,JSON.stringify(r),"utf8");fs.renameSync(t,f)}catch(_){}}' +
    '__ensureJunction(targetUid){' +
    'try{' +
    'const win=process.platform==="win32";' +
    'const la=this.__byokDir("ext");if(!la)return;' +
    'const fm=globalThis.__byokFs,pm=globalThis.__byokPath;' +
    'if(!fm||!pm)return;' +
    'const b=pm.join(la,"CodeBuddyExtension","Data");' +
    'const m=pm.join(b,"69719899-bf05-4822-9e20-d4e7437a2edd","CodeBuddyIDE","69719899-bf05-4822-9e20-d4e7437a2edd");' +
    'const tp=pm.join(b,targetUid,"CodeBuddyIDE");' +
    'const td=pm.join(tp,targetUid);' +
    'if(win?td.toLowerCase()===m.toLowerCase():td===m)return;' +
    'if(!fm.existsSync(tp))fm.mkdirSync(tp,{recursive:true});' +
    'let isJ=false;' +
    'try{isJ=fm.lstatSync(td).isSymbolicLink()}catch(_){}' +
    'if(!isJ){' +
    'if(fm.existsSync(td)){try{fm.renameSync(td,td+".bak_"+Date.now())}catch(_){}}' +
    'fm.symlinkSync(m,td,win?"junction":"dir");' +
    'this.__byokLog("created session link: "+td+" -> "+m);' +
    '}' +
    '}catch(e){this.__byokLog("junc err "+e.message)}' +
    '}' +
    '__byokApplySwitch(s,ts){' +
    'const nextUid=s.account.uid;' +
    'const done=()=>{' +
    'try{this.storageService.store("genie.userId",nextUid,-1,1)}catch(_){}' +
    'this.currentSession=s;' +
    'this._onDidChangeSession.fire(s);' +
    'this.scheduleRefresh();' +
    'this.__ensureJunction(nextUid);' +
    'try{' +
    'if(globalThis.__cbSession&&globalThis.__cbSession._sessions){' +
    'const cs=globalThis.__cbSession;' +
    'const ins=new Map();' +
    'for(const[cid,sess]of cs._sessions){' +
    'if(sess.userId!==nextUid){' +
    'sess.userId=nextUid;' +
    'sess.revision=cs.nextV2Revision();' +
    'ins.set(`session:${cid}`,JSON.stringify(sess));' +
    'cs.broadcastV2("upsert",sess,"byok-switch",sess.revision);' +
    '}' +
    '}' +
    'if(cs._db&&ins.size>0){' +
    'cs._db.updateItems({insert:ins});' +
    '}' +
    'this.__byokLog("migrated "+ins.size+" sessions to uid="+nextUid);' +
    '}' +
    '}catch(e){this.__byokLog("sess sync err "+e.message)}' +
    'this.__byokLog("switched to uid="+nextUid);' +
    '};' +
    'try{this.storeSession(s).then(()=>{done();this.__byokReceipt({ok:!0,uid:s.account.uid,ts:ts})}).catch(e=>{this.__byokLog("store fail "+e.message);this.__byokReceipt({ok:!1,uid:s.account.uid,ts:ts,err:"store_fail: "+e.message})})}' +
    'catch(e){this.__byokLog("store err "+e.message);this.__byokReceipt({ok:!1,uid:s.account.uid,ts:ts,err:"store_err: "+e.message})}' +
    '}' +
    'startByokWatcher(){' +
    'if(this.__byokStarted)return;this.__byokStarted=1;' +
    '(async()=>{' +
    'try{' +
    'const fm=await import("fs"),pm=await import("path");' +
    'const fs=fm.default||fm,path=pm.default||pm;' +
    'globalThis.__byokFs=fs;globalThis.__byokPath=path;' +
    'const f=path.join(this.__byokDir("data"),"CodeBuddy CN","byok-switch.json");' +
    'this.__byokLog("watcher on "+f);' +
    'setInterval(()=>{' +
    'fs.readFile(f,"utf8",(err,txt)=>{' +
    'if(err)return;' +
    'fs.unlink(f,()=>{});' +
    'let cmd=null;' +
    'try{cmd=JSON.parse(txt)}catch(_){this.__byokLog("bad json");this.__byokReceipt({ok:!1,err:"bad_json",ts:0});return}' +
    'const s=cmd&&cmd.session;' +
    'if(!s||!s.account||!s.auth){this.__byokLog("bad cmd");this.__byokReceipt({ok:!1,err:"bad_cmd",ts:cmd?cmd.ts||0:0});return}' +
    'const cur=this.currentSession&&this.currentSession.account?this.currentSession.account.uid:null;' +
    'const next=s.account.uid;' +
    'if(cur===next){this.__byokLog("same uid skip");this.__byokReceipt({ok:!0,skipped:!0,uid:next,ts:cmd.ts||0});return}' +
    'this.__byokApplySwitch(s,cmd.ts||0);' +
    '});' +
    '},2000);' +
    '}catch(e){this.__byokLog("watcher err "+e.message)}' +
    '})()' +
    '}'
} as const;
