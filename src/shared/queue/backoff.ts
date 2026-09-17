export const BASE_DELAY_MS = 2000; // 2 seconds
export const MAX_DELAY_MS = 120_000; // 2 minutes
export const BACKOFF_FACTOR = 2;
export const JITTER_FRACTION = 0.2; // ±20% randomization

/**
 * Computes exponential backoff delay with ±20% jitter.
 * Prevents thundering herd problems during remote outages.
 *
 * @param attempt 1-indexed retry attempt number (>= 1)
 */
export function computeBackoffDelay(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const rawDelay = Math.min(
    BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, safeAttempt - 1),
    MAX_DELAY_MS,
  );
  const jitter =
    rawDelay * (Math.random() * 2 * JITTER_FRACTION - JITTER_FRACTION);
  return Math.max(0, Math.round(rawDelay + jitter));
}
