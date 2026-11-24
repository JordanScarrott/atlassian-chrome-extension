import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewerBreakdown,
  buildReviewerBreakdownTooltip,
  countQuickWinsPrs,
  filterPrsByRelatedTicket,
  formatFooterUpdated,
  formatRelativeAge,
  formatRemainingSnooze,
  getAiTriageBadges,
  getCiBadgeDescriptor,
  getCrossFilterEmptyHint,
  getDeckDotDescriptor,
  getHeaderConnectionDescriptor,
  getOffscreenDeckAttention,
  sortDeckPrs
} from '../bitbucket-pr-extension/src/popup-helpers.js';
import { enrichPullRequest } from '../bitbucket-pr-extension/src/pr-triage.js';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const ME = '{me-uuid}';

/**
 * Create an enriched PR fixture for popup-helper tests.
 * @param {Record<string, any>} [overrides]
 */
function makeEnrichedPr(overrides = {}) {
  return enrichPullRequest(
    {
      key: 'acme/repo#1',
      id: 1,
      title: 'MEZ-10 Add CI badge',
      state: 'OPEN',
      url: 'https://bitbucket.org/acme/repo/pull-requests/1',
      repoFullName: 'acme/repo',
      repoName: 'repo',
      workspace: 'acme',
      authorUuid: '{author-uuid}',
      authorName: 'Alice',
      sourceBranch: 'feat/MEZ-10-ci',
      destinationBranch: 'main',
      createdOn: new Date(NOW - 5 * 3600 * 1000).toISOString(),
      updatedOn: new Date(NOW - 30 * 60 * 1000).toISOString(),
      commentCount: 0,
      taskCount: 0,
      draft: false,
      reviewers: [],
      participants: [],
      ...overrides
    },
    ME,
    { now: NOW }
  );
}

test('formatRelativeAge formats just now, minutes, hours, days, >= 14d short date, and rejects invalid inputs', () => {
  const iso = (deltaMs) => new Date(NOW - deltaMs).toISOString();

  // < 1m and future timestamps clamp to 'just now'
  assert.equal(formatRelativeAge(iso(0), NOW), 'just now');
  assert.equal(formatRelativeAge(iso(59_999), NOW), 'just now');
  assert.equal(formatRelativeAge(iso(-120_000), NOW), 'just now');

  // Minutes (1m .. 59m)
  assert.equal(formatRelativeAge(iso(60_000), NOW), '1m');
  assert.equal(formatRelativeAge(iso(59 * 60_000), NOW), '59m');

  // Hours (1h .. 23h)
  assert.equal(formatRelativeAge(iso(60 * 60_000), NOW), '1h');
  assert.equal(formatRelativeAge(iso(23 * 3600_000), NOW), '23h');

  // Days (1d .. 13d)
  assert.equal(formatRelativeAge(iso(24 * 3600_000), NOW), '1d');
  assert.equal(formatRelativeAge(iso(13 * 86_400_000), NOW), '13d');

  // >= 14d formats as localized short month/day string (matching Date.toLocaleDateString)
  const fourteenDaysAgoMs = NOW - 14 * 86_400_000;
  const expectedShortDate = new Date(fourteenDaysAgoMs).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  });
  assert.equal(formatRelativeAge(new Date(fourteenDaysAgoMs).toISOString(), NOW), expectedShortDate);

  // Invalid / missing timestamps
  assert.equal(formatRelativeAge('', NOW), '');
  assert.equal(formatRelativeAge('   ', NOW), '');
  assert.equal(formatRelativeAge('not-a-timestamp', NOW), '');
  assert.equal(formatRelativeAge(null, NOW), '');
  assert.equal(formatRelativeAge(undefined, NOW), '');
});

test('formatFooterUpdated formats Never updated, just now, Nm ago, Nh ago, and Nd ago across boundaries', () => {
  // Missing / non-positive / non-finite values
  assert.equal(formatFooterUpdated(null, NOW), 'Never updated');
  assert.equal(formatFooterUpdated(undefined, NOW), 'Never updated');
  assert.equal(formatFooterUpdated(0, NOW), 'Never updated');
  assert.equal(formatFooterUpdated(-100, NOW), 'Never updated');
  assert.equal(formatFooterUpdated(Number.NaN, NOW), 'Never updated');
  assert.equal(formatFooterUpdated(Number.POSITIVE_INFINITY, NOW), 'Never updated');

  // Relative windows
  assert.equal(formatFooterUpdated(NOW, NOW), 'Updated just now');
  assert.equal(formatFooterUpdated(NOW - 45_000, NOW), 'Updated just now');
  assert.equal(formatFooterUpdated(NOW + 60_000, NOW), 'Updated just now');
  assert.equal(formatFooterUpdated(NOW - 60_000, NOW), 'Updated 1m ago');
  assert.equal(formatFooterUpdated(NOW - 59 * 60_000, NOW), 'Updated 59m ago');
  assert.equal(formatFooterUpdated(NOW - 60 * 60_000, NOW), 'Updated 1h ago');
  assert.equal(formatFooterUpdated(NOW - 23 * 3600_000, NOW), 'Updated 23h ago');
  assert.equal(formatFooterUpdated(NOW - 24 * 3600_000, NOW), 'Updated 1d ago');
  assert.equal(formatFooterUpdated(NOW - 30 * 86_400_000, NOW), 'Updated 30d ago');
});

test('formatRemainingSnooze handles <1m, minutes, hours, hours+minutes, exact boundaries, and expired/malformed inputs', () => {
  // Expired or invalid returns empty string
  assert.equal(formatRemainingSnooze(NOW, NOW), '');
  assert.equal(formatRemainingSnooze(NOW - 10_000, NOW), '');
  assert.equal(formatRemainingSnooze(null, NOW), '');
  assert.equal(formatRemainingSnooze(undefined, NOW), '');
  assert.equal(formatRemainingSnooze(Number.NaN, NOW), '');

  // <1m boundary (1ms .. 59_999ms)
  assert.equal(formatRemainingSnooze(NOW + 1, NOW), '<1m left');
  assert.equal(formatRemainingSnooze(NOW + 59_999, NOW), '<1m left');

  // Exact 1 minute (60_000ms) -> 1m left; 2m .. 59m -> Nm left
  assert.equal(formatRemainingSnooze(NOW + 60_000, NOW), '1m left');
  assert.equal(formatRemainingSnooze(NOW + 60_001, NOW), '2m left');
  assert.equal(formatRemainingSnooze(NOW + 59 * 60_000, NOW), '59m left');

  // Exact hours vs hours + minutes
  assert.equal(formatRemainingSnooze(NOW + 60 * 60_000, NOW), '1h left');
  assert.equal(formatRemainingSnooze(NOW + 4 * 60 * 60_000, NOW), '4h left');
  assert.equal(formatRemainingSnooze(NOW + (3 * 60 + 40) * 60_000, NOW), '3h 40m left');
  assert.equal(formatRemainingSnooze(NOW + (2 * 60 + 1) * 60_000, NOW), '2h 1m left');
});

test('buildReviewerBreakdownTooltip summarizes Approved, Changes requested, Pending, excludes author, and handles edge cases', () => {
  const pr = makeEnrichedPr({
    authorUuid: '{author}',
    reviewers: [
      { uuid: '{author}', displayName: 'Author Self' },
      { uuid: '{rev-1}', displayName: 'Alice' },
      { uuid: '{rev-2}', displayName: 'Bob' },
      { uuid: '{rev-3}', displayName: 'Charlie' }
    ],
    participants: [
      { uuid: '{author}', displayName: 'Author Self', role: 'AUTHOR', approved: true, state: 'approved' },
      { uuid: '{rev-1}', displayName: 'Alice', role: 'REVIEWER', approved: true, state: 'approved' },
      { uuid: '{rev-2}', displayName: 'Bob', role: 'REVIEWER', approved: false, state: 'changes_requested' },
      // Non-reviewer commenter should not appear unless they reviewed/approved
      { uuid: '{commenter}', displayName: 'Eve', role: 'PARTICIPANT', approved: false, state: null },
      // Unlisted participant who voted should still appear
      { uuid: '{rev-4}', displayName: 'Dana', role: 'PARTICIPANT', approved: true, state: 'approved' }
    ]
  });

  const breakdown = buildReviewerBreakdown(pr);
  assert.deepEqual(breakdown.approvedNames, ['Alice', 'Dana']);
  assert.deepEqual(breakdown.changesRequestedNames, ['Bob']);
  assert.deepEqual(breakdown.pendingNames, ['Charlie']);
  assert.equal(
    breakdown.approvalTooltip,
    'Approved: Alice, Dana\nChanges requested: Bob\nPending: Charlie'
  );
  assert.equal(buildReviewerBreakdownTooltip(pr), breakdown.approvalTooltip);

  // Fallback when counts exist without named reviewer arrays
  assert.equal(
    buildReviewerBreakdownTooltip({ approvalsCount: 2, totalReviewers: 2, reviewers: [], participants: [] }),
    '2 approval(s)'
  );

  // Missing names fall back to 'Reviewer', empty/null PR returns ''
  assert.equal(
    buildReviewerBreakdownTooltip({
      authorUuid: '{a}',
      reviewers: [{ uuid: '{r1}', displayName: '' }],
      participants: []
    }),
    'Pending: Reviewer'
  );
  assert.equal(buildReviewerBreakdownTooltip(null), '');
  assert.equal(buildReviewerBreakdownTooltip(undefined), '');
  assert.equal(buildReviewerBreakdownTooltip({}), '');
});

test('getCiBadgeDescriptor handles SUCCESSFUL, FAILED, INPROGRESS, STOPPED, URL sanitization, and invalid inputs', () => {
  // Single passing build
  assert.deepEqual(
    getCiBadgeDescriptor({
      state: 'SUCCESSFUL',
      totalCount: 1,
      passedCount: 1,
      url: 'https://ci.example.com/builds/10',
      name: 'Unit Tests'
    }),
    {
      stateClass: 'ci-successful',
      label: '✓ CI',
      tooltip: 'Build: Unit Tests (1/1 passed)',
      safeUrl: 'https://ci.example.com/builds/10'
    }
  );

  // Multi-check failing build with unsafe URL rejected
  assert.deepEqual(
    getCiBadgeDescriptor({
      state: 'FAILED',
      totalCount: 4,
      passedCount: 3,
      url: 'javascript:alert(1)',
      name: 'E2E Suite'
    }),
    {
      stateClass: 'ci-failed',
      label: '✕ 3/4',
      tooltip: 'Build: E2E Suite (3/4 passed)',
      safeUrl: null
    }
  );

  // Multi-check passing build shows ✓ passed/total
  assert.deepEqual(
    getCiBadgeDescriptor({
      state: 'SUCCESSFUL',
      totalCount: 3,
      passedCount: 3,
      url: 'http://insecure.example.com/1',
      name: ''
    }),
    {
      stateClass: 'ci-successful',
      label: '✓ 3/3',
      tooltip: 'Build: Checks (3/3 passed)',
      safeUrl: null
    }
  );

  // INPROGRESS & STOPPED
  assert.deepEqual(
    getCiBadgeDescriptor({
      state: 'INPROGRESS',
      totalCount: 2,
      passedCount: 1,
      url: 'https://ci.example.com/2',
      name: 'Docker Build'
    }),
    {
      stateClass: 'ci-inprogress',
      label: '⟳ CI',
      tooltip: 'Build: Docker Build (1/2 passed)',
      safeUrl: 'https://ci.example.com/2'
    }
  );

  assert.deepEqual(
    getCiBadgeDescriptor({
      state: 'STOPPED',
      totalCount: 0,
      passedCount: 0,
      url: null,
      name: 'Deploy'
    }),
    {
      stateClass: 'ci-stopped',
      label: '■ CI',
      tooltip: 'Build: Deploy',
      safeUrl: null
    }
  );

  // Clamps passedCount > totalCount and rejects invalid states / nullish objects
  assert.equal(
    getCiBadgeDescriptor({ state: 'SUCCESSFUL', totalCount: 2, passedCount: 5, name: 'Test' })?.label,
    '✓ 2/2'
  );
  assert.equal(getCiBadgeDescriptor(null), null);
  assert.equal(getCiBadgeDescriptor(undefined), null);
  assert.equal(getCiBadgeDescriptor({}), null);
  // @ts-expect-error testing runtime handling of unknown build state
  assert.equal(getCiBadgeDescriptor({ state: 'UNKNOWN' }), null);
});

test('getCrossFilterEmptyHint detects cross-filter search hits while respecting activeFilter, snoozes, and misses', () => {
  const waitingAuthoredPr = makeEnrichedPr({
    key: 'acme/api#10',
    id: 10,
    title: 'MEZ-501 Refactor billing',
    authorUuid: ME,
    reviewers: [{ uuid: '{rev}', displayName: 'Bob' }],
    participants: []
  });

  const approvedReviewerPr = makeEnrichedPr({
    key: 'acme/web#11',
    id: 11,
    title: 'MEZ-502 Billing dashboard',
    authorUuid: '{other}',
    reviewers: [{ uuid: ME, displayName: 'Me' }],
    participants: [{ uuid: ME, displayName: 'Me', role: 'REVIEWER', approved: true, state: 'approved' }]
  });

  const snoozedPr = makeEnrichedPr({
    key: 'acme/web#12',
    id: 12,
    title: 'Snoozed billing cleanup',
    authorUuid: '{other}',
    reviewers: [{ uuid: ME, displayName: 'Me' }],
    participants: [],
    updatedOn: '2026-11-23T10:00:00Z'
  });

  const allPrs = [waitingAuthoredPr, approvedReviewerPr, snoozedPr];
  const snoozedMap = {
    'acme/web#12': { until: NOW + 3600_000, prUpdatedOn: '2026-11-23T10:00:00Z' }
  };

  // Search 'billing' under 'action_required' misses, but finds 2 matches in 'all' (excluding snoozed)
  assert.deepEqual(
    getCrossFilterEmptyHint({
      activeFilter: 'action_required',
      searchQuery: 'billing',
      allPrs,
      snoozedMap,
      now: NOW
    }),
    {
      matchCount: 2,
      label: 'No matches in Needs Action — 2 matches in All PRs.'
    }
  );

  // Singular match phrasing under 'reviewing' -> 1 match in authored PR #10
  assert.deepEqual(
    getCrossFilterEmptyHint({
      activeFilter: 'reviewing',
      searchQuery: 'MEZ-501',
      allPrs,
      snoozedMap,
      now: NOW
    }),
    {
      matchCount: 1,
      label: 'No matches in Reviewing — 1 match in All PRs.'
    }
  );

  // Works for 'snoozed' filter when PR is active in All PRs, and ignores snoozed-only matches when checking All PRs
  assert.deepEqual(
    getCrossFilterEmptyHint({
      activeFilter: 'snoozed',
      searchQuery: 'MEZ-502',
      allPrs,
      snoozedMap,
      now: NOW
    }),
    {
      matchCount: 1,
      label: 'No matches in Snoozed — 1 match in All PRs.'
    }
  );
  assert.equal(
    getCrossFilterEmptyHint({
      activeFilter: 'action_required',
      searchQuery: 'cleanup',
      allPrs,
      snoozedMap,
      now: NOW
    }),
    null
  );

  // Returns null when already in 'all', query is empty, active filter already matches, or nothing matches anywhere
  assert.equal(
    getCrossFilterEmptyHint({ activeFilter: 'all', searchQuery: 'billing', allPrs, snoozedMap, now: NOW }),
    null
  );
  assert.equal(
    getCrossFilterEmptyHint({ activeFilter: 'action_required', searchQuery: '   ', allPrs, snoozedMap, now: NOW }),
    null
  );
  assert.equal(
    getCrossFilterEmptyHint({ activeFilter: 'authored', searchQuery: 'MEZ-501', allPrs, snoozedMap, now: NOW }),
    null
  );
  assert.equal(
    getCrossFilterEmptyHint({ activeFilter: 'action_required', searchQuery: 'nonexistent', allPrs, snoozedMap, now: NOW }),
    null
  );
  assert.equal(getCrossFilterEmptyHint(null), null);
  assert.equal(
    getCrossFilterEmptyHint({ activeFilter: 'invalid_filter', searchQuery: 'billing', allPrs, snoozedMap, now: NOW }),
    null
  );
});

test('getHeaderConnectionDescriptor handles none, single BB, single GH, dual BB+GH, error, and rate-limit states', () => {
  const none = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: false,
    github: { isAuthenticated: false, apiBaseUrl: 'https://api.github.com', user: null }
  });
  assert.equal(none.variant, 'neutral');
  assert.equal(none.text, 'Not connected');

  const bbOnly = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: true,
    bitbucketUser: { uuid: '{me}', displayName: 'Jordan S', username: 'jscarrott', avatarUrl: null, cachedAt: NOW },
    workspaces: [{ slug: 'acme', name: 'Acme' }],
    github: { isAuthenticated: false, apiBaseUrl: 'https://api.github.com', user: null }
  });
  assert.equal(bbOnly.variant, 'connected');
  assert.equal(bbOnly.text, 'Jordan S');
  assert.match(bbOnly.title, /Bitbucket: Jordan S \(acme\)/);

  const ghOnly = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: false,
    github: {
      isAuthenticated: true,
      apiBaseUrl: 'https://github.corp.example.com/api/v3',
      user: { uuid: 'gh:1', displayName: 'Jordan GH', username: 'jscarrott', avatarUrl: null, cachedAt: NOW }
    }
  });
  assert.equal(ghOnly.variant, 'connected');
  assert.equal(ghOnly.text, 'GitHub (@jscarrott)');
  assert.match(ghOnly.title, /https:\/\/github\.corp\.example\.com\/api\/v3/);

  const dual = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: true,
    bitbucketUser: { uuid: '{me}', displayName: 'Jordan S', username: 'jscarrott', avatarUrl: null, cachedAt: NOW },
    syncedWorkspaces: ['acme'],
    github: {
      isAuthenticated: true,
      apiBaseUrl: 'https://api.github.com',
      user: { uuid: 'gh:1', displayName: 'Jordan GH', username: 'jscarrott', avatarUrl: null, cachedAt: NOW }
    }
  });
  assert.equal(dual.variant, 'connected');
  assert.equal(dual.text, 'Bitbucket + GitHub');
  assert.match(dual.title, /Bitbucket: Jordan S \(acme\)/);
  assert.match(dual.title, /GitHub: Jordan GH \(@jscarrott\)/);

  const errored = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: true,
    bitbucketUsername: 'jordan@acme.com',
    error: 'GitHub: 401',
    github: { isAuthenticated: true, apiBaseUrl: 'https://api.github.com', user: null }
  });
  assert.equal(errored.variant, 'error');
  assert.equal(errored.text, 'Sync issue');
  assert.match(errored.title, /GitHub: 401/);

  const limited = getHeaderConnectionDescriptor({
    bitbucketAuthenticated: false,
    github: { isAuthenticated: true, apiBaseUrl: 'https://api.github.com', user: null },
    rateLimitWarning: true,
    now: NOW
  });
  assert.equal(limited.variant, 'warning');
  assert.equal(limited.text, 'Rate limited');
});

test('filterPrsByRelatedTicket, sortDeckPrs, getDeckDotDescriptor, and getOffscreenDeckAttention work across BB+GH', () => {
  const waitingPr = makeEnrichedPr({
    provider: 'bitbucket',
    key: 'acme/api#1',
    id: 1,
    title: 'MEZ-700 API schema',
    authorUuid: ME,
    reviewers: [{ uuid: '{rev}', displayName: 'Rev' }],
    participants: []
  });

  const needsReviewPr = makeEnrichedPr({
    provider: 'github',
    key: 'gh:acme/web#2',
    id: 2,
    title: 'MEZ-700 Web UI',
    authorUuid: 'gh:other',
    reviewers: [{ uuid: ME, displayName: 'Me' }],
    participants: []
  });

  const ciFailedAuthoredPr = makeEnrichedPr({
    provider: 'github',
    key: 'gh:acme/worker#3',
    id: 3,
    title: 'MEZ-700 Worker job (#44)',
    authorUuid: ME,
    buildStatus: {
      state: 'FAILED',
      totalCount: 1,
      passedCount: 0,
      failedCount: 1,
      inProgressCount: 0,
      stoppedCount: 0,
      url: 'https://ci.example.com/3',
      name: 'CI',
      updatedOn: '2026-11-23T11:50:00Z',
      commitHash: 'abc',
      cachedAt: NOW
    }
  });

  const unrelatedPr = makeEnrichedPr({
    key: 'acme/docs#9',
    id: 9,
    title: 'MEZ-999 Unrelated docs'
  });

  const scoped = filterPrsByRelatedTicket([waitingPr, unrelatedPr, needsReviewPr, ciFailedAuthoredPr], 'MEZ-700');
  assert.deepEqual(scoped.map((p) => p.key), ['gh:acme/worker#3', 'gh:acme/web#2', 'acme/api#1']);
  assert.deepEqual(
    filterPrsByRelatedTicket([waitingPr, ciFailedAuthoredPr], '#44').map((p) => p.key),
    ['gh:acme/worker#3']
  );

  const deck = sortDeckPrs([waitingPr, needsReviewPr, ciFailedAuthoredPr]);
  assert.deepEqual(deck.map((p) => p.key), ['gh:acme/worker#3', 'gh:acme/web#2', 'acme/api#1']);

  assert.equal(getDeckDotDescriptor(ciFailedAuthoredPr).colorClass, 'dot-red');
  assert.match(getDeckDotDescriptor(ciFailedAuthoredPr).tooltip, /CI Failed/);
  assert.equal(getDeckDotDescriptor(needsReviewPr).colorClass, 'dot-blue');
  assert.equal(getDeckDotDescriptor(waitingPr).colorClass, 'dot-gray');

  const readyPr = makeEnrichedPr({
    key: 'acme/ready#4',
    id: 4,
    authorUuid: ME,
    participants: [{ uuid: '{r1}', displayName: 'R1', role: 'REVIEWER', approved: true, state: 'approved' }]
  });
  assert.equal(getDeckDotDescriptor(readyPr).colorClass, 'dot-green');

  // On slide 0 (ciFailedAuthoredPr): slide 1 (needsReviewPr) is off-screen right -> '+1 needs action →'
  const off0 = getOffscreenDeckAttention(deck, 0, {}, NOW);
  assert.equal(off0?.rightCount, 1);
  assert.equal(off0?.leftCount, 0);
  assert.equal(off0?.targetIndex, 1);
  assert.equal(off0?.label, '+1 needs action →');

  // On slide 2 (waitingPr): slides 0 and 1 are off-screen left -> '← +2 needs action'
  const off2 = getOffscreenDeckAttention(deck, 2, {}, NOW);
  assert.equal(off2?.leftCount, 2);
  assert.equal(off2?.targetIndex, 0);
  assert.equal(off2?.label, '← +2 needs action');

  // If slide 1 is snoozed, sliding onto slide 0 leaves 0 off-screen actionable PRs
  const snoozed = {
    [needsReviewPr.key]: { until: NOW + 60_000, prUpdatedOn: needsReviewPr.updatedOn }
  };
  assert.equal(getOffscreenDeckAttention(deck, 0, snoozed, NOW), null);
});

test('getAiTriageBadges enforces strict confidence >= 0.75 gating, capped effort+alert labels, and rich diffstat tooltips', () => {
  // Null / disabled / missing triage returns nulls cleanly
  assert.deepEqual(getAiTriageBadges(null), { effortBadge: null, alertBadge: null });
  assert.deepEqual(getAiTriageBadges(undefined), { effortBadge: null, alertBadge: null });
  assert.deepEqual(getAiTriageBadges({}), { effortBadge: null, alertBadge: null });

  const diffstat = {
    commitHash: 'abc123',
    filesChanged: 12,
    linesAdded: 140,
    linesRemoved: 32,
    files: [],
    cachedAt: NOW
  };

  // Effort: quick + no alert + diffstat tooltip
  const quickRes = getAiTriageBadges(
    {
      provider: 'jev',
      model: 'clef-flash',
      effort: 'quick',
      effortConfidence: 0.88,
      alert: null,
      alertConfidence: 0.2,
      changeKind: 'tests_docs',
      riskScore: 1,
      hasClearContext: true
    },
    diffstat
  );
  assert.equal(quickRes.effortBadge?.label, '⚡ ~2m');
  assert.equal(quickRes.effortBadge?.cssClass, 'ai-effort-quick');
  assert.match(quickRes.effortBadge?.tooltip ?? '', /Quick review \(~2m\)/);
  assert.match(quickRes.effortBadge?.tooltip ?? '', /Kind: Tests & Docs/);
  assert.match(quickRes.effortBadge?.tooltip ?? '', /Risk: 1\/5/);
  assert.match(quickRes.effortBadge?.tooltip ?? '', /12 files · \+140\/-32/);
  assert.match(quickRes.effortBadge?.tooltip ?? '', /clef-flash \(88% confidence\)/);
  assert.equal(quickRes.alertBadge, null);

  // Effort: medium + hotfix alert at exact 0.75 threshold
  const mediumHotfixRes = getAiTriageBadges(
    {
      provider: 'gemini',
      model: 'gemini-decision-1',
      effort: 'medium',
      effortConfidence: 0.75,
      alert: 'hotfix',
      alertConfidence: 0.75,
      changeKind: 'hotfix',
      riskScore: 3.4,
      hasClearContext: true
    },
    null
  );
  assert.equal(mediumHotfixRes.effortBadge?.label, '⏱ ~15m');
  assert.equal(mediumHotfixRes.effortBadge?.cssClass, 'ai-effort-medium');
  assert.match(mediumHotfixRes.effortBadge?.tooltip ?? '', /gemini-decision-1 \(75% confidence\)/);
  assert.equal(mediumHotfixRes.effortBadge?.tooltip.includes('files ·'), false);

  assert.equal(mediumHotfixRes.alertBadge?.label, '🔥 Hotfix');
  assert.equal(mediumHotfixRes.alertBadge?.cssClass, 'ai-alert-hotfix');
  assert.match(mediumHotfixRes.alertBadge?.tooltip ?? '', /Risk: 3\.4\/5/);
  assert.match(mediumHotfixRes.alertBadge?.tooltip ?? '', /gemini-decision-1 \(75% confidence\)/);

  // Effort: deep + high_risk alert
  const deepHighRiskRes = getAiTriageBadges(
    {
      provider: 'jev',
      model: 'clef-flash',
      effort: 'deep',
      effortConfidence: 0.94,
      alert: 'high_risk',
      alertConfidence: 0.81,
      changeKind: 'refactor',
      riskScore: 4.6,
      hasClearContext: false
    },
    {
      commitHash: 'def',
      filesChanged: 1,
      linesAdded: 5,
      linesRemoved: 1,
      files: [],
      cachedAt: NOW
    }
  );
  assert.equal(deepHighRiskRes.effortBadge?.label, '🧠 Deep');
  assert.equal(deepHighRiskRes.effortBadge?.cssClass, 'ai-effort-deep');
  assert.match(deepHighRiskRes.effortBadge?.tooltip ?? '', /1 file · \+5\/-1/);
  assert.equal(deepHighRiskRes.alertBadge?.label, '⚠ High Risk');
  assert.equal(deepHighRiskRes.alertBadge?.cssClass, 'ai-alert-high_risk');
  assert.match(deepHighRiskRes.alertBadge?.tooltip ?? '', /81% confidence/);

  // Strict < 0.75 gating suppresses badges independently
  const gatedBoth = getAiTriageBadges({
    provider: 'jev',
    model: 'clef-flash',
    effort: 'quick',
    effortConfidence: 0.749,
    alert: 'hotfix',
    alertConfidence: 0.74,
    changeKind: 'bugfix',
    riskScore: 2
  });
  assert.equal(gatedBoth.effortBadge, null);
  assert.equal(gatedBoth.alertBadge, null);

  const gatedEffortOnly = getAiTriageBadges({
    provider: 'jev',
    model: 'clef-flash',
    effort: 'quick',
    effortConfidence: 0.7,
    alert: 'high_risk',
    alertConfidence: 0.9,
    riskScore: 4
  });
  assert.equal(gatedEffortOnly.effortBadge, null);
  assert.equal(gatedEffortOnly.alertBadge?.label, '⚠ High Risk');

  // Unknown effort/alert values are safely ignored
  const unknownValues = getAiTriageBadges({
    // @ts-expect-error testing runtime resilience for unknown effort
    effort: 'unknown',
    effortConfidence: 0.99,
    // @ts-expect-error testing runtime resilience for unknown alert
    alert: 'unknown',
    alertConfidence: 0.99
  });
  assert.equal(unknownValues.effortBadge, null);
  assert.equal(unknownValues.alertBadge, null);
});

test('countQuickWinsPrs counts non-snoozed open PRs with quick effort and confidence >= 0.75', () => {
  const quickValid = makeEnrichedPr({
    key: 'acme/repo#201',
    id: 201,
    updatedOn: '2026-11-23T11:00:00Z',
    aiTriage: {
      commitHash: 'a',
      questionSetVersion: 'effort-risk-v1',
      provider: 'jev',
      model: 'clef-flash',
      effort: 'quick',
      effortConfidence: 0.85,
      alert: null,
      alertConfidence: 0.1,
      changeKind: 'tests_docs',
      riskScore: 1,
      hasClearContext: true,
      cachedAt: NOW
    }
  });
  const quickLowConf = makeEnrichedPr({
    key: 'acme/repo#202',
    id: 202,
    aiTriage: {
      commitHash: 'b',
      questionSetVersion: 'effort-risk-v1',
      provider: 'jev',
      model: 'clef-flash',
      effort: 'quick',
      effortConfidence: 0.74,
      alert: null,
      alertConfidence: 0.1,
      changeKind: 'bugfix',
      riskScore: 2,
      hasClearContext: true,
      cachedAt: NOW
    }
  });
  const quickSnoozed = makeEnrichedPr({
    key: 'acme/repo#203',
    id: 203,
    updatedOn: '2026-11-23T11:00:00Z',
    aiTriage: {
      commitHash: 'c',
      questionSetVersion: 'effort-risk-v1',
      provider: 'jev',
      model: 'clef-flash',
      effort: 'quick',
      effortConfidence: 0.92,
      alert: null,
      alertConfidence: 0.1,
      changeKind: 'config_deps',
      riskScore: 1,
      hasClearContext: true,
      cachedAt: NOW
    }
  });
  const deepPr = makeEnrichedPr({
    key: 'acme/repo#204',
    id: 204,
    aiTriage: {
      commitHash: 'd',
      questionSetVersion: 'effort-risk-v1',
      provider: 'jev',
      model: 'clef-flash',
      effort: 'deep',
      effortConfidence: 0.95,
      alert: 'high_risk',
      alertConfidence: 0.9,
      changeKind: 'refactor',
      riskScore: 5,
      hasClearContext: false,
      cachedAt: NOW
    }
  });

  const snoozedMap = {
    'acme/repo#203': { until: NOW + 60_000, prUpdatedOn: '2026-11-23T11:00:00Z' }
  };

  assert.equal(countQuickWinsPrs([quickValid, quickLowConf, quickSnoozed, deepPr], snoozedMap, NOW), 1);
  assert.equal(countQuickWinsPrs([quickLowConf, deepPr], {}, NOW), 0);
  assert.equal(countQuickWinsPrs([], {}, NOW), 0);
});

