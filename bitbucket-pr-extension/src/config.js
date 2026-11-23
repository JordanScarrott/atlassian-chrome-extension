/**
 * Central Configuration Module for the Atlassian Chrome Extension.
 *
 * ============================================================================
 * DEVELOPER CONFIGURATION — MEZZANINE JIRA & CONFLUENCE URLS
 * ============================================================================
 * To enable one-click deep links from PR Jira ticket chips and the Jira tab,
 * hardcode your company's Mezzanine Jira base URL below ONCE (with `https://`
 * and NO trailing slash), for example:
 *
 *   MEZZANINE_JIRA_URL: 'https://mezzanine.jira.example.com',
 *
 * Optionally, you may also set `CONFLUENCE_URL` to enable quick-open links
 * in the Confluence tab. Users can still optionally override the Jira URL in
 * the extension Preferences drawer without modifying code.
 * ============================================================================
 */

/**
 * @typedef {Object} Preferences
 * @property {0 | 1 | 5 | 15 | 30} pollIntervalMinutes
 * @property {'action_required' | 'all_open' | 'off'} badgeMode
 * @property {boolean} notificationsEnabled
 * @property {24 | 48 | 72} staleThresholdHours
 * @property {'action_required' | 'reviewing' | 'authored' | 'all'} defaultFilter
 * @property {boolean} compactMode
 * @property {readonly string[]} workspacesFilter
 * @property {readonly string[]} reposFilter
 * @property {string} jiraBaseUrlOverride
 */

export const CENTRAL_URLS = Object.freeze({
  /**
   * Hardcode your Mezzanine Jira base URL here once (no trailing slash), e.g.:
   * 'https://mezzanine.jira.example.com'
   */
  MEZZANINE_JIRA_URL: '',

  /** Optional Confluence base URL placeholder (no trailing slash). */
  CONFLUENCE_URL: '',

  BITBUCKET_API_BASE_URL: 'https://api.bitbucket.org/2.0',
  BITBUCKET_WEB_BASE_URL: 'https://bitbucket.org'
});

export const AUTH_SETUP_LINKS = Object.freeze({
  atlassianApiTokens: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  bitbucketAccessTokensDocs: 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/',
  requiredScopes: Object.freeze([
    'read:user:bitbucket',
    'read:workspace:bitbucket',
    'read:repository:bitbucket',
    'read:pullrequest:bitbucket'
  ])
});

export const CACHE_TTL_MS = Object.freeze({
  userProfile: 24 * 60 * 60 * 1000,
  workspaces: 60 * 60 * 1000,
  repositories: 30 * 60 * 1000,
  prStaleAfter: 5 * 60 * 1000
});

export const THROTTLE_CONFIG = Object.freeze({
  manualRefreshCooldownMs: 10_000,
  syncLockTimeoutMs: 45_000,
  requestTimeoutMs: 12_000,
  maxConcurrentRequests: 4,
  maxPagesPerEndpoint: 5,
  maxReposPerWorkspace: 25,
  baseBackoffMs: 15_000,
  maxBackoffMs: 15 * 60 * 1000,
  nearLimitDelayMs: 1_500
});

/** @type {Readonly<Preferences>} */
export const DEFAULT_PREFERENCES = Object.freeze({
  pollIntervalMinutes: 5,
  badgeMode: 'action_required',
  notificationsEnabled: false,
  staleThresholdHours: 48,
  defaultFilter: 'action_required',
  compactMode: false,
  workspacesFilter: Object.freeze(/** @type {string[]} */ ([])),
  reposFilter: Object.freeze(/** @type {string[]} */ ([])),
  jiraBaseUrlOverride: ''
});

export const STORAGE_KEYS = Object.freeze({
  AUTH_TYPE: 'authType',
  BITBUCKET_USERNAME: 'bitbucketUsername',
  BITBUCKET_TOKEN: 'bitbucketToken',
  PREFERENCES: 'preferences',
  CACHED_USER: 'cachedUser',
  CACHED_WORKSPACES: 'cachedWorkspaces',
  CACHED_REPOS: 'cachedRepos',
  PR_LIST: 'prList',
  LAST_UPDATED: 'lastUpdated',
  ERROR: 'error',
  RATE_LIMIT_WARNING: 'rateLimitWarning',
  SYNCED_WORKSPACES: 'syncedWorkspaces',
  SYNC_STATE: 'syncState',
  SNOOZED_PRS: 'snoozedPrs',
  REQUESTED_PRODUCTS: 'requestedProducts',
  PRODUCT_FEEDBACK: 'productFeedback',
  PRODUCT_FEEDBACK_TIMESTAMP: 'productFeedbackTimestamp'
});

/**
 * Validate and sanitize an external URL, strictly requiring `https:`.
 * Rejects `http:`, `javascript:`, `data:`, embedded credentials, or malformed strings.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function sanitizeHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve the effective Jira base URL (normalized `https://...` with no trailing slash, or `''`).
 * Checks `preferences.jiraBaseUrlOverride` first, then falls back to `CENTRAL_URLS.MEZZANINE_JIRA_URL`.
 *
 * @param {Partial<Preferences> | null | undefined} [preferences]
 * @returns {string}
 */
export function getEffectiveJiraBaseUrl(preferences) {
  const overrideRaw = typeof preferences?.jiraBaseUrlOverride === 'string'
    ? preferences.jiraBaseUrlOverride.trim()
    : '';

  const candidate = overrideRaw || CENTRAL_URLS.MEZZANINE_JIRA_URL.trim();
  const safeUrl = sanitizeHttpsUrl(candidate);
  if (!safeUrl) {
    return '';
  }

  const parsed = new URL(safeUrl);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}
