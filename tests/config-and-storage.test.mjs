import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_SETUP_LINKS,
  CACHE_TTL_MS,
  CENTRAL_URLS,
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  THROTTLE_CONFIG,
  getEffectiveJiraBaseUrl,
  sanitizeHttpsUrl
} from '../bitbucket-pr-extension/src/config.js';
import {
  createStorage,
  normalizeAuthType,
  validatePreferences
} from '../bitbucket-pr-extension/src/storage.js';

/**
 * Create an in-memory mock compatible with `chrome.storage.local`.
 * @param {Record<string, unknown>} [seed]
 */
function createMemoryStorageArea(seed = {}) {
  /** @type {Record<string, unknown>} */
  const store = { ...seed };
  return {
    store,
    async get(keys) {
      if (keys === null || keys === undefined) {
        return { ...store };
      }
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: store[keys] } : {};
      }
      if (Array.isArray(keys)) {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const k of keys) {
          if (k in store) {
            out[k] = store[k];
          }
        }
        return out;
      }
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, defVal] of Object.entries(keys)) {
        out[k] = k in store ? store[k] : defVal;
      }
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        delete store[k];
      }
    }
  };
}

test('config constants match Phase 2 specification', () => {
  assert.equal(CENTRAL_URLS.MEZZANINE_JIRA_URL, '');
  assert.equal(CENTRAL_URLS.CONFLUENCE_URL, '');
  assert.equal(CENTRAL_URLS.BITBUCKET_API_BASE_URL, 'https://api.bitbucket.org/2.0');
  assert.equal(CENTRAL_URLS.BITBUCKET_WEB_BASE_URL, 'https://bitbucket.org');

  assert.equal(
    AUTH_SETUP_LINKS.atlassianApiTokens,
    'https://id.atlassian.com/manage-profile/security/api-tokens'
  );
  assert.deepEqual(AUTH_SETUP_LINKS.requiredScopes, [
    'read:user:bitbucket',
    'read:workspace:bitbucket',
    'read:repository:bitbucket',
    'read:pullrequest:bitbucket'
  ]);

  assert.equal(CACHE_TTL_MS.userProfile, 24 * 60 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.workspaces, 60 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.repositories, 30 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.prStaleAfter, 5 * 60 * 1000);

  assert.equal(THROTTLE_CONFIG.manualRefreshCooldownMs, 10_000);
  assert.equal(THROTTLE_CONFIG.syncLockTimeoutMs, 45_000);
  assert.equal(THROTTLE_CONFIG.requestTimeoutMs, 12_000);
  assert.equal(THROTTLE_CONFIG.maxConcurrentRequests, 4);
  assert.equal(THROTTLE_CONFIG.maxPagesPerEndpoint, 5);
  assert.equal(THROTTLE_CONFIG.maxReposPerWorkspace, 25);
  assert.equal(THROTTLE_CONFIG.baseBackoffMs, 15_000);
  assert.equal(THROTTLE_CONFIG.maxBackoffMs, 15 * 60 * 1000);
  assert.equal(THROTTLE_CONFIG.nearLimitDelayMs, 1_500);

  assert.equal(DEFAULT_PREFERENCES.pollIntervalMinutes, 15);
  assert.equal(DEFAULT_PREFERENCES.badgeMode, 'action_required');
  assert.equal(DEFAULT_PREFERENCES.notificationsEnabled, false);
  assert.equal(DEFAULT_PREFERENCES.staleThresholdHours, 48);
  assert.equal(DEFAULT_PREFERENCES.defaultFilter, 'action_required');
  assert.equal(DEFAULT_PREFERENCES.compactMode, false);
});

test('sanitizeHttpsUrl accepts valid https URLs and rejects unsafe schemes or credentials', () => {
  assert.equal(
    sanitizeHttpsUrl('  https://mezzanine.jira.example.com/browse/ENG-1  '),
    'https://mezzanine.jira.example.com/browse/ENG-1'
  );
  assert.equal(sanitizeHttpsUrl('http://insecure.example.com'), null);
  assert.equal(sanitizeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeHttpsUrl('data:text/html,hi'), null);
  assert.equal(sanitizeHttpsUrl('https://user:pass@example.com'), null);
  assert.equal(sanitizeHttpsUrl('not a url'), null);
  assert.equal(sanitizeHttpsUrl(''), null);
  assert.equal(sanitizeHttpsUrl(null), null);
});

test('getEffectiveJiraBaseUrl normalizes override and strips trailing slashes', () => {
  assert.equal(getEffectiveJiraBaseUrl(DEFAULT_PREFERENCES), '');
  assert.equal(
    getEffectiveJiraBaseUrl({ jiraBaseUrlOverride: 'https://jira.mezzanine.internal///' }),
    'https://jira.mezzanine.internal'
  );
  assert.equal(
    getEffectiveJiraBaseUrl({ jiraBaseUrlOverride: 'https://example.com/jira/' }),
    'https://example.com/jira'
  );
  assert.equal(
    getEffectiveJiraBaseUrl({ jiraBaseUrlOverride: 'http://insecure.example.com' }),
    ''
  );
});

test('storage migrates legacy authType values transparently when reading credentials', async () => {
  const areaPat = createMemoryStorageArea({
    [STORAGE_KEYS.AUTH_TYPE]: 'pat',
    [STORAGE_KEYS.BITBUCKET_TOKEN]: '  secret-pat-token  '
  });
  const storagePat = createStorage(areaPat);
  const credsPat = await storagePat.getCredentials();
  assert.deepEqual(credsPat, {
    authType: 'bearer',
    username: '',
    token: 'secret-pat-token'
  });
  assert.equal(areaPat.store[STORAGE_KEYS.AUTH_TYPE], 'bearer');

  const areaAppPw = createMemoryStorageArea({
    [STORAGE_KEYS.AUTH_TYPE]: 'app_password',
    [STORAGE_KEYS.BITBUCKET_USERNAME]: ' user@example.com ',
    [STORAGE_KEYS.BITBUCKET_TOKEN]: ' scoped-api-token '
  });
  const storageAppPw = createStorage(areaAppPw);
  const credsAppPw = await storageAppPw.getCredentials();
  assert.deepEqual(credsAppPw, {
    authType: 'api_token',
    username: 'user@example.com',
    token: 'scoped-api-token'
  });
  assert.equal(areaAppPw.store[STORAGE_KEYS.AUTH_TYPE], 'api_token');

  assert.equal(normalizeAuthType('pat'), 'bearer');
  assert.equal(normalizeAuthType('app_password'), 'api_token');
  assert.equal(normalizeAuthType('unknown'), 'api_token');
});

test('storage clearCredentialsAndCache clears auth and caches while preserving preferences and feedback', async () => {
  const area = createMemoryStorageArea();
  const storage = createStorage(area);

  await storage.saveCredentials({
    authType: 'api_token',
    username: 'dev@example.com',
    token: 'tok-123'
  });
  await storage.savePreferences({
    pollIntervalMinutes: 15,
    badgeMode: 'all_open',
    notificationsEnabled: true,
    compactMode: true,
    jiraBaseUrlOverride: 'https://jira.corp.example.com/'
  });
  await storage.saveProductFeedback({
    requestedProducts: ['jira', 'confluence'],
    productFeedback: 'Keep Jira tab fast!',
    productFeedbackTimestamp: 1700000000000
  });
  await storage.setCachedUser({
    uuid: '{u1}',
    displayName: 'Dev',
    username: 'dev',
    avatarUrl: 'https://avatar.example.com/a.png',
    cachedAt: 1000
  });
  await storage.setCachedWorkspaces({
    items: [{ slug: 'ws1', name: 'Workspace 1' }],
    cachedAt: 1000
  });
  await storage.setCachedRepos('ws1', {
    items: [{ slug: 'repo1', fullName: 'ws1/repo1', updatedOn: '2026-11-22T00:00:00Z' }],
    cachedAt: 1000
  });
  await storage.savePrSnapshot({
    prList: [],
    lastUpdated: 2000,
    error: null,
    rateLimitWarning: true,
    syncedWorkspaces: ['ws1']
  });
  await storage.saveSyncState({ consecutiveFailures: 2, backoffUntil: 99999 });

  await storage.clearCredentialsAndCache();

  assert.equal(await storage.getCredentials(), null);
  assert.equal(await storage.getCachedUser(), null);
  assert.equal(await storage.getCachedWorkspaces(), null);
  assert.equal(await storage.getCachedRepos('ws1'), null);
  const snapshot = await storage.getPrSnapshot();
  assert.deepEqual(snapshot, {
    prList: [],
    lastUpdated: null,
    error: null,
    rateLimitWarning: false,
    syncedWorkspaces: []
  });
  const syncState = await storage.getSyncState();
  assert.equal(syncState.consecutiveFailures, 0);

  // Preferences and product feedback remain intact
  const prefs = await storage.getPreferences();
  assert.equal(prefs.pollIntervalMinutes, 15);
  assert.equal(prefs.badgeMode, 'all_open');
  assert.equal(prefs.notificationsEnabled, true);
  assert.equal(prefs.jiraBaseUrlOverride, 'https://jira.corp.example.com');

  const feedback = await storage.getProductFeedback();
  assert.deepEqual(feedback.requestedProducts, ['jira', 'confluence']);
  assert.equal(feedback.productFeedback, 'Keep Jira tab fast!');
});

test('validatePreferences rejects invalid values and falls back cleanly', () => {
  const validated = validatePreferences({
    pollIntervalMinutes: 999,
    badgeMode: 'invalid',
    staleThresholdHours: 12,
    defaultFilter: 'bogus',
    compactMode: true,
    workspacesFilter: [' ws1 ', 'ws1', 'ws2', ''],
    reposFilter: ['ws1/r1', 'ws1/r1'],
    jiraBaseUrlOverride: 'http://not-https.example.com'
  });

  assert.equal(validated.pollIntervalMinutes, DEFAULT_PREFERENCES.pollIntervalMinutes);
  assert.equal(validated.badgeMode, DEFAULT_PREFERENCES.badgeMode);
  assert.equal(validated.staleThresholdHours, DEFAULT_PREFERENCES.staleThresholdHours);
  assert.equal(validated.defaultFilter, DEFAULT_PREFERENCES.defaultFilter);
  assert.equal(validated.compactMode, true);
  assert.deepEqual(validated.workspacesFilter, ['ws1', 'ws2']);
  assert.deepEqual(validated.reposFilter, ['ws1/r1']);
  assert.equal(validated.jiraBaseUrlOverride, '');
});

test('storage handles snooze map and throws on missing storage area', async () => {
  assert.throws(() => createStorage(undefined), /storage area/i);

  const area = createMemoryStorageArea();
  const storage = createStorage(area);
  await storage.saveSnoozedMap({
    'ws/repo#1': { until: 50000, prUpdatedOn: '2026-11-22T10:00:00Z', reason: 'later' }
  });
  const map = await storage.getSnoozedMap();
  assert.deepEqual(map, {
    'ws/repo#1': { until: 50000, prUpdatedOn: '2026-11-22T10:00:00Z', reason: 'later' }
  });
});
