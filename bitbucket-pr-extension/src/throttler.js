import { THROTTLE_CONFIG } from './config.js';

/**
 * @typedef {Object} SyncGateDecision
 * @property {boolean} allowed
 * @property {'in_flight' | 'cooldown' | 'backoff'} [reason]
 * @property {number} [retryInMs]
 */

/**
 * Parse a `Retry-After` header value (seconds integer or HTTP-date) into milliseconds.
 *
 * @param {string | number | null | undefined} retryAfterHeader
 * @param {number} [now]
 * @returns {number | null}
 */
export function parseRetryAfterMs(retryAfterHeader, now = Date.now()) {
  if (retryAfterHeader === null || retryAfterHeader === undefined) {
    return null;
  }

  if (typeof retryAfterHeader === 'number') {
    if (!Number.isFinite(retryAfterHeader) || retryAfterHeader < 0) {
      return null;
    }
    return Math.min(Math.round(retryAfterHeader * 1000), THROTTLE_CONFIG.maxBackoffMs);
  }

  if (typeof retryAfterHeader !== 'string') {
    return null;
  }

  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.min(seconds * 1000, THROTTLE_CONFIG.maxBackoffMs);
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    const delta = Math.max(0, parsedDateMs - now);
    return Math.min(delta, THROTTLE_CONFIG.maxBackoffMs);
  }

  return null;
}

/**
 * Compute deterministic/jittered backoff duration in milliseconds.
 * Honors numeric or HTTP-date `Retry-After` header if valid; otherwise applies
 * exponential backoff with full/partial jitter capped at `THROTTLE_CONFIG.maxBackoffMs`.
 *
 * @param {number} consecutiveFailures
 * @param {string | number | null | undefined} [retryAfterHeader]
 * @param {() => number} [randomFn]
 * @param {number} [now]
 * @returns {number}
 */
export function computeBackoffMs(
  consecutiveFailures,
  retryAfterHeader = null,
  randomFn = Math.random,
  now = Date.now()
) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, now);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const failures = Math.max(1, Math.floor(Number.isFinite(consecutiveFailures) ? consecutiveFailures : 1));
  const exponent = Math.min(failures - 1, 10);
  const rawExponential = THROTTLE_CONFIG.baseBackoffMs * (2 ** exponent);
  const capped = Math.min(rawExponential, THROTTLE_CONFIG.maxBackoffMs);

  // Add +-20% jitter centered around 1.0 (0.8 .. 1.2) while preserving cap
  const rand = Math.min(1, Math.max(0, randomFn()));
  const jitterFactor = 0.8 + rand * 0.4;
  return Math.min(Math.round(capped * jitterFactor), THROTTLE_CONFIG.maxBackoffMs);
}

/**
 * Execute an array of items through a bounded concurrency pool while preserving result order.
 * Supports optional error isolation (`isolateErrors: true` returns `{ status: 'fulfilled', value }`
 * or `{ status: 'rejected', reason }`); by default (`isolateErrors: false`) rejects on first error.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} workerFn
 * @param {{ isolateErrors?: boolean }} [options]
 * @returns {Promise<R[]>}
 */
export async function runWithConcurrency(items, concurrency, workerFn, options = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.floor(concurrency));
  const isolateErrors = Boolean(options.isolateErrors);
  /** @type {any[]} */
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        const value = await workerFn(items[currentIndex], currentIndex);
        results[currentIndex] = isolateErrors ? { status: 'fulfilled', value } : value;
      } catch (err) {
        if (isolateErrors) {
          results[currentIndex] = { status: 'rejected', reason: err };
        } else {
          throw err;
        }
      }
    }
  }

  const poolSize = Math.min(limit, items.length);
  const workers = Array.from({ length: poolSize }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Error thrown when a fetch request exceeds its configured timeout.
 */
export class RequestTimeoutError extends Error {
  /**
   * @param {number} timeoutMs
   */
  constructor(timeoutMs) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
    /** @type {'TIMEOUT'} */
    this.code = 'TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Perform a `fetch` wrapped with an `AbortController` timeout.
 * Throws a clean `RequestTimeoutError` (`code: 'TIMEOUT'`) when aborted due to timeout.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(
  fetchFn,
  url,
  options = {},
  timeoutMs = THROTTLE_CONFIG.requestTimeoutMs
) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timerId = setTimeout(() => {
    timedOut = true;
    controller.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await fetchFn(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (timedOut) {
      throw new RequestTimeoutError(timeoutMs);
    }
    if (err instanceof RequestTimeoutError) {
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timerId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * Evaluate whether a sync request is permitted based on in-flight lock, manual cooldown, and backoff.
 * Note: `forceManual: true` bypasses `backoff` if the user explicitly clicks Refresh,
 * while still honoring `in_flight` deduplication and `cooldown`.
 *
 * @param {import('./storage.js').SyncState | null | undefined} syncState
 * @param {{ forceManual?: boolean, bypassCooldown?: boolean, now?: number }} [options]
 * @returns {SyncGateDecision}
 */
export function checkSyncGate(syncState, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const forceManual = Boolean(options.forceManual);
  const bypassCooldown = Boolean(options.bypassCooldown);
  const state = syncState ?? {
    inFlightSince: null,
    lastManualSyncAt: null,
    backoffUntil: null,
    consecutiveFailures: 0
  };

  if (typeof state.inFlightSince === 'number') {
    const elapsed = now - state.inFlightSince;
    if (elapsed >= 0 && elapsed < THROTTLE_CONFIG.syncLockTimeoutMs) {
      return {
        allowed: false,
        reason: 'in_flight',
        retryInMs: THROTTLE_CONFIG.syncLockTimeoutMs - elapsed
      };
    }
  }

  if (forceManual && !bypassCooldown && typeof state.lastManualSyncAt === 'number') {
    const sinceLastManual = now - state.lastManualSyncAt;
    if (sinceLastManual >= 0 && sinceLastManual < THROTTLE_CONFIG.manualRefreshCooldownMs) {
      return {
        allowed: false,
        reason: 'cooldown',
        retryInMs: THROTTLE_CONFIG.manualRefreshCooldownMs - sinceLastManual
      };
    }
  }

  if (!forceManual && typeof state.backoffUntil === 'number' && now < state.backoffUntil) {
    return {
      allowed: false,
      reason: 'backoff',
      retryInMs: state.backoffUntil - now
    };
  }

  return { allowed: true };
}
