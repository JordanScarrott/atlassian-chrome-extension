import { DEFAULT_PREFERENCES, STORAGE_KEYS, sanitizeHttpsUrl } from './config.js';

/**
 * @typedef {'api_token' | 'bearer'} AuthType
 */

/**
 * @typedef {Object} Credentials
 * @property {AuthType} authType
 * @property {string} username
 * @property {string} token
 */

/**
 * @typedef {Object} CachedUser
 * @property {string} uuid
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
 * @property {string} key
 * @property {number} id
 * @property {string} title
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
        STORAGE_KEYS.PR_LIST,
        STORAGE_KEYS.LAST_UPDATED,
        STORAGE_KEYS.ERROR,
        STORAGE_KEYS.RATE_LIMIT_WARNING,
        STORAGE_KEYS.SYNCED_WORKSPACES,
        STORAGE_KEYS.SYNC_STATE
      ]);
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
    }
  };
}
