import {
  CACHE_TTL_MS,
  CENTRAL_URLS,
  THROTTLE_CONFIG,
  sanitizeHttpsUrl
} from './config.js';
import { normalizeAuthType } from './storage.js';
import {
  RequestTimeoutError,
  fetchWithTimeout,
  parseRetryAfterMs,
  runWithConcurrency
} from './throttler.js';

/**
 * @typedef {'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'TIMEOUT' | 'NETWORK' | 'BAD_CONFIG' | 'API_ERROR'} BitbucketErrorCode
 */

/**
 * @typedef {Object} VerifyCredentialsResult
 * @property {import('./storage.js').CachedUser} user
 * @property {import('./storage.js').WorkspaceSummary[]} workspaces
 * @property {boolean} nearLimit
 */

/**
 * @typedef {Object} PartialFetchError
 * @property {string} scope
 * @property {string} message
 * @property {number | null} status
 */

/**
 * @typedef {Object} FetchPullRequestsResult
 * @property {import('./storage.js').PullRequestRecord[]} prs
 * @property {import('./storage.js').CachedUser} user
 * @property {import('./storage.js').WorkspaceSummary[]} workspaces
 * @property {boolean} nearLimit
 * @property {PartialFetchError[]} partialErrors
 */

const PR_FIELDS = [
  'next',
  'values.id',
  'values.title',
  'values.description',
  'values.state',
  'values.created_on',
  'values.updated_on',
  'values.comment_count',
  'values.task_count',
  'values.draft',
  'values.links.html.href',
  'values.author.display_name',
  'values.author.uuid',
  'values.source.branch.name',
  'values.source.commit.hash',
  'values.source.repository.full_name',
  'values.source.repository.name',
  'values.destination.branch.name',
  'values.destination.repository.full_name',
  'values.destination.repository.name',
  'values.participants.role',
  'values.participants.approved',
  'values.participants.state',
  'values.participants.user.uuid',
  'values.participants.user.display_name',
  'values.reviewers.uuid',
  'values.reviewers.display_name'
].join(',');

const REPO_FIELDS = 'next,values.slug,values.full_name,values.updated_on';
const BUILD_STATUS_FIELDS = 'values.state,values.name,values.url,values.updated_on';

/** @type {ReadonlySet<import('./storage.js').BuildState>} */
const TERMINAL_BUILD_STATES = new Set(['SUCCESSFUL', 'FAILED', 'STOPPED']);

/** @type {Readonly<Record<import('./storage.js').BuildState, number>>} */
const BUILD_STATE_PRECEDENCE = Object.freeze({
  FAILED: 4,
  INPROGRESS: 3,
  STOPPED: 2,
  SUCCESSFUL: 1
});

/**
 * Encode a UTF-8 string into Base64 safely using `TextEncoder` + `btoa` (no legacy percent-decoding hacks).
 *
 * @param {string} input
 * @returns {string}
 */
function encodeUtf8Base64(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Build the HTTP `Authorization` header for Bitbucket Cloud REST API 2.0.
 * - `'api_token'` (or legacy `'app_password'`): Basic auth with `username:token` (UTF-8 safe).
 * - `'bearer'` (or legacy `'pat'`): Bearer token auth.
 *
 * @param {{ authType?: string, username?: string, token?: string }} creds
 * @returns {string}
 */
export function buildAuthHeader({ authType, username = '', token = '' }) {
  const cleanToken = typeof token === 'string' ? token.trim() : '';
  if (!cleanToken) {
    throw new BitbucketApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'Bitbucket API token is missing. Configure it in Settings.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  const normalized = normalizeAuthType(authType);
  if (normalized === 'bearer') {
    return `Bearer ${cleanToken}`;
  }

  const cleanUser = typeof username === 'string' ? username.trim() : '';
  if (!cleanUser) {
    throw new BitbucketApiError({
      status: 0,
      code: 'BAD_CONFIG',
      message: 'Atlassian account email is required for API Token authentication.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  return `Basic ${encodeUtf8Base64(`${cleanUser}:${cleanToken}`)}`;
}

/**
 * Sanitized Bitbucket API / network error with human-readable messaging.
 * Never embeds raw API response bodies or credentials.
 */
export class BitbucketApiError extends Error {
  /**
   * @param {{
   *   status: number,
   *   code: BitbucketErrorCode,
   *   message: string,
   *   retryAfter: number | null,
   *   isTransient: boolean,
   *   isAuthError: boolean
   * }} details
   */
  constructor({ status, code, message, retryAfter, isTransient, isAuthError }) {
    super(message);
    this.name = 'BitbucketApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.isTransient = isTransient;
    this.isAuthError = isAuthError;
  }
}

/**
 * Map an HTTP response status & headers into a sanitized `BitbucketApiError`.
 *
 * @param {number} status
 * @param {Headers | { get?: (name: string) => string | null } | null | undefined} headers
 * @param {number} now
 * @returns {BitbucketApiError}
 */
export function mapHttpStatusToError(status, headers, now = Date.now()) {
  const retryHeader = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const retryAfter = parseRetryAfterMs(retryHeader, now);

  if (status === 401) {
    return new BitbucketApiError({
      status,
      code: 'UNAUTHORIZED',
      message: 'Authentication failed (401). Check your email/API token or access token in Settings.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  if (status === 403) {
    return new BitbucketApiError({
      status,
      code: 'FORBIDDEN',
      message: 'Access denied (403). Verify your token has the required Bitbucket read scopes.',
      retryAfter: null,
      isTransient: false,
      isAuthError: true
    });
  }

  if (status === 404) {
    return new BitbucketApiError({
      status,
      code: 'NOT_FOUND',
      message: 'Requested Bitbucket resource was not found (404). Check configured workspace or repository slugs.',
      retryAfter: null,
      isTransient: false,
      isAuthError: false
    });
  }

  if (status === 429) {
    return new BitbucketApiError({
      status,
      code: 'RATE_LIMITED',
      message: 'Bitbucket API rate limit reached (429). Polling has been temporarily paused.',
      retryAfter,
      isTransient: true,
      isAuthError: false
    });
  }

  if (status >= 500) {
    return new BitbucketApiError({
      status,
      code: 'SERVER_ERROR',
      message: `Bitbucket API is temporarily unavailable (${status}). Will retry automatically.`,
      retryAfter,
      isTransient: true,
      isAuthError: false
    });
  }

  return new BitbucketApiError({
    status,
    code: 'API_ERROR',
    message: `Bitbucket API returned unexpected status ${status}.`,
    retryAfter: null,
    isTransient: false,
    isAuthError: false
  });
}

/**
 * Normalize a raw Bitbucket API pull request payload into our canonical domain record.
 *
 * @param {any} rawPr
 * @param {string} fallbackWorkspace
 * @returns {import('./storage.js').PullRequestRecord | null}
 */
export function normalizePullRequest(rawPr, fallbackWorkspace = '') {
  if (!rawPr || typeof rawPr !== 'object' || typeof rawPr.id !== 'number') {
    return null;
  }

  const repoFullName = String(
    rawPr.destination?.repository?.full_name ||
    rawPr.source?.repository?.full_name ||
    ''
  ).trim();

  const repoName = String(
    rawPr.destination?.repository?.name ||
    rawPr.source?.repository?.name ||
    repoFullName.split('/').pop() ||
    'unknown-repo'
  ).trim();

  const workspace = repoFullName.includes('/')
    ? repoFullName.split('/')[0]
    : fallbackWorkspace;

  const canonicalRepo = repoFullName || (workspace ? `${workspace}/${repoName}` : repoName);
  const key = `${canonicalRepo}#${rawPr.id}`;

  const safeUrl = sanitizeHttpsUrl(rawPr.links?.html?.href) ||
    (canonicalRepo.includes('/')
      ? `${CENTRAL_URLS.BITBUCKET_WEB_BASE_URL}/${canonicalRepo}/pull-requests/${rawPr.id}`
      : CENTRAL_URLS.BITBUCKET_WEB_BASE_URL);

  /** @type {import('./storage.js').PrReviewer[]} */
  const reviewers = Array.isArray(rawPr.reviewers)
    ? rawPr.reviewers
      .filter((r) => r && typeof r.uuid === 'string')
      .map((r) => ({
        uuid: r.uuid,
        displayName: typeof r.display_name === 'string' ? r.display_name : 'Reviewer'
      }))
    : [];

  /** @type {import('./storage.js').PrParticipant[]} */
  const participants = Array.isArray(rawPr.participants)
    ? rawPr.participants
      .filter((p) => p && p.user && typeof p.user.uuid === 'string')
      .map((p) => {
        const rawState = p.state;
        /** @type {'approved' | 'changes_requested' | null} */
        let normalizedState = null;
        if (rawState === 'approved' || p.approved === true) {
          normalizedState = 'approved';
        } else if (rawState === 'changes_requested') {
          normalizedState = 'changes_requested';
        }
        return {
          uuid: p.user.uuid,
          displayName: typeof p.user.display_name === 'string' ? p.user.display_name : 'Participant',
          role: typeof p.role === 'string' ? p.role : 'PARTICIPANT',
          approved: Boolean(p.approved),
          state: normalizedState
        };
      })
    : [];

  const rawCommitHash = typeof rawPr.source?.commit?.hash === 'string'
    ? rawPr.source.commit.hash.trim()
    : '';
  const rawDescription = typeof rawPr.description === 'string' ? rawPr.description : '';
  const description = rawDescription
    ? rawDescription.slice(0, THROTTLE_CONFIG.maxDescriptionCharsInPrompt)
    : undefined;

  return {
    key,
    id: rawPr.id,
    title: typeof rawPr.title === 'string' && rawPr.title.trim() ? rawPr.title.trim() : `PR #${rawPr.id}`,
    ...(description !== undefined ? { description } : {}),
    state: typeof rawPr.state === 'string' ? rawPr.state : 'OPEN',
    url: safeUrl,
    repoFullName: canonicalRepo,
    repoName,
    workspace,
    authorUuid: typeof rawPr.author?.uuid === 'string' ? rawPr.author.uuid : '',
    authorName: typeof rawPr.author?.display_name === 'string' ? rawPr.author.display_name : 'Unknown Author',
    sourceBranch: typeof rawPr.source?.branch?.name === 'string' ? rawPr.source.branch.name : '',
    destinationBranch: typeof rawPr.destination?.branch?.name === 'string' ? rawPr.destination.branch.name : '',
    createdOn: typeof rawPr.created_on === 'string' ? rawPr.created_on : '',
    updatedOn: typeof rawPr.updated_on === 'string'
      ? rawPr.updated_on
      : (typeof rawPr.created_on === 'string' ? rawPr.created_on : ''),
    commentCount: typeof rawPr.comment_count === 'number' ? rawPr.comment_count : 0,
    taskCount: typeof rawPr.task_count === 'number' ? rawPr.task_count : 0,
    draft: Boolean(rawPr.draft),
    reviewers,
    participants,
    ...(rawCommitHash ? { sourceCommitHash: rawCommitHash } : {})
  };
}

/**
 * Fetch lightweight per-file diffstat metadata for a Bitbucket PR (no raw diff patches).
 * Gracefully returns `null` on any network, auth, or HTTP error so PR sync never fails.
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   authHeader: string,
 *   pr: Pick<import('./storage.js').PullRequestRecord, 'id' | 'repoFullName' | 'workspace' | 'repoName' | 'sourceCommitHash'>,
 *   nowFn?: () => number
 * }} params
 * @returns {Promise<import('./storage.js').DiffstatSummary | null>}
 */
export async function fetchBitbucketDiffstat({
  fetchFn = fetch,
  authHeader,
  pr,
  nowFn = Date.now
}) {
  if (!authHeader || !pr || typeof pr.id !== 'number') {
    return null;
  }

  let ws = '';
  let repoSlug = '';
  const fullName = typeof pr.repoFullName === 'string' ? pr.repoFullName.trim() : '';
  const slashIdx = fullName.indexOf('/');
  if (slashIdx > 0) {
    ws = fullName.slice(0, slashIdx).trim();
    repoSlug = fullName.slice(slashIdx + 1).trim();
  } else if (pr.workspace && pr.repoName) {
    ws = pr.workspace.trim();
    repoSlug = pr.repoName.trim();
  }
  if (!ws || !repoSlug) {
    return null;
  }

  const url = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(repoSlug)}/pullrequests/${pr.id}/diffstat?pagelen=50`;
  try {
    const response = await fetchWithTimeout(
      fetchFn,
      url,
      {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        }
      },
      THROTTLE_CONFIG.requestTimeoutMs
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const values = Array.isArray(data?.values) ? data.values : [];

    let linesAdded = 0;
    let linesRemoved = 0;
    /** @type {import('./storage.js').DiffstatFile[]} */
    const files = [];

    for (const entry of values) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const filePath =
        (typeof entry.new?.path === 'string' && entry.new.path) ||
        (typeof entry.old?.path === 'string' && entry.old.path) ||
        '';
      if (!filePath) {
        continue;
      }
      const added = typeof entry.lines_added === 'number' && Number.isFinite(entry.lines_added)
        ? entry.lines_added
        : 0;
      const removed = typeof entry.lines_removed === 'number' && Number.isFinite(entry.lines_removed)
        ? entry.lines_removed
        : 0;
      const status = typeof entry.status === 'string' && entry.status ? entry.status : 'modified';

      linesAdded += added;
      linesRemoved += removed;
      files.push({
        path: filePath,
        added,
        removed,
        status
      });
    }

    const filesChanged = typeof data?.size === 'number' && Number.isFinite(data.size)
      ? Math.max(data.size, files.length)
      : files.length;

    return {
      commitHash: typeof pr.sourceCommitHash === 'string' ? pr.sourceCommitHash.trim() : '',
      filesChanged,
      linesAdded,
      linesRemoved,
      files,
      cachedAt: nowFn()
    };
  } catch {
    return null;
  }
}

/**
 * Aggregate raw Bitbucket commit/PR build statuses into a single summary record.
 * Precedence: `FAILED` > `INPROGRESS` > `STOPPED` > `SUCCESSFUL`.
 *
 * @param {readonly any[]} rawStatuses
 * @param {string} [commitHash]
 * @param {number} [now]
 * @returns {import('./storage.js').BuildStatusSummary | null}
 */
export function aggregateBuildStatuses(rawStatuses, commitHash = '', now = Date.now()) {
  if (!Array.isArray(rawStatuses) || rawStatuses.length === 0) {
    return null;
  }

  let passedCount = 0;
  let failedCount = 0;
  let inProgressCount = 0;
  let stoppedCount = 0;

  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string } | null} */
  let primaryFailed = null;
  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string } | null} */
  let primaryInProgress = null;
  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string } | null} */
  let primaryStopped = null;
  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string, updatedMs: number } | null} */
  let latestSuccessful = null;

  for (const raw of rawStatuses) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const rawState = typeof raw.state === 'string' ? raw.state.toUpperCase() : '';
    if (!(rawState in BUILD_STATE_PRECEDENCE)) {
      continue;
    }
    const state = /** @type {import('./storage.js').BuildState} */ (rawState);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '';
    const url = sanitizeHttpsUrl(raw.url);
    const updatedOn = typeof raw.updated_on === 'string' ? raw.updated_on : '';

    if (state === 'FAILED') {
      failedCount += 1;
      if (!primaryFailed) {
        primaryFailed = { state, name, url, updatedOn };
      } else if (!primaryFailed.url && url) {
        primaryFailed.url = url;
      }
    } else if (state === 'INPROGRESS') {
      inProgressCount += 1;
      if (!primaryInProgress) {
        primaryInProgress = { state, name, url, updatedOn };
      } else if (!primaryInProgress.url && url) {
        primaryInProgress.url = url;
      }
    } else if (state === 'STOPPED') {
      stoppedCount += 1;
      if (!primaryStopped) {
        primaryStopped = { state, name, url, updatedOn };
      } else if (!primaryStopped.url && url) {
        primaryStopped.url = url;
      }
    } else if (state === 'SUCCESSFUL') {
      passedCount += 1;
      const parsedMs = updatedOn ? Date.parse(updatedOn) : Number.NaN;
      const updatedMs = Number.isNaN(parsedMs) ? -1 : parsedMs;
      if (!latestSuccessful || updatedMs > latestSuccessful.updatedMs) {
        latestSuccessful = { state, name, url, updatedOn, updatedMs };
      } else if (updatedMs === latestSuccessful.updatedMs && !latestSuccessful.url && url) {
        latestSuccessful.url = url;
      }
    }
  }

  const totalCount = passedCount + failedCount + inProgressCount + stoppedCount;
  if (totalCount === 0) {
    return null;
  }

  /** @type {{ state: import('./storage.js').BuildState, name: string, url: string | null, updatedOn: string }} */
  const chosen = primaryFailed ?? primaryInProgress ?? primaryStopped ?? /** @type {NonNullable<typeof latestSuccessful>} */ (latestSuccessful);

  let latestUpdatedOn = chosen.updatedOn;
  let latestUpdatedMs = latestUpdatedOn ? Date.parse(latestUpdatedOn) : Number.NaN;
  if (Number.isNaN(latestUpdatedMs)) {
    latestUpdatedMs = -1;
  }
  for (const raw of rawStatuses) {
    if (!raw || typeof raw !== 'object' || typeof raw.updated_on !== 'string' || !raw.updated_on) {
      continue;
    }
    const ms = Date.parse(raw.updated_on);
    if (!Number.isNaN(ms) && ms > latestUpdatedMs) {
      latestUpdatedMs = ms;
      latestUpdatedOn = raw.updated_on;
    }
  }

  return {
    state: chosen.state,
    totalCount,
    passedCount,
    failedCount,
    inProgressCount,
    stoppedCount,
    url: chosen.url,
    name: chosen.name,
    updatedOn: latestUpdatedOn,
    commitHash: typeof commitHash === 'string' ? commitHash.trim() : '',
    cachedAt: now
  };
}

/**
 * Validate that a pagination `next` URL points strictly to Bitbucket API HTTPS host.
 *
 * @param {unknown} nextUrl
 * @returns {string | null}
 */
function sanitizeBitbucketNextUrl(nextUrl) {
  const safe = sanitizeHttpsUrl(nextUrl);
  if (!safe) {
    return null;
  }
  const parsed = new URL(safe);
  const apiBase = new URL(CENTRAL_URLS.BITBUCKET_API_BASE_URL);
  const basePath = apiBase.pathname.endsWith('/') ? apiBase.pathname : `${apiBase.pathname}/`;
  return parsed.origin === apiBase.origin && parsed.pathname.startsWith(basePath) ? safe : null;
}

/**
 * Create a Bitbucket Cloud REST API 2.0 client with injectable network/time dependencies.
 *
 * @param {{
 *   fetchFn?: typeof fetch,
 *   nowFn?: () => number,
 *   sleepFn?: (ms: number) => Promise<void>
 * }} [deps]
 */
export function createBitbucketClient({
  fetchFn = fetch,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  /**
   * Perform a single authenticated GET request to Bitbucket API 2.0.
   *
   * @param {string} url
   * @param {string} authHeader
   * @returns {Promise<{ data: any, nearLimit: boolean }>}
   */
  async function requestJson(url, authHeader) {
    let response;
    try {
      response = await fetchWithTimeout(
        fetchFn,
        url,
        {
          method: 'GET',
          headers: {
            Authorization: authHeader,
            Accept: 'application/json'
          }
        },
        THROTTLE_CONFIG.requestTimeoutMs
      );
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        throw new BitbucketApiError({
          status: 0,
          code: 'TIMEOUT',
          message: 'Bitbucket API request timed out. Please check your connection and try again.',
          retryAfter: null,
          isTransient: true,
          isAuthError: false
        });
      }
      throw new BitbucketApiError({
        status: 0,
        code: 'NETWORK',
        message: 'Could not reach Bitbucket API. Check your network connection.',
        retryAfter: null,
        isTransient: true,
        isAuthError: false
      });
    }

    const nearLimitHeader = response.headers?.get?.('x-ratelimit-nearlimit');
    const nearLimit = typeof nearLimitHeader === 'string' && nearLimitHeader.toLowerCase() === 'true';

    if (!response.ok) {
      throw mapHttpStatusToError(response.status, response.headers, nowFn());
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new BitbucketApiError({
        status: response.status,
        code: 'API_ERROR',
        message: 'Received an unreadable response from Bitbucket API.',
        retryAfter: null,
        isTransient: true,
        isAuthError: false
      });
    }

    if (nearLimit && THROTTLE_CONFIG.nearLimitDelayMs > 0) {
      await sleepFn(THROTTLE_CONFIG.nearLimitDelayMs);
    }

    return { data, nearLimit };
  }

  /**
   * Fetch paginated `values` up to `maxPagesPerEndpoint`.
   *
   * @param {string} initialUrl
   * @param {string} authHeader
   * @returns {Promise<{ values: any[], nearLimit: boolean }>}
   */
  async function fetchPaginated(initialUrl, authHeader) {
    const values = [];
    let nearLimit = false;
    /** @type {string | null} */
    let currentUrl = initialUrl;

    for (let page = 0; page < THROTTLE_CONFIG.maxPagesPerEndpoint && currentUrl; page += 1) {
      const result = await requestJson(currentUrl, authHeader);
      if (result.nearLimit) {
        nearLimit = true;
      }
      if (Array.isArray(result.data?.values)) {
        values.push(...result.data.values);
      }
      currentUrl = sanitizeBitbucketNextUrl(result.data?.next);
    }

    return { values, nearLimit };
  }

  /**
   * Fetch and normalize the current authenticated user.
   *
   * @param {string} authHeader
   * @returns {Promise<{ user: import('./storage.js').CachedUser, nearLimit: boolean }>}
   */
  async function fetchCurrentUser(authHeader) {
    const url = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/user`;
    const { data, nearLimit } = await requestJson(url, authHeader);
    if (!data || typeof data.uuid !== 'string' || !data.uuid) {
      throw new BitbucketApiError({
        status: 200,
        code: 'API_ERROR',
        message: 'Bitbucket user profile response did not include a user UUID.',
        retryAfter: null,
        isTransient: false,
        isAuthError: false
      });
    }

    return {
      user: {
        uuid: data.uuid,
        displayName: typeof data.display_name === 'string' && data.display_name
          ? data.display_name
          : (typeof data.username === 'string' ? data.username : 'Bitbucket User'),
        username: typeof data.username === 'string'
          ? data.username
          : (typeof data.nickname === 'string' ? data.nickname : ''),
        avatarUrl: sanitizeHttpsUrl(data.links?.avatar?.href),
        cachedAt: nowFn()
      },
      nearLimit
    };
  }

  /**
   * Fetch accessible workspaces via `/2.0/user/workspaces` (handles `workspace_access` wrappers
   * and gracefully tolerates 403 when token is repo-scoped).
   *
   * @param {string} authHeader
   * @returns {Promise<{ workspaces: import('./storage.js').WorkspaceSummary[], nearLimit: boolean }>}
   */
  async function fetchWorkspaces(authHeader) {
    const url = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/user/workspaces?pagelen=50`;
    try {
      const { values, nearLimit } = await fetchPaginated(url, authHeader);
      /** @type {Map<string, import('./storage.js').WorkspaceSummary>} */
      const bySlug = new Map();
      for (const entry of values) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const ws = entry.workspace && typeof entry.workspace === 'object' ? entry.workspace : entry;
        if (typeof ws.slug !== 'string' || !ws.slug.trim()) {
          continue;
        }
        const slug = ws.slug.trim();
        if (!bySlug.has(slug)) {
          bySlug.set(slug, {
            slug,
            name: typeof ws.name === 'string' && ws.name.trim() ? ws.name.trim() : slug
          });
        }
      }
      return { workspaces: Array.from(bySlug.values()), nearLimit };
    } catch (err) {
      if (err instanceof BitbucketApiError && err.status === 403) {
        return { workspaces: [], nearLimit: false };
      }
      throw err;
    }
  }

  /**
   * Verify user credentials against `/2.0/user` and `/2.0/user/workspaces`.
   *
   * @param {Partial<import('./storage.js').Credentials>} creds
   * @returns {Promise<VerifyCredentialsResult>}
   */
  async function verifyCredentials(creds) {
    const authHeader = buildAuthHeader(creds);
    const { user, nearLimit: userNearLimit } = await fetchCurrentUser(authHeader);
    const { workspaces, nearLimit: wsNearLimit } = await fetchWorkspaces(authHeader);

    return {
      user,
      workspaces,
      nearLimit: userNearLimit || wsNearLimit
    };
  }

  /**
   * Resolve repos to scan for a given workspace, using cache when valid or `reposFilter` overrides.
   *
   * @param {{
   *   workspace: string,
   *   authHeader: string,
   *   storage: ReturnType<import('./storage.js').createStorage>,
   *   reposFilter: string[],
   *   forceRefreshCache: boolean
   * }} params
   * @returns {Promise<{ repos: import('./storage.js').RepoSummary[], nearLimit: boolean }>}
   */
  async function resolveWorkspaceRepos({ workspace, authHeader, storage, reposFilter, forceRefreshCache }) {
    const cleanWorkspace = workspace.trim().toLowerCase();
    const cleanedEntries = reposFilter
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    if (cleanedEntries.length > 0) {
      /** @type {Map<string, import('./storage.js').RepoSummary>} */
      const bySlug = new Map();
      for (const entry of cleanedEntries) {
        const slashIdx = entry.indexOf('/');
        if (slashIdx <= 0) {
          continue;
        }
        const entryWorkspace = entry.slice(0, slashIdx).trim();
        const repoSlug = entry.slice(slashIdx + 1).trim();
        if (!repoSlug || entryWorkspace.toLowerCase() !== cleanWorkspace) {
          continue;
        }
        const canonicalSlug = repoSlug.toLowerCase();
        if (!bySlug.has(canonicalSlug)) {
          bySlug.set(canonicalSlug, {
            slug: repoSlug,
            fullName: `${workspace.trim()}/${repoSlug}`,
            updatedOn: ''
          });
        }
      }
      return { repos: Array.from(bySlug.values()), nearLimit: false };
    }

    const now = nowFn();
    if (!forceRefreshCache) {
      const cached = await storage.getCachedRepos(workspace);
      if (cached && now - cached.cachedAt < CACHE_TTL_MS.repositories) {
        return { repos: cached.items, nearLimit: false };
      }
    }

    const url = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/repositories/${encodeURIComponent(workspace)}?sort=-updated_on&pagelen=${THROTTLE_CONFIG.maxReposPerWorkspace}&fields=${encodeURIComponent(REPO_FIELDS)}`;
    const { data, nearLimit } = await requestJson(url, authHeader);
    const repos = Array.isArray(data?.values)
      ? data.values
        .filter((r) => r && typeof r.slug === 'string' && r.slug)
        .slice(0, THROTTLE_CONFIG.maxReposPerWorkspace)
        .map((r) => ({
          slug: r.slug,
          fullName: typeof r.full_name === 'string' ? r.full_name : `${workspace}/${r.slug}`,
          updatedOn: typeof r.updated_on === 'string' ? r.updated_on : ''
        }))
      : [];

    await storage.setCachedRepos(workspace, { items: repos, cachedAt: now });
    return { repos, nearLimit };
  }

  /**
   * Merge newly fetched normalized PR data into `prMap` so authored + reviewing duplicates
   * retain the richest reviewer/participant metadata.
   *
   * @param {Map<string, import('./storage.js').PullRequestRecord>} prMap
   * @param {import('./storage.js').PullRequestRecord} normalized
   */
  function upsertPullRequest(prMap, normalized) {
    const existing = prMap.get(normalized.key);
    if (!existing) {
      prMap.set(normalized.key, normalized);
      return;
    }

    const mergedReviewersMap = new Map();
    for (const r of existing.reviewers) {
      mergedReviewersMap.set(r.uuid, r);
    }
    for (const r of normalized.reviewers) {
      mergedReviewersMap.set(r.uuid, r);
    }

    const mergedParticipantsMap = new Map();
    for (const p of existing.participants) {
      mergedParticipantsMap.set(p.uuid, p);
    }
    for (const p of normalized.participants) {
      const prev = mergedParticipantsMap.get(p.uuid);
      if (!prev) {
        mergedParticipantsMap.set(p.uuid, p);
      } else {
        mergedParticipantsMap.set(p.uuid, {
          ...prev,
          ...p,
          approved: Boolean(prev.approved || p.approved),
          state: p.state || prev.state
        });
      }
    }

    prMap.set(normalized.key, {
      ...existing,
      ...normalized,
      sourceCommitHash: normalized.sourceCommitHash || existing.sourceCommitHash,
      reviewers: Array.from(mergedReviewersMap.values()),
      participants: Array.from(mergedParticipantsMap.values())
    });
  }

  /**
   * Determine whether a Bitbucket API error represents a fatal sync failure (which must abort sync
   * rather than silently overwriting cached PRs with partial/empty data).
   *
   * @param {unknown} err
   * @param {{ allowForbidden?: boolean }} [options]
   * @returns {boolean}
   */
  function isFatalFetchError(err, options = {}) {
    const allowForbidden = Boolean(options.allowForbidden);
    if (err instanceof BitbucketApiError) {
      if (err.status === 401 || err.status === 429) {
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
   * Determine whether a cached build status entry is still fresh enough to reuse without network calls.
   *
   * @param {import('./storage.js').BuildStatusSummary | undefined} cached
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
   * Parse `workspace` and `repoSlug` from a `PullRequestRecord`.
   *
   * @param {import('./storage.js').PullRequestRecord} pr
   * @returns {{ ws: string, repoSlug: string } | null}
   */
  function extractRepoSlugParts(pr) {
    const fullName = typeof pr.repoFullName === 'string' ? pr.repoFullName.trim() : '';
    const slashIdx = fullName.indexOf('/');
    if (slashIdx > 0) {
      const ws = fullName.slice(0, slashIdx).trim();
      const repoSlug = fullName.slice(slashIdx + 1).trim();
      if (ws && repoSlug) {
        return { ws, repoSlug };
      }
    }
    if (pr.workspace && pr.repoName) {
      return { ws: pr.workspace.trim(), repoSlug: pr.repoName.trim() };
    }
    return null;
  }

  /**
   * Fetch all open authored & reviewing pull requests across configured/discovered workspaces.
   *
   * @param {{
   *   creds: Partial<import('./storage.js').Credentials>,
   *   storage: ReturnType<import('./storage.js').createStorage>,
   *   preferences: import('./config.js').Preferences,
   *   forceRefreshCache?: boolean
   * }} params
   * @returns {Promise<FetchPullRequestsResult>}
   */
  async function fetchPullRequests({ creds, storage, preferences, forceRefreshCache = false }) {
    const authHeader = buildAuthHeader(creds);
    const now = nowFn();
    let nearLimit = false;
    /** @type {PartialFetchError[]} */
    const partialErrors = [];

    // 1. User profile (24h cache)
    let user = forceRefreshCache ? null : await storage.getCachedUser();
    if (!user || now - user.cachedAt >= CACHE_TTL_MS.userProfile) {
      const fetched = await fetchCurrentUser(authHeader);
      user = fetched.user;
      if (fetched.nearLimit) {
        nearLimit = true;
      }
      await storage.setCachedUser(user);
    }

    // 2. Workspaces (1h cache, or scoped from explicit workspace / repo filters)
    const explicitWorkspaces = Array.isArray(preferences.workspacesFilter)
      ? Array.from(new Set(preferences.workspacesFilter.map((w) => String(w).trim()).filter(Boolean)))
      : [];
    const reposFilter = Array.isArray(preferences.reposFilter)
      ? preferences.reposFilter.map((r) => String(r).trim()).filter(Boolean)
      : [];
    const repoFilterWorkspaces = Array.from(new Set(
      reposFilter
        .filter((r) => r.includes('/'))
        .map((r) => r.split('/')[0].trim())
        .filter(Boolean)
    ));

    let workspaces = /** @type {import('./storage.js').WorkspaceSummary[]} */ ([]);
    if (explicitWorkspaces.length > 0) {
      workspaces = explicitWorkspaces.map((slug) => ({ slug, name: slug }));
    } else if (repoFilterWorkspaces.length > 0) {
      // When reposFilter is provided without explicit workspacesFilter, scope directly to those workspaces
      workspaces = repoFilterWorkspaces.map((slug) => ({ slug, name: slug }));
    } else {
      const cachedWs = forceRefreshCache ? null : await storage.getCachedWorkspaces();
      if (cachedWs && now - cachedWs.cachedAt < CACHE_TTL_MS.workspaces) {
        workspaces = cachedWs.items;
      } else {
        const fetchedWs = await fetchWorkspaces(authHeader);
        workspaces = fetchedWs.workspaces;
        if (fetchedWs.nearLimit) {
          nearLimit = true;
        }
        await storage.setCachedWorkspaces({ items: workspaces, cachedAt: now });
      }
    }

    if (workspaces.length === 0) {
      return {
        prs: [],
        user,
        workspaces,
        nearLimit,
        partialErrors
      };
    }

    /** @type {Map<string, import('./storage.js').PullRequestRecord>} */
    const prMap = new Map();
    const encodedUuid = encodeURIComponent(user.uuid);
    const encodedFields = encodeURIComponent(PR_FIELDS);
    let successfulScopes = 0;
    /** @type {unknown} */
    let firstScopeError = null;

    // 3. Fetch authored PRs & reviewing PRs per workspace
    for (const ws of workspaces) {
      const wsSlug = ws.slug;

      // 3a. Authored PRs via workspace pullrequests endpoint
      const authoredUrl = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/workspaces/${encodeURIComponent(wsSlug)}/pullrequests/${encodedUuid}?state=OPEN&pagelen=50&fields=${encodedFields}`;
      try {
        const authoredRes = await fetchPaginated(authoredUrl, authHeader);
        successfulScopes += 1;
        if (authoredRes.nearLimit) {
          nearLimit = true;
        }
        for (const rawPr of authoredRes.values) {
          const normalized = normalizePullRequest(rawPr, wsSlug);
          if (normalized) {
            upsertPullRequest(prMap, normalized);
          }
        }
      } catch (err) {
        if (isFatalFetchError(err)) {
          throw err;
        }
        firstScopeError = firstScopeError ?? err;
        partialErrors.push({
          scope: `${wsSlug} (authored)`,
          message: err instanceof Error ? err.message : 'Failed to fetch authored PRs.',
          status: err instanceof BitbucketApiError ? err.status : null
        });
      }

      // 3b. Resolve repos in workspace & fetch reviewing PRs with bounded concurrency
      /** @type {import('./storage.js').RepoSummary[]} */
      let reposToScan = [];
      try {
        const repoRes = await resolveWorkspaceRepos({
          workspace: wsSlug,
          authHeader,
          storage,
          reposFilter,
          forceRefreshCache
        });
        reposToScan = repoRes.repos;
        if (reposToScan.length === 0) {
          successfulScopes += 1;
        }
        if (repoRes.nearLimit) {
          nearLimit = true;
        }
      } catch (err) {
        if (isFatalFetchError(err)) {
          throw err;
        }
        firstScopeError = firstScopeError ?? err;
        partialErrors.push({
          scope: `${wsSlug} (repositories)`,
          message: err instanceof Error ? err.message : 'Failed to list repositories.',
          status: err instanceof BitbucketApiError ? err.status : null
        });
        continue;
      }

      if (reposToScan.length === 0) {
        continue;
      }

      const reviewerQuery = encodeURIComponent(`state="OPEN" AND reviewers.uuid="${user.uuid}"`);
      const repoResults = await runWithConcurrency(
        reposToScan,
        THROTTLE_CONFIG.maxConcurrentRequests,
        async (repo) => {
          const repoSlug = repo.slug;
          const reviewUrl = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/repositories/${encodeURIComponent(wsSlug)}/${encodeURIComponent(repoSlug)}/pullrequests?q=${reviewerQuery}&pagelen=50&fields=${encodedFields}`;
          return fetchPaginated(reviewUrl, authHeader);
        },
        { isolateErrors: true }
      );

      for (let i = 0; i < repoResults.length; i += 1) {
        const outcome = /** @type {{ status: 'fulfilled', value: { values: any[], nearLimit: boolean } } | { status: 'rejected', reason: unknown }} */ (
          /** @type {unknown} */ (repoResults[i])
        );
        const repo = reposToScan[i];
        if (outcome.status === 'fulfilled') {
          successfulScopes += 1;
          if (outcome.value.nearLimit) {
            nearLimit = true;
          }
          for (const rawPr of outcome.value.values) {
            const normalized = normalizePullRequest(rawPr, wsSlug);
            if (normalized) {
              upsertPullRequest(prMap, normalized);
            }
          }
        } else {
          const reason = outcome.reason;
          if (isFatalFetchError(reason, { allowForbidden: true })) {
            throw reason;
          }
          firstScopeError = firstScopeError ?? reason;
          partialErrors.push({
            scope: repo.fullName,
            message: reason instanceof Error ? reason.message : 'Failed to fetch repo PRs.',
            status: reason instanceof BitbucketApiError ? reason.status : null
          });
        }
      }
    }

    if (successfulScopes === 0 && partialErrors.length > 0) {
      throw firstScopeError instanceof Error
        ? firstScopeError
        : new BitbucketApiError({
          status: partialErrors[0].status ?? 0,
          code: 'API_ERROR',
          message: partialErrors[0].message,
          retryAfter: null,
          isTransient: false,
          isAuthError: false
        });
    }

    // 4. Enrich deduplicated PRs with commit-cached CI / build status (never fails PR sync)
    const prs = Array.from(prMap.values());
    if (prs.length > 0) {
      let cachedStatuses = /** @type {import('./storage.js').BuildStatusCacheMap} */ ({});
      try {
        cachedStatuses = await storage.getCachedBuildStatuses();
      } catch {
        cachedStatuses = {};
      }
      const nextStatusCache = { ...cachedStatuses };
      let cacheMutated = false;

      /** @type {Array<{ pr: import('./storage.js').PullRequestRecord, cacheKey: string | null, cached: import('./storage.js').BuildStatusSummary | null, repoParts: { ws: string, repoSlug: string } }>} */
      const statusTasks = [];
      const statusNow = nowFn();

      for (const pr of prs) {
        const commitHash = typeof pr.sourceCommitHash === 'string' ? pr.sourceCommitHash.trim() : '';
        const cacheKey = commitHash
          ? (pr.repoFullName ? `${pr.repoFullName}:${commitHash}` : commitHash)
          : null;
        const cached = cacheKey
          ? (nextStatusCache[cacheKey] ?? (commitHash && nextStatusCache[commitHash]) ?? null)
          : null;

        if (!forceRefreshCache && cached && isBuildStatusCacheFresh(cached, statusNow)) {
          pr.buildStatus = cached;
          continue;
        }

        if (nearLimit) {
          pr.buildStatus = cached ?? null;
          continue;
        }

        const repoParts = extractRepoSlugParts(pr);
        if (!repoParts) {
          pr.buildStatus = cached ?? null;
          continue;
        }

        statusTasks.push({ pr, cacheKey, cached, repoParts });
      }

      if (statusTasks.length > 0) {
        const encodedStatusFields = encodeURIComponent(BUILD_STATUS_FIELDS);
        const statusOutcomes = await runWithConcurrency(
          statusTasks,
          THROTTLE_CONFIG.maxConcurrentRequests,
          async (task) => {
            if (nearLimit) {
              return { skippedDueToLimit: true, summary: task.cached, nearLimit: false };
            }
            const statusUrl = `${CENTRAL_URLS.BITBUCKET_API_BASE_URL}/repositories/${encodeURIComponent(task.repoParts.ws)}/${encodeURIComponent(task.repoParts.repoSlug)}/pullrequests/${task.pr.id}/statuses?pagelen=50&fields=${encodedStatusFields}`;
            const res = await requestJson(statusUrl, authHeader);
            if (res.nearLimit) {
              nearLimit = true;
            }
            const rawValues = Array.isArray(res.data?.values) ? res.data.values : [];
            const summary = aggregateBuildStatuses(rawValues, task.pr.sourceCommitHash ?? '', nowFn());
            return { skippedDueToLimit: false, summary, nearLimit: res.nearLimit };
          },
          { isolateErrors: true }
        );

        for (let i = 0; i < statusOutcomes.length; i += 1) {
          const outcome = /** @type {{ status: 'fulfilled', value: { skippedDueToLimit: boolean, summary: import('./storage.js').BuildStatusSummary | null, nearLimit: boolean } } | { status: 'rejected', reason: unknown }} */ (
            /** @type {unknown} */ (statusOutcomes[i])
          );
          const task = statusTasks[i];

          if (outcome.status === 'fulfilled') {
            const { skippedDueToLimit, summary } = outcome.value;
            if (skippedDueToLimit) {
              task.pr.buildStatus = task.cached ?? null;
              continue;
            }
            task.pr.buildStatus = summary;
            if (summary && task.cacheKey) {
              nextStatusCache[task.cacheKey] = summary;
              cacheMutated = true;
            }
          } else {
            const reason = outcome.reason;
            if (reason instanceof BitbucketApiError && reason.status === 429) {
              nearLimit = true;
            }
            task.pr.buildStatus = task.cached ?? null;
            partialErrors.push({
              scope: `${task.pr.key} (statuses)`,
              message: reason instanceof Error ? reason.message : 'Failed to fetch PR build statuses.',
              status: reason instanceof BitbucketApiError ? reason.status : null
            });
          }
        }
      }

      if (cacheMutated) {
        try {
          await storage.setCachedBuildStatuses(nextStatusCache);
        } catch {
          // Non-fatal cache persistence failure
        }
      }
    }

    return {
      prs,
      user,
      workspaces,
      nearLimit,
      partialErrors
    };
  }

  /**
   * Fetch diffstat metadata for a single PR using the client's `fetchFn` and `nowFn`.
   *
   * @param {Partial<import('./storage.js').Credentials>} creds
   * @param {Pick<import('./storage.js').PullRequestRecord, 'id' | 'repoFullName' | 'workspace' | 'repoName' | 'sourceCommitHash'>} pr
   * @returns {Promise<import('./storage.js').DiffstatSummary | null>}
   */
  async function fetchDiffstat(creds, pr) {
    try {
      const authHeader = buildAuthHeader(creds);
      return await fetchBitbucketDiffstat({ fetchFn, authHeader, pr, nowFn });
    } catch {
      return null;
    }
  }

  return {
    verifyCredentials,
    fetchPullRequests,
    fetchDiffstat
  };
}
