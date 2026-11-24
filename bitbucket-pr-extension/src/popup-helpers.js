import { sanitizeHttpsUrl } from './config.js';
import { filterAndSortPrs } from './pr-triage.js';

/** @typedef {import('./pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('./pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('./storage.js').BuildState} BuildState */
/** @typedef {import('./storage.js').BuildStatusSummary} BuildStatusSummary */
/** @typedef {import('./storage.js').SnoozedMap} SnoozedMap */

/**
 * @typedef {Object} ReviewerBreakdown
 * @property {string[]} approvedNames
 * @property {string[]} changesRequestedNames
 * @property {string[]} pendingNames
 * @property {string} approvalTooltip
 */

/**
 * @typedef {'ci-successful' | 'ci-failed' | 'ci-inprogress' | 'ci-stopped'} CiBadgeStateClass
 */

/**
 * @typedef {Object} CiBadgeDescriptor
 * @property {CiBadgeStateClass} stateClass
 * @property {string} label
 * @property {string} tooltip
 * @property {string | null} safeUrl
 */

/**
 * @typedef {Object} CrossFilterEmptyHint
 * @property {number} matchCount
 * @property {string} label
 */

/** @type {Readonly<Record<PrFilter, string>>} */
export const FILTER_LABELS = Object.freeze({
  action_required: 'Needs Action',
  reviewing: 'Reviewing',
  authored: 'My PRs',
  all: 'All PRs',
  snoozed: 'Snoozed'
});

/**
 * Format a compact relative age label (`just now`, `Nm`, `Nh`, `Nd`, or short date like `Nov 8` for >= 14d).
 * Returns `''` for invalid or missing timestamps.
 *
 * @param {string | null | undefined} isoTimestamp
 * @param {number} [now]
 * @returns {string}
 */
export function formatRelativeAge(isoTimestamp, now = Date.now()) {
  if (typeof isoTimestamp !== 'string' || !isoTimestamp.trim()) {
    return '';
  }
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    return '';
  }

  const refNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const diffMinutes = Math.max(0, Math.floor((refNow - parsed) / 60_000));
  if (diffMinutes < 1) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 14) {
    return `${diffDays}d`;
  }
  return new Date(parsed).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
}

/**
 * Format the footer sync status timestamp (`Never updated`, `Updated just now`, `Updated Nm ago`, `Updated Nh ago`, `Updated Nd ago`).
 *
 * @param {number | null | undefined} lastUpdated
 * @param {number} [now]
 * @returns {string}
 */
export function formatFooterUpdated(lastUpdated, now = Date.now()) {
  if (typeof lastUpdated !== 'number' || !Number.isFinite(lastUpdated) || lastUpdated <= 0) {
    return 'Never updated';
  }

  const refNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const diffMinutes = Math.max(0, Math.floor((refNow - lastUpdated) / 60_000));
  if (diffMinutes < 1) {
    return 'Updated just now';
  }
  if (diffMinutes < 60) {
    return `Updated ${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `Updated ${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `Updated ${diffDays}d ago`;
}

/**
 * Format remaining snooze duration (`<1m left`, `Nm left`, `Nh left`, `Nh Mm left`).
 * Returns `''` when the snooze is expired (`untilMs <= now`) or invalid.
 *
 * @param {number | null | undefined} untilMs
 * @param {number} [now]
 * @returns {string}
 */
export function formatRemainingSnooze(untilMs, now = Date.now()) {
  if (typeof untilMs !== 'number' || !Number.isFinite(untilMs)) {
    return '';
  }

  const refNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const remainingMs = untilMs - refNow;
  if (remainingMs <= 0) {
    return '';
  }
  if (remainingMs < 60_000) {
    return '<1m left';
  }

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours > 0 && mins > 0) {
    return `${hours}h ${mins}m left`;
  }
  if (hours > 0) {
    return `${hours}h left`;
  }
  return `${mins}m left`;
}

/**
 * Build reviewer breakdown name lists (`approvedNames`, `changesRequestedNames`, `pendingNames`)
 * and summary tooltip text for a pull request.
 *
 * @param {Partial<EnrichedPullRequest> | null | undefined} pr
 * @returns {ReviewerBreakdown}
 */
export function buildReviewerBreakdown(pr) {
  if (!pr || typeof pr !== 'object') {
    return {
      approvedNames: [],
      changesRequestedNames: [],
      pendingNames: [],
      approvalTooltip: ''
    };
  }

  const authorUuid = typeof pr.authorUuid === 'string' ? pr.authorUuid : '';
  const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
  const participants = Array.isArray(pr.participants) ? pr.participants : [];

  /** @type {Map<string, { displayName: string, state: 'approved' | 'changes_requested' | 'pending' }>} */
  const byUuid = new Map();

  for (const r of reviewers) {
    if (r && typeof r.uuid === 'string' && r.uuid && r.uuid !== authorUuid) {
      const displayName = typeof r.displayName === 'string' && r.displayName.trim()
        ? r.displayName.trim()
        : 'Reviewer';
      byUuid.set(r.uuid, {
        displayName,
        state: 'pending'
      });
    }
  }

  for (const p of participants) {
    if (!p || typeof p.uuid !== 'string' || !p.uuid || p.uuid === authorUuid) {
      continue;
    }
    const existing = byUuid.get(p.uuid);
    const hasReviewVote = p.state === 'approved' || Boolean(p.approved) || p.state === 'changes_requested';
    if (p.role === 'REVIEWER' || existing || hasReviewVote) {
      /** @type {'approved' | 'changes_requested' | 'pending'} */
      let reviewState = 'pending';
      if (p.state === 'approved' || p.approved) {
        reviewState = 'approved';
      } else if (p.state === 'changes_requested') {
        reviewState = 'changes_requested';
      }
      const rawName = typeof p.displayName === 'string' ? p.displayName.trim() : '';
      byUuid.set(p.uuid, {
        displayName: rawName || existing?.displayName || 'Reviewer',
        state: reviewState
      });
    }
  }

  /** @type {string[]} */
  const approvedNames = [];
  /** @type {string[]} */
  const changesRequestedNames = [];
  /** @type {string[]} */
  const pendingNames = [];

  for (const entry of byUuid.values()) {
    if (entry.state === 'approved') {
      approvedNames.push(entry.displayName);
    } else if (entry.state === 'changes_requested') {
      changesRequestedNames.push(entry.displayName);
    } else {
      pendingNames.push(entry.displayName);
    }
  }

  /** @type {string[]} */
  const lines = [];
  if (approvedNames.length > 0) {
    lines.push(`Approved: ${approvedNames.join(', ')}`);
  }
  if (changesRequestedNames.length > 0) {
    lines.push(`Changes requested: ${changesRequestedNames.join(', ')}`);
  }
  if (pendingNames.length > 0) {
    lines.push(`Pending: ${pendingNames.join(', ')}`);
  }

  const approvalsCount = typeof pr.approvalsCount === 'number' && Number.isFinite(pr.approvalsCount) && pr.approvalsCount >= 0
    ? pr.approvalsCount
    : 0;
  const totalReviewers = typeof pr.totalReviewers === 'number' && Number.isFinite(pr.totalReviewers) && pr.totalReviewers >= 0
    ? pr.totalReviewers
    : 0;

  let approvalTooltip = '';
  if (lines.length > 0) {
    approvalTooltip = lines.join('\n');
  } else if (approvalsCount > 0 || totalReviewers > 0) {
    approvalTooltip = `${approvalsCount} approval(s)`;
  }

  return {
    approvedNames,
    changesRequestedNames,
    pendingNames,
    approvalTooltip
  };
}

/**
 * Build a multi-line tooltip summarizing Approved / Changes requested / Pending reviewer names.
 *
 * @param {Partial<EnrichedPullRequest> | null | undefined} pr
 * @returns {string}
 */
export function buildReviewerBreakdownTooltip(pr) {
  return buildReviewerBreakdown(pr).approvalTooltip;
}

/**
 * Derive CI status badge presentation descriptor (`stateClass`, `label`, `tooltip`, `safeUrl`)
 * for `SUCCESSFUL`, `FAILED`, `INPROGRESS`, or `STOPPED`, or `null` if absent/unrecognized.
 *
 * @param {Partial<BuildStatusSummary> | null | undefined} buildStatus
 * @returns {CiBadgeDescriptor | null}
 */
export function getCiBadgeDescriptor(buildStatus) {
  if (!buildStatus || typeof buildStatus !== 'object') {
    return null;
  }

  const totalCount = typeof buildStatus.totalCount === 'number' &&
    Number.isFinite(buildStatus.totalCount) &&
    buildStatus.totalCount > 0
    ? Math.floor(buildStatus.totalCount)
    : 0;
  const rawPassed = typeof buildStatus.passedCount === 'number' &&
    Number.isFinite(buildStatus.passedCount) &&
    buildStatus.passedCount >= 0
    ? Math.floor(buildStatus.passedCount)
    : 0;
  const passedCount = totalCount > 0 ? Math.min(rawPassed, totalCount) : rawPassed;

  /** @type {CiBadgeStateClass} */
  let stateClass;
  let label;

  if (buildStatus.state === 'SUCCESSFUL') {
    stateClass = 'ci-successful';
    label = totalCount > 1 ? `✓ ${passedCount}/${totalCount}` : '✓ CI';
  } else if (buildStatus.state === 'FAILED') {
    stateClass = 'ci-failed';
    label = totalCount > 1 ? `✕ ${passedCount}/${totalCount}` : '✕ CI';
  } else if (buildStatus.state === 'INPROGRESS') {
    stateClass = 'ci-inprogress';
    label = '⟳ CI';
  } else if (buildStatus.state === 'STOPPED') {
    stateClass = 'ci-stopped';
    label = '■ CI';
  } else {
    return null;
  }

  const buildName = typeof buildStatus.name === 'string' && buildStatus.name.trim()
    ? buildStatus.name.trim()
    : 'Checks';
  const countsPart = totalCount > 0
    ? ` (${passedCount}/${totalCount} passed)`
    : '';

  return {
    stateClass,
    label,
    tooltip: `Build: ${buildName}${countsPart}`,
    safeUrl: sanitizeHttpsUrl(buildStatus.url)
  };
}

/**
 * Determine whether a search in a non-`all` filter missed while `all` contains matches,
 * returning `{ matchCount, label }` or `null`.
 *
 * @param {{
 *   activeFilter?: PrFilter | string | null,
 *   searchQuery?: string | null,
 *   allPrs?: readonly EnrichedPullRequest[] | null,
 *   snoozedMap?: SnoozedMap | null,
 *   now?: number
 * } | null | undefined} params
 * @returns {CrossFilterEmptyHint | null}
 */
export function getCrossFilterEmptyHint(params) {
  if (!params || typeof params !== 'object') {
    return null;
  }

  const activeFilter = params.activeFilter;
  if (typeof activeFilter !== 'string' || activeFilter === 'all' || !(activeFilter in FILTER_LABELS)) {
    return null;
  }

  const trimmedQuery = typeof params.searchQuery === 'string' ? params.searchQuery.trim() : '';
  if (!trimmedQuery) {
    return null;
  }

  const allPrs = Array.isArray(params.allPrs) ? params.allPrs : [];
  if (allPrs.length === 0) {
    return null;
  }

  const snoozedMap = params.snoozedMap ?? {};
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? params.now : Date.now();
  const typedFilter = /** @type {PrFilter} */ (activeFilter);

  const activeMatches = filterAndSortPrs(allPrs, {
    filter: typedFilter,
    query: trimmedQuery,
    snoozedMap,
    now
  });
  if (activeMatches.length > 0) {
    return null;
  }

  const allMatches = filterAndSortPrs(allPrs, {
    filter: 'all',
    query: trimmedQuery,
    snoozedMap,
    now
  });
  if (allMatches.length === 0) {
    return null;
  }

  const filterLabel = FILTER_LABELS[typedFilter] ?? typedFilter;
  const matchCount = allMatches.length;
  return {
    matchCount,
    label: `No matches in ${filterLabel} — ${matchCount} match${matchCount === 1 ? '' : 'es'} in All PRs.`
  };
}
