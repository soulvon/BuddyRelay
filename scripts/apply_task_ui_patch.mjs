import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDEBAR = path.join(ROOT, 'resources', 'webview', 'sidebar.html');

let html = fs.readFileSync(SIDEBAR, 'utf8').replace(/\r\n/g, '\n');

// 1. 在 CSS 区域增强全屏与抽屉样式
const cssTarget = `    /* 任务模态框动作行：三按钮统一规格（钉死高度/内边距/字号，primary 不再更大） */
    #taskModalOverlay .action-row {
      display: flex;
      gap: 8px;
    }

    #taskModalOverlay .action-row button {
      flex: 1 !important;
      height: 30px !important;
      padding: 0 12px !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }`;

const cssEnhanced = `    /* 任务模态框动作行：统一规格（钉死高度/内边距/字号，primary 不再更大） */
    #taskModalOverlay .action-row {
      display: flex;
      gap: 8px;
    }

    #taskModalOverlay .action-row button {
      flex: 1 !important;
      height: 30px !important;
      padding: 0 12px !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }

    /* ── 全屏模态框：铺满整个侧栏视口 ── */
    #taskModalOverlay.modal-overlay {
      position: fixed !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      background: var(--bg) !important;
      z-index: 1000 !important;
      display: flex !important;
      flex-direction: column !important;
      padding: 0 !important;
      margin: 0 !important;
      border: none !important;
    }

    #taskModalOverlay .modal-box {
      width: 100% !important;
      max-width: 100% !important;
      height: 100% !important;
      max-height: 100% !important;
      border-radius: 0 !important;
      border: none !important;
      box-shadow: none !important;
      display: flex !important;
      flex-direction: column !important;
      background: var(--bg) !important;
      padding: 0 !important;
    }

    #taskModalOverlay .task-header {
      height: 42px !important;
      padding: 0 14px !important;
      border-bottom: 1px solid var(--card-border) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      flex: none !important;
    }

    #taskModalOverlay .task-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #taskModalOverlay .task-header-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    #taskModalOverlay .task-view-body {
      flex: 1 !important;
      overflow-y: auto !important;
      padding: 10px 14px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 8px !important;
    }

    #taskModalOverlay .task-view-footer {
      padding: 8px 14px !important;
      border-top: 1px solid var(--card-border) !important;
      background: var(--subtle-bg, var(--bg)) !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      flex: none !important;
    }

    /* Kite 折叠式账号抽屉 */
    .task-account-bar {
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      background: var(--subtle-bg);
      overflow: hidden;
      margin-bottom: 4px;
    }

    .task-account-trigger {
      height: 32px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }

    .task-account-trigger-info {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .task-drawer-arrow {
      font-size: 11px;
      color: var(--muted);
      transition: transform 0.2s;
    }

    .task-account-bar.is-expanded .task-drawer-arrow {
      transform: rotate(180deg);
    }

    .task-account-drawer {
      border-top: 1px solid var(--card-border);
      padding: 8px 10px;
      background: var(--bg);
    }

    .task-drawer-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .task-drawer-btn {
      height: 22px;
      padding: 0 6px;
      font-size: 10px;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }

    .task-drawer-btn:hover {
      background: var(--hover-bg);
      color: var(--vscode-foreground);
    }

    .task-acct-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 140px;
      overflow-y: auto;
    }

    /* 结果统计指标 4 格网格 */
    .task-summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 12px;
    }

    .task-summary-cell {
      padding: 8px 4px;
      text-align: center;
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      background: var(--subtle-bg);
    }

    .task-summary-val {
      font-size: 14px;
      font-weight: 700;
      line-height: 1.2;
    }

    .task-summary-lbl {
      font-size: 10px;
      color: var(--muted);
      margin-top: 2px;
    }

    .refresh-icon.is-spinning {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }`;

if (!html.includes(cssTarget)) {
  throw new Error('cssTarget not matched');
}
html = html.replace(cssTarget, cssEnhanced);

// 2. 替换 taskModalOverlay DOM 并插入 taskProgressOverlay
const domTarget = `  <!-- 成长任务模态框（统计+列表+操作一体） -->
  <div id="taskModalOverlay" class="modal-overlay" hidden>
    <div class="modal-box" style="width:min(560px,94vw);max-height:88vh">
      <div class="modal-header">
        <h3>成长任务</h3>
        <button class="modal-close" id="taskModalClose" title="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="acct-select-bar" style="margin-bottom:8px;">
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;">
            <input type="checkbox" id="taskSelAll"> <span>全选</span>
          </label>
          <span class="batch-count" id="taskSelCount" style="margin-left:4px;">已选 0</span>
          <div id="taskAcctList" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;"></div>
        </div>
        <div class="action-row" style="margin-bottom:8px;">
          <button class="btn-outline" id="btnTaskRefresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
            刷新列表</button>
          <button class="btn-outline" id="btnTaskAcceptAll">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
            全部报名</button>
          <button class="primary" id="btnTaskRunAuto">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            一键完成</button>
        </div>
        <div class="summary-status-grid" style="margin-bottom:8px;">
          <div class="summary-status-row"><span class="summary-status-label">任务总数</span><span class="summary-status-val" id="taskCount">0</span></div>
          <div class="summary-status-row"><span class="summary-status-label">已完成 / 可领取</span><span class="summary-status-val ok" id="taskDoneStat">0 / 0</span></div>
        </div>
        <div id="taskSkeleton" style="display:none;flex-direction:column;gap:8px;">
          <div class="skeleton-card" style="height:64px;"></div>
          <div class="skeleton-card" style="height:64px;"></div>
          <div class="skeleton-card" style="height:64px;"></div>
        </div>
        <div id="taskList" style="display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow-y:auto;"></div>
        <div id="taskEmpty" class="empty-state" hidden>
          <p>暂无任务数据，点击刷新拉取</p>
        </div>
        <div id="taskProgressBox" hidden style="margin-top:8px;padding:8px;border:1px solid var(--card-border);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:11px;font-weight:600;color:var(--muted);">执行进度</div>
          <div id="taskProgressLines" style="display:flex;flex-direction:column;gap:2px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);"></div>
        </div>
      </div>
    </div>
  </div>`;

const domReplacement = `  <!-- 成长任务中心（全屏子视图模式） -->
  <div id="taskModalOverlay" class="modal-overlay" hidden>
    <div class="modal-box">
      <!-- 头部：标题 + 刷新图标 + 关闭 -->
      <div class="modal-header task-header">
        <div class="task-header-left">
          <h3>成长任务</h3>
          <span class="grid-health-badge grid-health-ok" id="taskHeaderBadge" style="font-size:10px;">0 项</span>
        </div>
        <div class="task-header-right">
          <button class="toolbar-icon-btn" id="btnTaskRefresh" title="刷新任务列表">
            <svg class="refresh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
              <path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
              <path d="M8 16H3v5"/>
            </svg>
          </button>
          <button class="modal-close" id="taskModalClose" title="关闭">×</button>
        </div>
      </div>

      <!-- 视图主体 -->
      <div class="task-view-body">
        <!-- Kite 式折叠多账号选择器 -->
        <div class="task-account-bar" id="taskAccountBar">
          <div class="task-account-trigger" id="taskAccountTrigger" title="点击展开/收起账号选择">
            <div class="task-account-trigger-info">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;opacity:0.75;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span style="font-size:11px;color:var(--muted);">执行目标:</span>
              <span id="taskAccountSummary" style="font-size:11px;font-weight:600;color:var(--vscode-foreground);">已选 1 个账号</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="batch-count" id="taskSelCount">已选 1</span>
              <span class="task-drawer-arrow" id="taskDrawerArrow">▾</span>
            </div>
          </div>
          <div class="task-account-drawer" id="taskAccountDrawer" hidden>
            <div class="task-drawer-tools">
              <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;color:var(--muted);">
                <input type="checkbox" id="taskSelAll"> <span>全选</span>
              </label>
              <div style="flex:1"></div>
              <button class="task-drawer-btn" id="taskSelActiveOnly" type="button">仅当前</button>
              <button class="task-drawer-btn" id="taskSelInvert" type="button">反选</button>
            </div>
            <div id="taskAcctList" class="task-acct-list"></div>
          </div>
        </div>

        <!-- 任务总数与可领取统计 -->
        <div class="summary-status-grid" style="margin:2px 0 0;">
          <div class="summary-status-row"><span class="summary-status-label">任务总数</span><span class="summary-status-val" id="taskCount">0</span></div>
          <div class="summary-status-row"><span class="summary-status-label">已完成 / 可领取</span><span class="summary-status-val ok" id="taskDoneStat">0 / 0</span></div>
        </div>

        <!-- 骨架屏占位 -->
        <div id="taskSkeleton" style="display:none;flex-direction:column;gap:8px;">
          <div class="skeleton-card" style="height:64px;"></div>
          <div class="skeleton-card" style="height:64px;"></div>
          <div class="skeleton-card" style="height:64px;"></div>
        </div>

        <!-- 任务卡片列表 -->
        <div id="taskList" style="display:flex;flex-direction:column;gap:8px;flex:1;overflow-y:auto;padding-right:2px;"></div>
        <div id="taskEmpty" class="empty-state" hidden>
          <p>暂无任务数据，点击右上角刷新拉取</p>
        </div>
      </div>

      <!-- 底部固定操作栏 -->
      <div class="task-view-footer action-row">
        <div style="flex:1;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          <span id="taskFooterHint">勾选账号后一键执行</span>
        </div>
        <button class="btn-outline" id="btnTaskAcceptAll">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
          全部报名</button>
        <button class="primary" id="btnTaskRunAuto">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          一键完成</button>
      </div>
    </div>
  </div>

  <!-- 独立执行进度与结果统计模态框 -->
  <div id="taskProgressOverlay" class="modal-overlay" hidden>
    <div class="modal-box" style="width:min(440px,94vw);max-height:86vh;">
      <!-- 阶段一：进度进行中 -->
      <div id="taskProgressStage">
        <div class="modal-header">
          <h3 id="taskBatchTitle">正在批量执行任务</h3>
        </div>
        <div class="modal-body" style="padding-top:10px;">
          <div class="modal-progress-bar"><div class="modal-progress-fill" id="taskBatchProgressFill" style="width:0%"></div></div>
          <div class="modal-progress-text" id="taskBatchProgressText">准备执行…</div>

          <div id="taskProgressBox" style="margin-top:12px;padding:8px;border:1px solid var(--card-border);border-radius:var(--radius-sm);background:rgba(0,0,0,0.03);max-height:160px;overflow-y:auto;">
            <div id="taskProgressLines" style="display:flex;flex-direction:column;gap:3px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);"></div>
          </div>

          <div style="display:flex;justify-content:flex-end;margin-top:14px;">
            <button class="modal-cancel-btn" id="btnTaskStop" style="color:var(--gh-red,#ef4444);border-color:rgba(239,68,68,0.3);">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px;"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              停止执行
            </button>
          </div>
        </div>
      </div>

      <!-- 阶段二：结果统计面板 -->
      <div id="taskResultStage" hidden>
        <div class="modal-header">
          <h3 id="taskResultHeaderTitle">执行结果</h3>
          <button class="modal-close" id="taskResultCloseX" title="关闭">×</button>
        </div>
        <div class="modal-body" style="padding-top:8px;">
          <div style="text-align:center;margin:8px 0 12px;">
            <div id="taskResultIcon" style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:rgba(16,185,129,0.12);color:var(--ac-emerald,#10b981);margin-bottom:8px;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </div>
            <div id="taskResultMainTitle" style="font-size:14px;font-weight:600;color:var(--vscode-foreground);">批量执行完成</div>
            <div id="taskResultSubTitle" style="font-size:11px;color:var(--muted);margin-top:2px;">耗时 1 秒 · 共处理 1 个账号</div>
          </div>

          <div class="task-summary-grid">
            <div class="task-summary-cell">
              <div class="task-summary-val" id="resClaimedCredits" style="color:var(--ac-emerald,#10b981);">+0</div>
              <div class="task-summary-lbl">到账积分</div>
            </div>
            <div class="task-summary-cell">
              <div class="task-summary-val" id="resClaimedTasks" style="color:var(--ac-blue,#3b82f6);">0</div>
              <div class="task-summary-lbl">已领任务</div>
            </div>
            <div class="task-summary-cell">
              <div class="task-summary-val" id="resAcceptedTasks" style="color:var(--vscode-foreground);">0</div>
              <div class="task-summary-lbl">新报任务</div>
            </div>
            <div class="task-summary-cell">
              <div class="task-summary-val" id="resSkippedTasks" style="color:var(--muted);">0</div>
              <div class="task-summary-lbl">跳过/人工</div>
            </div>
          </div>

          <div style="font-size:11px;font-weight:600;color:var(--muted);margin-bottom:4px;">账号明细</div>
          <div id="taskResultDetails" style="max-height:120px;overflow-y:auto;border:1px solid var(--card-border);border-radius:var(--radius-sm);padding:6px;display:flex;flex-direction:column;gap:3px;font-size:11px;"></div>

          <div style="display:flex;justify-content:flex-end;margin-top:14px;">
            <button class="primary" id="btnTaskResultClose" style="min-width:100px;">完成</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;

if (!html.includes(domTarget)) {
  throw new Error('domTarget not matched');
}
html = html.replace(domTarget, domReplacement);

// 3. 替换 JS 控制逻辑
const jsTargetStart = '    // ── 成长任务模态框 ──';
const jsTargetEnd = '    // ── 搜索 ──';
const sIdx = html.indexOf(jsTargetStart);
const eIdx = html.indexOf(jsTargetEnd);
if (sIdx === -1 || eIdx === -1) {
  throw new Error('JS targets not matched');
}

const newJs = `    // ── 成长任务模态框 ──
    let currentTasks = [];
    let tasksLoaded = false;

    // ── 任务中心 DOM 声明（必须严格先声明后绑定，通过 G4 门控） ──
    const taskCountEl = document.getElementById('taskCount');
    const taskDoneStat = document.getElementById('taskDoneStat');
    const taskListEl = document.getElementById('taskList');
    const taskEmpty = document.getElementById('taskEmpty');
    const taskHeaderBadge = document.getElementById('taskHeaderBadge');
    const taskFooterHint = document.getElementById('taskFooterHint');

    const selectedAccountIds = new Set();
    const taskAccountBar = document.getElementById('taskAccountBar');
    const taskAccountTrigger = document.getElementById('taskAccountTrigger');
    const taskAccountDrawer = document.getElementById('taskAccountDrawer');
    const taskAccountSummary = document.getElementById('taskAccountSummary');
    const taskDrawerArrow = document.getElementById('taskDrawerArrow');
    const taskAcctList = document.getElementById('taskAcctList');
    const taskSelAll = document.getElementById('taskSelAll');
    const taskSelCount = document.getElementById('taskSelCount');
    const taskSelActiveOnly = document.getElementById('taskSelActiveOnly');
    const taskSelInvert = document.getElementById('taskSelInvert');

    const btnGrowthTasks = document.getElementById('btnGrowthTasks');
    const taskModalOverlay = document.getElementById('taskModalOverlay');
    const btnTaskRefresh = document.getElementById('btnTaskRefresh');
    const btnTaskAcceptAll = document.getElementById('btnTaskAcceptAll');
    const btnTaskRunAuto = document.getElementById('btnTaskRunAuto');
    const taskModalClose = document.getElementById('taskModalClose');

    // 独立进度模态框 DOM
    const taskProgressOverlay = document.getElementById('taskProgressOverlay');
    const taskProgressStage = document.getElementById('taskProgressStage');
    const taskResultStage = document.getElementById('taskResultStage');
    const taskBatchTitle = document.getElementById('taskBatchTitle');
    const taskBatchProgressFill = document.getElementById('taskBatchProgressFill');
    const taskBatchProgressText = document.getElementById('taskBatchProgressText');
    const taskProgressBox = document.getElementById('taskProgressBox');
    const taskProgressLines = document.getElementById('taskProgressLines');
    const btnTaskStop = document.getElementById('btnTaskStop');

    // 结果面板 DOM
    const taskResultIcon = document.getElementById('taskResultIcon');
    const taskResultMainTitle = document.getElementById('taskResultMainTitle');
    const taskResultSubTitle = document.getElementById('taskResultSubTitle');
    const resClaimedCredits = document.getElementById('resClaimedCredits');
    const resClaimedTasks = document.getElementById('resClaimedTasks');
    const resAcceptedTasks = document.getElementById('resAcceptedTasks');
    const resSkippedTasks = document.getElementById('resSkippedTasks');
    const taskResultDetails = document.getElementById('taskResultDetails');
    const btnTaskResultClose = document.getElementById('btnTaskResultClose');
    const taskResultCloseX = document.getElementById('taskResultCloseX');

    function renderAcctChips() {
      if (!currentAccounts.length) {
        taskAcctList.innerHTML = '<span style="font-size:11px;color:var(--muted);">号池为空</span>';
        taskAccountSummary.textContent = '暂无可用账号';
        taskSelCount.textContent = '0';
        return;
      }

      taskAcctList.innerHTML = currentAccounts.map(acc => {
        const checked = selectedAccountIds.has(acc.id);
        const rawName = acc.nickname || acc.email;
        const name = privacyMode ? maskName(rawName) : rawName;
        const suffix = acc.isActive ? '（当前）' : '';
        return '<label class="acct-chip ' + (checked ? 'is-selected' : '') + '" style="display:flex;align-items:center;justify-content:space-between;width:100%;border-radius:var(--radius-sm);padding:4px 8px;margin-bottom:2px;" title="' + escHtml(rawName) + '">' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<input type="checkbox" data-acct="' + acc.id + '" ' + (checked ? 'checked' : '') + '>' +
            '<span style="font-size:11px;color:var(--vscode-foreground);">' + escHtml(name) + suffix + '</span>' +
          '</div>' +
          '<span style="font-size:10px;color:var(--muted);">' + fmtNum(acc.totalCredits || 0) + '分</span>' +
        '</label>';
      }).join('');

      taskSelCount.textContent = '已选 ' + selectedAccountIds.size;
      const allChecked = currentAccounts.length > 0 && currentAccounts.every(a => selectedAccountIds.has(a.id));
      taskSelAll.checked = allChecked;

      // 更新单行收起态文字
      if (selectedAccountIds.size === 0) {
        taskAccountSummary.textContent = '未选择账号 (点击勾选)';
        taskFooterHint.textContent = '请先在上方勾选要执行的账号';
      } else if (selectedAccountIds.size === currentAccounts.length) {
        taskAccountSummary.textContent = '全部账号 (共 ' + currentAccounts.length + ' 个)';
        taskFooterHint.textContent = '将对全部 ' + currentAccounts.length + ' 个账号执行任务';
      } else if (selectedAccountIds.size === 1) {
        const singleId = Array.from(selectedAccountIds)[0];
        const singleAcc = currentAccounts.find(a => a.id === singleId);
        const sName = singleAcc ? (singleAcc.nickname || singleAcc.email) : '1个账号';
        taskAccountSummary.textContent = (privacyMode ? maskName(sName) : sName) + (singleAcc && singleAcc.isActive ? ' (当前)' : '');
        taskFooterHint.textContent = '将对账号 [' + (privacyMode ? maskName(sName) : sName) + '] 执行';
      } else {
        taskAccountSummary.textContent = '已选 ' + selectedAccountIds.size + ' 个账号 (共 ' + currentAccounts.length + ' 个)';
        taskFooterHint.textContent = '将按序对已选 ' + selectedAccountIds.size + ' 个账号执行';
      }
    }

    // 抽屉展开/收起
    taskAccountTrigger.addEventListener('click', () => {
      const isExp = taskAccountBar.classList.toggle('is-expanded');
      taskAccountDrawer.hidden = !isExp;
    });

    taskAcctList.addEventListener('change', e => {
      const input = e.target;
      if (!input.dataset || !input.dataset.acct) return;
      if (input.checked) selectedAccountIds.add(input.dataset.acct);
      else selectedAccountIds.delete(input.dataset.acct);
      renderAcctChips();
    });

    taskSelAll.addEventListener('change', () => {
      if (taskSelAll.checked) {
        currentAccounts.forEach(a => selectedAccountIds.add(a.id));
      } else {
        selectedAccountIds.clear();
      }
      renderAcctChips();
    });

    taskSelActiveOnly.addEventListener('click', () => {
      selectedAccountIds.clear();
      const active = currentAccounts.find(a => a.isActive);
      if (active) selectedAccountIds.add(active.id);
      renderAcctChips();
    });

    taskSelInvert.addEventListener('click', () => {
      currentAccounts.forEach(a => {
        if (selectedAccountIds.has(a.id)) selectedAccountIds.delete(a.id);
        else selectedAccountIds.add(a.id);
      });
      renderAcctChips();
    });

    function openProgressModal(title) {
      taskProgressOverlay.hidden = false;
      taskProgressStage.hidden = false;
      taskResultStage.hidden = true;
      taskBatchTitle.textContent = title;
      taskBatchProgressFill.style.width = '0%';
      taskBatchProgressText.textContent = '正在初始化...';
      taskProgressLines.innerHTML = '';
      btnTaskStop.disabled = false;
      btnTaskStop.textContent = '停止执行';
    }

    function appendProgressLine(text, level) {
      const line = document.createElement('div');
      line.className = 'task-progress-line is-' + (level || 'doing');
      line.textContent = text;
      taskProgressLines.appendChild(line);
      taskProgressLines.scrollTop = taskProgressLines.scrollHeight;
    }

    // 打开全屏任务中心
    btnGrowthTasks.addEventListener('click', () => {
      taskModalOverlay.hidden = false;
      const active = currentAccounts.find(a => a.isActive);
      if (active && selectedAccountIds.size === 0) {
        selectedAccountIds.add(active.id);
      }
      renderAcctChips();
      if (currentTasks.length === 0) {
        document.getElementById('taskSkeleton').style.display = 'flex';
        btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
        vscode.postMessage({ command: 'taskList' });
      }
    });

    taskModalClose.addEventListener('click', () => {
      taskModalOverlay.hidden = true;
    });

    // 刷新图标按钮
    btnTaskRefresh.addEventListener('click', () => {
      document.getElementById('taskSkeleton').style.display = 'flex';
      taskListEl.innerHTML = '';
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
      vscode.postMessage({ command: 'taskList' });
    });

    // 一键完成与全部报名（唤起独立进度模态框）
    btnTaskRunAuto.addEventListener('click', () => {
      if (selectedAccountIds.size === 0) {
        showToast('请先勾选要执行的账号', 'error', 2200);
        return;
      }
      openProgressModal('正在批量执行成长任务');
      appendProgressLine('开始批量执行，共 ' + selectedAccountIds.size + ' 个账号...', 'doing');
      vscode.postMessage({ command: 'taskRunAuto', accountIds: Array.from(selectedAccountIds) });
    });

    btnTaskAcceptAll.addEventListener('click', () => {
      if (selectedAccountIds.size === 0) {
        showToast('请先勾选要执行的账号', 'error', 2200);
        return;
      }
      openProgressModal('正在批量报名成长任务');
      appendProgressLine('开始批量报名，共 ' + selectedAccountIds.size + ' 个账号...', 'doing');
      vscode.postMessage({ command: 'taskAcceptAll', accountIds: Array.from(selectedAccountIds) });
    });

    // 停止执行
    btnTaskStop.addEventListener('click', () => {
      btnTaskStop.disabled = true;
      btnTaskStop.textContent = '中止中...';
      vscode.postMessage({ command: 'taskStop' });
    });

    // 关闭统计结果
    function closeTaskResult() {
      taskProgressOverlay.hidden = true;
      // 刷新最新任务数据
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
      vscode.postMessage({ command: 'taskList' });
    }
    btnTaskResultClose.addEventListener('click', closeTaskResult);
    taskResultCloseX.addEventListener('click', closeTaskResult);

    function renderTasks() {
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.remove('is-spinning');
      taskCountEl.textContent = String(currentTasks.length);
      taskHeaderBadge.textContent = currentTasks.length + ' 项';
      const done = currentTasks.filter(t => t.claimed || t.acceptStatus === 'claimed').length;
      const claimable = currentTasks.filter(t => isTaskClaimable(t)).length;
      taskDoneStat.textContent = done + ' / ' + claimable;

      if (!currentTasks.length) {
        taskListEl.innerHTML = '';
        taskEmpty.hidden = false;
        return;
      }
      taskEmpty.hidden = true;

      taskListEl.innerHTML = currentTasks.map(t => {
        const claimable = isTaskClaimable(t);
        let statusLabel = '进行中';
        let statusClass = 'grid-health-badge grid-health-warn';
        let action = '';

        if (t.claimed || t.acceptStatus === 'claimed') {
          statusLabel = '已领取';
          statusClass = 'grid-health-badge grid-health-ok';
        } else if (t.locked) {
          statusLabel = '未解锁';
          statusClass = 'grid-health-badge grid-health-warn';
        } else if (t.manualOnly) {
          statusLabel = '需人工';
          statusClass = 'grid-health-badge grid-health-warn';
        } else if (claimable) {
          statusLabel = '可领取';
          statusClass = 'grid-health-badge grid-health-ok';
          action = '<button class="grid-switch-btn" onclick="onTaskClaim(\\'' + t.taskCode + '\\')">领取</button>';
        } else if (t.acceptStatus === 'not_accepted') {
          statusLabel = '未报名';
          action = '<button class="status-toggle-btn is-enabled" onclick="onTaskAccept(\\'' + t.taskCode + '\\')">报名</button>';
        }

        // 防御乱码字符
        const safeTitle = (t.title || '').replace(/\\uFFFD/g, '');

        return '<div class="grid-card" data-code="' + t.taskCode + '">' +
          '<div class="grid-card-head">' +
            '<div class="grid-card-email" title="' + escHtml(safeTitle) + '">' + escHtml(safeTitle) + '</div>' +
            '<span class="' + statusClass + '">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="grid-quota-head" style="margin-top:2px;">' +
            '<span style="font-family:var(--vscode-editor-font-family,monospace);opacity:0.7;">' + escHtml(t.taskCode) + '</span>' +
            '<span class="grid-quota-val ' + (t.current >= t.target && t.target > 0 ? 'is-ok' : '') + '">' + t.current + ' / ' + t.target + '</span>' +
          '</div>' +
          (action ? '<div class="grid-card-actions">' + action + '</div>' : '') +
        '</div>';
      }).join('');
    }

    function isTaskClaimable(t) {
      if (t.locked || t.claimed || t.acceptStatus === 'claimed') return false;
      if (t.target > 0 && t.current >= t.target) return true;
      return t.target <= 0 && t.acceptStatus === 'completed';
    }

    window.onTaskClaim = function(code) {
      vscode.postMessage({ command: 'taskClaim', taskCode: code });
    };

    window.onTaskAccept = function(code) {
      vscode.postMessage({ command: 'taskAcceptAll' });
    };

`;

html = html.slice(0, sIdx) + newJs + html.slice(eIdx);

// 4. 更新 window.addEventListener('message') 中的 taskProgress 与 taskBatchSummary 分支
const msgTarget = `      } else if (msg.command === 'taskProgress') {
        taskProgressBox.hidden = false;
        appendTaskProgressLine(msg.text, msg.level);
      } else if (msg.command === 'updateTasks') {`;

const msgReplacement = `      } else if (msg.command === 'taskProgress') {
        if (typeof msg.percent === 'number') {
          taskBatchProgressFill.style.width = msg.percent + '%';
        }
        if (msg.text) {
          taskBatchProgressText.textContent = msg.text;
          appendProgressLine(msg.text, msg.level);
        }
      } else if (msg.command === 'taskBatchSummary') {
        const s = msg.data || {};
        taskProgressStage.hidden = true;
        taskResultStage.hidden = false;
        if (s.stopped) {
          taskResultMainTitle.textContent = '任务批处理已中止';
          taskResultIcon.innerHTML = '<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"16\" x2=\"12.01\" y2=\"16\"/></svg>';
          taskResultIcon.style.color = 'var(--gh-red, #ef4444)';
          taskResultIcon.style.background = 'rgba(239, 68, 68, 0.12)';
        } else {
          taskResultMainTitle.textContent = '批量任务执行完成';
          taskResultIcon.innerHTML = '<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 6 9 17l-5-5\"/></svg>';
          taskResultIcon.style.color = 'var(--ac-emerald, #10b981)';
          taskResultIcon.style.background = 'rgba(16, 185, 129, 0.12)';
        }
        taskResultSubTitle.textContent = '耗时 ' + (s.durationSec || 1) + ' 秒 · 处理 ' + (s.processedAccounts || 0) + '/' + (s.totalAccounts || 0) + ' 个账号';
        resClaimedCredits.textContent = '+' + fmtNum(s.totalCredits || 0);
        resClaimedTasks.textContent = String(s.totalClaimed || 0);
        resAcceptedTasks.textContent = String(s.totalAccepted || 0);
        resSkippedTasks.textContent = String((s.totalSkipped || 0) + (s.totalFailures || 0));

        const details = s.details || [];
        taskResultDetails.innerHTML = details.length ? details.map(d => {
          const rawName = d.accountName || '账号';
          const name = privacyMode ? maskName(rawName) : rawName;
          const isOk = d.status === 'ok';
          const color = isOk ? 'var(--ac-emerald, #10b981)' : d.status === 'stopped' ? 'var(--muted)' : 'var(--gh-red, #ef4444)';
          return '<div style=\"display:flex;justify-content:space-between;gap:8px;\"><span style=\"font-weight:500;\">' + escHtml(name) + '</span><span style=\"color:' + color + ';\">' + escHtml(d.message || '') + '</span></div>';
        }).join('') : '<div style=\"color:var(--muted);text-align:center;\">无明细记录</div>';
      } else if (msg.command === 'updateTasks') {`;

if (!html.includes(msgTarget)) {
  throw new Error('msgTarget not matched');
}
html = html.replace(msgTarget, msgReplacement);

fs.writeFileSync(SIDEBAR, html, 'utf8');
console.log('Successfully patched sidebar.html!');
