import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJiraTicketLinks,
  buildRelatedPrMap,
  collectActiveJiraTickets,
  computeCounts,
  enrichPullRequest,
  extractGitHubIssueRefs,
  extractJiraKeys,
  filterAndSortPrs,
  getPrimaryTicketKey,
  groupPrsByTicket,
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

test('CI status escalates authored PRs to ci_failed (preventing false ready_to_merge) and lowers red reviewer priority', () => {
  const makeBuild = (state, name = 'CI Pipeline') => ({
    state,
    totalCount: 1,
    passedCount: state === 'SUCCESSFUL' ? 1 : 0,
    failedCount: state === 'FAILED' ? 1 : 0,
    inProgressCount: state === 'INPROGRESS' ? 1 : 0,
    stoppedCount: state === 'STOPPED' ? 1 : 0,
    url: 'https://ci.example.com/1',
    name,
    updatedOn: '2026-11-22T11:00:00Z',
    commitHash: 'deadbeef',
    cachedAt: NOW
  });

  // Authored PR with approval + FAILED CI must escalate to ci_failed (NOT ready_to_merge!)
  const approvedButRed = enrichPullRequest(
    makePr({
      key: 'acme/repo#20',
      authorUuid: ME,
      participants: [
        { uuid: '{rev}', displayName: 'Rev', role: 'REVIEWER', approved: true, state: 'approved' }
      ],
      buildStatus: makeBuild('FAILED')
    }),
    ME,
    { now: NOW }
  );
  assert.equal(approvedButRed.actionState, 'ci_failed');
  assert.equal(approvedButRed.isYourTurn, true);
  assert.equal(approvedButRed.priorityScore, 105);

  // Authored PR with STOPPED CI also escalates to ci_failed
  const stoppedCi = enrichPullRequest(
    makePr({
      key: 'acme/repo#21',
      authorUuid: ME,
      buildStatus: makeBuild('STOPPED')
    }),
    ME,
    { now: NOW }
  );
  assert.equal(stoppedCi.actionState, 'ci_failed');
  assert.equal(stoppedCi.isYourTurn, true);
  assert.equal(stoppedCi.priorityScore, 105);

  // Authored PR with changes_requested + FAILED CI stays changes_requested (score 110 > 105)
  const changesAndRed = enrichPullRequest(
    makePr({
      key: 'acme/repo#22',
      authorUuid: ME,
      participants: [
        { uuid: '{rev}', displayName: 'Rev', role: 'REVIEWER', approved: false, state: 'changes_requested' }
      ],
      buildStatus: makeBuild('FAILED')
    }),
    ME,
    { now: NOW }
  );
  assert.equal(changesAndRed.actionState, 'changes_requested');
  assert.equal(changesAndRed.priorityScore, 110);

  // Draft PR with FAILED CI remains draft
  const draftRed = enrichPullRequest(
    makePr({
      key: 'acme/repo#23',
      authorUuid: ME,
      draft: true,
      buildStatus: makeBuild('FAILED')
    }),
    ME,
    { now: NOW }
  );
  assert.equal(draftRed.actionState, 'draft');
  assert.equal(draftRed.isYourTurn, false);

  // Reviewer PRs: green needs_review (100) sorts ahead of red needs_review (92)
  const greenReview = enrichPullRequest(
    makePr({
      key: 'acme/repo#24',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      buildStatus: makeBuild('SUCCESSFUL', 'Unit Tests')
    }),
    ME,
    { now: NOW }
  );
  const redReview = enrichPullRequest(
    makePr({
      key: 'acme/repo#25',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      buildStatus: makeBuild('FAILED', 'Lint Check')
    }),
    ME,
    { now: NOW }
  );
  assert.equal(greenReview.priorityScore, 100);
  assert.equal(redReview.priorityScore, 92);
  assert.equal(redReview.isYourTurn, true);

  const sorted = filterAndSortPrs([redReview, greenReview], { filter: 'action_required', now: NOW });
  assert.deepEqual(sorted.map((p) => p.key), ['acme/repo#24', 'acme/repo#25']);
});

test('filterAndSortPrs supports ci:* search tokens and build name, and collectActiveJiraTickets ignores snoozed PRs', () => {
  const buildSummary = (state, name) => ({
    state,
    totalCount: 1,
    passedCount: state === 'SUCCESSFUL' ? 1 : 0,
    failedCount: state === 'FAILED' ? 1 : 0,
    inProgressCount: state === 'INPROGRESS' ? 1 : 0,
    stoppedCount: state === 'STOPPED' ? 1 : 0,
    url: 'https://ci.example.com/run',
    name,
    updatedOn: '2026-11-22T11:00:00Z',
    commitHash: 'abc',
    cachedAt: NOW
  });

  const failedPr = enrichPullRequest(
    makePr({
      key: 'acme/repo#30',
      title: 'MEZ-200 Broken build',
      authorUuid: ME,
      buildStatus: buildSummary('FAILED', 'Webpack Compile')
    }),
    ME,
    { now: NOW }
  );
  const passingPr = enrichPullRequest(
    makePr({
      key: 'acme/repo#31',
      title: 'MEZ-201 Green build',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      buildStatus: buildSummary('SUCCESSFUL', 'Jest Suite')
    }),
    ME,
    { now: NOW }
  );
  const runningPr = enrichPullRequest(
    makePr({
      key: 'acme/repo#32',
      title: 'MEZ-202 Running build',
      authorUuid: ME,
      buildStatus: buildSummary('INPROGRESS', 'Docker Push')
    }),
    ME,
    { now: NOW }
  );
  const stoppedPr = enrichPullRequest(
    makePr({
      key: 'acme/repo#33',
      title: 'MEZ-203 Cancelled build',
      authorUuid: ME,
      buildStatus: buildSummary('STOPPED', 'Deploy Staging')
    }),
    ME,
    { now: NOW }
  );

  const all = [failedPr, passingPr, runningPr, stoppedPr];
  assert.deepEqual(
    filterAndSortPrs(all, { filter: 'all', query: 'ci:failed', now: NOW }).map((p) => p.key),
    ['acme/repo#30', 'acme/repo#33']
  );
  assert.deepEqual(
    filterAndSortPrs(all, { filter: 'all', query: 'ci:passing', now: NOW }).map((p) => p.key),
    ['acme/repo#31']
  );
  assert.deepEqual(
    filterAndSortPrs(all, { filter: 'all', query: 'ci:running', now: NOW }).map((p) => p.key),
    ['acme/repo#32']
  );
  assert.deepEqual(
    filterAndSortPrs(all, { filter: 'all', query: 'ci:stopped', now: NOW }).map((p) => p.key),
    ['acme/repo#33']
  );
  assert.deepEqual(
    filterAndSortPrs(all, { filter: 'all', query: 'webpack', now: NOW }).map((p) => p.key),
    ['acme/repo#30']
  );

  // Snoozed PR should NOT mark MEZ-200 as hasYourTurn: true
  const snoozedMap = {
    'acme/repo#30': { until: NOW + 60_000, prUpdatedOn: failedPr.updatedOn }
  };
  const ticketsWithSnooze = collectActiveJiraTickets(all, snoozedMap, NOW);
  const mez200 = ticketsWithSnooze.find((t) => t.key === 'MEZ-200');
  const mez201 = ticketsWithSnooze.find((t) => t.key === 'MEZ-201');
  assert.equal(mez200?.hasYourTurn, false);
  assert.equal(mez201?.hasYourTurn, true);

  // Without snoozedMap (backward compatible), MEZ-200 has hasYourTurn: true
  const ticketsWithoutSnooze = collectActiveJiraTickets(all);
  assert.equal(ticketsWithoutSnooze.find((t) => t.key === 'MEZ-200')?.hasYourTurn, true);
});

test('extractJiraKeys scans PR description & /browse URLs, and extractGitHubIssueRefs extracts #123 references', () => {
  const keys = extractJiraKeys(
    'Refactor payment service',
    'feat/payments-cleanup',
    'Related to https://jira.example.com/browse/pay-404 and OPS-12 (also PAY-404).'
  );
  assert.deepEqual(keys, ['OPS-12', 'PAY-404']);

  const refs = extractGitHubIssueRefs(
    'Fix crash on startup (#42)',
    'fix/42-crash',
    'Closes #108, refs #42 and resolves: #99'
  );
  assert.deepEqual(refs, ['#42', '#108', '#99']);

  assert.equal(getPrimaryTicketKey({ jiraKeys: ['PAY-404'], issueRefs: ['#42'] }), 'PAY-404');
  assert.equal(getPrimaryTicketKey({ jiraKeys: [], issueRefs: ['#42'] }), '#42');
  assert.equal(getPrimaryTicketKey({ jiraKeys: [], issueRefs: [] }), null);
});

test('buildRelatedPrMap links PRs across Bitbucket + GitHub and groupPrsByTicket orders linked & unlinked groups', () => {
  const bbAuth = enrichPullRequest(
    makePr({
      provider: 'bitbucket',
      key: 'acme/backend#10',
      id: 10,
      title: 'MEZ-500 Backend API',
      authorUuid: ME,
      participants: [
        { uuid: '{rev}', displayName: 'Rev', role: 'REVIEWER', approved: true, state: 'approved' }
      ],
      buildStatus: {
        state: 'FAILED',
        totalCount: 1,
        passedCount: 0,
        failedCount: 1,
        inProgressCount: 0,
        stoppedCount: 0,
        url: 'https://ci.example.com/10',
        name: 'CI',
        updatedOn: '2026-11-22T11:00:00Z',
        commitHash: 'abc',
        cachedAt: NOW
      }
    }),
    ME,
    { jiraBaseUrl: 'https://jira.example.com', now: NOW }
  );

  const ghFrontend = enrichPullRequest(
    makePr({
      provider: 'github',
      key: 'gh:acme/frontend#22',
      id: 22,
      title: 'Frontend UI changes',
      description: 'Implements https://jira.example.com/browse/MEZ-500 and Fixes #77',
      authorUuid: 'gh:other',
      reviewers: [{ uuid: 'gh:99', displayName: 'Me GH' }],
      participants: []
    }),
    'gh:99',
    { jiraBaseUrl: 'https://jira.example.com', now: NOW }
  );

  const ghIssueOnlyWaiting = enrichPullRequest(
    makePr({
      provider: 'github',
      key: 'gh:acme/docs#5',
      id: 5,
      title: 'Update docs',
      description: 'Closes #77',
      authorUuid: 'gh:99',
      reviewers: [{ uuid: 'gh:100', displayName: 'Reviewer' }],
      participants: []
    }),
    'gh:99',
    { jiraBaseUrl: 'https://jira.example.com', now: NOW }
  );

  const unlinkedPr = enrichPullRequest(
    makePr({
      key: 'acme/infra#99',
      id: 99,
      title: 'Bump dependencies',
      sourceBranch: 'chore/deps',
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      participants: []
    }),
    ME,
    { jiraBaseUrl: 'https://jira.example.com', now: NOW }
  );

  assert.equal(ghFrontend.provider, 'github');
  assert.deepEqual(ghFrontend.jiraKeys, ['MEZ-500']);
  assert.deepEqual(ghFrontend.issueRefs, ['#77']);
  assert.equal(ghFrontend.primaryTicketKey, 'MEZ-500');
  assert.equal(bbAuth.provider, 'bitbucket');

  const allPrs = [unlinkedPr, ghIssueOnlyWaiting, ghFrontend, bbAuth];
  const relatedMap = buildRelatedPrMap(allPrs);

  // MEZ-500 links Bitbucket acme/backend#10 <-> GitHub gh:acme/frontend#22, plus #77 links gh:acme/frontend#22 <-> gh:acme/docs#5
  assert.deepEqual(relatedMap['acme/backend#10'], {
    ticketKey: 'MEZ-500',
    relatedKeys: ['gh:acme/frontend#22']
  });
  assert.deepEqual(relatedMap['gh:acme/frontend#22'], {
    ticketKey: 'MEZ-500',
    relatedKeys: ['acme/backend#10', 'gh:acme/docs#5']
  });
  assert.deepEqual(relatedMap['gh:acme/docs#5'], {
    ticketKey: '#77',
    relatedKeys: ['gh:acme/frontend#22']
  });
  assert.equal(relatedMap['acme/infra#99'], undefined);

  const groups = groupPrsByTicket(allPrs, {}, NOW);
  assert.equal(groups.length, 3);

  // Group 0: MEZ-500 (yourTurnCount = 2, cross-provider bitbucket + github)
  assert.equal(groups[0].groupKey, 'MEZ-500');
  assert.equal(groups[0].label, 'MEZ-500');
  assert.equal(groups[0].ticketUrl, 'https://jira.example.com/browse/MEZ-500');
  assert.equal(groups[0].isUnlinked, false);
  assert.equal(groups[0].prs.length, 2);
  assert.equal(groups[0].yourTurnCount, 2);
  assert.equal(groups[0].approvedCount, 1);
  assert.equal(groups[0].ciFailedCount, 1);
  assert.deepEqual(groups[0].providers.sort(), ['bitbucket', 'github']);

  // Group 1: #77 (linked, waiting_reviewers -> yourTurnCount = 0)
  assert.equal(groups[1].groupKey, '#77');
  assert.equal(groups[1].ticketUrl, null);
  assert.equal(groups[1].yourTurnCount, 0);

  // Group 2: UNLINKED always sorted last even if its PR is yourTurn
  assert.equal(groups[2].groupKey, 'UNLINKED');
  assert.equal(groups[2].label, 'No Linked Ticket');
  assert.equal(groups[2].isUnlinked, true);
  assert.equal(groups[2].yourTurnCount, 1);
});

