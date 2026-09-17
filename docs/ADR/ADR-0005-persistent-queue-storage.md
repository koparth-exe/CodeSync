# ADR-0005: Hybrid Persistent Queue Storage (storage.local + IndexedDB)

**Status:** Accepted (Amended & Hardened in Phase 0.1)  
**Date:** 2026-09-12 (Amended: 2026-09-13)  
**Deciders:** Architecture & Security Team

---

## Context
MV3 browser extension service workers are ephemeral and terminated after ~30 seconds of inactivity. If a submission is captured while offline or during high network latency, it must survive service worker termination, browser restarts, and operating system reboots.

The Phase 0 architecture initially designated `browser.storage.local` for all queue data. However, `browser.storage.local` has a strict **10 MB default quota** across all extension data and incurs full JSON serialization overhead on every read. Storing 200 source code payloads (up to 500 KB each) alongside sync history risks quota exhaustion and memory degradation.

---

## Decision
**Adopt a Hybrid Partitioned Storage & Two-Tier Concurrency Architecture:**
1. **`browser.storage.local`**: Stores lightweight metadata, configuration, auth credentials, persistent lease records (`QueueLeaseRecord`), and queue state indices (`QueueItemMetadata`).
2. **`IndexedDB` (`codesync_db`)**: Stores full source-code payloads (`QueueItemPayload`), large platform API responses, and long-term sync history.
3. **Write-Ahead Log (WAL)**: When enqueuing, the source payload is written to IndexedDB first, followed by the metadata record in `storage.local`.
4. **Two-Tier Concurrency Model**: Because `storage.local` does NOT provide atomic compare-and-swap (CAS), active runtime synchronization uses the native Web Locks API (`navigator.locks`), while cross-restart and crash recovery use a persistent heartbeat-backed lease record with a probe-and-verify protocol.

---

## Alternatives Considered

### A. `browser.storage.local` Only
- **Evaluated**: Storing full source code strings directly in the queue JSON array.
- **Rejected**: High risk of exhausting the 10 MB quota during prolonged offline periods or backfill operations; deserializing large JSON blobs causes service worker memory spikes.

### B. `IndexedDB` Only
- **Evaluated**: Storing all extension settings, auth state, and queue items exclusively in IndexedDB.
- **Rejected**: Slower startup time for reading small settings; `storage.local` provides simpler synchronous-like caching and cross-context reactive change listeners (`browser.storage.onChanged`).

### C. In-Memory Only
- **Evaluated**: Holding queue in service worker memory.
- **Rejected**: Fatal flaw. Service worker termination or browser closure results in permanent submission loss.

### D. Hybrid Partitioned Architecture (Selected)
- **Selected**: Combines the rapid, reactive metadata access of `storage.local` with the transactional capacity and disk-based scalability of `IndexedDB`.

---

## Consequences

### Positive:
- **Zero Quota Exhaustion**: Heavy source payloads cannot exhaust the 10 MB `storage.local` quota.
- **High Performance**: Ephemeral service worker starts up rapidly by deserializing only lightweight metadata.
- **Survives All Crashes**: Submissions persist across browser crashes, restarts, and service worker terminations.
- **Extensible**: Readily scales to future capabilities such as full submission history backfill.

### Negative / Trade-Offs:
- Requires managing two storage abstractions (`StorageService` and `PayloadStorage`).
- Enqueue sequence requires a two-phase write (IndexedDB payload write, followed by `storage.local` metadata write).
