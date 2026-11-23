/**
 * Pure data normalization and partitioning utilities for Bitbucket Pull Requests.
 * Zero Chrome API dependencies so this module can run in Service Workers, popups, and Bun tests.
 */

const REVIEW_PRIORITY = {
  pending: 0,
  changes_requested: 1,
  approved: 2,
};

function normalizeUuid(uuid) {
  return typeof uuid === 'string' ? uuid.replace(/[{}]/g, '').trim().toLowerCase() : '';
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function toTimestamp(isoString) {
  if (!isoString) return 0;
  const parsed = Date.parse(isoString);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Strictly compares a Bitbucket user object against the current user.
 * Matches by normalized UUID or strict account_id equality.
 * Falls back to exact lowercase username equality ONLY when both uuid and account_id are absent on candidate.
 */
export function isSameUser(candidate, currentUser) {
  if (!candidate || !currentUser) return false;

  const candUuid = normalizeUuid(candidate.uuid);
  const currUuid = normalizeUuid(currentUser.uuid);
  if (candUuid && currUuid && candUuid === currUuid) {
    return true;
  }

  const candAccountId = normalizeId(candidate.account_id ?? candidate.accountId);
  const currAccountId = normalizeId(currentUser.account_id ?? currentUser.accountId);
  if (candAccountId && currAccountId && candAccountId === currAccountId) {
    return true;
  }

  if (!candUuid && !candAccountId) {
    const candUsername = normalizeUsername(candidate.username);
    const currUsername = normalizeUsername(currentUser.username);
    if (candUsername && currUsername && candUsername === currUsername) {
      return true;
    }
  }

  return false;
}

/**
 * Validates that a URL uses an http: or https: scheme.
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return trimmed;
    }
    return '';
  } catch {
    return '';
  }
}

function findMatchingReviewer(entries, user) {
  const candUuid = normalizeUuid(user?.uuid);
  const candAccountId = normalizeId(user?.account_id ?? user?.accountId);
  const candDisplayName = (user?.display_name || user?.displayName || '').trim().toLowerCase();

  return entries.find((entry) => {
    const entryUuid = normalizeUuid(entry.uuid);
    const entryAccountId = normalizeId(entry.accountId);

    if (candUuid && entryUuid) {
      return candUuid === entryUuid;
    }
    if (candAccountId && entryAccountId) {
      return candAccountId === entryAccountId;
    }
    if (candDisplayName && entry.displayName) {
      return candDisplayName === entry.displayName.trim().toLowerCase();
    }
    return false;
  });
}

function resolveParticipantReviewState(participant) {
  if (participant?.approved === true || participant?.state === 'approved') {
    return { state: 'approved', approved: true };
  }
  if (participant?.state === 'changes_requested') {
    return { state: 'changes_requested', approved: false };
  }
  return { state: 'pending', approved: false };
}

function buildReviewerEntry(user, reviewState, currentUser) {
  return {
    displayName: user?.display_name || user?.nickname || user?.username || 'Reviewer',
    uuid: user?.uuid || '',
    accountId: user?.account_id || '',
    avatarUrl: sanitizeUrl(user?.links?.avatar?.href),
    state: reviewState.state,
    approved: reviewState.approved,
    isMe: isSameUser(user, currentUser),
  };
}

function mergeReviewers(rawPr, currentUser) {
  const entries = [];
  const rawAuthor = rawPr?.author || null;
  const participants = Array.isArray(rawPr?.participants) ? rawPr.participants : [];
  const rawReviewers = Array.isArray(rawPr?.reviewers) ? rawPr.reviewers : [];

  for (const participant of participants) {
    if (!participant || !participant.user) continue;

    const isReviewerRole = participant.role === 'REVIEWER';
    const hasExplicitDecision =
      participant.approved === true || participant.state === 'changes_requested';

    if (!isReviewerRole && !hasExplicitDecision) {
      continue;
    }

    const user = participant.user;
    if (rawAuthor && isSameUser(user, rawAuthor) && !hasExplicitDecision) {
      continue;
    }

    const reviewState = resolveParticipantReviewState(participant);
    const existing = findMatchingReviewer(entries, user);
    if (existing) {
      if (!existing.uuid && user.uuid) existing.uuid = user.uuid;
      if (!existing.accountId && user.account_id) existing.accountId = user.account_id;
      if (!existing.avatarUrl && user.links?.avatar?.href) {
        existing.avatarUrl = sanitizeUrl(user.links.avatar.href);
      }
      if (existing.state === 'pending' && reviewState.state !== 'pending') {
        existing.state = reviewState.state;
        existing.approved = reviewState.approved;
      }
      continue;
    }

    entries.push(buildReviewerEntry(user, reviewState, currentUser));
  }

  for (const reviewer of rawReviewers) {
    if (!reviewer) continue;

    const existing = findMatchingReviewer(entries, reviewer);
    if (existing) {
      if (!existing.uuid && reviewer.uuid) existing.uuid = reviewer.uuid;
      if (!existing.accountId && reviewer.account_id) existing.accountId = reviewer.account_id;
      if (!existing.avatarUrl && reviewer.links?.avatar?.href) {
        existing.avatarUrl = sanitizeUrl(reviewer.links.avatar.href);
      }
      continue;
    }

    if (rawAuthor && isSameUser(reviewer, rawAuthor)) {
      continue;
    }

    entries.push(
      buildReviewerEntry(reviewer, { state: 'pending', approved: false }, currentUser)
    );
  }

  return entries;
}

const IGNORED_KEY_PREFIXES = new Set([
  'UTF',
  'ISO',
  'SHA',
  'MD',
  'HTTP',
  'HTTPS',
  'TLS',
  'SSL',
  'EC',
  'AES',
  'RSA',
  'RC',
  'PR',
]);

/**
 * Normalizes a Jira Cloud site URL to its origin (e.g. "https://org.atlassian.net").
 */
export function normalizeJiraBaseUrl(input) {
  if (typeof input !== 'string') return '';
  let trimmed = input.trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Extracts unique Jira issue keys (e.g. PROJ-123) and any explicit /browse/ URLs
 * from a PR's description, source branch, and title.
 */
export function extractJiraTickets({ sourceBranch = '', title = '', description = '' } = {}, jiraBaseUrl = '') {
  const base = normalizeJiraBaseUrl(jiraBaseUrl);
  const found = new Map();

  // 1. Explicit Jira browse URLs in description
  const browseUrlRe = /https?:\/\/[^\s"'<>)\]]+\/browse\/([A-Z][A-Z0-9_]{1,15}-\d+)\b/g;
  for (const match of String(description || '').matchAll(browseUrlRe)) {
    const key = match[1];
    const url = sanitizeUrl(match[0]);
    if (key && url && !found.has(key)) {
      found.set(key, { key, url });
    }
  }

  // 2. Keys in source branch, title, then description
  const keyRe = /\b([A-Z][A-Z0-9_]{1,15})-(\d+)\b/g;
  for (const text of [sourceBranch, title, description]) {
    for (const match of String(text || '').matchAll(keyRe)) {
      const prefix = match[1];
      if (IGNORED_KEY_PREFIXES.has(prefix)) continue;
      const key = `${prefix}-${match[2]}`;
      if (!found.has(key)) {
        found.set(key, {
          key,
          url: base ? `${base}/browse/${key}` : '',
        });
      }
    }
  }

  return Array.from(found.values());
}

/**
 * Normalizes a raw Bitbucket Pull Request API object into a stable UI/storage model.
 */
export function normalizePullRequest(rawPr, currentUser) {
  const repoFullName =
    rawPr?.destination?.repository?.full_name ||
    rawPr?.source?.repository?.full_name ||
    '';
  const repoName =
    rawPr?.destination?.repository?.name ||
    repoFullName.split('/').pop() ||
    'Repository';

  const id = rawPr?.id;
  const key = `${repoFullName}#${id}`;
  const rawAuthor = rawPr?.author || null;

  const author = {
    displayName:
      rawAuthor?.display_name ||
      rawAuthor?.nickname ||
      rawAuthor?.username ||
      'Unknown Author',
    uuid: rawAuthor?.uuid || '',
    accountId: rawAuthor?.account_id || '',
    avatarUrl: sanitizeUrl(rawAuthor?.links?.avatar?.href),
  };

  const reviewers = mergeReviewers(rawPr, currentUser);
  const isAuthor = isSameUser(rawAuthor, currentUser);
  const myReviewerEntry = !isAuthor ? reviewers.find((r) => r.isMe) : undefined;
  const isReviewer = Boolean(myReviewerEntry);
  const myReviewState = myReviewerEntry ? myReviewerEntry.state : 'none';

  const commentCountRaw = Number(rawPr?.comment_count ?? 0);
  const taskCountRaw = Number(rawPr?.task_count ?? 0);

  const title = rawPr?.title || 'Untitled Pull Request';
  const description = (rawPr?.description || rawPr?.summary?.raw || '').trim();
  const sourceBranch = rawPr?.source?.branch?.name || '';
  const destinationBranch = rawPr?.destination?.branch?.name || '';

  return {
    key,
    id,
    title,
    description,
    state: rawPr?.state || 'OPEN',
    url: sanitizeUrl(rawPr?.links?.html?.href),
    repoFullName,
    repoName,
    sourceBranch,
    destinationBranch,
    author,
    createdOn: rawPr?.created_on || '',
    updatedOn: rawPr?.updated_on || rawPr?.created_on || '',
    commentCount: Number.isFinite(commentCountRaw) ? commentCountRaw : 0,
    taskCount: Number.isFinite(taskCountRaw) ? taskCountRaw : 0,
    reviewers,
    jiraTickets: extractJiraTickets({ sourceBranch, title, description }),
    isAuthor,
    isReviewer,
    myReviewState,
  };
}

/**
 * Partitions normalized pull requests into authored PRs and PRs to review.
 */
export function partitionPullRequests(prs) {
  const list = Array.isArray(prs) ? prs : [];

  const myPrs = list
    .filter((p) => p.isAuthor)
    .sort((a, b) => toTimestamp(b.updatedOn) - toTimestamp(a.updatedOn));

  const toReviewPrs = list
    .filter((p) => p.isReviewer)
    .sort((a, b) => {
      const priorityA = REVIEW_PRIORITY[a.myReviewState] ?? 3;
      const priorityB = REVIEW_PRIORITY[b.myReviewState] ?? 3;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return toTimestamp(b.updatedOn) - toTimestamp(a.updatedOn);
    });

  const pendingReviewCount = toReviewPrs.filter(
    (p) => p.myReviewState === 'pending'
  ).length;

  return {
    myPrs,
    toReviewPrs,
    pendingReviewCount,
  };
}
