import { sanitizeHttpsUrl } from './config.js';

/**
 * @typedef {'author' | 'reviewer' | 'both'} PrRole
 * @typedef {'approved' | 'changes_requested' | 'pending' | null} ParticipantReviewState
 * @typedef {'needs_review' | 'changes_requested' | 'ready_to_merge' | 'waiting_reviewers' | 'approved_by_you' | 'changes_requested_by_you' | 'draft'} ActionState
 * @typedef {'action_required' | 'reviewing' | 'authored' | 'all' | 'snoozed'} PrFilter
 */

/**
 * @typedef {Object} JiraTicketLink
 * @property {string} key
 * @property {string | null} url
 */

/**
 * @typedef {import('./storage.js').PullRequestRecord & {
 *   role: PrRole,
 *   approvalsCount: number,
 *   changesRequestedCount: number,
 *   totalReviewers: number,
 *   myParticipantState: ParticipantReviewState,
 *   actionState: ActionState,
 *   isYourTurn: boolean,
 *   priorityScore: number,
 *   ageHours: number,
 *   isStale: boolean,
 *   jiraKeys: string[],
 *   jiraTickets: JiraTicketLink[]
 * }} EnrichedPullRequest
 */

/**
 * @typedef {Object} ActiveJiraTicketSummary
 * @property {string} key
 * @property {string | null} url
 * @property {number} prCount
 * @property {number} highestPriority
 * @property {boolean} hasYourTurn
 * @property {string[]} prKeys
 */

/**
 * @typedef {Object} PrCounts
 * @property {number} actionRequired
 * @property {number} reviewing
 * @property {number} authored
 * @property {number} all
 * @property {number} snoozed
 */

const JIRA_KEY_REGEX = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/**
 * Normalize a Jira base URL into `https://origin/optional-base` without trailing slash, or `''`.
 *
 * @param {unknown} jiraBaseUrl
 * @returns {string}
 */
function normalizeJiraBase(jiraBaseUrl) {
  const safe = sanitizeHttpsUrl(jiraBaseUrl);
  if (!safe) {
    return '';
  }
  const parsed = new URL(safe);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Extract deduplicated uppercase Jira issue keys from PR title and source branch, preserving order.
 *
 * @param {string} [title]
 * @param {string} [sourceBranch]
 * @returns {string[]}
 */
export function extractJiraKeys(title = '', sourceBranch = '') {
  const combined = `${typeof title === 'string' ? title : ''} ${typeof sourceBranch === 'string' ? sourceBranch : ''}`;
  const matches = combined.match(JIRA_KEY_REGEX);
  if (!matches) {
    return [];
  }
  const seen = new Set();
  const keys = [];
  for (const key of matches) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Build deep links (`{ key, url }`) for extracted Jira keys against a validated `https://` Jira base URL.
 *
 * @param {readonly string[]} keys
 * @param {string} [jiraBaseUrl]
 * @returns {JiraTicketLink[]}
 */
export function buildJiraTicketLinks(keys, jiraBaseUrl = '') {
  const normalizedBase = normalizeJiraBase(jiraBaseUrl);
  return keys.map((key) => ({
    key,
    url: normalizedBase ? `${normalizedBase}/browse/${encodeURIComponent(key)}` : null
  }));
}

/**
 * Enrich a normalized PR with role, approval counts, "Your Turn" action state,
 * priority score, staleness, and auto-detected Jira ticket chips.
 *
 * @param {import('./storage.js').PullRequestRecord} pr
 * @param {string} currentUserUuid
 * @param {{ staleThresholdHours?: number, jiraBaseUrl?: string, now?: number }} [options]
 * @returns {EnrichedPullRequest}
 */
export function enrichPullRequest(pr, currentUserUuid, options = {}) {
  const staleThresholdHours = typeof options.staleThresholdHours === 'number' && options.staleThresholdHours > 0
    ? options.staleThresholdHours
    : 48;
  const jiraBaseUrl = typeof options.jiraBaseUrl === 'string' ? options.jiraBaseUrl : '';
  const now = typeof options.now === 'number' ? options.now : Date.now();

  const isAuthor = Boolean(currentUserUuid) && pr.authorUuid === currentUserUuid;
  const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
  const participants = Array.isArray(pr.participants) ? pr.participants : [];

  const inReviewers = Boolean(currentUserUuid) && reviewers.some((r) => r.uuid === currentUserUuid);
  const myParticipant = Boolean(currentUserUuid)
    ? participants.find((p) => p.uuid === currentUserUuid)
    : undefined;
  const isReviewerParticipant = Boolean(
    myParticipant && (myParticipant.role === 'REVIEWER' || inReviewers)
  );
  const isReviewer = inReviewers || isReviewerParticipant;

  /** @type {PrRole} */
  let role = 'reviewer';
  if (isAuthor && isReviewer) {
    role = 'both';
  } else if (isAuthor) {
    role = 'author';
  } else {
    role = 'reviewer';
  }

  let approvalsCount = 0;
  let changesRequestedCount = 0;
  const nonAuthorParticipantUuids = new Set();

  for (const r of reviewers) {
    if (r.uuid && r.uuid !== pr.authorUuid) {
      nonAuthorParticipantUuids.add(r.uuid);
    }
  }

  for (const p of participants) {
    if (p.uuid === pr.authorUuid) {
      continue;
    }
    if (p.role === 'REVIEWER') {
      nonAuthorParticipantUuids.add(p.uuid);
    }
    if (p.state === 'approved' || p.approved) {
      approvalsCount += 1;
    } else if (p.state === 'changes_requested') {
      changesRequestedCount += 1;
    }
  }

  const totalReviewers = nonAuthorParticipantUuids.size;

  /** @type {ParticipantReviewState} */
  let myParticipantState = null;
  if (isReviewer) {
    if (myParticipant) {
      if (myParticipant.state === 'approved' || myParticipant.approved) {
        myParticipantState = 'approved';
      } else if (myParticipant.state === 'changes_requested') {
        myParticipantState = 'changes_requested';
      } else {
        myParticipantState = 'pending';
      }
    } else {
      myParticipantState = 'pending';
    }
  }

  /** @type {ActionState} */
  let actionState;
  let isYourTurn = false;
  let priorityScore = 10;

  if (pr.draft) {
    actionState = 'draft';
    isYourTurn = false;
    priorityScore = 5;
  } else if (role === 'reviewer') {
    if (myParticipantState === 'pending') {
      actionState = 'needs_review';
      isYourTurn = true;
      priorityScore = 100;
    } else if (myParticipantState === 'changes_requested') {
      actionState = 'changes_requested_by_you';
      isYourTurn = false;
      priorityScore = 40;
    } else if (myParticipantState === 'approved') {
      actionState = 'approved_by_you';
      isYourTurn = false;
      priorityScore = 20;
    } else {
      actionState = 'waiting_reviewers';
      isYourTurn = false;
      priorityScore = 10;
    }
  } else if (role === 'author') {
    if (changesRequestedCount > 0) {
      actionState = 'changes_requested';
      isYourTurn = true;
      priorityScore = 110;
    } else if (approvalsCount > 0 && changesRequestedCount === 0) {
      actionState = 'ready_to_merge';
      isYourTurn = true;
      priorityScore = 95;
    } else {
      actionState = 'waiting_reviewers';
      isYourTurn = false;
      priorityScore = 50;
    }
  } else {
    // role === 'both': prioritize author blocking states first, then pending self-review, then ready/waiting
    if (changesRequestedCount > 0) {
      actionState = 'changes_requested';
      isYourTurn = true;
      priorityScore = 110;
    } else if (myParticipantState === 'pending') {
      actionState = 'needs_review';
      isYourTurn = true;
      priorityScore = 100;
    } else if (approvalsCount > 0 && changesRequestedCount === 0) {
      actionState = 'ready_to_merge';
      isYourTurn = true;
      priorityScore = 95;
    } else if (myParticipantState === 'changes_requested') {
      actionState = 'changes_requested_by_you';
      isYourTurn = false;
      priorityScore = 40;
    } else {
      actionState = 'waiting_reviewers';
      isYourTurn = false;
      priorityScore = 50;
    }
  }

  const updatedMs = Date.parse(pr.updatedOn || pr.createdOn || '');
  const ageHours = Number.isNaN(updatedMs)
    ? 0
    : Math.max(0, (now - updatedMs) / (60 * 60 * 1000));
  const isStale = ageHours >= staleThresholdHours;

  const jiraKeys = extractJiraKeys(pr.title, pr.sourceBranch);
  const jiraTickets = buildJiraTicketLinks(jiraKeys, jiraBaseUrl);

  return {
    ...pr,
    role,
    approvalsCount,
    changesRequestedCount,
    totalReviewers,
    myParticipantState,
    actionState,
    isYourTurn,
    priorityScore,
    ageHours,
    isStale,
    jiraKeys,
    jiraTickets
  };
}

/**
 * Collect unique Jira tickets referenced across all open enriched PRs,
 * sorted by urgency (`hasYourTurn`, `highestPriority`, `prCount`, key).
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @returns {ActiveJiraTicketSummary[]}
 */
export function collectActiveJiraTickets(enrichedPrs) {
  /** @type {Map<string, ActiveJiraTicketSummary>} */
  const ticketMap = new Map();

  for (const pr of enrichedPrs) {
    const tickets = Array.isArray(pr.jiraTickets) ? pr.jiraTickets : [];
    for (const ticket of tickets) {
      const existing = ticketMap.get(ticket.key);
      if (existing) {
        if (!existing.prKeys.includes(pr.key)) {
          existing.prKeys.push(pr.key);
          existing.prCount += 1;
        }
        if (pr.priorityScore > existing.highestPriority) {
          existing.highestPriority = pr.priorityScore;
        }
        if (pr.isYourTurn) {
          existing.hasYourTurn = true;
        }
        if (!existing.url && ticket.url) {
          existing.url = ticket.url;
        }
      } else {
        ticketMap.set(ticket.key, {
          key: ticket.key,
          url: ticket.url,
          prCount: 1,
          highestPriority: pr.priorityScore,
          hasYourTurn: pr.isYourTurn,
          prKeys: [pr.key]
        });
      }
    }
  }

  return Array.from(ticketMap.values()).sort((a, b) => {
    if (a.hasYourTurn !== b.hasYourTurn) {
      return a.hasYourTurn ? -1 : 1;
    }
    if (a.highestPriority !== b.highestPriority) {
      return b.highestPriority - a.highestPriority;
    }
    if (a.prCount !== b.prCount) {
      return b.prCount - a.prCount;
    }
    return a.key.localeCompare(b.key);
  });
}

/**
 * Determine whether a PR is currently snoozed.
 * Returns `true` ONLY if a snooze entry exists, `now < entry.until`, AND `pr.updatedOn === entry.prUpdatedOn`.
 * Any new commit/comment/activity advancing `updatedOn` automatically unsnoozes the PR.
 *
 * @param {Pick<import('./storage.js').PullRequestRecord, 'key' | 'updatedOn'>} pr
 * @param {import('./storage.js').SnoozedMap | null | undefined} snoozedMap
 * @param {number} [now]
 * @returns {boolean}
 */
export function isPrSnoozed(pr, snoozedMap, now = Date.now()) {
  if (!snoozedMap || typeof snoozedMap !== 'object') {
    return false;
  }
  const entry = snoozedMap[pr.key];
  if (!entry) {
    return false;
  }
  if (now >= entry.until) {
    return false;
  }
  return pr.updatedOn === entry.prUpdatedOn;
}

/**
 * Return a cleaned snooze map removing expired snoozes, PRs no longer open,
 * or PRs whose `updatedOn` timestamp changed since snoozing.
 *
 * @param {import('./storage.js').SnoozedMap | null | undefined} snoozedMap
 * @param {readonly Pick<import('./storage.js').PullRequestRecord, 'key' | 'updatedOn'>[]} prs
 * @param {number} [now]
 * @returns {import('./storage.js').SnoozedMap}
 */
export function pruneExpiredSnoozes(snoozedMap, prs, now = Date.now()) {
  if (!snoozedMap || typeof snoozedMap !== 'object') {
    return {};
  }
  /** @type {Map<string, string>} */
  const prUpdatedMap = new Map();
  for (const pr of prs) {
    prUpdatedMap.set(pr.key, pr.updatedOn);
  }

  /** @type {import('./storage.js').SnoozedMap} */
  const cleaned = {};
  for (const [key, entry] of Object.entries(snoozedMap)) {
    if (!entry || now >= entry.until) {
      continue;
    }
    const currentUpdatedOn = prUpdatedMap.get(key);
    if (currentUpdatedOn === undefined || currentUpdatedOn !== entry.prUpdatedOn) {
      continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

/**
 * Check if an enriched PR matches a case-insensitive substring query across
 * `title`, `repoName`, `repoFullName`, `authorName`, `sourceBranch`, and `jiraKeys`.
 *
 * @param {EnrichedPullRequest} pr
 * @param {string} normalizedQuery
 * @returns {boolean}
 */
function matchesSearchQuery(pr, normalizedQuery) {
  if (!normalizedQuery) {
    return true;
  }
  const haystack = [
    pr.title,
    pr.repoName,
    pr.repoFullName,
    pr.authorName,
    pr.sourceBranch,
    ...(Array.isArray(pr.jiraKeys) ? pr.jiraKeys : [])
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

/**
 * Filter and sort enriched PRs by pill filter and search query.
 * Snoozed PRs are excluded from `'action_required'`, `'reviewing'`, `'authored'`, and `'all'`
 * and appear exclusively in `'snoozed'`.
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @param {{
 *   filter?: PrFilter,
 *   query?: string,
 *   snoozedMap?: import('./storage.js').SnoozedMap | null,
 *   now?: number
 * }} [options]
 * @returns {EnrichedPullRequest[]}
 */
export function filterAndSortPrs(enrichedPrs, options = {}) {
  const filter = options.filter ?? 'action_required';
  const normalizedQuery = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const snoozedMap = options.snoozedMap ?? {};
  const now = typeof options.now === 'number' ? options.now : Date.now();

  const filtered = enrichedPrs.filter((pr) => {
    const snoozed = isPrSnoozed(pr, snoozedMap, now);

    if (filter === 'snoozed') {
      if (!snoozed) {
        return false;
      }
    } else {
      if (snoozed) {
        return false;
      }
      if (filter === 'action_required' && !pr.isYourTurn) {
        return false;
      }
      if (filter === 'reviewing' && pr.role !== 'reviewer' && pr.role !== 'both') {
        return false;
      }
      if (filter === 'authored' && pr.role !== 'author' && pr.role !== 'both') {
        return false;
      }
    }

    return matchesSearchQuery(pr, normalizedQuery);
  });

  return [...filtered].sort((a, b) => {
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
 * Compute pill badge counts across non-snoozed filters and snoozed PRs.
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @param {import('./storage.js').SnoozedMap | null | undefined} [snoozedMap]
 * @param {number} [now]
 * @returns {PrCounts}
 */
export function computeCounts(enrichedPrs, snoozedMap = {}, now = Date.now()) {
  let actionRequired = 0;
  let reviewing = 0;
  let authored = 0;
  let all = 0;
  let snoozed = 0;

  for (const pr of enrichedPrs) {
    if (isPrSnoozed(pr, snoozedMap, now)) {
      snoozed += 1;
      continue;
    }

    all += 1;
    if (pr.isYourTurn) {
      actionRequired += 1;
    }
    if (pr.role === 'reviewer' || pr.role === 'both') {
      reviewing += 1;
    }
    if (pr.role === 'author' || pr.role === 'both') {
      authored += 1;
    }
  }

  return {
    actionRequired,
    reviewing,
    authored,
    all,
    snoozed
  };
}
