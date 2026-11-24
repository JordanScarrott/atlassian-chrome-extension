import {
  DECISION_MODELS,
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  THROTTLE_CONFIG,
  getEffectiveGitHubApiBaseUrl,
  sanitizeDecisionEndpointUrl,
  sanitizeHttpsUrl
} from './config.js';

/**
 * @typedef {'api_token' | 'bearer'} AuthType
 */

/**
 * @typedef {'bitbucket' | 'github'} PrProvider
 */

/**
 * @typedef {'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED'} BuildState
 */

/**
 * @typedef {Object} BuildStatusSummary
 * @property {BuildState} state
 * @property {number} totalCount
 * @property {number} passedCount
 * @property {number} failedCount
 * @property {number} inProgressCount
 * @property {number} stoppedCount
 * @property {string | null} url
 * @property {string} name
 * @property {string} updatedOn
 * @property {string} commitHash
 * @property {number} cachedAt
 */

/**
 * @typedef {Record<string, BuildStatusSummary>} BuildStatusCacheMap
 */

/**
 * @typedef {Object} DiffstatFile
 * @property {string} path
 * @property {number} added
 * @property {number} removed
 * @property {string} status
 */

/**
 * @typedef {Object} DiffstatSummary
 * @property {string} commitHash
 * @property {number} filesChanged
 * @property {number} linesAdded
 * @property {number} linesRemoved
 * @property {DiffstatFile[]} files
 * @property {number} cachedAt
 */

/**
 * @typedef {Record<string, DiffstatSummary>} DiffstatCacheMap
 */

/**
 * @typedef {'off' | 'jev' | 'gemini'} DecisionProvider
 */

/**
 * @typedef {Object} DecisionConfig
 * @property {DecisionProvider} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 */

/**
 * @typedef {Object} DecisionTriageResult
 * @property {string} commitHash
 * @property {string} questionSetVersion
 * @property {'jev' | 'gemini'} provider
 * @property {string} model
 * @property {'quick' | 'medium' | 'deep' | null} effort
 * @property {number} effortConfidence
 * @property {'hotfix' | 'high_risk' | null} alert
 * @property {number} alertConfidence
 * @property {string | null} changeKind
 * @property {number | null} riskScore
 * @property {boolean | null} hasClearContext
 * @property {number} cachedAt
 */

/**
 * @typedef {Record<string, DecisionTriageResult>} DecisionCacheMap
 */

/**
 * @typedef {Object} Credentials
 * @property {AuthType} authType
 * @property {string} username
 * @property {string} token
 */

/**
 * @typedef {Object} GitHubCredentials
 * @property {string} token
 * @property {string} apiBaseUrl
 */

/**
 * @typedef {Object} CachedUser
 * @property {string} uuid
 * @property {string} [accountId]
 * @property {string} displayName
 * @property {string} username
 * @property {string | null} avatarUrl
 * @property {number} cachedAt
 */

/**
 * @typedef {Object} WorkspaceSummary
 * @property {string} slug
 * @property {string} name
 */

/**
 * @typedef {Object} CachedWorkspaces
 * @property {WorkspaceSummary[]} items
 * @property {number} cachedAt
 */

/**
 * @typedef {Object} RepoSummary
 * @property {string} slug
 * @property {string} fullName
 * @property {string} updatedOn
 */

/**
 * @typedef {Object} CachedReposEntry
 * @property {RepoSummary[]} items
 * @property {number} cachedAt
 */

/**
 * @typedef {Object} PrParticipant
 * @property {string} uuid
 * @property {string} displayName
 * @property {string} role
 * @property {boolean} approved
 * @property {'approved' | 'changes_requested' | null} state
 */

/**
 * @typedef {Object} PrReviewer
 * @property {string} uuid
 * @property {string} displayName
 */

/**
 * @typedef {Object} PullRequestRecord
 * @property {PrProvider} [provider]
 * @property {string} key
 * @property {number} id
 * @property {string} title
 * @property {string} [description]
 * @property {string} state
 * @property {string} url
 * @property {string} repoFullName
 * @property {string} repoName
 * @property {string} workspace
 * @property {string} authorUuid
 * @property {string} authorName
 * @property {string} sourceBranch
 * @property {string} destinationBranch
 * @property {string} createdOn
 * @property {string} updatedOn
 * @property {number} commentCount
 * @property {number} taskCount
 * @property {boolean} draft
 * @property {PrReviewer[]} reviewers
 * @property {PrParticipant[]} participants
 * @property {string} [sourceCommitHash]
 * @property {BuildStatusSummary | null} [buildStatus]
 * @property {DiffstatSummary | null} [diffstat]
 * @property {DecisionTriageResult | null} [aiTriage]
 */

/**
 * @typedef {Object} PrSnapshot
 * @property {PullRequestRecord[]} prList
 * @property {number | null} lastUpdated
 * @property {string | null} error
 * @property {boolean} rateLimitWarning
 * @property {string[]} syncedWorkspaces
 */

/**
 * @typedef {Object} SyncState
 * @property {number | null} inFlightSince
 * @property {number | null} lastManualSyncAt
 * @property {number | null} backoffUntil
 * @property {number} consecutiveFailures
 */

/**
 * @typedef {Object} SnoozeEntry
 * @property {number} until
 * @property {string} prUpdatedOn
 * @property {string} [reason]
 */

/**
 * @typedef {Record<string, SnoozeEntry>} SnoozedMap
 */

/**
 * @typedef {Object} ProductFeedbackState
 * @property {string[]} requestedProducts
 * @property {string} productFeedback
 * @property {number | null} productFeedbackTimestamp
 */

/**
 * @typedef {Object} StorageAreaLike
 * @property {(keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>} get
 * @property {(items: Record<string, unknown>) => Promise<void>} set
 * @property {(keys: string | string[]) => Promise<void>} remove
 */

/** @type {ReadonlySet<number>} */
const VALID_POLL_INTERVALS = new Set([0, 1, 5, 15, 30]);
/** @type {ReadonlySet<string>} */
const VALID_BADGE_MODES = new Set(['action_required', 'all_open', 'off']);
/** @type {ReadonlySet<number>} */
const VALID_STALE_HOURS = new Set([24, 48, 72]);
/** @type {ReadonlySet<string>} */
const VALID_DEFAULT_FILTERS = new Set(['action_required', 'reviewing', 'authored', 'all']);

/**
 * Normalize legacy and current auth type values.
 * Migrates `'pat'` -> `'bearer'` and `'app_password'` -> `'api_token'`.
 *
 * @param {unknown} rawAuthType
 * @returns {AuthType}
 */
export function normalizeAuthType(rawAuthType) {
  if (rawAuthType === 'bearer' || rawAuthType === 'pat') {
    return 'bearer';
  }
  if (rawAuthType === 'api_token' || rawAuthType === 'app_password') {
    return 'api_token';
  }
  return 'api_token';
}

/**
 * Validate and sanitize string filter arrays (workspace slugs or `workspace/repo` slugs).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function sanitizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result;
}

/**
 * Merge and validate partial preferences against `DEFAULT_PREFERENCES`.
 *
 * @param {unknown} raw
 * @param {import('./config.js').Preferences} [base]
 * @returns {import('./config.js').Preferences}
 */
export function validatePreferences(raw, base = DEFAULT_PREFERENCES) {
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};

  const pollCandidate = typeof source.pollIntervalMinutes === 'number'
    ? source.pollIntervalMinutes
    : base.pollIntervalMinutes;
  const pollIntervalMinutes = /** @type {0 | 1 | 5 | 15 | 30} */ (
    VALID_POLL_INTERVALS.has(pollCandidate) ? pollCandidate : DEFAULT_PREFERENCES.pollIntervalMinutes
  );

  const badgeCandidate = typeof source.badgeMode === 'string' ? source.badgeMode : base.badgeMode;
  const badgeMode = /** @type {'action_required' | 'all_open' | 'off'} */ (
    VALID_BADGE_MODES.has(badgeCandidate) ? badgeCandidate : DEFAULT_PREFERENCES.badgeMode
  );

  const notificationsEnabled = typeof source.notificationsEnabled === 'boolean'
    ? source.notificationsEnabled
    : base.notificationsEnabled;

  const staleCandidate = typeof source.staleThresholdHours === 'number'
    ? source.staleThresholdHours
    : base.staleThresholdHours;
  const staleThresholdHours = /** @type {24 | 48 | 72} */ (
    VALID_STALE_HOURS.has(staleCandidate) ? staleCandidate : DEFAULT_PREFERENCES.staleThresholdHours
  );

  const filterCandidate = typeof source.defaultFilter === 'string'
    ? source.defaultFilter
    : base.defaultFilter;
  const defaultFilter = /** @type {'action_required' | 'reviewing' | 'authored' | 'all'} */ (
    VALID_DEFAULT_FILTERS.has(filterCandidate) ? filterCandidate : DEFAULT_PREFERENCES.defaultFilter
  );

  const compactMode = typeof source.compactMode === 'boolean'
    ? source.compactMode
    : base.compactMode;

  const groupByTicket = typeof source.groupByTicket === 'boolean'
    ? source.groupByTicket
    : Boolean(base.groupByTicket);

  const workspacesFilter = source.workspacesFilter !== undefined
    ? sanitizeStringList(source.workspacesFilter)
    : [...base.workspacesFilter];

  const reposFilter = source.reposFilter !== undefined
    ? sanitizeStringList(source.reposFilter)
    : [...base.reposFilter];

  let jiraBaseUrlOverride = base.jiraBaseUrlOverride;
  if (typeof source.jiraBaseUrlOverride === 'string') {
    const trimmed = source.jiraBaseUrlOverride.trim();
    if (!trimmed) {
      jiraBaseUrlOverride = '';
    } else {
      const sanitized = sanitizeHttpsUrl(trimmed);
      if (sanitized) {
        const parsed = new URL(sanitized);
        jiraBaseUrlOverride = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
      }
    }
  }

  return {
    pollIntervalMinutes,
    badgeMode,
    notificationsEnabled,
    staleThresholdHours,
    defaultFilter,
    compactMode,
    groupByTicket,
    workspacesFilter,
    reposFilter,
    jiraBaseUrlOverride
  };
}

/**
 * Create an injectable, strongly-typed storage adapter around `chrome.storage.local`.
 *
 * @param {StorageAreaLike | undefined} [area]
 */
export function createStorage(area = typeof chrome !== 'undefined' ? chrome?.storage?.local : undefined) {
  if (!area || typeof area.get !== 'function' || typeof area.set !== 'function' || typeof area.remove !== 'function') {
    throw new Error('A valid chrome.storage.local-compatible storage area is required.');
  }

  return {
    /**
     * Read and migrate stored Bitbucket credentials.
     * Transparently upgrades `'pat'` -> `'bearer'` and `'app_password'` -> `'api_token'`.
     *
     * @returns {Promise<Credentials | null>}
     */
    async getCredentials() {
      const data = await area.get([
        STORAGE_KEYS.AUTH_TYPE,
        STORAGE_KEYS.BITBUCKET_USERNAME,
        STORAGE_KEYS.BITBUCKET_TOKEN
      ]);

      const storedToken = data[STORAGE_KEYS.BITBUCKET_TOKEN];
      const rawToken = typeof storedToken === 'string' ? storedToken.trim() : '';

      if (!rawToken) {
        return null;
      }

      const rawAuthType = data[STORAGE_KEYS.AUTH_TYPE];
      const normalizedAuthType = normalizeAuthType(rawAuthType);
      const storedUsername = data[STORAGE_KEYS.BITBUCKET_USERNAME];
      const username = typeof storedUsername === 'string' ? storedUsername.trim() : '';

      // Persist migrated authType transparently if legacy value was stored
      if (rawAuthType !== normalizedAuthType) {
        await area.set({ [STORAGE_KEYS.AUTH_TYPE]: normalizedAuthType });
      }

      return {
        authType: normalizedAuthType,
        username,
        token: rawToken
      };
    },

    /**
     * Save Bitbucket credentials (normalizing authType).
     *
     * @param {Partial<Credentials>} creds
     * @returns {Promise<Credentials>}
     */
    async saveCredentials(creds) {
      const normalized = {
        authType: normalizeAuthType(creds.authType),
        username: typeof creds.username === 'string' ? creds.username.trim() : '',
        token: typeof creds.token === 'string' ? creds.token.trim() : ''
      };

      await area.set({
        [STORAGE_KEYS.AUTH_TYPE]: normalized.authType,
        [STORAGE_KEYS.BITBUCKET_USERNAME]: normalized.username,
        [STORAGE_KEYS.BITBUCKET_TOKEN]: normalized.token
      });

      return normalized;
    },

    /**
     * Clear credentials, user/workspace/repo/PR caches, and sync state
     * while preserving user preferences, snoozed PRs, and product feedback.
     *
     * @returns {Promise<void>}
     */
    async clearCredentialsAndCache() {
      await area.remove([
        STORAGE_KEYS.AUTH_TYPE,
        STORAGE_KEYS.BITBUCKET_USERNAME,
        STORAGE_KEYS.BITBUCKET_TOKEN,
        STORAGE_KEYS.CACHED_USER,
        STORAGE_KEYS.CACHED_WORKSPACES,
        STORAGE_KEYS.CACHED_REPOS,
        STORAGE_KEYS.CACHED_BUILD_STATUSES,
        STORAGE_KEYS.PR_LIST,
        STORAGE_KEYS.LAST_UPDATED,
        STORAGE_KEYS.ERROR,
        STORAGE_KEYS.RATE_LIMIT_WARNING,
        STORAGE_KEYS.SYNCED_WORKSPACES,
        STORAGE_KEYS.SYNC_STATE
      ]);
    },

    /**
     * Read stored GitHub PAT credentials and effective API base URL.
     * Returns `null` if no GitHub token is configured.
     *
     * @returns {Promise<GitHubCredentials | null>}
     */
    async getGitHubCredentials() {
      const data = await area.get([
        STORAGE_KEYS.GITHUB_TOKEN,
        STORAGE_KEYS.GITHUB_API_BASE_URL
      ]);
      const storedToken = data[STORAGE_KEYS.GITHUB_TOKEN];
      const token = typeof storedToken === 'string' ? storedToken.trim() : '';
      if (!token) {
        return null;
      }

      const rawBaseVal = data[STORAGE_KEYS.GITHUB_API_BASE_URL];
      const rawBase = typeof rawBaseVal === 'string' ? rawBaseVal : '';
      return {
        token,
        apiBaseUrl: getEffectiveGitHubApiBaseUrl(rawBase)
      };
    },

    /**
     * Save GitHub PAT credentials and optional normalized Enterprise API base URL.
     *
     * @param {Partial<GitHubCredentials>} creds
     * @returns {Promise<GitHubCredentials>}
     */
    async saveGitHubCredentials(creds) {
      const token = typeof creds?.token === 'string' ? creds.token.trim() : '';
      const rawBase = typeof creds?.apiBaseUrl === 'string' ? creds.apiBaseUrl.trim() : '';
      const apiBaseUrl = getEffectiveGitHubApiBaseUrl(rawBase);

      await area.set({
        [STORAGE_KEYS.GITHUB_TOKEN]: token,
        [STORAGE_KEYS.GITHUB_API_BASE_URL]: rawBase ? apiBaseUrl : ''
      });

      return { token, apiBaseUrl };
    },

    /**
     * Clear GitHub credentials and cached GitHub user profile while preserving
     * Bitbucket credentials, preferences, snoozed PRs, and product feedback.
     *
     * @returns {Promise<void>}
     */
    async clearGitHubCredentialsAndCache() {
      await area.remove([
        STORAGE_KEYS.GITHUB_TOKEN,
        STORAGE_KEYS.GITHUB_API_BASE_URL,
        STORAGE_KEYS.CACHED_GITHUB_USER
      ]);
    },

    /**
     * Read cached GitHub user profile.
     *
     * @returns {Promise<CachedUser | null>}
     */
    async getCachedGitHubUser() {
      const data = await area.get([STORAGE_KEYS.CACHED_GITHUB_USER]);
      const raw = data[STORAGE_KEYS.CACHED_GITHUB_USER];
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const entry = /** @type {Record<string, unknown>} */ (raw);
      if (typeof entry.uuid !== 'string' || typeof entry.cachedAt !== 'number') {
        return null;
      }
      const avatarUrl = typeof entry.avatarUrl === 'string' ? sanitizeHttpsUrl(entry.avatarUrl) : null;
      return {
        uuid: entry.uuid,
        ...(typeof entry.accountId === 'string' ? { accountId: entry.accountId } : {}),
        displayName: typeof entry.displayName === 'string' ? entry.displayName : 'GitHub User',
        username: typeof entry.username === 'string' ? entry.username : '',
        avatarUrl,
        cachedAt: entry.cachedAt
      };
    },

    /**
     * Persist cached GitHub user profile.
     *
     * @param {CachedUser} user
     * @returns {Promise<void>}
     */
    async setCachedGitHubUser(user) {
      const avatarUrl = typeof user.avatarUrl === 'string' ? sanitizeHttpsUrl(user.avatarUrl) : null;
      await area.set({
        [STORAGE_KEYS.CACHED_GITHUB_USER]: {
          uuid: user.uuid,
          ...(typeof user.accountId === 'string' ? { accountId: user.accountId } : {}),
          displayName: user.displayName,
          username: user.username,
          avatarUrl,
          cachedAt: user.cachedAt
        }
      });
    },

    /**
     * Read and validate preferences merged with defaults.
     *
     * @returns {Promise<import('./config.js').Preferences>}
     */
    async getPreferences() {
      const data = await area.get([STORAGE_KEYS.PREFERENCES]);
      return validatePreferences(data[STORAGE_KEYS.PREFERENCES], DEFAULT_PREFERENCES);
    },

    /**
     * Merge partial preference updates with existing stored preferences and validate.
     *
     * @param {Partial<import('./config.js').Preferences>} partialPrefs
     * @returns {Promise<import('./config.js').Preferences>}
     */
    async savePreferences(partialPrefs) {
      const current = await this.getPreferences();
      const merged = validatePreferences(partialPrefs, current);
      await area.set({ [STORAGE_KEYS.PREFERENCES]: merged });
      return merged;
    },

    /**
     * @returns {Promise<CachedUser | null>}
     */
    async getCachedUser() {
      const data = await area.get([STORAGE_KEYS.CACHED_USER]);
      const raw = data[STORAGE_KEYS.CACHED_USER];
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const entry = /** @type {Record<string, unknown>} */ (raw);
      if (typeof entry.uuid !== 'string' || typeof entry.cachedAt !== 'number') {
        return null;
      }
      const avatarUrl = typeof entry.avatarUrl === 'string' ? sanitizeHttpsUrl(entry.avatarUrl) : null;
      return {
        uuid: entry.uuid,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : 'Bitbucket User',
        username: typeof entry.username === 'string' ? entry.username : '',
        avatarUrl,
        cachedAt: entry.cachedAt
      };
    },

    /**
     * @param {CachedUser} user
     * @returns {Promise<void>}
     */
    async setCachedUser(user) {
      const avatarUrl = typeof user.avatarUrl === 'string' ? sanitizeHttpsUrl(user.avatarUrl) : null;
      await area.set({
        [STORAGE_KEYS.CACHED_USER]: {
          uuid: user.uuid,
          displayName: user.displayName,
          username: user.username,
          avatarUrl,
          cachedAt: user.cachedAt
        }
      });
    },

    /**
     * @returns {Promise<CachedWorkspaces | null>}
     */
    async getCachedWorkspaces() {
      const data = await area.get([STORAGE_KEYS.CACHED_WORKSPACES]);
      const raw = data[STORAGE_KEYS.CACHED_WORKSPACES];
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      const entry = /** @type {Record<string, unknown>} */ (raw);
      if (!Array.isArray(entry.items) || typeof entry.cachedAt !== 'number') {
        return null;
      }
      return {
        items: entry.items.filter(
          (w) => w && typeof w === 'object' && typeof w.slug === 'string' && typeof w.name === 'string'
        ),
        cachedAt: entry.cachedAt
      };
    },

    /**
     * @param {CachedWorkspaces} workspaces
     * @returns {Promise<void>}
     */
    async setCachedWorkspaces(workspaces) {
      await area.set({ [STORAGE_KEYS.CACHED_WORKSPACES]: workspaces });
    },

    /**
     * @param {string} workspace
     * @returns {Promise<CachedReposEntry | null>}
     */
    async getCachedRepos(workspace) {
      const data = await area.get([STORAGE_KEYS.CACHED_REPOS]);
      const all = data[STORAGE_KEYS.CACHED_REPOS];
      if (!all || typeof all !== 'object') {
        return null;
      }
      const entry = /** @type {Record<string, unknown>} */ (all)[workspace];
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const typed = /** @type {Record<string, unknown>} */ (entry);
      if (!Array.isArray(typed.items) || typeof typed.cachedAt !== 'number') {
        return null;
      }
      return {
        items: typed.items.filter(
          (r) => r && typeof r === 'object' && typeof r.slug === 'string' && typeof r.fullName === 'string'
        ),
        cachedAt: typed.cachedAt
      };
    },

    /**
     * @param {string} workspace
     * @param {CachedReposEntry} repos
     * @returns {Promise<void>}
     */
    async setCachedRepos(workspace, repos) {
      const data = await area.get([STORAGE_KEYS.CACHED_REPOS]);
      const current = data[STORAGE_KEYS.CACHED_REPOS];
      const map = current && typeof current === 'object' ? { .../** @type {Record<string, unknown>} */ (current) } : {};
      map[workspace] = repos;
      await area.set({ [STORAGE_KEYS.CACHED_REPOS]: map });
    },

    /**
     * Read cached commit build statuses keyed by `${repoFullName}:${commitHash}` (or `${commitHash}`).
     *
     * @returns {Promise<BuildStatusCacheMap>}
     */
    async getCachedBuildStatuses() {
      const data = await area.get([STORAGE_KEYS.CACHED_BUILD_STATUSES]);
      const raw = data[STORAGE_KEYS.CACHED_BUILD_STATUSES];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
      }
      /** @type {BuildStatusCacheMap} */
      const cleaned = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (
          (e.state !== 'SUCCESSFUL' && e.state !== 'FAILED' && e.state !== 'INPROGRESS' && e.state !== 'STOPPED') ||
          typeof e.cachedAt !== 'number'
        ) {
          continue;
        }
        cleaned[key] = {
          state: e.state,
          totalCount: typeof e.totalCount === 'number' ? e.totalCount : 0,
          passedCount: typeof e.passedCount === 'number' ? e.passedCount : 0,
          failedCount: typeof e.failedCount === 'number' ? e.failedCount : 0,
          inProgressCount: typeof e.inProgressCount === 'number' ? e.inProgressCount : 0,
          stoppedCount: typeof e.stoppedCount === 'number' ? e.stoppedCount : 0,
          url: sanitizeHttpsUrl(e.url),
          name: typeof e.name === 'string' ? e.name : '',
          updatedOn: typeof e.updatedOn === 'string' ? e.updatedOn : '',
          commitHash: typeof e.commitHash === 'string' ? e.commitHash : '',
          cachedAt: e.cachedAt
        };
      }
      return cleaned;
    },

    /**
     * Persist build status cache map, sanitizing URLs and pruning oldest entries past `maxBuildStatusCacheEntries`.
     *
     * @param {BuildStatusCacheMap} map
     * @returns {Promise<void>}
     */
    async setCachedBuildStatuses(map) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        await area.set({ [STORAGE_KEYS.CACHED_BUILD_STATUSES]: {} });
        return;
      }
      /** @type {Array<[string, BuildStatusSummary]>} */
      const validEntries = [];
      for (const [key, entry] of Object.entries(map)) {
        if (!key || !entry || typeof entry !== 'object') {
          continue;
        }
        if (
          (entry.state !== 'SUCCESSFUL' &&
            entry.state !== 'FAILED' &&
            entry.state !== 'INPROGRESS' &&
            entry.state !== 'STOPPED') ||
          typeof entry.cachedAt !== 'number'
        ) {
          continue;
        }
        validEntries.push([
          key,
          {
            state: entry.state,
            totalCount: typeof entry.totalCount === 'number' ? entry.totalCount : 0,
            passedCount: typeof entry.passedCount === 'number' ? entry.passedCount : 0,
            failedCount: typeof entry.failedCount === 'number' ? entry.failedCount : 0,
            inProgressCount: typeof entry.inProgressCount === 'number' ? entry.inProgressCount : 0,
            stoppedCount: typeof entry.stoppedCount === 'number' ? entry.stoppedCount : 0,
            url: sanitizeHttpsUrl(entry.url),
            name: typeof entry.name === 'string' ? entry.name : '',
            updatedOn: typeof entry.updatedOn === 'string' ? entry.updatedOn : '',
            commitHash: typeof entry.commitHash === 'string' ? entry.commitHash : '',
            cachedAt: entry.cachedAt
          }
        ]);
      }

      const maxEntries = THROTTLE_CONFIG.maxBuildStatusCacheEntries;
      if (validEntries.length > maxEntries) {
        validEntries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
        validEntries.length = maxEntries;
      }

      /** @type {BuildStatusCacheMap} */
      const bounded = {};
      for (const [key, value] of validEntries) {
        bounded[key] = value;
      }
      await area.set({ [STORAGE_KEYS.CACHED_BUILD_STATUSES]: bounded });
    },

    /**
     * @returns {Promise<PrSnapshot>}
     */
    async getPrSnapshot() {
      const data = await area.get([
        STORAGE_KEYS.PR_LIST,
        STORAGE_KEYS.LAST_UPDATED,
        STORAGE_KEYS.ERROR,
        STORAGE_KEYS.RATE_LIMIT_WARNING,
        STORAGE_KEYS.SYNCED_WORKSPACES
      ]);

      const rawPrList = data[STORAGE_KEYS.PR_LIST];
      const rawLastUpdated = data[STORAGE_KEYS.LAST_UPDATED];
      const rawError = data[STORAGE_KEYS.ERROR];
      const rawRateLimitWarning = data[STORAGE_KEYS.RATE_LIMIT_WARNING];
      const rawSyncedWorkspaces = data[STORAGE_KEYS.SYNCED_WORKSPACES];

      return {
        prList: Array.isArray(rawPrList)
          ? /** @type {PullRequestRecord[]} */ (rawPrList)
          : [],
        lastUpdated: typeof rawLastUpdated === 'number' ? rawLastUpdated : null,
        error: typeof rawError === 'string' ? rawError : null,
        rateLimitWarning: Boolean(rawRateLimitWarning),
        syncedWorkspaces: sanitizeStringList(rawSyncedWorkspaces)
      };
    },

    /**
     * @param {Partial<PrSnapshot>} snapshot
     * @returns {Promise<void>}
     */
    async savePrSnapshot(snapshot) {
      /** @type {Record<string, unknown>} */
      const patch = {};
      if (snapshot.prList !== undefined) {
        patch[STORAGE_KEYS.PR_LIST] = snapshot.prList;
      }
      if (snapshot.lastUpdated !== undefined) {
        patch[STORAGE_KEYS.LAST_UPDATED] = snapshot.lastUpdated;
      }
      if (snapshot.error !== undefined) {
        patch[STORAGE_KEYS.ERROR] = snapshot.error;
      }
      if (snapshot.rateLimitWarning !== undefined) {
        patch[STORAGE_KEYS.RATE_LIMIT_WARNING] = snapshot.rateLimitWarning;
      }
      if (snapshot.syncedWorkspaces !== undefined) {
        patch[STORAGE_KEYS.SYNCED_WORKSPACES] = snapshot.syncedWorkspaces;
      }
      await area.set(patch);
    },

    /**
     * @returns {Promise<SyncState>}
     */
    async getSyncState() {
      const data = await area.get([STORAGE_KEYS.SYNC_STATE]);
      const raw = data[STORAGE_KEYS.SYNC_STATE];
      if (!raw || typeof raw !== 'object') {
        return {
          inFlightSince: null,
          lastManualSyncAt: null,
          backoffUntil: null,
          consecutiveFailures: 0
        };
      }
      const s = /** @type {Record<string, unknown>} */ (raw);
      return {
        inFlightSince: typeof s.inFlightSince === 'number' ? s.inFlightSince : null,
        lastManualSyncAt: typeof s.lastManualSyncAt === 'number' ? s.lastManualSyncAt : null,
        backoffUntil: typeof s.backoffUntil === 'number' ? s.backoffUntil : null,
        consecutiveFailures: typeof s.consecutiveFailures === 'number' && s.consecutiveFailures >= 0
          ? s.consecutiveFailures
          : 0
      };
    },

    /**
     * @param {Partial<SyncState>} state
     * @returns {Promise<SyncState>}
     */
    async saveSyncState(state) {
      const current = await this.getSyncState();
      const next = {
        inFlightSince: state.inFlightSince !== undefined ? state.inFlightSince : current.inFlightSince,
        lastManualSyncAt: state.lastManualSyncAt !== undefined ? state.lastManualSyncAt : current.lastManualSyncAt,
        backoffUntil: state.backoffUntil !== undefined ? state.backoffUntil : current.backoffUntil,
        consecutiveFailures: state.consecutiveFailures !== undefined
          ? state.consecutiveFailures
          : current.consecutiveFailures
      };
      await area.set({ [STORAGE_KEYS.SYNC_STATE]: next });
      return next;
    },

    /**
     * @returns {Promise<SnoozedMap>}
     */
    async getSnoozedMap() {
      const data = await area.get([STORAGE_KEYS.SNOOZED_PRS]);
      const raw = data[STORAGE_KEYS.SNOOZED_PRS];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
      }
      /** @type {SnoozedMap} */
      const cleaned = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.until === 'number' &&
          typeof entry.prUpdatedOn === 'string'
        ) {
          cleaned[key] = {
            until: entry.until,
            prUpdatedOn: entry.prUpdatedOn,
            ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {})
          };
        }
      }
      return cleaned;
    },

    /**
     * @param {SnoozedMap} map
     * @returns {Promise<void>}
     */
    async saveSnoozedMap(map) {
      await area.set({ [STORAGE_KEYS.SNOOZED_PRS]: map });
    },

    /**
     * @returns {Promise<ProductFeedbackState>}
     */
    async getProductFeedback() {
      const data = await area.get([
        STORAGE_KEYS.REQUESTED_PRODUCTS,
        STORAGE_KEYS.PRODUCT_FEEDBACK,
        STORAGE_KEYS.PRODUCT_FEEDBACK_TIMESTAMP
      ]);

      const rawRequested = data[STORAGE_KEYS.REQUESTED_PRODUCTS];
      const rawFeedback = data[STORAGE_KEYS.PRODUCT_FEEDBACK];
      const rawTimestamp = data[STORAGE_KEYS.PRODUCT_FEEDBACK_TIMESTAMP];

      return {
        requestedProducts: sanitizeStringList(rawRequested),
        productFeedback: typeof rawFeedback === 'string' ? rawFeedback : '',
        productFeedbackTimestamp: typeof rawTimestamp === 'number' ? rawTimestamp : null
      };
    },

    /**
     * @param {ProductFeedbackState} feedback
     * @returns {Promise<void>}
     */
    async saveProductFeedback(feedback) {
      await area.set({
        [STORAGE_KEYS.REQUESTED_PRODUCTS]: sanitizeStringList(feedback.requestedProducts),
        [STORAGE_KEYS.PRODUCT_FEEDBACK]: typeof feedback.productFeedback === 'string'
          ? feedback.productFeedback
          : '',
        [STORAGE_KEYS.PRODUCT_FEEDBACK_TIMESTAMP]: typeof feedback.productFeedbackTimestamp === 'number'
          ? feedback.productFeedbackTimestamp
          : Date.now()
      });
    },

    /**
     * Read and normalize persisted System One Decision Model config, falling back
     * cleanly to `DECISION_MODELS` defaults.
     *
     * @returns {Promise<DecisionConfig>}
     */
    async getDecisionConfig() {
      const data = await area.get([STORAGE_KEYS.DECISION_CONFIG]);
      const raw = data[STORAGE_KEYS.DECISION_CONFIG];
      const source = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? /** @type {Record<string, unknown>} */ (raw)
        : {};

      /** @type {DecisionProvider} */
      const provider = source.provider === 'jev' || source.provider === 'gemini' || source.provider === 'off'
        ? source.provider
        : DECISION_MODELS.DEFAULT_PROVIDER;

      const defaultBaseUrl = provider === 'gemini'
        ? DECISION_MODELS.GEMINI_DECISIONS_URL
        : provider === 'jev'
          ? DECISION_MODELS.JEV_API_BASE_URL
          : '';
      const rawBase = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
      const baseUrl = (rawBase ? sanitizeDecisionEndpointUrl(rawBase) : sanitizeDecisionEndpointUrl(defaultBaseUrl)) || '';

      const defaultModel = provider === 'gemini'
        ? DECISION_MODELS.GEMINI_DEFAULT_MODEL
        : provider === 'jev'
          ? DECISION_MODELS.JEV_DEFAULT_MODEL
          : '';
      const rawModel = typeof source.model === 'string' ? source.model.trim() : '';
      const model = rawModel || defaultModel;

      const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';

      return {
        provider,
        baseUrl,
        model,
        apiKey
      };
    },

    /**
     * Persist System One Decision Model configuration, validating provider and endpoint URL.
     *
     * @param {Partial<DecisionConfig>} config
     * @returns {Promise<DecisionConfig>}
     */
    async saveDecisionConfig(config) {
      const current = await this.getDecisionConfig();
      const source = config && typeof config === 'object' ? config : {};

      /** @type {DecisionProvider} */
      const provider = source.provider === 'jev' || source.provider === 'gemini' || source.provider === 'off'
        ? source.provider
        : current.provider;

      const providerDefaultBase = provider === 'gemini'
        ? DECISION_MODELS.GEMINI_DECISIONS_URL
        : provider === 'jev'
          ? DECISION_MODELS.JEV_API_BASE_URL
          : '';
      const rawBase = typeof source.baseUrl === 'string'
        ? source.baseUrl.trim()
        : (provider !== current.provider ? providerDefaultBase : current.baseUrl);
      const baseUrl = rawBase
        ? (sanitizeDecisionEndpointUrl(rawBase) || '')
        : (sanitizeDecisionEndpointUrl(providerDefaultBase) || '');

      const providerDefaultModel = provider === 'gemini'
        ? DECISION_MODELS.GEMINI_DEFAULT_MODEL
        : provider === 'jev'
          ? DECISION_MODELS.JEV_DEFAULT_MODEL
          : '';
      const rawModel = typeof source.model === 'string'
        ? source.model.trim()
        : (provider !== current.provider ? providerDefaultModel : current.model);
      const model = rawModel || providerDefaultModel;

      const apiKey = typeof source.apiKey === 'string'
        ? (source.apiKey.trim() || (provider === current.provider ? current.apiKey : ''))
        : current.apiKey;

      /** @type {DecisionConfig} */
      const next = {
        provider,
        baseUrl,
        model,
        apiKey
      };

      await area.set({ [STORAGE_KEYS.DECISION_CONFIG]: next });
      return next;
    },

    /**
     * Clear stored Decision Model config and cached decision triage results.
     *
     * @returns {Promise<void>}
     */
    async clearDecisionConfigAndCache() {
      await area.remove([
        STORAGE_KEYS.DECISION_CONFIG,
        STORAGE_KEYS.CACHED_DECISIONS
      ]);
    },

    /**
     * Read cached per-commit diffstats keyed by `${repoFullName}:${commitHash}`.
     *
     * @returns {Promise<DiffstatCacheMap>}
     */
    async getCachedDiffstats() {
      const data = await area.get([STORAGE_KEYS.CACHED_DIFFSTATS]);
      const raw = data[STORAGE_KEYS.CACHED_DIFFSTATS];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
      }

      /** @type {DiffstatCacheMap} */
      const cleaned = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!key || !entry || typeof entry !== 'object') {
          continue;
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (typeof e.cachedAt !== 'number' || !Array.isArray(e.files)) {
          continue;
        }
        /** @type {DiffstatFile[]} */
        const files = [];
        for (const f of e.files) {
          if (!f || typeof f !== 'object') {
            continue;
          }
          const fo = /** @type {Record<string, unknown>} */ (f);
          if (typeof fo.path !== 'string' || !fo.path) {
            continue;
          }
          files.push({
            path: fo.path,
            added: typeof fo.added === 'number' && Number.isFinite(fo.added) ? fo.added : 0,
            removed: typeof fo.removed === 'number' && Number.isFinite(fo.removed) ? fo.removed : 0,
            status: typeof fo.status === 'string' ? fo.status : 'modified'
          });
        }
        cleaned[key] = {
          commitHash: typeof e.commitHash === 'string' ? e.commitHash : '',
          filesChanged: typeof e.filesChanged === 'number' && Number.isFinite(e.filesChanged) ? e.filesChanged : files.length,
          linesAdded: typeof e.linesAdded === 'number' && Number.isFinite(e.linesAdded) ? e.linesAdded : 0,
          linesRemoved: typeof e.linesRemoved === 'number' && Number.isFinite(e.linesRemoved) ? e.linesRemoved : 0,
          files,
          cachedAt: e.cachedAt
        };
      }
      return cleaned;
    },

    /**
     * Persist diffstat cache map, pruning oldest entries past `THROTTLE_CONFIG.maxDiffstatCacheEntries` (LRU).
     *
     * @param {DiffstatCacheMap} map
     * @returns {Promise<void>}
     */
    async setCachedDiffstats(map) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        await area.set({ [STORAGE_KEYS.CACHED_DIFFSTATS]: {} });
        return;
      }

      /** @type {Array<[string, DiffstatSummary]>} */
      const validEntries = [];
      for (const [key, entry] of Object.entries(map)) {
        if (!key || !entry || typeof entry !== 'object') {
          continue;
        }
        if (typeof entry.cachedAt !== 'number' || !Array.isArray(entry.files)) {
          continue;
        }
        /** @type {DiffstatFile[]} */
        const files = entry.files
          .filter((f) => f && typeof f === 'object' && typeof f.path === 'string' && f.path)
          .map((f) => ({
            path: f.path,
            added: typeof f.added === 'number' && Number.isFinite(f.added) ? f.added : 0,
            removed: typeof f.removed === 'number' && Number.isFinite(f.removed) ? f.removed : 0,
            status: typeof f.status === 'string' ? f.status : 'modified'
          }));

        validEntries.push([
          key,
          {
            commitHash: typeof entry.commitHash === 'string' ? entry.commitHash : '',
            filesChanged: typeof entry.filesChanged === 'number' && Number.isFinite(entry.filesChanged)
              ? entry.filesChanged
              : files.length,
            linesAdded: typeof entry.linesAdded === 'number' && Number.isFinite(entry.linesAdded) ? entry.linesAdded : 0,
            linesRemoved: typeof entry.linesRemoved === 'number' && Number.isFinite(entry.linesRemoved) ? entry.linesRemoved : 0,
            files,
            cachedAt: entry.cachedAt
          }
        ]);
      }

      const maxEntries = THROTTLE_CONFIG.maxDiffstatCacheEntries;
      if (validEntries.length > maxEntries) {
        validEntries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
        validEntries.length = maxEntries;
      }

      /** @type {DiffstatCacheMap} */
      const bounded = {};
      for (const [key, value] of validEntries) {
        bounded[key] = value;
      }
      await area.set({ [STORAGE_KEYS.CACHED_DIFFSTATS]: bounded });
    },

    /**
     * Read cached System One decision triage results keyed by `${repoFullName}:${commitHash}:${questionSetVersion}`.
     *
     * @returns {Promise<DecisionCacheMap>}
     */
    async getCachedDecisions() {
      const data = await area.get([STORAGE_KEYS.CACHED_DECISIONS]);
      const raw = data[STORAGE_KEYS.CACHED_DECISIONS];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
      }

      /** @type {DecisionCacheMap} */
      const cleaned = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!key || !entry || typeof entry !== 'object') {
          continue;
        }
        const e = /** @type {Record<string, unknown>} */ (entry);
        if (
          (e.provider !== 'jev' && e.provider !== 'gemini') ||
          typeof e.cachedAt !== 'number' ||
          typeof e.questionSetVersion !== 'string'
        ) {
          continue;
        }
        /** @type {'quick' | 'medium' | 'deep' | null} */
        const effort = e.effort === 'quick' || e.effort === 'medium' || e.effort === 'deep'
          ? e.effort
          : null;
        /** @type {'hotfix' | 'high_risk' | null} */
        const alert = e.alert === 'hotfix' || e.alert === 'high_risk'
          ? e.alert
          : null;

        cleaned[key] = {
          commitHash: typeof e.commitHash === 'string' ? e.commitHash : '',
          questionSetVersion: e.questionSetVersion,
          provider: e.provider,
          model: typeof e.model === 'string' ? e.model : '',
          effort,
          effortConfidence: typeof e.effortConfidence === 'number' && Number.isFinite(e.effortConfidence)
            ? e.effortConfidence
            : 0,
          alert,
          alertConfidence: typeof e.alertConfidence === 'number' && Number.isFinite(e.alertConfidence)
            ? e.alertConfidence
            : 0,
          changeKind: typeof e.changeKind === 'string' ? e.changeKind : null,
          riskScore: typeof e.riskScore === 'number' && Number.isFinite(e.riskScore) ? e.riskScore : null,
          hasClearContext: typeof e.hasClearContext === 'boolean' ? e.hasClearContext : null,
          cachedAt: e.cachedAt
        };
      }
      return cleaned;
    },

    /**
     * Persist System One decision triage cache map, pruning oldest entries past
     * `THROTTLE_CONFIG.maxDecisionCacheEntries` (LRU).
     *
     * @param {DecisionCacheMap} map
     * @returns {Promise<void>}
     */
    async setCachedDecisions(map) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        await area.set({ [STORAGE_KEYS.CACHED_DECISIONS]: {} });
        return;
      }

      /** @type {Array<[string, DecisionTriageResult]>} */
      const validEntries = [];
      for (const [key, entry] of Object.entries(map)) {
        if (!key || !entry || typeof entry !== 'object') {
          continue;
        }
        if (
          (entry.provider !== 'jev' && entry.provider !== 'gemini') ||
          typeof entry.cachedAt !== 'number' ||
          typeof entry.questionSetVersion !== 'string'
        ) {
          continue;
        }
        /** @type {'quick' | 'medium' | 'deep' | null} */
        const effort = entry.effort === 'quick' || entry.effort === 'medium' || entry.effort === 'deep'
          ? entry.effort
          : null;
        /** @type {'hotfix' | 'high_risk' | null} */
        const alert = entry.alert === 'hotfix' || entry.alert === 'high_risk'
          ? entry.alert
          : null;

        validEntries.push([
          key,
          {
            commitHash: typeof entry.commitHash === 'string' ? entry.commitHash : '',
            questionSetVersion: entry.questionSetVersion,
            provider: entry.provider,
            model: typeof entry.model === 'string' ? entry.model : '',
            effort,
            effortConfidence: typeof entry.effortConfidence === 'number' && Number.isFinite(entry.effortConfidence)
              ? entry.effortConfidence
              : 0,
            alert,
            alertConfidence: typeof entry.alertConfidence === 'number' && Number.isFinite(entry.alertConfidence)
              ? entry.alertConfidence
              : 0,
            changeKind: typeof entry.changeKind === 'string' ? entry.changeKind : null,
            riskScore: typeof entry.riskScore === 'number' && Number.isFinite(entry.riskScore) ? entry.riskScore : null,
            hasClearContext: typeof entry.hasClearContext === 'boolean' ? entry.hasClearContext : null,
            cachedAt: entry.cachedAt
          }
        ]);
      }

      const maxEntries = THROTTLE_CONFIG.maxDecisionCacheEntries;
      if (validEntries.length > maxEntries) {
        validEntries.sort((a, b) => b[1].cachedAt - a[1].cachedAt);
        validEntries.length = maxEntries;
      }

      /** @type {DecisionCacheMap} */
      const bounded = {};
      for (const [key, value] of validEntries) {
        bounded[key] = value;
      }
      await area.set({ [STORAGE_KEYS.CACHED_DECISIONS]: bounded });
    }
  };
}
