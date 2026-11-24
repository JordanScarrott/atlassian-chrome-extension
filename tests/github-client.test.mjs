import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubApiError,
  aggregateGitHubCommitStatus,
  collapseGitHubReviews,
  createGitHubClient,
  mapGitHubHttpStatusToError,
  normalizeGitHubPullRequest
} from '../bitbucket-pr-extension/src/github-client.js';
import { CACHE_TTL_MS, DEFAULT_PREFERENCES } from '../bitbucket-pr-extension/src/config.js';
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

test('verifyCredentials validates PAT, sends required GitHub headers, supports GHES, and detects nearLimit', async () => {
  /** @type {Array<{ url: string, headers: Record<string, string> }>} */
  const calls = [];
  const client = createGitHubClient({
    nowFn: () => 123_456,
    fetchFn: async (url, init) => {
      const headersObj = /** @type {Record<string, string>} */ (init?.headers ?? {});
      calls.push({ url: String(url), headers: headersObj });
      return jsonResponse(
        {
          id: 42,
          login: 'jscarrott',
          name: 'Jordan Scarrott',
          avatar_url: 'https://avatars.githubusercontent.com/u/42'
        },
        { headers: { 'X-RateLimit-Remaining': '15' } }
      );
    }
  });

  const res = await client.verifyCredentials({
    token: 'ghp_secret123',
    apiBaseUrl: 'https://github.enterprise.local/api/v3///'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://github.enterprise.local/api/v3/user');
  assert.equal(calls[0].headers.Authorization, 'Bearer ghp_secret123');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');

  assert.deepEqual(res.user, {
    uuid: 'gh:42',
    accountId: '42',
    displayName: 'Jordan Scarrott',
    username: 'jscarrott',
    avatarUrl: 'https://avatars.githubusercontent.com/u/42',
    cachedAt: 123_456
  });
  assert.equal(res.nearLimit, true);

  // Rejects non-HTTPS override URLs before sending token over the wire
  await assert.rejects(
    () => client.verifyCredentials({ token: 'ghp_secret123', apiBaseUrl: 'http://insecure.example.com/api/v3' }),
    (err) => err instanceof GitHubApiError && err.code === 'BAD_CONFIG'
  );
});

test('mapGitHubHttpStatusToError handles 401, 403 forbidden vs rate limit, 429 Retry-After / X-RateLimit-Reset, and 5xx cleanly', () => {
  const now = 1_700_000_000_000;

  const err401 = mapGitHubHttpStatusToError(401, new Headers(), now);
  assert.equal(err401.code, 'UNAUTHORIZED');
  assert.equal(err401.isAuthError, true);
  assert.equal(err401.isTransient, false);

  const err403Forbidden = mapGitHubHttpStatusToError(
    403,
    new Headers({ 'X-RateLimit-Remaining': '100' }),
    now
  );
  assert.equal(err403Forbidden.code, 'FORBIDDEN');
  assert.equal(err403Forbidden.isAuthError, true);
  assert.equal(err403Forbidden.isTransient, false);

  const resetEpochSec = String(Math.floor((now + 45_000) / 1000));
  const err403RateLimit = mapGitHubHttpStatusToError(
    403,
    new Headers({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': resetEpochSec }),
    now
  );
  assert.equal(err403RateLimit.code, 'RATE_LIMITED');
  assert.equal(err403RateLimit.isTransient, true);
  assert.equal(err403RateLimit.isAuthError, false);
  assert.equal(err403RateLimit.retryAfter, 45_000);

  const err429 = mapGitHubHttpStatusToError(
    429,
    new Headers({ 'Retry-After': '30' }),
    now
  );
  assert.equal(err429.code, 'RATE_LIMITED');
  assert.equal(err429.isTransient, true);
  assert.equal(err429.retryAfter, 30_000);
});

test('collapseGitHubReviews keeps latest decisive review per reviewer and respects dismissals', () => {
  const collapsed = collapseGitHubReviews(
    [
      {
        user: { id: 100, login: 'alice', name: 'Alice' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-22T10:00:00Z'
      },
      {
        user: { id: 100, login: 'alice', name: 'Alice' },
        state: 'COMMENTED',
        submitted_at: '2026-11-22T10:30:00Z'
      },
      {
        user: { id: 100, login: 'alice', name: 'Alice' },
        state: 'APPROVED',
        submitted_at: '2026-11-22T11:00:00Z'
      },
      {
        user: { id: 200, login: 'bob', name: '' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-22T09:00:00Z'
      },
      {
        user: { id: 300, login: 'carol' },
        state: 'APPROVED',
        submitted_at: '2026-11-22T08:00:00Z'
      },
      {
        user: { id: 300, login: 'carol' },
        state: 'DISMISSED',
        submitted_at: '2026-11-22T09:00:00Z'
      },
      {
        user: { id: 42, login: 'author' },
        state: 'COMMENTED',
        submitted_at: '2026-11-22T12:00:00Z'
      }
    ],
    'gh:42'
  );

  assert.deepEqual(collapsed, [
    { uuid: 'gh:100', displayName: 'Alice', role: 'REVIEWER', approved: true, state: 'approved' },
    { uuid: 'gh:200', displayName: 'bob', role: 'REVIEWER', approved: false, state: 'changes_requested' }
  ]);
});

test('aggregateGitHubCommitStatus maps success/failure/error/pending and enforces precedence', () => {
  const now = 1_700_000_000_000;
  assert.equal(aggregateGitHubCommitStatus({ state: 'pending', total_count: 0, statuses: [] }, 'sha1', now), null);

  const failed = aggregateGitHubCommitStatus(
    {
      state: 'failure',
      total_count: 3,
      statuses: [
        { state: 'success', context: 'ci/lint', target_url: 'https://ci.example.com/lint', updated_at: '2026-11-23T10:00:00Z' },
        { state: 'pending', context: 'ci/e2e', target_url: 'https://ci.example.com/e2e', updated_at: '2026-11-23T10:01:00Z' },
        { state: 'error', context: 'ci/unit', target_url: 'http://insecure.example.com/unit', updated_at: '2026-11-23T10:02:00Z' }
      ]
    },
    'sha-abc',
    now
  );
  assert.deepEqual(failed, {
    state: 'FAILED',
    totalCount: 3,
    passedCount: 1,
    failedCount: 1,
    inProgressCount: 1,
    stoppedCount: 0,
    url: null,
    name: 'ci/unit',
    updatedOn: '2026-11-23T10:02:00Z',
    commitHash: 'sha-abc',
    cachedAt: now
  });

  const pending = aggregateGitHubCommitStatus(
    {
      state: 'pending',
      total_count: 1,
      statuses: [
        { state: 'pending', context: 'ci/build', target_url: 'https://ci.example.com/build', updated_at: '2026-11-23T10:05:00Z' }
      ]
    },
    'sha-pending',
    now
  );
  assert.equal(pending?.state, 'INPROGRESS');
  assert.equal(pending?.url, 'https://ci.example.com/build');
});

test('fetchPullRequests deduplicates 3 search queries, enriches reviews/status, caches commits, and honors nearLimit', async () => {
  let now = 1_700_000_000_000;
  const storage = createMemoryStorage();
  /** @type {string[]} */
  const requestedUrls = [];
  let simulateNearLimit = false;
  let commitStatusMode = 'initial';

  const longBody = `Fixes #77 and resolves MEZ-123.\n${'x'.repeat(600)}`;

  const client = createGitHubClient({
    nowFn: () => now,
    fetchFn: async (url) => {
      const str = String(url);
      requestedUrls.push(str);

      if (str === 'https://api.github.com/user') {
        return jsonResponse({ id: 42, login: 'jordan', name: 'Jordan Scarrott' });
      }
      if (str.includes('/search/issues?q=is:pr+is:open+author:@me')) {
        return jsonResponse({
          items: [
            {
              number: 10,
              repository_url: 'https://api.github.com/repos/acme/backend',
              html_url: 'https://github.com/acme/backend/pull/10',
              title: 'MEZ-123 Auth fix'
            }
          ]
        });
      }
      if (str.includes('/search/issues?q=is:pr+is:open+review-requested:@me')) {
        return jsonResponse({
          items: [
            // Duplicate #10 across author + review-requested
            {
              number: 10,
              repository_url: 'https://api.github.com/repos/acme/backend',
              html_url: 'https://github.com/acme/backend/pull/10'
            },
            {
              number: 25,
              repository_url: 'https://api.github.com/repos/acme/frontend',
              html_url: 'https://github.com/acme/frontend/pull/25'
            }
          ]
        });
      }
      if (str.includes('/search/issues?q=is:pr+is:open+reviewed-by:@me')) {
        return jsonResponse({ items: [] });
      }
      if (str === 'https://api.github.com/repos/acme/backend/pulls/10') {
        return jsonResponse(
          {
            number: 10,
            title: 'Auth fix',
            body: longBody,
            state: 'open',
            draft: false,
            html_url: 'https://github.com/acme/backend/pull/10',
            user: { id: 42, login: 'jordan', name: 'Jordan Scarrott' },
            head: { ref: 'feat/MEZ-123-auth', sha: 'sha-terminal-10' },
            base: { ref: 'main' },
            requested_reviewers: [{ id: 99, login: 'alice', name: 'Alice' }],
            comments: 2,
            review_comments: 3,
            created_at: '2026-11-22T09:00:00Z',
            updated_at: '2026-11-22T11:00:00Z'
          },
          simulateNearLimit ? { headers: { 'X-RateLimit-Remaining': '5' } } : {}
        );
      }
      if (str === 'https://api.github.com/repos/acme/backend/pulls/10/reviews?per_page=50') {
        return jsonResponse([
          { user: { id: 99, login: 'alice', name: 'Alice' }, state: 'APPROVED', submitted_at: '2026-11-22T11:05:00Z' }
        ]);
      }
      if (str === 'https://api.github.com/repos/acme/backend/commits/sha-terminal-10/status') {
        return jsonResponse({
          state: 'success',
          total_count: 1,
          statuses: [
            { state: 'success', context: 'ci/test', target_url: 'https://ci.example.com/10', updated_at: '2026-11-22T11:02:00Z' }
          ]
        });
      }
      if (str === 'https://api.github.com/repos/acme/frontend/pulls/25') {
        return jsonResponse({
          number: 25,
          title: 'UI Update',
          body: '',
          state: 'open',
          draft: false,
          html_url: 'javascript:alert(1)',
          user: { id: 77, login: 'bob', name: 'Bob' },
          head: { ref: 'feat/ui', sha: 'sha-active-25' },
          base: { ref: 'main' },
          requested_reviewers: [{ id: 42, login: 'jordan', name: 'Jordan Scarrott' }],
          comments: 1,
          review_comments: 0,
          created_at: '2026-11-22T08:00:00Z',
          updated_at: '2026-11-22T10:00:00Z'
        });
      }
      if (str === 'https://api.github.com/repos/acme/frontend/pulls/25/reviews?per_page=50') {
        return jsonResponse([]);
      }
      if (str === 'https://api.github.com/repos/acme/frontend/commits/sha-active-25/status') {
        if (commitStatusMode === 'updated') {
          return jsonResponse({
            state: 'failure',
            total_count: 1,
            statuses: [
              { state: 'failure', context: 'ci/lint', target_url: 'https://ci.example.com/25-fail', updated_at: '2026-11-22T12:00:00Z' }
            ]
          });
        }
        return jsonResponse({
          state: 'pending',
          total_count: 1,
          statuses: [
            { state: 'pending', context: 'ci/lint', target_url: 'https://ci.example.com/25', updated_at: '2026-11-22T10:05:00Z' }
          ]
        });
      }
      throw new Error(`Unexpected URL: ${str}`);
    }
  });

  // Round 1: fetches user, 3 searches, 2 PR details, 2 reviews, 2 commit statuses
  const run1 = await client.fetchPullRequests({
    creds: { token: 'ghp_tok', apiBaseUrl: 'https://api.github.com' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });

  assert.equal(run1.prs.length, 2);
  const pr10 = run1.prs.find((p) => p.key === 'gh:acme/backend#10');
  const pr25 = run1.prs.find((p) => p.key === 'gh:acme/frontend#25');

  assert.equal(pr10?.provider, 'github');
  assert.equal(pr10?.authorUuid, 'gh:42');
  assert.equal(pr10?.description?.length, 500);
  assert.equal(pr10?.commentCount, 5);
  assert.equal(pr10?.participants[0]?.state, 'approved');
  assert.equal(pr10?.buildStatus?.state, 'SUCCESSFUL');

  // Unsafe javascript: URL falls back to safe https GitHub URL
  assert.equal(pr25?.url, 'https://github.com/acme/frontend/pull/25');
  assert.equal(pr25?.buildStatus?.state, 'INPROGRESS');

  // Round 2 (30s later): /user cached (24h), sha-terminal-10 cached (6h), sha-active-25 cached (60s)
  now += 30_000;
  requestedUrls.length = 0;
  const run2 = await client.fetchPullRequests({
    creds: { token: 'ghp_tok', apiBaseUrl: 'https://api.github.com' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });
  assert.equal(run2.prs.length, 2);
  assert.ok(!requestedUrls.includes('https://api.github.com/user'));
  assert.ok(!requestedUrls.some((u) => u.includes('/status')));

  // Round 3 (after 60s active TTL, before 6h terminal TTL): only sha-active-25 re-fetches commit status
  now += CACHE_TTL_MS.buildStatusActive;
  commitStatusMode = 'updated';
  requestedUrls.length = 0;
  const run3 = await client.fetchPullRequests({
    creds: { token: 'ghp_tok', apiBaseUrl: 'https://api.github.com' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });
  assert.ok(!requestedUrls.some((u) => u.includes('sha-terminal-10/status')));
  assert.ok(requestedUrls.some((u) => u.includes('sha-active-25/status')));
  assert.equal(run3.prs.find((p) => p.key === 'gh:acme/frontend#25')?.buildStatus?.state, 'FAILED');

  // Round 4: nearLimit skips commit status fetches and falls back to cached entries
  now += CACHE_TTL_MS.buildStatusActive;
  simulateNearLimit = true;
  requestedUrls.length = 0;
  const run4 = await client.fetchPullRequests({
    creds: { token: 'ghp_tok', apiBaseUrl: 'https://api.github.com' },
    storage,
    preferences: DEFAULT_PREFERENCES
  });
  assert.equal(run4.nearLimit, true);
  assert.ok(!requestedUrls.some((u) => u.includes('/status')));
  assert.equal(run4.prs.find((p) => p.key === 'gh:acme/frontend#25')?.buildStatus?.state, 'FAILED');
});

test('normalizeGitHubPullRequest produces canonical defaults when optional fields are absent', () => {
  const normalized = normalizeGitHubPullRequest({
    owner: 'org',
    repo: 'service',
    number: 9,
    detail: {
      title: 'Add health check',
      user: { id: 1, login: 'dev' },
      head: { ref: 'feat/health', sha: 'deadbeef' },
      base: { ref: 'main' }
    },
    webBaseUrl: 'https://github.enterprise.local'
  });

  assert.equal(normalized.provider, 'github');
  assert.equal(normalized.key, 'gh:org/service#9');
  assert.equal(normalized.url, 'https://github.enterprise.local/org/service/pull/9');
  assert.equal(normalized.workspace, 'org');
  assert.equal(normalized.repoName, 'service');
  assert.equal(normalized.sourceCommitHash, 'deadbeef');
  assert.equal(normalized.buildStatus, null);
});

test('fetchGitHubDiffstat fetches /files?per_page=50, drops patch hunks, and degrades gracefully on error', async () => {
  const { fetchGitHubDiffstat } = await import('../bitbucket-pr-extension/src/github-client.js');

  let calledUrl = '';
  const summary = await fetchGitHubDiffstat({
    headers: { Authorization: 'Bearer ghp_tok' },
    apiBaseUrl: 'https://github.enterprise.local/api/v3',
    pr: {
      id: 25,
      repoFullName: 'acme/web',
      workspace: 'acme',
      repoName: 'web',
      sourceCommitHash: 'sha25'
    },
    nowFn: () => 888_000,
    fetchFn: async (url) => {
      calledUrl = String(url);
      return jsonResponse([
        {
          filename: 'src/index.ts',
          status: 'modified',
          additions: 15,
          deletions: 4,
          patch: '@@ -1,4 +1,15 @@\n+const shouldNotBeKept = 1;'
        },
        {
          filename: 'README.md',
          status: 'added',
          additions: 10,
          deletions: 0,
          patch: '@@ -0,0 +1,10 @@\n+Docs'
        }
      ]);
    }
  });

  assert.equal(
    calledUrl,
    'https://github.enterprise.local/api/v3/repos/acme/web/pulls/25/files?per_page=50'
  );
  assert.deepEqual(summary, {
    commitHash: 'sha25',
    filesChanged: 2,
    linesAdded: 25,
    linesRemoved: 4,
    files: [
      { path: 'src/index.ts', added: 15, removed: 4, status: 'modified' },
      { path: 'README.md', added: 10, removed: 0, status: 'added' }
    ],
    cachedAt: 888_000
  });
  assert.equal('patch' in (summary?.files[0] ?? {}), false);

  const errSummary = await fetchGitHubDiffstat({
    headers: { Authorization: 'Bearer ghp_tok' },
    pr: {
      id: 25,
      repoFullName: 'acme/web',
      workspace: 'acme',
      repoName: 'web',
      sourceCommitHash: 'sha25'
    },
    fetchFn: async () => new Response('Server error', { status: 500 })
  });
  assert.equal(errSummary, null);
});

