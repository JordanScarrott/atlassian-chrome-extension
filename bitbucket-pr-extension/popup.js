import {
  AUTH_SETUP_LINKS,
  CENTRAL_URLS,
  DECISION_MODELS,
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  getEffectiveGitHubApiBaseUrl,
  getEffectiveJiraBaseUrl,
  sanitizeDecisionEndpointUrl,
  sanitizeHttpsUrl
} from './src/config.js';
import { isPrSnoozed } from './src/pr-triage.js';
import {
  highlightSelectedPrCard,
  navigateDeckSlideInContainer
} from './src/ui/pr-card-renderer.js';
import {
  hideSettingsDrawer,
  readValidatedCredentialInputs,
  readValidatedDecisionInputs,
  readValidatedGitHubInputs,
  readValidatedPreferencesInputs,
  renderAccountSection,
  renderPreferencesForm,
  renderSettingsSubtab,
  resolveAccountSectionElements,
  resolvePreferencesFormElements,
  resolveSettingsDrawerControls,
  showInlineBanner,
  showSettingsDrawer,
  syncAuthMethodFields,
  syncDecisionProviderFields,
  toggleSecretInputVisibility
} from './src/ui/settings-renderer.js';
import {
  TOP_TABS,
  hasQuickWinsFilterToken,
  refreshRelativeTimestampsInDom,
  renderAddProductForm,
  renderBitbucketTab as renderBitbucketTabView,
  renderConfluenceTab as renderConfluenceTabView,
  renderFooterTimestamp,
  renderHeaderStatusChip,
  renderJiraTab as renderJiraTabView,
  renderShortcutsPopoverState,
  renderStaticMetadata,
  renderSyncLoadingState,
  renderTopTabSelection,
  resolveBitbucketTabElements,
  resolveJiraTabElements,
  resolveShellDomElements,
  showToastBanner
} from './src/ui/tabs-renderer.js';

/** @typedef {import('./src/config.js').Preferences} Preferences */
/** @typedef {import('./src/pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('./src/pr-triage.js').PrCounts} PrCounts */
/** @typedef {import('./src/pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('./src/storage.js').AuthType} AuthType */
/** @typedef {import('./src/storage.js').CachedUser} CachedUser */
/** @typedef {import('./src/storage.js').DecisionProvider} DecisionProvider */
/** @typedef {import('./src/storage.js').PrSnapshot} PrSnapshot */
/** @typedef {import('./src/storage.js').ProductFeedbackState} ProductFeedbackState */
/** @typedef {import('./src/storage.js').SnoozedMap} SnoozedMap */
/** @typedef {import('./src/storage.js').SyncState} SyncState */
/** @typedef {import('./src/storage.js').WorkspaceSummary} WorkspaceSummary */
/** @typedef {import('./src/ui/pr-card-renderer.js').PrCardCallbacks} PrCardCallbacks */
/** @typedef {import('./src/ui/settings-renderer.js').DecisionBootstrapState} DecisionBootstrapState */

/**
 * @typedef {Object} GitHubBootstrapState
 * @property {boolean} isAuthenticated
 * @property {string} apiBaseUrl
 * @property {CachedUser | null} user
 */

/**
 * @typedef {Object} WorkerBootstrapState
 * @property {boolean} isAuthenticated
 * @property {boolean} [bitbucketAuthenticated]
 * @property {AuthType} authType
 * @property {string} username
 * @property {CachedUser | null} user
 * @property {GitHubBootstrapState} [github]
 * @property {DecisionBootstrapState} [decision]
 * @property {WorkspaceSummary[]} workspaces
 * @property {boolean} [isAuthError]
 * @property {Omit<PrSnapshot, 'prList'> & { prList: EnrichedPullRequest[], isAuthError?: boolean }} snapshot
 * @property {Preferences} preferences
 * @property {SyncState} syncState
 * @property {SnoozedMap} snoozedMap
 * @property {PrCounts} counts
 * @property {ProductFeedbackState} productFeedback
 */

const SNOOZE_FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** @type {ReadonlySet<string>} */
const WATCHED_STORAGE_KEYS = new Set([
  STORAGE_KEYS.AUTH_TYPE,
  STORAGE_KEYS.BITBUCKET_USERNAME,
  STORAGE_KEYS.BITBUCKET_TOKEN,
  STORAGE_KEYS.GITHUB_TOKEN,
  STORAGE_KEYS.GITHUB_API_BASE_URL,
  STORAGE_KEYS.CACHED_GITHUB_USER,
  STORAGE_KEYS.DECISION_CONFIG,
  STORAGE_KEYS.PREFERENCES,
  STORAGE_KEYS.CACHED_USER,
  STORAGE_KEYS.CACHED_WORKSPACES,
  STORAGE_KEYS.PR_LIST,
  STORAGE_KEYS.LAST_UPDATED,
  STORAGE_KEYS.ERROR,
  STORAGE_KEYS.RATE_LIMIT_WARNING,
  STORAGE_KEYS.SYNCED_WORKSPACES,
  STORAGE_KEYS.SYNC_STATE,
  STORAGE_KEYS.SNOOZED_PRS
]);

/**
 * Send a typed message to the MV3 background service worker, checking `chrome.runtime.lastError`.
 *
 * @template {Record<string, any>} [T=Record<string, any>]
 * @param {Record<string, unknown>} payload
 * @returns {Promise<T>}
 */
function sendWorkerMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'Could not communicate with background worker.'));
        return;
      }
      resolve(/** @type {T} */ (response ?? {}));
    });
  });
}

/**
 * Create a clean default bootstrap state before the initial worker response resolves.
 *
 * @returns {WorkerBootstrapState}
 */
function createEmptyState() {
  return {
    isAuthenticated: false,
    bitbucketAuthenticated: false,
    authType: 'api_token',
    username: '',
    user: null,
    github: {
      isAuthenticated: false,
      apiBaseUrl: getEffectiveGitHubApiBaseUrl(),
      user: null
    },
    decision: {
      provider: DECISION_MODELS.DEFAULT_PROVIDER,
      baseUrl: '',
      model: '',
      isConfigured: false
    },
    workspaces: [],
    snapshot: {
      prList: [],
      lastUpdated: null,
      error: null,
      rateLimitWarning: false,
      syncedWorkspaces: []
    },
    preferences: { ...DEFAULT_PREFERENCES },
    syncState: {
      inFlightSince: null,
      lastManualSyncAt: null,
      backoffUntil: null,
      consecutiveFailures: 0
    },
    snoozedMap: {},
    counts: {
      actionRequired: 0,
      reviewing: 0,
      authored: 0,
      all: 0,
      snoozed: 0
    },
    productFeedback: {
      requestedProducts: [],
      productFeedback: '',
      productFeedbackTimestamp: null
    }
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  // --- DOM References ---
  const shellEls = resolveShellDomElements();
  const {
    appTitle,
    connectionStatusChip,
    connectionStatusText,
    manualRefreshBtn,
    toggleSettingsBtn,
    tabButtons,
    tabPanels,
    prSearchInput,
    loadingIndicator,
    clearRelatedScopeBtn,
    setupHintBtn,
    setupHintGitHubBtn,
    jiraOpenPrefsBtn,
    confluenceConfiguredCard,
    confluencePlaceholderCard,
    openConfluenceBtn,
    addProductForm,
    customProductFeedbackInput,
    productRequestSuccessAlert,
    lastUpdatedText,
    shortcutsToggleBtn,
    shortcutsPopover,
    closeShortcutsBtn,
    appVersionEl,
    toastContainer
  } = shellEls;

  const settingsControls = resolveSettingsDrawerControls();
  const { settingsPanel, settingsAccountTab, settingsPreferencesTab } = settingsControls;

  const accountSectionElements = resolveAccountSectionElements();
  const preferencesFormElements = resolvePreferencesFormElements();
  const bitbucketTabElements = resolveBitbucketTabElements();
  const jiraTabElements = resolveJiraTabElements();

  const {
    prSearchClearBtn,
    quickWinsBtn,
    groupByTicketBtn,
    errorSetupBtn,
    prItemsContainer,
    emptyStateActionBtn
  } = bitbucketTabElements;
  const { openJiraBtn, jiraConnectBtn } = jiraTabElements;

  // --- Popup View State ---
  /** @type {WorkerBootstrapState} */
  let state = createEmptyState();
  /** @type {string} */
  let activeTabId = 'bitbucket-tab';
  /** @type {PrFilter} */
  let activeFilter = DEFAULT_PREFERENCES.defaultFilter;
  /** @type {string} */
  let searchQuery = '';
  /** @type {string | null} */
  let activeRelatedTicketKey = null;
  /** @type {string | null} */
  let selectedPrKey = null;
  /** @type {EnrichedPullRequest[]} */
  let visiblePrs = [];
  /** @type {EnrichedPullRequest[]} */
  let navigablePrs = [];
  /** @type {Set<string>} */
  const collapsedGroups = new Set();
  /** @type {Set<string>} */
  const expandedStackGroups = new Set();
  /** @type {Map<string, number>} */
  const deckActiveSlideMap = new Map();
  /** @type {boolean} */
  let isReplacingToken = false;
  /** @type {boolean} */
  let isReplacingGitHubToken = false;
  /** @type {boolean} */
  let isConfiguringDecision = false;
  /** @type {boolean} */
  let isSyncing = false;
  /** @type {boolean} */
  let isGroupByTicketUpdating = false;
  /** @type {number | null} */
  let storageRefreshTimer = null;
  /** @type {number | null} */
  let productFeedbackTimer = null;
  /** @type {number} */
  let suppressStorageRefreshUntil = 0;
  /** @type {number} */
  let stateRequestSeq = 0;

  /** @type {{ currentTimer: number | null }} */
  const toastTimerRef = { currentTimer: null };

  // --- Helper Utilities ---

  /**
   * Determine whether Bitbucket Cloud is currently authenticated.
   *
   * @returns {boolean}
   */
  function isBitbucketAuthenticated() {
    if (typeof state.bitbucketAuthenticated === 'boolean') {
      return state.bitbucketAuthenticated;
    }
    return Boolean(state.isAuthenticated && !state.github?.isAuthenticated);
  }

  /**
   * Determine whether GitHub is currently authenticated.
   *
   * @returns {boolean}
   */
  function isGitHubAuthenticated() {
    return Boolean(state.github?.isAuthenticated);
  }

  /**
   * Show a non-blocking toast message that auto-dismisses, with an optional inline action button.
   *
   * @param {string} message
   * @param {'neutral' | 'success' | 'error'} [variant]
   * @param {{ actionLabel?: string, onAction?: () => void | Promise<unknown>, durationMs?: number }} [options]
   */
  function showToast(message, variant = 'neutral', options = {}) {
    toastTimerRef.currentTimer = showToastBanner(toastContainer, message, variant, options, toastTimerRef);
  }

  /**
   * Validate and open an external `https://` URL in a new Chrome tab.
   *
   * @param {unknown} rawUrl
   * @returns {Promise<boolean>}
   */
  async function openSafeExternalUrl(rawUrl) {
    const safeUrl = sanitizeHttpsUrl(rawUrl);
    if (!safeUrl) {
      showToast('Blocked unsafe or unconfigured URL.', 'error');
      return false;
    }
    await chrome.tabs.create({ url: safeUrl });
    return true;
  }

  /**
   * Toggle between top-level product tabs (`bitbucket-tab`, `jira-tab`, `confluence-tab`, `add-product-tab`).
   *
   * @param {string} nextTabId
   */
  function switchTopTab(nextTabId) {
    if (renderTopTabSelection({ tabButtons, tabPanels, appTitle }, nextTabId)) {
      activeTabId = nextTabId;
    }
  }

  /**
   * Toggle between Settings drawer sub-tabs (`account` and `preferences`).
   *
   * @param {'account' | 'preferences'} subtab
   */
  function switchSettingsSubtab(subtab) {
    renderSettingsSubtab(
      {
        settingsAccountTab,
        settingsPreferencesTab,
        settingsAccountPanel: settingsControls.settingsAccountPanel,
        settingsPreferencesPanel: settingsControls.settingsPreferencesPanel
      },
      subtab
    );
  }

  /**
   * Populate Settings -> Account & Setup UI (Bitbucket Cloud + GitHub + System One AI Triage).
   */
  function populateAccountSection() {
    renderAccountSection(
      accountSectionElements,
      {
        bitbucketAuthenticated: isBitbucketAuthenticated(),
        isReplacingToken,
        authType: state.authType,
        username: state.username,
        user: state.user,
        workspaces: state.workspaces,
        syncedWorkspaces: state.snapshot.syncedWorkspaces,
        githubAuthenticated: isGitHubAuthenticated(),
        isReplacingGitHubToken,
        githubApiBaseUrl: state.github?.apiBaseUrl || '',
        githubUser: state.github?.user ?? null,
        decision: state.decision,
        isConfiguringDecision
      },
      { decisionTestBtn: settingsControls.decisionTestBtn }
    );
  }

  /**
   * Populate Settings -> Preferences inputs from `state.preferences`.
   *
   * @param {Preferences} prefs
   */
  function populatePreferencesForm(prefs) {
    renderPreferencesForm(preferencesFormElements, prefs, state.workspaces);
  }

  /**
   * Open the Settings drawer to a chosen sub-tab (`account` or `preferences`).
   *
   * @param {'account' | 'preferences'} [subtab]
   * @param {boolean | { forceReplaceBitbucket?: boolean, forceReplaceGitHub?: boolean, focusTarget?: 'bitbucket' | 'github' }} [optionsOrForceReplace]
   */
  function openSettingsPanel(subtab = 'account', optionsOrForceReplace = false) {
    const opts = typeof optionsOrForceReplace === 'boolean'
      ? { forceReplaceBitbucket: optionsOrForceReplace }
      : optionsOrForceReplace;

    if (opts.forceReplaceBitbucket) {
      isReplacingToken = true;
    }
    if (opts.forceReplaceGitHub) {
      isReplacingGitHubToken = true;
    }

    populateAccountSection();
    populatePreferencesForm(state.preferences);
    switchSettingsSubtab(subtab);
    closeShortcutsPopover();
    showSettingsDrawer(
      {
        settingsPanel,
        toggleSettingsBtn,
        githubCredentialsForm: accountSectionElements.githubCredentialsForm,
        githubTokenInput: accountSectionElements.githubTokenInput,
        githubReplaceTokenBtn: settingsControls.githubReplaceTokenBtn,
        credentialsForm: accountSectionElements.credentialsForm,
        authTypeSelect: accountSectionElements.authTypeSelect,
        bitbucketUsernameInput: accountSectionElements.bitbucketUsernameInput,
        bitbucketTokenInput: accountSectionElements.bitbucketTokenInput,
        replaceTokenBtn: settingsControls.replaceTokenBtn,
        prefPollInterval: preferencesFormElements.prefPollInterval
      },
      subtab,
      opts.focusTarget
    );
  }

  /**
   * Close the Settings drawer and discard any unsaved form edits.
   */
  function closeSettingsPanel() {
    isReplacingToken = false;
    isReplacingGitHubToken = false;
    isConfiguringDecision = false;
    populateAccountSection();
    populatePreferencesForm(state.preferences);
    hideSettingsDrawer(settingsPanel, toggleSettingsBtn);
  }

  /**
   * Toggle shortcuts cheat-sheet popover.
   *
   * @param {boolean} [forceOpen]
   */
  function toggleShortcutsPopover(forceOpen) {
    renderShortcutsPopoverState(shortcutsPopover, shortcutsToggleBtn, forceOpen);
  }

  /**
   * Hide shortcuts cheat-sheet popover.
   */
  function closeShortcutsPopover() {
    toggleShortcutsPopover(false);
  }

  /**
   * Update loading spinner & refresh button disabled state.
   *
   * @param {boolean} loading
   */
  function setSyncLoading(loading) {
    isSyncing = loading;
    renderSyncLoadingState(loadingIndicator, manualRefreshBtn, loading);
  }

  /**
   * Highlight a PR card as keyboard-selected and align its DOM focus/scroll state.
   *
   * @param {string | null} prKey
   * @param {boolean} [scrollIntoView]
   */
  function selectPrCard(prKey, scrollIntoView = true) {
    selectedPrKey = prKey;
    highlightSelectedPrCard(prItemsContainer, prKey, { scrollIntoView, collapsedGroups });
  }

  /**
   * Sync the `#group-by-ticket-btn` visual toggle state from `state.preferences.groupByTicket`.
   */
  function renderGroupByTicketToggle() {
    const enabled = Boolean(state.preferences.groupByTicket);
    groupByTicketBtn.classList.toggle('active', enabled);
    groupByTicketBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    groupByTicketBtn.disabled = isGroupByTicketUpdating;
  }

  /** @type {PrCardCallbacks} */
  const prCardCallbacks = {
    onOpenUrl: (rawUrl) => openSafeExternalUrl(rawUrl),
    onCopyUrl: (pr) => copyPrLink(pr),
    onToggleSnooze: (pr) => toggleSnoozePr(pr),
    onSelectCard: (prKey, scrollIntoView = false) => {
      selectPrCard(prKey, scrollIntoView);
    },
    onSelectRelatedTicket: (ticketKey) => {
      activeRelatedTicketKey = ticketKey;
      selectedPrKey = null;
      renderBitbucketTab();
    },
    onGroupCollapseToggle: (groupKey, nextCollapsed) => {
      if (nextCollapsed) {
        collapsedGroups.add(groupKey);
      } else {
        collapsedGroups.delete(groupKey);
      }
    },
    onDeckIndexChange: (groupKey, slideIndex) => {
      deckActiveSlideMap.set(groupKey, slideIndex);
    },
    onDeckExpandToggle: (groupKey, nextExpanded) => {
      if (nextExpanded) {
        expandedStackGroups.add(groupKey);
      } else {
        expandedStackGroups.delete(groupKey);
      }
    }
  };

  /**
   * Render the PR list tab via `tabs-renderer.js`.
   */
  function renderBitbucketTab() {
    const result = renderBitbucketTabView(
      bitbucketTabElements,
      {
        isAuthenticated: state.isAuthenticated,
        bitbucketAuthenticated: isBitbucketAuthenticated(),
        githubAuthenticated: isGitHubAuthenticated(),
        isAuthError: Boolean(state.snapshot.isAuthError || state.isAuthError),
        isGroupByTicketUpdating,
        prList: state.snapshot.prList,
        error: state.snapshot.error,
        rateLimitWarning: state.snapshot.rateLimitWarning,
        backoffUntil: state.syncState.backoffUntil,
        preferences: state.preferences,
        snoozedMap: state.snoozedMap,
        activeFilter,
        searchQuery,
        activeRelatedTicketKey,
        selectedPrKey,
        collapsedGroups,
        expandedStackGroups,
        deckActiveSlideMap
      },
      prCardCallbacks
    );

    visiblePrs = result.visiblePrs;
    navigablePrs = result.navigablePrs;
    selectedPrKey = result.selectedPrKey;
    activeRelatedTicketKey = result.activeRelatedTicketKey;
  }

  /**
   * Render the Jira tab via `tabs-renderer.js`.
   */
  function renderJiraTab() {
    renderJiraTabView(
      jiraTabElements,
      {
        isAuthenticated: state.isAuthenticated,
        preferences: state.preferences,
        prList: state.snapshot.prList,
        snoozedMap: state.snoozedMap
      },
      {
        onFilterPrsByTicket: (ticketKey) => {
          activeRelatedTicketKey = null;
          activeFilter = 'all';
          selectedPrKey = null;
          searchQuery = ticketKey;
          prSearchInput.value = ticketKey;
          switchTopTab('bitbucket-tab');
          renderBitbucketTab();
          prItemsContainer.focus();
          prSearchInput.focus();
        },
        onOpenUrl: (rawUrl) => openSafeExternalUrl(rawUrl),
        onOpenJiraUrlSettings: () => {
          openSettingsPanel('preferences');
          preferencesFormElements.prefJiraUrl.focus();
        }
      }
    );
  }

  /**
   * Render all UI regions from current `state`.
   */
  function renderAll() {
    renderHeaderStatusChip(
      { connectionStatusChip, connectionStatusText },
      {
        bitbucketAuthenticated: isBitbucketAuthenticated(),
        bitbucketUser: state.user,
        bitbucketUsername: state.username,
        github: state.github,
        syncedWorkspaces: state.snapshot.syncedWorkspaces,
        workspaces: state.workspaces,
        error: state.snapshot.error,
        rateLimitWarning: state.snapshot.rateLimitWarning,
        backoffUntil: state.syncState.backoffUntil
      }
    );
    renderFooterTimestamp(lastUpdatedText, state.snapshot.lastUpdated);
    renderBitbucketTab();
    renderJiraTab();
    renderConfluenceTabView({ confluenceConfiguredCard, confluencePlaceholderCard });

    // Only refresh Settings form inputs when drawer is closed to avoid clobbering active user edits
    if (settingsPanel.classList.contains('hidden')) {
      populateAccountSection();
      populatePreferencesForm(state.preferences);
    }
  }

  /**
   * Fetch sanitized state from background service worker and update UI.
   *
   * @param {{ applyDefaultFilter?: boolean, updateAddProduct?: boolean }} [options]
   */
  async function refreshStateFromWorker(options = {}) {
    stateRequestSeq += 1;
    const reqId = stateRequestSeq;
    const nextState = await sendWorkerMessage({ action: 'GET_STATE' });
    if (reqId !== stateRequestSeq) {
      return;
    }
    if (nextState && typeof nextState === 'object' && 'snapshot' in nextState) {
      state = /** @type {WorkerBootstrapState} */ (/** @type {unknown} */ (nextState));
      if (options.applyDefaultFilter) {
        activeFilter = state.preferences.defaultFilter || DEFAULT_PREFERENCES.defaultFilter;
      }
      if (options.updateAddProduct) {
        renderAddProductForm(addProductForm, customProductFeedbackInput, state.productFeedback);
      }
      renderAll();
    }
  }

  /**
   * Suppress redundant `chrome.storage.onChanged` reloads briefly after a local action already fetched fresh state.
   */
  function markLocalStateMutation() {
    suppressStorageRefreshUntil = Date.now() + 250;
  }

  /**
   * Refresh footer and PR card relative timestamps in-place every 30s without rebuilding the PR DOM.
   */
  function refreshLiveTimestamps() {
    renderFooterTimestamp(lastUpdatedText, state.snapshot.lastUpdated);
    const hasSnoozeBadges = refreshRelativeTimestampsInDom(prItemsContainer, Date.now());
    if (activeTabId === 'bitbucket-tab' && activeFilter === 'snoozed' && hasSnoozeBadges) {
      renderBitbucketTab();
    }
  }

  // --- User Actions ---

  /**
   * Trigger a manual PR sync via the background service worker.
   */
  async function triggerManualSync() {
    if (isSyncing) {
      return;
    }
    if (!state.isAuthenticated) {
      openSettingsPanel('account');
      showToast('Connect Bitbucket or GitHub first to sync PRs.');
      return;
    }

    setSyncLoading(true);
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({
        action: 'SYNC_NOW',
        forceManual: true
      });
      await refreshStateFromWorker();
      markLocalStateMutation();

      if (res.skipped && res.reason === 'cooldown') {
        const secs = Math.max(1, Math.ceil((Number(res.retryInMs) || 1000) / 1000));
        showToast(`Recently synced — wait ${secs}s before refreshing again.`);
      } else if (res.skipped && res.reason === 'in_flight') {
        showToast('Sync already in progress...');
      } else if (res.ok === false && res.error) {
        showToast(String(res.error), 'error');
      } else {
        showToast('Pull requests synced.', 'success');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to sync pull requests.';
      showToast(msg, 'error');
    } finally {
      setSyncLoading(false);
    }
  }

  /**
   * Toggle `preferences.groupByTicket` and persist via `UPDATE_PREFERENCES`.
   */
  async function toggleGroupByTicket() {
    if (isGroupByTicketUpdating || !state.isAuthenticated) {
      return;
    }
    const nextGroupByTicket = !Boolean(state.preferences.groupByTicket);
    activeRelatedTicketKey = null;
    selectedPrKey = null;

    state.preferences = {
      ...state.preferences,
      groupByTicket: nextGroupByTicket
    };
    renderBitbucketTab();

    isGroupByTicketUpdating = true;
    renderGroupByTicketToggle();
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({
        action: 'UPDATE_PREFERENCES',
        preferences: { ...state.preferences, groupByTicket: nextGroupByTicket }
      });
      if (res.ok === false) {
        showToast(String(res.error || 'Could not update grouping preference.'), 'error');
        await refreshStateFromWorker();
        return;
      }
      await refreshStateFromWorker();
      markLocalStateMutation();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update grouping preference.', 'error');
      await refreshStateFromWorker();
    } finally {
      isGroupByTicketUpdating = false;
      renderGroupByTicketToggle();
    }
  }

  /**
   * Copy a PR's validated HTTPS URL to the clipboard.
   *
   * @param {EnrichedPullRequest} pr
   */
  async function copyPrLink(pr) {
    const safeUrl = sanitizeHttpsUrl(pr.url);
    if (!safeUrl) {
      showToast('Cannot copy invalid PR URL.', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(safeUrl);
      showToast(`Copied link for #${pr.id}`, 'success');
    } catch {
      showToast('Clipboard permission unavailable.', 'error');
    }
  }

  /**
   * Undo a PR snooze from the inline toast action button.
   *
   * @param {EnrichedPullRequest} pr
   */
  async function undoSnoozePr(pr) {
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'UNSNOOZE_PR', prKey: pr.key });
      if (res.ok === false) {
        showToast(String(res.error || 'Could not undo snooze.'), 'error');
        return;
      }
      await refreshStateFromWorker();
      markLocalStateMutation();
      showToast(`Restored #${pr.id}`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to undo snooze.', 'error');
    }
  }

  /**
   * Snooze a PR for 4h or unsnooze it immediately via the background service worker.
   *
   * @param {EnrichedPullRequest} pr
   */
  async function toggleSnoozePr(pr) {
    const currentlySnoozed = isPrSnoozed(pr, state.snoozedMap);
    try {
      markLocalStateMutation();
      const res = currentlySnoozed
        ? await sendWorkerMessage({ action: 'UNSNOOZE_PR', prKey: pr.key })
        : await sendWorkerMessage({
          action: 'SNOOZE_PR',
          prKey: pr.key,
          durationMs: SNOOZE_FOUR_HOURS_MS,
          prUpdatedOn: pr.updatedOn
        });

      if (res.ok === false) {
        showToast(String(res.error || 'Could not update snooze state.'), 'error');
        return;
      }

      await refreshStateFromWorker();
      markLocalStateMutation();

      if (currentlySnoozed) {
        showToast(`Unsnoozed #${pr.id}`, 'success');
      } else {
        showToast('Snoozed for 4h (auto-unsnoozes on update)', 'success', {
          actionLabel: 'Undo',
          onAction: () => undoSnoozePr(pr)
        });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update snooze.', 'error');
    }
  }

  /**
   * Disable/enable Bitbucket Account form controls during async verification or saving.
   *
   * @param {boolean} busy
   */
  function setCredentialsFormBusy(busy) {
    settingsControls.testConnectionBtn.disabled = busy;
    settingsControls.saveSettingsBtn.disabled = busy;
    settingsControls.cancelSettingsBtn.disabled = busy;
  }

  /**
   * Test entered Bitbucket credentials without persisting them.
   */
  async function handleTestConnection() {
    const creds = readValidatedCredentialInputs(accountSectionElements);
    if (!creds) {
      return;
    }

    setCredentialsFormBusy(true);
    showInlineBanner(accountSectionElements.authStatusBanner, 'Testing Bitbucket connection...', 'info');
    try {
      const res = await sendWorkerMessage({ action: 'TEST_CONNECTION', creds });
      if (res.ok) {
        const name = res.user?.displayName || 'Bitbucket User';
        const wsCount = Array.isArray(res.workspaces) ? res.workspaces.length : 0;
        showInlineBanner(
          accountSectionElements.authStatusBanner,
          `Verified as ${name} (${wsCount} accessible workspace${wsCount === 1 ? '' : 's'}).`,
          'success'
        );
      } else {
        showInlineBanner(accountSectionElements.authStatusBanner, String(res.error || 'Verification failed.'), 'error');
      }
    } catch (err) {
      showInlineBanner(
        accountSectionElements.authStatusBanner,
        err instanceof Error ? err.message : 'Failed to test connection.',
        'error'
      );
    } finally {
      setCredentialsFormBusy(false);
    }
  }

  /**
   * Verify, save Bitbucket credentials, trigger immediate sync, and close Settings on success.
   *
   * @param {SubmitEvent} e
   */
  async function handleSaveCredentials(e) {
    e.preventDefault();
    const creds = readValidatedCredentialInputs(accountSectionElements);
    if (!creds) {
      return;
    }

    setCredentialsFormBusy(true);
    showInlineBanner(accountSectionElements.authStatusBanner, 'Verifying and syncing pull requests...', 'info');
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'SAVE_CREDENTIALS', creds });
      if (!res.ok) {
        showInlineBanner(accountSectionElements.authStatusBanner, String(res.error || 'Could not save credentials.'), 'error');
        return;
      }

      accountSectionElements.bitbucketTokenInput.value = '';
      isReplacingToken = false;
      await refreshStateFromWorker({ applyDefaultFilter: true });
      markLocalStateMutation();
      closeSettingsPanel();
      showToast('Bitbucket connected & synced!', 'success');
    } catch (err) {
      showInlineBanner(
        accountSectionElements.authStatusBanner,
        err instanceof Error ? err.message : 'Failed to save credentials.',
        'error'
      );
    } finally {
      setCredentialsFormBusy(false);
    }
  }

  /**
   * Disable/enable GitHub Account form controls during async verification or saving.
   *
   * @param {boolean} busy
   */
  function setGitHubFormBusy(busy) {
    settingsControls.testGitHubConnectionBtn.disabled = busy;
    settingsControls.saveGitHubSettingsBtn.disabled = busy;
    settingsControls.cancelGitHubSettingsBtn.disabled = busy;
  }

  /**
   * Test entered GitHub PAT credentials without persisting them.
   */
  async function handleTestGitHubConnection() {
    const creds = readValidatedGitHubInputs(accountSectionElements);
    if (!creds) {
      return;
    }

    setGitHubFormBusy(true);
    showInlineBanner(accountSectionElements.githubAuthStatusBanner, 'Testing GitHub connection...', 'info');
    try {
      const res = await sendWorkerMessage({ action: 'TEST_GITHUB_CONNECTION', creds });
      if (res.ok) {
        const display = res.user?.displayName || 'GitHub User';
        const login = res.user?.username ? `@${res.user.username}` : '';
        const identity = login && display !== res.user?.username ? `${display} (${login})` : (login || display);
        showInlineBanner(accountSectionElements.githubAuthStatusBanner, `Verified as ${identity}.`, 'success');
      } else {
        showInlineBanner(accountSectionElements.githubAuthStatusBanner, String(res.error || 'GitHub verification failed.'), 'error');
      }
    } catch (err) {
      showInlineBanner(
        accountSectionElements.githubAuthStatusBanner,
        err instanceof Error ? err.message : 'Failed to test GitHub connection.',
        'error'
      );
    } finally {
      setGitHubFormBusy(false);
    }
  }

  /**
   * Verify, save GitHub credentials, trigger immediate sync, and close Settings on success.
   *
   * @param {SubmitEvent} e
   */
  async function handleSaveGitHubCredentials(e) {
    e.preventDefault();
    const creds = readValidatedGitHubInputs(accountSectionElements);
    if (!creds) {
      return;
    }

    setGitHubFormBusy(true);
    showInlineBanner(accountSectionElements.githubAuthStatusBanner, 'Verifying and syncing GitHub pull requests...', 'info');
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'SAVE_GITHUB_CREDENTIALS', creds });
      if (!res.ok) {
        showInlineBanner(accountSectionElements.githubAuthStatusBanner, String(res.error || 'Could not save GitHub credentials.'), 'error');
        return;
      }

      accountSectionElements.githubTokenInput.value = '';
      isReplacingGitHubToken = false;
      await refreshStateFromWorker({ applyDefaultFilter: true });
      markLocalStateMutation();
      closeSettingsPanel();
      showToast('GitHub connected & synced!', 'success');
    } catch (err) {
      showInlineBanner(
        accountSectionElements.githubAuthStatusBanner,
        err instanceof Error ? err.message : 'Failed to save GitHub credentials.',
        'error'
      );
    } finally {
      setGitHubFormBusy(false);
    }
  }

  /**
   * Toggle `effort:quick` token inside the search filter bar from `#quick-wins-btn`.
   */
  function toggleQuickWinsFilter() {
    if (!state.isAuthenticated) {
      return;
    }
    activeRelatedTicketKey = null;
    selectedPrKey = null;

    const currentlyActive = hasQuickWinsFilterToken(searchQuery);
    if (currentlyActive) {
      const remainingTokens = searchQuery
        .trim()
        .split(/\s+/)
        .filter((token) => token.toLowerCase() !== 'effort:quick');
      searchQuery = remainingTokens.join(' ');
    } else {
      const trimmed = searchQuery.trim();
      searchQuery = trimmed ? `${trimmed} effort:quick` : 'effort:quick';
    }

    prSearchInput.value = searchQuery;
    renderBitbucketTab();
  }

  /**
   * Disable/enable System One AI Triage form controls during async verification or saving.
   *
   * @param {boolean} busy
   */
  function setDecisionFormBusy(busy) {
    const isOff = accountSectionElements.decisionProviderSelect.value === 'off';
    settingsControls.decisionTestBtn.disabled = busy || isOff;
    settingsControls.decisionSaveBtn.disabled = busy;
    settingsControls.decisionCancelBtn.disabled = busy;
  }

  /**
   * Request optional Chrome host permission for custom non-default Decision Model endpoints
   * (e.g. internal Jev / Clef Flash servers) before testing or saving.
   *
   * @param {DecisionProvider} provider
   * @param {string} baseUrl
   * @returns {Promise<boolean>}
   */
  async function ensureDecisionHostPermission(provider, baseUrl) {
    if (provider !== 'jev' || !baseUrl) {
      return true;
    }
    const safeUrl = sanitizeDecisionEndpointUrl(baseUrl);
    if (!safeUrl) {
      return false;
    }

    let originPattern;
    try {
      const parsed = new URL(safeUrl);
      const defaultJevUrl = sanitizeDecisionEndpointUrl(DECISION_MODELS.JEV_API_BASE_URL);
      const defaultJevOrigin = defaultJevUrl ? new URL(defaultJevUrl).origin : '';
      const geminiOrigin = new URL(DECISION_MODELS.GEMINI_DECISIONS_URL).origin;
      if (parsed.origin === geminiOrigin || (defaultJevOrigin && parsed.origin === defaultJevOrigin)) {
        return true;
      }
      originPattern = `${parsed.origin}/*`;
    } catch {
      return false;
    }

    const requestPermission = chrome?.permissions?.request;
    if (typeof requestPermission !== 'function') {
      return true;
    }

    try {
      const granted = await requestPermission.call(chrome.permissions, { origins: [originPattern] });
      if (!granted) {
        showInlineBanner(
          accountSectionElements.decisionStatusBanner,
          `Host permission denied for ${originPattern}. Grant site access to allow scoring requests.`,
          'warning'
        );
        return false;
      }
      return true;
    } catch (err) {
      showInlineBanner(
        accountSectionElements.decisionStatusBanner,
        err instanceof Error ? err.message : `Could not request host permission for ${originPattern}.`,
        'warning'
      );
      return false;
    }
  }

  /**
   * Test System One Decision Model configuration without persisting it.
   */
  async function handleTestDecisionModel() {
    const config = readValidatedDecisionInputs(accountSectionElements, {
      currentProvider: state.decision?.provider,
      isConfigured: state.decision?.isConfigured
    });
    if (!config || config.provider === 'off') {
      return;
    }

    setDecisionFormBusy(true);
    const hasPermission = await ensureDecisionHostPermission(config.provider, config.baseUrl);
    if (!hasPermission) {
      setDecisionFormBusy(false);
      return;
    }

    showInlineBanner(accountSectionElements.decisionStatusBanner, 'Testing Decision Model connection...', 'info');
    try {
      const res = await sendWorkerMessage({ action: 'TEST_DECISION_MODEL', config });
      if (res.ok) {
        const providerName = res.provider === 'gemini' ? 'Gemini Decision 1' : 'Jev / Clef Flash';
        showInlineBanner(
          accountSectionElements.decisionStatusBanner,
          `Verified ${providerName} (${String(res.model || config.model)}).`,
          'success'
        );
      } else {
        showInlineBanner(
          accountSectionElements.decisionStatusBanner,
          String(res.error || 'Decision model verification failed.'),
          'error'
        );
      }
    } catch (err) {
      showInlineBanner(
        accountSectionElements.decisionStatusBanner,
        err instanceof Error ? err.message : 'Failed to test Decision Model connection.',
        'error'
      );
    } finally {
      setDecisionFormBusy(false);
    }
  }

  /**
   * Validate, optionally request host permission, save System One Decision Model config,
   * and score open PRs immediately.
   *
   * @param {SubmitEvent} e
   */
  async function handleSaveDecisionConfig(e) {
    e.preventDefault();
    const config = readValidatedDecisionInputs(accountSectionElements, {
      currentProvider: state.decision?.provider,
      isConfigured: state.decision?.isConfigured
    });
    if (!config) {
      return;
    }

    setDecisionFormBusy(true);
    try {
      if (config.provider === 'off') {
        markLocalStateMutation();
        const res = await sendWorkerMessage({ action: 'CLEAR_DECISION_CONFIG' });
        if (res.ok === false) {
          showInlineBanner(
            accountSectionElements.decisionStatusBanner,
            String(res.error || 'Could not disable System One AI Triage.'),
            'error'
          );
          return;
        }
        accountSectionElements.decisionApiKeyInput.value = '';
        isConfiguringDecision = false;
        await refreshStateFromWorker();
        markLocalStateMutation();
        populateAccountSection();
        showToast('System One AI Triage disabled.');
        return;
      }

      const hasPermission = await ensureDecisionHostPermission(config.provider, config.baseUrl);
      if (!hasPermission) {
        return;
      }

      showInlineBanner(accountSectionElements.decisionStatusBanner, 'Verifying model and scoring PRs...', 'info');
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'SAVE_DECISION_CONFIG', config });
      if (!res.ok) {
        showInlineBanner(
          accountSectionElements.decisionStatusBanner,
          String(res.error || 'Could not save Decision Model settings.'),
          'error'
        );
        return;
      }

      accountSectionElements.decisionApiKeyInput.value = '';
      isConfiguringDecision = false;
      await refreshStateFromWorker();
      markLocalStateMutation();
      closeSettingsPanel();
      if (res.syncError) {
        showToast(`AI Triage saved, but sync failed: ${String(res.syncError)}`, 'error', { durationMs: 4200 });
      } else {
        showToast('System One AI Triage enabled & PRs scored!', 'success');
      }
    } catch (err) {
      showInlineBanner(
        accountSectionElements.decisionStatusBanner,
        err instanceof Error ? err.message : 'Failed to save Decision Model settings.',
        'error'
      );
    } finally {
      setDecisionFormBusy(false);
    }
  }

  /**
   * Validate and persist user preferences via background worker.
   *
   * @param {SubmitEvent} e
   */
  async function handleSavePreferences(e) {
    e.preventDefault();
    const prevDefaultFilter = state.preferences.defaultFilter;
    const nextPrefs = readValidatedPreferencesInputs(preferencesFormElements);
    if (!nextPrefs) {
      return;
    }

    settingsControls.savePreferencesBtn.disabled = true;
    showInlineBanner(preferencesFormElements.prefsStatusBanner, 'Saving preferences...', 'info');
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({
        action: 'UPDATE_PREFERENCES',
        preferences: nextPrefs
      });
      if (res.ok === false) {
        showInlineBanner(preferencesFormElements.prefsStatusBanner, String(res.error || 'Could not save preferences.'), 'error');
        return;
      }

      await refreshStateFromWorker();
      markLocalStateMutation();
      if (state.preferences.defaultFilter !== prevDefaultFilter) {
        activeFilter = state.preferences.defaultFilter;
        selectedPrKey = null;
        renderBitbucketTab();
      }
      closeSettingsPanel();
      if (res.syncError) {
        showToast(`Preferences saved, but sync failed: ${String(res.syncError)}`, 'error', { durationMs: 4200 });
      } else {
        showToast('Preferences saved.', 'success');
      }
    } catch (err) {
      showInlineBanner(
        preferencesFormElements.prefsStatusBanner,
        err instanceof Error ? err.message : 'Failed to save preferences.',
        'error'
      );
    } finally {
      settingsControls.savePreferencesBtn.disabled = false;
    }
  }

  /**
   * Wire `ArrowLeft` / `ArrowRight` roving keyboard navigation for an ARIA `tablist`.
   *
   * @param {readonly HTMLButtonElement[]} buttons
   * @param {(btn: HTMLButtonElement) => void} onActivate
   */
  function wireTablistArrowNavigation(buttons, onActivate) {
    buttons.forEach((btn, index) => {
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') {
          return;
        }
        e.preventDefault();
        let nextIndex = index;
        if (e.key === 'ArrowRight') {
          nextIndex = (index + 1) % buttons.length;
        } else if (e.key === 'ArrowLeft') {
          nextIndex = (index - 1 + buttons.length) % buttons.length;
        } else if (e.key === 'Home') {
          nextIndex = 0;
        } else if (e.key === 'End') {
          nextIndex = buttons.length - 1;
        }
        const nextBtn = buttons[nextIndex];
        if (nextBtn) {
          onActivate(nextBtn);
          nextBtn.focus();
        }
      });
    });
  }

  // --- Wire Event Listeners ---

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      const nextTab = btn.dataset.tab;
      if (nextTab) {
        switchTopTab(nextTab);
      }
    });
  }

  wireTablistArrowNavigation(tabButtons, (btn) => {
    const nextTab = btn.dataset.tab;
    if (nextTab) {
      switchTopTab(nextTab);
    }
  });

  connectionStatusChip.addEventListener('click', () => {
    openSettingsPanel('account');
  });

  toggleSettingsBtn.addEventListener('click', () => {
    if (settingsPanel.classList.contains('hidden')) {
      openSettingsPanel(state.isAuthenticated ? 'preferences' : 'account');
    } else {
      closeSettingsPanel();
    }
  });
  settingsControls.closeSettingsBtn.addEventListener('click', closeSettingsPanel);
  settingsControls.cancelSettingsBtn.addEventListener('click', closeSettingsPanel);
  settingsControls.cancelGitHubSettingsBtn.addEventListener('click', closeSettingsPanel);
  settingsControls.decisionCancelBtn.addEventListener('click', closeSettingsPanel);
  settingsControls.cancelPreferencesBtn.addEventListener('click', closeSettingsPanel);

  settingsAccountTab.addEventListener('click', () => switchSettingsSubtab('account'));
  settingsPreferencesTab.addEventListener('click', () => switchSettingsSubtab('preferences'));
  wireTablistArrowNavigation([settingsAccountTab, settingsPreferencesTab], (btn) => {
    switchSettingsSubtab(btn === settingsPreferencesTab ? 'preferences' : 'account');
  });

  settingsControls.replaceTokenBtn.addEventListener('click', () => {
    isReplacingToken = true;
    populateAccountSection();
    if (
      accountSectionElements.authTypeSelect.value === 'api_token' &&
      !accountSectionElements.bitbucketUsernameInput.value.trim()
    ) {
      accountSectionElements.bitbucketUsernameInput.focus();
    } else {
      accountSectionElements.bitbucketTokenInput.focus();
    }
  });

  settingsControls.signOutBtn.addEventListener('click', () => {
    accountSectionElements.signOutConfirm.classList.remove('hidden');
    settingsControls.confirmSignOutBtn.focus();
  });

  settingsControls.cancelSignOutBtn.addEventListener('click', () => {
    accountSectionElements.signOutConfirm.classList.add('hidden');
    settingsControls.signOutBtn.focus();
  });

  settingsControls.confirmSignOutBtn.addEventListener('click', async () => {
    settingsControls.confirmSignOutBtn.disabled = true;
    try {
      markLocalStateMutation();
      await sendWorkerMessage({ action: 'SIGN_OUT' });
      isReplacingToken = false;
      activeRelatedTicketKey = null;
      activeFilter = state.preferences.defaultFilter || DEFAULT_PREFERENCES.defaultFilter;
      searchQuery = '';
      selectedPrKey = null;
      prSearchInput.value = '';
      await refreshStateFromWorker();
      markLocalStateMutation();
      populateAccountSection();
      showToast('Signed out of Bitbucket.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to sign out.', 'error');
    } finally {
      settingsControls.confirmSignOutBtn.disabled = false;
    }
  });

  settingsControls.githubReplaceTokenBtn.addEventListener('click', () => {
    isReplacingGitHubToken = true;
    populateAccountSection();
    accountSectionElements.githubTokenInput.focus();
  });

  settingsControls.githubSignOutBtn.addEventListener('click', () => {
    accountSectionElements.githubSignOutConfirm.classList.remove('hidden');
    settingsControls.githubConfirmSignOutBtn.focus();
  });

  settingsControls.githubCancelSignOutBtn.addEventListener('click', () => {
    accountSectionElements.githubSignOutConfirm.classList.add('hidden');
    settingsControls.githubSignOutBtn.focus();
  });

  settingsControls.githubConfirmSignOutBtn.addEventListener('click', async () => {
    settingsControls.githubConfirmSignOutBtn.disabled = true;
    try {
      markLocalStateMutation();
      await sendWorkerMessage({ action: 'SIGN_OUT_GITHUB' });
      isReplacingGitHubToken = false;
      activeRelatedTicketKey = null;
      selectedPrKey = null;
      await refreshStateFromWorker();
      markLocalStateMutation();
      populateAccountSection();
      showToast('Signed out of GitHub.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to sign out of GitHub.', 'error');
    } finally {
      settingsControls.githubConfirmSignOutBtn.disabled = false;
    }
  });

  settingsControls.decisionReplaceBtn.addEventListener('click', () => {
    isConfiguringDecision = true;
    populateAccountSection();
    accountSectionElements.decisionProviderSelect.focus();
  });

  settingsControls.decisionSignOutBtn.addEventListener('click', () => {
    accountSectionElements.decisionSignOutConfirmRow.classList.remove('hidden');
    settingsControls.decisionConfirmSignOutBtn.focus();
  });

  settingsControls.decisionCancelSignOutBtn.addEventListener('click', () => {
    accountSectionElements.decisionSignOutConfirmRow.classList.add('hidden');
    settingsControls.decisionSignOutBtn.focus();
  });

  settingsControls.decisionConfirmSignOutBtn.addEventListener('click', async () => {
    settingsControls.decisionConfirmSignOutBtn.disabled = true;
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'CLEAR_DECISION_CONFIG' });
      if (res.ok === false) {
        showToast(String(res.error || 'Could not disable System One AI Triage.'), 'error');
        return;
      }
      isConfiguringDecision = false;
      await refreshStateFromWorker();
      markLocalStateMutation();
      populateAccountSection();
      showToast('System One AI Triage disabled.');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to disable System One AI Triage.', 'error');
    } finally {
      settingsControls.decisionConfirmSignOutBtn.disabled = false;
    }
  });

  accountSectionElements.decisionProviderSelect.addEventListener('change', () => {
    syncDecisionProviderFields(
      {
        decisionProviderSelect: accountSectionElements.decisionProviderSelect,
        decisionFieldsGroup: accountSectionElements.decisionFieldsGroup,
        decisionBaseUrlInput: accountSectionElements.decisionBaseUrlInput,
        decisionBaseUrlHelp: accountSectionElements.decisionBaseUrlHelp,
        decisionModelInput: accountSectionElements.decisionModelInput,
        decisionApiKeyInput: accountSectionElements.decisionApiKeyInput,
        decisionApiKeyHelp: accountSectionElements.decisionApiKeyHelp,
        decisionTestBtn: settingsControls.decisionTestBtn
      },
      { applyProviderDefaults: true }
    );
  });

  accountSectionElements.decisionToggleKeyBtn.addEventListener('click', () => {
    toggleSecretInputVisibility(
      accountSectionElements.decisionApiKeyInput,
      accountSectionElements.decisionToggleKeyBtn,
      'Show API key',
      'Hide API key'
    );
  });

  settingsControls.decisionTestBtn.addEventListener('click', () => {
    void handleTestDecisionModel();
  });
  accountSectionElements.decisionConfigForm.addEventListener('submit', (e) => {
    void handleSaveDecisionConfig(e);
  });

  settingsControls.createApiTokenLink.addEventListener('click', (e) => {
    e.preventDefault();
    void openSafeExternalUrl(AUTH_SETUP_LINKS.atlassianApiTokens);
  });

  settingsControls.createGitHubTokenLink.addEventListener('click', (e) => {
    e.preventDefault();
    void openSafeExternalUrl(AUTH_SETUP_LINKS.githubTokens);
  });

  accountSectionElements.authTypeSelect.addEventListener('change', () => {
    syncAuthMethodFields(accountSectionElements);
  });
  accountSectionElements.toggleTokenVisibilityBtn.addEventListener('click', () => {
    toggleSecretInputVisibility(
      accountSectionElements.bitbucketTokenInput,
      accountSectionElements.toggleTokenVisibilityBtn,
      'Show token',
      'Hide token'
    );
  });

  accountSectionElements.toggleGitHubTokenVisibilityBtn.addEventListener('click', () => {
    toggleSecretInputVisibility(
      accountSectionElements.githubTokenInput,
      accountSectionElements.toggleGitHubTokenVisibilityBtn,
      'Show GitHub token',
      'Hide GitHub token'
    );
  });

  settingsControls.testConnectionBtn.addEventListener('click', () => {
    void handleTestConnection();
  });
  accountSectionElements.credentialsForm.addEventListener('submit', (e) => {
    void handleSaveCredentials(e);
  });
  settingsControls.testGitHubConnectionBtn.addEventListener('click', () => {
    void handleTestGitHubConnection();
  });
  accountSectionElements.githubCredentialsForm.addEventListener('submit', (e) => {
    void handleSaveGitHubCredentials(e);
  });
  settingsControls.preferencesForm.addEventListener('submit', (e) => {
    void handleSavePreferences(e);
  });

  manualRefreshBtn.addEventListener('click', () => {
    void triggerManualSync();
  });
  errorSetupBtn.addEventListener('click', () => {
    const isAuthErr = Boolean(state.snapshot.isAuthError || state.isAuthError || !state.isAuthenticated);
    if (isAuthErr) {
      const errMsg = state.snapshot.error || '';
      const isGhErr = /^GitHub:/i.test(errMsg) || /GitHub/i.test(errMsg);
      openSettingsPanel('account', isGhErr
        ? { forceReplaceGitHub: true, focusTarget: 'github' }
        : { forceReplaceBitbucket: true, focusTarget: 'bitbucket' });
    } else {
      openSettingsPanel('preferences');
    }
  });
  setupHintBtn.addEventListener('click', () => openSettingsPanel('account', { focusTarget: 'bitbucket' }));
  setupHintGitHubBtn.addEventListener('click', () => openSettingsPanel('account', { focusTarget: 'github' }));
  jiraConnectBtn.addEventListener('click', () => openSettingsPanel('account'));

  for (const pill of bitbucketTabElements.filterPillButtons) {
    pill.addEventListener('click', () => {
      const nextFilter = /** @type {PrFilter | undefined} */ (pill.dataset.filter);
      if (!nextFilter) {
        return;
      }
      activeRelatedTicketKey = null;
      activeFilter = nextFilter;
      selectedPrKey = null;
      renderBitbucketTab();
    });
  }

  wireTablistArrowNavigation(bitbucketTabElements.filterPillButtons, (pill) => {
    const nextFilter = /** @type {PrFilter | undefined} */ (pill.dataset.filter);
    if (!nextFilter) {
      return;
    }
    activeRelatedTicketKey = null;
    activeFilter = nextFilter;
    selectedPrKey = null;
    renderBitbucketTab();
  });

  quickWinsBtn.addEventListener('click', () => {
    toggleQuickWinsFilter();
  });

  groupByTicketBtn.addEventListener('click', () => {
    void toggleGroupByTicket();
  });

  clearRelatedScopeBtn.addEventListener('click', () => {
    activeRelatedTicketKey = null;
    selectedPrKey = null;
    renderBitbucketTab();
  });

  prSearchInput.addEventListener('input', () => {
    activeRelatedTicketKey = null;
    searchQuery = prSearchInput.value;
    selectedPrKey = null;
    renderBitbucketTab();
  });

  prSearchClearBtn.addEventListener('click', () => {
    activeRelatedTicketKey = null;
    searchQuery = '';
    prSearchInput.value = '';
    selectedPrKey = null;
    renderBitbucketTab();
    prSearchInput.focus();
  });

  emptyStateActionBtn.addEventListener('click', () => {
    const action = emptyStateActionBtn.dataset.emptyAction;
    selectedPrKey = null;
    if (action === 'clear_related') {
      activeRelatedTicketKey = null;
    } else if (action === 'clear_search') {
      searchQuery = '';
      prSearchInput.value = '';
    } else {
      activeRelatedTicketKey = null;
      activeFilter = 'all';
    }
    renderBitbucketTab();
  });

  openJiraBtn.addEventListener('click', () => {
    const effectiveJiraUrl = getEffectiveJiraBaseUrl(state.preferences);
    if (!effectiveJiraUrl) {
      openSettingsPanel('preferences');
      preferencesFormElements.prefJiraUrl.focus();
      return;
    }
    void openSafeExternalUrl(effectiveJiraUrl);
  });

  jiraOpenPrefsBtn.addEventListener('click', () => {
    openSettingsPanel('preferences');
    preferencesFormElements.prefJiraUrl.focus();
  });

  openConfluenceBtn.addEventListener('click', () => {
    void openSafeExternalUrl(CENTRAL_URLS.CONFLUENCE_URL);
  });

  addProductForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checkedProducts = Array.from(addProductForm.querySelectorAll('input[name="products"]:checked'))
      .filter((el) => el instanceof HTMLInputElement)
      .map((cb) => cb.value);
    const feedback = customProductFeedbackInput.value.trim();
    const timestamp = Date.now();

    await chrome.storage.local.set({
      [STORAGE_KEYS.REQUESTED_PRODUCTS]: checkedProducts,
      [STORAGE_KEYS.PRODUCT_FEEDBACK]: feedback,
      [STORAGE_KEYS.PRODUCT_FEEDBACK_TIMESTAMP]: timestamp
    });

    state.productFeedback = {
      requestedProducts: checkedProducts,
      productFeedback: feedback,
      productFeedbackTimestamp: timestamp
    };

    productRequestSuccessAlert.classList.remove('hidden');
    if (productFeedbackTimer !== null) {
      window.clearTimeout(productFeedbackTimer);
    }
    productFeedbackTimer = window.setTimeout(() => {
      productRequestSuccessAlert.classList.add('hidden');
    }, 3500);
    showToast('Product request saved.', 'success');
  });

  shortcutsToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleShortcutsPopover();
  });
  closeShortcutsBtn.addEventListener('click', closeShortcutsPopover);

  document.addEventListener('click', (e) => {
    if (shortcutsPopover.classList.contains('hidden')) {
      return;
    }
    const clickTarget = e.target;
    if (
      clickTarget instanceof Node &&
      !shortcutsPopover.contains(clickTarget) &&
      !shortcutsToggleBtn.contains(clickTarget)
    ) {
      closeShortcutsPopover();
    }
  });

  // --- Live Background Sync Subscription ---
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') {
      return;
    }
    if (Date.now() < suppressStorageRefreshUntil) {
      return;
    }
    const hasRelevantChange = Object.keys(changes).some((key) => WATCHED_STORAGE_KEYS.has(key));
    if (!hasRelevantChange) {
      return;
    }
    if (storageRefreshTimer !== null) {
      window.clearTimeout(storageRefreshTimer);
    }
    storageRefreshTimer = window.setTimeout(() => {
      storageRefreshTimer = null;
      void refreshStateFromWorker();
    }, 40);
  });

  // --- Lightweight 30s Live Relative Timestamp Refresh ---
  const liveTickInterval = window.setInterval(refreshLiveTimestamps, 30_000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(liveTickInterval);
  });
  window.addEventListener('unload', () => {
    window.clearInterval(liveTickInterval);
  });

  // --- Keyboard-First Triage Navigation ---
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }

    const target = e.target;
    const isEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (e.key === 'Escape') {
      if (!shortcutsPopover.classList.contains('hidden')) {
        e.preventDefault();
        closeShortcutsPopover();
        return;
      }
      if (!settingsPanel.classList.contains('hidden')) {
        e.preventDefault();
        closeSettingsPanel();
        return;
      }
      if (activeRelatedTicketKey) {
        e.preventDefault();
        activeRelatedTicketKey = null;
        selectedPrKey = null;
        renderBitbucketTab();
        return;
      }
      if (searchQuery) {
        e.preventDefault();
        searchQuery = '';
        prSearchInput.value = '';
        selectedPrKey = null;
        renderBitbucketTab();
        return;
      }
      if (document.activeElement === prSearchInput) {
        e.preventDefault();
        prSearchInput.blur();
      }
      return;
    }

    if (isEditable) {
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      toggleShortcutsPopover();
      return;
    }

    // Do not fire triage shortcuts behind open Settings drawer
    if (!settingsPanel.classList.contains('hidden')) {
      return;
    }

    if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
      e.preventDefault();
      switchTopTab(TOP_TABS[Number(e.key) - 1]);
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      switchTopTab('bitbucket-tab');
      if (state.isAuthenticated) {
        prSearchInput.focus();
        prSearchInput.select();
      }
      return;
    }

    if (e.key === 'g') {
      e.preventDefault();
      switchTopTab('bitbucket-tab');
      if (state.isAuthenticated) {
        void toggleGroupByTicket();
      }
      return;
    }

    if (e.key === 'r') {
      e.preventDefault();
      void triggerManualSync();
      return;
    }

    const activeList = navigablePrs.length > 0 ? navigablePrs : visiblePrs;
    if (activeTabId !== 'bitbucket-tab' || activeList.length === 0) {
      return;
    }

    if (e.key === 'h' || e.key === 'ArrowLeft') {
      if (navigateDeckSlideInContainer(prItemsContainer, selectedPrKey, -1, selectPrCard)) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'l' || e.key === 'ArrowRight') {
      if (navigateDeckSlideInContainer(prItemsContainer, selectedPrKey, 1, selectPrCard)) {
        e.preventDefault();
        return;
      }
    }

    const currentIndex = selectedPrKey
      ? activeList.findIndex((pr) => pr.key === selectedPrKey)
      : -1;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex < 0
        ? 0
        : Math.min(activeList.length - 1, currentIndex + 1);
      selectPrCard(activeList[nextIndex].key, true);
      return;
    }

    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex < 0
        ? 0
        : Math.max(0, currentIndex - 1);
      selectPrCard(activeList[prevIndex].key, true);
      return;
    }

    if (currentIndex < 0) {
      return;
    }
    const selectedPr = activeList[currentIndex];
    if (!selectedPr) {
      return;
    }

    if (e.key === 'Enter') {
      const interactiveElement = target instanceof HTMLElement
        ? target.closest('button, a, input, select, textarea')
        : null;
      if (!interactiveElement) {
        e.preventDefault();
        void openSafeExternalUrl(selectedPr.url);
      }
      return;
    }

    if (e.key === 'c') {
      e.preventDefault();
      void copyPrLink(selectedPr);
      return;
    }

    if (e.key === 's') {
      e.preventDefault();
      void toggleSnoozePr(selectedPr);
    }
  });

  // --- Bootstrap Initial State ---
  renderStaticMetadata(
    {
      appVersionEl,
      createApiTokenLink: settingsControls.createApiTokenLink,
      requiredScopesList: settingsControls.requiredScopesList,
      createGitHubTokenLink: settingsControls.createGitHubTokenLink,
      githubRequiredScopesList: settingsControls.githubRequiredScopesList
    },
    chrome.runtime.getManifest().version
  );
  try {
    await refreshStateFromWorker({ applyDefaultFilter: true, updateAddProduct: true });
  } catch (err) {
    renderAll();
    showToast(err instanceof Error ? err.message : 'Unable to load extension state.', 'error');
  }
});
