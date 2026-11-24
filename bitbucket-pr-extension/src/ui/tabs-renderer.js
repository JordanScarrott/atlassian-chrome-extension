import {
  AUTH_SETUP_LINKS,
  CENTRAL_URLS,
  getEffectiveJiraBaseUrl,
  sanitizeHttpsUrl
} from '../config.js';
import {
  filterPrsByRelatedTicket,
  formatFooterUpdated,
  formatRelativeAge,
  getCrossFilterEmptyHint,
  getHeaderConnectionDescriptor
} from '../popup-helpers.js';
import {
  buildRelatedPrMap,
  collectActiveJiraTickets,
  computeCounts,
  filterAndSortPrs,
  groupPrsByTicket,
  isPrSnoozed
} from '../pr-triage.js';
import {
  buildPrCardElement,
  buildTicketGroupElement
} from './pr-card-renderer.js';

/** @typedef {import('../config.js').Preferences} Preferences */
/** @typedef {import('../pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('../pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('../storage.js').CachedUser} CachedUser */
/** @typedef {import('../storage.js').ProductFeedbackState} ProductFeedbackState */
/** @typedef {import('../storage.js').SnoozedMap} SnoozedMap */
/** @typedef {import('../storage.js').WorkspaceSummary} WorkspaceSummary */
/** @typedef {import('./pr-card-renderer.js').PrCardCallbacks} PrCardCallbacks */

export const TOP_TABS = Object.freeze(['bitbucket-tab', 'jira-tab', 'confluence-tab', 'add-product-tab']);

/**
 * Resolve a DOM element by ID and assert its concrete element class.
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
 * Resolve Bitbucket PR list tab DOM elements.
 *
 * @returns {BitbucketTabElements}
 */
export function resolveBitbucketTabElements() {
  return {
    extensionContainer: getEl('extension-container', HTMLDivElement),
    mainContent: getEl('main-content', HTMLElement),
    triageControls: getEl('triage-controls', HTMLDivElement),
    filterPillButtons: /** @type {HTMLButtonElement[]} */ (
      Array.from(document.querySelectorAll('.filter-pill')).filter((el) => el instanceof HTMLButtonElement)
    ),
    countActionRequired: getEl('count-action-required', HTMLSpanElement),
    countReviewing: getEl('count-reviewing', HTMLSpanElement),
    countAuthored: getEl('count-authored', HTMLSpanElement),
    countAll: getEl('count-all', HTMLSpanElement),
    countSnoozed: getEl('count-snoozed', HTMLSpanElement),
    prSearchClearBtn: getEl('pr-search-clear-btn', HTMLButtonElement),
    groupByTicketBtn: getEl('group-by-ticket-btn', HTMLButtonElement),
    prCountTitle: getEl('pr-count-title', HTMLSpanElement),
    errorAlert: getEl('error-alert', HTMLDivElement),
    errorTitle: getEl('error-title', HTMLElement),
    errorMessage: getEl('error-message', HTMLParagraphElement),
    errorSetupBtn: getEl('error-setup-btn', HTMLButtonElement),
    rateLimitBanner: getEl('rate-limit-banner', HTMLDivElement),
    backoffBanner: getEl('backoff-banner', HTMLDivElement),
    backoffMessage: getEl('backoff-message', HTMLParagraphElement),
    relatedScopeBanner: getEl('related-scope-banner', HTMLDivElement),
    relatedScopeText: getEl('related-scope-text', HTMLSpanElement),
    prItemsContainer: getEl('pr-items-container', HTMLDivElement),
    emptyState: getEl('empty-state', HTMLDivElement),
    emptyStateTitle: getEl('empty-state-title', HTMLHeadingElement),
    emptyStateMessage: getEl('empty-state-message', HTMLParagraphElement),
    emptyStateActionBtn: getEl('empty-state-action-btn', HTMLButtonElement),
    setupHint: getEl('setup-hint', HTMLDivElement)
  };
}

/**
 * Resolve Jira tab DOM elements.
 *
 * @returns {JiraTabElements}
 */
export function resolveJiraTabElements() {
  return {
    openJiraBtn: getEl('open-jira-btn', HTMLButtonElement),
    jiraSetupHint: getEl('jira-setup-hint', HTMLDivElement),
    jiraTicketsCount: getEl('jira-tickets-count', HTMLSpanElement),
    jiraTicketsContainer: getEl('jira-tickets-container', HTMLDivElement),
    jiraEmptyState: getEl('jira-empty-state', HTMLDivElement),
    jiraEmptyTitle: getEl('jira-empty-title', HTMLHeadingElement),
    jiraEmptyMessage: getEl('jira-empty-message', HTMLParagraphElement),
    jiraConnectBtn: getEl('jira-connect-btn', HTMLButtonElement)
  };
}

/**
 * Resolve header, tab navigation, Confluence, + Add Product, footer, shortcuts, and toast elements.
 *
 * @returns {{
 *   appTitle: HTMLHeadingElement,
 *   connectionStatusChip: HTMLButtonElement,
 *   connectionStatusText: HTMLSpanElement,
 *   manualRefreshBtn: HTMLButtonElement,
 *   toggleSettingsBtn: HTMLButtonElement,
 *   tabButtons: HTMLButtonElement[],
 *   tabPanels: HTMLElement[],
 *   prSearchInput: HTMLInputElement,
 *   loadingIndicator: HTMLDivElement,
 *   clearRelatedScopeBtn: HTMLButtonElement,
 *   setupHintBtn: HTMLButtonElement,
 *   setupHintGitHubBtn: HTMLButtonElement,
 *   jiraOpenPrefsBtn: HTMLButtonElement,
 *   confluenceConfiguredCard: HTMLDivElement,
 *   confluencePlaceholderCard: HTMLDivElement,
 *   openConfluenceBtn: HTMLButtonElement,
 *   addProductForm: HTMLFormElement,
 *   customProductFeedbackInput: HTMLTextAreaElement,
 *   productRequestSuccessAlert: HTMLDivElement,
 *   lastUpdatedText: HTMLDivElement,
 *   shortcutsToggleBtn: HTMLButtonElement,
 *   shortcutsPopover: HTMLElement,
 *   closeShortcutsBtn: HTMLButtonElement,
 *   appVersionEl: HTMLDivElement,
 *   toastContainer: HTMLDivElement
 * }}
 */
export function resolveShellDomElements() {
  return {
    appTitle: getEl('app-title', HTMLHeadingElement),
    connectionStatusChip: getEl('connection-status-chip', HTMLButtonElement),
    connectionStatusText: getEl('connection-status-text', HTMLSpanElement),
    manualRefreshBtn: getEl('manual-refresh-btn', HTMLButtonElement),
    toggleSettingsBtn: getEl('toggle-settings-btn', HTMLButtonElement),
    tabButtons: /** @type {HTMLButtonElement[]} */ (
      Array.from(document.querySelectorAll('.tab-btn')).filter((el) => el instanceof HTMLButtonElement)
    ),
    tabPanels: /** @type {HTMLElement[]} */ (
      Array.from(document.querySelectorAll('.tab-panel')).filter((el) => el instanceof HTMLElement)
    ),
    prSearchInput: getEl('pr-search-input', HTMLInputElement),
    loadingIndicator: getEl('loading-indicator', HTMLDivElement),
    clearRelatedScopeBtn: getEl('clear-related-scope-btn', HTMLButtonElement),
    setupHintBtn: getEl('setup-hint-btn', HTMLButtonElement),
    setupHintGitHubBtn: getEl('setup-hint-github-btn', HTMLButtonElement),
    jiraOpenPrefsBtn: getEl('jira-open-prefs-btn', HTMLButtonElement),
    confluenceConfiguredCard: getEl('confluence-configured-card', HTMLDivElement),
    confluencePlaceholderCard: getEl('confluence-placeholder-card', HTMLDivElement),
    openConfluenceBtn: getEl('open-confluence-btn', HTMLButtonElement),
    addProductForm: getEl('add-product-form', HTMLFormElement),
    customProductFeedbackInput: getEl('custom-product-feedback', HTMLTextAreaElement),
    productRequestSuccessAlert: getEl('product-request-success', HTMLDivElement),
    lastUpdatedText: getEl('last-updated-text', HTMLDivElement),
    shortcutsToggleBtn: getEl('shortcuts-toggle-btn', HTMLButtonElement),
    shortcutsPopover: getEl('shortcuts-popover', HTMLElement),
    closeShortcutsBtn: getEl('close-shortcuts-btn', HTMLButtonElement),
    appVersionEl: getEl('app-version', HTMLDivElement),
    toastContainer: getEl('toast-container', HTMLDivElement)
  };
}

/** @type {Readonly<Record<string, string>>} */
const TAB_TITLES = Object.freeze({
  'bitbucket-tab': 'Atlassian Hub',
  'jira-tab': 'Jira Hub',
  'confluence-tab': 'Confluence Hub',
  'add-product-tab': 'Customizer'
});

/**
 * Toggle between top-level product tabs (`bitbucket-tab`, `jira-tab`, `confluence-tab`, `add-product-tab`).
 *
 * @param {{
 *   tabButtons: readonly HTMLButtonElement[],
 *   tabPanels: readonly HTMLElement[],
 *   appTitle: HTMLHeadingElement
 * }} elements
 * @param {string} nextTabId
 * @returns {boolean}
 */
export function renderTopTabSelection(elements, nextTabId) {
  if (!TOP_TABS.includes(nextTabId)) {
    return false;
  }

  for (const btn of elements.tabButtons) {
    const isSelected = btn.dataset.tab === nextTabId;
    btn.classList.toggle('active', isSelected);
    btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    btn.tabIndex = isSelected ? 0 : -1;
  }

  const targetPanelId = `${nextTabId}-panel`;
  for (const panel of elements.tabPanels) {
    panel.classList.toggle('hidden', panel.id !== targetPanelId);
  }

  elements.appTitle.textContent = TAB_TITLES[nextTabId] ?? 'Customizer';
  return true;
}

/**
 * Render a non-blocking toast element inside `toastContainer` with optional inline action button.
 *
 * @param {HTMLDivElement} toastContainer
 * @param {string} message
 * @param {'neutral' | 'success' | 'error'} [variant]
 * @param {{ actionLabel?: string, onAction?: () => void | Promise<unknown>, durationMs?: number }} [options]
 * @param {{ currentTimer: number | null }} [timerRef]
 * @returns {number}
 */
export function showToastBanner(toastContainer, message, variant = 'neutral', options = {}, timerRef) {
  if (timerRef && timerRef.currentTimer !== null) {
    window.clearTimeout(timerRef.currentTimer);
    timerRef.currentTimer = null;
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
      if (timerRef && timerRef.currentTimer !== null) {
        window.clearTimeout(timerRef.currentTimer);
        timerRef.currentTimer = null;
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

  return window.setTimeout(() => {
    if (timerRef) {
      timerRef.currentTimer = null;
    }
    if (toast.parentNode === toastContainer) {
      toast.remove();
    }
  }, durationMs);
}

/**
 * Refresh relative PR timestamps in-place without rebuilding the PR card DOM.
 *
 * @param {HTMLDivElement} prItemsContainer
 * @param {number} now
 * @returns {boolean} True if snoozed remaining badges are present and should be re-rendered.
 */
export function refreshRelativeTimestampsInDom(prItemsContainer, now) {
  const ageNodes = prItemsContainer.querySelectorAll('.pr-age');
  for (const node of ageNodes) {
    if (node instanceof HTMLElement && node.dataset.iso) {
      node.textContent = formatRelativeAge(node.dataset.iso, now);
    }
  }
  return prItemsContainer.querySelectorAll('.snooze-remaining-badge').length > 0;
}

/**
 * Toggle shortcuts cheat-sheet popover visibility and aria-expanded state.
 *
 * @param {HTMLElement} shortcutsPopover
 * @param {HTMLButtonElement} shortcutsToggleBtn
 * @param {boolean} [forceOpen]
 */
export function renderShortcutsPopoverState(shortcutsPopover, shortcutsToggleBtn, forceOpen) {
  const shouldOpen = typeof forceOpen === 'boolean'
    ? forceOpen
    : shortcutsPopover.classList.contains('hidden');
  shortcutsPopover.classList.toggle('hidden', !shouldOpen);
  shortcutsToggleBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

/**
 * Update loading spinner & refresh button disabled/spinning state.
 *
 * @param {HTMLDivElement} loadingIndicator
 * @param {HTMLButtonElement} manualRefreshBtn
 * @param {boolean} loading
 */
export function renderSyncLoadingState(loadingIndicator, manualRefreshBtn, loading) {
  loadingIndicator.classList.toggle('hidden', !loading);
  manualRefreshBtn.disabled = loading;
  manualRefreshBtn.classList.toggle('is-spinning', loading);
}

/**
 * @typedef {Object} HeaderFooterElements
 * @property {HTMLButtonElement} connectionStatusChip
 * @property {HTMLSpanElement} connectionStatusText
 * @property {HTMLDivElement} lastUpdatedText
 */

/**
 * @typedef {Object} BitbucketTabElements
 * @property {HTMLDivElement} extensionContainer
 * @property {HTMLElement} mainContent
 * @property {HTMLDivElement} triageControls
 * @property {readonly HTMLButtonElement[]} filterPillButtons
 * @property {HTMLSpanElement} countActionRequired
 * @property {HTMLSpanElement} countReviewing
 * @property {HTMLSpanElement} countAuthored
 * @property {HTMLSpanElement} countAll
 * @property {HTMLSpanElement} countSnoozed
 * @property {HTMLButtonElement} prSearchClearBtn
 * @property {HTMLButtonElement} groupByTicketBtn
 * @property {HTMLSpanElement} prCountTitle
 * @property {HTMLDivElement} errorAlert
 * @property {HTMLElement} errorTitle
 * @property {HTMLParagraphElement} errorMessage
 * @property {HTMLButtonElement} errorSetupBtn
 * @property {HTMLDivElement} rateLimitBanner
 * @property {HTMLDivElement} backoffBanner
 * @property {HTMLParagraphElement} backoffMessage
 * @property {HTMLDivElement} relatedScopeBanner
 * @property {HTMLSpanElement} relatedScopeText
 * @property {HTMLDivElement} prItemsContainer
 * @property {HTMLDivElement} emptyState
 * @property {HTMLHeadingElement} emptyStateTitle
 * @property {HTMLParagraphElement} emptyStateMessage
 * @property {HTMLButtonElement} emptyStateActionBtn
 * @property {HTMLDivElement} setupHint
 */

/**
 * @typedef {Object} BitbucketTabViewState
 * @property {boolean} isAuthenticated
 * @property {boolean} bitbucketAuthenticated
 * @property {boolean} githubAuthenticated
 * @property {boolean} isAuthError
 * @property {boolean} isGroupByTicketUpdating
 * @property {readonly EnrichedPullRequest[]} prList
 * @property {string | null} error
 * @property {boolean} rateLimitWarning
 * @property {number | null} backoffUntil
 * @property {Preferences} preferences
 * @property {SnoozedMap} snoozedMap
 * @property {PrFilter} activeFilter
 * @property {string} searchQuery
 * @property {string | null} activeRelatedTicketKey
 * @property {string | null} selectedPrKey
 * @property {Set<string>} collapsedGroups
 * @property {Set<string>} expandedStackGroups
 * @property {Map<string, number>} deckActiveSlideMap
 */

/**
 * @typedef {Object} JiraTabElements
 * @property {HTMLButtonElement} openJiraBtn
 * @property {HTMLDivElement} jiraSetupHint
 * @property {HTMLSpanElement} jiraTicketsCount
 * @property {HTMLDivElement} jiraTicketsContainer
 * @property {HTMLDivElement} jiraEmptyState
 * @property {HTMLHeadingElement} jiraEmptyTitle
 * @property {HTMLParagraphElement} jiraEmptyMessage
 * @property {HTMLButtonElement} jiraConnectBtn
 */

/**
 * @typedef {Object} JiraTabCallbacks
 * @property {(ticketKey: string) => void} onFilterPrsByTicket
 * @property {(rawUrl: string) => void | Promise<unknown>} onOpenUrl
 * @property {() => void} onOpenJiraUrlSettings
 */

/**
 * @typedef {Object} ConfluenceTabElements
 * @property {HTMLDivElement} confluenceConfiguredCard
 * @property {HTMLDivElement} confluencePlaceholderCard
 */

/**
 * Populate static setup metadata from `config.js` and `manifest.json`.
 *
 * @param {{
 *   appVersionEl: HTMLDivElement,
 *   createApiTokenLink: HTMLAnchorElement,
 *   requiredScopesList: HTMLUListElement,
 *   createGitHubTokenLink: HTMLAnchorElement,
 *   githubRequiredScopesList: HTMLUListElement
 * }} elements
 * @param {string} manifestVersion
 */
export function renderStaticMetadata(elements, manifestVersion) {
  elements.appVersionEl.textContent = `v${manifestVersion}`;

  const safeApiTokenDocs = sanitizeHttpsUrl(AUTH_SETUP_LINKS.atlassianApiTokens);
  if (safeApiTokenDocs) {
    elements.createApiTokenLink.href = safeApiTokenDocs;
  }

  const scopeNodes = AUTH_SETUP_LINKS.requiredScopes.map((scope) => {
    const li = document.createElement('li');
    li.textContent = scope;
    return li;
  });
  elements.requiredScopesList.replaceChildren(...scopeNodes);

  const safeGitHubTokenDocs = sanitizeHttpsUrl(AUTH_SETUP_LINKS.githubTokens);
  if (safeGitHubTokenDocs) {
    elements.createGitHubTokenLink.href = safeGitHubTokenDocs;
  }

  const githubScopeNodes = AUTH_SETUP_LINKS.githubRequiredScopes.map((scope) => {
    const li = document.createElement('li');
    li.textContent = scope;
    return li;
  });
  elements.githubRequiredScopesList.replaceChildren(...githubScopeNodes);
}

/**
 * Update header connection chip based on single/dual provider auth, error, and rate-limit state.
 *
 * @param {Pick<HeaderFooterElements, 'connectionStatusChip' | 'connectionStatusText'>} elements
 * @param {{
 *   bitbucketAuthenticated: boolean,
 *   bitbucketUser: CachedUser | null,
 *   bitbucketUsername: string,
 *   github: { isAuthenticated: boolean, apiBaseUrl: string, user: CachedUser | null } | undefined,
 *   syncedWorkspaces: readonly string[],
 *   workspaces: readonly WorkspaceSummary[],
 *   error: string | null,
 *   rateLimitWarning: boolean,
 *   backoffUntil: number | null,
 *   now?: number
 * }} viewState
 */
export function renderHeaderStatusChip(elements, viewState) {
  const descriptor = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: viewState.bitbucketAuthenticated,
    bitbucketUser: viewState.bitbucketUser,
    bitbucketUsername: viewState.bitbucketUsername,
    github: viewState.github,
    syncedWorkspaces: viewState.syncedWorkspaces,
    workspaces: viewState.workspaces,
    error: viewState.error,
    rateLimitWarning: viewState.rateLimitWarning,
    backoffUntil: viewState.backoffUntil,
    now: typeof viewState.now === 'number' ? viewState.now : Date.now()
  });

  elements.connectionStatusChip.className = `status-chip status-chip-${descriptor.variant}`;
  elements.connectionStatusText.textContent = descriptor.text;
  elements.connectionStatusChip.title = descriptor.title;
  elements.connectionStatusChip.setAttribute('aria-label', descriptor.ariaLabel);
}

/**
 * Render footer timestamp (`#last-updated-text`) cleanly with full-date tooltip.
 *
 * @param {HTMLDivElement} lastUpdatedText
 * @param {number | null} lastUpdated
 */
export function renderFooterTimestamp(lastUpdatedText, lastUpdated) {
  lastUpdatedText.textContent = formatFooterUpdated(lastUpdated);
  if (typeof lastUpdated === 'number' && Number.isFinite(lastUpdated) && lastUpdated > 0) {
    lastUpdatedText.title = `Last synced: ${new Date(lastUpdated).toLocaleString()}`;
  } else {
    lastUpdatedText.removeAttribute('title');
  }
}

/**
 * Render non-blocking error, rate-limit, and backoff banners above the PR list.
 *
 * @param {{
 *   errorAlert: HTMLDivElement,
 *   errorTitle: HTMLElement,
 *   errorMessage: HTMLParagraphElement,
 *   errorSetupBtn: HTMLButtonElement,
 *   rateLimitBanner: HTMLDivElement,
 *   backoffBanner: HTMLDivElement,
 *   backoffMessage: HTMLParagraphElement
 * }} elements
 * @param {{
 *   isAuthenticated: boolean,
 *   isAuthError: boolean,
 *   prCount: number,
 *   error: string | null,
 *   rateLimitWarning: boolean,
 *   backoffUntil: number | null
 * }} viewState
 * @param {number} now
 */
export function renderStatusBanners(elements, viewState, now) {
  if (viewState.error) {
    elements.errorTitle.textContent = viewState.prCount > 0
      ? 'Sync Issue (showing cached PRs)'
      : 'Sync Issue';
    elements.errorMessage.textContent = viewState.error;
    elements.errorSetupBtn.textContent = viewState.isAuthError ? 'Update Token' : 'Preferences';
    elements.errorAlert.classList.remove('hidden');
  } else {
    elements.errorAlert.classList.add('hidden');
  }

  elements.rateLimitBanner.classList.toggle('hidden', !viewState.rateLimitWarning);

  const backoffUntil = viewState.backoffUntil;
  if (viewState.isAuthenticated && typeof backoffUntil === 'number' && backoffUntil > now) {
    const remainingSec = Math.max(1, Math.ceil((backoffUntil - now) / 1000));
    const etaLabel = remainingSec >= 60
      ? `${Math.ceil(remainingSec / 60)}m`
      : `${remainingSec}s`;
    elements.backoffMessage.textContent = `Auto-polling paused for ~${etaLabel}. You can still click Refresh anytime.`;
    elements.backoffBanner.classList.remove('hidden');
  } else {
    elements.backoffBanner.classList.add('hidden');
  }
}

/**
 * Sync the `#group-by-ticket-btn` visual toggle state from `preferences.groupByTicket`.
 *
 * @param {HTMLButtonElement} groupByTicketBtn
 * @param {boolean} enabled
 * @param {boolean} isUpdating
 */
export function renderGroupByTicketToggle(groupByTicketBtn, enabled, isUpdating) {
  groupByTicketBtn.classList.toggle('active', enabled);
  groupByTicketBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  groupByTicketBtn.disabled = isUpdating;
}

/**
 * Render the PR list tab: filter pills, counts, search, By Ticket toggle, Related scope banner,
 * Flat or Ticket-Deck grouped PR cards, or empty/onboarding state.
 *
 * @param {BitbucketTabElements} elements
 * @param {BitbucketTabViewState} viewState
 * @param {PrCardCallbacks} callbacks
 * @returns {{
 *   visiblePrs: EnrichedPullRequest[],
 *   navigablePrs: EnrichedPullRequest[],
 *   selectedPrKey: string | null,
 *   activeRelatedTicketKey: string | null
 * }}
 */
export function renderBitbucketTab(elements, viewState, callbacks) {
  const {
    extensionContainer,
    mainContent,
    triageControls,
    filterPillButtons,
    countActionRequired,
    countReviewing,
    countAuthored,
    countAll,
    countSnoozed,
    prSearchClearBtn,
    groupByTicketBtn,
    prCountTitle,
    errorAlert,
    errorTitle,
    errorMessage,
    errorSetupBtn,
    rateLimitBanner,
    backoffBanner,
    backoffMessage,
    relatedScopeBanner,
    relatedScopeText,
    prItemsContainer,
    emptyState,
    emptyStateTitle,
    emptyStateMessage,
    emptyStateActionBtn,
    setupHint
  } = elements;

  const prevScrollTop = mainContent.scrollTop;
  const now = Date.now();
  extensionContainer.classList.toggle('compact-mode', Boolean(viewState.preferences.compactMode));

  if (!viewState.isAuthenticated) {
    relatedScopeBanner.classList.add('hidden');
    triageControls.classList.add('hidden');
    prItemsContainer.replaceChildren();
    emptyState.classList.add('hidden');
    setupHint.classList.remove('hidden');
    rateLimitBanner.classList.add('hidden');
    backoffBanner.classList.add('hidden');
    if (viewState.error) {
      errorTitle.textContent = 'Connection Required';
      errorMessage.textContent = viewState.error;
      errorSetupBtn.textContent = 'Update Token';
      errorAlert.classList.remove('hidden');
    } else {
      errorAlert.classList.add('hidden');
    }
    return {
      visiblePrs: [],
      navigablePrs: [],
      selectedPrKey: null,
      activeRelatedTicketKey: null
    };
  }

  setupHint.classList.add('hidden');
  triageControls.classList.remove('hidden');
  renderStatusBanners(
    {
      errorAlert,
      errorTitle,
      errorMessage,
      errorSetupBtn,
      rateLimitBanner,
      backoffBanner,
      backoffMessage
    },
    {
      isAuthenticated: viewState.isAuthenticated,
      isAuthError: viewState.isAuthError,
      prCount: viewState.prList.length,
      error: viewState.error,
      rateLimitWarning: viewState.rateLimitWarning,
      backoffUntil: viewState.backoffUntil
    },
    now
  );
  renderGroupByTicketToggle(
    groupByTicketBtn,
    Boolean(viewState.preferences.groupByTicket),
    viewState.isGroupByTicketUpdating
  );

  const prs = viewState.prList;
  const snoozedMap = viewState.snoozedMap;
  const counts = computeCounts(prs, snoozedMap, now);
  const showProviderBadge = (viewState.bitbucketAuthenticated && viewState.githubAuthenticated) ||
    prs.some((pr) => pr.provider === 'github');

  countActionRequired.textContent = String(counts.actionRequired);
  countReviewing.textContent = String(counts.reviewing);
  countAuthored.textContent = String(counts.authored);
  countAll.textContent = String(counts.all);
  countSnoozed.textContent = String(counts.snoozed);

  for (const pill of filterPillButtons) {
    const pillFilter = pill.dataset.filter;
    const isSelected = pillFilter === viewState.activeFilter;
    pill.classList.toggle('active', isSelected);
    pill.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    pill.tabIndex = isSelected ? 0 : -1;
  }

  prSearchClearBtn.classList.toggle('hidden', viewState.searchQuery.trim().length === 0);

  /** @type {EnrichedPullRequest[]} */
  let visiblePrs;
  if (viewState.activeRelatedTicketKey) {
    visiblePrs = filterPrsByRelatedTicket(prs, viewState.activeRelatedTicketKey);
    relatedScopeText.textContent = `Related PRs for ${viewState.activeRelatedTicketKey} (${visiblePrs.length})`;
    relatedScopeBanner.classList.remove('hidden');
  } else {
    relatedScopeBanner.classList.add('hidden');
    visiblePrs = filterAndSortPrs(prs, {
      filter: viewState.activeFilter,
      query: viewState.searchQuery,
      snoozedMap,
      now
    });
  }

  prCountTitle.textContent = `${visiblePrs.length} PR${visiblePrs.length === 1 ? '' : 's'}`;

  if (visiblePrs.length === 0) {
    prItemsContainer.replaceChildren();
    emptyState.classList.remove('hidden');

    if (viewState.activeRelatedTicketKey) {
      emptyStateTitle.textContent = 'No related PRs open';
      emptyStateMessage.textContent = `No open pull requests reference ${viewState.activeRelatedTicketKey}.`;
      emptyStateActionBtn.textContent = 'Show All PRs';
      emptyStateActionBtn.dataset.emptyAction = 'clear_related';
      emptyStateActionBtn.classList.remove('hidden');
      return {
        visiblePrs,
        navigablePrs: [],
        selectedPrKey: null,
        activeRelatedTicketKey: viewState.activeRelatedTicketKey
      };
    }

    const trimmedQuery = viewState.searchQuery.trim();
    if (trimmedQuery) {
      const crossHint = getCrossFilterEmptyHint({
        activeFilter: viewState.activeFilter,
        searchQuery: trimmedQuery,
        allPrs: prs,
        snoozedMap,
        now
      });

      if (crossHint) {
        emptyStateTitle.textContent = 'No matches in this filter';
        emptyStateMessage.textContent = crossHint.label;
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
    } else if (viewState.activeFilter === 'action_required' && counts.all > 0) {
      emptyStateTitle.textContent = 'Nothing needs your action!';
      emptyStateMessage.textContent = `You have ${counts.all} open pull request${counts.all === 1 ? '' : 's'} waiting on others.`;
      emptyStateActionBtn.textContent = 'View All PRs';
      emptyStateActionBtn.dataset.emptyAction = 'view_all';
      emptyStateActionBtn.classList.remove('hidden');
    } else if (viewState.activeFilter === 'snoozed') {
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
    return {
      visiblePrs,
      navigablePrs: [],
      selectedPrKey: null,
      activeRelatedTicketKey: viewState.activeRelatedTicketKey
    };
  }

  emptyState.classList.add('hidden');
  let nextSelectedPrKey = viewState.selectedPrKey;
  if (nextSelectedPrKey && !visiblePrs.some((pr) => pr.key === nextSelectedPrKey)) {
    nextSelectedPrKey = null;
  }

  const fragment = document.createDocumentFragment();
  const shouldGroup = Boolean(viewState.preferences.groupByTicket) && !viewState.activeRelatedTicketKey;
  /** @type {EnrichedPullRequest[]} */
  let navigablePrs;

  if (shouldGroup) {
    const groups = groupPrsByTicket(visiblePrs, snoozedMap, now);
    /** @type {EnrichedPullRequest[]} */
    const nextNavigable = [];
    for (const group of groups) {
      const rendered = buildTicketGroupElement(
        group,
        snoozedMap,
        now,
        {
          showProviderBadge,
          selectedPrKey: nextSelectedPrKey,
          activeFilter: viewState.activeFilter,
          collapsedGroups: viewState.collapsedGroups,
          expandedStackGroups: viewState.expandedStackGroups,
          deckActiveSlideMap: viewState.deckActiveSlideMap
        },
        callbacks
      );
      fragment.appendChild(rendered.element);
      nextNavigable.push(...rendered.orderedPrs);
    }
    navigablePrs = nextNavigable;
  } else {
    const relatedMap = buildRelatedPrMap(prs);
    navigablePrs = visiblePrs;
    for (const pr of visiblePrs) {
      const card = buildPrCardElement(
        pr,
        Boolean(nextSelectedPrKey && pr.key === nextSelectedPrKey),
        isPrSnoozed(pr, snoozedMap, now),
        now,
        {
          showProviderBadge,
          relatedSummary: relatedMap[pr.key] ?? null,
          activeRelatedTicketKey: viewState.activeRelatedTicketKey,
          activeFilter: viewState.activeFilter,
          snoozedMap
        },
        callbacks
      );
      fragment.appendChild(card);
    }
  }

  prItemsContainer.replaceChildren(fragment);

  if (prevScrollTop > 0) {
    mainContent.scrollTop = Math.min(prevScrollTop, Math.max(0, mainContent.scrollHeight - mainContent.clientHeight));
  }

  return {
    visiblePrs,
    navigablePrs,
    selectedPrKey: nextSelectedPrKey,
    activeRelatedTicketKey: viewState.activeRelatedTicketKey
  };
}

/**
 * Render the Jira tab with snooze-aware active tickets, Filter PRs drill-down, and adaptive Jira CTA.
 *
 * @param {JiraTabElements} elements
 * @param {{
 *   isAuthenticated: boolean,
 *   preferences: Preferences,
 *   prList: readonly EnrichedPullRequest[],
 *   snoozedMap: SnoozedMap,
 *   now?: number
 * }} viewState
 * @param {JiraTabCallbacks} callbacks
 */
export function renderJiraTab(elements, viewState, callbacks) {
  const {
    openJiraBtn,
    jiraSetupHint,
    jiraTicketsCount,
    jiraTicketsContainer,
    jiraEmptyState,
    jiraEmptyTitle,
    jiraEmptyMessage,
    jiraConnectBtn
  } = elements;

  const effectiveJiraUrl = getEffectiveJiraBaseUrl(viewState.preferences);
  const hasJiraUrl = Boolean(effectiveJiraUrl);
  const hasOverrideUrl = Boolean(sanitizeHttpsUrl(viewState.preferences.jiraBaseUrlOverride));

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

  if (!viewState.isAuthenticated) {
    jiraTicketsCount.textContent = 'Not connected';
    jiraTicketsContainer.replaceChildren();
    jiraEmptyTitle.textContent = 'Connect an account first';
    jiraEmptyMessage.textContent = 'Connect Bitbucket or GitHub in Settings to surface Jira keys referenced in your open pull requests.';
    jiraConnectBtn.classList.remove('hidden');
    jiraEmptyState.classList.remove('hidden');
    return;
  }

  jiraConnectBtn.classList.add('hidden');
  const now = typeof viewState.now === 'number' ? viewState.now : Date.now();
  const tickets = collectActiveJiraTickets(viewState.prList, viewState.snoozedMap, now);
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
    filterBtn.title = `Filter PRs matching ${ticket.key}`;
    filterBtn.setAttribute('aria-label', `Filter pull requests for ${ticket.key}`);
    filterBtn.addEventListener('click', () => {
      callbacks.onFilterPrsByTicket(ticket.key);
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
        void callbacks.onOpenUrl(safeTicketUrl);
      });
      actionsEl.appendChild(openBtn);
    } else {
      const setUrlBtn = document.createElement('button');
      setUrlBtn.type = 'button';
      setUrlBtn.className = 'btn btn-ghost btn-sm';
      setUrlBtn.textContent = 'Set URL';
      setUrlBtn.addEventListener('click', () => {
        callbacks.onOpenJiraUrlSettings();
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
 *
 * @param {ConfluenceTabElements} elements
 */
export function renderConfluenceTab(elements) {
  const safeConfluenceUrl = sanitizeHttpsUrl(CENTRAL_URLS.CONFLUENCE_URL);
  elements.confluenceConfiguredCard.classList.toggle('hidden', !safeConfluenceUrl);
  elements.confluencePlaceholderCard.classList.toggle('hidden', Boolean(safeConfluenceUrl));
}

/**
 * Populate `+ Add Product` form inputs from stored feedback.
 *
 * @param {HTMLFormElement} addProductForm
 * @param {HTMLTextAreaElement} customProductFeedbackInput
 * @param {ProductFeedbackState} productFeedback
 */
export function renderAddProductForm(addProductForm, customProductFeedbackInput, productFeedback) {
  const selectedSet = new Set(productFeedback.requestedProducts);
  const checkboxes = addProductForm.querySelectorAll('input[name="products"]');
  for (const el of checkboxes) {
    if (el instanceof HTMLInputElement) {
      el.checked = selectedSet.has(el.value);
    }
  }
  customProductFeedbackInput.value = productFeedback.productFeedback || '';
}
