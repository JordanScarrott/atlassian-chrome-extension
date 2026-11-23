import test from 'node:test';
import assert from 'node:assert/strict';

import { findNewlyActionablePrs } from '../bitbucket-pr-extension/src/notifications.js';
import { enrichPullRequest } from '../bitbucket-pr-extension/src/pr-triage.js';

const ME = '{me}';
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

function makeEnriched(overrides = {}) {
  return enrichPullRequest(
    {
      key: 'acme/repo#1',
      id: 1,
      title: 'Test PR',
      state: 'OPEN',
      url: 'https://bitbucket.org/acme/repo/pull-requests/1',
      repoFullName: 'acme/repo',
      repoName: 'repo',
      workspace: 'acme',
      authorUuid: '{other}',
      authorName: 'Alice',
      sourceBranch: 'feat/x',
      destinationBranch: 'main',
      createdOn: '2026-11-22T08:00:00Z',
      updatedOn: '2026-11-22T10:00:00Z',
      commentCount: 0,
      taskCount: 0,
      draft: false,
      reviewers: [{ uuid: ME, displayName: 'Me' }],
      participants: [],
      ...overrides
    },
    ME,
    { now: NOW }
  );
}

test('findNewlyActionablePrs returns only newly actionable, non-snoozed PRs', () => {
  const alreadyActionable = makeEnriched({ key: 'acme/repo#1', id: 1 });
  const newlyActionable = makeEnriched({ key: 'acme/repo#2', id: 2 });
  const newlySnoozed = makeEnriched({
    key: 'acme/repo#3',
    id: 3,
    updatedOn: '2026-11-22T10:00:00Z'
  });
  const transitionedWaitingToReady = makeEnriched({
    key: 'acme/repo#4',
    id: 4,
    authorUuid: ME,
    reviewers: [],
    participants: [
      { uuid: '{rev}', displayName: 'Rev', role: 'REVIEWER', approved: true, state: 'approved' }
    ]
  });
  const previouslyWaiting = makeEnriched({
    key: 'acme/repo#4',
    id: 4,
    authorUuid: ME,
    reviewers: [{ uuid: '{rev}', displayName: 'Rev' }],
    participants: []
  });
  const notYourTurnNow = makeEnriched({
    key: 'acme/repo#5',
    id: 5,
    authorUuid: ME,
    reviewers: [{ uuid: '{rev}', displayName: 'Rev' }],
    participants: []
  });

  const snoozedMap = {
    'acme/repo#3': {
      until: NOW + 60_000,
      prUpdatedOn: '2026-11-22T10:00:00Z'
    }
  };

  const result = findNewlyActionablePrs(
    [alreadyActionable, previouslyWaiting],
    [alreadyActionable, newlyActionable, newlySnoozed, transitionedWaitingToReady, notYourTurnNow],
    snoozedMap,
    NOW
  );

  assert.deepEqual(
    result.map((p) => p.key),
    ['acme/repo#2', 'acme/repo#4']
  );
});
