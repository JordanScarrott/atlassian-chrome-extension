import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BitbucketApiError,
  buildAuthHeader,
  createBitbucketClient,
  normalizePullRequest
} from '../bitbucket-pr-extension/src/bitbucket-client.js';
import { DEFAULT_PREFERENCES } from '../bitbucket-pr-extension/src/config.js';
import { createStorage } from '../bitbucket-pr-extension/src/storage.js';

function createMemoryStorage() {
  /** @type {Record<string, unknown>} */
  const store = {};
  return createStorage({
    async get(keys) {
      if (!keys) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of list) {
        if (k in store) out[k] = store[k];
      }
      return out;
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) delete store[k];
    }
  });
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

test('buildAuthHeader generates UTF-8 safe Basic auth and Bearer headers', () => {
  const basic = buildAuthHeader({
    authType: 'api_token',
    username: 'jörgen@example.com',
    token: 'tok-ütf8'
  });
  assert.ok(basic.startsWith('Basic '));
  const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
  assert.equal(decoded, 'jörgen@example.com:tok-ütf8');

  // Legacy app_password maps to Basic
  const legacyAppPw = buildAuthHeader({
    authType: 'app_password',
    username: 'user@example.com',
    token: 'abc'
  });
  assert.equal(Buffer.from(legacyAppPw.slice(6), 'base64').toString('utf8'), 'user@example.com:abc');

  // Bearer and legacy pat
  assert.equal(buildAuthHeader({ authType: 'bearer', token: ' ws-tok ' }), 'Bearer ws-tok');
  assert.equal(buildAuthHeader({ authType: 'pat', token: 'pat-tok' }), 'Bearer pat-tok');

  assert.throws(
    () => buildAuthHeader({ authType: 'api_token', username: '', token: 'tok' }),
    (err) => err instanceof BitbucketApiError && err.isAuthError
  );
});

test('verifyCredentials returns user + workspaces and tolerates 403 on workspaces', async () => {
  const calls = [];
  const client = createBitbucketClient({
    nowFn: () => 12345,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/user')) {
        return jsonResponse({
          uuid: '{user-1}',
          display_name: 'Jordan',
          username: 'jordan',
          links: { avatar: { href: 'https://avatar.bitbucket.org/jordan.png' } }
        });
      }
      if (String(url).includes('/workspaces')) {
        return new Response('<html>Forbidden Raw Dump</html>', { status: 403 });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  const res = await client.verifyCredentials({
    authType: 'bearer',
    token: 'repo-scoped-token'
  });

  assert.equal(res.user.uuid, '{user-1}');
  assert.equal(res.user.displayName, 'Jordan');
  assert.deepEqual(res.workspaces, []);
  assert.equal(calls.length, 2);
});

test('verifyCredentials maps 401 and 429 cleanly without exposing raw bodies', async () => {
  const client401 = createBitbucketClient({
    fetchFn: async () => new Response('{"secret_internal":"raw body leak"}', { status: 401 })
  });

  await assert.rejects(
    () => client401.verifyCredentials({ authType: 'bearer', token: 'bad' }),
    (err) =>
      err instanceof BitbucketApiError &&
      err.status === 401 &&
      err.isAuthError === true &&
      !err.message.includes('raw body leak')
  );

  const client429 = createBitbucketClient({
    fetchFn: async () =>
      new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '45' } })
  });

  await assert.rejects(
    () => client429.verifyCredentials({ authType: 'bearer', token: 'rate-limited' }),
    (err) =>
      err instanceof BitbucketApiError &&
      err.status === 429 &&
      err.isTransient === true &&
      err.retryAfter === 45_000
  );
});

test('fetchPullRequests uses caches, deduplicates authored + reviewing PRs, and tolerates per-repo 403/404', async () => {
  const storage = createMemoryStorage();
  const requests = [];
  let sleepCalls = 0;

  const pr1 = {
    id: 101,
    title: 'MEZ-42 Add OAuth login',
    state: 'OPEN',
    created_on: '2026-11-20T10:00:00Z',
    updated_on: '2026-11-22T09:00:00Z',
    comment_count: 3,
    task_count: 1,
    draft: false,
    links: { html: { href: 'https://bitbucket.org/acme/web-app/pull-requests/101' } },
    author: { uuid: '{me}', display_name: 'Jordan' },
    source: { branch: { name: 'feature/MEZ-42-oauth' } },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'acme/web-app', name: 'web-app' }
    },
    reviewers: [{ uuid: '{rev-1}', display_name: 'Alice' }],
    participants: [
      { role: 'AUTHOR', approved: false, state: null, user: { uuid: '{me}', display_name: 'Jordan' } },
      { role: 'REVIEWER', approved: true, state: 'approved', user: { uuid: '{rev-1}', display_name: 'Alice' } }
    ]
  };

  const pr2 = {
    id: 202,
    title: 'Fix retry loop',
    state: 'OPEN',
    created_on: '2026-11-21T10:00:00Z',
    updated_on: '2026-11-22T11:00:00Z',
    comment_count: 0,
    task_count: 0,
    draft: false,
    links: { html: { href: 'javascript:alert(1)' } }, // unsafe URL should be sanitized
    author: { uuid: '{other}', display_name: 'Bob' },
    source: { branch: { name: 'fix/MEZ-99-retry' } },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'acme/web-app', name: 'web-app' }
    },
    reviewers: [{ uuid: '{me}', display_name: 'Jordan' }],
    participants: []
  };

  const client = createBitbucketClient({
    nowFn: () => 1_700_000_000_000,
    sleepFn: async () => {
      sleepCalls += 1;
    },
    fetchFn: async (url) => {
      const str = String(url);
      requests.push(str);

      if (str.endsWith('/2.0/user')) {
        return jsonResponse({ uuid: '{me}', display_name: 'Jordan', username: 'jordan' });
      }
      if (str.includes('/2.0/user/workspaces?')) {
        return jsonResponse({
          values: [{ administrator: false, type: 'workspace_access', workspace: { slug: 'acme', name: 'Acme Corp' } }]
        });
      }
      if (str.includes('/2.0/workspaces/acme/pullrequests/')) {
        return jsonResponse(
          { values: [pr1] },
          { headers: { 'X-RateLimit-NearLimit': 'true' } }
        );
      }
      if (str.includes('/2.0/repositories/acme?')) {
        return jsonResponse({
          values: [
            { slug: 'web-app', full_name: 'acme/web-app', updated_on: '2026-11-22T11:00:00Z' },
            { slug: 'secret-repo', full_name: 'acme/secret-repo', updated_on: '2026-11-22T10:00:00Z' }
          ]
        });
      }
      if (str.includes('/repositories/acme/web-app/pullrequests')) {
        // Also returns pr1 (testing deduplication) + pr2
        return jsonResponse({ values: [pr1, pr2] });
      }
      if (str.includes('/repositories/acme/secret-repo/pullrequests')) {
        return new Response('Forbidden', { status: 403 });
      }
      throw new Error(`Unexpected URL: ${str}`);
    }
  });

  const firstRun = await client.fetchPullRequests({
    creds: { authType: 'api_token', username: 'j@example.com', token: 'tok' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });

  assert.equal(firstRun.prs.length, 2);
  assert.equal(firstRun.nearLimit, true);
  assert.equal(sleepCalls, 1);
  assert.equal(firstRun.partialErrors.length, 1);
  assert.equal(firstRun.partialErrors[0].scope, 'acme/secret-repo');

  const sanitizedPr2 = firstRun.prs.find((p) => p.id === 202);
  assert.equal(sanitizedPr2?.url, 'https://bitbucket.org/acme/web-app/pull-requests/202');

  // Second run within cache TTL should NOT re-fetch /user, /user/workspaces, or /repositories/{ws}
  requests.length = 0;
  const secondRun = await client.fetchPullRequests({
    creds: { authType: 'api_token', username: 'j@example.com', token: 'tok' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });

  assert.equal(secondRun.prs.length, 2);
  assert.ok(!requests.some((u) => u.endsWith('/2.0/user')));
  assert.ok(!requests.some((u) => u.includes('/2.0/user/workspaces?')));
  assert.ok(!requests.some((u) => u.includes('/2.0/repositories/acme?')));
});

test('normalizePullRequest rejects malformed payloads and preserves canonical fields', () => {
  assert.equal(normalizePullRequest(null, 'ws'), null);
  assert.equal(normalizePullRequest({}, 'ws'), null);

  const normalized = normalizePullRequest({
    id: 7,
    title: '  Ship widget  ',
    author: { uuid: '{a}', display_name: 'Alice' },
    source: { branch: { name: 'feat/x' }, repository: { full_name: 'ws/repo', name: 'repo' } },
    destination: { branch: { name: 'main' } }
  });
  assert.equal(normalized?.key, 'ws/repo#7');
  assert.equal(normalized?.title, 'Ship widget');
  assert.equal(normalized?.url, 'https://bitbucket.org/ws/repo/pull-requests/7');
});

test('fetchPullRequests includes required PR fields, merges authored + reviewing duplicates, follows only safe /2.0/ next URLs, and scopes reposFilter', async () => {
  const storage = createMemoryStorage();
  /** @type {string[]} */
  const requests = [];

  const client = createBitbucketClient({
    nowFn: () => 1_700_000_000_000,
    sleepFn: async () => {},
    fetchFn: async (url) => {
      const str = String(url);
      requests.push(str);

      if (str.endsWith('/2.0/user')) {
        return jsonResponse({ uuid: '{me}', display_name: 'Jordan', username: 'jordan' });
      }
      if (str.includes('/2.0/workspaces/acme/pullrequests/') && !str.includes('page=2')) {
        const parsed = new URL(str);
        const fields = (parsed.searchParams.get('fields') || '').split(',');
        assert.ok(fields.includes('next'));
        assert.ok(fields.includes('values.links.html.href'));
        assert.ok(fields.includes('values.participants.role'));
        assert.ok(fields.includes('values.participants.state'));
        assert.ok(fields.includes('values.reviewers.uuid'));

        return jsonResponse({
          next: 'https://api.bitbucket.org/2.0/workspaces/acme/pullrequests/%7Bme%7D?page=2',
          values: [
            {
              id: 55,
              title: 'Authored + Reviewing PR',
              state: 'OPEN',
              author: { uuid: '{me}', display_name: 'Jordan' },
              source: { branch: { name: 'feat/MEZ-11' } },
              destination: { branch: { name: 'main' }, repository: { full_name: 'Acme/api', name: 'api' } },
              reviewers: [{ uuid: '{other-rev}', display_name: 'Bob' }],
              participants: [
                { role: 'REVIEWER', approved: true, state: 'approved', user: { uuid: '{other-rev}', display_name: 'Bob' } }
              ]
            }
          ]
        });
      }
      if (str.includes('/2.0/workspaces/acme/pullrequests/') && str.includes('page=2')) {
        return jsonResponse({
          next: 'https://evil.example.com/2.0/steal', // must be ignored!
          values: []
        });
      }
      if (str.includes('/repositories/acme/api/pullrequests')) {
        return jsonResponse({
          values: [
            {
              id: 55,
              title: 'Authored + Reviewing PR',
              state: 'OPEN',
              author: { uuid: '{me}', display_name: 'Jordan' },
              source: { branch: { name: 'feat/MEZ-11' } },
              destination: { branch: { name: 'main' }, repository: { full_name: 'Acme/api', name: 'api' } },
              reviewers: [{ uuid: '{me}', display_name: 'Jordan' }],
              participants: [
                { role: 'REVIEWER', approved: false, state: null, user: { uuid: '{me}', display_name: 'Jordan' } }
              ]
            }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${str}`);
    }
  });

  const res = await client.fetchPullRequests({
    creds: { authType: 'bearer', token: 'tok' },
    storage,
    preferences: {
      ...DEFAULT_PREFERENCES,
      reposFilter: ['acme/api/', 'acme/api']
    }
  });

  assert.equal(res.prs.length, 1);
  // Deduplication merges reviewers & participants rather than overwriting
  assert.equal(res.prs[0].reviewers.length, 2);
  assert.equal(res.prs[0].participants.length, 2);
  // Should NOT call /user/workspaces or /repositories/{ws} or evil next URL
  assert.ok(!requests.some((u) => u.includes('/user/workspaces')));
  assert.ok(!requests.some((u) => u.includes('/2.0/repositories/Acme?')));
  assert.ok(!requests.some((u) => u.includes('evil.example.com')));
});

test('fetchPullRequests throws on 429, TIMEOUT, and NETWORK errors instead of returning empty prs: []', async () => {
  for (const scenario of ['429', 'timeout', 'network']) {
    const storage = createMemoryStorage();
    await storage.setCachedUser({
      uuid: '{me}',
      displayName: 'Jordan',
      username: 'jordan',
      avatarUrl: null,
      cachedAt: 1_700_000_000_000
    });
    await storage.setCachedWorkspaces({
      items: [{ slug: 'acme', name: 'Acme' }],
      cachedAt: 1_700_000_000_000
    });

    const client = createBitbucketClient({
      nowFn: () => 1_700_000_000_100,
      sleepFn: async () => {},
      fetchFn: async () => {
        if (scenario === '429') {
          return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '12' } });
        }
        if (scenario === 'timeout') {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        throw new TypeError('Failed to fetch');
      }
    });

    await assert.rejects(
      () =>
        client.fetchPullRequests({
          creds: { authType: 'bearer', token: 'tok' },
          storage,
          preferences: DEFAULT_PREFERENCES
        }),
      (err) => err instanceof BitbucketApiError && err.isTransient === true
    );
  }
});
