import {
  ACTION_BADGE_LABELS,
  buildReviewerBreakdown,
  formatRelativeAge,
  formatRemainingSnooze,
  getAiTriageBadges,
  getCiBadgeDescriptor,
  getDeckDotDescriptor,
  getOffscreenDeckAttention,
  sortDeckPrs
} from '../popup-helpers.js';
import { sanitizeHttpsUrl } from '../config.js';
import { isPrSnoozed } from '../pr-triage.js';

export { ACTION_BADGE_LABELS };

/** @typedef {import('../popup-helpers.js').AiTriageBadgeDescriptor} AiTriageBadgeDescriptor */
/** @typedef {import('../pr-triage.js').EnrichedPullRequest} EnrichedPullRequest */
/** @typedef {import('../pr-triage.js').PrFilter} PrFilter */
/** @typedef {import('../pr-triage.js').RelatedPrSummary} RelatedPrSummary */
/** @typedef {import('../pr-triage.js').TicketPrGroup} TicketPrGroup */
/** @typedef {import('../storage.js').PrProvider} PrProvider */
/** @typedef {import('../storage.js').SnoozedMap} SnoozedMap */

/**
 * @typedef {Object} PrCardCallbacks
 * @property {(rawUrl: string) => void | Promise<unknown>} onOpenUrl
 * @property {(pr: EnrichedPullRequest) => void | Promise<unknown>} onCopyUrl
 * @property {(pr: EnrichedPullRequest) => void | Promise<unknown>} onToggleSnooze
 * @property {(prKey: string, scrollIntoView?: boolean) => void} [onSelectCard]
 * @property {(ticketKey: string) => void} [onSelectRelatedTicket]
 * @property {(groupKey: string, nextCollapsed: boolean) => void} [onGroupCollapseToggle]
 * @property {(groupKey: string, slideIndex: number) => void} [onDeckIndexChange]
 * @property {(groupKey: string, nextExpanded: boolean) => void} [onDeckExpandToggle]
 */

/**
 * @typedef {Object} PrCardRenderOptions
 * @property {boolean} [showProviderBadge]
 * @property {RelatedPrSummary | null} [relatedSummary]
 * @property {string | null} [activeRelatedTicketKey]
 * @property {PrFilter} [activeFilter]
 * @property {SnoozedMap} [snoozedMap]
 */

/**
 * @typedef {Object} TicketGroupRenderOptions
 * @property {boolean} [showProviderBadge]
 * @property {string | null} [selectedPrKey]
 * @property {PrFilter} [activeFilter]
 * @property {Set<string>} [collapsedGroups]
 * @property {Set<string>} [expandedStackGroups]
 * @property {Map<string, number>} [deckActiveSlideMap]
 */

/**
 * Build a crisp CI status pill (`.ci-badge`) from `pr.buildStatus`.
 *
 * @param {NonNullable<EnrichedPullRequest['buildStatus']>} buildStatus
 * @param {(rawUrl: string) => void | Promise<unknown>} [onOpenUrl]
 * @returns {HTMLAnchorElement | HTMLSpanElement | null}
 */
export function buildCiBadgeElement(buildStatus, onOpenUrl) {
  const descriptor = getCiBadgeDescriptor(buildStatus);
  if (!descriptor) {
    return null;
  }

  const { stateClass, label, tooltip, safeUrl } = descriptor;
  const el = safeUrl ? document.createElement('a') : document.createElement('span');
  el.className = `ci-badge ${stateClass}`;
  el.textContent = label;
  el.title = tooltip;

  if (safeUrl && el instanceof HTMLAnchorElement) {
    el.href = safeUrl;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    el.setAttribute('aria-label', `${tooltip} — open build status`);
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onOpenUrl === 'function') {
        void onOpenUrl(safeUrl);
      }
    });
  }

  return el;
}

/**
 * Build a subtle AI triage badge (`.ai-badge`) element from a descriptor.
 *
 * @param {AiTriageBadgeDescriptor} descriptor
 * @returns {HTMLSpanElement}
 */
export function buildAiBadgeElement(descriptor) {
  const el = document.createElement('span');
  el.className = `ai-badge ${descriptor.cssClass}`;
  el.textContent = descriptor.label;
  el.title = descriptor.tooltip;
  return el;
}

/**
 * Build a subtle provider micro-badge (`BB` or `GH`) element.
 *
 * @param {PrProvider} provider
 * @returns {HTMLSpanElement}
 */
export function buildProviderBadgeElement(provider) {
  const badge = document.createElement('span');
  badge.className = provider === 'github'
    ? 'provider-badge provider-gh'
    : 'provider-badge provider-bb';
  badge.textContent = provider === 'github' ? 'GH' : 'BB';
  badge.title = provider === 'github' ? 'GitHub pull request' : 'Bitbucket Cloud pull request';
  return badge;
}

/**
 * Scroll a Ticket Deck track smoothly or immediately to a specific slide index.
 *
 * @param {HTMLDivElement} trackEl
 * @param {readonly HTMLDivElement[]} slideElements
 * @param {number} targetIndex
 * @param {'auto' | 'smooth'} [behavior]
 */
export function scrollDeckToIndex(trackEl, slideElements, targetIndex, behavior = 'smooth') {
  const slideEl = slideElements[targetIndex];
  if (!slideEl) {
    return;
  }
  const slideWidth = trackEl.clientWidth || slideEl.offsetWidth;
  if (slideWidth > 0 && typeof trackEl.scrollTo === 'function') {
    trackEl.scrollTo({
      left: targetIndex * (slideWidth + 6),
      behavior
    });
  } else if (typeof slideEl.scrollIntoView === 'function') {
    slideEl.scrollIntoView({ inline: 'start', block: 'nearest', behavior });
  }
}

/**
 * Highlight a PR card as keyboard-selected, sync focus out of any previously focused PR card,
 * and optionally scroll the selected card into view (expanding any collapsed Ticket Group).
 *
 * @param {HTMLDivElement} prItemsContainer
 * @param {string | null} prKey
 * @param {{ scrollIntoView?: boolean, collapsedGroups?: Set<string> }} [options]
 */
export function highlightSelectedPrCard(prItemsContainer, prKey, options = {}) {
  const scrollIntoView = options.scrollIntoView ?? true;
  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLElement) {
    const focusedCard = activeEl.closest('.pr-card');
    if (focusedCard instanceof HTMLElement && focusedCard.dataset.prKey !== prKey) {
      activeEl.blur();
    }
  }

  const cards = prItemsContainer.querySelectorAll('.pr-card');
  for (const node of cards) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    const match = Boolean(prKey && node.dataset.prKey === prKey);
    node.classList.toggle('is-selected', match);
    node.setAttribute('aria-selected', match ? 'true' : 'false');
    if (match && scrollIntoView) {
      const parentGroup = node.closest('.ticket-group');
      if (parentGroup instanceof HTMLElement && parentGroup.classList.contains('is-collapsed')) {
        const groupKey = parentGroup.dataset.groupKey;
        if (groupKey) {
          options.collapsedGroups?.delete(groupKey);
          parentGroup.classList.remove('is-collapsed');
          const hdr = parentGroup.querySelector('.ticket-group-header');
          if (hdr) {
            hdr.setAttribute('aria-expanded', 'true');
          }
        }
      }
      node.scrollIntoView({ block: 'nearest', inline: 'start', behavior: 'smooth' });
    }
  }
}

/**
 * Navigate to the previous or next slide inside the Ticket Deck containing `selectedPrKey`.
 *
 * @param {HTMLDivElement} prItemsContainer
 * @param {string | null} selectedPrKey
 * @param {-1 | 1} delta
 * @param {(prKey: string, scrollIntoView?: boolean) => void} onSelectCard
 * @returns {boolean}
 */
export function navigateDeckSlideInContainer(prItemsContainer, selectedPrKey, delta, onSelectCard) {
  if (!selectedPrKey) {
    return false;
  }
  const cards = Array.from(prItemsContainer.querySelectorAll('.pr-card'));
  const selectedCard = cards.find(
    (node) => node instanceof HTMLElement && node.dataset.prKey === selectedPrKey
  );
  if (!(selectedCard instanceof HTMLElement)) {
    return false;
  }
  const groupEl = selectedCard.closest('.ticket-group');
  if (!(groupEl instanceof HTMLElement) || groupEl.classList.contains('is-expanded-stack')) {
    return false;
  }
  const slides = Array.from(groupEl.querySelectorAll('.ticket-deck-slide'));
  if (slides.length <= 1) {
    return false;
  }
  const slideIdx = slides.findIndex(
    (s) => s instanceof HTMLElement && s.dataset.prKey === selectedPrKey
  );
  if (slideIdx < 0) {
    return false;
  }
  const nextIdx = Math.max(0, Math.min(slides.length - 1, slideIdx + delta));
  if (nextIdx === slideIdx) {
    return true;
  }
  const navBtn = groupEl.querySelector(delta < 0 ? '.deck-nav-btn:first-of-type' : '.deck-nav-btn:nth-of-type(2)');
  if (navBtn instanceof HTMLButtonElement && !navBtn.disabled) {
    navBtn.click();
    return true;
  }
  const nextSlide = slides[nextIdx];
  const nextKey = nextSlide instanceof HTMLElement ? nextSlide.dataset.prKey : null;
  if (nextKey) {
    onSelectCard(nextKey, true);
    return true;
  }
  return false;
}

/**
 * Build a single accessible PR card DOM element without `innerHTML`.
 *
 * @param {EnrichedPullRequest} pr
 * @param {boolean} isSelected
 * @param {boolean} isSnoozed
 * @param {number} now
 * @param {PrCardRenderOptions} [options]
 * @param {PrCardCallbacks} [callbacks]
 * @returns {HTMLDivElement}
 */
export function buildPrCardElement(pr, isSelected, isSnoozed, now, options = {}, callbacks) {
  const card = document.createElement('div');
  card.className = 'pr-card';
  if (pr.isYourTurn) {
    card.classList.add('is-your-turn');
  }
  if (isSelected) {
    card.classList.add('is-selected');
  }
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  card.dataset.prKey = pr.key;
  card.tabIndex = 0;

  // Top row: provider badge + repo + PR ID + action/CI/stale/related badges
  const topRow = document.createElement('div');
  topRow.className = 'pr-card-top';

  const repoRow = document.createElement('div');
  repoRow.className = 'pr-repo-row';

  if (options.showProviderBadge) {
    repoRow.appendChild(buildProviderBadgeElement(pr.provider));
  }

  const repoEl = document.createElement('span');
  repoEl.className = 'pr-repo';
  repoEl.textContent = pr.repoFullName || pr.repoName;
  repoRow.appendChild(repoEl);

  const idEl = document.createElement('span');
  idEl.className = 'pr-id-tag';
  idEl.textContent = `#${pr.id}`;
  repoRow.appendChild(idEl);

  const badgesRow = document.createElement('div');
  badgesRow.className = 'pr-badges-row';

  if (options.relatedSummary && !options.activeRelatedTicketKey) {
    const relatedCount = options.relatedSummary.relatedKeys.length;
    const ticketKey = options.relatedSummary.ticketKey;
    if (relatedCount > 0 && ticketKey) {
      const relatedBtn = document.createElement('button');
      relatedBtn.type = 'button';
      relatedBtn.className = 'related-pr-pill';
      relatedBtn.textContent = `🔗 +${relatedCount} ${ticketKey}`;
      relatedBtn.title = `Show ${relatedCount + 1} related PRs for ${ticketKey}`;
      relatedBtn.setAttribute('aria-label', `Show ${relatedCount + 1} related PRs for ${ticketKey}`);
      relatedBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (callbacks && typeof callbacks.onSelectRelatedTicket === 'function') {
          callbacks.onSelectRelatedTicket(ticketKey);
        }
      });
      badgesRow.appendChild(relatedBtn);
    }
  }

  if (pr.buildStatus) {
    const ciBadgeEl = buildCiBadgeElement(pr.buildStatus, callbacks?.onOpenUrl);
    if (ciBadgeEl) {
      badgesRow.appendChild(ciBadgeEl);
    }
  }

  const { effortBadge, alertBadge } = getAiTriageBadges(pr.aiTriage, pr.diffstat);
  if (effortBadge) {
    badgesRow.appendChild(buildAiBadgeElement(effortBadge));
  }
  if (alertBadge) {
    badgesRow.appendChild(buildAiBadgeElement(alertBadge));
  }

  const badgeMeta = ACTION_BADGE_LABELS[pr.actionState] ?? {
    label: pr.actionState,
    title: ''
  };
  const actionBadge = document.createElement('span');
  actionBadge.className = `action-badge state-${pr.actionState}`;
  actionBadge.textContent = badgeMeta.label;
  if (badgeMeta.title) {
    actionBadge.title = badgeMeta.title;
  }
  badgesRow.appendChild(actionBadge);

  if (pr.isStale) {
    const staleBadge = document.createElement('span');
    staleBadge.className = 'stale-badge';
    staleBadge.textContent = 'Stale';
    staleBadge.title = `No updates for ${Math.floor(pr.ageHours)}h`;
    badgesRow.appendChild(staleBadge);
  }

  topRow.append(repoRow, badgesRow);

  // Title link
  const safePrUrl = sanitizeHttpsUrl(pr.url);
  const titleLink = document.createElement('a');
  titleLink.className = 'pr-title-link';
  titleLink.textContent = pr.title;
  if (safePrUrl) {
    titleLink.href = safePrUrl;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
  }
  titleLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (callbacks && typeof callbacks.onSelectCard === 'function') {
      callbacks.onSelectCard(pr.key, false);
    }
    if (callbacks && typeof callbacks.onOpenUrl === 'function') {
      void callbacks.onOpenUrl(pr.url);
    }
  });

  // Jira chips + source branch
  const chipsRow = document.createElement('div');
  chipsRow.className = 'pr-chips-row';
  const jiraTickets = Array.isArray(pr.jiraTickets) ? pr.jiraTickets : [];

  for (const ticket of jiraTickets) {
    const safeTicketUrl = sanitizeHttpsUrl(ticket.url);
    if (safeTicketUrl) {
      const chipLink = document.createElement('a');
      chipLink.className = 'jira-chip';
      chipLink.href = safeTicketUrl;
      chipLink.target = '_blank';
      chipLink.rel = 'noopener noreferrer';
      chipLink.textContent = `${ticket.key} ↗`;
      chipLink.title = `Open ${ticket.key} in Jira`;
      chipLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (callbacks && typeof callbacks.onOpenUrl === 'function') {
          void callbacks.onOpenUrl(safeTicketUrl);
        }
      });
      chipsRow.appendChild(chipLink);
    } else {
      const chipStatic = document.createElement('span');
      chipStatic.className = 'jira-chip jira-chip-static';
      chipStatic.textContent = ticket.key;
      chipStatic.title = 'Set Jira Base URL in Preferences or src/config.js to enable direct links';
      chipsRow.appendChild(chipStatic);
    }
  }

  if (pr.sourceBranch) {
    const branchChip = document.createElement('span');
    branchChip.className = 'pr-branch-chip';
    branchChip.textContent = pr.sourceBranch;
    branchChip.title = pr.destinationBranch
      ? `${pr.sourceBranch} -> ${pr.destinationBranch}`
      : pr.sourceBranch;
    chipsRow.appendChild(branchChip);
  }

  // Footer row: author, approvals/CR/tasks/comments/snooze, quick actions, relative age
  const footerRow = document.createElement('div');
  footerRow.className = 'pr-card-footer';

  const metaLeft = document.createElement('div');
  metaLeft.className = 'pr-meta-left';

  const authorEl = document.createElement('span');
  authorEl.className = 'pr-author';
  authorEl.textContent = pr.authorName;
  authorEl.title = pr.authorName;
  metaLeft.appendChild(authorEl);

  const reviewerInfo = buildReviewerBreakdown(pr);

  if (pr.totalReviewers > 0 || pr.approvalsCount > 0) {
    const approvalsEl = document.createElement('span');
    approvalsEl.className = pr.approvalsCount > 0 ? 'pr-stat-pill has-approvals' : 'pr-stat-pill';
    const denom = Math.max(pr.totalReviewers, pr.approvalsCount);
    approvalsEl.textContent = `✓ ${pr.approvalsCount}/${denom}`;
    approvalsEl.title = reviewerInfo.approvalTooltip;
    metaLeft.appendChild(approvalsEl);
  }

  if (pr.changesRequestedCount > 0) {
    const crEl = document.createElement('span');
    crEl.className = 'pr-stat-pill meta-cr-badge';
    crEl.textContent = `✕ ${pr.changesRequestedCount} CR`;
    crEl.title = reviewerInfo.changesRequestedNames.length > 0
      ? `Changes requested by: ${reviewerInfo.changesRequestedNames.join(', ')}`
      : `${pr.changesRequestedCount} reviewer(s) requested changes`;
    metaLeft.appendChild(crEl);
  }

  if (pr.taskCount > 0) {
    const tasksEl = document.createElement('span');
    tasksEl.className = 'pr-stat-pill meta-task-badge';
    tasksEl.textContent = `☑ ${pr.taskCount}`;
    tasksEl.title = `${pr.taskCount} unresolved task(s)`;
    metaLeft.appendChild(tasksEl);
  }

  if (pr.commentCount > 0) {
    const commentsEl = document.createElement('span');
    commentsEl.className = 'pr-stat-pill';
    commentsEl.textContent = `${pr.commentCount} cmt`;
    commentsEl.title = `${pr.commentCount} comment(s)`;
    metaLeft.appendChild(commentsEl);
  }

  const snoozeEntry = isSnoozed ? options.snoozedMap?.[pr.key] : undefined;
  if (isSnoozed && snoozeEntry && options.activeFilter === 'snoozed') {
    const remainingText = formatRemainingSnooze(snoozeEntry.until, now);
    if (remainingText) {
      const snoozeBadge = document.createElement('span');
      snoozeBadge.className = 'pr-stat-pill snooze-remaining-badge';
      snoozeBadge.textContent = remainingText;
      snoozeBadge.title = `Snoozed until ${new Date(snoozeEntry.until).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })} (resurfaces early if PR updates)`;
      metaLeft.appendChild(snoozeBadge);
    }
  }

  const metaRight = document.createElement('div');
  metaRight.className = 'pr-meta-right';

  const quickActions = document.createElement('div');
  quickActions.className = 'pr-quick-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'quick-action-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy PR link (c)';
  copyBtn.setAttribute('aria-label', `Copy link for ${pr.title}`);
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (callbacks && typeof callbacks.onCopyUrl === 'function') {
      void callbacks.onCopyUrl(pr);
    }
  });
  quickActions.appendChild(copyBtn);

  const snoozeBtn = document.createElement('button');
  snoozeBtn.type = 'button';
  snoozeBtn.className = 'quick-action-btn';
  snoozeBtn.textContent = isSnoozed ? 'Unsnooze' : 'Snooze 4h';
  snoozeBtn.title = isSnoozed ? 'Unsnooze PR (s)' : 'Snooze PR for 4 hours (s)';
  snoozeBtn.setAttribute('aria-label', `${snoozeBtn.textContent} ${pr.title}`);
  snoozeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (callbacks && typeof callbacks.onToggleSnooze === 'function') {
      void callbacks.onToggleSnooze(pr);
    }
  });
  quickActions.appendChild(snoozeBtn);

  const isoTimestamp = pr.updatedOn || pr.createdOn;
  const ageEl = document.createElement('span');
  ageEl.className = 'pr-age';
  ageEl.dataset.iso = isoTimestamp || '';
  ageEl.textContent = formatRelativeAge(isoTimestamp, now);
  if (isoTimestamp && !Number.isNaN(Date.parse(isoTimestamp))) {
    ageEl.title = `Updated ${new Date(isoTimestamp).toLocaleString()}`;
  }

  metaRight.append(quickActions, ageEl);
  footerRow.append(metaLeft, metaRight);

  card.append(topRow, titleLink);
  if (chipsRow.childElementCount > 0) {
    card.appendChild(chipsRow);
  }
  card.appendChild(footerRow);

  card.addEventListener('click', () => {
    if (callbacks && typeof callbacks.onSelectCard === 'function') {
      callbacks.onSelectCard(pr.key, false);
    }
    if (callbacks && typeof callbacks.onOpenUrl === 'function') {
      void callbacks.onOpenUrl(pr.url);
    }
  });

  card.addEventListener('focus', () => {
    if (callbacks && typeof callbacks.onSelectCard === 'function') {
      callbacks.onSelectCard(pr.key, false);
    }
  });

  return card;
}

/**
 * Build a collapsible Ticket Group element. Multi-PR linked tickets render as a
 * horizontal swipeable Ticket Deck (with color-coded mini-map dots, off-screen attention badge,
 * prev/next buttons, and optional `⊞` vertical stack toggle); `UNLINKED` stays a vertical list.
 *
 * @param {TicketPrGroup} group
 * @param {SnoozedMap} snoozedMap
 * @param {number} now
 * @param {TicketGroupRenderOptions} [options]
 * @param {PrCardCallbacks} [callbacks]
 * @returns {{ element: HTMLDivElement, orderedPrs: EnrichedPullRequest[], trackEl: HTMLDivElement | null }}
 */
export function buildTicketGroupElement(group, snoozedMap, now, options = {}, callbacks) {
  const showProviderBadge = Boolean(options.showProviderBadge);
  const selectedPrKey = options.selectedPrKey ?? null;
  const activeFilter = options.activeFilter;
  const collapsedGroups = options.collapsedGroups;
  const expandedStackGroups = options.expandedStackGroups;
  const deckActiveSlideMap = options.deckActiveSlideMap;

  const groupEl = document.createElement('div');
  let isCollapsed = Boolean(collapsedGroups?.has(group.groupKey));
  let isExpandedStack = Boolean(expandedStackGroups?.has(group.groupKey));
  groupEl.className = 'ticket-group';
  groupEl.dataset.groupKey = group.groupKey;
  if (isCollapsed) {
    groupEl.classList.add('is-collapsed');
  }
  if (isExpandedStack) {
    groupEl.classList.add('is-expanded-stack');
  }

  const orderedPrs = sortDeckPrs(group.prs);
  const isDeck = !group.isUnlinked && orderedPrs.length > 1;

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'ticket-group-header-row';

  const headerBtn = document.createElement('button');
  headerBtn.type = 'button';
  headerBtn.className = 'ticket-group-header';
  headerBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  headerBtn.setAttribute('aria-label', `${group.label} (${orderedPrs.length} pull requests)`);

  const chevron = document.createElement('span');
  chevron.className = 'ticket-group-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '▾';
  headerBtn.appendChild(chevron);

  const safeTicketUrl = sanitizeHttpsUrl(group.ticketUrl);
  if (!safeTicketUrl) {
    const labelSpan = document.createElement('span');
    labelSpan.className = 'ticket-group-key';
    labelSpan.textContent = group.label;
    headerBtn.appendChild(labelSpan);
  }

  const countBadge = document.createElement('span');
  countBadge.className = 'ticket-group-count';
  countBadge.textContent = String(orderedPrs.length);
  countBadge.title = `${orderedPrs.length} pull request${orderedPrs.length === 1 ? '' : 's'}`;
  headerBtn.appendChild(countBadge);

  if (group.yourTurnCount > 0) {
    const turnPill = document.createElement('span');
    turnPill.className = 'ticket-group-meta-pill is-action';
    turnPill.textContent = `${group.yourTurnCount} Your Turn`;
    headerBtn.appendChild(turnPill);
  }

  const approvedPill = document.createElement('span');
  approvedPill.className = group.approvedCount > 0
    ? 'ticket-group-meta-pill is-approved'
    : 'ticket-group-meta-pill';
  approvedPill.textContent = `${group.approvedCount}/${orderedPrs.length} Approved`;
  headerBtn.appendChild(approvedPill);

  if (group.ciFailedCount > 0) {
    const ciPill = document.createElement('span');
    ciPill.className = 'ticket-group-meta-pill is-ci-failed';
    ciPill.textContent = `${group.ciFailedCount} CI Failed`;
    headerBtn.appendChild(ciPill);
  }

  if (group.providers.length > 1) {
    for (const prov of group.providers) {
      headerBtn.appendChild(buildProviderBadgeElement(prov));
    }
  }

  headerBtn.addEventListener('click', () => {
    isCollapsed = !isCollapsed;
    if (collapsedGroups) {
      if (isCollapsed) {
        collapsedGroups.add(group.groupKey);
      } else {
        collapsedGroups.delete(group.groupKey);
      }
    }
    groupEl.classList.toggle('is-collapsed', isCollapsed);
    headerBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (callbacks && typeof callbacks.onGroupCollapseToggle === 'function') {
      callbacks.onGroupCollapseToggle(group.groupKey, isCollapsed);
    }
  });

  if (safeTicketUrl) {
    const keyLink = document.createElement('a');
    keyLink.className = 'ticket-group-key-link';
    keyLink.href = safeTicketUrl;
    keyLink.target = '_blank';
    keyLink.rel = 'noopener noreferrer';
    keyLink.textContent = `${group.label} ↗`;
    keyLink.title = `Open ${group.label} in Jira`;
    keyLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (callbacks && typeof callbacks.onOpenUrl === 'function') {
        void callbacks.onOpenUrl(safeTicketUrl);
      }
    });
    headerRow.append(keyLink, headerBtn);
  } else {
    headerRow.appendChild(headerBtn);
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'ticket-group-body';

  /** @type {PrCardRenderOptions} */
  const cardOptions = {
    showProviderBadge,
    activeFilter,
    snoozedMap
  };

  if (!isDeck) {
    for (const pr of orderedPrs) {
      const card = buildPrCardElement(
        pr,
        Boolean(selectedPrKey && pr.key === selectedPrKey),
        isPrSnoozed(pr, snoozedMap, now),
        now,
        cardOptions,
        callbacks
      );
      bodyEl.appendChild(card);
    }
    groupEl.append(headerRow, bodyEl);
    return { element: groupEl, orderedPrs, trackEl: null };
  }

  // Horizontal Ticket Deck for multi-PR linked tickets
  let activeSlideIndex = deckActiveSlideMap?.get(group.groupKey) ?? 0;
  const selectedIndexInDeck = selectedPrKey
    ? orderedPrs.findIndex((p) => p.key === selectedPrKey)
    : -1;
  if (selectedIndexInDeck >= 0) {
    activeSlideIndex = selectedIndexInDeck;
  }
  activeSlideIndex = Math.max(0, Math.min(orderedPrs.length - 1, activeSlideIndex));
  deckActiveSlideMap?.set(group.groupKey, activeSlideIndex);

  const deckBar = document.createElement('div');
  deckBar.className = 'ticket-deck-bar';

  const deckLeft = document.createElement('div');
  deckLeft.className = 'ticket-deck-left';

  const counterEl = document.createElement('span');
  counterEl.className = 'ticket-deck-counter';
  deckLeft.appendChild(counterEl);

  const dotsWrap = document.createElement('div');
  dotsWrap.className = 'ticket-deck-dots';
  dotsWrap.setAttribute('role', 'tablist');
  dotsWrap.setAttribute('aria-label', `PR slides for ${group.label}`);

  /** @type {HTMLButtonElement[]} */
  const dotButtons = orderedPrs.map((pr, idx) => {
    const dotDesc = getDeckDotDescriptor(pr);
    const dotBtn = document.createElement('button');
    dotBtn.type = 'button';
    dotBtn.className = `ticket-deck-dot ${dotDesc.colorClass}`;
    dotBtn.title = dotDesc.tooltip;
    dotBtn.setAttribute('aria-label', `Slide ${idx + 1} of ${orderedPrs.length}: ${dotDesc.tooltip}`);
    dotBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      goToSlide(idx, true);
    });
    dotsWrap.appendChild(dotBtn);
    return dotBtn;
  });
  deckLeft.appendChild(dotsWrap);

  const offscreenBtn = document.createElement('button');
  offscreenBtn.type = 'button';
  offscreenBtn.className = 'deck-offscreen-badge hidden';
  deckLeft.appendChild(offscreenBtn);

  const navWrap = document.createElement('div');
  navWrap.className = 'ticket-deck-nav';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'deck-nav-btn';
  prevBtn.textContent = '‹';
  prevBtn.title = 'Previous PR in deck (h / ←)';
  prevBtn.setAttribute('aria-label', `Previous PR in ${group.label}`);

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'deck-nav-btn';
  nextBtn.textContent = '›';
  nextBtn.title = 'Next PR in deck (l / →)';
  nextBtn.setAttribute('aria-label', `Next PR in ${group.label}`);

  const expandStackBtn = document.createElement('button');
  expandStackBtn.type = 'button';
  expandStackBtn.className = 'deck-expand-btn';
  expandStackBtn.textContent = '⊞';
  expandStackBtn.setAttribute('aria-pressed', isExpandedStack ? 'true' : 'false');
  expandStackBtn.title = isExpandedStack ? 'Collapse to horizontal deck' : 'Stack all PRs vertically';
  expandStackBtn.setAttribute('aria-label', `Toggle vertical stack for ${group.label}`);

  navWrap.append(prevBtn, nextBtn, expandStackBtn);
  deckBar.append(deckLeft, navWrap);

  const trackEl = document.createElement('div');
  trackEl.className = 'ticket-deck-track';
  trackEl.dataset.groupKey = group.groupKey;

  /** @type {HTMLDivElement[]} */
  const slideElements = orderedPrs.map((pr) => {
    const slide = document.createElement('div');
    slide.className = 'ticket-deck-slide';
    slide.dataset.prKey = pr.key;
    const card = buildPrCardElement(
      pr,
      Boolean(selectedPrKey && pr.key === selectedPrKey),
      isPrSnoozed(pr, snoozedMap, now),
      now,
      cardOptions,
      callbacks
    );
    slide.appendChild(card);
    trackEl.appendChild(slide);
    return slide;
  });

  /**
   * Synchronize deck counter, mini-map dots, prev/next disabled states, and off-screen attention badge.
   *
   * @param {number} idx
   */
  function syncDeckChrome(idx) {
    const clamped = Math.max(0, Math.min(orderedPrs.length - 1, idx));
    activeSlideIndex = clamped;
    deckActiveSlideMap?.set(group.groupKey, clamped);
    if (callbacks && typeof callbacks.onDeckIndexChange === 'function') {
      callbacks.onDeckIndexChange(group.groupKey, clamped);
    }
    counterEl.textContent = `${clamped + 1} / ${orderedPrs.length}`;

    dotButtons.forEach((dot, dotIdx) => {
      const active = dotIdx === clamped;
      dot.classList.toggle('is-active', active);
      dot.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const stacked = expandedStackGroups ? expandedStackGroups.has(group.groupKey) : isExpandedStack;
    prevBtn.disabled = stacked || clamped <= 0;
    nextBtn.disabled = stacked || clamped >= orderedPrs.length - 1;
    prevBtn.classList.toggle('hidden', stacked);
    nextBtn.classList.toggle('hidden', stacked);
    dotsWrap.classList.toggle('hidden', stacked);
    counterEl.classList.toggle('hidden', stacked);

    const offscreen = stacked
      ? null
      : getOffscreenDeckAttention(orderedPrs, clamped, snoozedMap, Date.now());
    if (offscreen) {
      offscreenBtn.textContent = offscreen.label;
      offscreenBtn.title = 'Jump to off-screen PR needing action';
      offscreenBtn.dataset.targetIndex = String(offscreen.targetIndex);
      offscreenBtn.classList.remove('hidden');
    } else {
      offscreenBtn.classList.add('hidden');
    }
  }

  /**
   * Scroll deck smoothly to `targetIndex` and optionally select the PR card.
   *
   * @param {number} targetIndex
   * @param {boolean} [selectTarget]
   * @param {'auto' | 'smooth'} [behavior]
   */
  function goToSlide(targetIndex, selectTarget = false, behavior = 'smooth') {
    const clamped = Math.max(0, Math.min(orderedPrs.length - 1, targetIndex));
    syncDeckChrome(clamped);
    scrollDeckToIndex(trackEl, slideElements, clamped, behavior);
    if (selectTarget) {
      const targetPr = orderedPrs[clamped];
      if (targetPr && callbacks && typeof callbacks.onSelectCard === 'function') {
        callbacks.onSelectCard(targetPr.key, false);
      }
    }
  }

  offscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetIdx = Number.parseInt(offscreenBtn.dataset.targetIndex || '0', 10);
    if (Number.isFinite(targetIdx)) {
      goToSlide(targetIdx, true);
    }
  });

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    goToSlide(activeSlideIndex - 1, true);
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    goToSlide(activeSlideIndex + 1, true);
  });

  expandStackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isExpandedStack = !(expandedStackGroups ? expandedStackGroups.has(group.groupKey) : isExpandedStack);
    if (expandedStackGroups) {
      if (isExpandedStack) {
        expandedStackGroups.add(group.groupKey);
      } else {
        expandedStackGroups.delete(group.groupKey);
      }
    }
    groupEl.classList.toggle('is-expanded-stack', isExpandedStack);
    expandStackBtn.setAttribute('aria-pressed', isExpandedStack ? 'true' : 'false');
    expandStackBtn.title = isExpandedStack ? 'Collapse to horizontal deck' : 'Stack all PRs vertically';
    if (callbacks && typeof callbacks.onDeckExpandToggle === 'function') {
      callbacks.onDeckExpandToggle(group.groupKey, isExpandedStack);
    }
    syncDeckChrome(activeSlideIndex);
    if (!isExpandedStack) {
      goToSlide(activeSlideIndex, false, 'auto');
    }
  });

  let scrollSyncTimer = /** @type {number | null} */ (null);
  trackEl.addEventListener('scroll', () => {
    const stacked = expandedStackGroups ? expandedStackGroups.has(group.groupKey) : isExpandedStack;
    if (stacked) {
      return;
    }
    if (scrollSyncTimer !== null) {
      window.clearTimeout(scrollSyncTimer);
    }
    scrollSyncTimer = window.setTimeout(() => {
      scrollSyncTimer = null;
      const width = trackEl.clientWidth;
      if (width <= 0) {
        return;
      }
      const inferredIdx = Math.round(trackEl.scrollLeft / (width + 6));
      if (inferredIdx !== activeSlideIndex && inferredIdx >= 0 && inferredIdx < orderedPrs.length) {
        syncDeckChrome(inferredIdx);
      }
    }, 60);
  }, { passive: true });

  syncDeckChrome(activeSlideIndex);
  if (!isExpandedStack && activeSlideIndex > 0) {
    window.requestAnimationFrame(() => goToSlide(activeSlideIndex, false, 'auto'));
  }

  bodyEl.append(deckBar, trackEl);
  groupEl.append(headerRow, bodyEl);
  return { element: groupEl, orderedPrs, trackEl };
}
