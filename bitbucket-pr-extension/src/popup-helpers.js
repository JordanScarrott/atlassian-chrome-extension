import { sanitizeHttpsUrl } from './config.js';
import { filterAndSortPrs, isPrSnoozed } from './pr-triage.js';

/** @typedef {import('./pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('./pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('./storage.js').BuildState} BuildState */
/** @typedef {import('./storage.js').BuildStatusSummary} BuildStatusSummary */
/** @typedef {import('./storage.js').CachedUser} CachedUser */
/** @typedef {import('./storage.js').SnoozedMap} SnoozedMap */
/** @typedef {import('./storage.js').WorkspaceSummary} WorkspaceSummary */

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

/**
 * @typedef {Object} HeaderConnectionDescriptor
 * @property {'neutral' | 'connected' | 'warning' | 'error'} variant
 * @property {string} text
 * @property {string} title
 * @property {string} ariaLabel
 */

/**
 * Derive status chip variant, concise label, and multi-account tooltip for single or dual-provider connections.
 *
 * @param {{
 *   bitbucketAuthenticated?: boolean,
 *   bitbucketUser?: CachedUser | null,
 *   bitbucketUsername?: string,
 *   github?: { isAuthenticated?: boolean, apiBaseUrl?: string, user?: CachedUser | null } | null,
 *   syncedWorkspaces?: readonly string[],
 *   workspaces?: readonly WorkspaceSummary[],
 *   error?: string | null,
 *   rateLimitWarning?: boolean,
 *   backoffUntil?: number | null,
 *   now?: number
 * }} params
 * @returns {HeaderConnectionDescriptor}
 */
export function getHeaderConnectionDescriptor(params) {
  const bbAuthed = Boolean(params?.bitbucketAuthenticated);
  const ghAuthed = Boolean(params?.github?.isAuthenticated);
  const now = typeof params?.now === 'number' && Number.isFinite(params.now) ? params.now : Date.now();

  if (!bbAuthed && !ghAuthed) {
    return {
      variant: 'neutral',
      text: 'Not connected',
      title: 'Click to connect Bitbucket or GitHub',
      ariaLabel: 'Connection status: Not connected. Open settings'
    };
  }

  /** @type {string[]} */
  const accountLines = [];

  if (bbAuthed) {
    const bbName = params?.bitbucketUser?.displayName || params?.bitbucketUsername || 'Bitbucket';
    const synced = Array.isArray(params?.syncedWorkspaces) ? params.syncedWorkspaces.filter(Boolean) : [];
    const fallbackWs = Array.isArray(params?.workspaces)
      ? params.workspaces.map((ws) => ws.slug).filter(Boolean)
      : [];
    const wsList = synced.length > 0 ? synced : fallbackWs;
    accountLines.push(
      wsList.length > 0
        ? `Bitbucket: ${bbName} (${wsList.join(', ')})`
        : `Bitbucket: ${bbName}`
    );
  }

  if (ghAuthed) {
    const ghUser = params?.github?.user;
    const ghLogin = typeof ghUser?.username === 'string' ? ghUser.username.trim() : '';
    const ghDisplay = typeof ghUser?.displayName === 'string' ? ghUser.displayName.trim() : '';
    const ghIdentity = ghDisplay && ghLogin && ghDisplay !== ghLogin
      ? `${ghDisplay} (@${ghLogin})`
      : (ghLogin ? `@${ghLogin}` : (ghDisplay || 'GitHub'));
    const ghApi = typeof params?.github?.apiBaseUrl === 'string' && params.github.apiBaseUrl.trim()
      ? ` [${params.github.apiBaseUrl.trim()}]`
      : '';
    accountLines.push(`GitHub: ${ghIdentity}${ghApi}`);
  }

  let connectedLabel;
  if (bbAuthed && ghAuthed) {
    connectedLabel = 'Bitbucket + GitHub';
  } else if (ghAuthed) {
    const ghLogin = typeof params?.github?.user?.username === 'string' ? params.github.user.username.trim() : '';
    const ghDisplay = typeof params?.github?.user?.displayName === 'string' ? params.github.user.displayName.trim() : '';
    connectedLabel = ghLogin ? `GitHub (@${ghLogin})` : (ghDisplay || 'GitHub');
  } else {
    connectedLabel = params?.bitbucketUser?.displayName || params?.bitbucketUsername || 'Connected';
  }

  if (params?.error) {
    return {
      variant: 'error',
      text: 'Sync issue',
      title: [params.error, ...accountLines].join('\n'),
      ariaLabel: 'Connection status: Sync issue. Open settings'
    };
  }

  const backoffUntil = typeof params?.backoffUntil === 'number' ? params.backoffUntil : null;
  if (params?.rateLimitWarning || (backoffUntil !== null && backoffUntil > now)) {
    const rateNote = backoffUntil !== null && backoffUntil > now
      ? `Auto-polling paused until ${new Date(backoffUntil).toLocaleTimeString()}`
      : 'Approaching API rate limit';
    return {
      variant: 'warning',
      text: 'Rate limited',
      title: [rateNote, ...accountLines].join('\n'),
      ariaLabel: 'Connection status: Rate limited. Open settings'
    };
  }

  return {
    variant: 'connected',
    text: connectedLabel,
    title: [...accountLines, 'Click to open Settings'].join('\n'),
    ariaLabel: `Connected (${connectedLabel}). Open settings`
  };
}

/**
 * Filter open PRs across all providers sharing a Jira ticket key or `#123` issue ref,
 * preserving priority triage sort order.
 *
 * @param {readonly EnrichedPullRequest[]} prs
 * @param {string} ticketKey
 * @returns {EnrichedPullRequest[]}
 */
export function filterPrsByRelatedTicket(prs, ticketKey) {
  if (!Array.isArray(prs) || typeof ticketKey !== 'string' || !ticketKey.trim()) {
    return [];
  }
  const target = ticketKey.trim();
  const matches = prs.filter((pr) => {
    if (!pr || typeof pr !== 'object') {
      return false;
    }
    const inJira = Array.isArray(pr.jiraKeys) && pr.jiraKeys.includes(target);
    const inIssues = Array.isArray(pr.issueRefs) && pr.issueRefs.includes(target);
    return inJira || inIssues;
  });

  return [...matches].sort((a, b) => {
    if (a.isYourTurn !== b.isYourTurn) {
      return a.isYourTurn ? -1 : 1;
    }
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    const timeA = Date.parse(a.updatedOn || a.createdOn || '') || 0;
    const timeB = Date.parse(b.updatedOn || b.createdOn || '') || 0;
    if (timeA !== timeB) {
      return timeB - timeA;
    }
    return a.key.localeCompare(b.key);
  });
}

/**
 * @typedef {Object} ActionBadgeMeta
 * @property {string} label
 * @property {string} title
 */

/** @type {Readonly<Record<string, ActionBadgeMeta>>} */
export const ACTION_BADGE_LABELS = Object.freeze({
  needs_review: {
    label: 'Needs Review',
    title: 'Your review is pending on this pull request'
  },
  changes_requested: {
    label: 'Changes Requested',
    title: 'A reviewer requested changes on your pull request'
  },
  ci_failed: {
    label: 'CI Failed',
    title: 'Latest CI build on your pull request failed or stopped'
  },
  ready_to_merge: {
    label: 'Ready to Merge',
    title: 'Approved by reviewers with no outstanding change requests or failing builds'
  },
  waiting_reviewers: {
    label: 'Waiting',
    title: 'Waiting on reviewers or updates from others'
  },
  approved_by_you: {
    label: 'Approved',
    title: 'You have approved this pull request'
  },
  changes_requested_by_you: {
    label: 'Changes Sent',
    title: 'You requested changes; waiting on author updates'
  },
  draft: {
    label: 'Draft',
    title: 'Draft pull request (excluded from Needs Action)'
  }
});

/**
 * @typedef {'dot-red' | 'dot-blue' | 'dot-green' | 'dot-gray'} DeckDotColorClass
 */

/**
 * @typedef {Object} DeckDotDescriptor
 * @property {DeckDotColorClass} colorClass
 * @property {string} tooltip
 */

/**
 * @typedef {Object} OffscreenDeckAttention
 * @property {number} totalOffscreen
 * @property {number} leftCount
 * @property {number} rightCount
 * @property {number} targetIndex
 * @property {string} label
 */

/**
 * Sort PRs inside a Ticket Deck by Attention Set urgency so slide 1 is always most urgent:
 * `isYourTurn` -> `priorityScore` descending -> `updatedOn` descending -> `key`.
 *
 * @param {readonly EnrichedPullRequest[]} prs
 * @returns {EnrichedPullRequest[]}
 */
export function sortDeckPrs(prs) {
  if (!Array.isArray(prs) || prs.length === 0) {
    return [];
  }
  return [...prs].sort((a, b) => {
    if (a.isYourTurn !== b.isYourTurn) {
      return a.isYourTurn ? -1 : 1;
    }
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    const timeA = Date.parse(a.updatedOn || a.createdOn || '') || 0;
    const timeB = Date.parse(b.updatedOn || b.createdOn || '') || 0;
    if (timeA !== timeB) {
      return timeB - timeA;
    }
    return a.key.localeCompare(b.key);
  });
}

/**
 * Derive color-coded mini-map dot class and hover tooltip for a PR slide in a Ticket Deck.
 *
 * @param {Pick<EnrichedPullRequest, 'actionState' | 'repoName' | 'repoFullName' | 'title'>} pr
 * @returns {DeckDotDescriptor}
 */
export function getDeckDotDescriptor(pr) {
  /** @type {DeckDotColorClass} */
  let colorClass = 'dot-gray';
  if (pr.actionState === 'ci_failed' || pr.actionState === 'changes_requested') {
    colorClass = 'dot-red';
  } else if (pr.actionState === 'needs_review') {
    colorClass = 'dot-blue';
  } else if (pr.actionState === 'ready_to_merge' || pr.actionState === 'approved_by_you') {
    colorClass = 'dot-green';
  }

  const actionLabel = ACTION_BADGE_LABELS[pr.actionState]?.label ?? pr.actionState;
  const repoLabel = pr.repoName || pr.repoFullName || 'PR';
  return {
    colorClass,
    tooltip: `${repoLabel}: ${pr.title} (${actionLabel})`
  };
}

/**
 * Summarize off-screen PRs in a Ticket Deck that need the user's attention (`isYourTurn === true`),
 * returning directional badge text and a jump target index, or `null` if none are off-screen.
 *
 * @param {readonly Pick<EnrichedPullRequest, 'key' | 'updatedOn' | 'isYourTurn'>[]} prs
 * @param {number} activeIndex
 * @param {SnoozedMap | null | undefined} [snoozedMap]
 * @param {number} [now]
 * @returns {OffscreenDeckAttention | null}
 */
export function getOffscreenDeckAttention(prs, activeIndex, snoozedMap = {}, now = Date.now()) {
  if (!Array.isArray(prs) || prs.length <= 1) {
    return null;
  }
  const safeActive = Math.max(0, Math.min(prs.length - 1, Math.floor(activeIndex)));
  let leftCount = 0;
  let rightCount = 0;
  let firstLeftIndex = -1;
  let firstRightIndex = -1;

  for (let i = 0; i < prs.length; i += 1) {
    if (i === safeActive) {
      continue;
    }
    const pr = prs[i];
    const effectiveYourTurn = Boolean(pr?.isYourTurn) && !isPrSnoozed(pr, snoozedMap, now);
    if (!effectiveYourTurn) {
      continue;
    }
    if (i < safeActive) {
      leftCount += 1;
      if (firstLeftIndex === -1) {
        firstLeftIndex = i;
      }
    } else {
      rightCount += 1;
      if (firstRightIndex === -1) {
        firstRightIndex = i;
      }
    }
  }

  const totalOffscreen = leftCount + rightCount;
  if (totalOffscreen === 0) {
    return null;
  }

  let label;
  let targetIndex;
  if (rightCount > 0 && leftCount === 0) {
    label = `+${rightCount} needs action →`;
    targetIndex = firstRightIndex;
  } else if (leftCount > 0 && rightCount === 0) {
    label = `← +${leftCount} needs action`;
    targetIndex = firstLeftIndex;
  } else {
    label = `← +${totalOffscreen} needs action →`;
    targetIndex = firstRightIndex;
  }

  return {
    totalOffscreen,
    leftCount,
    rightCount,
    targetIndex,
    label
  };
}
