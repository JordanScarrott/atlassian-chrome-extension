import test from 'node:test';
import assert from 'node:assert/strict';

import { BitbucketApiError } from '../bitbucket-pr-extension/src/bitbucket-client.js';
import { THROTTLE_CONFIG } from '../bitbucket-pr-extension/src/config.js';
import { createStorage } from '../bitbucket-pr-extension/src/storage.js';
import {
  POLL_ALARM_NAME,
  createWorkerService
} from '../bitbucket-pr-extension/src/worker-service.js';

/**
 * Create an in-memory `chrome.storage.local` / `chrome.storage.session` mock.
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

/**
 * Create mock Chrome APIs tracking badge updates, alarms, notifications, and opened tabs.
 */
function createMockChromeApi() {
  const localArea = createMemoryStorageArea();
  const sessionArea = createMemoryStorageArea();
  const badgeHistory = [];
  const alarmCalls = [];
  const createdNotifications = [];
  const clearedNotifications = [];
  const openedTabs = [];

  return {
    localArea,
    sessionArea,
    badgeHistory,
    alarmCalls,
    createdNotifications,
    clearedNotifications,
    openedTabs,
    chromeApi: {
      storage: {
        local: localArea,
        session: sessionArea
      },
      runtime: {
        getURL: (p) => `chrome-extension://test-id/${p}`
      },
      action: {
        async setBadgeText(details) {
          badgeHistory.push({ type: 'text', text: details.text });
        },
        async setBadgeBackgroundColor(details) {
          badgeHistory.push({ type: 'color', color: details.color });
        }
      },
      alarms: {
        async clear(name) {
          alarmCalls.push({ op: 'clear', name });
          return true;
        },
        async create(name, alarmInfo) {
          alarmCalls.push({ op: 'create', name, alarmInfo });
        }
      },
      notifications: {
        async create(notificationId, options) {
          createdNotifications.push({ notificationId, options });
          return notificationId;
        },
        async clear(notificationId) {
          clearedNotifications.push(notificationId);
          return true;
        }
      },
      tabs: {
        async create(createProperties) {
          openedTabs.push(createProperties);
          return createProperties;
        }
      }
    }
  };
}

/**
 * Create a canonical PullRequestRecord fixture.
 * @param {Record<string, unknown>} [overrides]
 */
function makePr(overrides = {}) {
  return {
    key: 'acme/web#101',
    id: 101,
    title: 'MEZ-101 Fix login redirect',
    state: 'OPEN',
    url: 'https://bitbucket.org/acme/web/pull-requests/101',
    repoFullName: 'acme/web',
    repoName: 'web',
    workspace: 'acme',
    authorUuid: '{alice}',
    authorName: 'Alice',
    sourceBranch: 'fix/MEZ-101-login',
    destinationBranch: 'main',
    createdOn: '2026-11-22T08:00:00Z',
    updatedOn: '2026-11-22T10:00:00Z',
    commentCount: 1,
    taskCount: 0,
    draft: false,
    reviewers: [{ uuid: '{me}', displayName: 'Jordan' }],
    participants: [],
    ...overrides
  };
}

const SAMPLE_USER = {
  uuid: '{me}',
  displayName: 'Jordan Scarrott',
  username: 'jordan',
  avatarUrl: 'https://avatar.bitbucket.org/jordan.png',
  cachedAt: 1_000_000
};

const SAMPLE_WORKSPACES = [
  { slug: 'acme', name: 'Acme Corp' }
];

test('TEST_CONNECTION, SAVE_CREDENTIALS, GET_STATE (no token leak), and SIGN_OUT lifecycle', async () => {
  const now = 1_700_000_000_000;
  const mock = createMockChromeApi();
  const storage = createStorage(mock.localArea);

  let verifyCalls = 0;
  let fetchPrCalls = 0;

  const client = {
    async verifyCredentials(creds) {
      verifyCalls += 1;
      if (creds.token === 'bad-token') {
        throw new BitbucketApiError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication failed (401).',
          retryAfter: null,
          isTransient: false,
          isAuthError: true
        });
      }
      return {
        user: { ...SAMPLE_USER, cachedAt: now },
        workspaces: SAMPLE_WORKSPACES,
        nearLimit: false
      };
    },
    async fetchPullRequests() {
      fetchPrCalls += 1;
      return {
        prs: [makePr()],
        user: { ...SAMPLE_USER, cachedAt: now },
        workspaces: SAMPLE_WORKSPACES,
        nearLimit: false,
        partialErrors: []
      };
    }
  };

  const worker = createWorkerService({
    storage,
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now
  });

  // 1. TEST_CONNECTION failure + success
  const badTest = await worker.handleMessage({
    action: 'TEST_CONNECTION',
    creds: { authType: 'bearer', token: 'bad-token' }
  });
  assert.equal(badTest.ok, false);
  assert.equal(badTest.isAuthError, true);

  const goodTest = await worker.handleMessage({
    action: 'TEST_CONNECTION',
    creds: { authType: 'api_token', username: 'jordan@example.com', token: 'super-secret-token' }
  });
  assert.equal(goodTest.ok, true);
  assert.equal(goodTest.user.uuid, '{me}');
  assert.deepEqual(goodTest.workspaces, SAMPLE_WORKSPACES);

  // 2. SAVE_CREDENTIALS caches user + workspaces and immediately syncs PRs
  const saveRes = await worker.handleMessage({
    action: 'SAVE_CREDENTIALS',
    creds: { authType: 'api_token', username: 'jordan@example.com', token: 'super-secret-token' }
  });
  assert.equal(saveRes.ok, true);
  assert.equal(verifyCalls, 3);
  assert.equal(fetchPrCalls, 1);
  assert.equal(saveRes.counts.actionRequired, 1);

  const cachedUser = await storage.getCachedUser();
  const cachedWorkspaces = await storage.getCachedWorkspaces();
  assert.equal(cachedUser?.uuid, '{me}');
  assert.deepEqual(cachedWorkspaces?.items, SAMPLE_WORKSPACES);

  // 3. GET_STATE must NEVER expose raw token anywhere in serialized payload
  await storage.savePreferences({ pollIntervalMinutes: 15 });
  const state = await worker.handleMessage({ action: 'GET_STATE' });
  assert.equal(state.isAuthenticated, true);
  assert.equal(state.authType, 'api_token');
  assert.equal(state.username, 'jordan@example.com');
  assert.equal('token' in state, false);
  assert.equal(JSON.stringify(state).includes('super-secret-token'), false);
  assert.equal(state.counts.actionRequired, 1);

  // 4. SIGN_OUT clears credentials, cache, and badge while preserving preferences
  const signOutRes = await worker.handleMessage({ action: 'SIGN_OUT' });
  assert.equal(signOutRes.ok, true);
  assert.equal(await storage.getCredentials(), null);
  assert.equal(await storage.getCachedUser(), null);
  assert.deepEqual(mock.badgeHistory.at(-1), { type: 'text', text: '' });
  assert.equal((await storage.getPreferences()).pollIntervalMinutes, 15);
});

test('SYNC_NOW enforces in-flight deduplication, cooldown, transient backoff preserving stale cache, and auth errors', async () => {
  let now = 1_700_000_000_000;
  const mock = createMockChromeApi();
  const storage = createStorage(mock.localArea);

  await storage.saveCredentials({
    authType: 'bearer',
    username: '',
    token: 'valid-token'
  });
  await storage.setCachedUser(SAMPLE_USER);

  /** @type {(value: unknown) => void} */
  let releasePendingFetch = () => {};
  /** @type {() => void} */
  let notifyFetchEntered = () => {};
  const fetchEntered = new Promise((resolve) => {
    notifyFetchEntered = resolve;
  });
  let mode = 'hang';

  const client = {
    async verifyCredentials() {
      return { user: SAMPLE_USER, workspaces: SAMPLE_WORKSPACES, nearLimit: false };
    },
    async fetchPullRequests() {
      if (mode === 'hang') {
        return new Promise((resolve) => {
          releasePendingFetch = resolve;
          notifyFetchEntered();
        });
      }
      if (mode === 'transient_429') {
        throw new BitbucketApiError({
          status: 429,
          code: 'RATE_LIMITED',
          message: 'Bitbucket API rate limit reached (429).',
          retryAfter: 30_000,
          isTransient: true,
          isAuthError: false
        });
      }
      if (mode === 'auth_401') {
        throw new BitbucketApiError({
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Authentication failed (401).',
          retryAfter: null,
          isTransient: false,
          isAuthError: true
        });
      }
      return {
        prs: [makePr()],
        user: SAMPLE_USER,
        workspaces: SAMPLE_WORKSPACES,
        nearLimit: false,
        partialErrors: []
      };
    }
  };

  const worker = createWorkerService({
    storage,
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now,
    randomFn: () => 0.5
  });

  // 1. In-flight deduplication: second call while first is pending skips cleanly
  const firstPending = worker.syncNow({ forceManual: true });
  await fetchEntered;

  const secondDuringFlight = await worker.syncNow({ forceManual: true });
  assert.equal(secondDuringFlight.ok, true);
  assert.equal(secondDuringFlight.skipped, true);
  assert.equal(secondDuringFlight.reason, 'in_flight');

  // Complete first sync
  releasePendingFetch({
    prs: [makePr()],
    user: SAMPLE_USER,
    workspaces: SAMPLE_WORKSPACES,
    nearLimit: false,
    partialErrors: []
  });
  const firstResult = await firstPending;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.snapshot?.prList.length, 1);
  assert.equal((await storage.getSyncState()).inFlightSince, null);

  // 2. Manual refresh cooldown enforcement within 10s
  now += 2_000;
  const cooldownResult = await worker.syncNow({ forceManual: true });
  assert.equal(cooldownResult.ok, true);
  assert.equal(cooldownResult.skipped, true);
  assert.equal(cooldownResult.reason, 'cooldown');
  assert.equal(cooldownResult.retryInMs, THROTTLE_CONFIG.manualRefreshCooldownMs - 2_000);

  // 3. Transient error backoff preserves existing stale `prList`
  now += THROTTLE_CONFIG.manualRefreshCooldownMs;
  mode = 'transient_429';
  const failed429 = await worker.syncNow({ forceManual: false });
  assert.equal(failed429.ok, false);
  assert.equal(failed429.isAuthError, false);
  assert.equal(failed429.snapshot?.prList.length, 1);
  assert.match(failed429.snapshot?.error ?? '', /429/);

  const syncStateAfter429 = await storage.getSyncState();
  assert.equal(syncStateAfter429.inFlightSince, null);
  assert.equal(syncStateAfter429.consecutiveFailures, 1);
  assert.equal(syncStateAfter429.backoffUntil, now + 30_000);

  // Automatic poll during backoff is skipped
  now += 5_000;
  const skippedBackoff = await worker.syncNow({ forceManual: false });
  assert.equal(skippedBackoff.skipped, true);
  assert.equal(skippedBackoff.reason, 'backoff');
  assert.equal(skippedBackoff.retryInMs, 25_000);

  // Manual refresh bypasses backoff and handles auth error; when no cached PRs exist, badge shows '!'
  await storage.savePrSnapshot({ prList: [] });
  mode = 'auth_401';
  const authFail = await worker.syncNow({ forceManual: true });
  assert.equal(authFail.ok, false);
  assert.equal(authFail.isAuthError, true);
  assert.deepEqual(mock.badgeHistory.slice(-2), [
    { type: 'text', text: '!' },
    { type: 'color', color: '#DE350B' }
  ]);
});

test('Badge updates across all 3 badgeModes and rateLimitWarning, plus SNOOZE_PR / UNSNOOZE_PR', async () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const mock = createMockChromeApi();
  const storage = createStorage(mock.localArea);

  await storage.saveCredentials({ authType: 'bearer', username: '', token: 'tok' });
  await storage.setCachedUser(SAMPLE_USER);

  const actionPr = makePr({
    key: 'acme/web#1',
    id: 1,
    reviewers: [{ uuid: '{me}', displayName: 'Jordan' }],
    updatedOn: '2026-11-22T10:00:00Z'
  });
  const waitingPr = makePr({
    key: 'acme/web#2',
    id: 2,
    authorUuid: '{me}',
    authorName: 'Jordan',
    reviewers: [{ uuid: '{bob}', displayName: 'Bob' }],
    participants: [],
    updatedOn: '2026-11-22T11:00:00Z'
  });

  const nearLimit = true;
  const client = {
    async verifyCredentials() {
      return { user: SAMPLE_USER, workspaces: SAMPLE_WORKSPACES, nearLimit: false };
    },
    async fetchPullRequests() {
      return {
        prs: [actionPr, waitingPr],
        user: SAMPLE_USER,
        workspaces: SAMPLE_WORKSPACES,
        nearLimit,
        partialErrors: []
      };
    }
  };

  const worker = createWorkerService({
    storage,
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now
  });

  // 1. Default badgeMode ('action_required') with nearLimit=true -> '1' on #FF991F
  await worker.syncNow({ forceManual: true });
  assert.deepEqual(mock.badgeHistory.slice(-2), [
    { type: 'text', text: '1' },
    { type: 'color', color: '#FF991F' }
  ]);

  // 2. SNOOZE_PR updates badge immediately to '' (0 actionRequired)
  const snoozeRes = await worker.handleMessage({
    action: 'SNOOZE_PR',
    prKey: 'acme/web#1',
    durationMs: 3_600_000,
    prUpdatedOn: '2026-11-22T10:00:00Z'
  });
  assert.equal(snoozeRes.ok, true);
  assert.equal(snoozeRes.counts.actionRequired, 0);
  assert.equal(snoozeRes.counts.snoozed, 1);
  assert.deepEqual(mock.badgeHistory.at(-1), { type: 'text', text: '' });

  // 3. Switch badgeMode to 'all_open' via UPDATE_PREFERENCES -> shows 1 non-snoozed PR on #0052CC
  const prefAllOpen = await worker.handleMessage({
    action: 'UPDATE_PREFERENCES',
    preferences: { badgeMode: 'all_open', pollIntervalMinutes: 15 }
  });
  assert.equal(prefAllOpen.ok, true);
  assert.deepEqual(mock.badgeHistory.slice(-2), [
    { type: 'text', text: '1' },
    { type: 'color', color: '#0052CC' }
  ]);
  assert.deepEqual(mock.alarmCalls.slice(-2), [
    { op: 'clear', name: POLL_ALARM_NAME },
    { op: 'create', name: POLL_ALARM_NAME, alarmInfo: { periodInMinutes: 15 } }
  ]);

  // 4. UNSNOOZE_PR brings count up immediately to '2'
  const unsnoozeRes = await worker.handleMessage({
    action: 'UNSNOOZE_PR',
    prKey: 'acme/web#1'
  });
  assert.equal(unsnoozeRes.ok, true);
  assert.equal(unsnoozeRes.counts.all, 2);
  assert.deepEqual(mock.badgeHistory.slice(-2), [
    { type: 'text', text: '2' },
    { type: 'color', color: '#0052CC' }
  ]);

  // 5. Switch badgeMode to 'off' and pollIntervalMinutes to 0 -> clears badge and clears alarm without creating
  await worker.handleMessage({
    action: 'UPDATE_PREFERENCES',
    preferences: { badgeMode: 'off', pollIntervalMinutes: 0 }
  });
  assert.deepEqual(mock.badgeHistory.at(-1), { type: 'text', text: '' });
  assert.deepEqual(mock.alarmCalls.at(-1), { op: 'clear', name: POLL_ALARM_NAME });
});

test('Deduplicated desktop notifications fire only for newly actionable PRs and open safe PR URL on click', async () => {
  let now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const mock = createMockChromeApi();
  const storage = createStorage(mock.localArea);

  await storage.saveCredentials({ authType: 'bearer', username: '', token: 'tok' });
  await storage.savePreferences({ notificationsEnabled: true });
  await storage.setCachedUser(SAMPLE_USER);

  const pr1 = makePr({
    key: 'acme/web#1',
    id: 1,
    title: 'Initial actionable PR',
    url: 'https://bitbucket.org/acme/web/pull-requests/1'
  });
  const pr2 = makePr({
    key: 'acme/web#2',
    id: 2,
    title: 'Newly assigned PR',
    url: 'https://bitbucket.org/acme/web/pull-requests/2'
  });

  let syncRound = 0;
  const client = {
    async verifyCredentials() {
      return { user: SAMPLE_USER, workspaces: SAMPLE_WORKSPACES, nearLimit: false };
    },
    async fetchPullRequests() {
      syncRound += 1;
      const prs = syncRound === 1 ? [pr1] : [pr1, pr2];
      return {
        prs,
        user: SAMPLE_USER,
        workspaces: SAMPLE_WORKSPACES,
        nearLimit: false,
        partialErrors: []
      };
    }
  };

  const worker = createWorkerService({
    storage,
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now
  });

  // First sync: pr1 is newly actionable -> 1 notification
  await worker.syncNow({ forceManual: false });
  assert.equal(mock.createdNotifications.length, 1);
  assert.match(mock.createdNotifications[0].options.message, /Initial actionable PR/);

  // Second sync: pr1 already actionable, only pr2 is new -> only 1 new notification
  now += 60_000;
  await worker.syncNow({ forceManual: false });
  assert.equal(mock.createdNotifications.length, 2);
  assert.match(mock.createdNotifications[1].options.message, /Newly assigned PR/);

  // Click notification -> opens validated HTTPS URL in new tab and clears notification
  const secondNotifId = mock.createdNotifications[1].notificationId;
  const clicked = await worker.handleNotificationClick(secondNotifId);
  assert.equal(clicked, true);
  assert.deepEqual(mock.openedTabs, [
    { url: 'https://bitbucket.org/acme/web/pull-requests/2' }
  ]);
  assert.deepEqual(mock.clearedNotifications, [secondNotifId]);
});

test('HTTP 429 preserves cached PRs, sets rateLimitWarning, persists backoff across worker restart, and scope changes bypass cooldown', async () => {
  let now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const mock = createMockChromeApi();
  const storage = createStorage(mock.localArea);

  await storage.saveCredentials({ authType: 'bearer', username: '', token: 'tok' });
  await storage.setCachedUser(SAMPLE_USER);

  const cachedPr = makePr({ key: 'acme/web#10', id: 10, title: 'Keep me on 429' });
  let shouldRateLimit = false;
  let syncCalls = 0;

  const client = {
    async verifyCredentials() {
      return { user: SAMPLE_USER, workspaces: SAMPLE_WORKSPACES, nearLimit: false };
    },
    async fetchPullRequests() {
      syncCalls += 1;
      if (shouldRateLimit) {
        throw new BitbucketApiError({
          status: 429,
          code: 'RATE_LIMITED',
          message: 'Bitbucket API rate limit exceeded. Polling will resume shortly.',
          retryAfter: 60_000,
          isTransient: true,
          isAuthError: false
        });
      }
      return {
        prs: [cachedPr],
        user: SAMPLE_USER,
        workspaces: SAMPLE_WORKSPACES,
        nearLimit: false,
        partialErrors: []
      };
    }
  };

  // Worker instance #1
  const worker1 = createWorkerService({
    storage,
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now
  });

  // Successful manual sync
  const firstRes = await worker1.syncNow({ forceManual: true });
  assert.equal(firstRes.ok, true);
  assert.equal(syncCalls, 1);

  // Immediately saving new workspace scope should bypass manual cooldown and trigger fetch
  const prefRes = await worker1.updatePreferences({ workspacesFilter: ['acme'] });
  assert.equal(prefRes.ok, true);
  assert.equal(syncCalls, 2);

  // Next poll hits 429 -> must preserve cached PR, set rateLimitWarning: true, and persist backoffUntil
  now += 60_000;
  shouldRateLimit = true;
  const errRes = await worker1.syncNow({ forceManual: false });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.snapshot?.prList.length, 1);
  assert.equal(errRes.snapshot?.prList[0].id, 10);
  assert.equal(errRes.snapshot?.rateLimitWarning, true);

  // Simulate MV3 Service Worker termination & fresh restart using same persistent chrome.storage.local
  const restartedWorker = createWorkerService({
    storage: createStorage(mock.localArea),
    client,
    chromeApi: mock.chromeApi,
    nowFn: () => now
  });

  await restartedWorker.ensurePollingAlarm();
  await restartedWorker.refreshBadgeFromStorage();
  const startupAutoSync = await restartedWorker.syncNow({ forceManual: false });
  assert.equal(startupAutoSync.skipped, true);
  assert.equal(startupAutoSync.reason, 'backoff');

  const stateAfterRestart = await restartedWorker.getState();
  assert.equal(stateAfterRestart.snapshot.prList.length, 1);
  assert.equal(stateAfterRestart.snapshot.rateLimitWarning, true);
  assert.ok((stateAfterRestart.syncState.backoffUntil ?? 0) > now);
});
