import { describe, test, expect } from 'bun:test';
import {
  BitbucketApiError,
  buildAuthHeaders,
  verifyCredentials,
  runWithConcurrency,
  fetchOpenPullRequests,
} from '../bitbucket-pr-extension/lib/bitbucket.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createRouterFetch(routes) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    for (const route of routes) {
      const matched =
        typeof route.match === 'function'
          ? route.match(url)
          : route.match instanceof RegExp
            ? route.match.test(url)
            : url === route.match;
      if (matched) {
        return route.handle(url, options);
      }
    }
    return jsonResponse({ error: { message: `Unhandled URL: ${url}` } }, 404);
  };
  return { fetchFn, calls };
}

describe('buildAuthHeaders', () => {
  test('builds Basic auth header for atlassian_token', () => {
    const headers = buildAuthHeaders({
      authType: 'atlassian_token',
      email: '  dev@example.com ',
      token: ' ATATT-fake-test-token ',
    });

    expect(headers).toEqual({
      Authorization: `Basic ${btoa('dev@example.com:ATATT-fake-test-token')}`,
      Accept: 'application/json',
    });
  });

  test('builds Bearer auth header for bearer_token', () => {
    const headers = buildAuthHeaders({
      authType: 'bearer_token',
      token: 'bb-bearer-fake-token',
    });

    expect(headers).toEqual({
      Authorization: 'Bearer bb-bearer-fake-token',
      Accept: 'application/json',
    });
  });

  test('throws INVALID_INPUT when email or token is missing', () => {
    expect(() =>
      buildAuthHeaders({ authType: 'atlassian_token', email: '', token: 'abc' })
    ).toThrow(BitbucketApiError);

    try {
      buildAuthHeaders({ authType: 'atlassian_token', email: '', token: 'abc' });
    } catch (err) {
      expect(err).toBeInstanceOf(BitbucketApiError);
      expect(err.code).toBe('INVALID_INPUT');
    }

    try {
      buildAuthHeaders({ authType: 'atlassian_token', email: 'dev@example.com', token: '   ' });
    } catch (err) {
      expect(err).toBeInstanceOf(BitbucketApiError);
      expect(err.code).toBe('INVALID_INPUT');
    }

    try {
      buildAuthHeaders({ authType: 'bearer_token', token: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(BitbucketApiError);
      expect(err.code).toBe('INVALID_INPUT');
    }
  });
});

describe('verifyCredentials', () => {
  const creds = {
    authType: 'atlassian_token',
    email: 'jordan@example.com',
    token: 'fake-token',
  };

  test('returns normalized user on 200', async () => {
    const { fetchFn, calls } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () =>
          jsonResponse({
            account_id: '557058:me',
            uuid: '{1111-2222}',
            display_name: 'Jordan Scarrott',
            username: 'jordans',
            nickname: 'jordan',
            links: { avatar: { href: 'https://bitbucket.org/avatar.png' } },
          }),
      },
    ]);

    const user = await verifyCredentials(creds, fetchFn);
    expect(calls).toHaveLength(1);
    expect(user).toEqual({
      accountId: '557058:me',
      uuid: '{1111-2222}',
      displayName: 'Jordan Scarrott',
      username: 'jordans',
      nickname: 'jordan',
      avatarUrl: 'https://bitbucket.org/avatar.png',
    });
  });

  test('throws AUTH_FAILED on 401', async () => {
    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse({ error: { message: 'Unauthorized' } }, 401),
      },
    ]);

    await expect(verifyCredentials(creds, fetchFn)).rejects.toMatchObject({
      name: 'BitbucketApiError',
      code: 'AUTH_FAILED',
      status: 401,
    });
  });

  test('throws MISSING_SCOPE on 403', async () => {
    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse({ error: { message: 'Forbidden' } }, 403),
      },
    ]);

    await expect(verifyCredentials(creds, fetchFn)).rejects.toMatchObject({
      name: 'BitbucketApiError',
      code: 'MISSING_SCOPE',
      status: 403,
    });
  });

  test('throws RATE_LIMITED on 429', async () => {
    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429),
      },
    ]);

    await expect(verifyCredentials(creds, fetchFn)).rejects.toMatchObject({
      name: 'BitbucketApiError',
      code: 'RATE_LIMITED',
      status: 429,
    });
  });
});

describe('runWithConcurrency', () => {
  test('bounds concurrent in-flight workers and preserves result order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i + 1);

    const results = await runWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return item * 10;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(results).toEqual(items.map((n) => n * 10));
  });
});

describe('fetchOpenPullRequests', () => {
  const creds = {
    authType: 'atlassian_token',
    email: 'jordan@example.com',
    token: 'fake-token',
  };

  const meUser = {
    account_id: '557058:me',
    uuid: '{me-uuid}',
    display_name: 'Jordan',
    username: 'jordans',
  };

  test('paginates workspaces and workspace pull requests and sends required fields expansion', async () => {
    const { fetchFn, calls } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () =>
          jsonResponse({
            values: [{ slug: 'ws-one' }],
            next: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100&page=2',
          }),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100&page=2',
        handle: () =>
          jsonResponse({
            values: [{ slug: 'ws-two' }],
          }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws-one/pullrequests/'),
        handle: (url) => {
          if (url.includes('page=2')) {
            return jsonResponse({
              values: [
                {
                  id: 102,
                  title: 'WS1 Page 2 PR',
                  description: 'Page 2 desc',
                  comment_count: 1,
                  task_count: 0,
                  updated_on: '2026-11-19T09:00:00Z',
                  destination: { repository: { full_name: 'ws-one/app', name: 'app' } },
                  author: { account_id: '557058:other', display_name: 'Other' },
                  participants: [{ role: 'REVIEWER', approved: false, user: meUser }],
                  reviewers: [meUser],
                },
              ],
            });
          }
          return jsonResponse({
            values: [
              {
                id: 101,
                title: 'WS1 Page 1 PR',
                description: 'Page 1 desc',
                comment_count: 3,
                task_count: 1,
                updated_on: '2026-11-19T10:00:00Z',
                destination: { repository: { full_name: 'ws-one/app', name: 'app' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
            ],
            next: `${url}&page=2`,
          });
        },
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws-two/pullrequests/'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 201,
                title: 'WS2 PR',
                description: 'WS2 desc',
                comment_count: 0,
                task_count: 0,
                updated_on: '2026-11-19T11:00:00Z',
                destination: { repository: { full_name: 'ws-two/service', name: 'service' } },
                author: { account_id: '557058:other', display_name: 'Other' },
                participants: [{ role: 'REVIEWER', approved: true, user: meUser }],
                reviewers: [meUser],
              },
            ],
          }),
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);

    expect(result.workspaceCount).toBe(2);
    expect(result.prs).toHaveLength(3);
    expect(result.myPrs.map((p) => p.key)).toEqual(['ws-one/app#101']);
    expect(result.toReviewPrs.map((p) => p.key)).toEqual([
      'ws-one/app#102', // pending first
      'ws-two/service#201', // approved second
    ]);
    expect(result.pendingReviewCount).toBe(1);

    const workspacePrCall = calls.find((c) =>
      c.url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws-one/pullrequests/')
    );
    expect(workspacePrCall).toBeDefined();
    const fieldsParam = new URL(workspacePrCall.url).searchParams.get('fields') || '';
    expect(fieldsParam).toContain('participants');
    expect(fieldsParam).toContain('reviewers');
    expect(fieldsParam).toContain('description');
    expect(fieldsParam).toContain('comment_count');
    expect(fieldsParam).toContain('task_count');
  });

  test('falls back to /2.0/user/permissions/workspaces when /2.0/user/workspaces returns 404', async () => {
    const { fetchFn, calls } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () => jsonResponse({ error: { message: 'Not found' } }, 404),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/permissions/workspaces?pagelen=100',
        handle: () =>
          jsonResponse({
            values: [{ workspace: { slug: 'fallback-ws' } }],
          }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/fallback-ws/pullrequests/'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 5,
                title: 'Fallback workspace PR',
                destination: { repository: { full_name: 'fallback-ws/repo', name: 'repo' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
            ],
          }),
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);

    expect(result.workspaceCount).toBe(1);
    expect(result.myPrs).toHaveLength(1);
    expect(result.myPrs[0].key).toBe('fallback-ws/repo#5');
    expect(
      calls.some((c) =>
        c.url.startsWith('https://api.bitbucket.org/2.0/user/permissions/workspaces')
      )
    ).toBe(true);
  });

  test('falls back to repo-level PR fetching when workspace PR endpoint returns 403 or 404', async () => {
    for (const status of [403, 404]) {
      const { fetchFn, calls } = createRouterFetch([
        {
          match: 'https://api.bitbucket.org/2.0/user',
          handle: () => jsonResponse(meUser),
        },
        {
          match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
          handle: () => jsonResponse({ values: [{ slug: 'ws' }] }),
        },
        {
          match: (url) =>
            url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws/pullrequests/'),
          handle: () => jsonResponse({ error: { message: 'Unavailable' } }, status),
        },
        {
          match: 'https://api.bitbucket.org/2.0/repositories/ws?pagelen=100',
          handle: () =>
            jsonResponse({
              values: [{ full_name: 'ws/repo-a' }, { full_name: 'ws/repo-b' }],
            }),
        },
        {
          match: (url) =>
            url.startsWith('https://api.bitbucket.org/2.0/repositories/ws/repo-a/pullrequests'),
          handle: () =>
            jsonResponse({
              values: [
                {
                  id: 11,
                  title: 'Repo A PR',
                  destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                  author: meUser,
                  participants: [],
                  reviewers: [],
                },
              ],
            }),
        },
        {
          match: (url) =>
            url.startsWith('https://api.bitbucket.org/2.0/repositories/ws/repo-b/pullrequests'),
          handle: () => jsonResponse({ values: [] }),
        },
      ]);

      const result = await fetchOpenPullRequests(creds, fetchFn);
      expect(result.myPrs).toHaveLength(1);
      expect(result.myPrs[0].key).toBe('ws/repo-a#11');
      expect(
        calls.some((c) => c.url === 'https://api.bitbucket.org/2.0/repositories/ws?pagelen=100')
      ).toBe(true);
    }
  });

  test('hydrates missing participants via individual PR detail endpoint', async () => {
    const { fetchFn, calls } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () => jsonResponse({ values: [{ slug: 'ws' }] }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws/pullrequests/'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 77,
                title: 'Needs hydration',
                destination: { repository: { full_name: 'ws/repo-h', name: 'repo-h' } },
                author: { account_id: '557058:other', display_name: 'Other' },
                // participants omitted here
              },
            ],
          }),
      },
      {
        match: 'https://api.bitbucket.org/2.0/repositories/ws/repo-h/pullrequests/77',
        handle: () =>
          jsonResponse({
            id: 77,
            participants: [
              {
                role: 'REVIEWER',
                approved: false,
                state: 'changes_requested',
                user: meUser,
              },
            ],
            reviewers: [meUser],
          }),
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);

    expect(
      calls.some(
        (c) =>
          c.url === 'https://api.bitbucket.org/2.0/repositories/ws/repo-h/pullrequests/77'
      )
    ).toBe(true);
    expect(result.toReviewPrs).toHaveLength(1);
    expect(result.toReviewPrs[0].myReviewState).toBe('changes_requested');
  });

  test('preserves PR #1 from ws/repo-a and PR #1 from ws/repo-b without dropping either during deduplication', async () => {
    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () => jsonResponse({ values: [{ slug: 'ws' }] }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws/pullrequests/'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 1,
                title: 'PR #1 in repo-a',
                destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
              {
                id: 1,
                title: 'PR #1 in repo-b',
                destination: { repository: { full_name: 'ws/repo-b', name: 'repo-b' } },
                author: { account_id: '557058:other', display_name: 'Other' },
                participants: [{ role: 'REVIEWER', approved: false, user: meUser }],
                reviewers: [meUser],
              },
              // Duplicate of ws/repo-a#1 should be deduplicated
              {
                id: 1,
                title: 'PR #1 in repo-a duplicate',
                destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
            ],
          }),
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);
    expect(result.prs).toHaveLength(2);
    expect(result.prs.map((p) => p.key).sort()).toEqual(['ws/repo-a#1', 'ws/repo-b#1']);
    expect(result.myPrs.map((p) => p.key)).toEqual(['ws/repo-a#1']);
    expect(result.toReviewPrs.map((p) => p.key)).toEqual(['ws/repo-b#1']);
  });

  test('respects bounded concurrency (max 5 in-flight) during PR participant hydration', async () => {
    let inFlightHydrations = 0;
    let maxInFlightHydrations = 0;

    const prs = Array.from({ length: 14 }, (_, idx) => ({
      id: idx + 1,
      title: `PR ${idx + 1}`,
      destination: { repository: { full_name: 'ws/repo-c', name: 'repo-c' } },
      author: meUser,
      // participants intentionally omitted to trigger hydration
    }));

    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () => jsonResponse({ values: [{ slug: 'ws' }] }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws/pullrequests/'),
        handle: () => jsonResponse({ values: prs }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/repositories/ws/repo-c/pullrequests/'),
        handle: async () => {
          inFlightHydrations += 1;
          maxInFlightHydrations = Math.max(maxInFlightHydrations, inFlightHydrations);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlightHydrations -= 1;
          return jsonResponse({ participants: [], reviewers: [] });
        },
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);
    expect(result.prs).toHaveLength(14);
    expect(maxInFlightHydrations).toBeLessThanOrEqual(5);
    expect(maxInFlightHydrations).toBeGreaterThan(1);
  });

  test('discovers PRs to review via repository PR endpoints even when workspace PR endpoint only returns authored PRs', async () => {
    const teammate = {
      account_id: '557058:teammate',
      uuid: '{teammate-uuid}',
      display_name: 'Teammate',
    };

    const { fetchFn } = createRouterFetch([
      {
        match: 'https://api.bitbucket.org/2.0/user',
        handle: () => jsonResponse(meUser),
      },
      {
        match: 'https://api.bitbucket.org/2.0/user/workspaces?pagelen=100',
        handle: () => jsonResponse({ values: [{ slug: 'ws' }] }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/workspaces/ws/pullrequests/'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 10,
                title: 'My Authored PR',
                destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
            ],
          }),
      },
      {
        match: 'https://api.bitbucket.org/2.0/repositories/ws?pagelen=100',
        handle: () =>
          jsonResponse({
            values: [{ full_name: 'ws/repo-a', slug: 'repo-a' }],
          }),
      },
      {
        match: (url) =>
          url.startsWith('https://api.bitbucket.org/2.0/repositories/ws/repo-a/pullrequests?'),
        handle: () =>
          jsonResponse({
            values: [
              {
                id: 10,
                title: 'My Authored PR',
                destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                author: meUser,
                participants: [],
                reviewers: [],
              },
              {
                id: 11,
                title: 'Teammate PR Needing My Review',
                destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
                author: teammate,
                participants: [{ role: 'REVIEWER', approved: false, user: meUser }],
                reviewers: [meUser],
              },
            ],
          }),
      },
    ]);

    const result = await fetchOpenPullRequests(creds, fetchFn);
    expect(result.myPrs.map((p) => p.id)).toEqual([10]);
    expect(result.toReviewPrs.map((p) => p.id)).toEqual([11]);
    expect(result.pendingReviewCount).toBe(1);
  });
});
