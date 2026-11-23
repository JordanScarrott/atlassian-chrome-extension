import { describe, test, expect } from 'bun:test';
import {
  extractJiraTickets,
  isSameUser,
  normalizeJiraBaseUrl,
  sanitizeUrl,
  normalizePullRequest,
  partitionPullRequests,
} from '../bitbucket-pr-extension/lib/pr-model.js';

describe('isSameUser', () => {
  test('matches normalized uuid with or without braces and case-insensitively', () => {
    expect(
      isSameUser({ uuid: '{ABC-123-DEF}' }, { uuid: 'abc-123-def' })
    ).toBe(true);
    expect(
      isSameUser({ uuid: '  {abc-123-def} ' }, { uuid: '{ABC-123-DEF}' })
    ).toBe(true);
  });

  test('matches account_id and accountId across candidate and currentUser', () => {
    expect(
      isSameUser({ account_id: '557058:user-1' }, { accountId: '557058:user-1' })
    ).toBe(true);
    expect(
      isSameUser({ accountId: ' 557058:user-2 ' }, { account_id: '557058:user-2' })
    ).toBe(true);
  });

  test('falls back to exact lowercase username only when both uuid and account_id are absent on candidate', () => {
    expect(
      isSameUser({ username: 'JordanS' }, { username: 'jordans', accountId: 'acc-1' })
    ).toBe(true);

    // Must not fall back to username when candidate provides a non-matching uuid or account_id
    expect(
      isSameUser(
        { uuid: '{other-uuid}', username: 'jordans' },
        { uuid: '{my-uuid}', username: 'jordans' }
      )
    ).toBe(false);
    expect(
      isSameUser(
        { account_id: 'other-acc', username: 'jordans' },
        { accountId: 'my-acc', username: 'jordans' }
      )
    ).toBe(false);
  });

  test('does not falsely match short substring nicknames or partial names', () => {
    expect(
      isSameUser(
        { nickname: 'dan', display_name: 'Dan', username: 'dan' },
        { nickname: 'jordan', display_name: 'Jordan', username: 'jordan@example.com' }
      )
    ).toBe(false);

    expect(
      isSameUser(
        { nickname: 'dan' },
        { nickname: 'dan', username: 'jordan@example.com' }
      )
    ).toBe(false);
  });

  test('returns false for missing or nullish user objects', () => {
    expect(isSameUser(null, { uuid: 'abc' })).toBe(false);
    expect(isSameUser({ uuid: 'abc' }, null)).toBe(false);
    expect(isSameUser({}, {})).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  test('allows https and http Bitbucket URLs and trims whitespace', () => {
    expect(sanitizeUrl('https://bitbucket.org/ws/repo/pull-requests/1')).toBe(
      'https://bitbucket.org/ws/repo/pull-requests/1'
    );
    expect(sanitizeUrl('  https://bitbucket.org/avatar.png  ')).toBe(
      'https://bitbucket.org/avatar.png'
    );
    expect(sanitizeUrl('http://example.com/pr/1')).toBe('http://example.com/pr/1');
  });

  test('blocks javascript:, hash fragments, empty strings, and invalid URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeUrl('JAVASCRIPT:alert(1)')).toBe('');
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(sanitizeUrl('#')).toBe('');
    expect(sanitizeUrl('')).toBe('');
    expect(sanitizeUrl('   ')).toBe('');
    expect(sanitizeUrl(null)).toBe('');
    expect(sanitizeUrl(undefined)).toBe('');
  });
});

describe('normalizePullRequest', () => {
  const currentUser = {
    accountId: '557058:me',
    uuid: '{1111-2222}',
    displayName: 'Jordan Scarrott',
    username: 'jordans',
  };

  test('produces unique keys across two repos with the same PR ID', () => {
    const rawPrA = {
      id: 1,
      title: 'Repo A PR',
      destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
      author: { account_id: '557058:me', display_name: 'Jordan' },
    };
    const rawPrB = {
      id: 1,
      title: 'Repo B PR',
      destination: { repository: { full_name: 'ws/repo-b', name: 'repo-b' } },
      author: { account_id: '557058:me', display_name: 'Jordan' },
    };

    const normA = normalizePullRequest(rawPrA, currentUser);
    const normB = normalizePullRequest(rawPrB, currentUser);

    expect(normA.key).toBe('ws/repo-a#1');
    expect(normB.key).toBe('ws/repo-b#1');
    expect(normA.key).not.toBe(normB.key);
  });

  test('extracts description, counts, branches, repoName, updatedOn, and author details', () => {
    const rawPr = {
      id: 42,
      title: 'Add unit tests',
      description: '  Covers normalization and partitioning.  ',
      state: 'OPEN',
      comment_count: 7,
      task_count: 2,
      created_on: '2026-11-18T09:00:00Z',
      updated_on: '2026-11-19T10:30:00Z',
      links: {
        html: { href: 'https://bitbucket.org/ws/my-repo/pull-requests/42' },
      },
      source: {
        branch: { name: 'feature/tests' },
        repository: { full_name: 'ws/my-repo', name: 'my-repo' },
      },
      destination: {
        branch: { name: 'main' },
        repository: { full_name: 'ws/my-repo', name: 'my-repo' },
      },
      author: {
        display_name: 'Alice Dev',
        uuid: '{aaaa-bbbb}',
        account_id: '557058:alice',
        links: { avatar: { href: 'https://bitbucket.org/account/alice/avatar/32/' } },
      },
    };

    const pr = normalizePullRequest(rawPr, currentUser);

    expect(pr.key).toBe('ws/my-repo#42');
    expect(pr.id).toBe(42);
    expect(pr.title).toBe('Add unit tests');
    expect(pr.description).toBe('Covers normalization and partitioning.');
    expect(pr.commentCount).toBe(7);
    expect(pr.taskCount).toBe(2);
    expect(pr.sourceBranch).toBe('feature/tests');
    expect(pr.destinationBranch).toBe('main');
    expect(pr.repoFullName).toBe('ws/my-repo');
    expect(pr.repoName).toBe('my-repo');
    expect(pr.createdOn).toBe('2026-11-18T09:00:00Z');
    expect(pr.updatedOn).toBe('2026-11-19T10:30:00Z');
    expect(pr.url).toBe('https://bitbucket.org/ws/my-repo/pull-requests/42');
    expect(pr.author).toEqual({
      displayName: 'Alice Dev',
      uuid: '{aaaa-bbbb}',
      accountId: '557058:alice',
      avatarUrl: 'https://bitbucket.org/account/alice/avatar/32/',
    });
  });

  test('merges participants and reviewers without duplicates while preserving review states and user flags', () => {
    const rawPr = {
      id: 99,
      title: 'Refactor API client',
      destination: { repository: { full_name: 'ws/core', name: 'core' } },
      author: {
        display_name: 'Alice Dev',
        uuid: '{alice-uuid}',
        account_id: '557058:alice',
      },
      participants: [
        // Author as participant without explicit review decision should be excluded
        {
          role: 'PARTICIPANT',
          approved: false,
          user: {
            display_name: 'Alice Dev',
            uuid: '{alice-uuid}',
            account_id: '557058:alice',
          },
        },
        // Current user approved
        {
          role: 'REVIEWER',
          approved: true,
          state: 'approved',
          user: {
            display_name: 'Jordan Scarrott',
            uuid: '{1111-2222}',
            account_id: '557058:me',
          },
        },
        // Bob requested changes
        {
          role: 'REVIEWER',
          approved: false,
          state: 'changes_requested',
          user: {
            display_name: 'Bob Reviewer',
            uuid: '{bob-uuid}',
            account_id: '557058:bob',
          },
        },
      ],
      reviewers: [
        // Duplicates of Jordan and Bob should NOT create duplicate entries or overwrite state
        {
          display_name: 'Jordan Scarrott',
          uuid: '{1111-2222}',
          account_id: '557058:me',
        },
        {
          display_name: 'Bob Reviewer',
          uuid: '{bob-uuid}',
          account_id: '557058:bob',
        },
        // Carol only exists in reviewers -> pending
        {
          display_name: 'Carol Reviewer',
          uuid: '{carol-uuid}',
          account_id: '557058:carol',
        },
      ],
    };

    const pr = normalizePullRequest(rawPr, currentUser);

    expect(pr.isAuthor).toBe(false);
    expect(pr.isReviewer).toBe(true);
    expect(pr.myReviewState).toBe('approved');
    expect(pr.reviewers).toHaveLength(3);

    const jordan = pr.reviewers.find((r) => r.accountId === '557058:me');
    const bob = pr.reviewers.find((r) => r.accountId === '557058:bob');
    const carol = pr.reviewers.find((r) => r.accountId === '557058:carol');

    expect(jordan).toEqual({
      displayName: 'Jordan Scarrott',
      uuid: '{1111-2222}',
      accountId: '557058:me',
      avatarUrl: '',
      state: 'approved',
      approved: true,
      isMe: true,
    });
    expect(bob).toEqual({
      displayName: 'Bob Reviewer',
      uuid: '{bob-uuid}',
      accountId: '557058:bob',
      avatarUrl: '',
      state: 'changes_requested',
      approved: false,
      isMe: false,
    });
    expect(carol).toEqual({
      displayName: 'Carol Reviewer',
      uuid: '{carol-uuid}',
      accountId: '557058:carol',
      avatarUrl: '',
      state: 'pending',
      approved: false,
      isMe: false,
    });
  });

  test('authored PR marks isAuthor=true, isReviewer=false, myReviewState=none even if author appears in reviewers', () => {
    const rawPr = {
      id: 7,
      title: 'My own PR',
      destination: { repository: { full_name: 'ws/repo-a', name: 'repo-a' } },
      author: {
        display_name: 'Jordan Scarrott',
        uuid: '{1111-2222}',
        account_id: '557058:me',
      },
      participants: [
        {
          role: 'REVIEWER',
          approved: true,
          user: {
            display_name: 'Jordan Scarrott',
            uuid: '{1111-2222}',
            account_id: '557058:me',
          },
        },
      ],
      reviewers: [
        {
          display_name: 'Jordan Scarrott',
          uuid: '{1111-2222}',
          account_id: '557058:me',
        },
      ],
    };

    const pr = normalizePullRequest(rawPr, currentUser);
    expect(pr.isAuthor).toBe(true);
    expect(pr.isReviewer).toBe(false);
    expect(pr.myReviewState).toBe('none');
  });
});

describe('partitionPullRequests', () => {
  test('separates myPrs and toReviewPrs, sorts accurately, and computes pendingReviewCount', () => {
    const prs = [
      {
        key: 'ws/repo#1',
        id: 1,
        isAuthor: true,
        isReviewer: false,
        myReviewState: 'none',
        updatedOn: '2026-11-18T10:00:00Z',
      },
      {
        key: 'ws/repo#2',
        id: 2,
        isAuthor: true,
        isReviewer: false,
        myReviewState: 'none',
        updatedOn: '2026-11-19T12:00:00Z',
      },
      {
        key: 'ws/repo#3',
        id: 3,
        isAuthor: false,
        isReviewer: true,
        myReviewState: 'approved',
        updatedOn: '2026-11-19T15:00:00Z',
      },
      {
        key: 'ws/repo#4',
        id: 4,
        isAuthor: false,
        isReviewer: true,
        myReviewState: 'pending',
        updatedOn: '2026-11-17T08:00:00Z',
      },
      {
        key: 'ws/repo#5',
        id: 5,
        isAuthor: false,
        isReviewer: true,
        myReviewState: 'changes_requested',
        updatedOn: '2026-11-19T09:00:00Z',
      },
      {
        key: 'ws/repo#6',
        id: 6,
        isAuthor: false,
        isReviewer: true,
        myReviewState: 'pending',
        updatedOn: '2026-11-19T11:00:00Z',
      },
      // Edge case: if an authored PR somehow had isReviewer=true, partition keeps it out of toReviewPrs if normalized properly,
      // and authored PRs appear in myPrs.
    ];

    const result = partitionPullRequests(prs);

    // myPrs sorted by updatedOn descending
    expect(result.myPrs.map((p) => p.key)).toEqual(['ws/repo#2', 'ws/repo#1']);

    // Authored PRs never appear in toReviewPrs
    for (const myPr of result.myPrs) {
      expect(result.toReviewPrs.some((p) => p.key === myPr.key)).toBe(false);
    }

    // toReviewPrs sorted by priority (pending -> changes_requested -> approved), then updatedOn descending
    expect(result.toReviewPrs.map((p) => p.key)).toEqual([
      'ws/repo#6', // pending, newer
      'ws/repo#4', // pending, older
      'ws/repo#5', // changes_requested
      'ws/repo#3', // approved
    ]);

    expect(result.pendingReviewCount).toBe(2);
  });

  test('authored PRs normalized through normalizePullRequest never appear in toReviewPrs', () => {
    const me = { accountId: '557058:me', uuid: '{me}' };
    const normalized = [
      normalizePullRequest(
        {
          id: 10,
          title: 'Self PR',
          destination: { repository: { full_name: 'ws/repo', name: 'repo' } },
          author: { account_id: '557058:me', uuid: '{me}' },
          reviewers: [{ account_id: '557058:me', uuid: '{me}' }],
        },
        me
      ),
    ];

    const result = partitionPullRequests(normalized);
    expect(result.myPrs).toHaveLength(1);
    expect(result.toReviewPrs).toHaveLength(0);
    expect(result.pendingReviewCount).toBe(0);
  });

  test('handles empty or non-array inputs safely', () => {
    expect(partitionPullRequests([])).toEqual({
      myPrs: [],
      toReviewPrs: [],
      pendingReviewCount: 0,
    });
    expect(partitionPullRequests(null)).toEqual({
      myPrs: [],
      toReviewPrs: [],
      pendingReviewCount: 0,
    });
  });
});

describe('Jira URL & Ticket Extraction', () => {
  test('normalizeJiraBaseUrl normalizes bare hostnames and strips paths', () => {
    expect(normalizeJiraBaseUrl('acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBaseUrl('https://acme.atlassian.net/jira/software')).toBe(
      'https://acme.atlassian.net'
    );
    expect(normalizeJiraBaseUrl('javascript:alert(1)')).toBe('');
    expect(normalizeJiraBaseUrl('')).toBe('');
  });

  test('extractJiraTickets extracts keys from branch, title, and explicit browse URLs while ignoring false positives', () => {
    const tickets = extractJiraTickets(
      {
        sourceBranch: 'feat/ENG-142-oauth-pkce',
        title: '[ENG-142] Add PKCE (UTF-8, SHA-256)',
        description: 'See https://acme.atlassian.net/browse/PLAT-99 and ENG-142',
      },
      'https://myorg.atlassian.net'
    );

    expect(tickets).toEqual([
      { key: 'PLAT-99', url: 'https://acme.atlassian.net/browse/PLAT-99' },
      { key: 'ENG-142', url: 'https://myorg.atlassian.net/browse/ENG-142' },
    ]);
  });
});
