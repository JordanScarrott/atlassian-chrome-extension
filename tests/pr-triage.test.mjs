import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJiraTicketLinks,
  collectActiveJiraTickets,
  computeCounts,
  enrichPullRequest,
  extractJiraKeys,
  filterAndSortPrs,
  isPrSnoozed,
  pruneExpiredSnoozes
} from '../bitbucket-pr-extension/src/pr-triage.js';

const ME = '{me-uuid}';
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

function makePr(overrides = {}) {
  return {
    key: 'acme/repo#1',
    id: 1,
    title: 'Default PR',
    state: 'OPEN',
    url: 'https://bitbucket.org/acme/repo/pull-requests/1',
    repoFullName: 'acme/repo',
    repoName: 'repo',
    workspace: 'acme',
    authorUuid: '{other-uuid}',
    authorName: 'Alice',
    sourceBranch: 'main-fix',
    destinationBranch: 'main',
    createdOn: new Date(NOW - 10 * 3600 * 1000).toISOString(),
    updatedOn: new Date(NOW - 2 * 3600 * 1000).toISOString(),
    commentCount: 0,
    taskCount: 0,
    draft: false,
    reviewers: [],
    participants: [],
    ...overrides
  };
}

test('enrichPullRequest classifies all reviewer and author Your Turn states accurately', () => {
  // 1. Reviewer pending -> needs_review (isYourTurn: true, score: 100)
  const needsReview = enrichPullRequest(
    makePr({
      key: 'acme/repo#1',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      participants: []
    }),
    ME,
    { now: NOW }
  );
  assert.equal(needsReview.role, 'reviewer');
  assert.equal(needsReview.myParticipantState, 'pending');
  assert.equal(needsReview.actionState, 'needs_review');
  assert.equal(needsReview.isYourTurn, true);
  assert.equal(needsReview.priorityScore, 100);

  // 2. Reviewer changes requested -> changes_requested_by_you (isYourTurn: false, score: 40)
  const crByYou = enrichPullRequest(
    makePr({
      key: 'acme/repo#2',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      participants: [
        { uuid: ME, displayName: 'Me', role: 'REVIEWER', approved: false, state: 'changes_requested' }
      ]
    }),
    ME,
    { now: NOW }
  );
  assert.equal(crByYou.actionState, 'changes_requested_by_you');
  assert.equal(crByYou.isYourTurn, false);
  assert.equal(crByYou.priorityScore, 40);

  // 3. Reviewer approved -> approved_by_you (isYourTurn: false, score: 20)
  const approvedByYou = enrichPullRequest(
    makePr({
      key: 'acme/repo#3',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      participants: [
        { uuid: ME, displayName: 'Me', role: 'REVIEWER', approved: true, state: 'approved' }
      ]
    }),
    ME,
    { now: NOW }
  );
  assert.equal(approvedByYou.actionState, 'approved_by_you');
  assert.equal(approvedByYou.isYourTurn, false);
  assert.equal(approvedByYou.priorityScore, 20);

  // 4. Author with changes requested -> changes_requested (isYourTurn: true, score: 110)
  const authorChanges = enrichPullRequest(
    makePr({
      key: 'acme/repo#4',
      authorUuid: ME,
      participants: [
        { uuid: '{rev-1}', displayName: 'Rev1', role: 'REVIEWER', approved: false, state: 'changes_requested' }
      ]
    }),
    ME,
    { now: NOW }
  );
  assert.equal(authorChanges.role, 'author');
  assert.equal(authorChanges.actionState, 'changes_requested');
  assert.equal(authorChanges.isYourTurn, true);
  assert.equal(authorChanges.priorityScore, 110);

  // 5. Author approved and ready to merge -> ready_to_merge (isYourTurn: true, score: 95)
  const readyToMerge = enrichPullRequest(
    makePr({
      key: 'acme/repo#5',
      authorUuid: ME,
      participants: [
        { uuid: '{rev-1}', displayName: 'Rev1', role: 'REVIEWER', approved: true, state: 'approved' }
      ]
    }),
    ME,
    { now: NOW }
  );
  assert.equal(readyToMerge.actionState, 'ready_to_merge');
  assert.equal(readyToMerge.isYourTurn, true);
  assert.equal(readyToMerge.priorityScore, 95);

  // 6. Author waiting for reviewers -> waiting_reviewers (isYourTurn: false, score: 50)
  const waiting = enrichPullRequest(
    makePr({
      key: 'acme/repo#6',
      authorUuid: ME,
      reviewers: [{ uuid: '{rev-1}', displayName: 'Rev1' }]
    }),
    ME,
    { now: NOW }
  );
  assert.equal(waiting.actionState, 'waiting_reviewers');
  assert.equal(waiting.isYourTurn, false);
  assert.equal(waiting.priorityScore, 50);

  // 7. Draft PR -> draft (isYourTurn: false) + staleness detection
  const draftStale = enrichPullRequest(
    makePr({
      key: 'acme/repo#7',
      draft: true,
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      updatedOn: new Date(NOW - 50 * 3600 * 1000).toISOString()
    }),
    ME,
    { staleThresholdHours: 48, now: NOW }
  );
  assert.equal(draftStale.actionState, 'draft');
  assert.equal(draftStale.isYourTurn, false);
  assert.equal(draftStale.isStale, true);
  assert.ok(draftStale.ageHours >= 50);
});

test('extractJiraKeys, buildJiraTicketLinks, and collectActiveJiraTickets extract & group tickets', () => {
  const keys = extractJiraKeys(
    'MEZ-101: Add widget (also fixes ENG2-42 and MEZ-101)',
    'feature/MEZ-101-OPS-7-branch'
  );
  assert.deepEqual(keys, ['MEZ-101', 'ENG2-42', 'OPS-7']);

  const linksWithBase = buildJiraTicketLinks(keys, 'https://mezzanine.jira.example.com/');
  assert.deepEqual(linksWithBase, [
    { key: 'MEZ-101', url: 'https://mezzanine.jira.example.com/browse/MEZ-101' },
    { key: 'ENG2-42', url: 'https://mezzanine.jira.example.com/browse/ENG2-42' },
    { key: 'OPS-7', url: 'https://mezzanine.jira.example.com/browse/OPS-7' }
  ]);

  const linksNoBase = buildJiraTicketLinks(['MEZ-101'], '');
  assert.deepEqual(linksNoBase, [{ key: 'MEZ-101', url: null }]);

  const enriched1 = enrichPullRequest(
    makePr({
      key: 'acme/repo#10',
      title: 'MEZ-101 part 1',
      reviewers: [{ uuid: ME, displayName: 'Me' }]
    }),
    ME,
    { jiraBaseUrl: 'https://mezzanine.jira.example.com', now: NOW }
  );
  const enriched2 = enrichPullRequest(
    makePr({
      key: 'acme/repo#11',
      title: 'MEZ-101 part 2 + OPS-7',
      authorUuid: ME
    }),
    ME,
    { jiraBaseUrl: 'https://mezzanine.jira.example.com', now: NOW }
  );

  const grouped = collectActiveJiraTickets([enriched1, enriched2]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].key, 'MEZ-101');
  assert.equal(grouped[0].prCount, 2);
  assert.equal(grouped[0].hasYourTurn, true);
  assert.equal(grouped[0].highestPriority, 100);
  assert.equal(grouped[1].key, 'OPS-7');
  assert.equal(grouped[1].prCount, 1);
  assert.equal(grouped[1].hasYourTurn, false);
});

test('Smart Snooze auto-unsnoozes when PR updatedOn advances or snooze expires', () => {
  const pr = makePr({ key: 'acme/repo#1', updatedOn: '2026-11-22T10:00:00Z' });
  const snoozedMap = {
    'acme/repo#1': {
      until: NOW + 3600_000,
      prUpdatedOn: '2026-11-22T10:00:00Z'
    },
    'acme/repo#2': {
      until: NOW - 1000,
      prUpdatedOn: '2026-11-22T10:00:00Z'
    }
  };

  assert.equal(isPrSnoozed(pr, snoozedMap, NOW), true);
  assert.equal(isPrSnoozed(pr, snoozedMap, NOW + 3600_000), false);

  const updatedPr = { ...pr, updatedOn: '2026-11-22T11:30:00Z' };
  assert.equal(isPrSnoozed(updatedPr, snoozedMap, NOW), false);

  const pruned = pruneExpiredSnoozes(snoozedMap, [pr], NOW);
  assert.deepEqual(Object.keys(pruned), ['acme/repo#1']);
});

test('filterAndSortPrs and computeCounts respect filters, snoozes, search query, and priority sort', () => {
  const prHigh = enrichPullRequest(
    makePr({
      key: 'acme/api#1',
      id: 1,
      title: 'MEZ-50 Fix auth',
      authorUuid: ME,
      repoName: 'api',
      repoFullName: 'acme/api',
      participants: [
        { uuid: '{r}', displayName: 'R', role: 'REVIEWER', approved: false, state: 'changes_requested' }
      ],
      updatedOn: '2026-11-22T09:00:00Z'
    }),
    ME,
    { now: NOW }
  );

  const prReview = enrichPullRequest(
    makePr({
      key: 'acme/web#2',
      id: 2,
      title: 'Update dashboard',
      authorName: 'Charlie',
      sourceBranch: 'feat/MEZ-88-ui',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      updatedOn: '2026-11-22T11:00:00Z'
    }),
    ME,
    { now: NOW }
  );

  const prSnoozed = enrichPullRequest(
    makePr({
      key: 'acme/web#3',
      id: 3,
      title: 'Snoozed item',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      updatedOn: '2026-11-22T10:00:00Z'
    }),
    ME,
    { now: NOW }
  );

  const allPrs = [prReview, prHigh, prSnoozed];
  const snoozedMap = {
    'acme/web#3': { until: NOW + 10_000, prUpdatedOn: '2026-11-22T10:00:00Z' }
  };

  const counts = computeCounts(allPrs, snoozedMap, NOW);
  assert.deepEqual(counts, {
    actionRequired: 2,
    reviewing: 1,
    authored: 1,
    all: 2,
    snoozed: 1
  });

  const actionList = filterAndSortPrs(allPrs, {
    filter: 'action_required',
    snoozedMap,
    now: NOW
  });
  assert.deepEqual(actionList.map((p) => p.key), ['acme/api#1', 'acme/web#2']);

  const searchByJiraBranch = filterAndSortPrs(allPrs, {
    filter: 'all',
    query: 'mez-88',
    snoozedMap,
    now: NOW
  });
  assert.deepEqual(searchByJiraBranch.map((p) => p.key), ['acme/web#2']);

  const snoozedList = filterAndSortPrs(allPrs, {
    filter: 'snoozed',
    snoozedMap,
    now: NOW
  });
  assert.deepEqual(snoozedList.map((p) => p.key), ['acme/web#3']);
});

test('role === "both" prioritizes changes_requested from another reviewer', () => {
  const prBoth = enrichPullRequest(
    makePr({
      authorUuid: ME,
      reviewers: [
        { uuid: ME, displayName: 'Me' },
        { uuid: '{other-rev}', displayName: 'Reviewer' }
      ],
      participants: [
        { uuid: ME, displayName: 'Me', role: 'AUTHOR', approved: false, state: 'changes_requested' },
        { uuid: '{other-rev}', displayName: 'Reviewer', role: 'REVIEWER', approved: false, state: 'changes_requested' }
      ]
    }),
    ME,
    { now: NOW }
  );

  assert.equal(prBoth.role, 'both');
  assert.equal(prBoth.changesRequestedCount, 1);
  assert.equal(prBoth.actionState, 'changes_requested');
  assert.equal(prBoth.isYourTurn, true);
});
