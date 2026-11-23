import {
  AUTH_SETUP_LINKS,
  CENTRAL_URLS,
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  getEffectiveJiraBaseUrl,
  sanitizeHttpsUrl
} from './src/config.js';
import {
  collectActiveJiraTickets,
  computeCounts,
  filterAndSortPrs,
  isPrSnoozed
} from './src/pr-triage.js';
import { normalizeAuthType } from './src/storage.js';

/** @typedef {import('./src/config.js').Preferences} Preferences */
/** @typedef {import('./src/pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('./src/pr-triage.js').PrCounts} PrCounts */
/** @typedef {import('./src/pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('./src/storage.js').AuthType} AuthType */
/** @typedef {import('./src/storage.js').CachedUser} CachedUser */
/** @typedef {import('./src/storage.js').PrSnapshot} PrSnapshot */
/** @typedef {import('./src/storage.js').ProductFeedbackState} ProductFeedbackState */
/** @typedef {import('./src/storage.js').SnoozedMap} SnoozedMap */
/** @typedef {import('./src/storage.js').SyncState} SyncState */
/** @typedef {import('./src/storage.js').WorkspaceSummary} WorkspaceSummary */

/**
 * @typedef {Object} WorkerBootstrapState
 * @property {boolean} isAuthenticated
 * @property {AuthType} authType
 * @property {string} username
 * @property {CachedUser | null} user
 * @property {WorkspaceSummary[]} workspaces
 * @property {boolean} [isAuthError]
 * @property {Omit<PrSnapshot, 'prList'> & { prList: EnrichedPullRequest[], isAuthError?: boolean }} snapshot
 * @property {Preferences} preferences
 * @property {SyncState} syncState
 * @property {SnoozedMap} snoozedMap
 * @property {PrCounts} counts
 * @property {ProductFeedbackState} productFeedback
 */

/**
 * @typedef {Object} ActionBadgeMeta
 * @property {string} label
 * @property {string} title
 */

const SNOOZE_FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TOP_TABS = ['bitbucket-tab', 'jira-tab', 'confluence-tab', 'add-product-tab'];

/** @type {Readonly<Record<PrFilter, string>>} */
const FILTER_LABELS = Object.freeze({
  action_required: 'Needs Action',
  reviewing: 'Reviewing',
  authored: 'My PRs',
  all: 'All PRs',
  snoozed: 'Snoozed'
});

/** @type {Readonly<Record<string, ActionBadgeMeta>>} */
const ACTION_BADGE_LABELS = Object.freeze({
  needs_review: {
    label: 'Needs Review',
    title: 'Your review is pending on this pull request'
  },
  changes_requested: {
    label: 'Changes Requested',
    title: 'A reviewer requested changes on your pull request'
  },
  ci_failed: {
    label: 'CI Failed',
    title: 'Latest CI build on your pull request failed or stopped'
  },
  ready_to_merge: {
    label: 'Ready to Merge',
    title: 'Approved by reviewers with no outstanding change requests or failing builds'
  },
  waiting_reviewers: {
    label: 'Waiting',
    title: 'Waiting on reviewers or updates from others'
  },
  approved_by_you: {
    label: 'Approved',
    title: 'You have approved this pull request'
  },
  changes_requested_by_you: {
    label: 'Changes Sent',
    title: 'You requested changes; waiting on author updates'
  },
  draft: {
    label: 'Draft',
    title: 'Draft pull request (excluded from Needs Action)'
  }
});

/** @type {ReadonlySet<string>} */
const WATCHED_STORAGE_KEYS = new Set([
  STORAGE_KEYS.AUTH_TYPE,
  STORAGE_KEYS.BITBUCKET_USERNAME,
  STORAGE_KEYS.BITBUCKET_TOKEN,
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
 * Resolve a DOM element by ID and assert its concrete element class for strict type safety.
 *
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new (...args: any[]) => T} ElementClass
 * @returns {T}
 */
function getEl(id, ElementClass) {
  const el = document.getElementById(id);
  if (!(el instanceof ElementClass)) {
    throw new Error(`Expected #${id} to exist as ${ElementClass.name}`);
  }
  return el;
}

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
 * Format a compact relative age label (`just now`, `5m`, `3h`, `6d`, or short date like `Nov 8` for >= 14d).
 *
 * @param {string} isoTimestamp
 * @param {number} [now]
 * @returns {string}
 */
function formatRelativeAge(isoTimestamp, now = Date.now()) {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return '';
  }
  const diffMinutes = Math.max(0, Math.floor((now - parsed) / 60_000));
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) {
    return `${diffDays}d`;
  }
  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Format remaining snooze duration (e.g. `3h 40m left`, `25m left`, `<1m left`).
 *
 * @param {number} untilMs
 * @param {number} [now]
 * @returns {string}
 */
function formatSnoozeRemaining(untilMs, now = Date.now()) {
  const remainingMs = Math.max(0, untilMs - now);
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes <= 1) {
    return '<1m left';
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m left`;
  }
  if (hours > 0) {
    return `${hours}h left`;
  }
  return `${mins}m left`;
}

/**
 * Parse comma-separated workspace or repository filter strings into trimmed, deduplicated slugs.
 *
 * @param {string} rawText
 * @returns {string[]}
 */
function parseCsvList(rawText) {
  const seen = new Set();
  /** @type {string[]} */
  const items = [];
  for (const part of rawText.split(',')) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      items.push(trimmed);
    }
  }
  return items;
}

/**
 * Extract 1-2 uppercase avatar initials from a display name or username.
 *
 * @param {string} name
 * @returns {string}
 */
function getInitials(name) {
  const cleaned = name.trim();
  if (!cleaned) {
    return 'BB';
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Create a clean default bootstrap state before the initial worker response resolves.
 *
 * @returns {WorkerBootstrapState}
 */
function createEmptyState() {
  return {
    isAuthenticated: false,
    authType: 'api_token',
    username: '',
    user: null,
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
  const extensionContainer = getEl('extension-container', HTMLDivElement);
  const mainContent = getEl('main-content', HTMLElement);
  const appTitle = getEl('app-title', HTMLHeadingElement);
  const connectionStatusChip = getEl('connection-status-chip', HTMLButtonElement);
  const connectionStatusText = getEl('connection-status-text', HTMLSpanElement);
  const manualRefreshBtn = getEl('manual-refresh-btn', HTMLButtonElement);
  const toggleSettingsBtn = getEl('toggle-settings-btn', HTMLButtonElement);

  const tabButtons = /** @type {HTMLButtonElement[]} */ (
    Array.from(document.querySelectorAll('.tab-btn')).filter((el) => el instanceof HTMLButtonElement)
  );
  const tabPanels = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('.tab-panel')).filter((el) => el instanceof HTMLElement)
  );

  // Settings Drawer & Sub-tabs
  const settingsPanel = getEl('settings-panel', HTMLElement);
  const closeSettingsBtn = getEl('close-settings-btn', HTMLButtonElement);
  const settingsAccountTab = getEl('settings-account-tab', HTMLButtonElement);
  const settingsPreferencesTab = getEl('settings-preferences-tab', HTMLButtonElement);
  const settingsAccountPanel = getEl('settings-account-panel', HTMLDivElement);
  const settingsPreferencesPanel = getEl('settings-preferences-panel', HTMLDivElement);

  // Account Summary
  const accountSummaryCard = getEl('account-summary-card', HTMLDivElement);
  const accountAvatar = getEl('account-avatar', HTMLDivElement);
  const accountDisplayName = getEl('account-display-name', HTMLDivElement);
  const accountUsername = getEl('account-username', HTMLDivElement);
  const accountAuthType = getEl('account-auth-type', HTMLSpanElement);
  const accountWorkspaceCount = getEl('account-workspace-count', HTMLSpanElement);
  const replaceTokenBtn = getEl('replace-token-btn', HTMLButtonElement);
  const signOutBtn = getEl('sign-out-btn', HTMLButtonElement);
  const signOutConfirm = getEl('sign-out-confirm', HTMLDivElement);
  const confirmSignOutBtn = getEl('confirm-sign-out-btn', HTMLButtonElement);
  const cancelSignOutBtn = getEl('cancel-sign-out-btn', HTMLButtonElement);

  // Credentials Form
  const credentialsForm = getEl('credentials-form', HTMLFormElement);
  const createApiTokenLink = getEl('create-api-token-link', HTMLAnchorElement);
  const requiredScopesList = getEl('required-scopes-list', HTMLUListElement);
  const authTypeSelect = getEl('auth-type', HTMLSelectElement);
  const usernameGroup = getEl('username-group', HTMLDivElement);
  const bitbucketUsernameInput = getEl('bitbucket-username', HTMLInputElement);
  const tokenLabel = getEl('token-label', HTMLLabelElement);
  const bitbucketTokenInput = getEl('bitbucket-token', HTMLInputElement);
  const toggleTokenVisibilityBtn = getEl('toggle-token-visibility', HTMLButtonElement);
  const tokenHelpText = getEl('token-help', HTMLParagraphElement);
  const authStatusBanner = getEl('auth-status-banner', HTMLDivElement);
  const testConnectionBtn = getEl('test-connection-btn', HTMLButtonElement);
  const saveSettingsBtn = getEl('save-settings-btn', HTMLButtonElement);
  const cancelSettingsBtn = getEl('cancel-settings-btn', HTMLButtonElement);

  // Preferences Form
  const preferencesForm = getEl('preferences-form', HTMLFormElement);
  const prefPollInterval = getEl('pref-poll-interval', HTMLSelectElement);
  const prefBadgeMode = getEl('pref-badge-mode', HTMLSelectElement);
  const prefStaleHours = getEl('pref-stale-hours', HTMLSelectElement);
  const prefDefaultFilter = getEl('pref-default-filter', HTMLSelectElement);
  const prefNotifications = getEl('pref-notifications', HTMLInputElement);
  const prefCompactMode = getEl('pref-compact-mode', HTMLInputElement);
  const prefWorkspacesFilter = getEl('pref-workspaces-filter', HTMLInputElement);
  const availableWorkspacesHint = getEl('available-workspaces-hint', HTMLParagraphElement);
  const prefReposFilter = getEl('pref-repos-filter', HTMLInputElement);
  const prefJiraUrl = getEl('pref-jira-url', HTMLInputElement);
  const prefsStatusBanner = getEl('prefs-status-banner', HTMLDivElement);
  const savePreferencesBtn = getEl('save-preferences-btn', HTMLButtonElement);
  const cancelPreferencesBtn = getEl('cancel-preferences-btn', HTMLButtonElement);

  // Bitbucket PRs Tab
  const triageControls = getEl('triage-controls', HTMLDivElement);
  const filterPillButtons = /** @type {HTMLButtonElement[]} */ (
    Array.from(document.querySelectorAll('.filter-pill')).filter((el) => el instanceof HTMLButtonElement)
  );
  const countActionRequired = getEl('count-action-required', HTMLSpanElement);
  const countReviewing = getEl('count-reviewing', HTMLSpanElement);
  const countAuthored = getEl('count-authored', HTMLSpanElement);
  const countAll = getEl('count-all', HTMLSpanElement);
  const countSnoozed = getEl('count-snoozed', HTMLSpanElement);
  const prSearchInput = getEl('pr-search-input', HTMLInputElement);
  const prSearchClearBtn = getEl('pr-search-clear-btn', HTMLButtonElement);
  const prCountTitle = getEl('pr-count-title', HTMLSpanElement);

  const loadingIndicator = getEl('loading-indicator', HTMLDivElement);
  const errorAlert = getEl('error-alert', HTMLDivElement);
  const errorTitle = getEl('error-title', HTMLElement);
  const errorMessage = getEl('error-message', HTMLParagraphElement);
  const errorSetupBtn = getEl('error-setup-btn', HTMLButtonElement);
  const rateLimitBanner = getEl('rate-limit-banner', HTMLDivElement);
  const backoffBanner = getEl('backoff-banner', HTMLDivElement);
  const backoffMessage = getEl('backoff-message', HTMLParagraphElement);

  const prItemsContainer = getEl('pr-items-container', HTMLDivElement);
  const emptyState = getEl('empty-state', HTMLDivElement);
  const emptyStateTitle = getEl('empty-state-title', HTMLHeadingElement);
  const emptyStateMessage = getEl('empty-state-message', HTMLParagraphElement);
  const emptyStateActionBtn = getEl('empty-state-action-btn', HTMLButtonElement);
  const setupHint = getEl('setup-hint', HTMLDivElement);
  const setupHintBtn = getEl('setup-hint-btn', HTMLButtonElement);

  // Jira Tab
  const openJiraBtn = getEl('open-jira-btn', HTMLButtonElement);
  const jiraSetupHint = getEl('jira-setup-hint', HTMLDivElement);
  const jiraOpenPrefsBtn = getEl('jira-open-prefs-btn', HTMLButtonElement);
  const jiraTicketsCount = getEl('jira-tickets-count', HTMLSpanElement);
  const jiraTicketsContainer = getEl('jira-tickets-container', HTMLDivElement);
  const jiraEmptyState = getEl('jira-empty-state', HTMLDivElement);
  const jiraEmptyTitle = getEl('jira-empty-title', HTMLHeadingElement);
  const jiraEmptyMessage = getEl('jira-empty-message', HTMLParagraphElement);
  const jiraConnectBtn = getEl('jira-connect-btn', HTMLButtonElement);

  // Confluence Tab
  const confluenceConfiguredCard = getEl('confluence-configured-card', HTMLDivElement);
  const confluencePlaceholderCard = getEl('confluence-placeholder-card', HTMLDivElement);
  const openConfluenceBtn = getEl('open-confluence-btn', HTMLButtonElement);

  // + Add Product Tab
  const addProductForm = getEl('add-product-form', HTMLFormElement);
  const customProductFeedbackInput = getEl('custom-product-feedback', HTMLTextAreaElement);
  const productRequestSuccessAlert = getEl('product-request-success', HTMLDivElement);

  // Footer, Shortcuts & Toasts
  const lastUpdatedText = getEl('last-updated-text', HTMLDivElement);
  const shortcutsToggleBtn = getEl('shortcuts-toggle-btn', HTMLButtonElement);
  const shortcutsPopover = getEl('shortcuts-popover', HTMLElement);
  const closeShortcutsBtn = getEl('close-shortcuts-btn', HTMLButtonElement);
  const appVersionEl = getEl('app-version', HTMLDivElement);
  const toastContainer = getEl('toast-container', HTMLDivElement);

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
  let selectedPrKey = null;
  /** @type {EnrichedPullRequest[]} */
  let visiblePrs = [];
  /** @type {boolean} */
  let isReplacingToken = false;
  /** @type {boolean} */
  let isSyncing = false;
  /** @type {number | null} */
  let storageRefreshTimer = null;
  /** @type {number | null} */
  let productFeedbackTimer = null;
  /** @type {number | null} */
  let toastDismissTimer = null;
  /** @type {number} */
  let suppressStorageRefreshUntil = 0;
  /** @type {number} */
  let stateRequestSeq = 0;

  // --- Helper Utilities ---

  /**
   * Show a non-blocking toast message that auto-dismisses, with an optional inline action button.
   *
   * @param {string} message
   * @param {'neutral' | 'success' | 'error'} [variant]
   * @param {{ actionLabel?: string, onAction?: () => void | Promise<void>, durationMs?: number }} [options]
   */
  function showToast(message, variant = 'neutral', options = {}) {
    if (toastDismissTimer !== null) {
      window.clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }

    const toast = document.createElement('div');
    toast.className = variant === 'neutral' ? 'toast' : `toast toast-${variant}`;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    if (options.actionLabel && typeof options.onAction === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'toast-action-btn';
      actionBtn.textContent = options.actionLabel;
      const onAction = options.onAction;
      actionBtn.addEventListener('click', () => {
        if (toastDismissTimer !== null) {
          window.clearTimeout(toastDismissTimer);
          toastDismissTimer = null;
        }
        toast.remove();
        void onAction();
      });
      toast.appendChild(actionBtn);
    }

    toastContainer.replaceChildren(toast);

    const durationMs = typeof options.durationMs === 'number'
      ? options.durationMs
      : (options.actionLabel ? 4500 : 2600);

    toastDismissTimer = window.setTimeout(() => {
      toastDismissTimer = null;
      if (toast.parentNode === toastContainer) {
        toast.remove();
      }
    }, durationMs);
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
   * Show an inline status banner inside Settings forms.
   *
   * @param {HTMLDivElement} bannerEl
   * @param {string} message
   * @param {'info' | 'success' | 'error' | 'warning'} variant
   */
  function showInlineBanner(bannerEl, message, variant) {
    bannerEl.className = `inline-banner ${variant}`;
    bannerEl.textContent = message;
    bannerEl.classList.remove('hidden');
  }

  /**
   * Hide and clear an inline status banner.
   *
   * @param {HTMLDivElement} bannerEl
   */
  function hideInlineBanner(bannerEl) {
    bannerEl.textContent = '';
    bannerEl.className = 'inline-banner hidden';
  }

  /**
   * Populate static setup metadata from `config.js` and `manifest.json`.
   */
  function renderStaticMetadata() {
    const manifestVersion = chrome.runtime.getManifest().version;
    appVersionEl.textContent = `v${manifestVersion}`;

    const safeApiTokenDocs = sanitizeHttpsUrl(AUTH_SETUP_LINKS.atlassianApiTokens);
    if (safeApiTokenDocs) {
      createApiTokenLink.href = safeApiTokenDocs;
    }

    const scopeNodes = AUTH_SETUP_LINKS.requiredScopes.map((scope) => {
      const li = document.createElement('li');
      li.textContent = scope;
      return li;
    });
    requiredScopesList.replaceChildren(...scopeNodes);
  }

  /**
   * Toggle between top-level product tabs (`bitbucket-tab`, `jira-tab`, `confluence-tab`, `add-product-tab`).
   *
   * @param {string} nextTabId
   */
  function switchTopTab(nextTabId) {
    if (!TOP_TABS.includes(nextTabId)) {
      return;
    }
    activeTabId = nextTabId;

    for (const btn of tabButtons) {
      const isSelected = btn.dataset.tab === nextTabId;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
    }

    const targetPanelId = `${nextTabId}-panel`;
    for (const panel of tabPanels) {
      panel.classList.toggle('hidden', panel.id !== targetPanelId);
    }

    if (nextTabId === 'bitbucket-tab') {
      appTitle.textContent = 'Atlassian Hub';
    } else if (nextTabId === 'jira-tab') {
      appTitle.textContent = 'Jira Hub';
    } else if (nextTabId === 'confluence-tab') {
      appTitle.textContent = 'Confluence Hub';
    } else {
      appTitle.textContent = 'Customizer';
    }
  }

  /**
   * Toggle between Settings drawer sub-tabs (`account` and `preferences`).
   *
   * @param {'account' | 'preferences'} subtab
   */
  function switchSettingsSubtab(subtab) {
    const isAccount = subtab === 'account';

    settingsAccountTab.classList.toggle('active', isAccount);
    settingsAccountTab.setAttribute('aria-selected', isAccount ? 'true' : 'false');
    settingsAccountTab.tabIndex = isAccount ? 0 : -1;

    settingsPreferencesTab.classList.toggle('active', !isAccount);
    settingsPreferencesTab.setAttribute('aria-selected', !isAccount ? 'true' : 'false');
    settingsPreferencesTab.tabIndex = !isAccount ? 0 : -1;

    settingsAccountPanel.classList.toggle('hidden', !isAccount);
    settingsPreferencesPanel.classList.toggle('hidden', isAccount);
  }

  /**
   * Update authentication form fields based on selected auth type (`api_token` vs `bearer`).
   */
  function syncAuthMethodFields() {
    const selected = normalizeAuthType(authTypeSelect.value);
    if (selected === 'api_token') {
      usernameGroup.classList.remove('hidden');
      tokenLabel.textContent = 'Atlassian API Token';
      bitbucketTokenInput.placeholder = 'Paste API token here';
      tokenHelpText.textContent = 'Use your Atlassian account email paired with a scoped Bitbucket API token.';
    } else {
      usernameGroup.classList.add('hidden');
      tokenLabel.textContent = 'Access Token (Bearer)';
      bitbucketTokenInput.placeholder = 'Paste Bearer access token here';
      tokenHelpText.textContent = 'Uses Authorization: Bearer <token>. Email is not required.';
    }
  }

  /**
   * Populate Settings -> Account & Setup UI from current `state` without ever injecting stored token plaintext.
   */
  function populateAccountSection() {
    const showSummary = state.isAuthenticated && !isReplacingToken;
    accountSummaryCard.classList.toggle('hidden', !showSummary);
    credentialsForm.classList.toggle('hidden', showSummary);
    signOutConfirm.classList.add('hidden');

    if (showSummary) {
      const displayName = state.user?.displayName || state.username || 'Bitbucket User';
      const secondaryIdentity = state.username || (state.user?.username ? `@${state.user.username}` : 'Authenticated');
      const wsCount = state.workspaces.length || state.snapshot.syncedWorkspaces.length;

      accountAvatar.textContent = getInitials(displayName);
      accountDisplayName.textContent = displayName;
      accountUsername.textContent = secondaryIdentity;
      accountAuthType.textContent = state.authType === 'bearer' ? 'Bearer' : 'API Token';
      accountWorkspaceCount.textContent = `${wsCount} workspace${wsCount === 1 ? '' : 's'}`;
    }

    authTypeSelect.value = normalizeAuthType(state.authType);
    bitbucketUsernameInput.value = state.username || '';
    // Security invariant: never populate stored token plaintext into the DOM
    bitbucketTokenInput.value = '';
    bitbucketTokenInput.type = 'password';
    toggleTokenVisibilityBtn.setAttribute('aria-label', 'Show token');
    toggleTokenVisibilityBtn.title = 'Show token';
    syncAuthMethodFields();
    hideInlineBanner(authStatusBanner);
  }

  /**
   * Populate Settings -> Preferences inputs from `state.preferences` and show discovered workspace slugs.
   *
   * @param {Preferences} prefs
   */
  function populatePreferencesForm(prefs) {
    prefPollInterval.value = String(prefs.pollIntervalMinutes);
    prefBadgeMode.value = prefs.badgeMode;
    prefStaleHours.value = String(prefs.staleThresholdHours);
    prefDefaultFilter.value = prefs.defaultFilter;
    prefNotifications.checked = Boolean(prefs.notificationsEnabled);
    prefCompactMode.checked = Boolean(prefs.compactMode);
    prefWorkspacesFilter.value = Array.isArray(prefs.workspacesFilter)
      ? prefs.workspacesFilter.join(', ')
      : '';
    prefReposFilter.value = Array.isArray(prefs.reposFilter)
      ? prefs.reposFilter.join(', ')
      : '';
    prefJiraUrl.value = prefs.jiraBaseUrlOverride || '';

    const slugs = state.workspaces
      .map((ws) => ws.slug)
      .filter((slug) => typeof slug === 'string' && slug.length > 0);
    if (slugs.length > 0) {
      availableWorkspacesHint.textContent = `Available: ${slugs.join(', ')}`;
      availableWorkspacesHint.classList.remove('hidden');
    } else {
      availableWorkspacesHint.textContent = '';
      availableWorkspacesHint.classList.add('hidden');
    }

    hideInlineBanner(prefsStatusBanner);
  }

  /**
   * Open the Settings drawer to a chosen sub-tab (`account` or `preferences`).
   *
   * @param {'account' | 'preferences'} [subtab]
   * @param {boolean} [forceReplace]
   */
  function openSettingsPanel(subtab = 'account', forceReplace = false) {
    if (forceReplace) {
      isReplacingToken = true;
    }
    populateAccountSection();
    populatePreferencesForm(state.preferences);
    switchSettingsSubtab(subtab);
    settingsPanel.classList.remove('hidden');
    toggleSettingsBtn.setAttribute('aria-expanded', 'true');
    closeShortcutsPopover();

    if (subtab === 'account') {
      if (!credentialsForm.classList.contains('hidden')) {
        if (authTypeSelect.value === 'api_token' && !bitbucketUsernameInput.value.trim()) {
          bitbucketUsernameInput.focus();
        } else {
          bitbucketTokenInput.focus();
        }
      } else {
        replaceTokenBtn.focus();
      }
    } else {
      prefPollInterval.focus();
    }
  }

  /**
   * Close the Settings drawer and discard any unsaved form edits.
   */
  function closeSettingsPanel() {
    const focusWasInside = settingsPanel.contains(document.activeElement);
    isReplacingToken = false;
    populateAccountSection();
    populatePreferencesForm(state.preferences);
    settingsPanel.classList.add('hidden');
    toggleSettingsBtn.setAttribute('aria-expanded', 'false');
    if (focusWasInside) {
      toggleSettingsBtn.focus();
    }
  }

  /**
   * Toggle shortcuts cheat-sheet popover.
   *
   * @param {boolean} [forceOpen]
   */
  function toggleShortcutsPopover(forceOpen) {
    const shouldOpen = typeof forceOpen === 'boolean'
      ? forceOpen
      : shortcutsPopover.classList.contains('hidden');
    shortcutsPopover.classList.toggle('hidden', !shouldOpen);
    shortcutsToggleBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
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
    loadingIndicator.classList.toggle('hidden', !loading);
    manualRefreshBtn.disabled = loading;
    manualRefreshBtn.classList.toggle('is-spinning', loading);
  }

  /**
   * Update header connection chip based on auth, error, and rate-limit state, with a rich tooltip.
   */
  function renderHeaderStatusChip() {
    connectionStatusChip.className = 'status-chip';
    const now = Date.now();
    const syncedSlugs = state.snapshot.syncedWorkspaces.length > 0
      ? state.snapshot.syncedWorkspaces
      : state.workspaces.map((ws) => ws.slug).filter(Boolean);
    const wsText = syncedSlugs.length > 0
      ? `Workspaces: ${syncedSlugs.join(', ')}`
      : 'No workspaces synced yet';

    if (!state.isAuthenticated) {
      connectionStatusChip.classList.add('status-chip-neutral');
      connectionStatusText.textContent = 'Not connected';
      connectionStatusChip.title = 'Click to connect your Bitbucket account';
      connectionStatusChip.setAttribute('aria-label', 'Connection status: Not connected. Open settings');
      return;
    }

    const displayLabel = state.user?.displayName || state.username || 'Connected';

    if (state.snapshot.error) {
      connectionStatusChip.classList.add('status-chip-error');
      connectionStatusText.textContent = 'Sync issue';
      connectionStatusChip.title = `${displayLabel} — ${state.snapshot.error}\n${wsText}`;
      connectionStatusChip.setAttribute('aria-label', `Connection status: Sync issue. Open settings`);
      return;
    }

    if (state.snapshot.rateLimitWarning || (state.syncState.backoffUntil && state.syncState.backoffUntil > now)) {
      connectionStatusChip.classList.add('status-chip-warning');
      connectionStatusText.textContent = 'Rate limited';
      const backoffNote = state.syncState.backoffUntil && state.syncState.backoffUntil > now
        ? `Auto-polling paused until ${new Date(state.syncState.backoffUntil).toLocaleTimeString()}`
        : 'Approaching Bitbucket API rate limit';
      connectionStatusChip.title = `${displayLabel} — ${backoffNote}\n${wsText}`;
      connectionStatusChip.setAttribute('aria-label', 'Connection status: Rate limited. Open settings');
      return;
    }

    connectionStatusChip.classList.add('status-chip-connected');
    connectionStatusText.textContent = displayLabel;
    connectionStatusChip.title = `Connected as ${displayLabel}\n${wsText}\nClick to open Settings`;
    connectionStatusChip.setAttribute('aria-label', `Connected as ${displayLabel}. Open settings`);
  }

  /**
   * Render footer timestamp (`#last-updated-text`) cleanly with full-date tooltip.
   */
  function renderFooterTimestamp() {
    const ts = state.snapshot.lastUpdated;
    if (!ts) {
      lastUpdatedText.textContent = 'Never updated';
      lastUpdatedText.removeAttribute('title');
      return;
    }

    const now = Date.now();
    const diffMinutes = Math.max(0, Math.floor((now - ts) / 60_000));
    let relativeLabel = 'just now';
    if (diffMinutes >= 1 && diffMinutes < 60) {
      relativeLabel = `${diffMinutes}m ago`;
    } else if (diffMinutes >= 60) {
      const diffHours = Math.floor(diffMinutes / 60);
      if (diffHours < 24) {
        relativeLabel = `${diffHours}h ago`;
      } else {
        const diffDays = Math.floor(diffHours / 24);
        relativeLabel = `${diffDays}d ago`;
      }
    }

    lastUpdatedText.textContent = `Updated ${relativeLabel}`;
    lastUpdatedText.title = `Last synced: ${new Date(ts).toLocaleString()}`;
  }

  /**
   * Build a crisp CI status pill (`.ci-badge`) from `pr.buildStatus`.
   *
   * @param {NonNullable<EnrichedPullRequest['buildStatus']>} buildStatus
   * @returns {HTMLAnchorElement | HTMLSpanElement}
   */
  function buildCiBadgeElement(buildStatus) {
    const safeUrl = sanitizeHttpsUrl(buildStatus.url);
    const el = safeUrl ? document.createElement('a') : document.createElement('span');

    let stateClass = 'ci-stopped';
    let label = '■ CI';
    if (buildStatus.state === 'SUCCESSFUL') {
      stateClass = 'ci-successful';
      label = buildStatus.totalCount > 1
        ? `✓ ${buildStatus.passedCount}/${buildStatus.totalCount}`
        : '✓ CI';
    } else if (buildStatus.state === 'FAILED') {
      stateClass = 'ci-failed';
      label = buildStatus.totalCount > 1
        ? `✕ ${buildStatus.passedCount}/${buildStatus.totalCount}`
        : '✕ CI';
    } else if (buildStatus.state === 'INPROGRESS') {
      stateClass = 'ci-inprogress';
      label = '⟳ CI';
    } else if (buildStatus.state === 'STOPPED') {
      stateClass = 'ci-stopped';
      label = '■ CI';
    }

    el.className = `ci-badge ${stateClass}`;
    el.textContent = label;

    const buildName = buildStatus.name || 'Checks';
    const countsPart = buildStatus.totalCount > 0
      ? ` (${buildStatus.passedCount}/${buildStatus.totalCount} passed)`
      : '';
    el.title = `Build: ${buildName}${countsPart}`;

    if (safeUrl && el instanceof HTMLAnchorElement) {
      el.href = safeUrl;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.setAttribute('aria-label', `${el.title} — open build status`);
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openSafeExternalUrl(safeUrl);
      });
    }

    return el;
  }

  /**
   * Build reviewer breakdown arrays and rich tooltip text for approval / changes-requested pills.
   *
   * @param {EnrichedPullRequest} pr
   * @returns {{ approvedNames: string[], changesRequestedNames: string[], pendingNames: string[], approvalTooltip: string }}
   */
  function buildReviewerBreakdown(pr) {
    /** @type {Map<string, { displayName: string, state: 'approved' | 'changes_requested' | 'pending' }>} */
    const byUuid = new Map();
    const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
    const participants = Array.isArray(pr.participants) ? pr.participants : [];

    for (const r of reviewers) {
      if (r.uuid && r.uuid !== pr.authorUuid) {
        byUuid.set(r.uuid, {
          displayName: r.displayName || 'Reviewer',
          state: 'pending'
        });
      }
    }

    for (const p of participants) {
      if (!p.uuid || p.uuid === pr.authorUuid) {
        continue;
      }
      const existing = byUuid.get(p.uuid);
      if (p.role === 'REVIEWER' || existing) {
        /** @type {'approved' | 'changes_requested' | 'pending'} */
        let reviewState = 'pending';
        if (p.state === 'approved' || p.approved) {
          reviewState = 'approved';
        } else if (p.state === 'changes_requested') {
          reviewState = 'changes_requested';
        }
        byUuid.set(p.uuid, {
          displayName: p.displayName || existing?.displayName || 'Reviewer',
          state: reviewState
        });
      }
    }

    /** @type {string[]} */
    const approvedNames = [];
    /** @type {string[]} */
    const changesRequestedNames = [];
    /** @type {string[]} */
    const pendingNames = [];

    for (const entry of byUuid.values()) {
      if (entry.state === 'approved') {
        approvedNames.push(entry.displayName);
      } else if (entry.state === 'changes_requested') {
        changesRequestedNames.push(entry.displayName);
      } else {
        pendingNames.push(entry.displayName);
      }
    }

    /** @type {string[]} */
    const lines = [];
    if (approvedNames.length > 0) {
      lines.push(`Approved: ${approvedNames.join(', ')}`);
    }
    if (changesRequestedNames.length > 0) {
      lines.push(`Changes requested: ${changesRequestedNames.join(', ')}`);
    }
    if (pendingNames.length > 0) {
      lines.push(`Pending: ${pendingNames.join(', ')}`);
    }
    const approvalTooltip = lines.length > 0
      ? lines.join('\n')
      : `${pr.approvalsCount} approval(s)`;

    return {
      approvedNames,
      changesRequestedNames,
      pendingNames,
      approvalTooltip
    };
  }

  /**
   * Build a single accessible PR card DOM element without `innerHTML`.
   *
   * @param {EnrichedPullRequest} pr
   * @param {boolean} isSelected
   * @param {boolean} isSnoozed
   * @param {number} now
   * @returns {HTMLDivElement}
   */
  function buildPrCardElement(pr, isSelected, isSnoozed, now) {
    const card = document.createElement('div');
    card.className = 'pr-card';
    if (pr.isYourTurn) {
      card.classList.add('is-your-turn');
    }
    if (isSelected) {
      card.classList.add('is-selected');
    }
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    card.dataset.prKey = pr.key;
    card.tabIndex = 0;

    // Top row: repo + PR ID + action/CI/stale badges
    const topRow = document.createElement('div');
    topRow.className = 'pr-card-top';

    const repoRow = document.createElement('div');
    repoRow.className = 'pr-repo-row';

    const repoEl = document.createElement('span');
    repoEl.className = 'pr-repo';
    repoEl.textContent = pr.repoFullName || pr.repoName;
    repoRow.appendChild(repoEl);

    const idEl = document.createElement('span');
    idEl.className = 'pr-id-tag';
    idEl.textContent = `#${pr.id}`;
    repoRow.appendChild(idEl);

    const badgesRow = document.createElement('div');
    badgesRow.className = 'pr-badges-row';

    if (pr.buildStatus) {
      badgesRow.appendChild(buildCiBadgeElement(pr.buildStatus));
    }

    const badgeMeta = ACTION_BADGE_LABELS[pr.actionState] ?? {
      label: pr.actionState,
      title: ''
    };
    const actionBadge = document.createElement('span');
    actionBadge.className = `action-badge state-${pr.actionState}`;
    actionBadge.textContent = badgeMeta.label;
    if (badgeMeta.title) {
      actionBadge.title = badgeMeta.title;
    }
    badgesRow.appendChild(actionBadge);

    if (pr.isStale) {
      const staleBadge = document.createElement('span');
      staleBadge.className = 'stale-badge';
      staleBadge.textContent = 'Stale';
      staleBadge.title = `No updates for ${Math.floor(pr.ageHours)}h`;
      badgesRow.appendChild(staleBadge);
    }

    topRow.append(repoRow, badgesRow);

    // Title link
    const safePrUrl = sanitizeHttpsUrl(pr.url);
    const titleLink = document.createElement('a');
    titleLink.className = 'pr-title-link';
    titleLink.textContent = pr.title;
    if (safePrUrl) {
      titleLink.href = safePrUrl;
      titleLink.target = '_blank';
      titleLink.rel = 'noopener noreferrer';
    }
    titleLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectPrCard(pr.key, false);
      void openSafeExternalUrl(pr.url);
    });

    // Jira chips + source branch
    const chipsRow = document.createElement('div');
    chipsRow.className = 'pr-chips-row';
    const jiraTickets = Array.isArray(pr.jiraTickets) ? pr.jiraTickets : [];

    for (const ticket of jiraTickets) {
      const safeTicketUrl = sanitizeHttpsUrl(ticket.url);
      if (safeTicketUrl) {
        const chipLink = document.createElement('a');
        chipLink.className = 'jira-chip';
        chipLink.href = safeTicketUrl;
        chipLink.target = '_blank';
        chipLink.rel = 'noopener noreferrer';
        chipLink.textContent = `${ticket.key} ↗`;
        chipLink.title = `Open ${ticket.key} in Jira`;
        chipLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void openSafeExternalUrl(safeTicketUrl);
        });
        chipsRow.appendChild(chipLink);
      } else {
        const chipStatic = document.createElement('span');
        chipStatic.className = 'jira-chip jira-chip-static';
        chipStatic.textContent = ticket.key;
        chipStatic.title = 'Set Jira Base URL in Preferences or src/config.js to enable direct links';
        chipsRow.appendChild(chipStatic);
      }
    }

    if (pr.sourceBranch) {
      const branchChip = document.createElement('span');
      branchChip.className = 'pr-branch-chip';
      branchChip.textContent = pr.sourceBranch;
      branchChip.title = pr.destinationBranch
        ? `${pr.sourceBranch} -> ${pr.destinationBranch}`
        : pr.sourceBranch;
      chipsRow.appendChild(branchChip);
    }

    // Footer row: author, approvals/CR/tasks/comments/snooze, quick actions, relative age
    const footerRow = document.createElement('div');
    footerRow.className = 'pr-card-footer';

    const metaLeft = document.createElement('div');
    metaLeft.className = 'pr-meta-left';

    const authorEl = document.createElement('span');
    authorEl.className = 'pr-author';
    authorEl.textContent = pr.authorName;
    authorEl.title = pr.authorName;
    metaLeft.appendChild(authorEl);

    const reviewerInfo = buildReviewerBreakdown(pr);

    if (pr.totalReviewers > 0 || pr.approvalsCount > 0) {
      const approvalsEl = document.createElement('span');
      approvalsEl.className = pr.approvalsCount > 0 ? 'pr-stat-pill has-approvals' : 'pr-stat-pill';
      const denom = Math.max(pr.totalReviewers, pr.approvalsCount);
      approvalsEl.textContent = `✓ ${pr.approvalsCount}/${denom}`;
      approvalsEl.title = reviewerInfo.approvalTooltip;
      metaLeft.appendChild(approvalsEl);
    }

    if (pr.changesRequestedCount > 0) {
      const crEl = document.createElement('span');
      crEl.className = 'pr-stat-pill meta-cr-badge';
      crEl.textContent = `✕ ${pr.changesRequestedCount} CR`;
      crEl.title = reviewerInfo.changesRequestedNames.length > 0
        ? `Changes requested by: ${reviewerInfo.changesRequestedNames.join(', ')}`
        : `${pr.changesRequestedCount} reviewer(s) requested changes`;
      metaLeft.appendChild(crEl);
    }

    if (pr.taskCount > 0) {
      const tasksEl = document.createElement('span');
      tasksEl.className = 'pr-stat-pill meta-task-badge';
      tasksEl.textContent = `☑ ${pr.taskCount}`;
      tasksEl.title = `${pr.taskCount} unresolved task(s)`;
      metaLeft.appendChild(tasksEl);
    }

    if (pr.commentCount > 0) {
      const commentsEl = document.createElement('span');
      commentsEl.className = 'pr-stat-pill';
      commentsEl.textContent = `${pr.commentCount} cmt`;
      commentsEl.title = `${pr.commentCount} comment(s)`;
      metaLeft.appendChild(commentsEl);
    }

    const snoozeEntry = isSnoozed ? state.snoozedMap[pr.key] : undefined;
    if (isSnoozed && snoozeEntry && activeFilter === 'snoozed') {
      const snoozeBadge = document.createElement('span');
      snoozeBadge.className = 'pr-stat-pill snooze-remaining-badge';
      snoozeBadge.textContent = formatSnoozeRemaining(snoozeEntry.until, now);
      snoozeBadge.title = `Snoozed until ${new Date(snoozeEntry.until).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })} (resurfaces early if PR updates)`;
      metaLeft.appendChild(snoozeBadge);
    }

    const metaRight = document.createElement('div');
    metaRight.className = 'pr-meta-right';

    const quickActions = document.createElement('div');
    quickActions.className = 'pr-quick-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'quick-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.title = 'Copy PR link (c)';
    copyBtn.setAttribute('aria-label', `Copy link for ${pr.title}`);
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyPrLink(pr);
    });
    quickActions.appendChild(copyBtn);

    const snoozeBtn = document.createElement('button');
    snoozeBtn.type = 'button';
    snoozeBtn.className = 'quick-action-btn';
    snoozeBtn.textContent = isSnoozed ? 'Unsnooze' : 'Snooze 4h';
    snoozeBtn.title = isSnoozed ? 'Unsnooze PR (s)' : 'Snooze PR for 4 hours (s)';
    snoozeBtn.setAttribute('aria-label', `${snoozeBtn.textContent} ${pr.title}`);
    snoozeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggleSnoozePr(pr);
    });
    quickActions.appendChild(snoozeBtn);

    const isoTimestamp = pr.updatedOn || pr.createdOn;
    const ageEl = document.createElement('span');
    ageEl.className = 'pr-age';
    ageEl.dataset.iso = isoTimestamp || '';
    ageEl.textContent = formatRelativeAge(isoTimestamp, now);
    if (isoTimestamp && !Number.isNaN(Date.parse(isoTimestamp))) {
      ageEl.title = `Updated ${new Date(isoTimestamp).toLocaleString()}`;
    }

    metaRight.append(quickActions, ageEl);
    footerRow.append(metaLeft, metaRight);

    card.append(topRow, titleLink);
    if (chipsRow.childElementCount > 0) {
      card.appendChild(chipsRow);
    }
    card.appendChild(footerRow);

    card.addEventListener('click', () => {
      selectPrCard(pr.key, false);
      void openSafeExternalUrl(pr.url);
    });

    card.addEventListener('focus', () => {
      selectPrCard(pr.key, false);
    });

    return card;
  }

  /**
   * Highlight a PR card as keyboard-selected, sync focus out of any previously focused PR card,
   * and smoothly scroll the selected card into view.
   *
   * @param {string | null} prKey
   * @param {boolean} [scrollIntoView]
   */
  function selectPrCard(prKey, scrollIntoView = true) {
    selectedPrKey = prKey;
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement) {
      const focusedCard = activeEl.closest('.pr-card');
      if (focusedCard instanceof HTMLElement && focusedCard.dataset.prKey !== prKey) {
        activeEl.blur();
      }
    }

    const cards = prItemsContainer.querySelectorAll('.pr-card');
    for (const node of cards) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const match = Boolean(prKey && node.dataset.prKey === prKey);
      node.classList.toggle('is-selected', match);
      node.setAttribute('aria-selected', match ? 'true' : 'false');
      if (match && scrollIntoView) {
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  /**
   * Render non-blocking error, rate-limit, and backoff banners above the PR list.
   *
   * @param {number} now
   */
  function renderStatusBanners(now) {
    const errText = state.snapshot.error;
    if (errText) {
      errorTitle.textContent = state.snapshot.prList.length > 0
        ? 'Sync Issue (showing cached PRs)'
        : 'Sync Issue';
      errorMessage.textContent = errText;
      errorSetupBtn.textContent = (state.snapshot.isAuthError || state.isAuthError) ? 'Update Token' : 'Preferences';
      errorAlert.classList.remove('hidden');
    } else {
      errorAlert.classList.add('hidden');
    }

    rateLimitBanner.classList.toggle('hidden', !state.snapshot.rateLimitWarning);

    const backoffUntil = state.syncState.backoffUntil;
    if (state.isAuthenticated && typeof backoffUntil === 'number' && backoffUntil > now) {
      const remainingSec = Math.max(1, Math.ceil((backoffUntil - now) / 1000));
      const etaLabel = remainingSec >= 60
        ? `${Math.ceil(remainingSec / 60)}m`
        : `${remainingSec}s`;
      backoffMessage.textContent = `Auto-polling paused for ~${etaLabel}. You can still click Refresh anytime.`;
      backoffBanner.classList.remove('hidden');
    } else {
      backoffBanner.classList.add('hidden');
    }
  }

  /**
   * Render the Bitbucket PRs tab: filter pills, counts, search, banners, PR cards, or empty/onboarding state.
   */
  function renderBitbucketTab() {
    const prevScrollTop = mainContent.scrollTop;
    const now = Date.now();
    extensionContainer.classList.toggle('compact-mode', Boolean(state.preferences.compactMode));

    if (!state.isAuthenticated) {
      triageControls.classList.add('hidden');
      prItemsContainer.replaceChildren();
      emptyState.classList.add('hidden');
      setupHint.classList.remove('hidden');
      rateLimitBanner.classList.add('hidden');
      backoffBanner.classList.add('hidden');
      if (state.snapshot.error) {
        errorTitle.textContent = 'Connection Required';
        errorMessage.textContent = state.snapshot.error;
        errorSetupBtn.textContent = 'Update Token';
        errorAlert.classList.remove('hidden');
      } else {
        errorAlert.classList.add('hidden');
      }
      visiblePrs = [];
      selectedPrKey = null;
      return;
    }

    setupHint.classList.add('hidden');
    triageControls.classList.remove('hidden');
    renderStatusBanners(now);

    const prs = state.snapshot.prList;
    const snoozedMap = state.snoozedMap;
    const counts = computeCounts(prs, snoozedMap, now);

    countActionRequired.textContent = String(counts.actionRequired);
    countReviewing.textContent = String(counts.reviewing);
    countAuthored.textContent = String(counts.authored);
    countAll.textContent = String(counts.all);
    countSnoozed.textContent = String(counts.snoozed);

    for (const pill of filterPillButtons) {
      const pillFilter = pill.dataset.filter;
      const isSelected = pillFilter === activeFilter;
      pill.classList.toggle('active', isSelected);
      pill.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      pill.tabIndex = isSelected ? 0 : -1;
    }

    prSearchClearBtn.classList.toggle('hidden', searchQuery.trim().length === 0);

    visiblePrs = filterAndSortPrs(prs, {
      filter: activeFilter,
      query: searchQuery,
      snoozedMap,
      now
    });

    prCountTitle.textContent = `${visiblePrs.length} PR${visiblePrs.length === 1 ? '' : 's'}`;

    if (visiblePrs.length === 0) {
      prItemsContainer.replaceChildren();
      selectedPrKey = null;
      emptyState.classList.remove('hidden');

      const trimmedQuery = searchQuery.trim();
      if (trimmedQuery) {
        const allMatches = activeFilter !== 'all'
          ? filterAndSortPrs(prs, { filter: 'all', query: trimmedQuery, snoozedMap, now })
          : [];

        if (activeFilter !== 'all' && allMatches.length > 0) {
          const filterLabel = FILTER_LABELS[activeFilter] ?? activeFilter;
          emptyStateTitle.textContent = 'No matches in this filter';
          emptyStateMessage.textContent = `No matches in ${filterLabel} — ${allMatches.length} match${allMatches.length === 1 ? '' : 'es'} in All PRs.`;
          emptyStateActionBtn.textContent = 'Show in All PRs';
          emptyStateActionBtn.dataset.emptyAction = 'show_in_all';
          emptyStateActionBtn.classList.remove('hidden');
        } else {
          emptyStateTitle.textContent = 'No matching pull requests';
          emptyStateMessage.textContent = `Nothing matched "${trimmedQuery}" in this view.`;
          emptyStateActionBtn.textContent = 'Clear Search';
          emptyStateActionBtn.dataset.emptyAction = 'clear_search';
          emptyStateActionBtn.classList.remove('hidden');
        }
      } else if (activeFilter === 'action_required' && counts.all > 0) {
        emptyStateTitle.textContent = 'Nothing needs your action!';
        emptyStateMessage.textContent = `You have ${counts.all} open pull request${counts.all === 1 ? '' : 's'} waiting on others.`;
        emptyStateActionBtn.textContent = 'View All PRs';
        emptyStateActionBtn.dataset.emptyAction = 'view_all';
        emptyStateActionBtn.classList.remove('hidden');
      } else if (activeFilter === 'snoozed') {
        emptyStateTitle.textContent = 'No snoozed pull requests';
        emptyStateMessage.textContent = 'Use Snooze 4h (or press s) to temporarily hide a PR until it updates.';
        emptyStateActionBtn.textContent = 'View All PRs';
        emptyStateActionBtn.dataset.emptyAction = 'view_all';
        emptyStateActionBtn.classList.remove('hidden');
      } else {
        emptyStateTitle.textContent = 'All caught up!';
        emptyStateMessage.textContent = 'No open pull requests in this view.';
        emptyStateActionBtn.classList.add('hidden');
      }
      return;
    }

    emptyState.classList.add('hidden');
    if (selectedPrKey && !visiblePrs.some((pr) => pr.key === selectedPrKey)) {
      selectedPrKey = null;
    }

    const fragment = document.createDocumentFragment();
    for (const pr of visiblePrs) {
      const card = buildPrCardElement(
        pr,
        Boolean(selectedPrKey && pr.key === selectedPrKey),
        isPrSnoozed(pr, snoozedMap, now),
        now
      );
      fragment.appendChild(card);
    }
    prItemsContainer.replaceChildren(fragment);

    if (prevScrollTop > 0) {
      mainContent.scrollTop = Math.min(prevScrollTop, Math.max(0, mainContent.scrollHeight - mainContent.clientHeight));
    }
  }

  /**
   * Render the Jira tab with snooze-aware active tickets, Filter PRs drill-down, and adaptive Jira CTA.
   */
  function renderJiraTab() {
    const effectiveJiraUrl = getEffectiveJiraBaseUrl(state.preferences);
    const hasJiraUrl = Boolean(effectiveJiraUrl);
    const hasOverrideUrl = Boolean(sanitizeHttpsUrl(state.preferences.jiraBaseUrlOverride));

    jiraSetupHint.classList.toggle('hidden', hasJiraUrl);
    openJiraBtn.disabled = false;
    if (!hasJiraUrl) {
      openJiraBtn.textContent = 'Configure Jira URL';
      openJiraBtn.title = 'Configure CENTRAL_URLS.MEZZANINE_JIRA_URL in src/config.js or set a Jira URL override in Preferences';
    } else if (hasOverrideUrl) {
      openJiraBtn.textContent = 'Open Jira ↗';
      openJiraBtn.title = `Open ${effectiveJiraUrl}`;
    } else {
      openJiraBtn.textContent = 'Open Mezzanine Jira ↗';
      openJiraBtn.title = `Open ${effectiveJiraUrl}`;
    }

    if (!state.isAuthenticated) {
      jiraTicketsCount.textContent = 'Not connected';
      jiraTicketsContainer.replaceChildren();
      jiraEmptyTitle.textContent = 'Connect Bitbucket first';
      jiraEmptyMessage.textContent = 'Sign in with your Bitbucket credentials to surface Jira keys referenced in your open pull requests.';
      jiraConnectBtn.classList.remove('hidden');
      jiraEmptyState.classList.remove('hidden');
      return;
    }

    jiraConnectBtn.classList.add('hidden');
    const now = Date.now();
    const tickets = collectActiveJiraTickets(state.snapshot.prList, state.snoozedMap, now);
    jiraTicketsCount.textContent = `${tickets.length} active ticket${tickets.length === 1 ? '' : 's'}`;

    if (tickets.length === 0) {
      jiraTicketsContainer.replaceChildren();
      jiraEmptyTitle.textContent = 'No Jira tickets found';
      jiraEmptyMessage.textContent = 'Reference a Jira key (e.g. MEZ-123) in a PR title or branch name to surface it here.';
      jiraEmptyState.classList.remove('hidden');
      return;
    }

    jiraEmptyState.classList.add('hidden');
    const fragment = document.createDocumentFragment();

    for (const ticket of tickets) {
      const card = document.createElement('div');
      card.className = ticket.hasYourTurn
        ? 'jira-ticket-card has-your-turn'
        : 'jira-ticket-card';

      const info = document.createElement('div');
      info.className = 'jira-ticket-info';

      const keyRow = document.createElement('div');
      keyRow.className = 'jira-ticket-key-row';

      const keyEl = document.createElement('span');
      keyEl.className = 'jira-ticket-key';
      keyEl.textContent = ticket.key;
      keyRow.appendChild(keyEl);

      if (ticket.hasYourTurn) {
        const badge = document.createElement('span');
        badge.className = 'action-badge state-needs_review';
        badge.textContent = 'Needs Action';
        keyRow.appendChild(badge);
      }

      const metaEl = document.createElement('div');
      metaEl.className = 'jira-ticket-meta';
      metaEl.textContent = `${ticket.prCount} linked open PR${ticket.prCount === 1 ? '' : 's'}`;

      info.append(keyRow, metaEl);

      const actionsEl = document.createElement('div');
      actionsEl.className = 'jira-ticket-actions';

      const filterBtn = document.createElement('button');
      filterBtn.type = 'button';
      filterBtn.className = 'btn btn-ghost btn-sm';
      filterBtn.textContent = 'Filter PRs';
      filterBtn.title = `Filter Bitbucket PRs matching ${ticket.key}`;
      filterBtn.setAttribute('aria-label', `Filter pull requests for ${ticket.key}`);
      filterBtn.addEventListener('click', () => {
        activeFilter = 'all';
        selectedPrKey = null;
        searchQuery = ticket.key;
        prSearchInput.value = ticket.key;
        switchTopTab('bitbucket-tab');
        renderBitbucketTab();
        prItemsContainer.focus();
        prSearchInput.focus();
      });
      actionsEl.appendChild(filterBtn);

      const safeTicketUrl = sanitizeHttpsUrl(ticket.url);
      if (safeTicketUrl) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn btn-secondary btn-sm';
        openBtn.textContent = 'Open ↗';
        openBtn.setAttribute('aria-label', `Open ${ticket.key} in Jira`);
        openBtn.addEventListener('click', () => {
          void openSafeExternalUrl(safeTicketUrl);
        });
        actionsEl.appendChild(openBtn);
      } else {
        const setUrlBtn = document.createElement('button');
        setUrlBtn.type = 'button';
        setUrlBtn.className = 'btn btn-ghost btn-sm';
        setUrlBtn.textContent = 'Set URL';
        setUrlBtn.addEventListener('click', () => {
          openSettingsPanel('preferences');
          prefJiraUrl.focus();
        });
        actionsEl.appendChild(setUrlBtn);
      }

      card.append(info, actionsEl);
      fragment.appendChild(card);
    }

    jiraTicketsContainer.replaceChildren(fragment);
  }

  /**
   * Render the Confluence tab (using `CENTRAL_URLS.CONFLUENCE_URL` if configured, else Coming Soon placeholder).
   */
  function renderConfluenceTab() {
    const safeConfluenceUrl = sanitizeHttpsUrl(CENTRAL_URLS.CONFLUENCE_URL);
    confluenceConfiguredCard.classList.toggle('hidden', !safeConfluenceUrl);
    confluencePlaceholderCard.classList.toggle('hidden', Boolean(safeConfluenceUrl));
  }

  /**
   * Populate `+ Add Product` form inputs from stored feedback.
   */
  function renderAddProductForm() {
    const selectedSet = new Set(state.productFeedback.requestedProducts);
    const checkboxes = addProductForm.querySelectorAll('input[name="products"]');
    for (const el of checkboxes) {
      if (el instanceof HTMLInputElement) {
        el.checked = selectedSet.has(el.value);
      }
    }
    customProductFeedbackInput.value = state.productFeedback.productFeedback || '';
  }

  /**
   * Render all UI regions from current `state`.
   */
  function renderAll() {
    renderHeaderStatusChip();
    renderFooterTimestamp();
    renderBitbucketTab();
    renderJiraTab();
    renderConfluenceTab();

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
        renderAddProductForm();
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
    renderFooterTimestamp();
    const now = Date.now();
    const ageNodes = prItemsContainer.querySelectorAll('.pr-age');
    for (const node of ageNodes) {
      if (node instanceof HTMLElement && node.dataset.iso) {
        node.textContent = formatRelativeAge(node.dataset.iso, now);
      }
    }
    if (activeTabId === 'bitbucket-tab' && activeFilter === 'snoozed') {
      const snoozeBadges = prItemsContainer.querySelectorAll('.snooze-remaining-badge');
      if (snoozeBadges.length > 0) {
        renderBitbucketTab();
      }
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
      showToast('Connect Bitbucket first to sync PRs.');
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
   * Collect and validate credential inputs from the Account & Setup form.
   *
   * @returns {{ authType: AuthType, username: string, token: string } | null}
   */
  function readValidatedCredentialInputs() {
    const authType = normalizeAuthType(authTypeSelect.value);
    const username = bitbucketUsernameInput.value.trim();
    const token = bitbucketTokenInput.value.trim();

    if (authType === 'api_token' && !username) {
      showInlineBanner(authStatusBanner, 'Enter your Atlassian account email for API Token login.', 'error');
      bitbucketUsernameInput.focus();
      return null;
    }
    if (!token) {
      showInlineBanner(authStatusBanner, 'Paste your Bitbucket token before continuing.', 'error');
      bitbucketTokenInput.focus();
      return null;
    }
    return { authType, username, token };
  }

  /**
   * Disable/enable Account form controls during async verification or saving.
   *
   * @param {boolean} busy
   */
  function setCredentialsFormBusy(busy) {
    testConnectionBtn.disabled = busy;
    saveSettingsBtn.disabled = busy;
    cancelSettingsBtn.disabled = busy;
  }

  /**
   * Test entered Bitbucket credentials without persisting them.
   */
  async function handleTestConnection() {
    const creds = readValidatedCredentialInputs();
    if (!creds) {
      return;
    }

    setCredentialsFormBusy(true);
    showInlineBanner(authStatusBanner, 'Testing Bitbucket connection...', 'info');
    try {
      const res = await sendWorkerMessage({ action: 'TEST_CONNECTION', creds });
      if (res.ok) {
        const name = res.user?.displayName || 'Bitbucket User';
        const wsCount = Array.isArray(res.workspaces) ? res.workspaces.length : 0;
        showInlineBanner(
          authStatusBanner,
          `Verified as ${name} (${wsCount} accessible workspace${wsCount === 1 ? '' : 's'}).`,
          'success'
        );
      } else {
        showInlineBanner(authStatusBanner, String(res.error || 'Verification failed.'), 'error');
      }
    } catch (err) {
      showInlineBanner(
        authStatusBanner,
        err instanceof Error ? err.message : 'Failed to test connection.',
        'error'
      );
    } finally {
      setCredentialsFormBusy(false);
    }
  }

  /**
   * Verify, save credentials, trigger immediate sync, and close Settings on success.
   *
   * @param {SubmitEvent} e
   */
  async function handleSaveCredentials(e) {
    e.preventDefault();
    const creds = readValidatedCredentialInputs();
    if (!creds) {
      return;
    }

    setCredentialsFormBusy(true);
    showInlineBanner(authStatusBanner, 'Verifying and syncing pull requests...', 'info');
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({ action: 'SAVE_CREDENTIALS', creds });
      if (!res.ok) {
        showInlineBanner(authStatusBanner, String(res.error || 'Could not save credentials.'), 'error');
        return;
      }

      bitbucketTokenInput.value = '';
      isReplacingToken = false;
      await refreshStateFromWorker({ applyDefaultFilter: true });
      markLocalStateMutation();
      closeSettingsPanel();
      showToast('Bitbucket connected & synced!', 'success');
    } catch (err) {
      showInlineBanner(
        authStatusBanner,
        err instanceof Error ? err.message : 'Failed to save credentials.',
        'error'
      );
    } finally {
      setCredentialsFormBusy(false);
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
    const rawJiraUrl = prefJiraUrl.value.trim();

    if (rawJiraUrl) {
      const sanitized = sanitizeHttpsUrl(rawJiraUrl);
      if (!sanitized) {
        showInlineBanner(
          prefsStatusBanner,
          'Jira Base URL override must be a valid https:// URL (e.g. https://mezzanine.jira.example.com).',
          'error'
        );
        prefJiraUrl.focus();
        return;
      }
    }

    const nextPrefs = {
      pollIntervalMinutes: Number(prefPollInterval.value),
      badgeMode: prefBadgeMode.value,
      staleThresholdHours: Number(prefStaleHours.value),
      defaultFilter: prefDefaultFilter.value,
      notificationsEnabled: prefNotifications.checked,
      compactMode: prefCompactMode.checked,
      workspacesFilter: parseCsvList(prefWorkspacesFilter.value),
      reposFilter: parseCsvList(prefReposFilter.value),
      jiraBaseUrlOverride: rawJiraUrl
    };

    savePreferencesBtn.disabled = true;
    showInlineBanner(prefsStatusBanner, 'Saving preferences...', 'info');
    try {
      markLocalStateMutation();
      const res = await sendWorkerMessage({
        action: 'UPDATE_PREFERENCES',
        preferences: nextPrefs
      });
      if (res.ok === false) {
        showInlineBanner(prefsStatusBanner, String(res.error || 'Could not save preferences.'), 'error');
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
        prefsStatusBanner,
        err instanceof Error ? err.message : 'Failed to save preferences.',
        'error'
      );
    } finally {
      savePreferencesBtn.disabled = false;
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
    openSettingsPanel(state.isAuthenticated ? 'account' : 'account');
  });

  toggleSettingsBtn.addEventListener('click', () => {
    if (settingsPanel.classList.contains('hidden')) {
      openSettingsPanel(state.isAuthenticated ? 'preferences' : 'account');
    } else {
      closeSettingsPanel();
    }
  });
  closeSettingsBtn.addEventListener('click', closeSettingsPanel);
  cancelSettingsBtn.addEventListener('click', closeSettingsPanel);
  cancelPreferencesBtn.addEventListener('click', closeSettingsPanel);

  settingsAccountTab.addEventListener('click', () => switchSettingsSubtab('account'));
  settingsPreferencesTab.addEventListener('click', () => switchSettingsSubtab('preferences'));
  wireTablistArrowNavigation([settingsAccountTab, settingsPreferencesTab], (btn) => {
    switchSettingsSubtab(btn === settingsPreferencesTab ? 'preferences' : 'account');
  });

  replaceTokenBtn.addEventListener('click', () => {
    isReplacingToken = true;
    populateAccountSection();
    if (authTypeSelect.value === 'api_token' && !bitbucketUsernameInput.value.trim()) {
      bitbucketUsernameInput.focus();
    } else {
      bitbucketTokenInput.focus();
    }
  });

  signOutBtn.addEventListener('click', () => {
    signOutConfirm.classList.remove('hidden');
    confirmSignOutBtn.focus();
  });

  cancelSignOutBtn.addEventListener('click', () => {
    signOutConfirm.classList.add('hidden');
    signOutBtn.focus();
  });

  confirmSignOutBtn.addEventListener('click', async () => {
    confirmSignOutBtn.disabled = true;
    try {
      markLocalStateMutation();
      await sendWorkerMessage({ action: 'SIGN_OUT' });
      isReplacingToken = false;
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
      confirmSignOutBtn.disabled = false;
    }
  });

  createApiTokenLink.addEventListener('click', (e) => {
    e.preventDefault();
    void openSafeExternalUrl(AUTH_SETUP_LINKS.atlassianApiTokens);
  });

  authTypeSelect.addEventListener('change', syncAuthMethodFields);
  toggleTokenVisibilityBtn.addEventListener('click', () => {
    const showing = bitbucketTokenInput.type === 'text';
    bitbucketTokenInput.type = showing ? 'password' : 'text';
    const nextLabel = showing ? 'Show token' : 'Hide token';
    toggleTokenVisibilityBtn.setAttribute('aria-label', nextLabel);
    toggleTokenVisibilityBtn.title = nextLabel;
  });

  testConnectionBtn.addEventListener('click', () => {
    void handleTestConnection();
  });
  credentialsForm.addEventListener('submit', (e) => {
    void handleSaveCredentials(e);
  });
  preferencesForm.addEventListener('submit', (e) => {
    void handleSavePreferences(e);
  });

  manualRefreshBtn.addEventListener('click', () => {
    void triggerManualSync();
  });
  errorSetupBtn.addEventListener('click', () => {
    const isAuthErr = Boolean(state.snapshot.isAuthError || state.isAuthError || !state.isAuthenticated);
    if (isAuthErr) {
      openSettingsPanel('account', true);
    } else {
      openSettingsPanel('preferences');
    }
  });
  setupHintBtn.addEventListener('click', () => openSettingsPanel('account'));
  jiraConnectBtn.addEventListener('click', () => openSettingsPanel('account'));

  for (const pill of filterPillButtons) {
    pill.addEventListener('click', () => {
      const nextFilter = /** @type {PrFilter | undefined} */ (pill.dataset.filter);
      if (!nextFilter) {
        return;
      }
      activeFilter = nextFilter;
      selectedPrKey = null;
      renderBitbucketTab();
    });
  }

  wireTablistArrowNavigation(filterPillButtons, (pill) => {
    const nextFilter = /** @type {PrFilter | undefined} */ (pill.dataset.filter);
    if (!nextFilter) {
      return;
    }
    activeFilter = nextFilter;
    selectedPrKey = null;
    renderBitbucketTab();
  });

  prSearchInput.addEventListener('input', () => {
    searchQuery = prSearchInput.value;
    selectedPrKey = null;
    renderBitbucketTab();
  });

  prSearchClearBtn.addEventListener('click', () => {
    searchQuery = '';
    prSearchInput.value = '';
    selectedPrKey = null;
    renderBitbucketTab();
    prSearchInput.focus();
  });

  emptyStateActionBtn.addEventListener('click', () => {
    const action = emptyStateActionBtn.dataset.emptyAction;
    selectedPrKey = null;
    if (action === 'clear_search') {
      searchQuery = '';
      prSearchInput.value = '';
    } else {
      activeFilter = 'all';
    }
    renderBitbucketTab();
  });

  openJiraBtn.addEventListener('click', () => {
    const effectiveJiraUrl = getEffectiveJiraBaseUrl(state.preferences);
    if (!effectiveJiraUrl) {
      openSettingsPanel('preferences');
      prefJiraUrl.focus();
      return;
    }
    void openSafeExternalUrl(effectiveJiraUrl);
  });

  jiraOpenPrefsBtn.addEventListener('click', () => {
    openSettingsPanel('preferences');
    prefJiraUrl.focus();
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

    if (e.key === 'r') {
      e.preventDefault();
      void triggerManualSync();
      return;
    }

    if (activeTabId !== 'bitbucket-tab' || visiblePrs.length === 0) {
      return;
    }

    const currentIndex = selectedPrKey
      ? visiblePrs.findIndex((pr) => pr.key === selectedPrKey)
      : -1;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex < 0
        ? 0
        : Math.min(visiblePrs.length - 1, currentIndex + 1);
      selectPrCard(visiblePrs[nextIndex].key, true);
      return;
    }

    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex < 0
        ? 0
        : Math.max(0, currentIndex - 1);
      selectPrCard(visiblePrs[prevIndex].key, true);
      return;
    }

    if (currentIndex < 0) {
      return;
    }
    const selectedPr = visiblePrs[currentIndex];
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
  renderStaticMetadata();
  try {
    await refreshStateFromWorker({ applyDefaultFilter: true, updateAddProduct: true });
  } catch (err) {
    renderAll();
    showToast(err instanceof Error ? err.message : 'Unable to load extension state.', 'error');
  }
});
