# Phase 1C.4.1 Implementation Plan: Submission → Durable WAL/Queue Integration

## Goal Description

Integrate the approved Phase 1C.3 submission extraction pipeline with the approved Phase 1B.1 durable WAL-backed persistent queue. The output of this phase is an authoritatively validated, normalized, content-hashed, target-snapshotted, and reliably persisted `PENDING` queue item in hybrid storage (`IndexedDB` for payload, `browser.storage.local` for metadata) without any GitHub writes, queue draining, or external network side effects.

---

## User Review Required

> [!IMPORTANT]
> **Strict Out-of-Scope Boundary Enforcement**:
> - No queue draining or automatic synchronization to GitHub.
> - No GitHub API calls (`GET`, `PUT`, contents, verification, 409 handling, rate limits).
> - No new browser permissions (strictly preserving `["storage"]`, no `<all_urls>`, no `webRequest`, no `cookies`, no `tabs`).
> - No backend or telemetry.
> - No modification to existing Phase 1C.2.1 GitHub synchronization logic or Phase 1C.1 authentication flows.

> [!NOTE]
> **Authoritative Service Worker Boundary**:
> Webpages and content scripts are untrusted/semi-trusted. They CANNOT specify target repositories, target branches, path templates, or duplicate policies. The service worker is the sole authority that resolves the target snapshot from extension configuration and authorized repositories, validates it fail-closed, normalizes source code, and executes the intent-first Write-Ahead Log (WAL).

---

## Architecture & Data Flow

```
WEBPAGE (Untrusted DOM / Events)
  ↓
CONTENT SCRIPT (Semi-Trusted Context, In-Memory Deduplication)
  ↓
PLATFORM ADAPTER (LeetCode / CodeChef / Codeforces / GeeksforGeeks)
  ↓
CANONICAL SUBMISSION CANDIDATE (Typed Schema, Provenance Tag)
  ↓
TYPED EXTENSION MESSAGE (UUID v4 Nonce, Freshness Window, Anti-Replay)
  ↓
SERVICE WORKER (Authoritative Boundary)
  ↓
MESSAGE / SENDER AUTHORIZATION (Runtime Context Allowlist, Origin Cross-Check)
  ↓
DETERMINISTIC VALIDATION (Status === "ACCEPTED", Bounds, Schema Hygiene)
  ↓
SOURCE NORMALIZATION (Unicode NFKC, LF Newlines, Trailing Whitespace Stripped)
  ↓
CONTENT IDENTITY (SHA-256 Lowercase Hex Hash of Normalized Source)
  ↓
IMMUTABLE TARGET SNAPSHOT (Repository, Branch, Base Path, Duplicate Policy — Frozen)
  ↓
DUPLICATE ENQUEUE CHECK (Idempotent Match on Active Queue Items)
  ↓
DURABLE WAL INTENT (Persisted to IndexedDB wal_logs BEFORE Mutations)
  ↓
PAYLOAD PERSISTENCE (IndexedDB payloads Store, Enforcing 500 KB Limit)
  ↓
QUEUE METADATA PERSISTENCE (browser.storage.local codesync:queue:metadata, State: PENDING)
  ↓
WAL COMMITTED & PRUNED (Durable Intent Removed Upon Safe Completion)
```

---

## Proposed Changes

### Storage & Queue Models

#### [MODIFY] [types.ts](file:///d:/Parth/Projects/CodeSync/src/shared/storage/types.ts)
- Add `TargetSnapshot` contract:
  ```typescript
  export interface TargetSnapshot {
    readonly targetRepository: string; // e.g. "octocat/dsa-solutions"
    readonly targetBranch: string;     // e.g. "main"
    readonly basePath: string;         // e.g. "solutions"
    readonly duplicatePolicy: GitHubDuplicatePolicy | DuplicatePolicy;
    readonly pathTemplate?: string | undefined;
  }
  ```
- Augment `QueueItemMetadata` with:
  - `readonly targetSnapshot?: TargetSnapshot | undefined;`
  - `readonly submissionId?: string | undefined;`
  - `readonly sourceProvenance?: SourceProvenance | undefined;`

#### [MODIFY] [types.ts](file:///d:/Parth/Projects/CodeSync/src/shared/queue/types.ts)
- Re-export `TargetSnapshot` from `../storage/types`.
- Augment `NormalizedSubmission` with:
  - `readonly targetSnapshot?: TargetSnapshot | undefined;`
  - `readonly sourceProvenance?: SourceProvenance | undefined;`

---

### Configuration & Target Validation

#### [MODIFY] [schema.ts](file:///d:/Parth/Projects/CodeSync/src/shared/config/schema.ts)
- Add `readonly targetRepository?: string | undefined;` to `ExtensionConfig`.

#### [MODIFY] [index.ts](file:///d:/Parth/Projects/CodeSync/src/shared/config/index.ts)
- Export individual safe target validation primitives:
  - `validateRepositoryIdentity(repo: unknown): string`: Enforces `owner/name` syntax (`/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/`), length bounds (owner $\le 39$, repo $\le 100$), traversal (`..`) rejection, null-byte rejection, fail-closed.
  - `validateTargetBranch(branch: unknown): string`: Enforces CodeSync Safe Branch Grammar (`/^[a-zA-Z0-9._/-]+$/`), independent traversal (`..`) rejection, no null bytes, no leading/trailing slashes, no `\\`.
  - `validateBaseFolder(folder: unknown): string`: Enforces 5-pillar path defense (ASCII segments, DOS device checks, no traversal, no drive prefixes, no absolute root).
  - Update `validateConfig` to validate `targetRepository` when present.

---

### Queue Manager Hardening

#### [MODIFY] [manager.ts](file:///d:/Parth/Projects/CodeSync/src/shared/queue/manager.ts)
- In `enqueueSubmission`:
  - **Duplicate Enqueue Protection**: Before creating a WAL intent, inspect active queue items (`PENDING` or `PROCESSING`). If an item matches the same identity (`id` match, or `platform` + `problemSlug` + `contentHash`), return the existing metadata idempotently without adding duplicate work or writing unnecessary WAL logs.
  - **Target Snapshot Attachment**: Capture `raw.targetSnapshot` onto `QueueItemMetadata` and WAL intent snapshot, falling back to a synthesized snapshot from `targetRepository`/`targetBranch` for backwards compatibility with existing Phase 1B.1 test harnesses.
  - **WAL Preservation**: Preserve `targetSnapshot` during `reconcileWalAndOrphans` crash recovery.

---

### Service Worker Submission Pipeline

#### [MODIFY] [submission-handler.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/submission-handler.ts)
- Preserve existing synchronous `handleMessage(rawMessage, runtimeSender): IngestionResult` for 100% backwards compatibility with Phase 1C.3 unit tests.
- Add `async handleMessageAndEnqueue(rawMessage: unknown, runtimeSender?: RuntimeSenderInfo): Promise<SubmissionEnqueueResult>`:
  1. Envelope validation via `MessageEnvelopeValidator.validateEnvelope` (freshness $\le 30$s, UUID v4 nonce, anti-replay, `content-script` sender context).
  2. Tab URL origin cross-check (`validatePlatformOrigin`).
  3. Canonical submission schema validation (`validateCanonicalSubmission`).
  4. Acceptance gate: verify status is `"ACCEPTED"`. Non-accepted submissions are rejected.
  5. Source normalization via `normalizeSourceCode` (NFKC, LF line endings, stripped trailing whitespace, single trailing newline).
  6. Deterministic content hash via `computeContentHash(normalizedSource)`.
  7. Immutable target snapshot capture: resolve configuration from `codesync:config` and `codesync:auth`, validate repository identity, branch, base folder, duplicate policy, and freeze via `Object.freeze`.
  8. Enqueue to persistent queue via `QueueManager.enqueueSubmission`.
  9. Return `{ success: true, queueItem, candidate }`.

#### [MODIFY] [background.ts](file:///d:/Parth/Projects/CodeSync/src/entrypoints/background.ts)
- Update `browser.runtime.onMessage` listener for `SUBMISSION_DETECTED` to invoke `defaultSubmissionHandler.handleMessageAndEnqueue(...)` asynchronously and respond via `sendResponse`.

---

## Verification Plan

### Automated Tests
1. Run full test suite:
   ```bash
   npm test
   ```
2. Create comprehensive test suite `tests/security/submission-to-queue.test.ts` covering all 26 test requirements:
   - **Submission handoff**: valid canonical submission reaches service worker; valid submission becomes durable queue item; invalid candidate rejected; invalid provenance rejected; page-controlled provenance rejected; unauthorized sender context rejected.
   - **Normalization & Hashing**: equivalent line endings (CRLF vs LF vs CR) yield identical normalized code and contentHash; SHA-256 content hash is deterministic; oversized payload (>500KB) rejected fail-closed.
   - **Target snapshot**: target captured at enqueue; later config changes do not alter queued target; invalid target configuration rejected fail-closed.
   - **WAL crash boundaries & recovery**: intent persisted before payload write; payload failure leaves recoverable state; metadata failure leaves recoverable state; WAL replay idempotent; crash/restart recovery; orphan payload recovery (`RECOVERED_ORPHAN_PAYLOAD`); orphan metadata quarantine (`PAYLOAD_NOT_FOUND`).
   - **Duplicate enqueue protection**: duplicate submission event delivery does not create duplicate queue items.
   - **Concurrency & Fencing**: concurrent enqueue preserves queue consistency; existing fencing intact; stale worker rejected.
   - **Privacy**: queue metadata contains zero credentials; diagnostics contain zero raw source; errors do not leak raw source.
   - **Primary End-to-End Integration Test**: simulated platform submission $\to$ content script $\to$ service worker $\to$ validation $\to$ normalization $\to$ hash $\to$ immutable target snapshot $\to$ durable WAL $\to$ payload persistence $\to$ queue metadata $\to$ `PENDING`. Assert zero GitHub calls, zero credential leakage, exactly one queue item.

### Static Analysis & Quality Gates
- TypeScript typecheck: `npm run compile`
- ESLint: `npm run lint`
- Prettier: `npm run format:check`
- Chrome MV3 production build: `npm run build`
- Firefox MV3 production build: `npm run build:firefox`
- Manifest permission audit: confirm only `["storage"]`, no `<all_urls>`, no `webRequest`, no `cookies`, no `tabs`.
