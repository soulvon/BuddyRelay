(function () {
  'use strict';

  // ── [1] I18n & State ──────────────────────────────────────────────────────
  const __I18N__ = window.__I18N__ || {};
  function t(key) {
    let s = (__I18N__ && __I18N__[key] !== undefined) ? __I18N__[key] : key;
    for (let i = 1; i < arguments.length; i++) {
      s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }

  const vscode = acquireVsCodeApi();
  const savedState = vscode.getState() || {};

  let currentAccounts = [];
  let currentLockedUids = [];
  let currentSettings = {};
  let privacyMode = savedState.privacyMode === true;
  let activeTag = savedState.activeTag || 'all';
  let sortBy = savedState.sortBy || 'default';
  let searchQuery = '';

  let switchingId = '';
  let switchElapsed = 0;
  let _switchTimeout = null;
  let _switchTicker = null;
  let checkingId = '';
  let _checkinFallback = 0;
  const refreshingIds = new Set();
  let _refreshAllFallback = 0;
  const acceptingTaskCodes = new Map();

  let lastCardsFingerprint = '';
  let lastCooldownEvents = null;
  let lastUsageRecords = [];
  let lastUsageSummary = null;
  let lastUsageFingerprint = '';
  let usageRefreshLockTs = 0;
  const usageOpenState = new Map();

  let lastModelStats = null;
  let modelStatsDays = 7;
  let modelStatsAccount = 'all';
  let modelStatsModel = 'all';
  let modelStatsSyncRequested = false;
  let modelStatsFingerprint = '';

  let activeUsageTab = 'model';
  let lastTokenLedger = null;
  let tokenRange = 'today';
  let tokenMode = 'total';
  let tokenAccountFilter = 'all';
  let tokenSourceFilter = 'all';
  let tokenStatsFingerprint = '';

  let currentTasks = [];
  let viewingAccountId = null;
  let editingMetaAccountId = '';
  const selectedAccountIds = new Set();
  if (Array.isArray(savedState.taskSelection)) {
    savedState.taskSelection.forEach((id) => {
      if (typeof id === 'string' && id) selectedAccountIds.add(id);
    });
  }

  function persistTaskSelection() {
    const st = vscode.getState() || {};
    st.taskSelection = Array.from(selectedAccountIds);
    vscode.setState(st);
  }

  // ── [2] Security, Escaping, Masking & Panel Error Boundary ────────────────
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const escAttr = escHtml;

  function maskEmail(email) {
    const str = String(email || '');
    const atIdx = str.indexOf('@');
    if (atIdx < 0) return str;
    const u = str.slice(0, atIdx);
    const maskedU = u.length <= 2 ? (u[0] || '*') + '***' : u.slice(0, 2) + '***';
    return maskedU + '@***';
  }

  function maskName(name) {
    if (!name) return t('common.unknown');
    if (!privacyMode) return name;
    const str = String(name);
    if (/^1\d{10}$/.test(str)) return str.slice(0, 3) + '****' + str.slice(7);
    if (str.includes('@')) return maskEmail(str);
    if (str.length === 2) return str[0] + '*';
    if (str.length === 3) return str[0] + '**';
    if (str.length > 3) return str[0] + '***' + str.slice(-1);
    return str;
  }

  function maskUid(uid) {
    if (!uid) return '—';
    const str = String(uid);
    if (privacyMode) return str.slice(0, 4) + '****' + str.slice(-2);
    return str.slice(0, 8) + '...' + str.slice(-4);
  }

  function fmtNum(n) {
    const v = Number(n || 0);
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  function fmtCompactTok(n) {
    const v = Number(n || 0);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B tok';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M tok';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K tok';
    return Math.round(v) + ' tok';
  }

  function fmtUsd(n) {
    const v = Number(n || 0);
    if (v <= 0) return '$0.00';
    if (v < 0.01) return '<$0.01';
    if (v < 100) return '$' + v.toFixed(2);
    return '$' + v.toFixed(1);
  }

  function fmtCooldownTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtDateCN(ts) {
    const raw = Number(ts || 0);
    if (!Number.isFinite(raw) || raw <= 0) return '';
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function isEntAccount(acc) {
    if (!acc) return false;
    const pt = String(acc.paymentType || '').toLowerCase();
    return Boolean(acc.enterpriseId || pt === 'enterprise' || pt === 'ultimate' || pt === 'exclusive');
  }

  function isLowQuotaAccount(acc) {
    if (!acc || acc.quotaUnlimited) return false;
    if (isEntAccount(acc)) return Boolean(acc.basePackage && acc.basePackage.total > 0 && acc.basePackage.percent <= 30);
    return Boolean(acc.activityPackage && acc.activityPackage.percent <= 30);
  }

  function getAccountOriginName(acc) {
    return (acc && (acc.nickname || acc.email)) || '';
  }

  function getAccountRawName(acc) {
    const custom = acc && acc.displayName ? String(acc.displayName).trim() : '';
    return custom || getAccountOriginName(acc);
  }

  function levelClass(percent, remain) {
    if (remain <= 0 || percent <= 10) return 'is-danger';
    if (percent <= 30) return 'is-warn';
    return 'is-ok';
  }

  function safeRender(panelName, containerEl, fn) {
    try {
      fn();
    } catch (err) {
      console.error('[BuddyRelay][Render:' + panelName + ']', err);
      if (containerEl) {
        containerEl.innerHTML = '<div class="panel-error-fallback">' + escHtml(t('err.unknownError')) + '</div>';
      }
    }
  }

  // ── [3] DOM References (declared before event binding for TDZ safety) ─────
  const appRoot = document.getElementById('appRoot') || document.querySelector('.app');
  const btnAddOAuth = document.getElementById('btnAddOAuth');
  const btnEmptyAddAccount = document.getElementById('btnEmptyAddAccount');
  const btnBatchCheckin = document.getElementById('btnBatchCheckin');
  const refreshAllBtn = document.getElementById('refreshAllBtn');
  const privacyModeBtn = document.getElementById('privacyModeBtn');
  const gridCount = document.getElementById('gridCount');
  const summaryCard = document.getElementById('summaryCard');
  const summaryDailyPct = document.getElementById('summaryDailyPct');
  const summaryDailyBar = document.getElementById('summaryDailyBar');
  const summaryDailyNum = document.getElementById('summaryDailyNum');
  const summaryDailyMax = document.getElementById('summaryDailyMax');
  const summaryWeeklyPct = document.getElementById('summaryWeeklyPct');
  const summaryWeeklyBar = document.getElementById('summaryWeeklyBar');
  const summaryWeeklyNum = document.getElementById('summaryWeeklyNum');
  const summaryWeeklyMax = document.getElementById('summaryWeeklyMax');

  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  const sortSelect = document.getElementById('sortSelect');
  const filterTrigger = document.getElementById('filterTrigger');
  const filterDropdown = document.getElementById('filterDropdown');
  const filterWrap = document.getElementById('filterWrap');
  const filterOptions = document.getElementById('filterOptions');
  const filterLabel = document.getElementById('filterLabel');
  const filterCount = document.getElementById('filterCount');
  const tagList = document.getElementById('tagList');
  const accountGrid = document.getElementById('accountGrid');
  const emptyState = document.getElementById('emptyState');

  const btnSettings = document.getElementById('btnSettings');
  const settingsModalOverlay = document.getElementById('settingsModalOverlay');
  const settingsModalClose = document.getElementById('settingsModalClose');
  const btnSettingsCancel = document.getElementById('btnSettingsCancel');
  const btnSettingsSave = document.getElementById('btnSettingsSave');
  const btnSettingsReset = document.getElementById('btnSettingsReset');
  const btnImportAccountsFile = document.getElementById('btnImportAccountsFile');
  const btnManualCheckUpdate = document.getElementById('btnManualCheckUpdate');

  const setCheckinEnabled = document.getElementById('setCheckinEnabled');
  const setDailyTime = document.getElementById('setDailyTime');
  const setRandomJitter = document.getElementById('setRandomJitter');
  const setPerAccountDelay = document.getElementById('setPerAccountDelay');
  const setRefreshInterval = document.getElementById('setRefreshInterval');
  const setGrowthAfterCheckin = document.getElementById('setGrowthAfterCheckin');
  const setStartupMakeup = document.getElementById('setStartupMakeup');
  const setAutoUseMakeupCard = document.getElementById('setAutoUseMakeupCard');
  const setAutoSwitchEnabled = document.getElementById('setAutoSwitchEnabled');
  const setQuotaThreshold = document.getElementById('setQuotaThreshold');
  const setAutoSwitchStrategy = document.getElementById('setAutoSwitchStrategy');
  const setCooldownMinutes = document.getElementById('setCooldownMinutes');
  const setAutoSwitchOn429 = document.getElementById('setAutoSwitchOn429');
  const setAutoSwitchNotify = document.getElementById('setAutoSwitchNotify');
  const setPrivacyModeDefault = document.getElementById('setPrivacyModeDefault');
  const setUpdateAutoCheck = document.getElementById('setUpdateAutoCheck');
  const setUpdateAutoInstall = document.getElementById('setUpdateAutoInstall');
  const setLocale = document.getElementById('setLocale');

  const addAccountOverlay = document.getElementById('addAccountOverlay');
  const addAccountClose = document.getElementById('addAccountClose');
  const btnGrowthTasks = document.getElementById('btnGrowthTasks');
  const taskModalOverlay = document.getElementById('taskModalOverlay');
  const btnTaskRefresh = document.getElementById('btnTaskRefresh');
  const btnTaskAcceptAll = document.getElementById('btnTaskAcceptAll');
  const btnTaskRunAuto = document.getElementById('btnTaskRunAuto');
  const taskModalClose = document.getElementById('taskModalClose');
  const taskCountEl = document.getElementById('taskCount');
  const taskDoneStat = document.getElementById('taskDoneStat');
  const taskListEl = document.getElementById('taskList');
  const taskEmpty = document.getElementById('taskEmpty');
  const taskHeaderBadge = document.getElementById('taskHeaderBadge');
  const taskFooterHint = document.getElementById('taskFooterHint');
  const taskAccountBar = document.getElementById('taskAccountBar');
  const taskAccountTrigger = document.getElementById('taskAccountTrigger');
  const taskAccountDrawer = document.getElementById('taskAccountDrawer');
  const taskAccountSummary = document.getElementById('taskAccountSummary');
  const taskAcctList = document.getElementById('taskAcctList');
  const taskSelAll = document.getElementById('taskSelAll');
  const taskSelCount = document.getElementById('taskSelCount');
  const taskSelActiveOnly = document.getElementById('taskSelActiveOnly');
  const taskSelInvert = document.getElementById('taskSelInvert');

  const taskProgressOverlay = document.getElementById('taskProgressOverlay');
  const taskProgressStage = document.getElementById('taskProgressStage');
  const taskResultStage = document.getElementById('taskResultStage');
  const taskBatchTitle = document.getElementById('taskBatchTitle');
  const taskBatchProgressFill = document.getElementById('taskBatchProgressFill');
  const taskBatchProgressText = document.getElementById('taskBatchProgressText');
  const taskProgressLines = document.getElementById('taskProgressLines');
  const btnTaskStop = document.getElementById('btnTaskStop');
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

  const usageModalOverlay = document.getElementById('usageModalOverlay');
  const btnOpenUsageDetail = document.getElementById('btnOpenUsageDetail');
  const usageModalClose = document.getElementById('usageModalClose');
  const usageModalCancel = document.getElementById('usageModalCancel');
  const usageModalTabs = document.getElementById('usageModalTabs');
  const tabContentModel = document.getElementById('tabContentModel');
  const tabContentLogs = document.getElementById('tabContentLogs');
  const btnRefreshUsage = document.getElementById('btnRefreshUsage');
  const tokenStatsBar = document.getElementById('tokenStatsBar');
  const todayTokensBadge = document.getElementById('todayTokensBadge');
  const todayCostBadge = document.getElementById('todayCostBadge');
  const btnOpenTokenDetail = document.getElementById('btnOpenTokenDetail');
  const tabContentTokens = document.getElementById('tabContentTokens');
  const tokenStatsRange = document.getElementById('tokenStatsRange');
  const tokenStatsMode = document.getElementById('tokenStatsMode');
  const tokenStatsAccount = document.getElementById('tokenStatsAccount');
  const tokenStatsSource = document.getElementById('tokenStatsSource');
  const tokenStatsKpiBar = document.getElementById('tokenStatsKpiBar');
  const tokenStatsBody = document.getElementById('tokenStatsBody');
  const usageModalHint = document.getElementById('usageModalHint');

  const restartModalOverlay = document.getElementById('restartModalOverlay');
  const restartNowBtn = document.getElementById('restartNowBtn');
  const restartLaterBtn = document.getElementById('restartLaterBtn');
  const restartModalClose = document.getElementById('restartModalClose');

  const btnExportPool = document.getElementById('btnExportPool');
  const btnDoctor = document.getElementById('btnDoctor');
  const exportModalOverlay = document.getElementById('exportModalOverlay');
  const exportModalClose = document.getElementById('exportModalClose');
  const btnExportFull = document.getElementById('btnExportFull');
  const btnExportMasked = document.getElementById('btnExportMasked');

  const editMetaModalOverlay = document.getElementById('editMetaModalOverlay');
  const editMetaClose = document.getElementById('editMetaClose');
  const editMetaCancel = document.getElementById('editMetaCancel');
  const editMetaSave = document.getElementById('editMetaSave');
  const editMetaAccountName = document.getElementById('editMetaAccountName');
  const editMetaDisplayName = document.getElementById('editMetaDisplayName');
  const editMetaTags = document.getElementById('editMetaTags');
  const editMetaNotes = document.getElementById('editMetaNotes');

  // ── [4] A11y Focus Isolation, Modal Lifecycle & Toast System ──────────────
  let lastFocusedElement = null;

  function hasOpenModals() {
    return Boolean(document.querySelector('.modal-overlay:not([hidden])'));
  }

  function openModal(overlay, initialFocusEl) {
    if (!overlay) return;
    if (!hasOpenModals()) {
      lastFocusedElement = document.activeElement;
      if (appRoot) {
        appRoot.inert = true;
        appRoot.setAttribute('aria-hidden', 'true');
      }
    }
    overlay.hidden = false;
    setTimeout(() => {
      const target = initialFocusEl || overlay.querySelector(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
    }, 0);
  }

  function closeModal(overlay) {
    if (!overlay) return;
    overlay.hidden = true;
    if (!hasOpenModals()) {
      if (appRoot) {
        appRoot.inert = false;
        appRoot.removeAttribute('aria-hidden');
      }
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function' && lastFocusedElement.isConnected) {
        lastFocusedElement.focus();
      }
      lastFocusedElement = null;
    }
  }

  const _toastByKey = new Map();
  function removeToast(toast, immediate = false) {
    if (!toast || !toast.parentNode) return;
    if (toast._hideTimer) clearTimeout(toast._hideTimer);
    if (toast.dataset && toast.dataset.toastKey && _toastByKey.get(toast.dataset.toastKey) === toast) {
      _toastByKey.delete(toast.dataset.toastKey);
    }
    if (immediate) {
      toast.remove();
      return;
    }
    toast.classList.remove('toast-in');
    toast.classList.add('toast-out');
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 220);
  }

  function removeToastByKey(key) {
    const existing = _toastByKey.get(key);
    if (existing) removeToast(existing);
    _toastByKey.delete(key);
  }

  function createToast(msg, type, key, detail = '') {
    const container = document.getElementById('toastContainer');
    if (!container) return null;
    if (key && _toastByKey.has(key)) removeToast(_toastByKey.get(key), true);

    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    if (key) toast.dataset.toastKey = key;

    const iconHtml = type === 'loading'
      ? '<span class="toast-spinner"></span>'
      : type === 'success'
        ? '<svg class="toast-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 8l3 3 7-7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg class="toast-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6.5"/><line x1="8" y1="5" x2="8" y2="9" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor"/></svg>';
    const closeBtn = '<button type="button" class="toast-close" aria-label="' + escAttr(t('common.close')) + '">&times;</button>';

    if (detail) {
      toast.classList.add('toast-with-actions');
      toast.innerHTML =
        '<div class="toast-main">' + iconHtml + '<span class="toast-msg">' + escHtml(msg) + '</span>' + closeBtn + '</div>' +
        '<div class="toast-acts">' +
          '<button type="button" class="toast-act" data-act="copy">' + escHtml(t('err.copyDetail')) + '</button>' +
          '<button type="button" class="toast-act" data-act="report">' + escHtml(t('err.reportIssue')) + '</button>' +
        '</div>';
      const copyBtn = toast.querySelector('.toast-act[data-act="copy"]');
      const copyLabel = copyBtn.textContent;
      copyBtn.addEventListener('click', () => {
        if (copyBtn.disabled) return;
        vscode.postMessage({ command: 'copyText', text: detail });
        copyBtn.textContent = t('err.copied');
        copyBtn.disabled = true;
        setTimeout(() => {
          if (!copyBtn.isConnected) return;
          copyBtn.textContent = copyLabel;
          copyBtn.disabled = false;
        }, 1500);
      });
      toast.querySelector('.toast-act[data-act="report"]').addEventListener('click', () => {
        vscode.postMessage({ command: 'reportIssue', text: detail });
      });
    } else {
      toast.innerHTML = iconHtml + '<span class="toast-msg">' + escHtml(msg) + '</span>' + closeBtn;
    }

    toast.querySelector('.toast-close').addEventListener('click', () => removeToast(toast));
    container.appendChild(toast);
    if (key) _toastByKey.set(key, toast);
    while (container.children.length > 4) {
      const victim = Array.from(container.children).find(
        (el) => el !== toast && !el.classList.contains('toast-error') && !el.classList.contains('toast-with-actions')
      ) || container.firstElementChild;
      removeToast(victim, true);
    }
    requestAnimationFrame(() => toast.classList.add('toast-in'));
    return toast;
  }

  function sanitizeToastText(text) {
    const raw = String(text ?? '');
    if (!privacyMode) return raw;
    let out = raw.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m));
    for (const acc of currentAccounts) {
      const disp = acc.displayName && String(acc.displayName).trim();
      if (disp && disp.length >= 2 && out.includes(disp)) {
        out = out.split(disp).join(maskName(disp));
      }
      const nick = acc.nickname && String(acc.nickname).trim();
      if (nick && nick.length >= 2 && out.includes(nick)) {
        out = out.split(nick).join(maskName(nick));
      }
      const emailStr = acc.email && String(acc.email).trim();
      if (emailStr && emailStr.length >= 4 && out.includes(emailStr)) {
        out = out.split(emailStr).join(maskName(emailStr));
      }
      if (acc.uid && String(acc.uid).length >= 6 && out.includes(acc.uid)) {
        out = out.split(acc.uid).join(maskUid(acc.uid));
      }
    }
    return out;
  }

  function showToast(msg, type = 'success', ttl = 2200, key = '', detail = '') {
    const toast = createToast(sanitizeToastText(msg), type, key, detail);
    if (toast && ttl > 0) {
      if (toast._hideTimer) clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => removeToast(toast), ttl);
    }
  }

  function showConfirm(message, title = t('ui.confirmTitle'), okText = t('common.ok'), isDanger = false) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('confirmOverlay');
      const titleEl = document.getElementById('confirmTitle');
      const msgEl = document.getElementById('confirmMsg');
      const okBtn = document.getElementById('confirmOk');
      const cancelBtn = document.getElementById('confirmCancel');
      const closeBtn = document.getElementById('confirmClose');
      if (!overlay) { resolve(false); return; }

      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      if (okBtn) {
        okBtn.textContent = okText;
        okBtn.style.background = isDanger ? 'var(--gh-red, #ef4444)' : 'var(--ac-blue, #3b82f6)';
      }

      const cleanup = (result) => {
        okBtn?.removeEventListener('click', onOk);
        cancelBtn?.removeEventListener('click', onCancel);
        closeBtn?.removeEventListener('click', onCancel);
        overlay.removeEventListener('click', onBackdrop);
        overlay._cancelConfirm = null;
        closeModal(overlay);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };

      overlay._cancelConfirm = () => cleanup(false);
      okBtn?.addEventListener('click', onOk);
      cancelBtn?.addEventListener('click', onCancel);
      closeBtn?.addEventListener('click', onCancel);
      overlay.addEventListener('click', onBackdrop);
      openModal(overlay, cancelBtn);
    });
  }

  // ── [5] Settings, Add Account, Export, Restart & Edit Meta ────────────────
  function readClampedInt(el, fallback, min, max) {
    const parsed = Number.parseInt(el && el.value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function populateSettingsForm(cfg) {
    if (!cfg) cfg = {};
    setCheckinEnabled.checked = cfg.autoCheckin !== false;
    setDailyTime.value = cfg.dailyTime || '00:10';
    setRandomJitter.value = cfg.randomJitterMinutes != null ? cfg.randomJitterMinutes : 30;
    setPerAccountDelay.value = cfg.perAccountDelaySeconds != null ? cfg.perAccountDelaySeconds : 15;
    setRefreshInterval.value = cfg.refreshIntervalMinutes != null ? cfg.refreshIntervalMinutes : 15;
    setGrowthAfterCheckin.checked = cfg.growthTasksAutoAfterCheckin !== false;
    setStartupMakeup.checked = cfg.startupMakeup !== false;
    setAutoUseMakeupCard.checked = cfg.autoUseMakeupCard !== false;

    setAutoSwitchEnabled.checked = cfg.autoSwitchEnabled !== false;
    setQuotaThreshold.value = cfg.quotaThresholdPercent != null ? cfg.quotaThresholdPercent : 10;
    setAutoSwitchStrategy.value = cfg.autoSwitchStrategy || 'highest_quota';
    setCooldownMinutes.value = cfg.cooldownMinutes != null ? cfg.cooldownMinutes : 5;
    setAutoSwitchOn429.checked = cfg.autoSwitchOn429 !== false;
    setAutoSwitchNotify.checked = cfg.autoSwitchNotify !== false;

    setPrivacyModeDefault.checked = cfg.privacyModeDefault === true;
    setUpdateAutoCheck.checked = cfg.updateAutoCheck !== false;
    setUpdateAutoInstall.checked = cfg.updateAutoInstall !== false;
    setLocale.value = cfg.locale || 'auto';
  }

  function openSettingsModal() {
    if (!settingsModalOverlay) return;
    document.documentElement.classList.add('settings-modal-open');
    document.body.classList.add('settings-modal-open');
    populateSettingsForm(currentSettings);
    openModal(settingsModalOverlay, settingsModalClose);
  }

  function closeSettingsModal() {
    document.documentElement.classList.remove('settings-modal-open');
    document.body.classList.remove('settings-modal-open');
    closeModal(settingsModalOverlay);
  }

  btnSettings.addEventListener('click', openSettingsModal);
  settingsModalClose.addEventListener('click', closeSettingsModal);
  btnSettingsCancel.addEventListener('click', closeSettingsModal);
  settingsModalOverlay.addEventListener('click', (e) => { if (e.target === settingsModalOverlay) closeSettingsModal(); });

  btnSettingsReset.addEventListener('click', () => {
    populateSettingsForm({
      autoCheckin: true,
      dailyTime: '00:10',
      randomJitterMinutes: 30,
      perAccountDelaySeconds: 15,
      refreshIntervalMinutes: 15,
      growthTasksAutoAfterCheckin: true,
      startupMakeup: true,
      autoUseMakeupCard: true,
      autoSwitchEnabled: true,
      quotaThresholdPercent: 10,
      autoSwitchStrategy: 'highest_quota',
      cooldownMinutes: 5,
      autoSwitchOn429: true,
      autoSwitchNotify: true,
      privacyModeDefault: false,
      updateAutoCheck: true,
      updateAutoInstall: true,
      locale: 'auto'
    });
  });

  btnSettingsSave.addEventListener('click', () => {
    const timeText = setDailyTime.value.trim() || '00:10';
    const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeText);
    if (!timeMatch) {
      showToast(t('js.invalidDailyTime'), 'error', 10000);
      setDailyTime.focus();
      return;
    }
    const s = {
      autoCheckin: setCheckinEnabled.checked,
      dailyTime: timeMatch[1].padStart(2, '0') + ':' + timeMatch[2],
      randomJitterMinutes: readClampedInt(setRandomJitter, 30, 0, 180),
      perAccountDelaySeconds: readClampedInt(setPerAccountDelay, 15, 1, 60),
      refreshIntervalMinutes: readClampedInt(setRefreshInterval, 15, 5, 120),
      growthTasksAutoAfterCheckin: setGrowthAfterCheckin.checked,
      startupMakeup: setStartupMakeup.checked,
      autoUseMakeupCard: setAutoUseMakeupCard.checked,
      autoSwitchEnabled: setAutoSwitchEnabled.checked,
      quotaThresholdPercent: readClampedInt(setQuotaThreshold, 10, 0, 90),
      autoSwitchStrategy: setAutoSwitchStrategy.value || 'highest_quota',
      cooldownMinutes: readClampedInt(setCooldownMinutes, 5, 1, 60),
      autoSwitchOn429: setAutoSwitchOn429.checked,
      autoSwitchNotify: setAutoSwitchNotify.checked,
      privacyModeDefault: setPrivacyModeDefault.checked,
      updateAutoCheck: setUpdateAutoCheck.checked,
      updateAutoInstall: setUpdateAutoInstall.checked,
      locale: setLocale.value || 'auto'
    };
    currentSettings = s;
    vscode.postMessage({ command: 'saveSettings', settings: s });
    closeSettingsModal();
  });

  function switchAddTab(tab) {
    document.querySelectorAll('.add-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('addTabOauth').hidden = tab !== 'oauth';
    document.getElementById('addTabCockpit').hidden = tab !== 'cockpit';
    document.getElementById('addTabLocal').hidden = tab !== 'local';
    document.getElementById('addTabJson').hidden = tab !== 'json';
  }

  function openAddModal() {
    switchAddTab('oauth');
    openModal(addAccountOverlay, addAccountClose);
  }

  function closeAddModal() {
    closeModal(addAccountOverlay);
  }

  document.querySelectorAll('.add-tab').forEach((b) => b.addEventListener('click', () => switchAddTab(b.dataset.tab)));
  addAccountClose.addEventListener('click', closeAddModal);
  addAccountOverlay.addEventListener('click', (e) => { if (e.target === addAccountOverlay) closeAddModal(); });
  btnAddOAuth.addEventListener('click', openAddModal);
  if (btnEmptyAddAccount) btnEmptyAddAccount.addEventListener('click', openAddModal);

  document.getElementById('btnStartOAuth').addEventListener('click', () => vscode.postMessage({ command: 'addAccountOAuth' }));
  document.getElementById('btnStartCockpitImport').addEventListener('click', () => vscode.postMessage({ command: 'importCockpit' }));
  document.getElementById('btnImportLocal').addEventListener('click', () => vscode.postMessage({ command: 'importLocal' }));
  document.getElementById('btnImportJson').addEventListener('click', () => {
    vscode.postMessage({ command: 'importJson', text: document.getElementById('importJsonText').value });
  });
  if (btnImportAccountsFile) {
    btnImportAccountsFile.addEventListener('click', () => {
      vscode.postMessage({ command: 'importAccountsFile' });
      closeAddModal();
    });
  }

  if (btnManualCheckUpdate) {
    btnManualCheckUpdate.addEventListener('click', () => {
      btnManualCheckUpdate.disabled = true;
      btnManualCheckUpdate.textContent = t('js.checkingLabel');
      vscode.postMessage({ command: 'checkUpdate' });
      setTimeout(() => {
        if (btnManualCheckUpdate) {
          btnManualCheckUpdate.disabled = false;
          btnManualCheckUpdate.textContent = t('ui.checkUpdateBtn');
        }
      }, 3000);
    });
  }

  function stopRefreshAllSpin() {
    if (_refreshAllFallback) { clearTimeout(_refreshAllFallback); _refreshAllFallback = 0; }
    if (refreshAllBtn) {
      refreshAllBtn.classList.remove('is-spinning');
      refreshAllBtn.disabled = false;
    }
  }
  btnBatchCheckin.addEventListener('click', () => vscode.postMessage({ command: 'batchCheckin' }));
  refreshAllBtn.addEventListener('click', () => {
    if (refreshAllBtn.disabled) return;
    refreshAllBtn.classList.add('is-spinning');
    refreshAllBtn.disabled = true;
    if (_refreshAllFallback) clearTimeout(_refreshAllFallback);
    _refreshAllFallback = setTimeout(stopRefreshAllSpin, 30000);
    vscode.postMessage({ command: 'refreshStatus' });
  });

  if (btnDoctor) {
    btnDoctor.addEventListener('click', () => {
      if (btnDoctor.disabled) return;
      btnDoctor.disabled = true;
      setTimeout(() => { btnDoctor.disabled = false; }, 1200);
      vscode.postMessage({ command: 'runDoctor' });
    });
  }

  if (btnExportPool) btnExportPool.addEventListener('click', () => openModal(exportModalOverlay, btnExportFull));
  if (exportModalClose) exportModalClose.addEventListener('click', () => closeModal(exportModalOverlay));
  if (exportModalOverlay) exportModalOverlay.addEventListener('click', (e) => { if (e.target === exportModalOverlay) closeModal(exportModalOverlay); });
  if (btnExportFull) btnExportFull.addEventListener('click', () => { closeModal(exportModalOverlay); vscode.postMessage({ command: 'exportAccounts', mode: 'full' }); });
  if (btnExportMasked) btnExportMasked.addEventListener('click', () => { closeModal(exportModalOverlay); vscode.postMessage({ command: 'exportAccounts', mode: 'masked' }); });

  const hideRestartModal = () => closeModal(restartModalOverlay);
  if (restartNowBtn) {
    restartNowBtn.addEventListener('click', () => {
      restartNowBtn.disabled = true;
      restartNowBtn.textContent = t('ui.restarting');
      vscode.postMessage({ command: 'restartApp' });
      setTimeout(() => {
        if (restartModalOverlay && !restartModalOverlay.hidden) {
          restartNowBtn.disabled = false;
          restartNowBtn.textContent = t('ui.restartNow');
        }
      }, 8000);
    });
  }
  if (restartLaterBtn) restartLaterBtn.addEventListener('click', hideRestartModal);
  if (restartModalClose) restartModalClose.addEventListener('click', hideRestartModal);
  if (restartModalOverlay) restartModalOverlay.addEventListener('click', (e) => { if (e.target === restartModalOverlay) hideRestartModal(); });

  function submitEditMeta() {
    if (!editingMetaAccountId) return;
    const displayName = editMetaDisplayName ? editMetaDisplayName.value.trim() : '';
    const notes = editMetaNotes.value.trim();
    const tags = editMetaTags.value.trim().split(/\s+/).filter(Boolean);
    vscode.postMessage({ command: 'updateAccountMeta', accountId: editingMetaAccountId, displayName, notes, tags });
    closeModal(editMetaModalOverlay);
  }

  window.onEditMeta = function (id) {
    editingMetaAccountId = id;
    const acc = currentAccounts.find((a) => a.id === id);
    if (!acc) return;
    const originName = getAccountOriginName(acc);
    editMetaAccountName.textContent = privacyMode ? maskName(originName) : originName;
    if (editMetaDisplayName) editMetaDisplayName.value = acc.displayName || '';
    editMetaTags.value = Array.isArray(acc.tags) ? acc.tags.join(' ') : '';
    editMetaNotes.value = acc.notes || '';
    openModal(editMetaModalOverlay, editMetaDisplayName || editMetaTags);
  };
  if (editMetaClose) editMetaClose.addEventListener('click', () => closeModal(editMetaModalOverlay));
  if (editMetaCancel) editMetaCancel.addEventListener('click', () => closeModal(editMetaModalOverlay));
  if (editMetaModalOverlay) editMetaModalOverlay.addEventListener('click', (e) => { if (e.target === editMetaModalOverlay) closeModal(editMetaModalOverlay); });
  if (editMetaSave) editMetaSave.addEventListener('click', submitEditMeta);
  if (editMetaDisplayName) {
    editMetaDisplayName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitEditMeta(); }
    });
  }
  if (editMetaTags) {
    editMetaTags.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitEditMeta(); }
    });
  }

  // ── [6] Privacy Mode ──────────────────────────────────────────────────────
  function updatePrivacyUi() {
    if (!privacyModeBtn) return;
    privacyModeBtn.classList.toggle('is-privacy', privacyMode);
    const titleText = privacyMode ? t('ui.privacyTitleOn') : t('ui.privacyTitleOff');
    privacyModeBtn.title = titleText;
    privacyModeBtn.setAttribute('aria-label', titleText);
    const eye = privacyModeBtn.querySelector('.privacy-eye');
    const eyeOff = privacyModeBtn.querySelector('.privacy-eye-off');
    if (eye) { if (privacyMode) eye.setAttribute('hidden', ''); else eye.removeAttribute('hidden'); }
    if (eyeOff) { if (privacyMode) eyeOff.removeAttribute('hidden'); else eyeOff.setAttribute('hidden', ''); }
    if (editingMetaAccountId && editMetaModalOverlay && !editMetaModalOverlay.hidden) {
      const acc = currentAccounts.find((a) => a.id === editingMetaAccountId);
      if (acc) editMetaAccountName.textContent = maskName(getAccountOriginName(acc));
    }
    if (lastUsageRecords.length) safeRender('usage', document.getElementById('usageRecordsList'), () => renderUsageRecords(lastUsageRecords, lastUsageSummary));
  }

  privacyModeBtn.addEventListener('click', () => {
    privacyMode = !privacyMode;
    const st = vscode.getState() || {};
    st.privacyMode = privacyMode;
    vscode.setState(st);
    updatePrivacyUi();
    renderCards();
    renderAcctChips();
    vscode.postMessage({ command: 'togglePrivacyMode', enabled: privacyMode });
  });
  updatePrivacyUi();

  // ── [7] Search, Sort, Tags & Filter ───────────────────────────────────────
  if (sortSelect) {
    sortSelect.value = sortBy;
    sortSelect.addEventListener('change', () => {
      sortBy = sortSelect.value || 'default';
      const st = vscode.getState() || {};
      st.sortBy = sortBy;
      vscode.setState(st);
      renderCards();
    });
  }

  function clearSearchInput() {
    searchInput.value = '';
    searchQuery = '';
    searchClear.hidden = true;
    renderCards();
  }
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    searchClear.hidden = !searchQuery;
    renderCards();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      clearSearchInput();
    }
  });
  searchClear.addEventListener('click', clearSearchInput);

  const SYSTEM_TAG_DEFS = [
    { key: 'all', label: t('js.tagAll') },
    { key: 'checked', label: t('js.tagChecked') },
    { key: 'unchecked', label: t('js.tagUnchecked') },
    { key: 'low', label: t('js.tagLow') }
  ];

  function getEffectiveTagDefs() {
    const defs = [...SYSTEM_TAG_DEFS];
    const customSet = new Set();
    currentAccounts.forEach((a) => {
      if (Array.isArray(a.tags)) {
        a.tags.forEach((tag) => { const clean = String(tag).trim(); if (clean) customSet.add(clean); });
      }
    });
    Array.from(customSet).sort().forEach((tag) => defs.push({ key: 'custom:' + tag, label: tag, isCustom: true }));
    return defs;
  }

  function getTagCounts() {
    const total = currentAccounts.length;
    const checked = currentAccounts.filter((a) => a.todayCheckedIn).length;
    const low = currentAccounts.filter((a) => isLowQuotaAccount(a)).length;
    const counts = { all: total, checked, unchecked: total - checked, low };
    const customSet = new Set();
    currentAccounts.forEach((a) => {
      if (Array.isArray(a.tags)) {
        a.tags.forEach((tag) => { const clean = String(tag).trim(); if (clean) customSet.add(clean); });
      }
    });
    customSet.forEach((tag) => {
      counts['custom:' + tag] = currentAccounts.filter((a) => Array.isArray(a.tags) && a.tags.includes(tag)).length;
    });
    return counts;
  }

  function applyActiveTag(tagKey) {
    activeTag = tagKey;
    const st = vscode.getState() || {};
    st.activeTag = activeTag;
    vscode.setState(st);
    renderTagBar();
    renderCards();
  }

  function renderTagBar() {
    const counts = getTagCounts();
    const defs = getEffectiveTagDefs();
    tagList.innerHTML = defs.map((def) => {
      const cls = 'tag-chip' + (activeTag === def.key ? ' is-active' : '') + (def.isCustom ? ' is-custom' : '');
      return '<button type="button" class="' + cls + '" data-tag="' + escAttr(def.key) + '">' + escHtml(def.label) + '(' + (counts[def.key] || 0) + ')</button>';
    }).join('');
    const def = defs.find((d) => d.key === activeTag) || defs[0];
    filterLabel.textContent = def.key === 'all' ? t('ui.tagAll') : def.label;
    filterCount.textContent = '(' + (counts[activeTag] || 0) + ')';
    if (filterDropdown && !filterDropdown.hidden) renderFilterDropdown();
  }

  tagList.addEventListener('click', (e) => {
    const chip = e.target.closest ? e.target.closest('.tag-chip[data-tag]') : null;
    if (!chip) return;
    applyActiveTag(chip.dataset.tag || 'all');
  });

  function renderFilterDropdown() {
    const counts = getTagCounts();
    const defs = getEffectiveTagDefs();
    filterOptions.innerHTML = defs.map((def) => {
      const active = activeTag === def.key;
      const checkMark = active
        ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';
      return '<div class="filter-option' + (active ? ' is-active' : '') + '" role="button" tabindex="0" data-tag="' + escAttr(def.key) + '">'
        + '<span class="filter-option-check">' + checkMark + '</span>'
        + '<span class="filter-option-label">' + escHtml(def.label) + '</span>'
        + '<span class="filter-option-count">' + (counts[def.key] || 0) + '</span>'
        + '</div>';
    }).join('');
  }

  filterOptions.addEventListener('click', (e) => {
    const opt = e.target.closest ? e.target.closest('.filter-option[data-tag]') : null;
    if (!opt) return;
    filterDropdown.hidden = true;
    applyActiveTag(opt.dataset.tag || 'all');
  });

  filterTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (filterDropdown.hidden) { renderFilterDropdown(); filterDropdown.hidden = false; }
    else { filterDropdown.hidden = true; }
  });
  document.addEventListener('click', (e) => {
    if (!filterWrap.contains(e.target)) filterDropdown.hidden = true;
  });

  // ── [8] Summary & Account Cards (Event Delegation, Zero Inline Handlers) ──
  function renderSummary() {
    safeRender('summary', summaryCard, () => {
      const total = currentAccounts.length;
      const checked = currentAccounts.filter((a) => a.todayCheckedIn).length;
      gridCount.textContent = t('ui.accountCount', total);

      const checkinPct = total > 0 ? Math.round((checked / total) * 1000) / 10 : 0;
      summaryDailyPct.textContent = checkinPct + '%';
      summaryDailyBar.style.width = checkinPct + '%';
      summaryDailyNum.textContent = checked;
      summaryDailyMax.textContent = '/ ' + total;

      const activeAccounts = currentAccounts.filter((a) => a.status !== 'disabled');
      const totalRemain = activeAccounts.reduce((s, a) => s + (a.quotaUnlimited ? 0 : Math.max(0, a.totalCredits || 0)), 0);
      const totalCap = activeAccounts.reduce((s, a) => {
        if (a.quotaUnlimited) return s;
        const base = Math.max(0, (a.basePackage && a.basePackage.total) || 0);
        const act = isEntAccount(a) ? 0 : Math.max(0, (a.activityPackage && a.activityPackage.total) || 0);
        return s + base + act;
      }, 0);
      const creditPct = totalCap > 0 ? Math.round((totalRemain / totalCap) * 1000) / 10 : 0;
      summaryWeeklyPct.textContent = t('js.pctRemaining', creditPct);
      summaryWeeklyBar.style.width = Math.min(100, creditPct) + '%';
      summaryWeeklyBar.className = 'summary-bar-fill ' + levelClass(creditPct, totalRemain);
      summaryWeeklyNum.textContent = fmtNum(Math.round(totalRemain));
      summaryWeeklyMax.textContent = '/ ' + fmtNum(totalCap);
    });
  }

  function renderTokenSummaryBar() {
    const today = lastTokenLedger && lastTokenLedger.totals && lastTokenLedger.totals.today;
    const last30d = lastTokenLedger && lastTokenLedger.totals && lastTokenLedger.totals.last30d;
    if (todayTokensBadge) todayTokensBadge.textContent = fmtCompactTok(today ? today.total : 0);
    if (todayCostBadge) todayCostBadge.textContent = fmtUsd(today ? today.costUsd : 0);
    if (tokenStatsBar) {
      tokenStatsBar.title = today
        ? t('ui.tokenStatsTitle') + ' (' + t('js.cardTokensToday', fmtCompactTok(today.total), fmtUsd(today.costUsd)) + ' · ' + t('ui.range30d') + ' ' + fmtCompactTok(last30d ? last30d.total : 0) + ' / ' + fmtUsd(last30d ? last30d.costUsd : 0) + ')'
        : t('ui.tokenStatsTitle');
    }
  }

  function sortAccountList(list) {
    if (sortBy === 'quota') {
      return [...list].sort((a, b) =>
        (b.quotaUnlimited ? Number.MAX_SAFE_INTEGER : (b.totalCredits || 0))
        - (a.quotaUnlimited ? Number.MAX_SAFE_INTEGER : (a.totalCredits || 0)));
    }
    if (sortBy === 'recent') {
      return [...list].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
    }
    if (sortBy === 'name') {
      return [...list].sort((a, b) => String(getAccountRawName(a)).localeCompare(String(getAccountRawName(b))));
    }
    return list;
  }

  function renderCards() {
    safeRender('cards', accountGrid, () => {
      renderTagBar();

      let list = currentAccounts;
      if (searchQuery) {
        list = list.filter((a) =>
          (a.displayName || '').toLowerCase().includes(searchQuery) ||
          (a.nickname || '').toLowerCase().includes(searchQuery) ||
          (a.email || '').toLowerCase().includes(searchQuery) ||
          (a.enterpriseName || '').toLowerCase().includes(searchQuery) ||
          (a.uid || '').toLowerCase().includes(searchQuery) ||
          (a.notes || '').toLowerCase().includes(searchQuery) ||
          (Array.isArray(a.tags) && a.tags.some((tag) => String(tag).toLowerCase().includes(searchQuery))));
      }
      if (activeTag === 'checked') list = list.filter((a) => a.todayCheckedIn);
      else if (activeTag === 'unchecked') list = list.filter((a) => !a.todayCheckedIn);
      else if (activeTag === 'low') list = list.filter((a) => isLowQuotaAccount(a));
      else if (activeTag.startsWith('custom:')) {
        const tag = activeTag.slice(7);
        list = list.filter((a) => Array.isArray(a.tags) && a.tags.includes(tag));
      }

      list = sortAccountList(list);

      if (!currentAccounts || currentAccounts.length === 0) {
        lastCardsFingerprint = '';
        accountGrid.innerHTML = '';
        emptyState.hidden = false;
        return;
      }
      emptyState.hidden = true;

      if (list.length === 0) {
        const emptyFp = 'empty#' + activeTag + '#' + searchQuery + '#' + sortBy;
        if (emptyFp === lastCardsFingerprint && accountGrid.children.length) return;
        lastCardsFingerprint = emptyFp;
        accountGrid.innerHTML = '<div class="empty-state"><div>' + escHtml(t('js.noMatchAccounts')) + '</div>'
          + '<button type="button" class="empty-reset-btn" id="btnResetFilter">' + escHtml(t('js.clearFilterBtn')) + '</button></div>';
        return;
      }

      const cardsFp = [
        privacyMode ? '1' : '0', activeTag, searchQuery, sortBy,
        switchingId, switchingId ? switchElapsed : 0, checkingId,
        Array.from(refreshingIds).sort().join(','),
        (currentLockedUids || []).join(','),
        JSON.stringify(lastCooldownEvents ? lastCooldownEvents.byUid || {} : {}),
        list.map((a) => [
          a.id, a.uid, a.displayName || '', a.nickname, a.email, a.status, a.isActive ? 1 : 0,
          a.paymentType || '', a.enterpriseId || '', a.enterpriseName || '', a.quotaUnlimited ? 1 : 0, a.quotaResetAt || 0,
          a.totalCredits, a.todayConsumed, a.todayGrants, a.todayCheckedIn ? 1 : 0,
          a.checkinStreak, a.notes || '', (a.tags || []).join('|'),
          a.tokenStats ? [a.tokenStats.todayTokens, a.tokenStats.todayCostUsd, a.tokenStats.totalTokens, a.tokenStats.totalCalls].join('/') : '',
          a.basePackage ? a.basePackage.remain + '/' + a.basePackage.total : '',
          a.activityPackage ? a.activityPackage.remain + '/' + a.activityPackage.total : ''
        ].join(':')).join(';')
      ].join('#');
      if (cardsFp === lastCardsFingerprint && accountGrid.children.length) return;
      lastCardsFingerprint = cardsFp;

      const prevGridScroll = accountGrid.scrollTop;
      const prevDocScroll = window.scrollY || 0;
      const cardTokSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="0.5"/><rect x="12" y="8" width="3" height="10" rx="0.5"/><rect x="17" y="5" width="3" height="13" rx="0.5"/></svg>';

      accountGrid.innerHTML = list.map((acc) => {
        const isActive = acc.isActive;
        const safeId = escAttr(acc.id);
        const rawName = getAccountRawName(acc);
        const displayName = maskName(rawName);
        const originRaw = getAccountOriginName(acc);
        const customTrimmed = acc.displayName ? String(acc.displayName).trim() : '';
        const hasCustomName = Boolean(customTrimmed && originRaw && customTrimmed !== originRaw);
        const titleTip = hasCustomName ? (displayName + ' (' + maskName(originRaw) + ')') : displayName;
        const displayUid = maskUid(acc.uid);
        const planText = String(acc.paymentType || 'free').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const planLabel = planText === 'ultimate'
          ? t('js.planUltimate')
          : (planText === 'exclusive'
            ? t('js.planExclusive')
            : (planText === 'enterprise'
              ? t('js.planEnterprise')
              : (planText ? planText.charAt(0).toUpperCase() + planText.slice(1) : 'Free')));
        const planTier = 'tier-' + (['free', 'trial', 'pro', 'team', 'enterprise', 'ultimate', 'exclusive'].indexOf(planText) >= 0 ? planText : 'unknown');
        const isEntAcc = isEntAccount(acc);
        const isUnlimited = Boolean(acc.quotaUnlimited);
        const rawEntName = acc.enterpriseName ? String(acc.enterpriseName).trim() : '';
        const displayEntName = rawEntName ? maskName(rawEntName) : '';
        const entChipHtml = (isEntAcc && displayEntName)
          ? '<span class="grid-enterprise-chip" title="' + escAttr(displayEntName) + '">' + escHtml(displayEntName) + '</span>'
          : '';

        const totalVal = isUnlimited ? escHtml(t('js.unlimitedQuota')) : fmtNum(acc.totalCredits);
        const totalUnitHtml = isUnlimited ? '' : ('<span class="grid-quota-unit">' + escHtml(t('js.unitPoint')) + '</span>');
        const base = acc.basePackage || { title: t('pkg.base'), count: 1, remain: 0, total: 500, percent: 0 };
        const baseLevel = levelClass(base.percent, base.remain);
        const act = acc.activityPackage || { title: t('pkg.activity'), count: 30, remain: acc.totalCredits || 0, total: 3000, percent: 50 };
        const actLevel = levelClass(act.percent, act.remain);
        const todayStatsHtml = `<span class="grid-today-stats" data-field="todayStats" title="${escAttr(t('js.todayStatsTitle'))}">${escHtml(t('js.todayConsumed'))}&nbsp;<span class="today-val is-consumed">${fmtNum(acc.todayConsumed || 0)}</span><span class="today-sep">·</span>${escHtml(t('js.todayGained'))}&nbsp;<span class="today-val is-gained">+${fmtNum(acc.todayGrants || 0)}</span></span>`;

        const isDisabled = acc.status === 'disabled';
        const isLockedElsewhere = !isActive && Array.isArray(currentLockedUids) && currentLockedUids.includes(acc.uid);
        let healthBadge = '';
        if (isLockedElsewhere) {
          healthBadge = '<span class="grid-health-badge grid-health-warn" title="' + escAttr(t('js.lockedElsewhereTitle')) + '">' + escHtml(t('js.lockedElsewhere')) + '</span>';
        } else if (acc.status === 'rate_limited') {
          healthBadge = '<span class="grid-health-badge grid-health-warn">' + escHtml(t('js.cooling429')) + '</span>';
        } else if (acc.status === 'expired') {
          healthBadge = '<span class="grid-health-badge grid-health-warn">' + escHtml(t('js.expired')) + '</span>';
        } else if (isDisabled) {
          healthBadge = '<span class="grid-disabled-tag">' + escHtml(t('js.disabled')) + '</span>';
        }

        const tagsHtml = (acc.tags && acc.tags.length > 0)
          ? '<div class="grid-card-tags">' + acc.tags.map((tag) => '<span class="grid-card-tag" data-action="filterTag" data-tag="' + escAttr(tag) + '">' + escHtml(tag) + '</span>').join('') + '</div>'
          : '';

        const cleanNotes = (acc.notes && !acc.notes.includes('额度见底标记') && !acc.notes.includes('探针预检失败'))
          ? acc.notes.trim()
          : '';
        const notesHtml = cleanNotes
          ? '<div class="grid-card-notes" data-action="editMeta" data-id="' + safeId + '" title="' + escAttr(t('js.notesEditTitle')) + '">' + escHtml(cleanNotes) + '</div>'
          : '';

        const isSwitchingThis = switchingId === acc.id;
        const switchBtnLabel = isSwitchingThis
          ? '<span class="btn-mini-spinner"></span>' + escHtml(switchElapsed >= 1 ? t('js.switchingElapsed', switchElapsed) : t('js.switching'))
          : escHtml(t('js.switchBtn'));
        const leftAction = acc.status === 'expired'
          ? '<button type="button" class="grid-switch-btn is-reauth" data-action="reauth" data-id="' + safeId + '" title="' + escAttr(t('js.reauthTitle')) + '">' + escHtml(t('js.reauthBtn')) + '</button>'
          : (isActive
            ? '<span class="grid-current-label"><span class="grid-current-dot">●</span> ' + escHtml(t('js.inUse')) + '</span>'
            : '<button type="button" class="grid-switch-btn" data-action="switch" data-id="' + safeId + '" ' + (isSwitchingThis || isDisabled ? 'disabled' : '') + ' title="' + escAttr(isDisabled ? t('js.switchDisabledTitle') : t('js.switchTitle')) + '">' + switchBtnLabel + '</button>');

        const isCheckingThis = checkingId === acc.id;
        const checkinDisabled = isEntAcc || acc.todayCheckedIn || isDisabled || isCheckingThis;
        const checkinTitle = isEntAcc
          ? t('ci.skipEnterprise')
          : (acc.todayCheckedIn ? t('js.checkinDoneTitle') : (isDisabled ? t('js.checkinDisabledTitle') : t('js.checkinDoTitle')));
        const checkinBtn = '<button type="button" class="status-toggle-btn ' + (acc.todayCheckedIn ? 'is-enabled is-done' : 'is-disabled is-pending') + '" data-action="checkin" data-id="' + safeId + '" ' + (checkinDisabled ? 'disabled' : '') + ' title="' + escAttr(checkinTitle) + '">' + (isCheckingThis ? '<span class="btn-mini-spinner"></span>' : '') + escHtml(acc.todayCheckedIn ? t('js.checkedInShort') : t('js.checkinBtn')) + '</button>';
        const isRefreshingThis = refreshingIds.has(acc.id);
        const statusToggleBtn = '<button type="button" class="status-switch ' + (isDisabled ? 'is-off' : 'is-on') + '" data-action="toggleStatus" data-id="' + safeId + '" title="' + escAttr(isDisabled ? t('js.enableTitle') : t('js.disableTitle')) + '" aria-label="' + escAttr(isDisabled ? t('js.ariaEnable') : t('js.ariaDisable')) + '"><span class="status-switch-thumb"></span></button>';

        const cdNameMap = (lastCooldownEvents && lastCooldownEvents.modelNames) || {};
        const cdEvents = (lastCooldownEvents && lastCooldownEvents.byUid) ? lastCooldownEvents.byUid[acc.uid] : null;
        const cdRows = cdEvents
          ? Object.keys(cdEvents).filter((m) => cdEvents[m] && cdEvents[m].resetAt > Date.now()).map((m) => {
            const ev = cdEvents[m];
            const label = cdNameMap[m] || m;
            const detail = t('cooldown.detail', fmtCooldownTime(ev.hitAt), fmtCooldownTime(ev.resetAt));
            return '<div class="grid-cooldown-row" title="' + escAttr(label + '  ' + detail) + '">'
              + '<span class="grid-cooldown-model">' + escHtml(label) + '</span>'
              + '<span class="grid-cooldown-time">' + escHtml(t('cooldown.until', fmtCooldownTime(ev.resetAt))) + '</span></div>';
          })
          : [];
        const cooldownHtml = '<div class="grid-cooldown-block">' + (cdRows.length > 0 ? cdRows.join('') : '<span class="grid-cooldown-empty">' + escHtml(t('cooldown.normal')) + '</span>') + '</div>';

        const basePct = Math.max(0, Math.min(100, Number(base.percent || 0)));
        const actPct = Math.max(0, Math.min(100, Number(act.percent || 0)));
        let quotaBarsHtml = '';
        if (isEntAcc) {
          const entTitle = (acc.basePackage && acc.basePackage.title) ? acc.basePackage.title : t('pkg.enterpriseQuota');
          const entRemain = Math.max(0, Number(base.remain || 0));
          const entTotal = Math.max(0, Number(base.total || 0));
          const entPct = isUnlimited ? 100 : basePct;
          const entLevel = isUnlimited ? 'is-ok' : baseLevel;
          const entRightVal = isUnlimited ? escHtml(t('js.unlimitedQuota')) : (fmtNum(entRemain) + ' / ' + fmtNum(entTotal));
          const entUsedCredits = isUnlimited ? entRemain : Math.max(0, entTotal - entRemain);
          const entUsedText = (isUnlimited || entTotal > 0) ? escHtml(t('js.enterpriseUsed', fmtNum(entUsedCredits))) : '';
          const resetDateStr = fmtDateCN(acc.quotaResetAt);
          const entResetText = resetDateStr ? escHtml(t('js.enterpriseResetAt', resetDateStr)) : '';
          const subhintHtml = (entUsedText || entResetText)
            ? '<div class="grid-quota-subhint"><span>' + entUsedText + '</span><span>' + entResetText + '</span></div>'
            : '';
          quotaBarsHtml = `
              <div class="grid-quota-item">
                <div class="grid-quota-head">
                  <span>${escHtml(entTitle)}</span>
                  <span class="grid-quota-val ${entLevel}" data-field="base">${entRightVal}</span>
                </div>
                <div class="quota-bar"><div class="quota-bar-fill ${entLevel}" data-field="baseBar" style="width:${entPct}%"></div></div>
                ${subhintHtml}
              </div>`;
        } else {
          quotaBarsHtml = `
              <div class="grid-quota-item">
                <div class="grid-quota-head">
                  <span>${escHtml(base.title)}</span>
                  <span class="grid-quota-val ${baseLevel}" data-field="base">${fmtNum(base.remain)} / ${fmtNum(base.total)}</span>
                </div>
                <div class="quota-bar"><div class="quota-bar-fill ${baseLevel}" data-field="baseBar" style="width:${basePct}%"></div></div>
              </div>
              <div class="grid-quota-item">
                <div class="grid-quota-head">
                  <span>${escHtml(act.title)}</span>
                  <span class="grid-quota-val ${actLevel}" data-field="act">${fmtNum(act.remain)} / ${fmtNum(act.total)}</span>
                </div>
                <div class="quota-bar"><div class="quota-bar-fill ${actLevel}" data-field="actBar" style="width:${actPct}%"></div></div>
              </div>`;
        }
        const ts = acc.tokenStats;
        let tokenBarHtml = '';
        if (ts && ts.todayTokens > 0) {
          tokenBarHtml = '<button type="button" class="grid-card-tokens" data-action="openAccountTokens" data-uid="' + escAttr(acc.uid) + '" title="' + escAttr(t('js.cardTokensHint')) + '">'
            + '<span class="grid-card-tokens-main">' + cardTokSvg + '<span>' + escHtml(t('js.cardTokensToday', fmtCompactTok(ts.todayTokens), fmtUsd(ts.todayCostUsd))) + '</span></span>'
            + '<span class="grid-card-tokens-sub">' + escHtml(t('js.cardTokensTotal', fmtCompactTok(ts.totalTokens))) + '</span>'
            + '</button>';
        } else if (ts && ts.totalTokens > 0) {
          tokenBarHtml = '<button type="button" class="grid-card-tokens" data-action="openAccountTokens" data-uid="' + escAttr(acc.uid) + '" title="' + escAttr(t('js.cardTokensHint')) + '">'
            + '<span class="grid-card-tokens-main">' + cardTokSvg + '<span>' + escHtml(t('js.cardTokensTotalOnly', fmtCompactTok(ts.totalTokens), fmtUsd(ts.totalCostUsd))) + '</span></span>'
            + '<span class="grid-card-tokens-sub">' + escHtml(t('ui.tokenCallsFmt', fmtNum(ts.totalCalls))) + '</span>'
            + '</button>';
        } else if (isActive) {
          tokenBarHtml = '<button type="button" class="grid-card-tokens is-pending" data-action="openAccountTokens" data-uid="' + escAttr(acc.uid) + '" title="' + escAttr(t('js.cardTokensHint')) + '">'
            + '<span class="grid-card-tokens-main">' + cardTokSvg + '<span>' + escHtml(t('js.cardTokensPending')) + '</span></span>'
            + '</button>';
        }
        return `
          <div class="grid-card ${isActive ? 'is-active' : ''} ${isDisabled ? 'is-disabled' : ''}" data-id="${safeId}">
            <div class="grid-card-head">
              <div class="grid-card-email" title="${escAttr(titleTip)}">${escHtml(displayName)}</div>
              ${isActive ? '<span class="grid-active-tag">' + escHtml(t('js.currentSuffix').trim()) + '</span>' : (isDisabled ? '<span class="grid-disabled-tag">' + escHtml(t('js.disabled')) + '</span>' : '')}
            </div>
            <div class="grid-card-meta">
              <span class="grid-plan-chip ${planTier}">${escHtml(planLabel)}</span>
              ${entChipHtml}
              ${healthBadge}
              ${tagsHtml}
            </div>
            ${notesHtml}
            ${cooldownHtml}
            <div class="grid-card-quotas">
              <div class="grid-quota-item" style="margin-bottom: 2px;">
                <div class="grid-quota-head" style="align-items: center;">
                  <span style="font-weight: 500;">${escHtml(t('js.totalCredits'))}</span>
                  <span class="grid-quota-val is-neutral" data-field="total">${totalVal}${totalUnitHtml}</span>
                </div>
              </div>
              ${quotaBarsHtml}
            </div>
            <div class="grid-card-extra">
              <div class="grid-extra-row"><span>${escHtml(t('js.streakLabel'))}</span><span class="grid-extra-val" data-field="streak">${escHtml(t('js.streakDaysUnit', acc.checkinStreak || 0))}</span></div>
              <div class="grid-extra-row"><span class="grid-extra-val" data-field="uid" title="${escAttr(t('js.copyUidTitle'))}">${escHtml(displayUid)}</span>${todayStatsHtml}</div>
            </div>
            ${tokenBarHtml}
            <div class="grid-card-actions">
              ${leftAction}
              <div class="grid-actions-right">
                ${checkinBtn}
                <button type="button" class="icon-btn" data-action="editMeta" data-id="${safeId}" title="${escAttr(t('js.editMetaBtnTitle'))}" aria-label="${escAttr(t('js.editMetaBtnTitle'))}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button type="button" class="icon-btn ${isRefreshingThis ? 'is-spinning' : ''}" data-action="refresh" data-id="${safeId}" ${isRefreshingThis ? 'disabled' : ''} title="${escAttr(t('js.refreshOneTitle'))}" aria-label="${escAttr(t('js.refreshOneTitle'))}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                </button>
                <button type="button" class="icon-btn is-danger-icon" data-action="delete" data-id="${safeId}" title="${escAttr(t('js.removeTitle'))}" aria-label="${escAttr(t('js.removeTitle'))}">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
                ${statusToggleBtn}
              </div>
            </div>
          </div>`;
      }).join('');

      accountGrid.scrollTop = prevGridScroll;
      if (window.scrollY !== prevDocScroll) window.scrollTo(0, prevDocScroll);
    });
  }

  function clearSwitchPending() {
    switchingId = '';
    switchElapsed = 0;
    if (_switchTimeout) { clearTimeout(_switchTimeout); _switchTimeout = null; }
    if (_switchTicker) { clearInterval(_switchTicker); _switchTicker = null; }
  }

  window.onToggleStatus = function (id) {
    vscode.postMessage({ command: 'toggleAccountStatus', accountId: id });
  };
  window.onSwitch = function (id) {
    clearSwitchPending();
    switchingId = id;
    switchElapsed = 0;
    renderCards();
    vscode.postMessage({ command: 'switchAccount', accountId: id });
    _switchTicker = setInterval(() => {
      if (switchingId !== id) {
        if (_switchTicker) { clearInterval(_switchTicker); _switchTicker = null; }
        return;
      }
      switchElapsed += 1;
      renderCards();
    }, 1000);
    _switchTimeout = setTimeout(() => {
      if (switchingId === id) { clearSwitchPending(); renderCards(); }
    }, 15000);
  };
  window.onCheckin = function (id) {
    if (checkingId === id) return;
    checkingId = id;
    renderCards();
    if (_checkinFallback) clearTimeout(_checkinFallback);
    _checkinFallback = setTimeout(() => {
      if (checkingId === id) { checkingId = ''; renderCards(); }
    }, 15000);
    vscode.postMessage({ command: 'checkinAccount', accountId: id });
  };
  window.onDelete = async function (id) {
    const acc = currentAccounts.find((a) => a.id === id);
    const rawName = acc ? getAccountRawName(acc) : t('js.thisAccount');
    const name = privacyMode ? maskName(rawName) : rawName;
    const ok = await showConfirm(t('js.removeConfirm', name), t('js.removeConfirmTitle'), t('js.removeConfirmBtn'), true);
    if (ok) vscode.postMessage({ command: 'deleteAccount', accountId: id, confirmed: true });
  };
  window.onRefresh = function (id) {
    if (!id || refreshingIds.has(id)) return;
    refreshingIds.add(id);
    renderCards();
    setTimeout(() => { if (refreshingIds.delete(id)) renderCards(); }, 15000);
    vscode.postMessage({ command: 'refreshAccount', accountId: id });
  };
  window.onReauth = function (id) {
    vscode.postMessage({ command: 'reauthAccount', accountId: id });
  };
  window.onFilterByTag = function (tag) {
    applyActiveTag('custom:' + tag);
  };

  if (accountGrid) {
    accountGrid.addEventListener('click', (e) => {
      const resetBtn = e.target.closest ? e.target.closest('#btnResetFilter') : null;
      if (resetBtn) {
        activeTag = 'all';
        const st = vscode.getState() || {};
        st.activeTag = 'all';
        vscode.setState(st);
        searchInput.value = '';
        searchQuery = '';
        searchClear.hidden = true;
        renderTagBar();
        renderCards();
        return;
      }
      const uidEl = e.target.closest ? e.target.closest('[data-field="uid"]') : null;
      if (uidEl) {
        const card = uidEl.closest('.grid-card');
        const id = card ? card.getAttribute('data-id') : '';
        const acc = currentAccounts.find((a) => a.id === id);
        if (acc && acc.uid) {
          vscode.postMessage({ command: 'copyText', text: acc.uid });
          showToast(t('js.uidCopied'), 'success', 1800, 'uid-copy');
        }
        return;
      }
      const actionEl = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id || '';
      if (action === 'filterTag') { e.stopPropagation(); window.onFilterByTag(actionEl.dataset.tag || ''); }
      else if (action === 'editMeta') window.onEditMeta(id);
      else if (action === 'reauth') window.onReauth(id);
      else if (action === 'switch') window.onSwitch(id);
      else if (action === 'checkin') window.onCheckin(id);
      else if (action === 'refresh') window.onRefresh(id);
      else if (action === 'delete') void window.onDelete(id);
      else if (action === 'toggleStatus') window.onToggleStatus(id);
      else if (action === 'openAccountTokens') openTokenModalForAccount(actionEl.dataset.uid || '');
    });
  }

  // ── [9] Growth Tasks Center & Single Task Accept ──────────────────────────
  function isTaskClaimable(task) {
    if (task.locked || task.claimed || task.acceptStatus === 'claimed') return false;
    if (task.target > 0 && task.current >= task.target) return true;
    return task.target <= 0 && task.acceptStatus === 'completed';
  }

  function renderAcctChips() {
    safeRender('taskAcctList', taskAcctList, () => {
      if (!currentAccounts.length) {
        taskAcctList.innerHTML = '<span style="font-size:12px;color:var(--muted);">' + escHtml(t('js.poolEmpty')) + '</span>';
        taskAccountSummary.textContent = t('js.noAvailableAccounts');
        taskSelCount.textContent = '0';
        return;
      }

      const aliveIds = new Set(currentAccounts.map((a) => a.id));
      let pruned = false;
      for (const id of Array.from(selectedAccountIds)) {
        if (!aliveIds.has(id)) { selectedAccountIds.delete(id); pruned = true; }
      }
      if (pruned) persistTaskSelection();

      taskAcctList.innerHTML = currentAccounts.map((acc) => {
        const checked = selectedAccountIds.has(acc.id);
        const rawName = getAccountRawName(acc);
        const name = privacyMode ? maskName(rawName) : rawName;
        const suffix = acc.isActive ? t('js.currentSuffixShort') : '';
        return '<label class="acct-chip ' + (checked ? 'is-selected' : '') + '" title="' + escAttr(name) + '">' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<input type="checkbox" data-acct="' + escAttr(acc.id) + '" ' + (checked ? 'checked' : '') + '>' +
            '<span>' + escHtml(name + suffix) + '</span>' +
          '</div>' +
          '<span style="font-size:11px;color:var(--muted);">' + escHtml(t('js.creditsShort', fmtNum(acc.totalCredits || 0))) + '</span>' +
        '</label>';
      }).join('');

      taskSelCount.textContent = t('js.selectedN', selectedAccountIds.size);
      taskSelAll.checked = currentAccounts.length > 0 && currentAccounts.every((a) => selectedAccountIds.has(a.id));

      if (selectedAccountIds.size === 0) {
        taskAccountSummary.textContent = t('js.selectNoneHint');
        taskFooterHint.textContent = t('js.selectFirstHint');
      } else if (selectedAccountIds.size === currentAccounts.length) {
        taskAccountSummary.textContent = t('js.allAccountsN', currentAccounts.length);
        taskFooterHint.textContent = t('js.willRunAll', currentAccounts.length);
      } else if (selectedAccountIds.size === 1) {
        const singleId = Array.from(selectedAccountIds)[0];
        const singleAcc = currentAccounts.find((a) => a.id === singleId);
        const sName = singleAcc ? getAccountRawName(singleAcc) : t('js.oneAccount');
        const maskedSingle = privacyMode ? maskName(sName) : sName;
        taskAccountSummary.textContent = maskedSingle + (singleAcc && singleAcc.isActive ? t('js.currentSuffixShort') : '');
        taskFooterHint.textContent = t('js.willRunOne', maskedSingle);
      } else {
        taskAccountSummary.textContent = t('js.selectedOf', selectedAccountIds.size, currentAccounts.length);
        taskFooterHint.textContent = t('js.willRunN', selectedAccountIds.size);
      }
    });
  }

  function renderTasks() {
    safeRender('taskList', taskListEl, () => {
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.remove('is-spinning');
      taskCountEl.textContent = String(currentTasks.length);
      taskHeaderBadge.textContent = t('ui.taskBadgeN', currentTasks.length);
      const done = currentTasks.filter((task) => task.claimed || task.acceptStatus === 'claimed').length;
      const claimable = currentTasks.filter((task) => isTaskClaimable(task)).length;
      taskDoneStat.textContent = done + ' / ' + claimable;

      if (!currentTasks.length) {
        taskListEl.innerHTML = '';
        taskEmpty.hidden = false;
        return;
      }
      taskEmpty.hidden = true;

      taskListEl.innerHTML = currentTasks.map((task) => {
        const isClaim = isTaskClaimable(task);
        const claimed = task.claimed || task.acceptStatus === 'claimed';
        const safeCode = escAttr(task.taskCode || '');
        const isAcceptingThis = acceptingTaskCodes.has(task.taskCode);
        let statusLabel = t('js.taskStatusProgress');
        let statusClass = 'task-badge is-warn';
        let action = '';

        if (claimed) {
          statusLabel = t('js.taskStatusClaimed');
          statusClass = 'task-badge is-ok';
        } else if (task.locked) {
          statusLabel = t('js.taskStatusLocked');
          statusClass = 'task-badge is-muted';
        } else if (task.manualOnly) {
          statusLabel = t('js.taskStatusManual');
          statusClass = 'task-badge is-warn';
        } else if (isClaim) {
          statusLabel = t('js.taskStatusClaimable');
          statusClass = 'task-badge is-ok';
          action = '<button type="button" class="task-item-btn" data-action="taskClaim" data-code="' + safeCode + '">' + escHtml(t('js.claimBtn')) + '</button>';
        } else if (task.acceptStatus === 'not_accepted') {
          statusLabel = t('js.taskStatusNotAccepted');
          statusClass = 'task-badge is-muted';
          action = '<button type="button" class="task-item-btn is-accept' + (isAcceptingThis ? ' is-loading' : '') + '" data-action="taskAccept" data-code="' + safeCode + '"' + (isAcceptingThis ? ' disabled' : '') + '>'
            + (isAcceptingThis ? '<span class="btn-mini-spinner is-dark"></span>' : '')
            + escHtml(t('js.acceptBtn')) + '</button>';
        }

        const safeTitle = (task.title || '').replace(/\uFFFD/g, '');
        const pct = task.target > 0 ? Math.min(100, Math.round((task.current / task.target) * 100)) : (claimed ? 100 : 0);
        const nums = task.target > 0 ? task.current + ' / ' + task.target : (task.locked ? '' : String(task.current));
        const barClass = 'task-item-bar' + (!claimed && pct < 100 ? ' is-warn' : '');
        const tipText = safeTitle + (task.lockedHint ? ' ' + task.lockedHint : '');

        return '<div class="task-item' + (claimed ? ' is-claimed' : '') + '" data-code="' + safeCode + '">'
          + '<div class="task-item-main">'
          + '<span class="task-item-title" title="' + escAttr(tipText) + '">' + escHtml(safeTitle) + '</span>'
          + '<span class="' + statusClass + '">' + escHtml(statusLabel) + '</span>'
          + '</div>'
          + '<div class="task-item-foot">'
          + '<div class="' + barClass + '"><i style="width:' + pct + '%"></i></div>'
          + '<span class="task-item-num">' + escHtml(nums) + '</span>'
          + action
          + '</div></div>';
      }).join('');
    });
  }

  function clearAcceptingTaskWatchdogs(targetCode) {
    if (targetCode) {
      const timer = acceptingTaskCodes.get(targetCode);
      if (timer) clearTimeout(timer);
      acceptingTaskCodes.delete(targetCode);
    } else {
      acceptingTaskCodes.forEach((timer) => clearTimeout(timer));
      acceptingTaskCodes.clear();
    }
  }

  window.onTaskClaim = function (code) {
    vscode.postMessage({ command: 'taskClaim', taskCode: code, accountId: viewingAccountId || undefined });
  };

  window.onTaskAccept = function (code) {
    if (!code || acceptingTaskCodes.has(code)) return;
    const watchdog = setTimeout(() => {
      if (acceptingTaskCodes.has(code)) {
        acceptingTaskCodes.delete(code);
        renderTasks();
      }
    }, 30000);
    acceptingTaskCodes.set(code, watchdog);
    renderTasks();
    vscode.postMessage({
      command: 'taskAcceptSingle',
      accountId: viewingAccountId || undefined,
      taskCode: code
    });
  };

  taskListEl.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    const code = btn.dataset.code || '';
    if (btn.dataset.action === 'taskClaim') window.onTaskClaim(code);
    else if (btn.dataset.action === 'taskAccept') window.onTaskAccept(code);
  });

  taskAccountTrigger.addEventListener('click', () => {
    const isExp = taskAccountBar.classList.toggle('is-expanded');
    taskAccountDrawer.hidden = !isExp;
  });

  taskAcctList.addEventListener('change', (e) => {
    const input = e.target;
    if (!input.dataset || !input.dataset.acct) return;
    if (input.checked) selectedAccountIds.add(input.dataset.acct);
    else selectedAccountIds.delete(input.dataset.acct);
    persistTaskSelection();
    renderAcctChips();
    if (selectedAccountIds.size === 1) {
      const id = Array.from(selectedAccountIds)[0];
      if (viewingAccountId !== id) {
        viewingAccountId = id;
        document.getElementById('taskSkeleton').style.display = 'flex';
        taskListEl.innerHTML = '';
        btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
        vscode.postMessage({ command: 'taskList', accountId: id });
      }
    }
  });

  taskSelAll.addEventListener('change', () => {
    if (taskSelAll.checked) currentAccounts.forEach((a) => selectedAccountIds.add(a.id));
    else selectedAccountIds.clear();
    persistTaskSelection();
    renderAcctChips();
  });

  taskSelActiveOnly.addEventListener('click', () => {
    selectedAccountIds.clear();
    const active = currentAccounts.find((a) => a.isActive);
    if (active) {
      selectedAccountIds.add(active.id);
      viewingAccountId = active.id;
      document.getElementById('taskSkeleton').style.display = 'flex';
      taskListEl.innerHTML = '';
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
      vscode.postMessage({ command: 'taskList', accountId: active.id });
    }
    persistTaskSelection();
    renderAcctChips();
  });

  taskSelInvert.addEventListener('click', () => {
    currentAccounts.forEach((a) => {
      if (selectedAccountIds.has(a.id)) selectedAccountIds.delete(a.id);
      else selectedAccountIds.add(a.id);
    });
    persistTaskSelection();
    renderAcctChips();
    if (selectedAccountIds.size === 1) {
      const id = Array.from(selectedAccountIds)[0];
      if (viewingAccountId !== id) {
        viewingAccountId = id;
        document.getElementById('taskSkeleton').style.display = 'flex';
        taskListEl.innerHTML = '';
        btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
        vscode.postMessage({ command: 'taskList', accountId: id });
      }
    }
  });

  function openProgressModal(title) {
    taskProgressStage.hidden = false;
    taskResultStage.hidden = true;
    taskBatchTitle.textContent = title;
    taskBatchProgressFill.style.width = '0%';
    taskBatchProgressText.textContent = t('js.initializing');
    taskProgressLines.innerHTML = '';
    btnTaskStop.disabled = false;
    btnTaskStop.textContent = t('ui.stopBtn');
    openModal(taskProgressOverlay, btnTaskStop);
  }

  function appendProgressLine(text, level) {
    const line = document.createElement('div');
    line.className = 'task-progress-line is-' + (level || 'doing');
    line.textContent = text;
    taskProgressLines.appendChild(line);
    taskProgressLines.scrollTop = taskProgressLines.scrollHeight;
  }

  function closeTaskModal() {
    closeModal(taskModalOverlay);
    taskAccountBar.classList.remove('is-expanded');
    taskAccountDrawer.hidden = true;
  }

  btnGrowthTasks.addEventListener('click', () => {
    taskAccountBar.classList.remove('is-expanded');
    taskAccountDrawer.hidden = true;
    const active = currentAccounts.find((a) => a.isActive);
    if (active && selectedAccountIds.size === 0) {
      selectedAccountIds.add(active.id);
      persistTaskSelection();
    }
    if (selectedAccountIds.size === 1) viewingAccountId = Array.from(selectedAccountIds)[0];
    renderAcctChips();
    openModal(taskModalOverlay, taskModalClose);
    if (currentTasks.length === 0) {
      btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
      vscode.postMessage({ command: 'taskList', accountId: viewingAccountId || undefined });
    }
  });
  taskModalClose.addEventListener('click', closeTaskModal);

  btnTaskRefresh.addEventListener('click', () => {
    document.getElementById('taskSkeleton').style.display = 'flex';
    taskListEl.innerHTML = '';
    btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
    vscode.postMessage({
      command: 'taskList',
      accountId: viewingAccountId || (selectedAccountIds.size === 1 ? Array.from(selectedAccountIds)[0] : undefined)
    });
  });

  btnTaskRunAuto.addEventListener('click', () => {
    if (selectedAccountIds.size === 0) { showToast(t('js.selectFirstToast'), 'error', 2200); return; }
    openProgressModal(t('js.runAutoTitle'));
    appendProgressLine(t('js.batchStartLine', selectedAccountIds.size), 'doing');
    vscode.postMessage({ command: 'taskRunAuto', accountIds: Array.from(selectedAccountIds) });
  });

  btnTaskAcceptAll.addEventListener('click', () => {
    if (selectedAccountIds.size === 0) { showToast(t('js.selectFirstToast'), 'error', 2200); return; }
    openProgressModal(t('js.acceptAutoTitle'));
    appendProgressLine(t('js.batchAcceptStartLine', selectedAccountIds.size), 'doing');
    vscode.postMessage({ command: 'taskAcceptAll', accountIds: Array.from(selectedAccountIds) });
  });

  btnTaskStop.addEventListener('click', () => {
    btnTaskStop.disabled = true;
    btnTaskStop.textContent = t('js.stopping');
    vscode.postMessage({ command: 'taskStop' });
  });

  function closeTaskResult() {
    closeModal(taskProgressOverlay);
    btnTaskRefresh.querySelector('.refresh-icon')?.classList.add('is-spinning');
    vscode.postMessage({ command: 'taskList', accountId: viewingAccountId || undefined });
  }
  btnTaskResultClose.addEventListener('click', closeTaskResult);
  taskResultCloseX.addEventListener('click', closeTaskResult);

  // ── [10] Usage Records & Model Analytics Modal ────────────────────────────
  function usageAccountLabel(accountId) {
    const acc = currentAccounts.find((a) => a.id === accountId);
    if (!acc) return t('ui.usageUnknownAccount');
    const raw = getAccountRawName(acc) || accountId;
    return privacyMode ? maskName(raw) : raw;
  }

  function renderUsageRecords(records, summary) {
    const container = document.getElementById('usageRecordsList');
    const countEl = document.getElementById('usageRecordsCount');
    const awardedBadge = document.getElementById('usageAwardedBadge');
    const consumedBadge = document.getElementById('usageConsumedBadge');
    lastUsageRecords = Array.isArray(records) ? records : [];
    lastUsageSummary = summary || null;
    if (summary) {
      if (awardedBadge) awardedBadge.textContent = t('js.gainedBadge', fmtNum(summary.totalAwarded || 0));
      if (consumedBadge) consumedBadge.textContent = t('js.consumedBadge', summary.totalConsumed ? '-' + fmtNum(summary.totalConsumed) : '0');
    }
    if (!container) return;

    safeRender('usageRecords', container, () => {
      const fingerprint = (privacyMode ? 'p1' : 'p0')
        + '#' + currentAccounts.map((a) => a.id + ':' + getAccountRawName(a)).join(',')
        + '#' + lastUsageRecords.map((r) => r.requestId + '|' + r.accountId + '|' + r.credit).join(',')
        + '#' + (summary ? (summary.totalAwarded || 0) + '/' + (summary.totalConsumed || 0) : '');
      if (fingerprint === lastUsageFingerprint && container.children.length) return;
      lastUsageFingerprint = fingerprint;
      const prevScrollTop = container.scrollTop;

      if (lastUsageRecords.length === 0) {
        if (countEl) countEl.textContent = '';
        container.innerHTML = '<div class="empty-state usage-list-empty">' + escHtml(t('ui.usageEmpty')) + '</div>';
        return;
      }
      if (countEl) countEl.textContent = t('ui.usageRecordsCount', lastUsageRecords.length);

      const groups = [];
      const groupIndex = new Map();
      for (const r of lastUsageRecords) {
        const key = String(r.accountId || '');
        let g = groupIndex.get(key);
        if (!g) {
          const acc = key ? currentAccounts.find((a) => a.id === key) : null;
          g = { id: key, name: usageAccountLabel(key), isActive: !!(acc && acc.isActive), total: 0, items: [] };
          groupIndex.set(key, g);
          groups.push(g);
        }
        g.total += Number(r.credit || 0);
        g.items.push(r);
      }

      container.innerHTML = groups.map((g) => {
        const open = usageOpenState.has(g.id) ? usageOpenState.get(g.id) : g.isActive;
        const rows = g.items.map((r) => {
          const credit = Number(r.credit || 0);
          const rawTime = String(r.requestTime || '');
          const time = rawTime.length >= 19 ? rawTime.slice(11, 19) : rawTime;
          const model = r.model || '';
          const tip = [model, r.client].filter(Boolean).join(' / ');
          return '<div class="usage-item" title="' + escAttr(tip) + '">'
            + '<span class="usage-item-time">' + escHtml(time) + '</span>'
            + '<span class="usage-item-name" title="' + escAttr(model) + '">' + escHtml(model) + '</span>'
            + '<span class="usage-item-delta is-minus">-' + fmtNum(credit) + '</span>'
            + '</div>';
        }).join('');
        return '<div class="usage-group' + (open ? ' is-open' : '') + (g.isActive ? ' is-active' : '') + '" data-account="' + escAttr(g.id) + '">'
          + '<button type="button" class="usage-group-head" aria-expanded="' + (open ? 'true' : 'false') + '">'
          + '<span class="usage-group-dot"></span>'
          + '<span class="usage-group-name">' + escHtml(g.name) + '</span>'
          + '<span class="usage-group-meta">' + escHtml(t('ui.usageGroupRequests', g.items.length)) + '</span>'
          + '<span class="usage-group-sum">-' + fmtNum(Math.round(g.total * 100) / 100) + '</span>'
          + '<svg class="usage-group-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
          + '</button>'
          + '<div class="usage-group-body">' + rows + '</div>'
          + '</div>';
      }).join('');
      container.scrollTop = prevScrollTop;
    });
  }

  const usageListEl = document.getElementById('usageRecordsList');
  if (usageListEl) {
    usageListEl.addEventListener('click', (e) => {
      const head = e.target.closest ? e.target.closest('.usage-group-head') : null;
      if (!head) return;
      const group = head.closest('.usage-group');
      if (!group) return;
      const id = group.getAttribute('data-account') || '';
      const open = !group.classList.contains('is-open');
      usageOpenState.set(id, open);
      group.classList.toggle('is-open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function modelStatsRangeDates() {
    const dates = [];
    const p = (n) => String(n).padStart(2, '0');
    const now = Date.now();
    for (let i = 0; i < modelStatsDays; i++) {
      const d = new Date(now + 8 * 3600000 - i * 86400000);
      dates.push(d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()));
    }
    return dates;
  }

  function modelStatsCollect() {
    const data = lastModelStats && lastModelStats.days ? lastModelStats.days : {};
    const dates = modelStatsRangeDates();
    const today = dates[0];
    const totals = new Map();
    const dayRows = [];
    let missingDays = 0;
    for (const date of dates) {
      const accs = data[date];
      if (!accs) { if (date !== today) missingDays++; continue; }
      const models = new Map();
      let dayTotal = 0;
      for (const [accId, mmap] of Object.entries(accs)) {
        if (modelStatsAccount !== 'all' && accId !== modelStatsAccount) continue;
        for (const [model, st] of Object.entries(mmap || {})) {
          if (modelStatsModel !== 'all' && model !== modelStatsModel) continue;
          const c = Number(st.credits || 0);
          const n = Number(st.count || 0);
          const cur = models.get(model) || { credits: 0, count: 0 };
          cur.credits += c; cur.count += n;
          models.set(model, cur);
          const tot = totals.get(model) || { credits: 0, count: 0 };
          tot.credits += c; tot.count += n;
          totals.set(model, tot);
          dayTotal += c;
        }
      }
      if (models.size) dayRows.push({ date, total: dayTotal, models });
    }
    return { totals, dayRows, missingDays, hasAny: dayRows.length > 0 };
  }

  function fillModelStatsOptions() {
    const accSel = document.getElementById('modelStatsAccount');
    const modelSel = document.getElementById('modelStatsModel');
    if (!accSel || !modelSel) return;
    const accIds = [];
    const seenAcc = new Set();
    for (const acc of currentAccounts) { accIds.push(acc.id); seenAcc.add(acc.id); }
    const days = lastModelStats && lastModelStats.days ? lastModelStats.days : {};
    for (const date of modelStatsRangeDates()) {
      const accs = days[date];
      if (accs) Object.keys(accs).forEach((id) => { if (!seenAcc.has(id)) { seenAcc.add(id); accIds.push(id); } });
    }
    const prevAcc = accSel.value || 'all';
    accSel.innerHTML = '<option value="all">' + escHtml(t('ui.modelStatsAllAccounts')) + '</option>'
      + accIds.map((id) => '<option value="' + escAttr(id) + '">' + escHtml(usageAccountLabel(id)) + '</option>').join('');
    accSel.value = seenAcc.has(prevAcc) || prevAcc === 'all' ? prevAcc : 'all';
    modelStatsAccount = accSel.value || 'all';

    const collected = modelStatsCollect();
    const prevModel = modelSel.value || 'all';
    const modelsSorted = [...collected.totals.entries()].sort((a, b) => b[1].credits - a[1].credits);
    modelSel.innerHTML = '<option value="all">' + escHtml(t('ui.modelStatsAllModels')) + '</option>'
      + modelsSorted.map(([m]) => '<option value="' + escAttr(m) + '">' + escHtml(m) + '</option>').join('');
    const modelIds = new Set(modelsSorted.map(([m]) => m));
    modelSel.value = modelIds.has(prevModel) || prevModel === 'all' ? prevModel : 'all';
    modelStatsModel = modelSel.value || 'all';
  }

  function renderModelStats() {
    const box = document.getElementById('modelStatsBody');
    const kpiBox = document.getElementById('modelStatsKpiBar');
    const grandBadge = document.getElementById('modelStatsGrandTotal');
    if (!box) return;
    safeRender('modelStats', box, () => {
      fillModelStatsOptions();
      const collected = modelStatsCollect();
      const fingerprint = (privacyMode ? 'p1' : 'p0') + '#' + modelStatsDays + '#' + modelStatsAccount + '#' + modelStatsModel + '#' + JSON.stringify(lastModelStats ? lastModelStats.days : {});
      if (fingerprint === modelStatsFingerprint && box.children.length) return;
      modelStatsFingerprint = fingerprint;

      if (!collected.hasAny) {
        if (grandBadge) grandBadge.hidden = true;
        if (kpiBox) kpiBox.innerHTML = '';
        box.innerHTML = '<div class="empty-state usage-list-empty" style="grid-column: 1 / -1; padding: 48px 14px;">' + escHtml(t('ui.modelStatsEmpty')) + '</div>';
        return;
      }

      const totalCredits = [...collected.totals.values()].reduce((s, t2) => s + t2.credits, 0);
      const totalRequests = [...collected.totals.values()].reduce((s, t2) => s + (t2.count || 0), 0);
      const totalsSorted = [...collected.totals.entries()].sort((a, b) => b[1].credits - a[1].credits);
      const dailyAvg = Math.round((totalCredits / Math.max(1, collected.dayRows.length)) * 100) / 100;

      if (grandBadge) {
        grandBadge.textContent = t('ui.modelStatsTotal') + ' ' + fmtNum(Math.round(totalCredits * 100) / 100) + ' ' + t('ui.modelUnitPoints');
        grandBadge.hidden = false;
      }
      if (kpiBox) {
        kpiBox.innerHTML =
          '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiTotalCredits')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val is-primary">' + escHtml(fmtNum(Math.round(totalCredits * 100) / 100)) + '</span><span class="model-kpi-unit">' + escHtml(t('ui.modelUnitPoints')) + '</span></div></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiTotalRequests')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(fmtNum(totalRequests)) + '</span><span class="model-kpi-unit">' + escHtml(t('ui.modelStatsReqCount', '').trim()) + '</span></div></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiDailyAvg')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(fmtNum(dailyAvg)) + '</span><span class="model-kpi-unit">' + escHtml(t('ui.modelUnitPoints')) + '</span></div></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiActiveModels')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(totalsSorted.length) + '</span></div></div>';
      }

      const palette = ['#10b981', '#3b82f6', '#06b6d4', '#f59e0b', '#64748b'];
      const leftHtml = '<div class="model-col-wrap"><div class="model-col-header"><span>' + escHtml(t('ui.modelRankSection')) + '</span><span class="model-col-header-count">' + escHtml(t('ui.modelStatsModelCount', totalsSorted.length)) + '</span></div><div class="model-card-list">'
        + totalsSorted.map(([model, st], idx) => {
          const color = palette[idx % palette.length];
          const pct = totalCredits > 0 ? Math.round(st.credits / totalCredits * 1000) / 10 : 0;
          return '<div class="model-card-item"><div class="model-card-main"><div class="model-card-title-col"><span class="model-card-dot" style="background:' + color + '"></span><span class="model-card-name" title="' + escAttr(model) + '">' + escHtml(model) + '</span></div><span class="model-card-sum">' + escHtml(fmtNum(Math.round(st.credits * 100) / 100)) + ' ' + escHtml(t('ui.modelUnitPoints')) + '</span></div><div class="model-card-bar-track"><div class="model-card-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><div class="model-card-subline"><span class="model-card-count">' + escHtml(t('ui.modelStatsReqCount', st.count)) + '</span><span class="model-card-pct">' + pct + '%</span></div></div>';
        }).join('') + '</div></div>';

      const todayDateStr = modelStatsRangeDates()[0];
      const rightHtml = '<div class="model-col-wrap"><div class="model-col-header"><span>' + escHtml(t('ui.modelDailySection')) + '</span><span class="model-col-header-count">' + escHtml(t('ui.modelStatsDayCount', collected.dayRows.length)) + '</span></div><div class="model-daily-list">'
        + collected.dayRows.map((day) => {
          const isToday = day.date === todayDateStr;
          const modelsSorted = [...day.models.entries()].sort((a, b) => b[1].credits - a[1].credits);
          const subrows = modelsSorted.map(([m, st]) => '<div class="model-day-model-row"><span class="model-day-model-name" title="' + escAttr(m) + '">' + escHtml(m) + '</span><span class="model-day-model-count">' + escHtml(t('ui.modelStatsReqCount', st.count)) + '</span><span class="model-day-model-stat">' + escHtml(fmtNum(Math.round(st.credits * 100) / 100)) + ' ' + escHtml(t('ui.modelUnitPoints')) + '</span></div>').join('');
          return '<div class="model-day-card' + (isToday ? ' is-today' : '') + '"><div class="model-day-card-head"><div class="model-day-badge-wrap"><span class="model-day-date-text">' + escHtml(day.date.slice(5)) + '</span>' + (isToday ? '<span class="model-day-today-tag">' + escHtml(t('ui.modelDailyToday')) + '</span>' : '') + '</div><span class="model-day-total-text">' + escHtml(t('ui.modelStatsTotal')) + ' ' + escHtml(fmtNum(Math.round(day.total * 100) / 100)) + ' ' + escHtml(t('ui.modelUnitPoints')) + '</span></div><div class="model-day-models">' + subrows + '</div></div>';
        }).join('') + '</div></div>';

      const syncingHtml = collected.missingDays > 0
        ? '<div class="model-stats-syncing" style="grid-column: 1 / -1;">' + escHtml(t('ui.modelStatsSyncing')) + '</div>'
        : '';
      box.innerHTML = syncingHtml + leftHtml + rightHtml;
    });
  }

  function requestModelStatsSync() {
    if (modelStatsSyncRequested) return;
    modelStatsSyncRequested = true;
    vscode.postMessage({ command: 'refreshModelStats', days: modelStatsDays });
  }

  function shiftUtc8Date(baseDateStr, deltaDays) {
    const parts = String(baseDateStr || '').split('-').map(Number);
    const ms = parts.length === 3 && parts[0] > 2000
      ? Date.UTC(parts[0], parts[1] - 1, parts[2]) + deltaDays * 86400000
      : Date.now() + 8 * 3600000 + deltaDays * 86400000;
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function tokenAllowedDateSet() {
    const today = (lastTokenLedger && lastTokenLedger.todayKey) || shiftUtc8Date('', 0);
    if (tokenRange === 'today') return new Set([today]);
    if (tokenRange === '7d' || tokenRange === '30d') {
      const n = tokenRange === '7d' ? 7 : 30;
      const s = new Set();
      for (let i = 0; i < n; i++) s.add(shiftUtc8Date(today, -i));
      return s;
    }
    return null;
  }

  function syncTokenFilterControls() {
    if (tokenStatsRange) {
      tokenStatsRange.querySelectorAll('.model-seg-btn').forEach((el) => el.classList.toggle('is-active', el.getAttribute('data-range') === tokenRange));
    }
    if (tokenStatsMode) {
      tokenStatsMode.querySelectorAll('.model-seg-btn').forEach((el) => el.classList.toggle('is-active', el.getAttribute('data-mode') === tokenMode));
    }
    if (tokenStatsAccount) tokenStatsAccount.value = tokenAccountFilter || 'all';
    if (tokenStatsSource) tokenStatsSource.value = tokenSourceFilter || 'all';
  }

  function fillTokenAccountOptions() {
    if (!tokenStatsAccount) return;
    const seen = new Set();
    const opts = [{ val: 'all', label: t('ui.modelStatsAllAccounts') }];
    for (const acc of currentAccounts) {
      if (!acc.uid || seen.has(acc.uid)) continue;
      seen.add(acc.uid);
      const raw = getAccountRawName(acc) || acc.uid;
      opts.push({ val: acc.uid, label: privacyMode ? maskName(raw) : raw });
    }
    const slices = (lastTokenLedger && Array.isArray(lastTokenLedger.slices)) ? lastTokenLedger.slices : [];
    let hasUnattributed = false;
    for (const sl of slices) {
      if (!sl.uid) continue;
      if (sl.uid === 'unattributed') { hasUnattributed = true; continue; }
      if (!seen.has(sl.uid)) {
        seen.add(sl.uid);
        opts.push({ val: sl.uid, label: maskUid(sl.uid) });
      }
    }
    if (hasUnattributed) opts.push({ val: 'unattributed', label: t('ui.tokenUnattributed') });
    tokenStatsAccount.innerHTML = opts.map((o) => '<option value="' + escAttr(o.val) + '">' + escHtml(o.label) + '</option>').join('');
    const validVals = new Set(opts.map((o) => o.val));
    tokenAccountFilter = validVals.has(tokenAccountFilter) ? tokenAccountFilter : 'all';
    tokenStatsAccount.value = tokenAccountFilter;
  }

  function formatTokenMetric(item) {
    if (tokenMode === 'usd') return fmtUsd(item.costUsd);
    if (tokenMode === 'weighted') return fmtCompactTok(item.weighted);
    return fmtCompactTok(item.total);
  }

  function pickTokenMetricNum(item) {
    if (tokenMode === 'usd') return Number(item.costUsd || 0);
    if (tokenMode === 'weighted') return Number(item.weighted || 0);
    return Number(item.total || 0);
  }

  function sourceDisplayName(src) {
    if (src === 'ide') return t('ui.tokenSourceIde');
    if (src === 'cli') return t('ui.tokenSourceCli');
    if (src === 'workbuddy') return t('ui.tokenSourceWorkbuddy');
    return String(src || '');
  }

  function renderTokenStats() {
    if (!tokenStatsBody) return;
    safeRender('tokenStats', tokenStatsBody, () => {
      fillTokenAccountOptions();
      const grandBadge = document.getElementById('modelStatsGrandTotal');
      const slices = (lastTokenLedger && Array.isArray(lastTokenLedger.slices)) ? lastTokenLedger.slices : [];
      const scannedAt = lastTokenLedger ? lastTokenLedger.scannedAt : 0;
      const fp = [
        privacyMode ? '1' : '0', tokenRange, tokenMode, tokenAccountFilter, tokenSourceFilter,
        scannedAt, currentAccounts.map((a) => a.uid + ':' + getAccountRawName(a)).join(',')
      ].join('#');
      if (fp === tokenStatsFingerprint && tokenStatsBody.children.length) return;
      tokenStatsFingerprint = fp;

      const allowedDates = tokenAllowedDateSet();
      const filtered = slices.filter((sl) => {
        if (allowedDates && !allowedDates.has(sl.date)) return false;
        if (tokenAccountFilter !== 'all' && sl.uid !== tokenAccountFilter) return false;
        if (tokenSourceFilter !== 'all' && sl.source !== tokenSourceFilter) return false;
        return true;
      });

      if (!filtered.length) {
        if (grandBadge && activeUsageTab === 'tokens') grandBadge.hidden = true;
        if (tokenStatsKpiBar) tokenStatsKpiBar.innerHTML = '';
        tokenStatsBody.innerHTML = '<div class="empty-state usage-list-empty" style="grid-column: 1 / -1; padding: 48px 14px;">' + escHtml(t('ui.tokenEmpty')) + '</div>';
        return;
      }

      const agg = { total: 0, weighted: 0, costUsd: 0, savedByCacheUsd: 0, input: 0, cacheRead: 0, output: 0, calls: 0 };
      const sourcesSeen = new Set();
      const byModel = new Map();
      const byDay = new Map();

      for (const sl of filtered) {
        agg.total += sl.total;
        agg.weighted += sl.weighted;
        agg.costUsd += sl.costUsd;
        agg.savedByCacheUsd += sl.savedByCacheUsd;
        agg.input += sl.input;
        agg.cacheRead += sl.cacheRead;
        agg.output += sl.output;
        agg.calls += sl.calls;
        sourcesSeen.add(sl.source);

        let mEntry = byModel.get(sl.model);
        if (!mEntry) {
          mEntry = { model: sl.model, displayName: sl.displayName || sl.model, total: 0, weighted: 0, costUsd: 0, input: 0, cacheRead: 0, output: 0, calls: 0 };
          byModel.set(sl.model, mEntry);
        }
        mEntry.total += sl.total; mEntry.weighted += sl.weighted; mEntry.costUsd += sl.costUsd;
        mEntry.input += sl.input; mEntry.cacheRead += sl.cacheRead; mEntry.output += sl.output; mEntry.calls += sl.calls;

        let dEntry = byDay.get(sl.date);
        if (!dEntry) {
          dEntry = { date: sl.date, total: 0, weighted: 0, costUsd: 0, calls: 0, models: new Map() };
          byDay.set(sl.date, dEntry);
        }
        dEntry.total += sl.total; dEntry.weighted += sl.weighted; dEntry.costUsd += sl.costUsd; dEntry.calls += sl.calls;
        let dm = dEntry.models.get(sl.model);
        if (!dm) {
          dm = { model: sl.model, displayName: sl.displayName || sl.model, total: 0, weighted: 0, costUsd: 0, calls: 0 };
          dEntry.models.set(sl.model, dm);
        }
        dm.total += sl.total; dm.weighted += sl.weighted; dm.costUsd += sl.costUsd; dm.calls += sl.calls;
      }

      const hitDenom = agg.input + agg.cacheRead;
      const cacheHitPct = hitDenom > 0 ? Math.round((agg.cacheRead / hitDenom) * 1000) / 10 : 0;
      if (grandBadge && activeUsageTab === 'tokens') {
        grandBadge.textContent = t('ui.modelStatsTotal') + ' ' + formatTokenMetric(agg);
        grandBadge.hidden = false;
      }

      if (tokenStatsKpiBar) {
        let primaryLabel = t('ui.kpiTokenMain');
        let primaryVal = fmtCompactTok(agg.total);
        let primarySub = fmtUsd(agg.costUsd) + ' · ' + t('ui.tokenModeWeighted') + ' ' + fmtCompactTok(agg.weighted);
        if (tokenMode === 'usd') {
          primaryLabel = t('ui.kpiTokenCost');
          primaryVal = fmtUsd(agg.costUsd);
          primarySub = fmtCompactTok(agg.total);
        } else if (tokenMode === 'weighted') {
          primaryLabel = t('ui.kpiTokenWeighted');
          primaryVal = fmtCompactTok(agg.weighted);
          primarySub = fmtCompactTok(agg.total) + ' · ' + fmtUsd(agg.costUsd);
        }
        const sourceText = Array.from(sourcesSeen).map(sourceDisplayName).join(' · ');
        tokenStatsKpiBar.innerHTML =
          '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(primaryLabel) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val is-primary">' + escHtml(primaryVal) + '</span></div><span class="token-kpi-sub">' + escHtml(primarySub) + '</span></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiCacheHit')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(cacheHitPct + '%') + '</span></div><span class="token-kpi-sub">' + escHtml(t('ui.tokenSavedFmt', fmtUsd(agg.savedByCacheUsd))) + '</span></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiInOut')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(fmtCompactTok(agg.input)) + '</span></div><span class="token-kpi-sub">' + escHtml(t('ui.tokenInOutSub', fmtCompactTok(agg.cacheRead), fmtCompactTok(agg.output))) + '</span></div>'
          + '<div class="model-kpi-card"><span class="model-kpi-label">' + escHtml(t('ui.kpiActiveCalls')) + '</span><div class="model-kpi-val-row"><span class="model-kpi-val">' + escHtml(fmtNum(agg.calls)) + '</span></div><span class="token-kpi-sub">' + escHtml(sourceText) + '</span></div>';
      }

      const palette = ['#10b981', '#3b82f6', '#06b6d4', '#f59e0b', '#64748b'];
      const totalMetric = pickTokenMetricNum(agg);
      const modelsSorted = Array.from(byModel.values()).sort((a, b) => pickTokenMetricNum(b) - pickTokenMetricNum(a));
      const leftHtml = '<div class="model-col-wrap"><div class="model-col-header"><span>' + escHtml(t('ui.modelRankSection')) + '</span><span class="model-col-header-count">' + escHtml(t('ui.modelStatsModelCount', modelsSorted.length)) + '</span></div><div class="model-card-list">'
        + modelsSorted.map((st, idx) => {
          const color = palette[idx % palette.length];
          const valNum = pickTokenMetricNum(st);
          const pct = totalMetric > 0 ? Math.round((valNum / totalMetric) * 1000) / 10 : 0;
          const mHitDenom = st.input + st.cacheRead;
          const mHitPct = mHitDenom > 0 ? Math.round((st.cacheRead / mHitDenom) * 1000) / 10 : 0;
          const secVal = tokenMode === 'usd' ? fmtCompactTok(st.total) : fmtUsd(st.costUsd);
          return '<div class="model-card-item"><div class="model-card-main"><div class="model-card-title-col"><span class="model-card-dot" style="background:' + color + '"></span><span class="model-card-name" title="' + escAttr(st.model) + '">' + escHtml(st.displayName) + '</span></div><span class="model-card-sum">' + escHtml(formatTokenMetric(st)) + '</span></div><div class="model-card-bar-track"><div class="model-card-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><div class="model-card-subline"><span class="model-card-count">' + escHtml(t('ui.tokenCallsFmt', fmtNum(st.calls)) + ' · ' + mHitPct + '% · ' + secVal) + '</span><span class="model-card-pct">' + pct + '%</span></div></div>';
        }).join('') + '</div></div>';

      const todayKey = (lastTokenLedger && lastTokenLedger.todayKey) || shiftUtc8Date('', 0);
      const daysSorted = Array.from(byDay.values()).sort((a, b) => b.date.localeCompare(a.date));
      const rightHtml = '<div class="model-col-wrap"><div class="model-col-header"><span>' + escHtml(t('ui.tokenDailySection')) + '</span><span class="model-col-header-count">' + escHtml(t('ui.modelStatsDayCount', daysSorted.length)) + '</span></div><div class="model-daily-list">'
        + daysSorted.map((day) => {
          const isToday = day.date === todayKey;
          const dayModels = Array.from(day.models.values()).sort((a, b) => pickTokenMetricNum(b) - pickTokenMetricNum(a)).slice(0, 5);
          const subrows = dayModels.map((dm) => '<div class="model-day-model-row"><span class="model-day-model-name" title="' + escAttr(dm.model) + '">' + escHtml(dm.displayName) + '</span><span class="model-day-model-count">' + escHtml(t('ui.modelStatsReqCount', dm.calls)) + '</span><span class="model-day-model-stat">' + escHtml(formatTokenMetric(dm)) + '</span></div>').join('');
          return '<div class="model-day-card' + (isToday ? ' is-today' : '') + '"><div class="model-day-card-head"><div class="model-day-badge-wrap"><span class="model-day-date-text">' + escHtml(day.date.slice(5)) + '</span>' + (isToday ? '<span class="model-day-today-tag">' + escHtml(t('ui.modelDailyToday')) + '</span>' : '') + '</div><span class="model-day-total-text">' + escHtml(formatTokenMetric(day) + (tokenMode === 'usd' ? '' : ' (' + fmtUsd(day.costUsd) + ')')) + '</span></div><div class="model-day-models">' + subrows + '</div></div>';
        }).join('') + '</div></div>';

      tokenStatsBody.innerHTML = leftHtml + rightHtml;
    });
  }

  function openTokenModalForAccount(uid) {
    tokenAccountFilter = uid || 'all';
    tokenSourceFilter = 'all';
    const ts = uid && lastTokenLedger && lastTokenLedger.perAccount ? lastTokenLedger.perAccount[uid] : null;
    tokenRange = (uid && ts && ts.todayTokens <= 0 && ts.totalTokens > 0) ? 'all' : 'today';
    syncTokenFilterControls();
    openUsageModal('tokens');
  }

  function switchUsageTab(tabName) {
    if (!usageModalTabs) return;
    activeUsageTab = tabName || 'model';
    usageModalTabs.querySelectorAll('.usage-modal-tab').forEach((tab) => tab.classList.toggle('is-active', tab.getAttribute('data-tab') === activeUsageTab));
    if (tabContentModel) tabContentModel.hidden = activeUsageTab !== 'model';
    if (tabContentLogs) tabContentLogs.hidden = activeUsageTab !== 'logs';
    if (tabContentTokens) tabContentTokens.hidden = activeUsageTab !== 'tokens';
    if (usageModalHint) usageModalHint.textContent = activeUsageTab === 'tokens' ? t('ui.tokenHint') : t('ui.modelDailyHint');
    const bodyEl = usageModalOverlay ? usageModalOverlay.querySelector('.modal-body') : null;
    if (bodyEl) bodyEl.scrollTop = 0;
    if (activeUsageTab === 'tokens') {
      tokenStatsFingerprint = '';
      renderTokenStats();
      if (!lastTokenLedger) vscode.postMessage({ command: 'refreshTokenLedger' });
    } else if (activeUsageTab === 'model') {
      modelStatsFingerprint = '';
      renderModelStats();
      requestModelStatsSync();
    } else {
      const grandBadge = document.getElementById('modelStatsGrandTotal');
      if (grandBadge) grandBadge.hidden = true;
    }
  }

  function openUsageModal(initialTab) {
    if (!usageModalOverlay) return;
    document.documentElement.classList.add('usage-modal-open');
    document.body.classList.add('usage-modal-open');
    modelStatsSyncRequested = false;
    switchUsageTab(initialTab || activeUsageTab || 'model');
    openModal(usageModalOverlay, usageModalClose);
  }

  function closeUsageModal() {
    document.documentElement.classList.remove('usage-modal-open');
    document.body.classList.remove('usage-modal-open');
    closeModal(usageModalOverlay);
  }

  if (btnOpenUsageDetail) btnOpenUsageDetail.addEventListener('click', (e) => { e.stopPropagation(); openUsageModal('model'); });
  const usageDetailsBar = document.getElementById('usageDetails');
  if (usageDetailsBar) {
    usageDetailsBar.addEventListener('click', () => openUsageModal('model'));
    usageDetailsBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openUsageModal('model'); }
    });
  }
  const openGlobalTokensModal = () => {
    tokenAccountFilter = 'all';
    tokenSourceFilter = 'all';
    tokenRange = 'today';
    syncTokenFilterControls();
    openUsageModal('tokens');
  };
  if (btnOpenTokenDetail) btnOpenTokenDetail.addEventListener('click', (e) => { e.stopPropagation(); openGlobalTokensModal(); });
  if (tokenStatsBar) {
    tokenStatsBar.addEventListener('click', openGlobalTokensModal);
    tokenStatsBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGlobalTokensModal(); }
    });
  }
  if (tokenStatsRange) {
    tokenStatsRange.addEventListener('click', (e) => {
      const segBtn = e.target.closest ? e.target.closest('.model-seg-btn') : null;
      if (!segBtn) return;
      const r = segBtn.getAttribute('data-range') || 'today';
      if (r === tokenRange) return;
      tokenRange = r;
      syncTokenFilterControls();
      tokenStatsFingerprint = '';
      renderTokenStats();
    });
  }
  if (tokenStatsMode) {
    tokenStatsMode.addEventListener('click', (e) => {
      const segBtn = e.target.closest ? e.target.closest('.model-seg-btn') : null;
      if (!segBtn) return;
      const m = segBtn.getAttribute('data-mode') || 'total';
      if (m === tokenMode) return;
      tokenMode = m;
      syncTokenFilterControls();
      tokenStatsFingerprint = '';
      renderTokenStats();
    });
  }
  if (tokenStatsAccount) tokenStatsAccount.addEventListener('change', () => { tokenAccountFilter = tokenStatsAccount.value || 'all'; tokenStatsFingerprint = ''; renderTokenStats(); });
  if (tokenStatsSource) tokenStatsSource.addEventListener('change', () => { tokenSourceFilter = tokenStatsSource.value || 'all'; tokenStatsFingerprint = ''; renderTokenStats(); });
  if (usageModalTabs) usageModalTabs.addEventListener('click', (e) => {
    const tabBtn = e.target.closest ? e.target.closest('.usage-modal-tab') : null;
    if (tabBtn) switchUsageTab(tabBtn.getAttribute('data-tab') || 'model');
  });
  if (usageModalClose) usageModalClose.addEventListener('click', closeUsageModal);
  if (usageModalCancel) usageModalCancel.addEventListener('click', closeUsageModal);

  const modelStatsRangeEl = document.getElementById('modelStatsRange');
  if (modelStatsRangeEl) {
    modelStatsRangeEl.addEventListener('click', (e) => {
      const segBtn = e.target.closest ? e.target.closest('.model-seg-btn') : null;
      if (!segBtn) return;
      const days = Number(segBtn.getAttribute('data-days')) || 7;
      if (days === modelStatsDays) return;
      modelStatsDays = days;
      modelStatsRangeEl.querySelectorAll('.model-seg-btn').forEach((el) => el.classList.toggle('is-active', Number(el.getAttribute('data-days')) === days));
      modelStatsSyncRequested = false;
      modelStatsFingerprint = '';
      renderModelStats();
      requestModelStatsSync();
    });
  }
  const modelStatsAccountEl = document.getElementById('modelStatsAccount');
  if (modelStatsAccountEl) modelStatsAccountEl.addEventListener('change', () => { modelStatsAccount = modelStatsAccountEl.value || 'all'; modelStatsFingerprint = ''; renderModelStats(); });
  const modelStatsModelEl = document.getElementById('modelStatsModel');
  if (modelStatsModelEl) modelStatsModelEl.addEventListener('change', () => { modelStatsModel = modelStatsModelEl.value || 'all'; modelStatsFingerprint = ''; renderModelStats(); });

  let usageSpinTimer = 0;
  function stopUsageRefreshSpin() {
    if (!btnRefreshUsage) return;
    btnRefreshUsage.classList.remove('is-spinning');
    if (usageSpinTimer) { clearTimeout(usageSpinTimer); usageSpinTimer = 0; }
  }
  if (btnRefreshUsage) {
    btnRefreshUsage.addEventListener('click', (e) => {
      e.stopPropagation();
      const now = Date.now();
      if (now - usageRefreshLockTs < 10000) { showToast(t('js.refreshTooSoon'), 'warn', 3000); return; }
      usageRefreshLockTs = now;
      btnRefreshUsage.classList.add('is-spinning');
      if (usageSpinTimer) clearTimeout(usageSpinTimer);
      usageSpinTimer = setTimeout(() => { stopUsageRefreshSpin(); showToast(t('js.refreshTimeout'), 'warn', 8000); }, 30000);
      vscode.postMessage({ command: 'refreshStatus' });
      vscode.postMessage({ command: 'refreshTokenLedger' });
    });
  }

  // ── [11] Global Escape Handler (Covers All 8 Modals in One Block) ─────────
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const confirmOverlay = document.getElementById('confirmOverlay');
    if (confirmOverlay && !confirmOverlay.hidden) {
      if (typeof confirmOverlay._cancelConfirm === 'function') confirmOverlay._cancelConfirm();
      return;
    }
    if (taskProgressOverlay && !taskProgressOverlay.hidden) { if (!taskResultStage.hidden) closeTaskResult(); return; }
    if (restartModalOverlay && !restartModalOverlay.hidden) { closeModal(restartModalOverlay); return; }
    if (editMetaModalOverlay && !editMetaModalOverlay.hidden) { closeModal(editMetaModalOverlay); return; }
    if (exportModalOverlay && !exportModalOverlay.hidden) { closeModal(exportModalOverlay); return; }
    if (addAccountOverlay && !addAccountOverlay.hidden) { closeAddModal(); return; }
    if (usageModalOverlay && !usageModalOverlay.hidden) { closeUsageModal(); return; }
    if (settingsModalOverlay && !settingsModalOverlay.hidden) { closeSettingsModal(); return; }
    if (taskModalOverlay && !taskModalOverlay.hidden) { closeTaskModal(); }
  });

  // ── [12] Message Router & Bootstrap ───────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.command) return;

    if (msg.command === 'showRestartModal') {
      if (restartNowBtn) { restartNowBtn.disabled = false; restartNowBtn.textContent = t('ui.restartNow'); }
      openModal(restartModalOverlay, restartLaterBtn);
      return;
    }

    if (msg.command === 'updateState') {
      const { accounts, isOperating, operationMessage, privacyMode: backendPrivacy, lockedUids: backendLockedUids } = msg.data;
      currentAccounts = accounts || [];
      currentLockedUids = Array.isArray(backendLockedUids) ? backendLockedUids : [];
      if (msg.data.cooldownEvents !== undefined) lastCooldownEvents = msg.data.cooldownEvents;
      if (msg.data.tokenLedger !== undefined) lastTokenLedger = msg.data.tokenLedger;
      if (msg.data.cooldownEventsError) showToast(t('cooldown.readError') + ': ' + msg.data.cooldownEventsError, 'error');
      stopUsageRefreshSpin();
      if (msg.data && msg.data.settings) currentSettings = msg.data.settings;
      if (typeof backendPrivacy === 'boolean') { privacyMode = backendPrivacy; updatePrivacyUi(); }

      if (msg.data && msg.data.version) {
        const vEl = document.getElementById('currentVersionTag');
        if (vEl) vEl.textContent = 'v' + msg.data.version;
      }

      const isCnHost = msg.data.hostEdition !== 'intl';
      if (btnBatchCheckin) btnBatchCheckin.hidden = !isCnHost;
      if (btnGrowthTasks) btnGrowthTasks.hidden = !isCnHost;
      const cnOnlyHintEl = document.getElementById('cnOnlyHint');
      if (cnOnlyHintEl) cnOnlyHintEl.style.display = isCnHost ? 'none' : 'block';

      if (isOperating) {
        showToast(operationMessage || t('js.operatingFallback'), 'loading', 0, 'op');
      } else {
        removeToastByKey('op');
        stopRefreshAllSpin();
        checkingId = '';
        refreshingIds.clear();
        if (switchingId) clearSwitchPending();
      }

      renderSummary();
      renderTokenSummaryBar();
      renderCards();
      renderAcctChips();
      if (msg.data) {
        renderUsageRecords(msg.data.recentRecords, msg.data.usageSummary);
        if (msg.data.modelStats !== undefined) {
          lastModelStats = msg.data.modelStats;
          modelStatsSyncRequested = false;
          renderModelStats();
        }
        if (msg.data.tokenLedger !== undefined && usageModalOverlay && !usageModalOverlay.hidden && activeUsageTab === 'tokens') {
          tokenStatsFingerprint = '';
          renderTokenStats();
        }
      }
    } else if (msg.command === 'notify') {
      stopRefreshAllSpin();
      clearAcceptingTaskWatchdogs();
      let needCardRedraw = false;
      if (checkingId || refreshingIds.size > 0 || switchingId) {
        checkingId = '';
        refreshingIds.clear();
        clearSwitchPending();
        needCardRedraw = true;
      }
      if (needCardRedraw) renderCards();
      if (taskModalOverlay && !taskModalOverlay.hidden) renderTasks();
      const ttl = msg.detail ? 0 : ((msg.level === 'error' || msg.level === 'warn') ? 10000 : 3200);
      showToast(msg.message, msg.level === 'success' ? 'success' : (msg.level === 'warn' ? 'warn' : 'error'), ttl, '', msg.detail || '');
    } else if (msg.command === 'taskProgress') {
      if (typeof msg.percent === 'number') taskBatchProgressFill.style.width = msg.percent + '%';
      if (msg.text) { taskBatchProgressText.textContent = msg.text; appendProgressLine(msg.text, msg.level); }
    } else if (msg.command === 'taskBatchSummary') {
      const s = msg.data || {};
      taskProgressStage.hidden = true;
      taskResultStage.hidden = false;
      if (s.stopped) {
        taskResultMainTitle.textContent = t('js.stoppedTitle');
        taskResultIcon.style.color = 'var(--gh-red, #ef4444)';
        taskResultIcon.style.background = 'rgba(239, 68, 68, 0.12)';
        taskResultSubTitle.textContent = t('js.stoppedSub', s.durationSec || 1);
      } else if (s.totalFailures > 0) {
        taskResultMainTitle.textContent = t('js.failTitle');
        taskResultIcon.style.color = 'var(--gh-red, #ef4444)';
        taskResultIcon.style.background = 'rgba(239, 68, 68, 0.12)';
        taskResultSubTitle.textContent = t('js.failSub', s.durationSec || 1, s.totalFailures);
      } else if ((s.totalCredits || 0) === 0 && (s.totalClaimed || 0) === 0 && (s.totalAccepted || 0) === 0) {
        taskResultMainTitle.textContent = t('js.noGainTitle');
        taskResultIcon.style.color = 'var(--ac-blue, #3b82f6)';
        taskResultIcon.style.background = 'rgba(59, 130, 246, 0.1)';
        taskResultSubTitle.textContent = t('js.noGainSub', s.durationSec || 1);
      } else {
        taskResultMainTitle.textContent = t('js.doneTitle');
        taskResultIcon.style.color = 'var(--ac-emerald, #10b981)';
        taskResultIcon.style.background = 'rgba(16, 185, 129, 0.12)';
        taskResultSubTitle.textContent = t('js.doneSub', s.durationSec || 1, s.processedAccounts || 0, s.totalAccounts || 0);
      }
      resClaimedCredits.textContent = '+' + fmtNum(s.totalCredits || 0);
      resClaimedTasks.textContent = String(s.totalClaimed || 0);
      resAcceptedTasks.textContent = String(s.totalAccepted || 0);
      resSkippedTasks.textContent = String((s.totalSkipped || 0) + (s.totalFailures || 0));

      const details = s.details || [];
      taskResultDetails.innerHTML = details.length ? details.map((d) => {
        const rawName = d.accountName || t('common.account');
        const name = privacyMode ? maskName(rawName) : rawName;
        const color = d.status === 'ok' ? 'var(--ac-emerald, #10b981)' : d.status === 'stopped' ? 'var(--muted)' : 'var(--gh-red, #ef4444)';
        return '<div style="display:flex;justify-content:space-between;gap:8px;"><span style="font-weight:500;">' + escHtml(name) + '</span><span style="color:' + color + ';">' + escHtml(d.message || '') + '</span></div>';
      }).join('') : '<div style="color:var(--muted);text-align:center;">' + escHtml(t('js.noDetails')) + '</div>';
    } else if (msg.command === 'updateTasks') {
      clearAcceptingTaskWatchdogs();
      currentTasks = (msg.data && msg.data.tasks) || [];
      if (msg.data && msg.data.accountId) viewingAccountId = msg.data.accountId;
      const accName = (msg.data && msg.data.accountName) || '';
      if (accName) taskAccountSummary.textContent = (privacyMode ? maskName(accName) : accName) + t('js.viewingSuffix');

      if (msg.data && msg.data.assetSummary) {
        const a = msg.data.assetSummary;
        const travelText = document.getElementById('assetTravelText');
        const travelBadge = document.getElementById('assetTravelBadge');
        const streakText = document.getElementById('assetStreakText');
        const energyText = document.getElementById('assetEnergyText');
        if (travelText && travelBadge) {
          if (a.travelState === 'traveling') {
            travelText.textContent = t('js.travelWorking', a.travelLocationName || t('js.defaultLocation'), a.travelExpectedCredits ? t('js.estimateCredits', a.travelExpectedCredits) : t('js.canEarnCredits'), a.travelEtaHours ? t('js.etaHours', a.travelEtaHours) : '');
            travelBadge.textContent = t('js.workingBadge');
            travelBadge.className = 'task-badge is-warn';
          } else if (a.travelState === 'arrived') {
            travelText.textContent = t('js.arrivedText');
            travelBadge.textContent = t('js.arrivedBadge');
            travelBadge.className = 'task-badge is-ok';
          } else if (a.travelDailyLimit) {
            travelText.textContent = t('js.travelLimitText');
            travelBadge.textContent = t('js.restBadge');
            travelBadge.className = 'task-badge is-muted';
          } else {
            travelText.textContent = t('js.idleText');
            travelBadge.textContent = t('js.idleBadge');
            travelBadge.className = 'task-badge is-ok';
          }
        }
        if (streakText) streakText.textContent = t('js.streakText', a.streakDays, a.nextTier, a.nextTierRemaining, a.makeupCards > 0 ? t('js.makeupCardsSuffix', a.makeupCards) : '');
        if (energyText) energyText.textContent = t('js.energyText', a.energyBalance, a.energyAffordableBoxes > 0 ? t('js.energyBoxesSuffix', a.energyAffordableBoxes) : '');
      }
      document.getElementById('taskSkeleton').style.display = 'none';
      renderTasks();
    }
  });

  vscode.postMessage({ command: 'webviewReady' });
})();
