import { normalizePullRequest, partitionPullRequests, sanitizeUrl } from './pr-model.js';

const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';
const PR_FIELDS =
  '+values.participants,+values.reviewers,+values.description,+values.comment_count,+values.task_count';

/**
 * Typed error for Bitbucket API and credential validation failures.
 */
export class BitbucketApiError extends Error {
  constructor(codeOrOptions, message, status = null) {
    if (typeof codeOrOptions === 'object' && codeOrOptions !== null) {
      super(codeOrOptions.message || 'Bitbucket API error');
      this.code = codeOrOptions.code || 'API_ERROR';
      this.status = codeOrOptions.status ?? null;
    } else {
      super(message || 'Bitbucket API error');
      this.code = codeOrOptions || 'API_ERROR';
      this.status = status;
    }
    this.name = 'BitbucketApiError';
  }
}

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function encodeRepoPath(repoFullName) {
  return String(repoFullName)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function getRepoFullName(pr) {
  return (
    pr?.destination?.repository?.full_name ||
    pr?.source?.repository?.full_name ||
    ''
  );
}

async function readErrorMessage(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text);
      return json?.error?.message || json?.message || text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return '';
  }
}

async function mapHttpError(response, context = {}) {
  const status = response.status;
  const detail = await readErrorMessage(response);

  if (status === 401) {
    const hint =
      context.authType === 'bearer_token'
        ? 'Authentication failed (401). Check that your Bitbucket access token is valid and not expired.'
        : 'Authentication failed (401). Check your Atlassian account email and scoped Bitbucket API token.';
    return new BitbucketApiError('AUTH_FAILED', hint, 401);
  }

  if (status === 403) {
    const scopeHint =
      context.requiredScope || 'read:user:bitbucket and read:pullrequest:bitbucket';
    return new BitbucketApiError(
      'MISSING_SCOPE',
      `Access denied (403). Ensure your API token has the required scope (${scopeHint}).`,
      403
    );
  }

  if (status === 429) {
    return new BitbucketApiError(
      'RATE_LIMITED',
      'Bitbucket API rate limit exceeded (429). Please wait a few minutes and try again.',
      429
    );
  }

  const suffix = detail ? `: ${detail}` : '';
  return new BitbucketApiError(
    'API_ERROR',
    `Bitbucket API request failed (${status})${suffix}`,
    status
  );
}

async function executeFetch(url, headers, fetchFn) {
  try {
    return await fetchFn(url, { headers });
  } catch (err) {
    throw new BitbucketApiError(
      'NETWORK_ERROR',
      `Network error while contacting Bitbucket: ${err?.message || 'request failed'}.`,
      null
    );
  }
}

/**
 * Builds HTTP headers for Atlassian API token (Basic) or Bearer token authentication.
 */
export function buildAuthHeaders(credentials = {}) {
  const authType = credentials?.authType || 'atlassian_token';
  const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
  const rawToken = credentials?.token ?? credentials?.apiToken;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';

  if (authType === 'atlassian_token') {
    if (!email) {
      throw new BitbucketApiError(
        'INVALID_INPUT',
        'Atlassian account email is required for API token authentication.'
      );
    }
    if (!token) {
      throw new BitbucketApiError('INVALID_INPUT', 'Atlassian API token is required.');
    }
    return {
      Authorization: `Basic ${encodeBase64Utf8(`${email}:${token}`)}`,
      Accept: 'application/json',
    };
  }

  if (authType === 'bearer_token') {
    if (!token) {
      throw new BitbucketApiError('INVALID_INPUT', 'Bearer token is required.');
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
  }

  throw new BitbucketApiError(
    'INVALID_INPUT',
    `Unsupported authentication type: ${authType}`
  );
}

/**
 * Verifies credentials against GET /2.0/user and returns normalized user identity fields.
 */
export async function verifyCredentials(credentials, fetchFn = fetch) {
  const headers = buildAuthHeaders(credentials);
  const authType = credentials?.authType || 'atlassian_token';
  const response = await executeFetch(`${BITBUCKET_API_BASE}/user`, headers, fetchFn);

  if (!response.ok) {
    throw await mapHttpError(response, {
      authType,
      requiredScope: 'read:user:bitbucket',
    });
  }

  const user = await response.json();
  return {
    accountId: user?.account_id || '',
    uuid: user?.uuid || '',
    displayName:
      user?.display_name || user?.nickname || user?.username || 'Bitbucket User',
    username: user?.username || '',
    nickname: user?.nickname || '',
    avatarUrl: sanitizeUrl(user?.links?.avatar?.href),
  };
}

/**
 * Runs an async worker over items with bounded concurrency.
 */
export async function runWithConcurrency(items, limit = 5, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Number(limit) || 5, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

/**
 * Fetches paginated Bitbucket collection responses up to maxPages.
 * Propagates 401, 403, 429, and API/network failures as BitbucketApiError.
 */
export async function fetchAllPages(startUrl, headers, fetchFn = fetch, maxPages = 10) {
  const values = [];
  let nextUrl = startUrl;
  let pageCount = 0;

  while (nextUrl && pageCount < maxPages) {
    const response = await executeFetch(nextUrl, headers, fetchFn);
    if (!response.ok) {
      throw await mapHttpError(response);
    }

    const data = await response.json();
    if (Array.isArray(data?.values)) {
      values.push(...data.values);
    }

    nextUrl = typeof data?.next === 'string' && data.next ? data.next : null;
    pageCount += 1;
  }

  return values;
}

async function discoverWorkspaceSlugs(headers, fetchFn) {
  let rawWorkspaces;
  try {
    rawWorkspaces = await fetchAllPages(
      `${BITBUCKET_API_BASE}/user/workspaces?pagelen=100`,
      headers,
      fetchFn
    );
  } catch (err) {
    if (err instanceof BitbucketApiError && (err.status === 404 || err.status === 410)) {
      rawWorkspaces = await fetchAllPages(
        `${BITBUCKET_API_BASE}/user/permissions/workspaces?pagelen=100`,
        headers,
        fetchFn
      );
    } else {
      throw err;
    }
  }

  const slugs = new Set();
  for (const item of rawWorkspaces) {
    const slug = item?.workspace?.slug || item?.slug;
    if (typeof slug === 'string' && slug.trim()) {
      slugs.add(slug.trim());
    }
  }
  return Array.from(slugs);
}

async function fetchWorkspacePrsViaRepos(slug, headers, fetchFn) {
  const repos = await fetchAllPages(
    `${BITBUCKET_API_BASE}/repositories/${encodeURIComponent(slug)}?pagelen=100`,
    headers,
    fetchFn
  );

  const repoNames = repos
    .map((repo) => repo?.full_name || (repo?.slug ? `${slug}/${repo.slug}` : ''))
    .filter(Boolean);

  const prBatches = await runWithConcurrency(repoNames, 8, async (repoFullName) => {
    try {
      return await fetchAllPages(
        `${BITBUCKET_API_BASE}/repositories/${encodeRepoPath(repoFullName)}/pullrequests?state=OPEN&pagelen=50&fields=${encodeURIComponent(PR_FIELDS)}`,
        headers,
        fetchFn
      );
    } catch (err) {
      if (
        err instanceof BitbucketApiError &&
        (err.status === 401 || err.status === 429)
      ) {
        throw err;
      }
      return [];
    }
  });

  return prBatches.flat();
}

async function fetchWorkspacePullRequests(slug, userId, headers, fetchFn) {
  let workspacePrs = [];
  let workspaceErr = null;

  if (userId) {
    const workspacePrUrl = `${BITBUCKET_API_BASE}/workspaces/${encodeURIComponent(
      slug
    )}/pullrequests/${encodeURIComponent(
      userId
    )}?state=OPEN&pagelen=50&fields=${encodeURIComponent(PR_FIELDS)}`;

    try {
      workspacePrs = await fetchAllPages(workspacePrUrl, headers, fetchFn);
    } catch (err) {
      if (err instanceof BitbucketApiError && (err.status === 404 || err.status === 403)) {
        workspaceErr = err;
      } else {
        throw err;
      }
    }
  }

  let repoPrs = [];
  try {
    repoPrs = await fetchWorkspacePrsViaRepos(slug, headers, fetchFn);
  } catch (err) {
    if (err instanceof BitbucketApiError && (err.status === 401 || err.status === 429)) {
      throw err;
    }
    if (workspaceErr || !userId) {
      throw err;
    }
    // If workspace-level PRs succeeded and repo listing isn't available/mocked, keep workspacePrs.
  }

  return [...workspacePrs, ...repoPrs];
}

function deduplicatePullRequests(rawPrs) {
  const byKey = new Map();

  for (const pr of rawPrs) {
    if (!pr || pr.id == null) continue;
    const repoFullName = getRepoFullName(pr);
    const dedupeKey = repoFullName
      ? `${repoFullName}#${pr.id}`
      : pr?.links?.html?.href || String(pr.id);

    const existing = byKey.get(dedupeKey);
    if (!existing || (!Array.isArray(existing.participants) && Array.isArray(pr.participants))) {
      byKey.set(dedupeKey, pr);
    }
  }

  return Array.from(byKey.values());
}

async function hydrateMissingParticipants(rawPrs, headers, fetchFn) {
  return runWithConcurrency(rawPrs, 5, async (pr) => {
    if (Array.isArray(pr.participants)) {
      return pr;
    }

    const repoFullName = getRepoFullName(pr);
    if (!repoFullName || pr.id == null) {
      return pr;
    }

    const detailUrl = `${BITBUCKET_API_BASE}/repositories/${encodeRepoPath(
      repoFullName
    )}/pullrequests/${encodeURIComponent(String(pr.id))}`;

    try {
      const response = await executeFetch(detailUrl, headers, fetchFn);
      if (!response.ok) {
        return pr;
      }
      const detailed = await response.json();
      return detailed && typeof detailed === 'object' ? { ...pr, ...detailed } : pr;
    } catch {
      return pr;
    }
  });
}

/**
 * Fetches, hydrates, normalizes, and partitions open Bitbucket pull requests
 * relevant to the authenticated user.
 */
export async function fetchOpenPullRequests(credentials, fetchFn = fetch) {
  const headers = buildAuthHeaders(credentials);
  const currentUser = await verifyCredentials(credentials, fetchFn);
  const slugs = await discoverWorkspaceSlugs(headers, fetchFn);
  const userId = currentUser.accountId || currentUser.uuid;

  const workspacePrBatches = await runWithConcurrency(slugs, 5, (slug) =>
    fetchWorkspacePullRequests(slug, userId, headers, fetchFn)
  );

  const deduplicated = deduplicatePullRequests(workspacePrBatches.flat());
  const hydrated = await hydrateMissingParticipants(deduplicated, headers, fetchFn);

  const prs = hydrated.map((pr) => normalizePullRequest(pr, currentUser));
  const { myPrs, toReviewPrs, pendingReviewCount } = partitionPullRequests(prs);

  return {
    user: currentUser,
    prs,
    myPrs,
    toReviewPrs,
    pendingReviewCount,
    workspaceCount: slugs.length,
    lastUpdated: new Date().toISOString(),
  };
}
