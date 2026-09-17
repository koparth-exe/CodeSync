# Implementation Plan: Phase 1C.4.2.2 — Real Queue Item → GitHub Synchronization Handler Integration

Connect the durable queue ([`QueueDrainer`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/drainer.ts) and [`QueueManager`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/manager.ts)) to the existing transactional GitHub write service ([`GitHubContentsService`](file:///d:/Parth/Projects/CodeSync/src/shared/github/contents-service.ts)) via a typed, fail-closed queue synchronization handler.

---

## 1. Architectural Baseline & Rules

### Non-Negotiable Invariants
1. **Reuse Existing Approved Services**:
   - Call existing [`GitHubContentsService.synchronizeFile(...)`](file:///d:/Parth/Projects/CodeSync/src/shared/github/contents-service.ts#L60) without duplicating OCC, 409 conflict protocol, verification GET, content size limits, or duplicate policy logic.
   - Reuse [`DurableTokenLifecycleManager`](file:///d:/Parth/Projects/CodeSync/src/shared/auth/token-lifecycle.ts) and [`GitHubApiClient`](file:///d:/Parth/Projects/CodeSync/src/shared/github/client.ts) for coordinated 401 token refresh and request execution.
   - Reuse [`path-engine.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/github/path-engine.ts) for path validation and template resolution.
2. **Queue Lifecycle Ownership**:
   - [`QueueManager`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/manager.ts) remains the single authoritative owner of queue state, claiming, leases, Web Locks, fencing tokens, retry backoff, and poison-pill isolation.
   - The queue handler only returns a typed [`SyncResult`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/types.ts#L35-L48). It never mutates queue items directly.
3. **Queue Coordination**:
   - [`QueueDrainer`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/drainer.ts) coordinates drain triggers across submissions, startup, and alarms.
4. **TargetSnapshot Immutability**:
   - The `TargetSnapshot` captured at enqueue time is strictly preserved.
5. **Fail-Closed Security**:
   - Malformed payloads, hash mismatches, invalid path templates, or unauthorized states immediately return non-retryable attention results without calling GitHub.

---

## 2. Proposed Changes

### Queue Synchronization Handler
#### [NEW] [`src/shared/queue/github-handler.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/github-handler.ts)
Implement `GitHubQueueSyncHandler` and `createGitHubQueueItemHandler(options)`:
- **Input Validation**:
  - Validates `item.platform` against allowlisted platform IDs.
  - Validates `item.id`, `item.contentHash`, `item.validatedBy === "SERVICE_WORKER"`, and `item.sourceProvenance`.
  - Validates `payload.sourceCode` existence and byte size limit (`MAX_SOURCE_PAYLOAD_BYTES = 512_000`).
  - Re-computes SHA-256 content hash of `normalizeSourceCode(payload.sourceCode)` and asserts strict equality with `item.contentHash`. Fails closed if mismatched.
  - Validates `item.targetSnapshot`: validates `targetRepository` format (`owner/repo`), safe branch name, base folder syntax, and path template syntax.
- **Language & Path Resolution**:
  - Maps `item.language` to safe file extension using a deterministic mapping table (`cpp`, `py`, `java`, `ts`, `js`, `rs`, `go`, etc.).
  - Interpolates allowlisted template variables (`{platform}`, `{platform_lower}`, `{slug}`, `{title}`, `{problem_id}`, `{language}`, `{language_lower}`, `{extension}`, `{status}`, `{date}`, `{timestamp}`) if `pathTemplate` is specified via `resolvePathTemplate`.
  - Fallback default path: `${item.platform.toLowerCase()}/${item.problemSlug}.${extension}`.
  - Passes `baseFolder: targetSnapshot.basePath` to `GitHubContentsService.synchronizeFile` to enforce boundary containment.
- **Commit Message**:
  - Generates safe commit summary and sanitizes via `formatSafeCommitMessage(summary)`. Contains zero secrets or arbitrary page dumps.
- **GitHub Invocation**:
  - Calls `contentsService.synchronizeFile(writeOptions)`.
- **Result & Error Mapping**:
  - `created` / `updated` $\rightarrow$ `{ status: "completed", commitSha, commitUrl }`.
  - `skipped_identical` / `skipped_exists` $\rightarrow$ `{ status: "skipped" }`.
  - `requires_attention` $\rightarrow$ `{ status: "requires_attention", commitSha, error }`.
  - `GitHubRateLimitError` $\rightarrow$ `{ status: "failed", error: { retryable: true, resetTimestamp, retryAfterSeconds } }`.
  - `GitHubWriteOutcomeUnknownError` $\rightarrow$ `{ status: "requires_attention", error: { retryable: false } }`.
  - `GitHubAuthError` / terminal 401 $\rightarrow$ `{ status: "requires_attention", error: { retryable: false } }`.
  - `GitHubApiError(403)` / `404` $\rightarrow$ `{ status: "requires_attention", error: { retryable: false } }`.
  - `GitHubApiError(isRetryable)` $\rightarrow$ `{ status: "failed", error: { retryable: true } }`.
  - `PathSecurityError` / `PathTemplateError` $\rightarrow$ `{ status: "requires_attention", error: { retryable: false } }`.

#### [MODIFY] [`src/shared/queue/index.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/queue/index.ts)
Export `createGitHubQueueItemHandler`, `GitHubQueueSyncHandler`, and associated options.

---

### Background Service Worker Wiring
#### [MODIFY] [`src/entrypoints/background.ts`](file:///d:/Parth/Projects/CodeSync/src/entrypoints/background.ts)
- Construct trusted instances:
  - `GitHubApiClient` using `defaultGitHubAuthService.getLifecycleManager()`.
  - `GitHubContentsService({ client })`.
  - `realHandler = createGitHubQueueItemHandler({ contentsService, storage: defaultStorageService })`.
- Register the real handler with `defaultQueueDrainer`:
  - `defaultQueueDrainer.setHandler(realHandler)`.
- Existing triggers (`submission_event`, `startup`, `alarm`) now execute full end-to-end synchronization.

---

### Deterministic Test Suite
#### [NEW] [`tests/security/queue-github-handler.test.ts`](file:///d:/Parth/Projects/CodeSync/tests/security/queue-github-handler.test.ts)
Implement comprehensive tests covering `HANDLER-01` through `HANDLER-30`:
- **HANDLER-01**: Valid queued submission reaches QueueDrainer and invokes real handler.
- **HANDLER-02**: Handler builds GitHubWriteOptions correctly from TargetSnapshot.
- **HANDLER-03**: Correct repository/branch/path are passed to GitHubContentsService.
- **HANDLER-04**: Persisted submitted source is the exact content synchronized.
- **HANDLER-05**: Content hash is verified; mismatch fails closed with REQUIRES_ATTENTION.
- **HANDLER-06**: Source provenance is preserved across queue execution.
- **HANDLER-07**: `validatedBy: "SERVICE_WORKER"` invariant is verified.
- **HANDLER-08**: Distinct submission IDs with identical content are not collapsed.
- **HANDLER-09**: `CONFIGURED_UNVERIFIED` does not bypass GitHub authorization (verified via `getRepository`).
- **HANDLER-10**: `AUTHORIZED` uses existing authorization mechanism correctly.
- **HANDLER-11**: Malformed queue payload does not reach GitHub.
- **HANDLER-12**: Invalid target/path does not reach GitHub.
- **HANDLER-13**: Confirmed write success transitions queue item to `COMPLETED`.
- **HANDLER-14**: Retryable GitHub failure maps to `FAILED` and engages QueueManager retry backoff.
- **HANDLER-15**: Rate-limit reset/retryAfterSeconds reaches QueueManager.
- **HANDLER-16**: 401 error follows coordinated token refresh lifecycle.
- **HANDLER-17**: 403 authorization failure transitions to `REQUIRES_ATTENTION` without looping.
- **HANDLER-18**: 409 conflict invokes existing revalidation behavior.
- **HANDLER-19**: Uncertain write (`WRITE_OUTCOME_UNKNOWN`) transitions to `REQUIRES_ATTENTION` without blind PUT.
- **HANDLER-20**: Verification UNKNOWN is never converted to success.
- **HANDLER-21**: Confirmed verification preserves commit and file SHA metadata in history.
- **HANDLER-22**: Handler does not mutate `TargetSnapshot`.
- **HANDLER-23**: Handler does not directly mutate queue lifecycle state.
- **HANDLER-24**: Concurrent drain triggers do not duplicate processing.
- **HANDLER-25**: Stale worker cannot complete superseded queue item (fencing check).
- **HANDLER-26**: Service worker restart/crash recovery remains safe.
- **HANDLER-27**: Zero GitHub network calls for corrupted/invalid payload.
- **HANDLER-28**: Zero secrets in logs, commit messages, or diagnostics.
- **HANDLER-29**: Zero complete source code dumps in security diagnostics.
- **HANDLER-30**: Real handler is not directly callable from untrusted page or content script contexts.
- **Full E2E Test**: Enqueue $\rightarrow$ drain $\rightarrow$ handler $\rightarrow$ GitHubContentsService mock $\rightarrow$ confirmed `COMPLETED` queue item with history entry.

---

## 3. Verification Plan

### Automated Quality Gates
1. `npm run compile` (`tsc --noEmit`)
2. `npm run lint` (`eslint .`)
3. `npm run format:check` (`prettier --check`)
4. `npm test` (`vitest run`)
5. `npm run build` (Chrome MV3)
6. `npm run build:firefox` (Firefox MV3)

### Manual / Security Audit
- Verify manifest permissions remain strictly `["storage", "alarms"]`.
- Verify host permissions remain strictly `["https://github.com/*", "https://api.github.com/*"]`.
- Confirm zero network calls to live GitHub in automated tests.
