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
 * @property {boolean} groupByTicket
 * @property {readonly string[]} workspacesFilter
 * @property {readonly string[]} reposFilter
 * @property {string} jiraBaseUrlOverride
 */

export const CENTRAL_URLS = Object.freeze({
  /**
   * Hardcode your Mezzanine Jira base URL here once (no trailing slash), e.g.:
   * 'https://mezzanine.jira.example.com'
   */
  MEZZANINE_JIRA_URL: 'https://mezzanineware.atlassian.net/',

  /** Optional Confluence base URL placeholder (no trailing slash). */
  CONFLUENCE_URL: '',

  BITBUCKET_API_BASE_URL: 'https://api.bitbucket.org/2.0',
  BITBUCKET_WEB_BASE_URL: 'https://bitbucket.org',

  /**
   * ==========================================================================
   * GITHUB & GITHUB ENTERPRISE SERVER URLS
   * ==========================================================================
   * For github.com, keep the defaults below.
   * For GitHub Enterprise Server (GHES), hardcode your company URLs ONCE below
   * (with `https://` and NO trailing slash), for example:
   *   GITHUB_API_BASE_URL: 'https://github.company.com/api/v3',
   *   GITHUB_WEB_BASE_URL: 'https://github.company.com',
   * Users can also override the API Base URL in Settings without code edits.
   * ==========================================================================
   */
  GITHUB_API_BASE_URL: 'https://api.github.com',
  GITHUB_WEB_BASE_URL: 'https://github.com'
});

/**
 * ============================================================================
 * DEVELOPER CONFIGURATION — SYSTEM ONE DECISION MODELS (JEV / CLEF & GEMINI)
 * ============================================================================
 * Configure default System One decision-model endpoints centrally below.
 *
 * - For an internal/office Clef Flash GPU server (keyless or Bearer-protected):
 *   Set `DEFAULT_PROVIDER: 'jev'` and hardcode `JEV_API_BASE_URL` (no trailing
 *   slash, e.g. 'https://clef.internal.example.com' or 'http://10.0.1.42:8080').
 * - For Google Gemini Decision 1:
 *   Set `DEFAULT_PROVIDER: 'gemini'`, keep `GEMINI_DECISIONS_URL` and
 *   `GEMINI_DEFAULT_MODEL: 'gemini-decision-1'`, and configure your API key
 *   in the extension Settings drawer (never hardcode keys in source!).
 *
 * Users can override provider, base URL, model, and API key in Settings.
 * ============================================================================
 */
export const DECISION_MODELS = Object.freeze({
  /** @type {'off' | 'jev' | 'gemini'} */
  DEFAULT_PROVIDER: 'off',

  /**
   * Default Jev / Clef Flash base URL (no trailing slash), e.g.:
   * 'https://api.typesafe.ai' or 'https://clef.internal.example.com'
   */
  JEV_API_BASE_URL: '',
  JEV_DEFAULT_MODEL: 'clef-flash',

  /** Google Gemini System One Decisions API endpoint & default model. */
  GEMINI_DECISIONS_URL: 'https://generativelanguage.googleapis.com/v1beta/decisions',
  GEMINI_DEFAULT_MODEL: 'gemini-decision-1',

  /** Minimum probability/confidence required to surface a triage badge. */
  CONFIDENCE_THRESHOLD: 0.75,
  /** Bump when question wording/choices change to invalidate cached scores cleanly. */
  QUESTION_SET_VERSION: 'effort-risk-v1',

  /** Per-request question limits enforced by auto-chunking in `decision-client.js`. */
  JEV_MAX_QUESTIONS_PER_REQUEST: 16,
  GEMINI_MAX_QUESTIONS_PER_REQUEST: 1000
});

export const AUTH_SETUP_LINKS = Object.freeze({
  atlassianApiTokens: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  bitbucketAccessTokensDocs: 'https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/',
  requiredScopes: Object.freeze([
    'read:user:bitbucket',
    'read:workspace:bitbucket',
    'read:repository:bitbucket',
    'read:pullrequest:bitbucket'
  ]),
  githubTokens: 'https://github.com/settings/tokens',
  githubFineGrainedDocs: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  githubRequiredScopes: Object.freeze([
    'repo (or fine-grained Pull requests: Read + Commit statuses: Read)'
  ])
});

export const CACHE_TTL_MS = Object.freeze({
  userProfile: 24 * 60 * 60 * 1000,
  workspaces: 60 * 60 * 1000,
  repositories: 30 * 60 * 1000,
  prStaleAfter: 5 * 60 * 1000,
  buildStatusTerminal: 6 * 60 * 60 * 1000,
  buildStatusActive: 60 * 1000,
  diffstat: 24 * 60 * 60 * 1000,
  decisionTriage: 24 * 60 * 60 * 1000
});

export const THROTTLE_CONFIG = Object.freeze({
  manualRefreshCooldownMs: 10_000,
  syncLockTimeoutMs: 45_000,
  requestTimeoutMs: 12_000,
  maxConcurrentRequests: 4,
  maxPagesPerEndpoint: 5,
  maxReposPerWorkspace: 25,
  maxBuildStatusCacheEntries: 200,
  maxDiffstatCacheEntries: 200,
  maxDecisionCacheEntries: 200,
  maxDiffstatFilesInPrompt: 25,
  maxDescriptionCharsInPrompt: 800,
  baseBackoffMs: 15_000,
  maxBackoffMs: 15 * 60 * 1000,
  nearLimitDelayMs: 1_500
});

/** @type {Readonly<Preferences>} */
export const DEFAULT_PREFERENCES = Object.freeze({
  pollIntervalMinutes: 15,
  badgeMode: 'action_required',
  notificationsEnabled: false,
  staleThresholdHours: 48,
  defaultFilter: 'action_required',
  compactMode: false,
  groupByTicket: false,
  workspacesFilter: Object.freeze(/** @type {string[]} */ ([])),
  reposFilter: Object.freeze(/** @type {string[]} */ ([])),
  jiraBaseUrlOverride: ''
});

export const STORAGE_KEYS = Object.freeze({
  AUTH_TYPE: 'authType',
  BITBUCKET_USERNAME: 'bitbucketUsername',
  BITBUCKET_TOKEN: 'bitbucketToken',
  GITHUB_TOKEN: 'githubToken',
  GITHUB_API_BASE_URL: 'githubApiBaseUrl',
  CACHED_GITHUB_USER: 'cachedGitHubUser',
  PREFERENCES: 'preferences',
  CACHED_USER: 'cachedUser',
  CACHED_WORKSPACES: 'cachedWorkspaces',
  CACHED_REPOS: 'cachedRepos',
  CACHED_BUILD_STATUSES: 'cachedBuildStatuses',
  DECISION_CONFIG: 'decisionConfig',
  CACHED_DIFFSTATS: 'cachedDiffstats',
  CACHED_DECISIONS: 'cachedDecisions',
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
 * Check whether a hostname is a local/loopback, RFC1918 private IPv4, or `.local` internal host
 * eligible for plain `http://` Clef Flash / internal GPU endpoints.
 *
 * @param {string} rawHostname
 * @returns {boolean}
 */
function isInternalOrLocalHostname(rawHostname) {
  const host = rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true;
  }
  if (host.endsWith('.local')) {
    return true;
  }
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) {
    return false;
  }
  const octets = ipv4Match.slice(1).map((part) => Number.parseInt(part, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Validate and sanitize a System One Decision Model endpoint URL (normalized without trailing slash).
 * Allows any valid `https://` URL without embedded credentials, and allows `http://` ONLY for
 * `localhost`, `127.0.0.1`, `[::1]`, RFC1918 private IPs, or internal `.local` hosts.
 * Rejects `javascript:`, `data:`, embedded credentials, and public `http://` URLs.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function sanitizeDecisionEndpointUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    if (parsed.protocol === 'https:') {
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${cleanPath}`;
    }
    if (parsed.protocol === 'http:' && isInternalOrLocalHostname(parsed.hostname)) {
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${cleanPath}`;
    }
    return null;
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

/**
 * Resolve the effective GitHub API base URL (normalized `https://...` with no trailing slash).
 * Uses `overrideUrl` when valid `https:`, otherwise falls back to `CENTRAL_URLS.GITHUB_API_BASE_URL`.
 *
 * @param {string | null | undefined} [overrideUrl]
 * @returns {string}
 */
export function getEffectiveGitHubApiBaseUrl(overrideUrl) {
  const overrideRaw = typeof overrideUrl === 'string' ? overrideUrl.trim() : '';
  const fallbackRaw = CENTRAL_URLS.GITHUB_API_BASE_URL.trim() || 'https://api.github.com';
  const candidate = overrideRaw || fallbackRaw;
  const safeUrl = sanitizeHttpsUrl(candidate) || sanitizeHttpsUrl(fallbackRaw) || 'https://api.github.com';
  const parsed = new URL(safeUrl);
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}
