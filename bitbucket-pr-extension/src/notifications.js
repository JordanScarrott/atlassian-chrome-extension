import { isPrSnoozed } from './pr-triage.js';

/**
 * Find PRs that newly entered the user's "Your Turn" attention set.
 * Returns only PRs that:
 * 1. Have `isYourTurn === true` in `currentPrs`,
 * 2. Are NOT currently snoozed under `snoozedMap` at `now`, AND
 * 3. Were NOT already `isYourTurn === true` in `previousPrs`.
 *
 * Prevents duplicate notification spam across polling intervals.
 *
 * @param {readonly import('./pr-triage.js').EnrichedPullRequest[]} previousPrs
 * @param {readonly import('./pr-triage.js').EnrichedPullRequest[]} currentPrs
 * @param {import('./storage.js').SnoozedMap | null | undefined} [snoozedMap]
 * @param {number} [now]
 * @returns {import('./pr-triage.js').EnrichedPullRequest[]}
 */
export function findNewlyActionablePrs(previousPrs, currentPrs, snoozedMap = {}, now = Date.now()) {
  const previousMap = new Map();
  if (Array.isArray(previousPrs)) {
    for (const prev of previousPrs) {
      if (prev && typeof prev.key === 'string') {
        previousMap.set(prev.key, prev);
      }
    }
  }

  if (!Array.isArray(currentPrs)) {
    return [];
  }

  return currentPrs.filter((pr) => {
    if (!pr || !pr.isYourTurn) {
      return false;
    }
    if (isPrSnoozed(pr, snoozedMap, now)) {
      return false;
    }
    const prev = previousMap.get(pr.key);
    return !(prev && prev.isYourTurn === true);
  });
}
