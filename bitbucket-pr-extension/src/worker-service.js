import {
  CACHE_TTL_MS,
  DECISION_MODELS,
  DEFAULT_PREFERENCES,
  THROTTLE_CONFIG,
  getEffectiveGitHubApiBaseUrl,
  getEffectiveJiraBaseUrl,
  sanitizeDecisionEndpointUrl,
  sanitizeHttpsUrl
} from './config.js';
import { BitbucketApiError, createBitbucketClient } from './bitbucket-client.js';
import { createDecisionClient } from './decision-client.js';
import { GitHubApiError, createGitHubClient } from './github-client.js';
import { findNewlyActionablePrs } from './notifications.js';
import {
  computeCounts,
  enrichPullRequest,
  pruneExpiredSnoozes
} from './pr-triage.js';
import { createStorage, normalizeAuthType } from './storage.js';
import { checkSyncGate, computeBackoffMs, runWithConcurrency } from './throttler.js';

export const POLL_ALARM_NAME = 'pollPRs';
export const NOTIFICATION_URL_MAP_KEY = 'notificationPrUrlMap';
const MAX_NOTIFICATION_URL_ENTRIES = 100;

/**
 * @typedef {Object} BadgeParams
 * @property {boolean} isAuthenticated
 * @property {'action_required' | 'all_open' | 'off'} badgeMode
 * @property {import('./pr-triage.js').PrCounts} counts
 * @property {string | null} error
 * @property {number} cachedPrCount
 * @property {boolean} rateLimitWarning
 */

/**
 * @typedef {Object} ChromeApiLike
 * @property {{
 *   setBadgeText: (details: { text: string }) => Promise<void> | void,
 *   setBadgeBackgroundColor: (details: { color: string }) => Promise<void> | void
 * }} [action]
 * @property {{
 *   create: (name: string, alarmInfo: { periodInMinutes?: number, delayInMinutes?: number }) => Promise<void> | void,
 *   clear: (name: string) => Promise<boolean> | void
 * }} [alarms]
 * @property {{
 *   create: (notificationId: string, options: {
 *     type: 'basic',
 *     iconUrl: string,
 *     title: string,
 *     message: string,
 *     contextMessage?: string
 *   }) => Promise<string> | void,
 *   clear: (notificationId: string) => Promise<boolean> | void
 * }} [notifications]
 * @property {{
 *   create: (createProperties: { url: string }) => Promise<unknown> | void
 * }} [tabs]
 * @property {{
 *   getURL?: (path: string) => string
 * }} [runtime]
 * @property {{
 *   session?: import('./storage.js').StorageAreaLike,
 *   local?: import('./storage.js').StorageAreaLike
 * }} [storage]
 */

/**
 * @typedef {Object} SyncResponse
 * @property {boolean} ok
 * @property {boolean} [skipped]
 * @property {'in_flight' | 'cooldown' | 'backoff' | 'not_authenticated'} [reason]
 * @property {number} [retryInMs]
 * @property {import('./storage.js').PrSnapshot} [snapshot]
 * @property {import('./pr-triage.js').PrCounts} [counts]
 * @property {string} [error]
 * @property {boolean} [isAuthError]
 */

/**
 * Resolve the appropriate current-user UUID for a PR based on its provider.
 *
 * @param {import('./storage.js').PullRequestRecord} pr
 * @param {string} bitbucketUserUuid
 * @param {string} githubUserUuid
 * @returns {string}
 */
function resolveProviderUserUuid(pr, bitbucketUserUuid, githubUserUuid) {
  if (pr.provider === 'github' || (typeof pr.key === 'string' && pr.key.startsWith('gh:'))) {
    return githubUserUuid;
  }
  return bitbucketUserUuid;
}

/**
 * Build a shallow, deterministic array of enriched PRs from stored/raw PR records,
 * matching each PR with its provider's current user UUID.
 *
 * @param {readonly import('./storage.js').PullRequestRecord[]} prs
 * @param {string | { bitbucket?: string, github?: string }} userUuids
 * @param {import('./config.js').Preferences} preferences
 * @param {number} now
 * @returns {import('./pr-triage.js').EnrichedPullRequest[]}
 */
function enrichPrList(prs, userUuids, preferences, now) {
  const jiraBaseUrl = getEffectiveJiraBaseUrl(preferences);
  const staleThresholdHours = preferences.staleThresholdHours || DEFAULT_PREFERENCES.staleThresholdHours;
  const bitbucketUserUuid = typeof userUuids === 'string' ? userUuids : (userUuids?.bitbucket ?? '');
  const githubUserUuid = typeof userUuids === 'string' ? '' : (userUuids?.github ?? '');

  return prs.map((pr) =>
    enrichPullRequest(pr, resolveProviderUserUuid(pr, bitbucketUserUuid, githubUserUuid), {
      staleThresholdHours,
      jiraBaseUrl,
      now
    })
  );
}

/**
 * Check if two string lists differ as sets/ordered filters (ignoring whitespace/order differences).
 *
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
function stringListChanged(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) {
    return true;
  }
  for (const item of setA) {
    if (!setB.has(item)) {
      return true;
    }
  }
  return false;
}

/**
 * Compute desired badge text and background color from auth, preferences, counts, and error state.
 *
 * @param {BadgeParams} params
 * @returns {{ text: string, color: string | null }}
 */
export function computeBadgeState({
  isAuthenticated,
  badgeMode,
  counts,
  error,
  cachedPrCount,
  rateLimitWarning
}) {
  if (!isAuthenticated || badgeMode === 'off') {
    return { text: '', color: null };
  }

  if (error && cachedPrCount === 0) {
    return { text: '!', color: '#DE350B' };
  }

  if (badgeMode === 'all_open') {
    const text = counts.all > 0 ? String(counts.all) : '';
    return { text, color: text ? '#0052CC' : null };
  }

  const text = counts.actionRequired > 0 ? String(counts.actionRequired) : '';
  const color = text ? (rateLimitWarning ? '#FF991F' : '#0052CC') : null;
  return { text, color };
}

/**
 * Check whether a persisted `DecisionConfig` has a valid active provider and endpoint/key.
 *
 * @param {import('./storage.js').DecisionConfig | null | undefined} config
 * @returns {boolean}
 */
function isDecisionConfigReady(config) {
  if (!config || (config.provider !== 'jev' && config.provider !== 'gemini')) {
    return false;
  }
  const safeBase = sanitizeDecisionEndpointUrl(
    config.baseUrl || (config.provider === 'gemini' ? DECISION_MODELS.GEMINI_DECISIONS_URL : DECISION_MODELS.JEV_API_BASE_URL)
  );
  if (!safeBase) {
    return false;
  }
  if (config.provider === 'gemini' && !(typeof config.apiKey === 'string' && config.apiKey.trim())) {
    return false;
  }
  return true;
}

/**
 * Check whether a cached diffstat or decision triage entry is still within its 24h TTL.
 *
 * @param {{ cachedAt?: number } | null | undefined} entry
 * @param {number} ttlMs
 * @param {number} now
 * @returns {boolean}
 */
function isCommitCacheEntryFresh(entry, ttlMs, now) {
  if (!entry || typeof entry.cachedAt !== 'number') {
    return false;
  }
  const ageMs = Math.max(0, now - entry.cachedAt);
  return ageMs < ttlMs;
}

/**
 * Create the testable MV3 service worker orchestrator.
 *
 * @param {{
 *   storage?: ReturnType<typeof createStorage>,
 *   client?: ReturnType<typeof createBitbucketClient>,
 *   githubClient?: ReturnType<typeof createGitHubClient>,
 *   decisionClient?: ReturnType<typeof createDecisionClient>,
 *   chromeApi?: ChromeApiLike,
 *   notificationStore?: import('./storage.js').StorageAreaLike,
 *   nowFn?: () => number,
 *   randomFn?: () => number
 * }} [deps]
 */
export function createWorkerService(deps = {}) {
  const chromeApi = deps.chromeApi ?? (typeof chrome !== 'undefined' ? /** @type {ChromeApiLike} */ (/** @type {unknown} */ (chrome)) : {});
  const storage = deps.storage ?? createStorage(chromeApi.storage?.local);
  const nowFn = deps.nowFn ?? Date.now;
  const randomFn = deps.randomFn ?? Math.random;
  const client = deps.client ?? createBitbucketClient({ nowFn });
  const githubClient = deps.githubClient ?? createGitHubClient({ nowFn });
  const decisionClient = deps.decisionClient ?? createDecisionClient({ nowFn });
  const notificationStore = deps.notificationStore ?? chromeApi.storage?.session ?? chromeApi.storage?.local;

  /** @type {Map<string, string>} */
  const inMemoryNotificationUrls = new Map();

  /**
   * Persist notificationId -> safe HTTPS PR URL mapping (surviving MV3 worker sleep when storage is available).
   *
   * @param {string} notificationId
   * @param {string} safeUrl
   * @returns {Promise<void>}
   */
  async function saveNotificationUrl(notificationId, safeUrl) {
    inMemoryNotificationUrls.set(notificationId, safeUrl);
    if (inMemoryNotificationUrls.size > MAX_NOTIFICATION_URL_ENTRIES) {
      const oldestKey = inMemoryNotificationUrls.keys().next().value;
      if (oldestKey !== undefined) {
        inMemoryNotificationUrls.delete(oldestKey);
      }
    }

    if (notificationStore && typeof notificationStore.get === 'function' && typeof notificationStore.set === 'function') {
      try {
        const data = await notificationStore.get([NOTIFICATION_URL_MAP_KEY]);
        const existing = data[NOTIFICATION_URL_MAP_KEY];
        /** @type {Record<string, string>} */
        const nextMap = existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { .../** @type {Record<string, string>} */ (existing) }
          : {};
        nextMap[notificationId] = safeUrl;

        const keys = Object.keys(nextMap);
        if (keys.length > MAX_NOTIFICATION_URL_ENTRIES) {
          for (const keyToDrop of keys.slice(0, keys.length - MAX_NOTIFICATION_URL_ENTRIES)) {
            delete nextMap[keyToDrop];
          }
        }
        await notificationStore.set({ [NOTIFICATION_URL_MAP_KEY]: nextMap });
      } catch {
        // Fallback to in-memory map if session/local storage write fails
      }
    }
  }

  /**
   * Look up and remove a notification PR URL mapping.
   *
   * @param {string} notificationId
   * @returns {Promise<string | null>}
   */
  async function consumeNotificationUrl(notificationId) {
    let rawUrl = inMemoryNotificationUrls.get(notificationId) ?? null;
    inMemoryNotificationUrls.delete(notificationId);

    if (notificationStore && typeof notificationStore.get === 'function' && typeof notificationStore.set === 'function') {
      try {
        const data = await notificationStore.get([NOTIFICATION_URL_MAP_KEY]);
        const existing = data[NOTIFICATION_URL_MAP_KEY];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
          const mapCopy = { .../** @type {Record<string, unknown>} */ (existing) };
          if (!rawUrl && typeof mapCopy[notificationId] === 'string') {
            rawUrl = mapCopy[notificationId];
          }
          if (notificationId in mapCopy) {
            delete mapCopy[notificationId];
            await notificationStore.set({ [NOTIFICATION_URL_MAP_KEY]: mapCopy });
          }
        }
      } catch {
        // Ignore storage errors on click cleanup
      }
    }

    return sanitizeHttpsUrl(rawUrl);
  }

  /**
   * Update extension action badge safely from current snapshot, preferences, and counts.
   *
   * @param {{
   *   isAuthenticated: boolean,
   *   preferences: import('./config.js').Preferences,
   *   counts: import('./pr-triage.js').PrCounts,
   *   snapshot: import('./storage.js').PrSnapshot
   * }} state
   * @returns {Promise<void>}
   */
  async function updateBadge({ isAuthenticated, preferences, counts, snapshot }) {
    if (!chromeApi.action || typeof chromeApi.action.setBadgeText !== 'function') {
      return;
    }

    const { text, color } = computeBadgeState({
      isAuthenticated,
      badgeMode: preferences.badgeMode,
      counts,
      error: snapshot.error,
      cachedPrCount: snapshot.prList.length,
      rateLimitWarning: snapshot.rateLimitWarning
    });

    await chromeApi.action.setBadgeText({ text });
    if (color && typeof chromeApi.action.setBadgeBackgroundColor === 'function') {
      await chromeApi.action.setBadgeBackgroundColor({ color });
    }
  }

  /**
   * Ensure the background polling alarm matches `preferences.pollIntervalMinutes`.
   *
   * @param {import('./config.js').Preferences} [preferencesArg]
   * @returns {Promise<void>}
   */
  async function ensurePollingAlarm(preferencesArg) {
    if (!chromeApi.alarms) {
      return;
    }
    const preferences = preferencesArg ?? await storage.getPreferences();
    if (typeof chromeApi.alarms.clear === 'function') {
      await chromeApi.alarms.clear(POLL_ALARM_NAME);
    }
    if (preferences.pollIntervalMinutes > 0 && typeof chromeApi.alarms.create === 'function') {
      await chromeApi.alarms.create(POLL_ALARM_NAME, {
        periodInMinutes: preferences.pollIntervalMinutes
      });
    }
  }

  /**
   * Derive whether a persisted error string indicates an authentication or scope/permission issue.
   *
   * @param {string | null} errorMessage
   * @returns {boolean}
   */
  function deriveIsAuthError(errorMessage) {
    if (typeof errorMessage !== 'string' || !errorMessage) {
      return false;
    }
    return (
      /\b(401|403)\b/.test(errorMessage) ||
      /Authentication failed/i.test(errorMessage) ||
      /Access denied/i.test(errorMessage) ||
      /API token/i.test(errorMessage) ||
      /Personal Access Token/i.test(errorMessage) ||
      /account email is required/i.test(errorMessage)
    );
  }

  /**
   * Extract normalized API error metadata across `BitbucketApiError`, `GitHubApiError`, and plain Error objects.
   *
   * @param {unknown} err
   * @param {string} fallbackMessage
   * @returns {{ status: number | null, isRateLimited: boolean, isAuthError: boolean, isTransient: boolean, retryAfter: number | null, message: string }}
   */
  function extractApiErrorInfo(err, fallbackMessage) {
    const isKnownApiError = err instanceof BitbucketApiError || err instanceof GitHubApiError;
    const errObj = err && typeof err === 'object' ? /** @type {Record<string, unknown>} */ (err) : null;
    const status = isKnownApiError
      ? err.status
      : (errObj && typeof errObj.status === 'number' ? errObj.status : null);
    const code = isKnownApiError
      ? err.code
      : (errObj && typeof errObj.code === 'string' ? errObj.code : null);
    const isRateLimited = status === 429 || code === 'RATE_LIMITED';
    const isAuthError = isKnownApiError
      ? err.isAuthError
      : Boolean(errObj && errObj.isAuthError);
    const isTransient = isKnownApiError
      ? err.isTransient
      : Boolean(errObj && errObj.isTransient);
    const retryAfter = isKnownApiError
      ? err.retryAfter
      : (errObj && typeof errObj.retryAfter === 'number' ? errObj.retryAfter : null);
    const message = err instanceof Error && err.message ? err.message : fallbackMessage;

    return { status, isRateLimited, isAuthError, isTransient, retryAfter, message };
  }

  /**
   * Fire Chrome desktop notifications for PRs that newly entered "Your Turn".
   *
   * @param {readonly import('./pr-triage.js').EnrichedPullRequest[]} newlyActionable
   * @param {number} now
   * @returns {Promise<void>}
   */
  async function dispatchNotifications(newlyActionable, now) {
    if (!newlyActionable.length || !chromeApi.notifications || typeof chromeApi.notifications.create !== 'function') {
      return;
    }

    const iconUrl = typeof chromeApi.runtime?.getURL === 'function'
      ? chromeApi.runtime.getURL('icons/icon128.png')
      : 'icons/icon128.png';

    for (const pr of newlyActionable) {
      const safePrUrl = sanitizeHttpsUrl(pr.url);
      const notificationId = `pr:${pr.key}:${now}`;
      const actionLabel = pr.actionState === 'changes_requested'
        ? 'Changes requested on your PR'
        : pr.actionState === 'ci_failed'
          ? 'CI build failed on your PR'
          : pr.actionState === 'ready_to_merge'
            ? 'Approved and ready to merge'
            : 'Your review is requested';

      if (safePrUrl) {
        await saveNotificationUrl(notificationId, safePrUrl);
      }

      await chromeApi.notifications.create(notificationId, {
        type: 'basic',
        iconUrl,
        title: `${actionLabel}: ${pr.repoName}`,
        message: pr.title,
        contextMessage: `by ${pr.authorName}`
      });
    }
  }

  /**
   * Fetch upfront diffstats (respecting `nearLimit` and 24h commit cache) and run Feature #1
   * System One effort & risk evaluation for open PRs with a `sourceCommitHash`.
   * Any diffstat or decision error is isolated per-PR so PR sync never fails.
   *
   * @param {{
   *   prs: import('./storage.js').PullRequestRecord[],
   *   bbCreds: import('./storage.js').Credentials | null,
   *   ghCreds: import('./storage.js').GitHubCredentials | null,
   *   nearLimit: boolean,
   *   forceRefreshCache: boolean,
   *   now: number
   * }} params
   * @returns {Promise<void>}
   */
  async function enrichPrsWithDiffstatAndDecisions({
    prs,
    bbCreds,
    ghCreds,
    nearLimit,
    forceRefreshCache,
    now
  }) {
    if (!Array.isArray(prs) || prs.length === 0) {
      return;
    }

    const decisionConfig = await storage.getDecisionConfig();
    if (!isDecisionConfigReady(decisionConfig)) {
      return;
    }

    let cachedDiffstats = /** @type {import('./storage.js').DiffstatCacheMap} */ ({});
    let cachedDecisions = /** @type {import('./storage.js').DecisionCacheMap} */ ({});
    try {
      [cachedDiffstats, cachedDecisions] = await Promise.all([
        storage.getCachedDiffstats(),
        storage.getCachedDecisions()
      ]);
    } catch {
      cachedDiffstats = {};
      cachedDecisions = {};
    }

    const nextDiffstatCache = { ...cachedDiffstats };
    const nextDecisionCache = { ...cachedDecisions };
    let diffstatMutated = false;
    let decisionMutated = false;

    /**
     * @typedef {{
     *   pr: import('./storage.js').PullRequestRecord,
     *   diffstatKey: string,
     *   decisionKey: string,
     *   cachedDiffstat: import('./storage.js').DiffstatSummary | null
     * }} DecisionTask
     */

    /** @type {DecisionTask[]} */
    const uncachedTasks = [];
    const questionVersion = DECISION_MODELS.QUESTION_SET_VERSION;

    for (const pr of prs) {
      const commitHash = typeof pr.sourceCommitHash === 'string' ? pr.sourceCommitHash.trim() : '';
      if (!commitHash) {
        continue;
      }

      const repoPrefix = pr.repoFullName || pr.key || 'repo';
      const diffstatKey = `${repoPrefix}:${commitHash}`;
      const decisionKey = `${repoPrefix}:${commitHash}:${questionVersion}`;

      const cachedDiff = nextDiffstatCache[diffstatKey] ?? null;
      const diffFresh = !forceRefreshCache && isCommitCacheEntryFresh(cachedDiff, CACHE_TTL_MS.diffstat, now);
      if (diffFresh && cachedDiff) {
        pr.diffstat = cachedDiff;
      }

      const cachedDec = nextDecisionCache[decisionKey] ?? null;
      const decisionFresh = !forceRefreshCache &&
        cachedDec &&
        cachedDec.provider === decisionConfig.provider &&
        cachedDec.model === decisionConfig.model &&
        isCommitCacheEntryFresh(cachedDec, CACHE_TTL_MS.decisionTriage, now);

      if (decisionFresh && cachedDec) {
        pr.aiTriage = cachedDec;
        continue;
      }

      uncachedTasks.push({
        pr,
        diffstatKey,
        decisionKey,
        cachedDiffstat: diffFresh && cachedDiff ? cachedDiff : (cachedDiff ?? null)
      });
    }

    if (uncachedTasks.length > 0) {
      const outcomes = await runWithConcurrency(
        uncachedTasks,
        THROTTLE_CONFIG.maxConcurrentRequests,
        async (task) => {
          let diffstat = task.pr.diffstat ?? task.cachedDiffstat ?? null;
          let fetchedDiffstat = false;

          if (!task.pr.diffstat && !nearLimit) {
            const isGh = task.pr.provider === 'github' ||
              (typeof task.pr.key === 'string' && task.pr.key.startsWith('gh:'));
            try {
              let fetched = null;
              if (isGh && ghCreds && typeof githubClient.fetchDiffstat === 'function') {
                fetched = await githubClient.fetchDiffstat(ghCreds, task.pr);
              } else if (!isGh && bbCreds && typeof client.fetchDiffstat === 'function') {
                fetched = await client.fetchDiffstat(bbCreds, task.pr);
              }
              if (fetched) {
                diffstat = fetched;
                fetchedDiffstat = true;
              }
            } catch {
              // Non-fatal: continue AI evaluation with title/branches/description only
            }
          }

          let triage = null;
          try {
            triage = await decisionClient.evaluateEffortAndRisk(decisionConfig, task.pr, diffstat);
          } catch {
            // Non-fatal: fall back to any stale cached triage entry
            triage = nextDecisionCache[task.decisionKey] ?? null;
            return {
              diffstat,
              fetchedDiffstat,
              triage,
              fetchedTriage: false
            };
          }

          return {
            diffstat,
            fetchedDiffstat,
            triage,
            fetchedTriage: Boolean(triage)
          };
        },
        { isolateErrors: true }
      );

      for (let i = 0; i < outcomes.length; i += 1) {
        const outcome = /** @type {{ status: 'fulfilled', value: { diffstat: import('./storage.js').DiffstatSummary | null, fetchedDiffstat: boolean, triage: import('./storage.js').DecisionTriageResult | null, fetchedTriage: boolean } } | { status: 'rejected', reason: unknown }} */ (
          /** @type {unknown} */ (outcomes[i])
        );
        const task = uncachedTasks[i];
        if (outcome.status !== 'fulfilled') {
          continue;
        }
        const { diffstat, fetchedDiffstat, triage, fetchedTriage } = outcome.value;
        if (diffstat) {
          task.pr.diffstat = diffstat;
          if (fetchedDiffstat) {
            nextDiffstatCache[task.diffstatKey] = diffstat;
            diffstatMutated = true;
          }
        }
        if (triage) {
          task.pr.aiTriage = triage;
          if (fetchedTriage) {
            nextDecisionCache[task.decisionKey] = triage;
            decisionMutated = true;
          }
        }
      }
    }

    const persistPromises = [];
    if (diffstatMutated) {
      persistPromises.push(storage.setCachedDiffstats(nextDiffstatCache).catch(() => {}));
    }
    if (decisionMutated) {
      persistPromises.push(storage.setCachedDecisions(nextDecisionCache).catch(() => {}));
    }
    if (persistPromises.length > 0) {
      await Promise.all(persistPromises);
    }
  }

  /**
   * Refresh the badge using current persisted storage state.
   *
   * @returns {Promise<{
   *   isAuthenticated: boolean,
   *   counts: import('./pr-triage.js').PrCounts,
   *   snapshot: import('./storage.js').PrSnapshot,
   *   preferences: import('./config.js').Preferences
   * }>}
   */
  async function refreshBadgeFromStorage() {
    const now = nowFn();
    const [bbCreds, ghCreds, preferences, snapshot, cachedBbUser, cachedGhUser, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getSnoozedMap()
    ]);

    const enriched = enrichPrList(
      snapshot.prList,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      preferences,
      now
    );
    const counts = computeCounts(enriched, snoozedMap, now);
    const isAuthenticated = Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token));

    await updateBadge({ isAuthenticated, preferences, counts, snapshot });
    return { isAuthenticated, counts, snapshot, preferences };
  }

  /**
   * Execute a gated PR sync across connected providers (Bitbucket, GitHub, or both),
   * enforcing in-flight lock, cooldown, backoff, and stale-while-revalidate error isolation.
   *
   * @param {{ forceManual?: boolean, forceRefreshCache?: boolean, bypassCooldown?: boolean }} [options]
   * @returns {Promise<SyncResponse>}
   */
  async function syncNow(options = {}) {
    const forceManual = Boolean(options.forceManual);
    const forceRefreshCache = Boolean(options.forceRefreshCache);
    const bypassCooldown = Boolean(options.bypassCooldown);
    const now = nowFn();

    const [
      bbCreds,
      ghCreds,
      preferences,
      prevSnapshot,
      prevSyncState,
      prevCachedBbUser,
      prevCachedGhUser,
      prevSnoozedMap
    ] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getSyncState(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getSnoozedMap()
    ]);

    const bbAuthed = Boolean(bbCreds && bbCreds.token);
    const ghAuthed = Boolean(ghCreds && ghCreds.token);

    if (!bbAuthed && !ghAuthed) {
      await updateBadge({
        isAuthenticated: false,
        preferences,
        counts: { actionRequired: 0, reviewing: 0, authored: 0, all: 0, snoozed: 0 },
        snapshot: prevSnapshot
      });
      return {
        ok: true,
        skipped: true,
        reason: 'not_authenticated',
        snapshot: prevSnapshot,
        counts: computeCounts([], prevSnoozedMap, now)
      };
    }

    const gate = checkSyncGate(prevSyncState, { forceManual, bypassCooldown, now });
    if (!gate.allowed) {
      const prevEnriched = enrichPrList(
        prevSnapshot.prList,
        { bitbucket: prevCachedBbUser?.uuid ?? '', github: prevCachedGhUser?.uuid ?? '' },
        preferences,
        now
      );
      return {
        ok: true,
        skipped: true,
        reason: gate.reason,
        retryInMs: gate.retryInMs,
        snapshot: prevSnapshot,
        counts: computeCounts(prevEnriched, prevSnoozedMap, now)
      };
    }

    await storage.saveSyncState({
      inFlightSince: now,
      ...(forceManual && !bypassCooldown ? { lastManualSyncAt: now } : {})
    });

    try {
      const [bbSettled, ghSettled] = await Promise.all([
        bbAuthed
          ? client.fetchPullRequests({
            creds: /** @type {import('./storage.js').Credentials} */ (bbCreds),
            storage,
            preferences,
            forceRefreshCache
          }).then(
            (value) => ({ status: /** @type {const} */ ('fulfilled'), value }),
            (reason) => ({ status: /** @type {const} */ ('rejected'), reason })
          )
          : Promise.resolve(null),
        ghAuthed
          ? githubClient.fetchPullRequests({
            creds: /** @type {import('./storage.js').GitHubCredentials} */ (ghCreds),
            storage,
            preferences,
            forceRefreshCache
          }).then(
            (value) => ({ status: /** @type {const} */ ('fulfilled'), value }),
            (reason) => ({ status: /** @type {const} */ ('rejected'), reason })
          )
          : Promise.resolve(null)
      ]);

      const bbSucceeded = Boolean(bbSettled && bbSettled.status === 'fulfilled');
      const ghSucceeded = Boolean(ghSettled && ghSettled.status === 'fulfilled');
      const bbFailed = Boolean(bbSettled && bbSettled.status === 'rejected');
      const ghFailed = Boolean(ghSettled && ghSettled.status === 'rejected');

      // If every connected provider failed, delegate to the full error/backoff handler
      if (!bbSucceeded && !ghSucceeded) {
        const firstErr = (bbSettled && bbSettled.status === 'rejected' ? bbSettled.reason : null) ??
          (ghSettled && ghSettled.status === 'rejected' ? ghSettled.reason : null);
        throw firstErr ?? new Error('An unexpected error occurred while syncing pull requests.');
      }

      const finishedAt = nowFn();
      const bbUserUuid = bbSettled && bbSettled.status === 'fulfilled'
        ? bbSettled.value.user.uuid
        : (prevCachedBbUser?.uuid ?? '');
      const ghUserUuid = ghSettled && ghSettled.status === 'fulfilled'
        ? ghSettled.value.user.uuid
        : (prevCachedGhUser?.uuid ?? '');

      const previousEnriched = enrichPrList(
        prevSnapshot.prList,
        {
          bitbucket: prevCachedBbUser?.uuid ?? bbUserUuid,
          github: prevCachedGhUser?.uuid ?? ghUserUuid
        },
        preferences,
        finishedAt
      );

      // Build unified PR list: fresh results for succeeded providers; preserve cached PRs for a partially failed provider
      /** @type {import('./storage.js').PullRequestRecord[]} */
      const combinedRawPrs = [];

      if (bbSettled && bbSettled.status === 'fulfilled') {
        for (const pr of bbSettled.value.prs) {
          combinedRawPrs.push({ ...pr, provider: 'bitbucket' });
        }
      } else if (bbFailed) {
        for (const prevPr of prevSnapshot.prList) {
          if (prevPr.provider !== 'github' && !(typeof prevPr.key === 'string' && prevPr.key.startsWith('gh:'))) {
            combinedRawPrs.push(prevPr);
          }
        }
      }

      if (ghSettled && ghSettled.status === 'fulfilled') {
        for (const pr of ghSettled.value.prs) {
          combinedRawPrs.push({ ...pr, provider: 'github' });
        }
      } else if (ghFailed) {
        for (const prevPr of prevSnapshot.prList) {
          if (prevPr.provider === 'github' || (typeof prevPr.key === 'string' && prevPr.key.startsWith('gh:'))) {
            combinedRawPrs.push(prevPr);
          }
        }
      }

      // Surface non-blocking partial banner if one provider failed while the other succeeded
      let partialBannerError = null;
      let partialIsRateLimited = false;
      let partialIsAuthError = false;
      if (bbFailed && bbSettled && bbSettled.status === 'rejected') {
        const info = extractApiErrorInfo(bbSettled.reason, 'Bitbucket sync failed.');
        partialBannerError = `Bitbucket: ${info.message}`;
        partialIsRateLimited = info.isRateLimited;
        partialIsAuthError = info.isAuthError;
      } else if (ghFailed && ghSettled && ghSettled.status === 'rejected') {
        const info = extractApiErrorInfo(ghSettled.reason, 'GitHub sync failed.');
        partialBannerError = `GitHub: ${info.message}`;
        partialIsRateLimited = info.isRateLimited;
        partialIsAuthError = info.isAuthError;
      }

      const nearLimit = Boolean(
        (bbSettled && bbSettled.status === 'fulfilled' && bbSettled.value.nearLimit) ||
        (ghSettled && ghSettled.status === 'fulfilled' && ghSettled.value.nearLimit) ||
        partialIsRateLimited
      );

      await enrichPrsWithDiffstatAndDecisions({
        prs: combinedRawPrs,
        bbCreds,
        ghCreds,
        nearLimit,
        forceRefreshCache,
        now: finishedAt
      });

      const currentEnriched = enrichPrList(
        combinedRawPrs,
        { bitbucket: bbUserUuid, github: ghUserUuid },
        preferences,
        finishedAt
      );

      const prunedSnoozes = pruneExpiredSnoozes(prevSnoozedMap, currentEnriched, finishedAt);
      if (Object.keys(prunedSnoozes).length !== Object.keys(prevSnoozedMap).length) {
        await storage.saveSnoozedMap(prunedSnoozes);
      }

      if (preferences.notificationsEnabled) {
        const newlyActionable = findNewlyActionablePrs(
          previousEnriched,
          currentEnriched,
          prunedSnoozes,
          finishedAt
        );
        await dispatchNotifications(newlyActionable, finishedAt);
      }

      const syncedWorkspaces = bbSettled && bbSettled.status === 'fulfilled'
        ? bbSettled.value.workspaces.map((w) => w.slug)
        : (bbAuthed ? prevSnapshot.syncedWorkspaces : []);

      /** @type {import('./storage.js').PrSnapshot} */
      const nextSnapshot = {
        prList: currentEnriched,
        lastUpdated: finishedAt,
        error: partialBannerError,
        rateLimitWarning: nearLimit,
        syncedWorkspaces
      };

      await storage.savePrSnapshot(nextSnapshot);
      await storage.saveSyncState({
        inFlightSince: null,
        backoffUntil: null,
        consecutiveFailures: 0
      });

      const counts = computeCounts(currentEnriched, prunedSnoozes, finishedAt);
      await updateBadge({
        isAuthenticated: true,
        preferences,
        counts,
        snapshot: nextSnapshot
      });

      return {
        ok: true,
        snapshot: nextSnapshot,
        counts,
        ...(partialBannerError ? { error: partialBannerError, isAuthError: partialIsAuthError } : {})
      };
    } catch (err) {
      const failedAt = nowFn();
      const info = extractApiErrorInfo(err, 'An unexpected error occurred while syncing pull requests.');

      const nextFailures = prevSyncState.consecutiveFailures + 1;
      const retryAfterSeconds = info.retryAfter !== null ? Math.ceil(info.retryAfter / 1000) : null;
      const backoffMs = info.isTransient || retryAfterSeconds !== null
        ? computeBackoffMs(nextFailures, retryAfterSeconds, randomFn, failedAt)
        : null;

      await storage.saveSyncState({
        inFlightSince: null,
        consecutiveFailures: nextFailures,
        backoffUntil: backoffMs !== null ? failedAt + backoffMs : null
      });

      const nextRateLimitWarning = info.isRateLimited ? true : prevSnapshot.rateLimitWarning;

      // Preserve existing prList for stale-while-revalidate display
      /** @type {import('./storage.js').PrSnapshot} */
      const errorSnapshot = {
        prList: prevSnapshot.prList,
        lastUpdated: prevSnapshot.lastUpdated,
        error: info.message,
        rateLimitWarning: nextRateLimitWarning,
        syncedWorkspaces: prevSnapshot.syncedWorkspaces
      };
      await storage.savePrSnapshot({
        error: info.message,
        ...(info.isRateLimited ? { rateLimitWarning: true } : {})
      });

      const enrichedCached = enrichPrList(
        prevSnapshot.prList,
        { bitbucket: prevCachedBbUser?.uuid ?? '', github: prevCachedGhUser?.uuid ?? '' },
        preferences,
        failedAt
      );
      const counts = computeCounts(enrichedCached, prevSnoozedMap, failedAt);
      await updateBadge({
        isAuthenticated: true,
        preferences,
        counts,
        snapshot: errorSnapshot
      });

      return {
        ok: false,
        error: info.message,
        isAuthError: info.isAuthError,
        snapshot: errorSnapshot,
        counts
      };
    } finally {
      const latestState = await storage.getSyncState();
      if (latestState.inFlightSince !== null) {
        await storage.saveSyncState({ inFlightSince: null });
      }
    }
  }

  /**
   * Verify Bitbucket credentials without persisting them.
   *
   * @param {Partial<import('./storage.js').Credentials>} creds
   */
  async function testConnection(creds) {
    try {
      const result = await client.verifyCredentials(creds);
      return {
        ok: true,
        user: result.user,
        workspaces: result.workspaces,
        nearLimit: result.nearLimit
      };
    } catch (err) {
      const info = extractApiErrorInfo(err, 'Failed to verify Bitbucket credentials.');
      return {
        ok: false,
        error: info.message,
        isAuthError: info.isAuthError
      };
    }
  }

  /**
   * Verify, save Bitbucket credentials, cache verified profile/workspaces, and trigger immediate sync.
   *
   * @param {Partial<import('./storage.js').Credentials>} creds
   */
  async function saveCredentials(creds) {
    const prevCreds = await storage.getCredentials();
    const prevCachedUser = await storage.getCachedUser();

    let verification;
    try {
      verification = await client.verifyCredentials(creds);
    } catch (err) {
      const info = extractApiErrorInfo(err, 'Failed to verify Bitbucket credentials.');
      return {
        ok: false,
        error: info.message,
        isAuthError: info.isAuthError
      };
    }

    const userChanged = Boolean(
      (prevCachedUser && prevCachedUser.uuid !== verification.user.uuid) ||
      (prevCreds && (
        prevCreds.authType !== normalizeAuthType(creds.authType) ||
        prevCreds.username !== (typeof creds.username === 'string' ? creds.username.trim() : '')
      ))
    );

    if (userChanged) {
      await storage.clearCredentialsAndCache();
    }

    await storage.saveCredentials(creds);
    const now = nowFn();
    await storage.setCachedUser({
      ...verification.user,
      cachedAt: now
    });
    await storage.setCachedWorkspaces({
      items: verification.workspaces,
      cachedAt: now
    });
    await storage.saveSyncState({
      inFlightSince: null,
      backoffUntil: null,
      consecutiveFailures: 0,
      lastManualSyncAt: null
    });

    const syncRes = await syncNow({ forceManual: true, forceRefreshCache: false });
    if (!syncRes.ok) {
      return {
        ok: false,
        error: syncRes.error ?? 'Credentials verified, but initial PR sync failed.',
        isAuthError: Boolean(syncRes.isAuthError)
      };
    }

    return {
      ok: true,
      user: verification.user,
      workspaces: verification.workspaces,
      snapshot: syncRes.snapshot,
      counts: syncRes.counts
    };
  }

  /**
   * Sign out of Bitbucket: clears Bitbucket credentials & caches; preserves GitHub session if still connected.
   */
  async function signOut() {
    const [ghCreds, prevSnapshot] = await Promise.all([
      storage.getGitHubCredentials(),
      storage.getPrSnapshot()
    ]);

    await storage.clearCredentialsAndCache();

    if (ghCreds && ghCreds.token) {
      const remainingGhPrs = prevSnapshot.prList.filter(
        (pr) => pr.provider === 'github' || (typeof pr.key === 'string' && pr.key.startsWith('gh:'))
      );
      await storage.savePrSnapshot({
        prList: remainingGhPrs,
        error: null,
        rateLimitWarning: false,
        syncedWorkspaces: []
      });
      await syncNow({ forceManual: true, bypassCooldown: true });
      return { ok: true };
    }

    if (chromeApi.action && typeof chromeApi.action.setBadgeText === 'function') {
      await chromeApi.action.setBadgeText({ text: '' });
    }
    return { ok: true };
  }

  /**
   * Verify GitHub PAT credentials without persisting them.
   *
   * @param {Partial<import('./storage.js').GitHubCredentials>} creds
   */
  async function testGitHubConnection(creds) {
    try {
      const result = await githubClient.verifyCredentials(creds);
      return {
        ok: true,
        user: result.user,
        nearLimit: result.nearLimit
      };
    } catch (err) {
      const info = extractApiErrorInfo(err, 'Failed to verify GitHub credentials.');
      return {
        ok: false,
        error: info.message,
        isAuthError: info.isAuthError
      };
    }
  }

  /**
   * Verify, cache GitHub user, save GitHub credentials, and trigger immediate sync.
   *
   * @param {Partial<import('./storage.js').GitHubCredentials>} creds
   */
  async function saveGitHubCredentials(creds) {
    const prevCachedGhUser = await storage.getCachedGitHubUser();

    let verification;
    try {
      verification = await githubClient.verifyCredentials(creds);
    } catch (err) {
      const info = extractApiErrorInfo(err, 'Failed to verify GitHub credentials.');
      return {
        ok: false,
        error: info.message,
        isAuthError: info.isAuthError
      };
    }

    if (prevCachedGhUser && prevCachedGhUser.uuid !== verification.user.uuid) {
      await storage.clearGitHubCredentialsAndCache();
    }

    const saved = await storage.saveGitHubCredentials(creds);
    const now = nowFn();
    await storage.setCachedGitHubUser({
      ...verification.user,
      cachedAt: now
    });
    await storage.saveSyncState({
      inFlightSince: null,
      backoffUntil: null,
      consecutiveFailures: 0,
      lastManualSyncAt: null
    });

    const syncRes = await syncNow({ forceManual: true, bypassCooldown: true });
    if (!syncRes.ok) {
      return {
        ok: false,
        error: syncRes.error ?? 'GitHub credentials verified, but initial PR sync failed.',
        isAuthError: Boolean(syncRes.isAuthError)
      };
    }

    return {
      ok: true,
      user: verification.user,
      apiBaseUrl: saved.apiBaseUrl,
      snapshot: syncRes.snapshot,
      counts: syncRes.counts
    };
  }

  /**
   * Sign out of GitHub: clears GitHub creds & cache, drops GitHub PRs from snapshot
   * (or re-syncs if Bitbucket is still connected), and updates badge.
   */
  async function signOutGitHub() {
    const [bbCreds, preferences, prevSnapshot, cachedBbUser, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getCachedUser(),
      storage.getSnoozedMap()
    ]);

    await storage.clearGitHubCredentialsAndCache();

    const remainingPrs = prevSnapshot.prList.filter(
      (pr) => pr.provider !== 'github' && !(typeof pr.key === 'string' && pr.key.startsWith('gh:'))
    );
    const now = nowFn();
    const enrichedRemaining = enrichPrList(
      remainingPrs,
      { bitbucket: cachedBbUser?.uuid ?? '', github: '' },
      preferences,
      now
    );

    const bbAuthed = Boolean(bbCreds && bbCreds.token);
    /** @type {import('./storage.js').PrSnapshot} */
    const nextSnapshot = {
      prList: bbAuthed ? enrichedRemaining : [],
      lastUpdated: bbAuthed ? prevSnapshot.lastUpdated : null,
      error: null,
      rateLimitWarning: bbAuthed ? prevSnapshot.rateLimitWarning : false,
      syncedWorkspaces: bbAuthed ? prevSnapshot.syncedWorkspaces : []
    };
    await storage.savePrSnapshot(nextSnapshot);

    const counts = computeCounts(bbAuthed ? enrichedRemaining : [], snoozedMap, now);
    await updateBadge({
      isAuthenticated: bbAuthed,
      preferences,
      counts,
      snapshot: nextSnapshot
    });

    if (bbAuthed) {
      await syncNow({ forceManual: true, bypassCooldown: true });
    }

    return { ok: true };
  }

  /**
   * Update preferences, re-enrich cached PRs, update alarm & badge, and sync if scope filters changed.
   *
   * @param {Partial<import('./config.js').Preferences>} partialPrefs
   */
  async function updatePreferences(partialPrefs) {
    const prevPrefs = await storage.getPreferences();
    const savedPrefs = await storage.savePreferences(partialPrefs);

    const scopeChanged =
      stringListChanged(prevPrefs.workspacesFilter, savedPrefs.workspacesFilter) ||
      stringListChanged(prevPrefs.reposFilter, savedPrefs.reposFilter);

    const now = nowFn();
    const [bbCreds, ghCreds, snapshot, cachedBbUser, cachedGhUser, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPrSnapshot(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getSnoozedMap()
    ]);

    const enrichedPrs = enrichPrList(
      snapshot.prList,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      savedPrefs,
      now
    );
    await storage.savePrSnapshot({ prList: enrichedPrs });

    const counts = computeCounts(enrichedPrs, snoozedMap, now);
    await ensurePollingAlarm(savedPrefs);
    const isAuthenticated = Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token));
    await updateBadge({
      isAuthenticated,
      preferences: savedPrefs,
      counts,
      snapshot: { ...snapshot, prList: enrichedPrs }
    });

    if (scopeChanged && bbCreds && bbCreds.token) {
      const syncResult = await syncNow({
        forceManual: true,
        forceRefreshCache: true,
        bypassCooldown: true
      });
      if (syncResult.ok && syncResult.counts) {
        return {
          ok: true,
          preferences: savedPrefs,
          counts: syncResult.counts,
          snapshot: syncResult.snapshot
        };
      }
      if (!syncResult.ok) {
        return {
          ok: true,
          preferences: savedPrefs,
          counts: syncResult.counts ?? counts,
          ...(syncResult.snapshot ? { snapshot: syncResult.snapshot } : {}),
          syncError: syncResult.error ?? 'Failed to sync pull requests for updated scope.'
        };
      }
    }

    return {
      ok: true,
      preferences: savedPrefs,
      counts
    };
  }

  /**
   * Snooze a PR for `durationMs` and immediately recompute counts + badge.
   *
   * @param {{ prKey: string, durationMs: number, prUpdatedOn?: string, reason?: string }} params
   */
  async function snoozePr({ prKey, durationMs, prUpdatedOn, reason }) {
    if (typeof prKey !== 'string' || !prKey.trim() || typeof durationMs !== 'number' || durationMs <= 0) {
      return { ok: false, error: 'Valid prKey and positive durationMs are required.' };
    }

    const now = nowFn();
    const [bbCreds, ghCreds, preferences, snapshot, cachedBbUser, cachedGhUser, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getSnoozedMap()
    ]);

    const matchingPr = snapshot.prList.find((pr) => pr.key === prKey);
    const effectiveUpdatedOn = typeof prUpdatedOn === 'string' && prUpdatedOn
      ? prUpdatedOn
      : (matchingPr?.updatedOn ?? '');

    /** @type {import('./storage.js').SnoozedMap} */
    const nextSnoozedMap = {
      ...snoozedMap,
      [prKey]: {
        until: now + durationMs,
        prUpdatedOn: effectiveUpdatedOn,
        ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {})
      }
    };

    await storage.saveSnoozedMap(nextSnoozedMap);

    const enriched = enrichPrList(
      snapshot.prList,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      preferences,
      now
    );
    const counts = computeCounts(enriched, nextSnoozedMap, now);
    await updateBadge({
      isAuthenticated: Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token)),
      preferences,
      counts,
      snapshot
    });

    return {
      ok: true,
      snoozedMap: nextSnoozedMap,
      counts
    };
  }

  /**
   * Remove a PR from the snooze map and immediately recompute counts + badge.
   *
   * @param {{ prKey: string }} params
   */
  async function unsnoozePr({ prKey }) {
    if (typeof prKey !== 'string' || !prKey.trim()) {
      return { ok: false, error: 'Valid prKey is required.' };
    }

    const now = nowFn();
    const [bbCreds, ghCreds, preferences, snapshot, cachedBbUser, cachedGhUser, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getSnoozedMap()
    ]);

    const nextSnoozedMap = { ...snoozedMap };
    delete nextSnoozedMap[prKey];
    await storage.saveSnoozedMap(nextSnoozedMap);

    const enriched = enrichPrList(
      snapshot.prList,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      preferences,
      now
    );
    const counts = computeCounts(enriched, nextSnoozedMap, now);
    await updateBadge({
      isAuthenticated: Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token)),
      preferences,
      counts,
      snapshot
    });

    return {
      ok: true,
      snoozedMap: nextSnoozedMap,
      counts
    };
  }

  /**
   * Verify a System One Decision Model configuration without persisting it.
   *
   * @param {Partial<import('./storage.js').DecisionConfig>} config
   */
  async function testDecisionModel(config) {
    try {
      const current = await storage.getDecisionConfig();
      const rawProvider = config?.provider === 'jev' || config?.provider === 'gemini' || config?.provider === 'off'
        ? config.provider
        : current.provider;
      const candidate = {
        provider: rawProvider,
        baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : current.baseUrl,
        model: typeof config?.model === 'string' ? config.model.trim() : current.model,
        apiKey: typeof config?.apiKey === 'string' && config.apiKey.trim()
          ? config.apiKey.trim()
          : (rawProvider === current.provider ? current.apiKey : '')
      };
      const result = await decisionClient.verifyConnection(candidate);
      return {
        ok: true,
        provider: result.provider,
        model: result.model
      };
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : 'Failed to verify Decision Model connection.';
      const isAuthError = Boolean(
        err && typeof err === 'object' && 'isAuthError' in err && /** @type {{ isAuthError?: unknown }} */ (err).isAuthError
      );
      return {
        ok: false,
        error: message,
        isAuthError
      };
    }
  }

  /**
   * Persist Decision Model configuration (preserving existing apiKey when omitted/blank for same provider)
   * and trigger an immediate sync so cached/open PRs receive Feature #1 triage scores.
   *
   * @param {Partial<import('./storage.js').DecisionConfig>} config
   */
  async function saveDecisionConfig(config) {
    const raw = config && typeof config === 'object' ? config : {};
    if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim() && !sanitizeDecisionEndpointUrl(raw.baseUrl.trim())) {
      return {
        ok: false,
        error: 'Endpoint URL must be a valid https:// URL (or http:// for localhost / private LAN hosts).',
        isAuthError: false
      };
    }

    const current = await storage.getDecisionConfig();
    /** @type {import('./storage.js').DecisionProvider} */
    const nextProvider = raw.provider === 'jev' || raw.provider === 'gemini' || raw.provider === 'off'
      ? raw.provider
      : current.provider;
    const defaultBase = nextProvider === 'gemini'
      ? DECISION_MODELS.GEMINI_DECISIONS_URL
      : nextProvider === 'jev'
        ? DECISION_MODELS.JEV_API_BASE_URL
        : '';
    const nextBaseRaw = typeof raw.baseUrl === 'string'
      ? raw.baseUrl.trim()
      : (nextProvider !== current.provider ? defaultBase : current.baseUrl);
    const nextBaseUrl = (nextBaseRaw ? sanitizeDecisionEndpointUrl(nextBaseRaw) : sanitizeDecisionEndpointUrl(defaultBase)) || '';
    const defaultModel = nextProvider === 'gemini'
      ? DECISION_MODELS.GEMINI_DEFAULT_MODEL
      : nextProvider === 'jev'
        ? DECISION_MODELS.JEV_DEFAULT_MODEL
        : '';
    const nextModel = (typeof raw.model === 'string' ? raw.model.trim() : (nextProvider !== current.provider ? defaultModel : current.model)) || defaultModel;
    const nextApiKey = typeof raw.apiKey === 'string'
      ? (raw.apiKey.trim() || (nextProvider === current.provider ? current.apiKey : ''))
      : current.apiKey;

    /** @type {import('./storage.js').DecisionConfig} */
    const candidate = {
      provider: nextProvider,
      baseUrl: nextBaseUrl,
      model: nextModel,
      apiKey: nextApiKey
    };

    if (candidate.provider !== 'off') {
      const check = await testDecisionModel(candidate);
      if (!check.ok) {
        return check;
      }
    }

    const saved = await storage.saveDecisionConfig(candidate);

    const [bbCreds, ghCreds, snapshot] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getPrSnapshot()
    ]);

    const isAuthed = Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token));
    if (isAuthed) {
      const syncRes = await syncNow({ forceManual: true, bypassCooldown: true });
      return {
        ok: true,
        decision: {
          provider: saved.provider,
          baseUrl: saved.baseUrl,
          model: saved.model,
          isConfigured: isDecisionConfigReady(saved)
        },
        ...(syncRes.snapshot ? { snapshot: syncRes.snapshot } : {}),
        ...(syncRes.counts ? { counts: syncRes.counts } : {}),
        ...(!syncRes.ok && syncRes.error ? { syncError: syncRes.error } : {})
      };
    }

    return {
      ok: true,
      decision: {
        provider: saved.provider,
        baseUrl: saved.baseUrl,
        model: saved.model,
        isConfigured: isDecisionConfigReady(saved)
      },
      snapshot
    };
  }

  /**
   * Clear Decision Model configuration & cached triage scores, and strip `aiTriage` from stored snapshot.
   */
  async function clearDecisionConfig() {
    await storage.clearDecisionConfigAndCache();
    const [bbCreds, ghCreds, cachedBbUser, cachedGhUser, preferences, snapshot, snoozedMap] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getPreferences(),
      storage.getPrSnapshot(),
      storage.getSnoozedMap()
    ]);

    const clearedPrs = snapshot.prList.map((pr) => {
      const copy = { ...pr };
      delete copy.aiTriage;
      return copy;
    });
    const now = nowFn();
    const enrichedPrs = enrichPrList(
      clearedPrs,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      preferences,
      now
    );
    await storage.savePrSnapshot({ prList: enrichedPrs });
    const counts = computeCounts(enrichedPrs, snoozedMap, now);
    await updateBadge({
      isAuthenticated: Boolean((bbCreds && bbCreds.token) || (ghCreds && ghCreds.token)),
      preferences,
      counts,
      snapshot: { ...snapshot, prList: enrichedPrs }
    });

    const defaultConfig = await storage.getDecisionConfig();
    return {
      ok: true,
      decision: {
        provider: defaultConfig.provider,
        baseUrl: defaultConfig.baseUrl,
        model: defaultConfig.model,
        isConfigured: isDecisionConfigReady(defaultConfig)
      },
      snapshot: {
        ...snapshot,
        prList: enrichedPrs
      },
      counts
    };
  }

  /**
   * Return sanitized bootstrap state for the popup UI. NEVER exposes raw Bitbucket, GitHub, or Decision API keys.
   */
  async function getState() {
    const now = nowFn();
    const [
      bbCreds,
      ghCreds,
      cachedBbUser,
      cachedGhUser,
      cachedWorkspaces,
      snapshot,
      preferences,
      syncState,
      snoozedMap,
      productFeedback,
      decisionConfig
    ] = await Promise.all([
      storage.getCredentials(),
      storage.getGitHubCredentials(),
      storage.getCachedUser(),
      storage.getCachedGitHubUser(),
      storage.getCachedWorkspaces(),
      storage.getPrSnapshot(),
      storage.getPreferences(),
      storage.getSyncState(),
      storage.getSnoozedMap(),
      storage.getProductFeedback(),
      storage.getDecisionConfig()
    ]);

    const enrichedPrs = enrichPrList(
      snapshot.prList,
      { bitbucket: cachedBbUser?.uuid ?? '', github: cachedGhUser?.uuid ?? '' },
      preferences,
      now
    );
    const counts = computeCounts(enrichedPrs, snoozedMap, now);
    const isAuthError = deriveIsAuthError(snapshot.error);
    const bitbucketAuthenticated = Boolean(bbCreds && bbCreds.token);
    const githubAuthenticated = Boolean(ghCreds && ghCreds.token);

    return {
      isAuthenticated: bitbucketAuthenticated || githubAuthenticated,
      bitbucketAuthenticated,
      authType: bbCreds ? bbCreds.authType : 'api_token',
      username: bbCreds ? bbCreds.username : '',
      user: cachedBbUser,
      github: {
        isAuthenticated: githubAuthenticated,
        apiBaseUrl: ghCreds ? ghCreds.apiBaseUrl : getEffectiveGitHubApiBaseUrl(),
        user: cachedGhUser
      },
      decision: {
        provider: decisionConfig.provider,
        baseUrl: decisionConfig.baseUrl,
        model: decisionConfig.model,
        isConfigured: isDecisionConfigReady(decisionConfig)
      },
      workspaces: cachedWorkspaces ? cachedWorkspaces.items : [],
      isAuthError,
      snapshot: {
        ...snapshot,
        isAuthError,
        prList: enrichedPrs
      },
      preferences,
      syncState,
      snoozedMap,
      counts,
      productFeedback
    };
  }

  /**
   * Handle notification click: open validated HTTPS PR URL in a new tab and clear notification.
   *
   * @param {string} notificationId
   * @returns {Promise<boolean>}
   */
  async function handleNotificationClick(notificationId) {
    const safeUrl = await consumeNotificationUrl(notificationId);
    if (chromeApi.notifications && typeof chromeApi.notifications.clear === 'function') {
      await chromeApi.notifications.clear(notificationId);
    }
    if (safeUrl && chromeApi.tabs && typeof chromeApi.tabs.create === 'function') {
      await chromeApi.tabs.create({ url: safeUrl });
      return true;
    }
    return false;
  }

  /**
   * Handle `chrome.runtime.onMessage` requests keyed by `action`.
   *
   * @param {unknown} message
   * @returns {Promise<Record<string, unknown>>}
   */
  async function handleMessage(message) {
    const payload = message && typeof message === 'object'
      ? /** @type {Record<string, unknown>} */ (message)
      : {};
    const action = typeof payload.action === 'string' ? payload.action : '';

    switch (action) {
      case 'SYNC_NOW':
        return syncNow({
          forceManual: Boolean(payload.forceManual),
          forceRefreshCache: Boolean(payload.forceRefreshCache)
        });
      case 'TEST_CONNECTION':
        return testConnection(
          payload.creds && typeof payload.creds === 'object'
            ? /** @type {Partial<import('./storage.js').Credentials>} */ (payload.creds)
            : {}
        );
      case 'SAVE_CREDENTIALS':
        return saveCredentials(
          payload.creds && typeof payload.creds === 'object'
            ? /** @type {Partial<import('./storage.js').Credentials>} */ (payload.creds)
            : {}
        );
      case 'SIGN_OUT':
        return signOut();
      case 'TEST_GITHUB_CONNECTION':
        return testGitHubConnection(
          payload.creds && typeof payload.creds === 'object'
            ? /** @type {Partial<import('./storage.js').GitHubCredentials>} */ (payload.creds)
            : {}
        );
      case 'SAVE_GITHUB_CREDENTIALS':
        return saveGitHubCredentials(
          payload.creds && typeof payload.creds === 'object'
            ? /** @type {Partial<import('./storage.js').GitHubCredentials>} */ (payload.creds)
            : {}
        );
      case 'SIGN_OUT_GITHUB':
        return signOutGitHub();
      case 'TEST_DECISION_MODEL':
        return testDecisionModel(
          payload.config && typeof payload.config === 'object'
            ? /** @type {Partial<import('./storage.js').DecisionConfig>} */ (payload.config)
            : {}
        );
      case 'SAVE_DECISION_CONFIG':
        return saveDecisionConfig(
          payload.config && typeof payload.config === 'object'
            ? /** @type {Partial<import('./storage.js').DecisionConfig>} */ (payload.config)
            : {}
        );
      case 'CLEAR_DECISION_CONFIG':
        return clearDecisionConfig();
      case 'UPDATE_PREFERENCES':
        return updatePreferences(
          payload.preferences && typeof payload.preferences === 'object'
            ? /** @type {Partial<import('./config.js').Preferences>} */ (payload.preferences)
            : {}
        );
      case 'SNOOZE_PR':
        return snoozePr({
          prKey: typeof payload.prKey === 'string' ? payload.prKey : '',
          durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : 0,
          prUpdatedOn: typeof payload.prUpdatedOn === 'string' ? payload.prUpdatedOn : undefined,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined
        });
      case 'UNSNOOZE_PR':
        return unsnoozePr({
          prKey: typeof payload.prKey === 'string' ? payload.prKey : ''
        });
      case 'GET_STATE':
        return getState();
      default:
        return {
          ok: false,
          error: action ? `Unsupported message action: ${action}` : 'Message action is required.'
        };
    }
  }

  return {
    syncNow,
    testConnection,
    saveCredentials,
    signOut,
    testGitHubConnection,
    saveGitHubCredentials,
    signOutGitHub,
    testDecisionModel,
    saveDecisionConfig,
    clearDecisionConfig,
    updatePreferences,
    snoozePr,
    unsnoozePr,
    getState,
    updateBadge,
    ensurePollingAlarm,
    refreshBadgeFromStorage,
    handleNotificationClick,
    handleMessage
  };
}
