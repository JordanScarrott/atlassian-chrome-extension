import {
  CACHE_TTL_MS,
  CENTRAL_URLS,
  THROTTLE_CONFIG,
  getEffectiveGitHubApiBaseUrl,
  sanitizeHttpsUrl
} from './config.js';
import {
  RequestTimeoutError,
  fetchWithTimeout,
  parseRetryAfterMs,
  runWithConcurrency
} from './throttler.js';

/**
 * @typedef {'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT' | 'NETWORK' | 'BAD_CONFIG' | 'API_ERROR'} GitHubErrorCode
 */

/**
 * @typedef {Object} VerifyGitHubCredentialsResult
 * @property {import('./storage.js').CachedUser} user
 * @property {boolean} nearLimit
 */

/**
 * @typedef {Object} GitHubPartialFetchError
 * @property {string} scope
 * @property {string} message
 * @property {number | null} status
 */

/**
 * @typedef {Object} FetchGitHubPullRequestsResult
 * @property {import('./storage.js').PullRequestRecord[]} prs
 * @property {import('./storage.js').CachedUser} user
 * @property {boolean} nearLimit
 * @property {GitHubPartialFetchError[]} partialErrors
 */

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_ACCEPT_HEADER = 'application/vnd.github+json';
const NEAR_LIMIT_REMAINING_THRESHOLD = 20;
const MAX_DESCRIPTION_CHARS = 500;

/** @type {ReadonlySet<import('./storage.js').BuildState>} */
const TERMINAL_BUILD_STATES = new Set(['SUCCESSFUL', 'FAILED', 'STOPPED']);

/**
 * Sanitized GitHub API / network error matching `BitbucketApiError` shape.
 * Never embeds raw API response bodies or credentials.
 */
export class GitHubApiError extends Error {
  /**
   * @param {{
   *   status: number,
   *   code: GitHubErrorCode,
   *   message: string,
   *   retryAfter: number | null,
   *   isTransient: boolean,
   *   isAuthError: boolean
   * }} details
   */
  constructor({ status, code, message, retryAfter, isTransient, isAuthError }) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.isTransient = isTransient;
    this.isAuthError = isAuthError;
  }
}

/**
 * Parse GitHub `X-RateLimit-Reset` (Unix epoch seconds) into delay milliseconds from `now`.
 *
 * @param {string | null | undefined} resetHeader
 * @param {number} now
 * @returns {number | null}
 */
function parseRateLimitResetMs(resetHeader, now) {
  if (typeof resetHeader !== 'string') {
    return null;
  }
  const trimmed = resetHeader.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const resetEpochMs = Number.parseInt(trimmed, 10) * 1000;
  if (!Number.isFinite(resetEpochMs)) {
    return null;
  }
  const delta = Math.max(0, resetEpochMs - now);
  return Math.min(delta, THROTTLE_CONFIG.maxBackoffMs);
}

/**
 * Resolve and validate the GitHub API base URL for requests.
 * Rejects explicitly provided non-HTTPS URLs with `BAD_CONFIG` so tokens are never
 * redirected to an unintended host.
 *
 * @param {string | null | undefined} overrideUrl
 * @returns {string}
 */
function resolveGitHubApiBaseOrThrow(overrideUrl) {
  const raw = typeof overrideUrl === 'string' ? overrideUrl.trim() : '';
  if (raw && !sanitizeHttpsUrl(raw)) {
    throw new GitHubApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'GitHub API Base URL must be a valid https:// URL.',
      retryAfter: null,
      isTransient: false,
      isAuthError: false
    });
  }
  return getEffectiveGitHubApiBaseUrl(raw);
}

/**
 * Derive a GitHub Web base URL from an API base URL for fallback PR links.
 *
 * @param {string} apiBaseUrl
 * @returns {string}
 */
function deriveGitHubWebBase(apiBaseUrl) {
  const defaultWeb = getNormalizedWebBase(CENTRAL_URLS.GITHUB_WEB_BASE_URL) || 'https://github.com';
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.hostname === 'api.github.com') {
      return defaultWeb;
    }
    const cleanPath = parsed.pathname.replace(/\/api\/v3\/?$/i, '').replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return defaultWeb;
  }
}

/**
 * @param {unknown} rawUrl
 * @returns {string}
 */
function getNormalizedWebBase(rawUrl) {
  const safe = sanitizeHttpsUrl(rawUrl);
  if (!safe) {
    return '';
  }
  const parsed = new URL(safe);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Map an HTTP status & GitHub response headers into a sanitized `GitHubApiError`.
 *
 * @param {number} status
 * @param {Headers | { get?: (name: string) => string | null } | null | undefined} headers
 * @param {number} [now]
 * @returns {GitHubApiError}
 */
export function mapGitHubHttpStatusToError(status, headers, now = Date.now()) {
  const getHeader = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  const retryHeader = getHeader('retry-after');
  const remainingHeader = getHeader('x-ratelimit-remaining');
  const resetHeader = getHeader('x-ratelimit-reset');

  const retryAfterFromHeader = parseRetryAfterMs(retryHeader, now);
  const retryAfterFromReset = parseRateLimitResetMs(resetHeader, now);
  const retryAfter = retryAfterFromHeader ?? retryAfterFromReset;

  const isRemainingExhausted = typeof remainingHeader === 'string' && remainingHeader.trim() === '0';
  const hasRetrySignal = Boolean(retryHeader && retryHeader.trim());

  if (status === 401) {
    return new GitHubApiError({
      status,
      code: 'UNAUTHORIZED',
      message: 'GitHub authentication failed (401). Check your Personal Access Token in Settings.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  if (status === 403 && (isRemainingExhausted || hasRetrySignal)) {
    return new GitHubApiError({
      status,
      code: 'RATE_LIMITED',
      message: 'GitHub API rate limit reached (403). Polling has been temporarily paused.',
      retryAfter,
      isTransient: true,
      isAuthError: false
    });
  }

  if (status === 403) {
    return new GitHubApiError({
      status,
      code: 'FORBIDDEN',
      message: 'GitHub access denied (403). Verify your token has repo or Pull requests: Read permissions.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  if (status === 404) {
    return new GitHubApiError({
      status,
      code: 'NOT_FOUND',
      message: 'Requested GitHub resource was not found (404).',
      retryAfter: null,
      isTransient: false,
      isAuthError: false
    });
  }

  if (status === 429) {
    return new GitHubApiError({
      status,
      code: 'RATE_LIMITED',
      message: 'GitHub API rate limit reached (429). Polling has been temporarily paused.',
      retryAfter,
      isTransient: true,
      isAuthError: false
    });
  }

  if (status >= 500) {
    return new GitHubApiError({
      status,
      code: 'SERVER_ERROR',
      message: `GitHub API is temporarily unavailable (${status}). Will retry automatically.`,
      retryAfter: retryAfterFromHeader,
      isTransient: true,
      isAuthError: false
    });
  }

  return new GitHubApiError({
    status,
    code: 'API_ERROR',
    message: `GitHub API returned unexpected status ${status}.`,
    retryAfter: null,
    isTransient: false,
    isAuthError: false
  });
}

/**
 * Extract `{ owner, repo, number }` from a GitHub Search Issues item.
 *
 * @param {any} item
 * @returns {{ owner: string, repo: string, number: number } | null}
 */
function parseSearchIssueRepoAndNumber(item) {
  if (!item || typeof item !== 'object' || typeof item.number !== 'number' || item.number <= 0) {
    return null;
  }

  if (typeof item.repository_url === 'string') {
    const match = item.repository_url.match(/\/repos\/([^/]+)\/([^/]+)\/?$/);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        number: item.number
      };
    }
  }

  const safeHtml = sanitizeHttpsUrl(item.html_url);
  if (safeHtml) {
    const parsed = new URL(safeHtml);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 4 && parts[2] === 'pull') {
      return {
        owner: parts[0],
        repo: parts[1],
        number: item.number
      };
    }
  }

  return null;
}

/**
 * Collapse GitHub PR reviews into latest decisive review per non-author reviewer.
 * Decisive states: `'APPROVED'` -> `'approved'`, `'CHANGES_REQUESTED'` -> `'changes_requested'`.
 * `'DISMISSED'` clears a reviewer's earlier decisive vote; `'COMMENTED'` / `'PENDING'` do not
 * override an existing decisive review.
 *
 * @param {readonly any[]} rawReviews
 * @param {string} authorUuid
 * @returns {import('./storage.js').PrParticipant[]}
 */
export function collapseGitHubReviews(rawReviews, authorUuid = '') {
  if (!Array.isArray(rawReviews) || rawReviews.length === 0) {
    return [];
  }

  /** @type {Map<string, { participant: import('./storage.js').PrParticipant, submittedMs: number }>} */
  const byReviewer = new Map();

  for (const review of rawReviews) {
    if (!review || typeof review !== 'object' || !review.user) {
      continue;
    }
    const rawId = review.user.id;
    if (typeof rawId !== 'number' && typeof rawId !== 'string') {
      continue;
    }
    const uuid = `gh:${rawId}`;
    if (authorUuid && uuid === authorUuid) {
      continue;
    }

    const rawState = typeof review.state === 'string' ? review.state.toUpperCase() : '';
    const submittedMs = typeof review.submitted_at === 'string' && review.submitted_at
      ? Date.parse(review.submitted_at)
      : Number.NaN;
    const effectiveMs = Number.isNaN(submittedMs) ? -1 : submittedMs;

    const prevEntry = byReviewer.get(uuid);
    if (prevEntry && effectiveMs >= 0 && prevEntry.submittedMs >= 0 && effectiveMs < prevEntry.submittedMs) {
      continue;
    }

    if (rawState === 'DISMISSED') {
      byReviewer.delete(uuid);
      continue;
    }

    if (rawState !== 'APPROVED' && rawState !== 'CHANGES_REQUESTED') {
      continue;
    }

    const displayName = (typeof review.user.name === 'string' && review.user.name.trim())
      ? review.user.name.trim()
      : (typeof review.user.login === 'string' && review.user.login.trim() ? review.user.login.trim() : 'Reviewer');

    /** @type {'approved' | 'changes_requested'} */
    const normalizedState = rawState === 'APPROVED' ? 'approved' : 'changes_requested';

    byReviewer.set(uuid, {
      submittedMs: effectiveMs,
      participant: {
        uuid,
        displayName,
        role: 'REVIEWER',
        approved: normalizedState === 'approved',
        state: normalizedState
      }
    });
  }

  return Array.from(byReviewer.values(), (entry) => entry.participant);
}

/**
 * Map GitHub combined commit status payload (`/commits/:sha/status`) into `BuildStatusSummary`.
 * Precedence: `FAILED` (`failure`/`error`) > `INPROGRESS` (`pending`) > `SUCCESSFUL` (`success`).
 *
 * @param {any} payload
 * @param {string} [commitHash]
 * @param {number} [now]
 * @returns {import('./storage.js').BuildStatusSummary | null}
 */
export function aggregateGitHubCommitStatus(payload, commitHash = '', now = Date.now()) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const statuses = Array.isArray(payload.statuses) ? payload.statuses : [];
  let passedCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;

  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string } | null} */
  let primaryFailed = null;
  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string } | null} */
  let primaryInProgress = null;
  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string, updatedMs: number } | null} */
  let latestSuccessful = null;
  let latestUpdatedOn = '';
  let latestUpdatedMs = -1;

  for (const raw of statuses) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const rawState = typeof raw.state === 'string' ? raw.state.toLowerCase() : '';
    const name = typeof raw.context === 'string' && raw.context.trim() ? raw.context.trim() : '';
    const url = sanitizeHttpsUrl(raw.target_url);
    const updatedOn = typeof raw.updated_at === 'string' ? raw.updated_at : '';
    const parsedMs = updatedOn ? Date.parse(updatedOn) : Number.NaN;
    const updatedMs = Number.isNaN(parsedMs) ? -1 : parsedMs;

    if (updatedOn && updatedMs > latestUpdatedMs) {
      latestUpdatedMs = updatedMs;
      latestUpdatedOn = updatedOn;
    }

    if (rawState === 'failure' || rawState === 'error') {
      failedCount += 1;
      if (!primaryFailed) {
        primaryFailed = { state: 'FAILED', name, url, updatedOn };
      } else if (!primaryFailed.url && url) {
        primaryFailed.url = url;
      }
    } else if (rawState === 'pending') {
      inProgressCount += 1;
      if (!primaryInProgress) {
        primaryInProgress = { state: 'INPROGRESS', name, url, updatedOn };
      } else if (!primaryInProgress.url && url) {
        primaryInProgress.url = url;
      }
    } else if (rawState === 'success') {
      passedCount += 1;
      if (!latestSuccessful || updatedMs > latestSuccessful.updatedMs) {
        latestSuccessful = { state: 'SUCCESSFUL', name, url, updatedOn, updatedMs };
      } else if (updatedMs === latestSuccessful.updatedMs && !latestSuccessful.url && url) {
        latestSuccessful.url = url;
      }
    }
  }

  const totalFromStatuses = passedCount + failedCount + inProgressCount;
  if (totalFromStatuses > 0) {
    const chosen = primaryFailed ?? primaryInProgress ?? /** @type {NonNullable<typeof latestSuccessful>} */ (latestSuccessful);
    return {
      state: chosen.state,
      totalCount: totalFromStatuses,
      passedCount,
      failedCount,
      inProgressCount,
      stoppedCount: 0,
      url: chosen.url,
      name: chosen.name,
      updatedOn: latestUpdatedOn || chosen.updatedOn,
      commitHash: typeof commitHash === 'string' ? commitHash.trim() : '',
      cachedAt: now
    };
  }

  // When GitHub returns total_count: 0 and empty statuses, there are no checks configured.
  const declaredTotal = typeof payload.total_count === 'number' ? payload.total_count : 0;
  if (declaredTotal <= 0) {
    return null;
  }

  const overallRaw = typeof payload.state === 'string' ? payload.state.toLowerCase() : '';
  /** @type {import('./storage.js').BuildState | null} */
  const mappedOverall = overallRaw === 'success'
    ? 'SUCCESSFUL'
    : (overallRaw === 'failure' || overallRaw === 'error')
      ? 'FAILED'
      : overallRaw === 'pending'
        ? 'INPROGRESS'
        : null;

  if (!mappedOverall) {
    return null;
  }

  return {
    state: mappedOverall,
    totalCount: declaredTotal,
    passedCount: mappedOverall === 'SUCCESSFUL' ? declaredTotal : 0,
    failedCount: mappedOverall === 'FAILED' ? declaredTotal : 0,
    inProgressCount: mappedOverall === 'INPROGRESS' ? declaredTotal : 0,
    stoppedCount: 0,
    url: null,
    name: 'Checks',
    updatedOn: '',
    commitHash: typeof commitHash === 'string' ? commitHash.trim() : '',
    cachedAt: now
  };
}

/**
 * Determine whether a cached commit status is still fresh.
 *
 * @param {import('./storage.js').BuildStatusSummary | undefined | null} cached
 * @param {number} now
 * @returns {boolean}
 */
function isBuildStatusCacheFresh(cached, now) {
  if (!cached) {
    return false;
  }
  const ageMs = Math.max(0, now - cached.cachedAt);
  if (TERMINAL_BUILD_STATES.has(cached.state)) {
    return ageMs < CACHE_TTL_MS.buildStatusTerminal;
  }
  if (cached.state === 'INPROGRESS') {
    return ageMs < CACHE_TTL_MS.buildStatusActive;
  }
  return false;
}

/**
 * Normalize a GitHub PR detail payload (+ reviews + commit status) into `PullRequestRecord`.
 *
 * @param {{
 *   owner: string,
 *   repo: string,
 *   number: number,
 *   detail: any,
 *   searchItem?: any,
 *   reviews?: readonly any[],
 *   buildStatus?: import('./storage.js').BuildStatusSummary | null,
 *   webBaseUrl?: string
 * }} params
 * @returns {import('./storage.js').PullRequestRecord}
 */
export function normalizeGitHubPullRequest({
  owner,
  repo,
  number,
  detail,
  searchItem,
  reviews = [],
  buildStatus = null,
  webBaseUrl = CENTRAL_URLS.GITHUB_WEB_BASE_URL
}) {
  const source = detail && typeof detail === 'object' ? detail : {};
  const fallback = searchItem && typeof searchItem === 'object' ? searchItem : {};
  const repoFullName = `${owner}/${repo}`;
  const key = `gh:${repoFullName}#${number}`;

  const rawAuthor = source.user && typeof source.user === 'object'
    ? source.user
    : (fallback.user && typeof fallback.user === 'object' ? fallback.user : null);
  const authorId = rawAuthor && (typeof rawAuthor.id === 'number' || typeof rawAuthor.id === 'string')
    ? String(rawAuthor.id)
    : '';
  const authorUuid = authorId ? `gh:${authorId}` : '';
  const authorName = rawAuthor
    ? ((typeof rawAuthor.name === 'string' && rawAuthor.name.trim())
      ? rawAuthor.name.trim()
      : (typeof rawAuthor.login === 'string' && rawAuthor.login.trim() ? rawAuthor.login.trim() : 'Unknown Author'))
    : 'Unknown Author';

  const normalizedWebBase = getNormalizedWebBase(webBaseUrl) || 'https://github.com';
  const fallbackUrl = `${normalizedWebBase}/${owner}/${repo}/pull/${number}`;
  const url = sanitizeHttpsUrl(source.html_url) || sanitizeHttpsUrl(fallback.html_url) || fallbackUrl;

  const rawTitle = typeof source.title === 'string' && source.title.trim()
    ? source.title.trim()
    : (typeof fallback.title === 'string' && fallback.title.trim() ? fallback.title.trim() : `PR #${number}`);

  const rawBody = typeof source.body === 'string'
    ? source.body
    : (typeof fallback.body === 'string' ? fallback.body : '');
  const description = rawBody.slice(0, MAX_DESCRIPTION_CHARS);

  /** @type {import('./storage.js').PrReviewer[]} */
  const reviewers = Array.isArray(source.requested_reviewers)
    ? source.requested_reviewers
      .filter((r) => r && (typeof r.id === 'number' || typeof r.id === 'string'))
      .map((r) => ({
        uuid: `gh:${r.id}`,
        displayName: (typeof r.name === 'string' && r.name.trim())
          ? r.name.trim()
          : (typeof r.login === 'string' && r.login.trim() ? r.login.trim() : 'Reviewer')
      }))
    : [];

  const participants = collapseGitHubReviews(reviews, authorUuid);

  const commentsCount = typeof source.comments === 'number' ? source.comments : 0;
  const reviewCommentsCount = typeof source.review_comments === 'number' ? source.review_comments : 0;
  const sha = typeof source.head?.sha === 'string' ? source.head.sha.trim() : '';
  const createdOn = typeof source.created_at === 'string'
    ? source.created_at
    : (typeof fallback.created_at === 'string' ? fallback.created_at : '');
  const updatedOn = typeof source.updated_at === 'string'
    ? source.updated_at
    : (typeof fallback.updated_at === 'string' ? fallback.updated_at : createdOn);

  return {
    provider: 'github',
    key,
    id: number,
    title: rawTitle,
    description,
    state: typeof source.state === 'string' && source.state ? source.state.toUpperCase() : 'OPEN',
    url,
    repoFullName,
    repoName: repo,
    workspace: owner,
    authorUuid,
    authorName,
    sourceBranch: typeof source.head?.ref === 'string' ? source.head.ref : '',
    destinationBranch: typeof source.base?.ref === 'string' ? source.base.ref : '',
    createdOn,
    updatedOn,
    commentCount: commentsCount + reviewCommentsCount,
    taskCount: 0,
    draft: Boolean(source.draft ?? fallback.draft),
    reviewers,
    participants,
    ...(sha ? { sourceCommitHash: sha } : {}),
    buildStatus: buildStatus ?? null
  };
}

/**
 * Create a GitHub REST API v3 client with injectable `fetchFn` and `nowFn`.
 * Works with github.com and GitHub Enterprise Server (`apiBaseUrl`).
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   nowFn?: () => number
 * }} [deps]
 */
export function createGitHubClient({
  fetchFn = fetch,
  nowFn = Date.now
} = {}) {
  /**
   * Perform an authenticated GET request against the GitHub REST API.
   *
   * @param {string} url
   * @param {string} token
   * @returns {Promise<{ data: any, nearLimit: boolean }>}
   */
  async function requestJson(url, token) {
    let response;
    try {
      response = await fetchWithTimeout(
        fetchFn,
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: GITHUB_ACCEPT_HEADER,
            'X-GitHub-Api-Version': GITHUB_API_VERSION
          }
        },
        THROTTLE_CONFIG.requestTimeoutMs
      );
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        throw new GitHubApiError({
          status: 0,
          code: 'TIMEOUT',
          message: 'GitHub API request timed out. Please check your connection and try again.',
          retryAfter: null,
          isTransient: true,
          isAuthError: false
        });
      }
      throw new GitHubApiError({
        status: 0,
        code: 'NETWORK',
        message: 'Could not reach GitHub API. Check your network connection.',
        retryAfter: null,
        isTransient: true,
        isAuthError: false
      });
    }

    const remainingHeader = response.headers?.get?.('x-ratelimit-remaining');
    const parsedRemaining = typeof remainingHeader === 'string' && /^\d+$/.test(remainingHeader.trim())
      ? Number.parseInt(remainingHeader.trim(), 10)
      : Number.NaN;
    const nearLimit = Number.isFinite(parsedRemaining) && parsedRemaining < NEAR_LIMIT_REMAINING_THRESHOLD;

    if (!response.ok) {
      throw mapGitHubHttpStatusToError(response.status, response.headers, nowFn());
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new GitHubApiError({
        status: response.status,
        code: 'API_ERROR',
        message: 'Received an unreadable response from GitHub API.',
        retryAfter: null,
        isTransient: true,
        isAuthError: false
      });
    }

    return { data, nearLimit };
  }

  /**
   * Validate token and fetch `/user`.
   *
   * @param {Partial<import('./storage.js').GitHubCredentials>} creds
   * @returns {Promise<{ user: import('./storage.js').CachedUser, nearLimit: boolean, apiBaseUrl: string }>}
   */
  async function fetchCurrentUser(creds) {
    const token = typeof creds?.token === 'string' ? creds.token.trim() : '';
    if (!token) {
      throw new GitHubApiError({
        status: 0,
        code: 'BAD_CONFIG',
        message: 'GitHub Personal Access Token is missing. Configure it in Settings.',
        retryAfter: null,
        isTransient: false,
        isAuthError: true
      });
    }

    const apiBaseUrl = resolveGitHubApiBaseOrThrow(creds?.apiBaseUrl);
    const { data, nearLimit } = await requestJson(`${apiBaseUrl}/user`, token);

    if (
      !data ||
      (typeof data.id !== 'number' && typeof data.id !== 'string') ||
      typeof data.login !== 'string' ||
      !data.login
    ) {
      throw new GitHubApiError({
        status: 200,
        code: 'API_ERROR',
        message: 'GitHub user profile response did not include a user ID and login.',
        retryAfter: null,
        isTransient: false,
        isAuthError: false
      });
    }

    const displayName = (typeof data.name === 'string' && data.name.trim())
      ? data.name.trim()
      : data.login;

    return {
      user: {
        uuid: `gh:${data.id}`,
        accountId: String(data.id),
        displayName,
        username: data.login,
        avatarUrl: sanitizeHttpsUrl(data.avatar_url),
        cachedAt: nowFn()
      },
      nearLimit,
      apiBaseUrl
    };
  }

  /**
   * Verify GitHub Personal Access Token credentials against `GET ${base}/user`.
   *
   * @param {Partial<import('./storage.js').GitHubCredentials>} creds
   * @returns {Promise<VerifyGitHubCredentialsResult>}
   */
  async function verifyCredentials(creds) {
    const { user, nearLimit } = await fetchCurrentUser(creds);
    return { user, nearLimit };
  }

  /**
   * Determine if a GitHub API error is fatal and must abort the PR fetch rather than
   * returning partial/empty results.
   *
   * @param {unknown} err
   * @param {{ allowForbidden?: boolean }} [options]
   * @returns {boolean}
   */
  function isFatalError(err, options = {}) {
    const allowForbidden = Boolean(options.allowForbidden);
    if (err instanceof GitHubApiError) {
      if (err.status === 401 || err.status === 429) {
        return true;
      }
      if (err.code === 'RATE_LIMITED') {
        return true;
      }
      if (err.status === 403) {
        return !allowForbidden;
      }
      if (err.isAuthError) {
        return true;
      }
      if (err.code === 'TIMEOUT' || err.code === 'NETWORK' || err.status >= 500) {
        return true;
      }
      return false;
    }
    return false;
  }

  /**
   * Fetch open authored, review-requested, and reviewed-by pull requests across GitHub.
   *
   * @param {{
   *   creds: Partial<import('./storage.js').GitHubCredentials>,
   *   storage: ReturnType<import('./storage.js').createStorage>,
   *   preferences?: import('./config.js').Preferences,
   *   forceRefreshCache?: boolean
   * }} params
   * @returns {Promise<FetchGitHubPullRequestsResult>}
   */
  async function fetchPullRequests({ creds, storage, forceRefreshCache = false }) {
    const token = typeof creds?.token === 'string' ? creds.token.trim() : '';
    if (!token) {
      throw new GitHubApiError({
        status: 0,
        code: 'BAD_CONFIG',
        message: 'GitHub Personal Access Token is missing. Configure it in Settings.',
        retryAfter: null,
        isTransient: false,
        isAuthError: true
      });
    }

    const apiBaseUrl = resolveGitHubApiBaseOrThrow(creds?.apiBaseUrl);
    const webBaseUrl = deriveGitHubWebBase(apiBaseUrl);
    const now = nowFn();
    let nearLimit = false;
    /** @type {GitHubPartialFetchError[]} */
    const partialErrors = [];

    // 1. User profile (24h cache)
    let user = forceRefreshCache ? null : await storage.getCachedGitHubUser();
    if (!user || now - user.cachedAt >= CACHE_TTL_MS.userProfile) {
      const fetched = await fetchCurrentUser({ token, apiBaseUrl });
      user = fetched.user;
      if (fetched.nearLimit) {
        nearLimit = true;
      }
      await storage.setCachedGitHubUser(user);
    }

    // 2. Run 3 GitHub Search Issues queries in parallel (authored, review-requested, reviewed-by)
    const searchSpecs = [
      { label: 'authored', q: 'is:pr+is:open+author:@me' },
      { label: 'review-requested', q: 'is:pr+is:open+review-requested:@me' },
      { label: 'reviewed-by', q: 'is:pr+is:open+reviewed-by:@me' }
    ];

    const searchOutcomes = await runWithConcurrency(
      searchSpecs,
      THROTTLE_CONFIG.maxConcurrentRequests,
      async (spec) => {
        const url = `${apiBaseUrl}/search/issues?q=${spec.q}&per_page=50`;
        return requestJson(url, token);
      },
      { isolateErrors: true }
    );

    /** @type {Map<string, { owner: string, repo: string, number: number, item: any }>} */
    const discoveredPrs = new Map();
    let successfulSearches = 0;
    /** @type {unknown} */
    let firstSearchError = null;

    for (let i = 0; i < searchOutcomes.length; i += 1) {
      const outcome = /** @type {{ status: 'fulfilled', value: { data: any, nearLimit: boolean } } | { status: 'rejected', reason: unknown }} */ (
        /** @type {unknown} */ (searchOutcomes[i])
      );
      const spec = searchSpecs[i];
      if (outcome.status === 'fulfilled') {
        successfulSearches += 1;
        if (outcome.value.nearLimit) {
          nearLimit = true;
        }
        const items = Array.isArray(outcome.value.data?.items) ? outcome.value.data.items : [];
        for (const item of items) {
          const parsed = parseSearchIssueRepoAndNumber(item);
          if (!parsed) {
            continue;
          }
          const key = `gh:${parsed.owner}/${parsed.repo}#${parsed.number}`;
          if (!discoveredPrs.has(key)) {
            discoveredPrs.set(key, { ...parsed, item });
          }
        }
      } else {
        const reason = outcome.reason;
        if (isFatalError(reason)) {
          throw reason;
        }
        firstSearchError = firstSearchError ?? reason;
        partialErrors.push({
          scope: `github search (${spec.label})`,
          message: reason instanceof Error ? reason.message : 'GitHub search query failed.',
          status: reason instanceof GitHubApiError ? reason.status : null
        });
      }
    }

    if (successfulSearches === 0 && firstSearchError) {
      throw firstSearchError instanceof Error
        ? firstSearchError
        : new GitHubApiError({
          status: partialErrors[0]?.status ?? 0,
          code: 'API_ERROR',
          message: partialErrors[0]?.message || 'GitHub search failed.',
          retryAfter: null,
          isTransient: false,
          isAuthError: false
        });
    }

    if (discoveredPrs.size === 0) {
      return { prs: [], user, nearLimit, partialErrors };
    }

    // 3. Load shared build status cache once before concurrent enrichment
    let cachedStatuses = /** @type {import('./storage.js').BuildStatusCacheMap} */ ({});
    try {
      cachedStatuses = await storage.getCachedBuildStatuses();
    } catch {
      cachedStatuses = {};
    }
    const nextStatusCache = { ...cachedStatuses };
    let cacheMutated = false;

    const entries = Array.from(discoveredPrs.values());
    const enrichOutcomes = await runWithConcurrency(
      entries,
      THROTTLE_CONFIG.maxConcurrentRequests,
      async (entry) => {
        const repoPath = `${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}`;
        const prUrl = `${apiBaseUrl}/repos/${repoPath}/pulls/${entry.number}`;
        const detailRes = await requestJson(prUrl, token);
        if (detailRes.nearLimit) {
          nearLimit = true;
        }

        const detail = detailRes.data;
        /** @type {any[]} */
        let reviews = [];
        try {
          const reviewsUrl = `${apiBaseUrl}/repos/${repoPath}/pulls/${entry.number}/reviews?per_page=50`;
          const reviewsRes = await requestJson(reviewsUrl, token);
          if (reviewsRes.nearLimit) {
            nearLimit = true;
          }
          if (Array.isArray(reviewsRes.data)) {
            reviews = reviewsRes.data;
          }
        } catch (reviewErr) {
          if (reviewErr instanceof GitHubApiError && (reviewErr.status === 401 || reviewErr.code === 'RATE_LIMITED')) {
            if (reviewErr.code === 'RATE_LIMITED') {
              nearLimit = true;
            }
            if (reviewErr.status === 401) {
              throw reviewErr;
            }
          }
          partialErrors.push({
            scope: `gh:${entry.owner}/${entry.repo}#${entry.number} (reviews)`,
            message: reviewErr instanceof Error ? reviewErr.message : 'Failed to fetch PR reviews.',
            status: reviewErr instanceof GitHubApiError ? reviewErr.status : null
          });
        }

        const sha = typeof detail?.head?.sha === 'string' ? detail.head.sha.trim() : '';
        const cacheKey = sha ? `gh:${entry.owner}/${entry.repo}:${sha}` : null;
        const cachedStatus = cacheKey ? (nextStatusCache[cacheKey] ?? null) : null;
        /** @type {import('./storage.js').BuildStatusSummary | null} */
        let buildStatus = null;
        let fetchedNewStatus = false;

        if (sha) {
          const statusNow = nowFn();
          if (!forceRefreshCache && cachedStatus && isBuildStatusCacheFresh(cachedStatus, statusNow)) {
            buildStatus = cachedStatus;
          } else if (nearLimit) {
            buildStatus = cachedStatus;
          } else {
            try {
              const statusUrl = `${apiBaseUrl}/repos/${repoPath}/commits/${encodeURIComponent(sha)}/status`;
              const statusRes = await requestJson(statusUrl, token);
              if (statusRes.nearLimit) {
                nearLimit = true;
              }
              buildStatus = aggregateGitHubCommitStatus(statusRes.data, sha, nowFn());
              fetchedNewStatus = Boolean(buildStatus);
            } catch (statusErr) {
              if (statusErr instanceof GitHubApiError && (statusErr.status === 429 || statusErr.code === 'RATE_LIMITED')) {
                nearLimit = true;
              }
              buildStatus = cachedStatus;
              partialErrors.push({
                scope: `gh:${entry.owner}/${entry.repo}#${entry.number} (statuses)`,
                message: statusErr instanceof Error ? statusErr.message : 'Failed to fetch commit status.',
                status: statusErr instanceof GitHubApiError ? statusErr.status : null
              });
            }
          }
        }

        const normalized = normalizeGitHubPullRequest({
          owner: entry.owner,
          repo: entry.repo,
          number: entry.number,
          detail,
          searchItem: entry.item,
          reviews,
          buildStatus,
          webBaseUrl
        });

        return {
          pr: normalized,
          cacheKey: fetchedNewStatus ? cacheKey : null,
          statusToCache: fetchedNewStatus ? buildStatus : null
        };
      },
      { isolateErrors: true }
    );

    /** @type {import('./storage.js').PullRequestRecord[]} */
    const prs = [];
    let successfulEnrichments = 0;
    /** @type {unknown} */
    let firstEnrichError = null;

    for (let i = 0; i < enrichOutcomes.length; i += 1) {
      const outcome = /** @type {{ status: 'fulfilled', value: { pr: import('./storage.js').PullRequestRecord, cacheKey: string | null, statusToCache: import('./storage.js').BuildStatusSummary | null } } | { status: 'rejected', reason: unknown }} */ (
        /** @type {unknown} */ (enrichOutcomes[i])
      );
      const entry = entries[i];

      if (outcome.status === 'fulfilled') {
        successfulEnrichments += 1;
        prs.push(outcome.value.pr);
        if (outcome.value.cacheKey && outcome.value.statusToCache) {
          nextStatusCache[outcome.value.cacheKey] = outcome.value.statusToCache;
          cacheMutated = true;
        }
      } else {
        const reason = outcome.reason;
        if (isFatalError(reason, { allowForbidden: true })) {
          throw reason;
        }
        firstEnrichError = firstEnrichError ?? reason;
        partialErrors.push({
          scope: `gh:${entry.owner}/${entry.repo}#${entry.number}`,
          message: reason instanceof Error ? reason.message : 'Failed to fetch GitHub PR details.',
          status: reason instanceof GitHubApiError ? reason.status : null
        });
      }
    }

    if (successfulEnrichments === 0 && firstEnrichError) {
      throw firstEnrichError instanceof Error
        ? firstEnrichError
        : new GitHubApiError({
          status: partialErrors[0]?.status ?? 0,
          code: 'API_ERROR',
          message: partialErrors[0]?.message || 'Failed to fetch GitHub pull requests.',
          retryAfter: null,
          isTransient: false,
          isAuthError: false
        });
    }

    if (cacheMutated) {
      try {
        await storage.setCachedBuildStatuses(nextStatusCache);
      } catch {
        // Non-fatal cache write failure
      }
    }

    return {
      prs,
      user,
      nearLimit,
      partialErrors
    };
  }

  return {
    verifyCredentials,
    fetchPullRequests
  };
}
