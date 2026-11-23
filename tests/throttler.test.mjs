import test from 'node:test';
import assert from 'node:assert/strict';

import { THROTTLE_CONFIG } from '../bitbucket-pr-extension/src/config.js';
import {
  RequestTimeoutError,
  checkSyncGate,
  computeBackoffMs,
  fetchWithTimeout,
  parseRetryAfterMs,
  runWithConcurrency
} from '../bitbucket-pr-extension/src/throttler.js';

test('parseRetryAfterMs supports numeric seconds, HTTP-dates, and caps at maxBackoffMs', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  assert.equal(parseRetryAfterMs('30', now), 30_000);
  assert.equal(parseRetryAfterMs(45, now), 45_000);
  assert.equal(parseRetryAfterMs('99999', now), THROTTLE_CONFIG.maxBackoffMs);

  const futureDate = new Date(now + 25_000).toUTCString();
  assert.equal(parseRetryAfterMs(futureDate, now), 25_000);

  const pastDate = new Date(now - 10_000).toUTCString();
  assert.equal(parseRetryAfterMs(pastDate, now), 0);

  assert.equal(parseRetryAfterMs('invalid-date', now), null);
  assert.equal(parseRetryAfterMs(null, now), null);
});

test('computeBackoffMs honors Retry-After header or uses exponential backoff with jitter capped at maxBackoffMs', () => {
  assert.equal(computeBackoffMs(3, '42', () => 0.5), 42_000);

  // Neutral jitter (randomFn() => 0.5 gives jitterFactor = 1.0)
  assert.equal(computeBackoffMs(1, null, () => 0.5), 15_000);
  assert.equal(computeBackoffMs(2, null, () => 0.5), 30_000);
  assert.equal(computeBackoffMs(3, null, () => 0.5), 60_000);

  // Min and max jitter bounds
  assert.equal(computeBackoffMs(1, null, () => 0), 12_000);
  assert.equal(computeBackoffMs(1, null, () => 1), 18_000);

  // Capped at maxBackoffMs even after many failures
  assert.equal(computeBackoffMs(20, null, () => 1), THROTTLE_CONFIG.maxBackoffMs);
});

test('runWithConcurrency bounds simultaneous workers and preserves output order', async () => {
  const items = [10, 20, 30, 40, 50, 60, 70];
  let active = 0;
  let maxActive = 0;

  const results = await runWithConcurrency(items, 3, async (item, index) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 2));
    active -= 1;
    return item * 2;
  });

  assert.ok(maxActive <= 3, `Expected maxActive <= 3, got ${maxActive}`);
  assert.equal(maxActive, 3);
  assert.deepEqual(results, [20, 40, 60, 80, 100, 120, 140]);
});

test('runWithConcurrency isolates errors when isolateErrors is enabled', async () => {
  const results = await runWithConcurrency(
    ['a', 'b', 'c'],
    2,
    async (item) => {
      if (item === 'b') {
        throw new Error('boom');
      }
      return item.toUpperCase();
    },
    { isolateErrors: true }
  );

  assert.deepEqual(results[0], { status: 'fulfilled', value: 'A' });
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'boom');
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'C' });
});

test('fetchWithTimeout rejects with RequestTimeoutError (code TIMEOUT) when fetch hangs', async () => {
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

  await assert.rejects(
    () => fetchWithTimeout(hangingFetch, 'https://api.bitbucket.org/2.0/user', {}, 15),
    (err) => err instanceof RequestTimeoutError && err.code === 'TIMEOUT'
  );
});

test('checkSyncGate enforces in_flight, manual cooldown, and backoff semantics', () => {
  const now = 1_000_000;

  // In-flight blocks both auto and manual sync while within syncLockTimeoutMs
  const inFlightState = {
    inFlightSince: now - 5_000,
    lastManualSyncAt: null,
    backoffUntil: null,
    consecutiveFailures: 0
  };
  assert.deepEqual(checkSyncGate(inFlightState, { forceManual: false, now }), {
    allowed: false,
    reason: 'in_flight',
    retryInMs: THROTTLE_CONFIG.syncLockTimeoutMs - 5_000
  });
  assert.deepEqual(checkSyncGate(inFlightState, { forceManual: true, now }), {
    allowed: false,
    reason: 'in_flight',
    retryInMs: THROTTLE_CONFIG.syncLockTimeoutMs - 5_000
  });

  // Stale in-flight lock past syncLockTimeoutMs self-heals
  const staleInFlightState = {
    inFlightSince: now - THROTTLE_CONFIG.syncLockTimeoutMs - 1,
    lastManualSyncAt: null,
    backoffUntil: null,
    consecutiveFailures: 0
  };
  assert.deepEqual(checkSyncGate(staleInFlightState, { forceManual: false, now }), { allowed: true });

  // Manual cooldown blocks rapid manual refreshes
  const cooldownState = {
    inFlightSince: null,
    lastManualSyncAt: now - 3_000,
    backoffUntil: null,
    consecutiveFailures: 0
  };
  assert.deepEqual(checkSyncGate(cooldownState, { forceManual: true, now }), {
    allowed: false,
    reason: 'cooldown',
    retryInMs: THROTTLE_CONFIG.manualRefreshCooldownMs - 3_000
  });
  // bypassCooldown permits internal scope-change syncs during cooldown while still honoring in_flight
  assert.deepEqual(checkSyncGate(cooldownState, { forceManual: true, bypassCooldown: true, now }), { allowed: true });
  assert.deepEqual(checkSyncGate(inFlightState, { forceManual: true, bypassCooldown: true, now }), {
    allowed: false,
    reason: 'in_flight',
    retryInMs: THROTTLE_CONFIG.syncLockTimeoutMs - 5_000
  });

  // Backoff blocks automatic polling, but forceManual bypasses backoff
  const backoffState = {
    inFlightSince: null,
    lastManualSyncAt: now - 60_000,
    backoffUntil: now + 20_000,
    consecutiveFailures: 2
  };
  assert.deepEqual(checkSyncGate(backoffState, { forceManual: false, now }), {
    allowed: false,
    reason: 'backoff',
    retryInMs: 20_000
  });
  assert.deepEqual(checkSyncGate(backoffState, { forceManual: true, now }), { allowed: true });
});
