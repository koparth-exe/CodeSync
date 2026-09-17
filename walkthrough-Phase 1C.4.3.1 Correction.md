# Phase 1C.4.3.1 Correction: P2 Rate-Limit / Uncertain-Write Classification Hardening

## Overview
This targeted correction addresses the P2 classification issue identified in the Phase 1C.4.3.1 audit where an explicit HTTP 429 received during a `PUT` request was conflated with transport-level uncertainty.

## Root Cause & Surgical Correction
1. **Root Cause**: `GitHubRateLimitError` extends `GitHubApiError` with `isRetryable: true`. In `GitHubContentsService.createOrUpdateFile`, the catch block around `client.createOrUpdateFile` previously evaluated `if (err instanceof GitHubApiError && (err.isRetryable || ...))` before checking for rate limits. An explicit HTTP 429 on PUT was therefore caught as an uncertain write, executed unnecessary reconciliation GETs, and quarantined the item as `REQUIRES_ATTENTION` instead of scheduling a backoff retry.
2. **Correction**: Explicitly re-throw `GitHubRateLimitError` prior to uncertain-write handling in `src/shared/github/contents-service.ts`:
   ```typescript
   if (err instanceof GitHubRateLimitError) {
     throw err;
   }
   ```
   This ensures:
   - HTTP 429 bubbles to `GitHubQueueSyncHandler.handle` as `status: "failed"` with `retryable: true` and rate-limit metadata (`resetTimestamp`, `retryAfterSeconds`).
   - `QueueManager` calculates `effectiveDelay = max(backoffDelay, rateLimitDelay)` and updates `item.nextRetryAt`.
   - Genuine transport/network uncertainty during PUT continues to use the existing `reconcileUncertainWrite` path safely.

## Quality Gates Summary
- **Total Tests**: 461 passing across 35 test files (442 baseline + 14 initial E2E + 5 targeted correction tests).
- `npm test`: **PASSED** (0 failed, 0 skipped).
- `npm run compile`: **PASSED** (`tsc --noEmit` exited 0).
- `npm run lint`: **PASSED** (`eslint .` exited 0).
- `npm run format:check`: **PASSED** (Prettier check exited 0).
- `npm run build`: **PASSED** (Chrome MV3 production bundle built).
- `npm run build:firefox`: **PASSED** (Firefox MV3 production bundle built).
- `npx vitest run tests/security/pipeline-e2e.test.ts`: **PASSED** (19/19 tests in 129 ms).
