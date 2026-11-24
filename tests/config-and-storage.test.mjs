import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTH_SETUP_LINKS,
  CACHE_TTL_MS,
  CENTRAL_URLS,
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  THROTTLE_CONFIG,
  getEffectiveGitHubApiBaseUrl,
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
  assert.equal(CACHE_TTL_MS.buildStatusTerminal, 6 * 60 * 60 * 1000);
  assert.equal(CACHE_TTL_MS.buildStatusActive, 60 * 1000);

  assert.equal(THROTTLE_CONFIG.manualRefreshCooldownMs, 10_000);
  assert.equal(THROTTLE_CONFIG.syncLockTimeoutMs, 45_000);
  assert.equal(THROTTLE_CONFIG.requestTimeoutMs, 12_000);
  assert.equal(THROTTLE_CONFIG.maxConcurrentRequests, 4);
  assert.equal(THROTTLE_CONFIG.maxPagesPerEndpoint, 5);
  assert.equal(THROTTLE_CONFIG.maxReposPerWorkspace, 25);
  assert.equal(THROTTLE_CONFIG.maxBuildStatusCacheEntries, 200);
  assert.equal(THROTTLE_CONFIG.baseBackoffMs, 15_000);
  assert.equal(THROTTLE_CONFIG.maxBackoffMs, 15 * 60 * 1000);
  assert.equal(THROTTLE_CONFIG.nearLimitDelayMs, 1_500);
  assert.equal(STORAGE_KEYS.CACHED_BUILD_STATUSES, 'cachedBuildStatuses');

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
  await storage.setCachedBuildStatuses({
    'ws1/repo1:abc123': {
      state: 'SUCCESSFUL',
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      inProgressCount: 0,
      stoppedCount: 0,
      url: 'https://ci.example.com/1',
      name: 'CI',
      updatedOn: '2026-11-22T00:00:00Z',
      commitHash: 'abc123',
      cachedAt: 1000
    }
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
  assert.deepEqual(await storage.getCachedBuildStatuses(), {});
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

test('storage getCachedBuildStatuses and setCachedBuildStatuses sanitize URLs and prune oldest entries past maxBuildStatusCacheEntries', async () => {
  const area = createMemoryStorageArea();
  const storage = createStorage(area);

  /** @type {Record<string, any>} */
  const oversized = {};
  const total = THROTTLE_CONFIG.maxBuildStatusCacheEntries + 25;
  for (let i = 0; i < total; i += 1) {
    oversized[`acme/repo:commit-${i}`] = {
      state: 'SUCCESSFUL',
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      inProgressCount: 0,
      stoppedCount: 0,
      url: i === total - 1 ? 'javascript:alert(1)' : `https://ci.example.com/builds/${i}`,
      name: `Build ${i}`,
      updatedOn: '2026-11-23T00:00:00Z',
      commitHash: `commit-${i}`,
      cachedAt: 1_000 + i
    };
  }

  await storage.setCachedBuildStatuses(oversized);
  const loaded = await storage.getCachedBuildStatuses();
  const keys = Object.keys(loaded);

  assert.equal(keys.length, THROTTLE_CONFIG.maxBuildStatusCacheEntries);
  assert.equal(loaded['acme/repo:commit-0'], undefined);
  assert.equal(loaded['acme/repo:commit-24'], undefined);
  assert.ok(loaded['acme/repo:commit-25']);
  assert.equal(loaded[`acme/repo:commit-${total - 1}`]?.url, null);
  assert.equal(loaded['acme/repo:commit-50']?.url, 'https://ci.example.com/builds/50');
});

test('GitHub config constants, getEffectiveGitHubApiBaseUrl, groupByTicket, and storage GitHub helpers work cleanly', async () => {
  assert.equal(CENTRAL_URLS.GITHUB_API_BASE_URL, 'https://api.github.com');
  assert.equal(CENTRAL_URLS.GITHUB_WEB_BASE_URL, 'https://github.com');
  assert.equal(AUTH_SETUP_LINKS.githubTokens, 'https://github.com/settings/tokens');
  assert.equal(
    AUTH_SETUP_LINKS.githubFineGrainedDocs,
    'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
  );
  assert.deepEqual(AUTH_SETUP_LINKS.githubRequiredScopes, [
    'repo (or fine-grained Pull requests: Read + Commit statuses: Read)'
  ]);
  assert.equal(STORAGE_KEYS.GITHUB_TOKEN, 'githubToken');
  assert.equal(STORAGE_KEYS.GITHUB_API_BASE_URL, 'githubApiBaseUrl');
  assert.equal(STORAGE_KEYS.CACHED_GITHUB_USER, 'cachedGitHubUser');
  assert.equal(DEFAULT_PREFERENCES.groupByTicket, false);

  assert.equal(getEffectiveGitHubApiBaseUrl(), 'https://api.github.com');
  assert.equal(
    getEffectiveGitHubApiBaseUrl('https://github.company.com/api/v3///'),
    'https://github.company.com/api/v3'
  );
  assert.equal(getEffectiveGitHubApiBaseUrl('http://insecure.example.com'), 'https://api.github.com');

  const prefs = validatePreferences({ groupByTicket: true });
  assert.equal(prefs.groupByTicket, true);
  assert.equal(validatePreferences({ groupByTicket: 'yes' }).groupByTicket, false);

  const area = createMemoryStorageArea();
  const storage = createStorage(area);
  await storage.saveCredentials({ authType: 'bearer', username: '', token: 'bb-tok' });
  await storage.savePreferences({ groupByTicket: true });
  await storage.saveGitHubCredentials({
    token: '  ghp_tok  ',
    apiBaseUrl: 'https://github.corp.example.com/api/v3/'
  });
  await storage.setCachedGitHubUser({
    uuid: 'gh:7',
    accountId: '7',
    displayName: 'Octo',
    username: 'octo',
    avatarUrl: 'https://avatars.githubusercontent.com/u/7',
    cachedAt: 5000
  });

  assert.deepEqual(await storage.getGitHubCredentials(), {
    token: 'ghp_tok',
    apiBaseUrl: 'https://github.corp.example.com/api/v3'
  });
  assert.equal((await storage.getCachedGitHubUser())?.uuid, 'gh:7');

  // clearGitHubCredentialsAndCache removes GitHub state while preserving Bitbucket credentials and preferences
  await storage.clearGitHubCredentialsAndCache();
  assert.equal(await storage.getGitHubCredentials(), null);
  assert.equal(await storage.getCachedGitHubUser(), null);
  assert.equal((await storage.getCredentials())?.token, 'bb-tok');
  assert.equal((await storage.getPreferences()).groupByTicket, true);
});

test('DECISION_MODELS defaults, sanitizeDecisionEndpointUrl, and decision/diffstat storage caches work cleanly', async () => {
  const { DECISION_MODELS, sanitizeDecisionEndpointUrl } = await import('../bitbucket-pr-extension/src/config.js');

  assert.equal(DECISION_MODELS.DEFAULT_PROVIDER, 'off');
  assert.equal(DECISION_MODELS.JEV_DEFAULT_MODEL, 'clef-flash');
  assert.equal(DECISION_MODELS.GEMINI_DEFAULT_MODEL, 'gemini-decision-1');
  assert.equal(DECISION_MODELS.CONFIDENCE_THRESHOLD, 0.75);
  assert.equal(DECISION_MODELS.QUESTION_SET_VERSION, 'effort-risk-v1');
  assert.equal(DECISION_MODELS.JEV_MAX_QUESTIONS_PER_REQUEST, 16);
  assert.equal(DECISION_MODELS.GEMINI_MAX_QUESTIONS_PER_REQUEST, 1000);

  assert.equal(sanitizeDecisionEndpointUrl('https://clef.internal.example.com/'), 'https://clef.internal.example.com');
  assert.equal(sanitizeDecisionEndpointUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(sanitizeDecisionEndpointUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(sanitizeDecisionEndpointUrl('http://[::1]:8080'), 'http://[::1]:8080');
  assert.equal(sanitizeDecisionEndpointUrl('http://10.20.30.40:8000'), 'http://10.20.30.40:8000');
  assert.equal(sanitizeDecisionEndpointUrl('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
  assert.equal(sanitizeDecisionEndpointUrl('http://172.16.0.10:8080'), 'http://172.16.0.10:8080');
  assert.equal(sanitizeDecisionEndpointUrl('http://gpu-box.local:8080'), 'http://gpu-box.local:8080');
  assert.equal(sanitizeDecisionEndpointUrl('http://public.example.com'), null);
  assert.equal(sanitizeDecisionEndpointUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeDecisionEndpointUrl('data:text/plain,hi'), null);
  assert.equal(sanitizeDecisionEndpointUrl('https://user:pass@clef.example.com'), null);

  const area = createMemoryStorageArea();
  const storage = createStorage(area);

  const initialCfg = await storage.getDecisionConfig();
  assert.deepEqual(initialCfg, {
    provider: 'off',
    baseUrl: '',
    model: '',
    apiKey: ''
  });

  const savedJev = await storage.saveDecisionConfig({
    provider: 'jev',
    baseUrl: 'http://10.0.0.5:8080/',
    model: 'clef-flash',
    apiKey: 'secret-jev'
  });
  assert.deepEqual(savedJev, {
    provider: 'jev',
    baseUrl: 'http://10.0.0.5:8080',
    model: 'clef-flash',
    apiKey: 'secret-jev'
  });

  // LRU-bounded diffstat & decision caches (max 200)
  /** @type {Record<string, any>} */
  const diffstats = {};
  /** @type {Record<string, any>} */
  const decisions = {};
  for (let i = 0; i < 210; i += 1) {
    diffstats[`acme/r:sha-${i}`] = {
      commitHash: `sha-${i}`,
      filesChanged: 1,
      linesAdded: 5,
      linesRemoved: 1,
      files: [{ path: 'src/a.js', added: 5, removed: 1, status: 'modified' }],
      cachedAt: 1000 + i
    };
    decisions[`acme/r:sha-${i}:effort-risk-v1`] = {
      commitHash: `sha-${i}`,
      questionSetVersion: 'effort-risk-v1',
      provider: 'jev',
      model: 'clef-flash',
      effort: 'quick',
      effortConfidence: 0.9,
      alert: null,
      alertConfidence: 0,
      changeKind: 'bugfix',
      riskScore: 1.5,
      hasClearContext: true,
      cachedAt: 1000 + i
    };
  }
  await storage.setCachedDiffstats(diffstats);
  await storage.setCachedDecisions(decisions);
  assert.equal(Object.keys(await storage.getCachedDiffstats()).length, 200);
  assert.equal(Object.keys(await storage.getCachedDecisions()).length, 200);
  assert.equal((await storage.getCachedDiffstats())['acme/r:sha-0'], undefined);
  assert.ok((await storage.getCachedDecisions())['acme/r:sha-209:effort-risk-v1']);

  await storage.clearDecisionConfigAndCache();
  assert.equal((await storage.getDecisionConfig()).provider, 'off');
  assert.deepEqual(await storage.getCachedDecisions(), {});
});


