import {
  DECISION_MODELS,
  getEffectiveGitHubApiBaseUrl,
  sanitizeDecisionEndpointUrl,
  sanitizeHttpsUrl
} from '../config.js';
import { normalizeAuthType } from '../storage.js';

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
 * Resolve Settings -> Account & Setup DOM elements.
 *
 * @returns {AccountSectionElements}
 */
export function resolveAccountSectionElements() {
  return {
    accountSummaryCard: getEl('account-summary-card', HTMLDivElement),
    accountAvatar: getEl('account-avatar', HTMLDivElement),
    accountDisplayName: getEl('account-display-name', HTMLDivElement),
    accountUsername: getEl('account-username', HTMLDivElement),
    accountAuthType: getEl('account-auth-type', HTMLSpanElement),
    accountWorkspaceCount: getEl('account-workspace-count', HTMLSpanElement),
    signOutConfirm: getEl('sign-out-confirm', HTMLDivElement),
    credentialsForm: getEl('credentials-form', HTMLFormElement),
    authTypeSelect: getEl('auth-type', HTMLSelectElement),
    usernameGroup: getEl('username-group', HTMLDivElement),
    bitbucketUsernameInput: getEl('bitbucket-username', HTMLInputElement),
    tokenLabel: getEl('token-label', HTMLLabelElement),
    bitbucketTokenInput: getEl('bitbucket-token', HTMLInputElement),
    toggleTokenVisibilityBtn: getEl('toggle-token-visibility', HTMLButtonElement),
    tokenHelpText: getEl('token-help', HTMLParagraphElement),
    authStatusBanner: getEl('auth-status-banner', HTMLDivElement),
    githubSummaryCard: getEl('github-summary-card', HTMLDivElement),
    githubAvatar: getEl('github-avatar', HTMLDivElement),
    githubDisplayName: getEl('github-display-name', HTMLDivElement),
    githubUsername: getEl('github-username', HTMLDivElement),
    githubApiUrlDisplay: getEl('github-api-url-display', HTMLSpanElement),
    githubSignOutConfirm: getEl('github-sign-out-confirm', HTMLDivElement),
    githubCredentialsForm: getEl('github-credentials-form', HTMLFormElement),
    githubTokenInput: getEl('github-token', HTMLInputElement),
    toggleGitHubTokenVisibilityBtn: getEl('toggle-github-token-visibility', HTMLButtonElement),
    githubApiUrlInput: getEl('github-api-url', HTMLInputElement),
    githubAuthStatusBanner: getEl('github-auth-status-banner', HTMLDivElement),
    decisionSummaryCard: getEl('decision-summary-card', HTMLDivElement),
    decisionProviderLabel: getEl('decision-provider-label', HTMLDivElement),
    decisionModelDisplay: getEl('decision-model-display', HTMLDivElement),
    decisionEndpointDisplay: getEl('decision-endpoint-display', HTMLSpanElement),
    decisionSignOutConfirmRow: getEl('decision-signout-confirm-row', HTMLDivElement),
    decisionConfigForm: getEl('decision-config-form', HTMLFormElement),
    decisionProviderSelect: getEl('decision-provider-select', HTMLSelectElement),
    decisionFieldsGroup: getEl('decision-fields-group', HTMLDivElement),
    decisionBaseUrlInput: getEl('decision-base-url-input', HTMLInputElement),
    decisionBaseUrlHelp: getEl('decision-base-url-help', HTMLParagraphElement),
    decisionModelInput: getEl('decision-model-input', HTMLInputElement),
    decisionApiKeyInput: getEl('decision-api-key-input', HTMLInputElement),
    decisionToggleKeyBtn: getEl('decision-toggle-key-btn', HTMLButtonElement),
    decisionApiKeyHelp: getEl('decision-api-key-help', HTMLParagraphElement),
    decisionStatusBanner: getEl('decision-status-banner', HTMLDivElement)
  };
}

/**
 * Resolve Settings -> Preferences DOM elements.
 *
 * @returns {PreferencesFormElements}
 */
export function resolvePreferencesFormElements() {
  return {
    prefPollInterval: getEl('pref-poll-interval', HTMLSelectElement),
    prefBadgeMode: getEl('pref-badge-mode', HTMLSelectElement),
    prefStaleHours: getEl('pref-stale-hours', HTMLSelectElement),
    prefDefaultFilter: getEl('pref-default-filter', HTMLSelectElement),
    prefNotifications: getEl('pref-notifications', HTMLInputElement),
    prefCompactMode: getEl('pref-compact-mode', HTMLInputElement),
    prefWorkspacesFilter: getEl('pref-workspaces-filter', HTMLInputElement),
    availableWorkspacesHint: getEl('available-workspaces-hint', HTMLParagraphElement),
    prefReposFilter: getEl('pref-repos-filter', HTMLInputElement),
    prefJiraUrl: getEl('pref-jira-url', HTMLInputElement),
    prefsStatusBanner: getEl('prefs-status-banner', HTMLDivElement)
  };
}

/**
 * Resolve Settings drawer control buttons and panel elements.
 *
 * @returns {{
 *   settingsPanel: HTMLElement,
 *   closeSettingsBtn: HTMLButtonElement,
 *   settingsAccountTab: HTMLButtonElement,
 *   settingsPreferencesTab: HTMLButtonElement,
 *   settingsAccountPanel: HTMLDivElement,
 *   settingsPreferencesPanel: HTMLDivElement,
 *   replaceTokenBtn: HTMLButtonElement,
 *   signOutBtn: HTMLButtonElement,
 *   confirmSignOutBtn: HTMLButtonElement,
 *   cancelSignOutBtn: HTMLButtonElement,
 *   createApiTokenLink: HTMLAnchorElement,
 *   requiredScopesList: HTMLUListElement,
 *   testConnectionBtn: HTMLButtonElement,
 *   saveSettingsBtn: HTMLButtonElement,
 *   cancelSettingsBtn: HTMLButtonElement,
 *   githubReplaceTokenBtn: HTMLButtonElement,
 *   githubSignOutBtn: HTMLButtonElement,
 *   githubConfirmSignOutBtn: HTMLButtonElement,
 *   githubCancelSignOutBtn: HTMLButtonElement,
 *   createGitHubTokenLink: HTMLAnchorElement,
 *   githubRequiredScopesList: HTMLUListElement,
 *   testGitHubConnectionBtn: HTMLButtonElement,
 *   saveGitHubSettingsBtn: HTMLButtonElement,
 *   cancelGitHubSettingsBtn: HTMLButtonElement,
 *   decisionReplaceBtn: HTMLButtonElement,
 *   decisionSignOutBtn: HTMLButtonElement,
 *   decisionConfirmSignOutBtn: HTMLButtonElement,
 *   decisionCancelSignOutBtn: HTMLButtonElement,
 *   decisionTestBtn: HTMLButtonElement,
 *   decisionSaveBtn: HTMLButtonElement,
 *   decisionCancelBtn: HTMLButtonElement,
 *   preferencesForm: HTMLFormElement,
 *   savePreferencesBtn: HTMLButtonElement,
 *   cancelPreferencesBtn: HTMLButtonElement
 * }}
 */
export function resolveSettingsDrawerControls() {
  return {
    settingsPanel: getEl('settings-panel', HTMLElement),
    closeSettingsBtn: getEl('close-settings-btn', HTMLButtonElement),
    settingsAccountTab: getEl('settings-account-tab', HTMLButtonElement),
    settingsPreferencesTab: getEl('settings-preferences-tab', HTMLButtonElement),
    settingsAccountPanel: getEl('settings-account-panel', HTMLDivElement),
    settingsPreferencesPanel: getEl('settings-preferences-panel', HTMLDivElement),
    replaceTokenBtn: getEl('replace-token-btn', HTMLButtonElement),
    signOutBtn: getEl('sign-out-btn', HTMLButtonElement),
    confirmSignOutBtn: getEl('confirm-sign-out-btn', HTMLButtonElement),
    cancelSignOutBtn: getEl('cancel-sign-out-btn', HTMLButtonElement),
    createApiTokenLink: getEl('create-api-token-link', HTMLAnchorElement),
    requiredScopesList: getEl('required-scopes-list', HTMLUListElement),
    testConnectionBtn: getEl('test-connection-btn', HTMLButtonElement),
    saveSettingsBtn: getEl('save-settings-btn', HTMLButtonElement),
    cancelSettingsBtn: getEl('cancel-settings-btn', HTMLButtonElement),
    githubReplaceTokenBtn: getEl('github-replace-token-btn', HTMLButtonElement),
    githubSignOutBtn: getEl('github-sign-out-btn', HTMLButtonElement),
    githubConfirmSignOutBtn: getEl('github-confirm-sign-out-btn', HTMLButtonElement),
    githubCancelSignOutBtn: getEl('github-cancel-sign-out-btn', HTMLButtonElement),
    createGitHubTokenLink: getEl('create-github-token-link', HTMLAnchorElement),
    githubRequiredScopesList: getEl('github-required-scopes-list', HTMLUListElement),
    testGitHubConnectionBtn: getEl('test-github-connection-btn', HTMLButtonElement),
    saveGitHubSettingsBtn: getEl('save-github-settings-btn', HTMLButtonElement),
    cancelGitHubSettingsBtn: getEl('cancel-github-settings-btn', HTMLButtonElement),
    decisionReplaceBtn: getEl('decision-replace-btn', HTMLButtonElement),
    decisionSignOutBtn: getEl('decision-signout-btn', HTMLButtonElement),
    decisionConfirmSignOutBtn: getEl('decision-confirm-signout-btn', HTMLButtonElement),
    decisionCancelSignOutBtn: getEl('decision-cancel-signout-btn', HTMLButtonElement),
    decisionTestBtn: getEl('decision-test-btn', HTMLButtonElement),
    decisionSaveBtn: getEl('decision-save-btn', HTMLButtonElement),
    decisionCancelBtn: getEl('decision-cancel-btn', HTMLButtonElement),
    preferencesForm: getEl('preferences-form', HTMLFormElement),
    savePreferencesBtn: getEl('save-preferences-btn', HTMLButtonElement),
    cancelPreferencesBtn: getEl('cancel-preferences-btn', HTMLButtonElement)
  };
}

/** @typedef {import('../config.js').Preferences} Preferences */
/** @typedef {import('../storage.js').AuthType} AuthType */
/** @typedef {import('../storage.js').CachedUser} CachedUser */
/** @typedef {import('../storage.js').DecisionProvider} DecisionProvider */
/** @typedef {import('../storage.js').WorkspaceSummary} WorkspaceSummary */

/**
 * @typedef {Object} DecisionBootstrapState
 * @property {DecisionProvider} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {boolean} isConfigured
 */

/**
 * @typedef {Object} AccountSectionElements
 * @property {HTMLDivElement} accountSummaryCard
 * @property {HTMLDivElement} accountAvatar
 * @property {HTMLDivElement} accountDisplayName
 * @property {HTMLDivElement} accountUsername
 * @property {HTMLSpanElement} accountAuthType
 * @property {HTMLSpanElement} accountWorkspaceCount
 * @property {HTMLDivElement} signOutConfirm
 * @property {HTMLFormElement} credentialsForm
 * @property {HTMLSelectElement} authTypeSelect
 * @property {HTMLDivElement} usernameGroup
 * @property {HTMLInputElement} bitbucketUsernameInput
 * @property {HTMLLabelElement} tokenLabel
 * @property {HTMLInputElement} bitbucketTokenInput
 * @property {HTMLButtonElement} toggleTokenVisibilityBtn
 * @property {HTMLParagraphElement} tokenHelpText
 * @property {HTMLDivElement} authStatusBanner
 * @property {HTMLDivElement} githubSummaryCard
 * @property {HTMLDivElement} githubAvatar
 * @property {HTMLDivElement} githubDisplayName
 * @property {HTMLDivElement} githubUsername
 * @property {HTMLSpanElement} githubApiUrlDisplay
 * @property {HTMLDivElement} githubSignOutConfirm
 * @property {HTMLFormElement} githubCredentialsForm
 * @property {HTMLInputElement} githubTokenInput
 * @property {HTMLButtonElement} toggleGitHubTokenVisibilityBtn
 * @property {HTMLInputElement} githubApiUrlInput
 * @property {HTMLDivElement} githubAuthStatusBanner
 * @property {HTMLDivElement} decisionSummaryCard
 * @property {HTMLDivElement} decisionProviderLabel
 * @property {HTMLDivElement} decisionModelDisplay
 * @property {HTMLSpanElement} decisionEndpointDisplay
 * @property {HTMLDivElement} decisionSignOutConfirmRow
 * @property {HTMLFormElement} decisionConfigForm
 * @property {HTMLSelectElement} decisionProviderSelect
 * @property {HTMLDivElement} decisionFieldsGroup
 * @property {HTMLInputElement} decisionBaseUrlInput
 * @property {HTMLParagraphElement} decisionBaseUrlHelp
 * @property {HTMLInputElement} decisionModelInput
 * @property {HTMLInputElement} decisionApiKeyInput
 * @property {HTMLButtonElement} decisionToggleKeyBtn
 * @property {HTMLParagraphElement} decisionApiKeyHelp
 * @property {HTMLDivElement} decisionStatusBanner
 */

/**
 * @typedef {Object} AccountSectionViewState
 * @property {boolean} bitbucketAuthenticated
 * @property {boolean} isReplacingToken
 * @property {AuthType} authType
 * @property {string} username
 * @property {CachedUser | null} user
 * @property {readonly WorkspaceSummary[]} workspaces
 * @property {readonly string[]} syncedWorkspaces
 * @property {boolean} githubAuthenticated
 * @property {boolean} isReplacingGitHubToken
 * @property {string} githubApiBaseUrl
 * @property {CachedUser | null} githubUser
 * @property {DecisionBootstrapState} [decision]
 * @property {boolean} [isConfiguringDecision]
 */

/**
 * @typedef {Object} PreferencesFormElements
 * @property {HTMLSelectElement} prefPollInterval
 * @property {HTMLSelectElement} prefBadgeMode
 * @property {HTMLSelectElement} prefStaleHours
 * @property {HTMLSelectElement} prefDefaultFilter
 * @property {HTMLInputElement} prefNotifications
 * @property {HTMLInputElement} prefCompactMode
 * @property {HTMLInputElement} prefWorkspacesFilter
 * @property {HTMLParagraphElement} availableWorkspacesHint
 * @property {HTMLInputElement} prefReposFilter
 * @property {HTMLInputElement} prefJiraUrl
 * @property {HTMLDivElement} prefsStatusBanner
 */

/**
 * Extract 1-2 uppercase avatar initials from a display name or username.
 *
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
export function getInitials(name, fallback = 'BB') {
  const cleaned = name.trim();
  if (!cleaned) {
    return fallback;
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Show an inline status banner inside Settings forms.
 *
 * @param {HTMLDivElement} bannerEl
 * @param {string} message
 * @param {'info' | 'success' | 'error' | 'warning'} variant
 */
export function showInlineBanner(bannerEl, message, variant) {
  bannerEl.className = `inline-banner ${variant}`;
  bannerEl.textContent = message;
  bannerEl.classList.remove('hidden');
}

/**
 * Hide and clear an inline status banner.
 *
 * @param {HTMLDivElement} bannerEl
 */
export function hideInlineBanner(bannerEl) {
  bannerEl.textContent = '';
  bannerEl.className = 'inline-banner hidden';
}

/**
 * Toggle between Settings drawer sub-tabs (`account` and `preferences`).
 *
 * @param {{
 *   settingsAccountTab: HTMLButtonElement,
 *   settingsPreferencesTab: HTMLButtonElement,
 *   settingsAccountPanel: HTMLDivElement,
 *   settingsPreferencesPanel: HTMLDivElement
 * }} elements
 * @param {'account' | 'preferences'} subtab
 */
export function renderSettingsSubtab(elements, subtab) {
  const isAccount = subtab === 'account';

  elements.settingsAccountTab.classList.toggle('active', isAccount);
  elements.settingsAccountTab.setAttribute('aria-selected', isAccount ? 'true' : 'false');
  elements.settingsAccountTab.tabIndex = isAccount ? 0 : -1;

  elements.settingsPreferencesTab.classList.toggle('active', !isAccount);
  elements.settingsPreferencesTab.setAttribute('aria-selected', !isAccount ? 'true' : 'false');
  elements.settingsPreferencesTab.tabIndex = !isAccount ? 0 : -1;

  elements.settingsAccountPanel.classList.toggle('hidden', !isAccount);
  elements.settingsPreferencesPanel.classList.toggle('hidden', isAccount);
}

/**
 * Update Bitbucket authentication form fields based on selected auth type (`api_token` vs `bearer`).
 *
 * @param {{
 *   authTypeSelect: HTMLSelectElement,
 *   usernameGroup: HTMLDivElement,
 *   tokenLabel: HTMLLabelElement,
 *   bitbucketTokenInput: HTMLInputElement,
 *   tokenHelpText: HTMLParagraphElement
 * }} elements
 */
export function syncAuthMethodFields(elements) {
  const {
    authTypeSelect,
    usernameGroup,
    tokenLabel,
    bitbucketTokenInput,
    tokenHelpText
  } = elements;
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
 * Format human-readable provider label for System One AI Triage.
 *
 * @param {DecisionProvider | string} provider
 * @returns {string}
 */
export function getDecisionProviderLabel(provider) {
  if (provider === 'gemini') {
    return 'Gemini Decision 1';
  }
  if (provider === 'jev') {
    return 'Jev / Clef Flash';
  }
  return 'Disabled';
}

/**
 * Extract displayable `host[:port]` from an endpoint URL for the connected summary card.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function formatEndpointHost(rawUrl) {
  const safe = sanitizeDecisionEndpointUrl(rawUrl);
  if (!safe) {
    return 'Endpoint configured';
  }
  try {
    return new URL(safe).host;
  } catch {
    return safe;
  }
}

/**
 * Synchronize System One Decision Model form placeholders, defaults, and hints
 * when switching between `off`, `jev`, and `gemini`.
 *
 * @param {{
 *   decisionProviderSelect: HTMLSelectElement,
 *   decisionFieldsGroup: HTMLDivElement,
 *   decisionBaseUrlInput: HTMLInputElement,
 *   decisionBaseUrlHelp: HTMLParagraphElement,
 *   decisionModelInput: HTMLInputElement,
 *   decisionApiKeyInput: HTMLInputElement,
 *   decisionApiKeyHelp: HTMLParagraphElement,
 *   decisionTestBtn?: HTMLButtonElement
 * }} elements
 * @param {{ applyProviderDefaults?: boolean }} [options]
 */
export function syncDecisionProviderFields(elements, options = {}) {
  const applyProviderDefaults = Boolean(options.applyProviderDefaults);
  const selected = elements.decisionProviderSelect.value;

  if (selected === 'off') {
    elements.decisionFieldsGroup.classList.add('hidden');
    if (elements.decisionTestBtn) {
      elements.decisionTestBtn.disabled = true;
    }
    return;
  }

  elements.decisionFieldsGroup.classList.remove('hidden');
  if (elements.decisionTestBtn) {
    elements.decisionTestBtn.disabled = false;
  }

  if (selected === 'gemini') {
    elements.decisionBaseUrlInput.placeholder = DECISION_MODELS.GEMINI_DECISIONS_URL;
    elements.decisionBaseUrlHelp.textContent = 'Default Google Gemini Decisions API endpoint (https:// required).';
    elements.decisionModelInput.placeholder = DECISION_MODELS.GEMINI_DEFAULT_MODEL;
    elements.decisionApiKeyInput.placeholder = 'AIza... (required for Gemini)';
    elements.decisionApiKeyHelp.textContent = 'Required for Gemini Decision 1. Sent via x-goog-api-key header and never re-displayed.';
    if (applyProviderDefaults) {
      elements.decisionBaseUrlInput.value = DECISION_MODELS.GEMINI_DECISIONS_URL;
      elements.decisionModelInput.value = DECISION_MODELS.GEMINI_DEFAULT_MODEL;
    }
  } else {
    elements.decisionBaseUrlInput.placeholder = 'https://clef.internal.example.com';
    elements.decisionBaseUrlHelp.textContent = 'HTTPS or internal LAN/localhost URL (/v1/systemone appended if omitted).';
    elements.decisionModelInput.placeholder = DECISION_MODELS.JEV_DEFAULT_MODEL;
    elements.decisionApiKeyInput.placeholder = 'Optional for internal GPU; paste Bearer token if required';
    elements.decisionApiKeyHelp.textContent = 'Optional for keyless internal Clef Flash GPU servers; stored locally and never re-displayed.';
    if (applyProviderDefaults) {
      elements.decisionBaseUrlInput.value = DECISION_MODELS.JEV_API_BASE_URL;
      elements.decisionModelInput.value = DECISION_MODELS.JEV_DEFAULT_MODEL;
    }
  }
}

/**
 * Populate Settings -> Account & Setup UI (Bitbucket Cloud + GitHub + System One AI Triage)
 * without ever injecting stored token or API key plaintext.
 *
 * @param {AccountSectionElements} elements
 * @param {AccountSectionViewState} viewState
 * @param {{ decisionTestBtn?: HTMLButtonElement }} [controls]
 */
export function renderAccountSection(elements, viewState, controls = {}) {
  const {
    accountSummaryCard,
    accountAvatar,
    accountDisplayName,
    accountUsername,
    accountAuthType,
    accountWorkspaceCount,
    signOutConfirm,
    credentialsForm,
    authTypeSelect,
    usernameGroup,
    bitbucketUsernameInput,
    tokenLabel,
    bitbucketTokenInput,
    toggleTokenVisibilityBtn,
    tokenHelpText,
    authStatusBanner,
    githubSummaryCard,
    githubAvatar,
    githubDisplayName,
    githubUsername,
    githubApiUrlDisplay,
    githubSignOutConfirm,
    githubCredentialsForm,
    githubTokenInput,
    toggleGitHubTokenVisibilityBtn,
    githubApiUrlInput,
    githubAuthStatusBanner,
    decisionSummaryCard,
    decisionProviderLabel,
    decisionModelDisplay,
    decisionEndpointDisplay,
    decisionSignOutConfirmRow,
    decisionConfigForm,
    decisionProviderSelect,
    decisionFieldsGroup,
    decisionBaseUrlInput,
    decisionBaseUrlHelp,
    decisionModelInput,
    decisionApiKeyInput,
    decisionToggleKeyBtn,
    decisionApiKeyHelp,
    decisionStatusBanner
  } = elements;

  const showBbSummary = viewState.bitbucketAuthenticated && !viewState.isReplacingToken;
  accountSummaryCard.classList.toggle('hidden', !showBbSummary);
  credentialsForm.classList.toggle('hidden', showBbSummary);
  signOutConfirm.classList.add('hidden');

  if (showBbSummary) {
    const displayName = viewState.user?.displayName || viewState.username || 'Bitbucket User';
    const secondaryIdentity = viewState.username || (viewState.user?.username ? `@${viewState.user.username}` : 'Authenticated');
    const wsCount = viewState.workspaces.length || viewState.syncedWorkspaces.length;

    accountAvatar.textContent = getInitials(displayName, 'BB');
    accountDisplayName.textContent = displayName;
    accountUsername.textContent = secondaryIdentity;
    accountAuthType.textContent = viewState.authType === 'bearer' ? 'Bearer' : 'API Token';
    accountWorkspaceCount.textContent = `${wsCount} workspace${wsCount === 1 ? '' : 's'}`;
  }

  authTypeSelect.value = normalizeAuthType(viewState.authType);
  bitbucketUsernameInput.value = viewState.username || '';
  // Security invariant: never populate stored token plaintext into the DOM
  bitbucketTokenInput.value = '';
  bitbucketTokenInput.type = 'password';
  toggleTokenVisibilityBtn.setAttribute('aria-label', 'Show token');
  toggleTokenVisibilityBtn.title = 'Show token';
  syncAuthMethodFields({
    authTypeSelect,
    usernameGroup,
    tokenLabel,
    bitbucketTokenInput,
    tokenHelpText
  });
  hideInlineBanner(authStatusBanner);

  // GitHub Account & Setup section
  const showGhSummary = viewState.githubAuthenticated && !viewState.isReplacingGitHubToken;
  githubSummaryCard.classList.toggle('hidden', !showGhSummary);
  githubCredentialsForm.classList.toggle('hidden', showGhSummary);
  githubSignOutConfirm.classList.add('hidden');

  const defaultGhApi = getEffectiveGitHubApiBaseUrl();
  const currentGhApi = viewState.githubApiBaseUrl || '';

  if (showGhSummary) {
    const ghUser = viewState.githubUser;
    const ghName = ghUser?.displayName || ghUser?.username || 'GitHub User';
    const ghHandle = ghUser?.username ? `@${ghUser.username}` : 'Authenticated';
    const effectiveApi = currentGhApi || defaultGhApi;
    const isCustomApi = effectiveApi !== defaultGhApi;

    githubAvatar.textContent = getInitials(ghName, 'GH');
    githubDisplayName.textContent = ghName;
    githubUsername.textContent = ghHandle;
    githubApiUrlDisplay.textContent = isCustomApi ? effectiveApi : 'github.com';
    githubApiUrlDisplay.title = `GitHub API: ${effectiveApi}`;
  }

  // Security invariant: never populate stored GitHub token plaintext into the DOM
  githubTokenInput.value = '';
  githubTokenInput.type = 'password';
  toggleGitHubTokenVisibilityBtn.setAttribute('aria-label', 'Show GitHub token');
  toggleGitHubTokenVisibilityBtn.title = 'Show token';
  githubApiUrlInput.value = currentGhApi;
  hideInlineBanner(githubAuthStatusBanner);

  // System One AI Triage section
  const decision = viewState.decision ?? {
    provider: DECISION_MODELS.DEFAULT_PROVIDER,
    baseUrl: '',
    model: '',
    isConfigured: false
  };
  const showDecisionSummary = Boolean(decision.isConfigured) && !viewState.isConfiguringDecision;
  decisionSummaryCard.classList.toggle('hidden', !showDecisionSummary);
  decisionConfigForm.classList.toggle('hidden', showDecisionSummary);
  decisionSignOutConfirmRow.classList.add('hidden');

  if (showDecisionSummary) {
    const defaultBase = decision.provider === 'gemini'
      ? DECISION_MODELS.GEMINI_DECISIONS_URL
      : DECISION_MODELS.JEV_API_BASE_URL;
    const effectiveBase = decision.baseUrl || defaultBase;
    const defaultModel = decision.provider === 'gemini'
      ? DECISION_MODELS.GEMINI_DEFAULT_MODEL
      : DECISION_MODELS.JEV_DEFAULT_MODEL;
    decisionProviderLabel.textContent = getDecisionProviderLabel(decision.provider);
    decisionModelDisplay.textContent = decision.model || defaultModel;
    decisionEndpointDisplay.textContent = formatEndpointHost(effectiveBase);
    decisionEndpointDisplay.title = effectiveBase;
  }

  const formProvider = decision.provider === 'jev' || decision.provider === 'gemini' || decision.provider === 'off'
    ? decision.provider
    : DECISION_MODELS.DEFAULT_PROVIDER;
  decisionProviderSelect.value = formProvider;

  if (formProvider === 'gemini') {
    decisionBaseUrlInput.value = decision.baseUrl || DECISION_MODELS.GEMINI_DECISIONS_URL;
    decisionModelInput.value = decision.model || DECISION_MODELS.GEMINI_DEFAULT_MODEL;
  } else if (formProvider === 'jev') {
    decisionBaseUrlInput.value = decision.baseUrl || DECISION_MODELS.JEV_API_BASE_URL;
    decisionModelInput.value = decision.model || DECISION_MODELS.JEV_DEFAULT_MODEL;
  } else {
    decisionBaseUrlInput.value = decision.baseUrl || '';
    decisionModelInput.value = decision.model || '';
  }

  // Security invariant: NEVER populate stored Decision API key into the DOM
  decisionApiKeyInput.value = '';
  decisionApiKeyInput.type = 'password';
  decisionToggleKeyBtn.setAttribute('aria-label', 'Show API key');
  decisionToggleKeyBtn.title = 'Show API key';
  syncDecisionProviderFields(
    {
      decisionProviderSelect,
      decisionFieldsGroup,
      decisionBaseUrlInput,
      decisionBaseUrlHelp,
      decisionModelInput,
      decisionApiKeyInput,
      decisionApiKeyHelp,
      decisionTestBtn: controls.decisionTestBtn
    },
    { applyProviderDefaults: false }
  );
  hideInlineBanner(decisionStatusBanner);
}

/**
 * Populate Settings -> Preferences inputs from `preferences` and show discovered workspace slugs.
 *
 * @param {PreferencesFormElements} elements
 * @param {Preferences} prefs
 * @param {readonly WorkspaceSummary[]} workspaces
 */
export function renderPreferencesForm(elements, prefs, workspaces) {
  const {
    prefPollInterval,
    prefBadgeMode,
    prefStaleHours,
    prefDefaultFilter,
    prefNotifications,
    prefCompactMode,
    prefWorkspacesFilter,
    availableWorkspacesHint,
    prefReposFilter,
    prefJiraUrl,
    prefsStatusBanner
  } = elements;

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

  const slugs = workspaces
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
 * Collect and validate credential inputs from the Bitbucket Account & Setup form.
 *
 * @param {{
 *   authTypeSelect: HTMLSelectElement,
 *   bitbucketUsernameInput: HTMLInputElement,
 *   bitbucketTokenInput: HTMLInputElement,
 *   authStatusBanner: HTMLDivElement
 * }} elements
 * @returns {{ authType: AuthType, username: string, token: string } | null}
 */
export function readValidatedCredentialInputs(elements) {
  const authType = normalizeAuthType(elements.authTypeSelect.value);
  const username = elements.bitbucketUsernameInput.value.trim();
  const token = elements.bitbucketTokenInput.value.trim();

  if (authType === 'api_token' && !username) {
    showInlineBanner(elements.authStatusBanner, 'Enter your Atlassian account email for API Token login.', 'error');
    elements.bitbucketUsernameInput.focus();
    return null;
  }
  if (!token) {
    showInlineBanner(elements.authStatusBanner, 'Paste your Bitbucket token before continuing.', 'error');
    elements.bitbucketTokenInput.focus();
    return null;
  }
  return { authType, username, token };
}

/**
 * Collect and validate GitHub PAT & optional Enterprise API URL from the GitHub form.
 *
 * @param {{
 *   githubTokenInput: HTMLInputElement,
 *   githubApiUrlInput: HTMLInputElement,
 *   githubAuthStatusBanner: HTMLDivElement
 * }} elements
 * @returns {{ token: string, apiBaseUrl: string } | null}
 */
export function readValidatedGitHubInputs(elements) {
  const token = elements.githubTokenInput.value.trim();
  const apiBaseUrl = elements.githubApiUrlInput.value.trim();

  if (!token) {
    showInlineBanner(elements.githubAuthStatusBanner, 'Paste your GitHub Personal Access Token before continuing.', 'error');
    elements.githubTokenInput.focus();
    return null;
  }

  if (apiBaseUrl && !sanitizeHttpsUrl(apiBaseUrl)) {
    showInlineBanner(
      elements.githubAuthStatusBanner,
      'GitHub API Base URL must be a valid https:// URL (e.g. https://api.github.com or https://github.company.com/api/v3).',
      'error'
    );
    elements.githubApiUrlInput.focus();
    return null;
  }

  return { token, apiBaseUrl };
}

/**
 * Collect and validate System One AI Triage configuration inputs from `#decision-config-form`.
 * Allows omitting the API key in Jev mode (for keyless internal GPUs) and preserves existing
 * saved key for Gemini when reconfiguring without re-entering the key (`alreadyConfiguredSameProvider`).
 *
 * @param {{
 *   decisionProviderSelect: HTMLSelectElement,
 *   decisionBaseUrlInput: HTMLInputElement,
 *   decisionModelInput: HTMLInputElement,
 *   decisionApiKeyInput: HTMLInputElement,
 *   decisionStatusBanner: HTMLDivElement
 * }} elements
 * @param {{ currentProvider?: DecisionProvider, isConfigured?: boolean, requireApiKeyForGemini?: boolean }} [options]
 * @returns {{ provider: DecisionProvider, baseUrl: string, model: string, apiKey: string } | null}
 */
export function readValidatedDecisionInputs(elements, options = {}) {
  const rawProvider = elements.decisionProviderSelect.value;
  /** @type {DecisionProvider} */
  const provider = rawProvider === 'jev' || rawProvider === 'gemini' ? rawProvider : 'off';
  if (provider === 'off') {
    return { provider: 'off', baseUrl: '', model: '', apiKey: '' };
  }

  const rawBaseUrl = elements.decisionBaseUrlInput.value.trim();
  const defaultBaseUrl = provider === 'gemini'
    ? DECISION_MODELS.GEMINI_DECISIONS_URL
    : DECISION_MODELS.JEV_API_BASE_URL;
  const candidateBaseUrl = rawBaseUrl || defaultBaseUrl;
  const safeBaseUrl = sanitizeDecisionEndpointUrl(candidateBaseUrl);

  if (!safeBaseUrl) {
    showInlineBanner(
      elements.decisionStatusBanner,
      provider === 'gemini'
        ? 'Gemini Decisions URL must be a valid https:// URL.'
        : 'Enter a valid https:// Endpoint URL (or http:// for localhost / internal LAN hosts).',
      'error'
    );
    elements.decisionBaseUrlInput.focus();
    return null;
  }

  const defaultModel = provider === 'gemini'
    ? DECISION_MODELS.GEMINI_DEFAULT_MODEL
    : DECISION_MODELS.JEV_DEFAULT_MODEL;
  const model = elements.decisionModelInput.value.trim() || defaultModel;
  const apiKey = elements.decisionApiKeyInput.value.trim();

  const canReuseStoredGeminiKey = Boolean(
    options.isConfigured &&
    options.currentProvider === 'gemini' &&
    !options.requireApiKeyForGemini
  );
  if (provider === 'gemini' && !apiKey && !canReuseStoredGeminiKey) {
    showInlineBanner(elements.decisionStatusBanner, 'Enter your Google AI Studio API key for Gemini Decision 1.', 'error');
    elements.decisionApiKeyInput.focus();
    return null;
  }

  return {
    provider,
    baseUrl: safeBaseUrl,
    model,
    apiKey
  };
}

/**
 * Parse comma-separated workspace or repository filter strings into trimmed, deduplicated slugs.
 *
 * @param {string} rawText
 * @returns {string[]}
 */
export function parseCsvList(rawText) {
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
 * Validate and collect Preferences form values, showing inline error banner if Jira URL override is invalid.
 *
 * @param {PreferencesFormElements} elements
 * @returns {Partial<Preferences> | null}
 */
export function readValidatedPreferencesInputs(elements) {
  const rawJiraUrl = elements.prefJiraUrl.value.trim();
  if (rawJiraUrl) {
    const sanitized = sanitizeHttpsUrl(rawJiraUrl);
    if (!sanitized) {
      showInlineBanner(
        elements.prefsStatusBanner,
        'Jira Base URL override must be a valid https:// URL (e.g. https://mezzanine.jira.example.com).',
        'error'
      );
      elements.prefJiraUrl.focus();
      return null;
    }
  }

  return /** @type {Partial<Preferences>} */ (/** @type {unknown} */ ({
    pollIntervalMinutes: Number(elements.prefPollInterval.value),
    badgeMode: elements.prefBadgeMode.value,
    staleThresholdHours: Number(elements.prefStaleHours.value),
    defaultFilter: elements.prefDefaultFilter.value,
    notificationsEnabled: elements.prefNotifications.checked,
    compactMode: elements.prefCompactMode.checked,
    workspacesFilter: parseCsvList(elements.prefWorkspacesFilter.value),
    reposFilter: parseCsvList(elements.prefReposFilter.value),
    jiraBaseUrlOverride: rawJiraUrl
  }));
}

/**
 * Toggle password/plaintext visibility on a token input and update its button labels.
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLButtonElement} toggleBtn
 * @param {string} showLabel
 * @param {string} hideLabel
 */
export function toggleSecretInputVisibility(inputEl, toggleBtn, showLabel, hideLabel) {
  const showing = inputEl.type === 'text';
  inputEl.type = showing ? 'password' : 'text';
  const nextLabel = showing ? showLabel : hideLabel;
  toggleBtn.setAttribute('aria-label', nextLabel);
  toggleBtn.title = nextLabel;
}

/**
 * Reveal the Settings drawer and move focus to the appropriate input or button.
 *
 * @param {{
 *   settingsPanel: HTMLElement,
 *   toggleSettingsBtn: HTMLButtonElement,
 *   githubCredentialsForm: HTMLFormElement,
 *   githubTokenInput: HTMLInputElement,
 *   githubReplaceTokenBtn: HTMLButtonElement,
 *   credentialsForm: HTMLFormElement,
 *   authTypeSelect: HTMLSelectElement,
 *   bitbucketUsernameInput: HTMLInputElement,
 *   bitbucketTokenInput: HTMLInputElement,
 *   replaceTokenBtn: HTMLButtonElement,
 *   prefPollInterval: HTMLSelectElement
 * }} elements
 * @param {'account' | 'preferences'} subtab
 * @param {'bitbucket' | 'github'} [focusTarget]
 */
export function showSettingsDrawer(elements, subtab, focusTarget) {
  elements.settingsPanel.classList.remove('hidden');
  elements.toggleSettingsBtn.setAttribute('aria-expanded', 'true');

  if (subtab === 'account') {
    if (focusTarget === 'github') {
      if (!elements.githubCredentialsForm.classList.contains('hidden')) {
        elements.githubTokenInput.focus();
        elements.githubTokenInput.scrollIntoView({ block: 'nearest' });
      } else {
        elements.githubReplaceTokenBtn.focus();
        elements.githubReplaceTokenBtn.scrollIntoView({ block: 'nearest' });
      }
    } else if (!elements.credentialsForm.classList.contains('hidden')) {
      if (elements.authTypeSelect.value === 'api_token' && !elements.bitbucketUsernameInput.value.trim()) {
        elements.bitbucketUsernameInput.focus();
      } else {
        elements.bitbucketTokenInput.focus();
      }
    } else {
      elements.replaceTokenBtn.focus();
    }
  } else {
    elements.prefPollInterval.focus();
  }
}

/**
 * Hide the Settings drawer and restore focus to the Settings toggle button if focus was inside.
 *
 * @param {HTMLElement} settingsPanel
 * @param {HTMLButtonElement} toggleSettingsBtn
 */
export function hideSettingsDrawer(settingsPanel, toggleSettingsBtn) {
  const focusWasInside = settingsPanel.contains(document.activeElement);
  settingsPanel.classList.add('hidden');
  toggleSettingsBtn.setAttribute('aria-expanded', 'false');
  if (focusWasInside) {
    toggleSettingsBtn.focus();
  }
}
