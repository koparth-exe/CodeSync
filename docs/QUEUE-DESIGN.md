# Queue & Retry Architecture Specification
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Technical Architecture Specification

---

## 1. Storage Partitioning: Hybrid Architecture

To ensure high performance, prevent quota exhaustion, and eliminate memory bloat in MV3 ephemeral service workers, CodeSync adopts a **Hybrid Storage Architecture**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ HYBRID STORAGE PARTITIONING                                                  │
│                                                                             │
│  ┌─────────────────────────────────────┐  ┌──────────────────────────────┐  │
│  │ browser.storage.local               │  │ IndexedDB (Payload Storage)  │  │
│  │                                     │  │                              │  │
│  │ • Queue Metadata & State Indices    │  │ • Full Source Code Payloads  │  │
│  │ • Retry Counters & Backoff Timestamps│ │ • Large Platform Responses   │  │
│  │ • Distributed Lease Records         │  │ • Full Sync History Records  │  │
│  │ • User Settings & Auth Credentials  │  │ • Backfill Datasets (Future) │  │
│  │ • Small Repository / Branch Caches  │  │                              │  │
│  │                                     │  │ Storage Cap: Unlimited/Large │  │
│  │ Storage Cap: 10 MB Hard Limit       │  │ Transactional & Indexed      │  │
│  └─────────────────────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Rationale for Partitioning

1. **Quota Protection**: Storing 200 source code files (up to 500 KB each) in `browser.storage.local` would quickly hit the 10 MB extension quota and fail silently.
2. **Serialization Overhead**: `browser.storage.local` deserializes the entire JSON object on read. Reading queue metadata does not require deserializing megabytes of source code.
3. **Transactional Safety**: IndexedDB provides true transactional semantics for source code persistence, while `storage.local` enables lightweight cross-context state synchronization.

---

## 2. Queue State Machine & Write-Ahead Protocol (WAL)

### 2.1 State Transitions

```
                       ┌──────────────┐
                       │  [ENQUEUE]   │
                       └──────┬───────┘
                              │ Write-Ahead Persistence
                              ▼
                       ┌──────────────┐
                       │   PENDING    │◄─────────────────┐
                       └──────┬───────┘                  │
                              │ Acquire Lease            │ Retry (Backoff)
                              ▼                          │
                       ┌──────────────┐                  │
                 ┌─────│  PROCESSING  │─────┐            │
                 │     └──────────────┘     │            │
                 │                          │            │
           Write │                    Error │            │
         Success │                          │            │
                 ▼                          ▼            │
          ┌─────────────┐            ┌─────────────┐     │
          │  COMPLETED  │            │   FAILED    │─────┘
          └─────────────┘            └──────┬──────┘ (attempts < max)
                                            │
                                            │ Exhausted / Permanent Error / Poison Pill
                                            ▼
                                     ┌──────────────────────┐
                                     │  REQUIRES_ATTENTION  │
                                     └──────────────────────┘

         (Identical Content)
         ┌─────────────┐
         │   SKIPPED   │
         └─────────────┘
```

### 2.2 Write-Ahead Log (WAL) Enqueue Sequence

To guarantee zero submission loss even if the browser process crashes mid-operation, CodeSync executes a strict two-phase Write-Ahead Log:

```typescript
async function enqueueSubmission(raw: NormalizedSubmission): Promise<QueueItemMetadata> {
  const itemId = crypto.randomUUID();
  const payloadId = `payload:${itemId}`;

  // Phase 1: Persist Source Code Payload to IndexedDB
  await PayloadStorage.put(payloadId, {
    id: payloadId,
    sourceCode: raw.sourceCode,
    platformMetadata: raw.platformMetadata,
    createdAt: Date.now(),
  });

  // Phase 2: Persist Lightweight Queue Metadata to browser.storage.local
  const metadata: QueueItemMetadata = {
    id: itemId,
    payloadId,
    platform: raw.platform,
    problemSlug: raw.problemSlug,
    problemTitle: raw.problemTitle,
    targetRepository: raw.targetRepository,
    targetBranch: raw.targetBranch,
    language: raw.language,
    status: raw.status,
    state: QueueState.PENDING,
    attempts: 0,
    crashCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const queue = await StorageService.getQueueMetadata();
  queue.push(metadata);
  await StorageService.setQueueMetadata(queue);

  // Phase 3: Trigger Service Worker Drain Event
  QueueManager.triggerDrain();
  return metadata;
}
```

---

## 3. Concurrency Control & Robust Queue Lease Model

### 3.1 Concurrency Reality & Elimination of CAS Assumptions

> **Critical Architecture Invariant**:
> `browser.storage.local` **DOES NOT provide a native atomic compare-and-swap (CAS) primitive**, nor is it a multi-process mutex. Calling `storage.local.get` followed asynchronously by `storage.local.set` is inherently subject to race conditions if two execution contexts (e.g. an alarm wakeup and a content script submission event) execute simultaneously.
>
> Therefore, CodeSync adopts a **two-tier concurrency architecture**:
> 1. **Tier 1 (Execution Serialization via Web Locks API)**: The standard W3C Web Locks API (`navigator.locks.request`) provides native, browser-enforced mutually exclusive execution within the active browser session.
> 2. **Tier 2 (Persistent Storage Lease Protocol)**: A heartbeat-backed lease record stored in `browser.storage.local` provides cross-restart tracking, stale-lock reclamation, and worker death recovery.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: Native Web Locks API (Active Runtime Serialization)                  │
│ navigator.locks.request('codesync_queue_drain', { mode: 'exclusive' })      │
│ • Guarantees that only ONE execution context processes the queue at a time  │
│ • Free of read-modify-write races; enforced natively by Chromium and Gecko   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ TIER 2: Persistent Storage Lease Protocol (Cross-Restart & Crash Safety)    │
│ • Record: { workerId: UUID, acquiredAt: ms, expiresAt: ms }                 │
│ • Max lease duration: 30 seconds; Heartbeat renewal every 10 seconds        │
│ • Stale lease detection: Reclaimed if Date.now() > lease.expiresAt          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Persistent Storage Lease Specification

```typescript
export interface QueueLeaseRecord {
  readonly workerId: string;       // Unique UUID v4 for the worker instance
  readonly acquiredAt: number;     // Timestamp ms of acquisition
  expiresAt: number;               // Heartbeat expiry (acquiredAt + LEASE_TTL_MS)
  readonly triggerSource: 'alarm' | 'submission_event' | 'manual_retry' | 'startup';
}
```

#### Lease Configuration Parameters:
- `LEASE_TTL_MS`: **30,000 ms** (30 seconds). The maximum time a worker may hold a lease without a heartbeat.
- `HEARTBEAT_INTERVAL_MS`: **10,000 ms** (10 seconds). Active workers renew `expiresAt` during multi-item processing.
- `CONTENTION_BACKOFF_BASE_MS`: **100 ms** (with exponential factor 2 and ±50% jitter).

### 3.3 Two-Step Lease Probe Protocol (Non-CAS Mitigation)

When acquiring the persistent lease, workers follow a defensive **Probe-and-Verify** protocol:

1. **Check Existing Lease**: Read `codesync:queue:lease`.
   - If a lease exists and `Date.now() < lease.expiresAt`:
     - If `lease.workerId === this.workerId`, the worker already owns the lease; proceed.
     - Otherwise, the lease is actively held by another worker. **Yield immediately** with jittered backoff.
2. **Probe Lease Write**: If no active lease exists (or `Date.now() >= lease.expiresAt` indicating a stale lease):
   - Generate a fresh `workerId = crypto.randomUUID()`.
   - Write candidate lease `{ workerId, acquiredAt: Date.now(), expiresAt: Date.now() + 30000, triggerSource }`.
3. **Verification Read-Back**: Immediately perform a verification read of `codesync:queue:lease`:
   - If `verifiedLease.workerId === this.workerId`: **Lease acquired successfully**. Proceed into the processing loop under the Web Lock.
   - If `verifiedLease.workerId !== this.workerId`: A race collision occurred; another worker overwrote the candidate lease during the turn. **Yield and release claim immediately**. Back off before retrying.

### 3.4 Lease Heartbeat & Orderly Release

- **Heartbeat**: During batch operations, after each queue item completes, the worker updates `expiresAt = Date.now() + 30000`. If network operations stall, the lease auto-expires after 30 seconds, preventing indefinite lock retention.
- **Orderly Release**: Upon completing queue draining:
  ```typescript
  async function releaseLease(workerId: string): Promise<void> {
    const current = await StorageService.getLease();
    if (current && current.workerId === workerId) {
      await StorageService.removeLease();
    }
  }
  ```
  A worker **never** removes a lease belonging to another `workerId`.

### 3.5 Service Worker Suspension, Crash Recovery & Poison-Pill Isolation

When an ephemeral MV3 service worker is suspended or crashes during processing:
1. **Stale Lease Reclamation**: On the next wakeup (triggered by `browser.alarms` or a new submission), the new service worker inspects `codesync:queue:lease`. Because `Date.now() > lease.expiresAt`, the stale lease is ignored and reclaimed via the Probe-and-Verify sequence.
2. **Reconciliation of Interrupted Items**: The worker inspects all items in `codesync:queue:metadata`:
   - Any item stuck in `state === QueueState.PROCESSING` has its state reset to `PENDING`, and its `crashCount` incremented by 1.
   - **Poison-Pill Quarantine**: If `crashCount >= 3`:
     - The item is immediately quarantined to `REQUIRES_ATTENTION` with error code `POISON_PILL_DETECTED`.
     - The item is flagged with an error description: *"Item repeatedly caused service worker crashes; quarantined to protect queue availability."*
     - The queue drain continues processing subsequent healthy items, preventing infinite crash-restart loops.

---

## 4. Exponential Backoff & Retry Matrix

### 4.1 Jittered Exponential Backoff Formula

```typescript
function computeBackoffDelay(attempt: number): number {
  const baseDelayMs = 2000;      // 2 seconds
  const maxDelayMs = 120000;     // 2 minutes
  const backoffFactor = 2;
  const jitterFraction = 0.2;    // ±20% randomization

  const rawDelay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
  const jitter = rawDelay * (Math.random() * 2 * jitterFraction - jitterFraction);
  return Math.round(rawDelay + jitter);
}
```

### 4.2 Error Classification & Fail-Closed Actions

| Error Category | HTTP / System Codes | Retry Action | Final State on Exhaustion |
|---|---|---|---|
| **Transient Network** | Timeout, DNS failure, 0 offline | Retry with backoff (up to 5 attempts) | `REQUIRES_ATTENTION` |
| **GitHub Server 5xx** | 500, 502, 503, 504 | Retry with backoff (up to 5 attempts) | `REQUIRES_ATTENTION` |
| **Rate Limit** | 429, 403 (`X-RateLimit-Remaining: 0`) | Pause entire queue until `X-RateLimit-Reset` | Auto-resumes after reset |
| **SHA Conflict** | 409 Conflict | Execute **8-Step Conflict Protocol** (Re-fetch & revalidate; **NO blind retries**) | `REQUIRES_ATTENTION` (Manual Diff) |
| **Permanent Auth** | 401 Unauthorized, Bad Token | **Zero retries**. Immediate fail-closed. | `REQUIRES_ATTENTION` (Prompt Re-Auth) |
| **Access Forbidden** | 403 (insufficient repository scope) | **Zero retries**. Immediate fail-closed. | `REQUIRES_ATTENTION` |
| **Target Missing** | 404 (repo or branch deleted) | **Zero retries**. Immediate fail-closed. | `REQUIRES_ATTENTION` |
| **Invalid Path / Traversal** | 422, Canonicalization Failure | **Zero retries**. Immediate fail-closed. | `REQUIRES_ATTENTION` |
| **Poison Payload** | Service worker crash on parse | **Max 3 crashes**. Quarantined. | `REQUIRES_ATTENTION` |

---

## 5. Queue Limits & Overload Protection

| Parameter | Hard Limit | Rationale |
|---|---|---|
| **Maximum Pending Items** | 200 items | Prevents unbounded storage growth during prolonged offline periods. |
| **Maximum Payload Size** | 500 KB per source file | Prevents memory allocation crashes; competitive programming files rarely exceed 50 KB. |
| **Maximum Retention (Completed)** | 24 hours | Completed items are pruned from active queue to `SyncHistory` in IndexedDB. |
| **Maximum Attempts** | 5 attempts | Caps network overhead; alerts user rather than looping indefinitely. |

### 5.1 Queue Overflow Protocol

If the queue reaches 200 items:
1. New submissions are rejected if total storage is exhausted, raising `QUEUE_OVERFLOW_ERROR` to the content script.
2. Completed and skipped items are aggressively pruned first.
3. **Pending or failed items are NEVER dropped silently**. CodeSync alerts the user in the popup that manual queue drain is required.
