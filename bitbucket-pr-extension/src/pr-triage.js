import { sanitizeHttpsUrl } from './config.js';

/**
 * @typedef {'author' | 'reviewer' | 'both'} PrRole
 * @typedef {'approved' | 'changes_requested' | 'pending' | null} ParticipantReviewState
 * @typedef {'needs_review' | 'changes_requested' | 'ci_failed' | 'ready_to_merge' | 'waiting_reviewers' | 'approved_by_you' | 'changes_requested_by_you' | 'draft'} ActionState
 * @typedef {'action_required' | 'reviewing' | 'authored' | 'all' | 'snoozed'} PrFilter
 */

/**
 * @typedef {Object} JiraTicketLink
 * @property {string} key
 * @property {string | null} url
 */

/**
 * @typedef {import('./storage.js').PullRequestRecord & {
 *   provider: import('./storage.js').PrProvider,
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
 *   jiraTickets: JiraTicketLink[],
 *   issueRefs: string[],
 *   primaryTicketKey: string | null
 * }} EnrichedPullRequest
 */

/**
 * @typedef {Object} RelatedPrSummary
 * @property {string} ticketKey
 * @property {string[]} relatedKeys
 */

/**
 * @typedef {Object} TicketPrGroup
 * @property {string} groupKey
 * @property {string} label
 * @property {string | null} ticketUrl
 * @property {boolean} isUnlinked
 * @property {EnrichedPullRequest[]} prs
 * @property {number} yourTurnCount
 * @property {number} approvedCount
 * @property {number} ciFailedCount
 * @property {import('./storage.js').PrProvider[]} providers
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
const JIRA_BROWSE_URL_REGEX = /\/browse\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)\b/g;
const GITHUB_KEYWORD_ISSUE_REGEX = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|relates?\s+to)\s*:?\s*(#\d+)\b/gi;
const GITHUB_TITLE_ISSUE_REGEX = /(?:^|[\s([:])(#\d+)\b/g;

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
 * Extract deduplicated uppercase Jira issue keys from PR title, source branch, and optional description,
 * including Jira `/browse/PROJ-123` URLs, preserving discovery order.
 *
 * @param {string} [title]
 * @param {string} [sourceBranch]
 * @param {string} [description]
 * @returns {string[]}
 */
export function extractJiraKeys(title = '', sourceBranch = '', description = '') {
  const safeTitle = typeof title === 'string' ? title : '';
  const safeBranch = typeof sourceBranch === 'string' ? sourceBranch : '';
  const safeDescription = typeof description === 'string' ? description : '';

  const seen = new Set();
  /** @type {string[]} */
  const keys = [];

  const collectFromSegment = (segment) => {
    if (!segment) {
      return;
    }
    const directMatches = segment.match(JIRA_KEY_REGEX);
    if (directMatches) {
      for (const key of directMatches) {
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
    }
    for (const match of segment.matchAll(JIRA_BROWSE_URL_REGEX)) {
      const upper = match[1].toUpperCase();
      if (!seen.has(upper)) {
        seen.add(upper);
        keys.push(upper);
      }
    }
  };

  collectFromSegment(safeTitle);
  collectFromSegment(safeBranch);
  collectFromSegment(safeDescription);
  return keys;
}

/**
 * Extract deduplicated GitHub/issue `#123` references from `Fixes #123`, `Closes #123`, `Refs #123`,
 * or `#123` tokens in title/branch/description.
 *
 * @param {string} [title]
 * @param {string} [sourceBranch]
 * @param {string} [description]
 * @returns {string[]}
 */
export function extractGitHubIssueRefs(title = '', sourceBranch = '', description = '') {
  const safeTitle = typeof title === 'string' ? title : '';
  const safeBranch = typeof sourceBranch === 'string' ? sourceBranch : '';
  const safeDescription = typeof description === 'string' ? description : '';

  const seen = new Set();
  /** @type {string[]} */
  const refs = [];

  const addRef = (ref) => {
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  };

  for (const match of safeTitle.matchAll(GITHUB_TITLE_ISSUE_REGEX)) {
    addRef(match[1]);
  }
  for (const segment of [safeTitle, safeBranch, safeDescription]) {
    if (!segment) {
      continue;
    }
    for (const match of segment.matchAll(GITHUB_KEYWORD_ISSUE_REGEX)) {
      addRef(match[1]);
    }
  }

  return refs;
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
 * Resolve the primary ticket key for a PR: first Jira key if present, else first `#123` issue ref, else `null`.
 *
 * @param {Partial<Pick<EnrichedPullRequest, 'jiraKeys' | 'issueRefs'>> | null | undefined} pr
 * @returns {string | null}
 */
export function getPrimaryTicketKey(pr) {
  if (!pr || typeof pr !== 'object') {
    return null;
  }
  if (Array.isArray(pr.jiraKeys) && pr.jiraKeys.length > 0 && typeof pr.jiraKeys[0] === 'string' && pr.jiraKeys[0]) {
    return pr.jiraKeys[0];
  }
  if (Array.isArray(pr.issueRefs) && pr.issueRefs.length > 0 && typeof pr.issueRefs[0] === 'string' && pr.issueRefs[0]) {
    return pr.issueRefs[0];
  }
  return null;
}

/**
 * Enrich a normalized PR with role, approval counts, "Your Turn" action state,
 * priority score, staleness, auto-detected Jira ticket chips, and GitHub issue references.
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

  const ciState = pr.buildStatus?.state ?? null;
  const ciFailed = ciState === 'FAILED' || ciState === 'STOPPED';

  if (pr.draft) {
    actionState = 'draft';
    isYourTurn = false;
    priorityScore = 5;
  } else if (role === 'reviewer') {
    if (myParticipantState === 'pending') {
      actionState = 'needs_review';
      isYourTurn = true;
      priorityScore = ciFailed ? 92 : 100;
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
    } else if (ciFailed) {
      actionState = 'ci_failed';
      isYourTurn = true;
      priorityScore = 105;
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
    // role === 'both': prioritize author blocking states first, then CI failures, then pending self-review, then ready/waiting
    if (changesRequestedCount > 0) {
      actionState = 'changes_requested';
      isYourTurn = true;
      priorityScore = 110;
    } else if (ciFailed) {
      actionState = 'ci_failed';
      isYourTurn = true;
      priorityScore = 105;
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

  const jiraKeys = extractJiraKeys(pr.title, pr.sourceBranch, pr.description);
  const jiraTickets = buildJiraTicketLinks(jiraKeys, jiraBaseUrl);
  const issueRefs = extractGitHubIssueRefs(pr.title, pr.sourceBranch, pr.description);
  const primaryTicketKey = getPrimaryTicketKey({ jiraKeys, issueRefs });
  /** @type {import('./storage.js').PrProvider} */
  const provider = pr.provider === 'github' ? 'github' : 'bitbucket';

  return {
    ...pr,
    provider,
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
    jiraTickets,
    issueRefs,
    primaryTicketKey
  };
}

/**
 * Build a map from each PR's `key` to other open PRs sharing a ticket key (Jira key or `#123` issue ref),
 * spanning both Bitbucket and GitHub PRs.
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @returns {Record<string, RelatedPrSummary>}
 */
export function buildRelatedPrMap(enrichedPrs) {
  if (!Array.isArray(enrichedPrs) || enrichedPrs.length === 0) {
    return {};
  }

  /** @type {Map<string, string[]>} */
  const ticketToPrKeys = new Map();
  /** @type {Map<string, string[]>} */
  const prToTickets = new Map();

  for (const pr of enrichedPrs) {
    if (!pr || typeof pr.key !== 'string' || !pr.key) {
      continue;
    }
    const ticketSet = new Set();
    if (Array.isArray(pr.jiraKeys)) {
      for (const k of pr.jiraKeys) {
        if (typeof k === 'string' && k) {
          ticketSet.add(k);
        }
      }
    }
    if (Array.isArray(pr.issueRefs)) {
      for (const ref of pr.issueRefs) {
        if (typeof ref === 'string' && ref) {
          ticketSet.add(ref);
        }
      }
    }
    const tickets = Array.from(ticketSet);
    if (tickets.length === 0) {
      continue;
    }
    prToTickets.set(pr.key, tickets);
    for (const ticketKey of tickets) {
      const list = ticketToPrKeys.get(ticketKey) ?? [];
      if (!list.includes(pr.key)) {
        list.push(pr.key);
        ticketToPrKeys.set(ticketKey, list);
      }
    }
  }

  /** @type {Record<string, RelatedPrSummary>} */
  const relatedMap = {};
  for (const pr of enrichedPrs) {
    const tickets = prToTickets.get(pr.key);
    if (!tickets) {
      continue;
    }
    let bestTicketKey = '';
    /** @type {string[]} */
    const relatedSetOrder = [];
    const relatedSeen = new Set();

    for (const ticketKey of tickets) {
      const peers = (ticketToPrKeys.get(ticketKey) ?? []).filter((k) => k !== pr.key);
      if (peers.length > 0 && !bestTicketKey) {
        bestTicketKey = ticketKey;
      }
      for (const peerKey of peers) {
        if (!relatedSeen.has(peerKey)) {
          relatedSeen.add(peerKey);
          relatedSetOrder.push(peerKey);
        }
      }
    }

    if (relatedSetOrder.length > 0) {
      relatedMap[pr.key] = {
        ticketKey: bestTicketKey,
        relatedKeys: relatedSetOrder
      };
    }
  }

  return relatedMap;
}

/**
 * Group enriched PRs by their primary ticket key (`getPrimaryTicketKey(pr)`).
 * Unlinked PRs are collected into a single `UNLINKED` group placed last (`label: 'No Linked Ticket'`).
 * Groups are ordered: linked groups with `yourTurnCount > 0` (by highest PR priorityScore),
 * then remaining linked groups (by highest PR priorityScore), then `UNLINKED`.
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @param {import('./storage.js').SnoozedMap | null | undefined} [snoozedMap]
 * @param {number} [now]
 * @returns {TicketPrGroup[]}
 */
export function groupPrsByTicket(enrichedPrs, snoozedMap = {}, now = Date.now()) {
  if (!Array.isArray(enrichedPrs) || enrichedPrs.length === 0) {
    return [];
  }

  /** @type {Map<string, {
   *   groupKey: string,
   *   label: string,
   *   ticketUrl: string | null,
   *   isUnlinked: boolean,
   *   prs: EnrichedPullRequest[],
   *   yourTurnCount: number,
   *   approvedCount: number,
   *   ciFailedCount: number,
   *   providers: Set<import('./storage.js').PrProvider>,
   *   highestPriority: number
   * }>} */
  const groups = new Map();

  for (const pr of enrichedPrs) {
    const primaryKey = getPrimaryTicketKey(pr);
    const isUnlinked = !primaryKey;
    const groupKey = primaryKey || 'UNLINKED';
    const label = primaryKey || 'No Linked Ticket';

    let ticketUrl = null;
    if (primaryKey && Array.isArray(pr.jiraTickets)) {
      const match = pr.jiraTickets.find((t) => t.key === primaryKey);
      if (match && match.url) {
        ticketUrl = match.url;
      }
    }

    const effectiveYourTurn = Boolean(pr.isYourTurn) && !isPrSnoozed(pr, snoozedMap, now);
    const isApproved = pr.approvalsCount > 0 && pr.changesRequestedCount === 0;
    const ciState = pr.buildStatus?.state ?? null;
    const isCiFailed = ciState === 'FAILED' || ciState === 'STOPPED';
    /** @type {import('./storage.js').PrProvider} */
    const provider = pr.provider === 'github' ? 'github' : 'bitbucket';

    const existing = groups.get(groupKey);
    if (existing) {
      existing.prs.push(pr);
      if (effectiveYourTurn) {
        existing.yourTurnCount += 1;
      }
      if (isApproved) {
        existing.approvedCount += 1;
      }
      if (isCiFailed) {
        existing.ciFailedCount += 1;
      }
      if (!existing.ticketUrl && ticketUrl) {
        existing.ticketUrl = ticketUrl;
      }
      if (pr.priorityScore > existing.highestPriority) {
        existing.highestPriority = pr.priorityScore;
      }
      existing.providers.add(provider);
    } else {
      groups.set(groupKey, {
        groupKey,
        label,
        ticketUrl,
        isUnlinked,
        prs: [pr],
        yourTurnCount: effectiveYourTurn ? 1 : 0,
        approvedCount: isApproved ? 1 : 0,
        ciFailedCount: isCiFailed ? 1 : 0,
        providers: new Set([provider]),
        highestPriority: pr.priorityScore
      });
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => {
      if (a.isUnlinked !== b.isUnlinked) {
        return a.isUnlinked ? 1 : -1;
      }
      const aHasYourTurn = a.yourTurnCount > 0;
      const bHasYourTurn = b.yourTurnCount > 0;
      if (aHasYourTurn !== bHasYourTurn) {
        return aHasYourTurn ? -1 : 1;
      }
      if (a.highestPriority !== b.highestPriority) {
        return b.highestPriority - a.highestPriority;
      }
      return a.label.localeCompare(b.label);
    })
    .map((g) => ({
      groupKey: g.groupKey,
      label: g.label,
      ticketUrl: g.ticketUrl,
      isUnlinked: g.isUnlinked,
      prs: g.prs,
      yourTurnCount: g.yourTurnCount,
      approvedCount: g.approvedCount,
      ciFailedCount: g.ciFailedCount,
      providers: Array.from(g.providers)
    }));
}

/**
 * Collect unique Jira tickets referenced across all open enriched PRs,
 * sorted by urgency (`hasYourTurn`, `highestPriority`, `prCount`, key).
 * Snoozed PRs do not contribute `hasYourTurn: true`.
 *
 * @param {readonly EnrichedPullRequest[]} enrichedPrs
 * @param {import('./storage.js').SnoozedMap | null | undefined} [snoozedMap]
 * @param {number} [now]
 * @returns {ActiveJiraTicketSummary[]}
 */
export function collectActiveJiraTickets(enrichedPrs, snoozedMap = {}, now = Date.now()) {
  /** @type {Map<string, ActiveJiraTicketSummary>} */
  const ticketMap = new Map();

  for (const pr of enrichedPrs) {
    const tickets = Array.isArray(pr.jiraTickets) ? pr.jiraTickets : [];
    const effectiveYourTurn = Boolean(pr.isYourTurn) && !isPrSnoozed(pr, snoozedMap, now);
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
        if (effectiveYourTurn) {
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
          hasYourTurn: effectiveYourTurn,
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
 * Check if an enriched PR matches a case-insensitive substring query (including CI status tokens
 * like `ci:failed`, `ci:passing`, `ci:running`, `ci:stopped`, AI triage tokens `effort:quick`,
 * `effort:medium`, `effort:deep`, `risk:high`, `alert:hotfix`, plus build name, `title`, `repoName`,
 * `repoFullName`, `authorName`, `sourceBranch`, and `jiraKeys`).
 *
 * @param {EnrichedPullRequest} pr
 * @param {string} normalizedQuery
 * @returns {boolean}
 */
function matchesSearchQuery(pr, normalizedQuery) {
  if (!normalizedQuery) {
    return true;
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ciState = pr.buildStatus?.state ?? null;
  const aiEffort = pr.aiTriage?.effort ?? null;
  const aiAlert = pr.aiTriage?.alert ?? null;
  const aiRiskScore = typeof pr.aiTriage?.riskScore === 'number' ? pr.aiTriage.riskScore : null;

  /** @type {string[]} */
  const textTokens = [];
  for (const token of tokens) {
    if (token === 'ci:failed') {
      if (ciState !== 'FAILED' && ciState !== 'STOPPED') {
        return false;
      }
      continue;
    }
    if (token === 'ci:passing') {
      if (ciState !== 'SUCCESSFUL') {
        return false;
      }
      continue;
    }
    if (token === 'ci:running') {
      if (ciState !== 'INPROGRESS') {
        return false;
      }
      continue;
    }
    if (token === 'ci:stopped') {
      if (ciState !== 'STOPPED') {
        return false;
      }
      continue;
    }
    if (token === 'effort:quick') {
      if (aiEffort !== 'quick') {
        return false;
      }
      continue;
    }
    if (token === 'effort:medium') {
      if (aiEffort !== 'medium') {
        return false;
      }
      continue;
    }
    if (token === 'effort:deep') {
      if (aiEffort !== 'deep') {
        return false;
      }
      continue;
    }
    if (token === 'risk:high') {
      if (aiAlert !== 'high_risk' && (aiRiskScore === null || aiRiskScore < 4)) {
        return false;
      }
      continue;
    }
    if (token === 'alert:hotfix') {
      if (aiAlert !== 'hotfix') {
        return false;
      }
      continue;
    }
    textTokens.push(token);
  }

  if (textTokens.length === 0) {
    return true;
  }

  const haystack = [
    pr.title,
    pr.repoName,
    pr.repoFullName,
    pr.authorName,
    pr.sourceBranch,
    pr.buildStatus?.name || '',
    ...(Array.isArray(pr.jiraKeys) ? pr.jiraKeys : [])
  ]
    .join(' ')
    .toLowerCase();

  if (textTokens.length === 1) {
    return haystack.includes(textTokens[0]);
  }
  return haystack.includes(textTokens.join(' '));
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
