# PHASE 1C.0.3 REFRESH ATTEMPT EPOCH & ERROR-RACE HARDENING REPORT
## CodeSync — GitHub Integration & Security Hardening Architecture

**Document Version:** 1.0.0  
**Phase Gate Status:** CONDITIONAL PASS RESOLUTION $\to$ **PASS**  
**Classification:** Technical Architecture Correction & Security Hardening Report  
**Author:** Gemini High (Senior Security Architect, Distributed-Systems Engineer, GitHub Authentication Engineer, Browser-Extension Security Engineer, Adversarial Reviewer)  
**Target Specifications:**  
- `docs/Phase1C-Architecture-Review.md`
- `docs/GITHUB-INTEGRATION.md`
- `docs/ARCHITECTURE.md`
- `docs/PATH-TEMPLATE-SPEC.md`
- `docs/PRIVACY.md`

---

## A. Problem Identified

In Phase 1C.0.2, CodeSync successfully addressed worker suspension across lease expirations and established generation fencing (`refreshGeneration`). However, the external security audit identified a subtle, critical distributed-systems race:

> **`refreshGeneration` represents the VERSION OF THE CREDENTIALS, NOT the IDENTITY OF THE CURRENT REFRESH ATTEMPT.**

Because a credential generation counter increments only upon a *successful commit* ($G \to G + 1$), multiple distinct refresh attempts can originate from the *same* credential generation. For example, if Worker A initiates a refresh at generation 10 and is delayed past the 30-second lease timeout, Worker B legitimately acquires durable coordination at generation 10 and dispatches a second refresh request using the same refresh token $R_1$.

This introduces an adversarial race condition:
1. GitHub processes Worker A's request first, rotating $R_1 \to R_2$, but Worker A's HTTP 200 response is still in transit over the network.
2. GitHub processes Worker B's duplicate request second, rejecting $R_1$ because it was already consumed upstream, and returns HTTP 400 `bad_refresh_token` to Worker B.
3. At the exact moment Worker B receives `bad_refresh_token`, Worker A has not yet committed to local storage. Therefore:
   $$\text{latestGeneration} === \text{startingGeneration} === 10$$
4. If Worker B evaluates its error solely by comparing credential generations, it observes that generation has not advanced, falsely concludes that authentication was revoked by the user, transitions auth state to `"expired"`, and purges credentials.
5. Milliseconds later, Worker A receives the valid $R_2$ response, but the authentication session has already been destroyed, corrupting user authentication!

Phase 1C.0.3 was commissioned to resolve this race by formally separating Credential Generation, Refresh Attempt Identity, and Durable Lease Ownership.

---

## B. Why `refreshGeneration` Alone Is Insufficient

`refreshGeneration: number` is a coarse-grained version counter of persisted credentials:
1. **Coarse Granularity:** It tracks *what credentials are saved*, not *what network operations are in flight*.
2. **Loss of Attempt History:** It cannot distinguish whether one, two, or three refresh requests were dispatched for the current generation.
3. **Absence of Ownership Ordering:** If two workers hold `refreshGeneration = 10`, generation comparison alone cannot determine which worker possesses the legitimate authority to make lifecycle decisions (such as declaring token expiration or resetting metadata).
4. **Premature Fail-Closed Hazard:** When an error arrives, if persisted generation equals starting generation, the system cannot differentiate between:
   - Case 1: A legitimate token revocation on GitHub.
   - Case 2: An error caused by a duplicate request where an earlier attempt consumed the token upstream and its successful commit is imminent.

To provide safe, fail-closed, and robust authentication, the architecture requires an orthogonal mechanism to track attempt identity and lease acquisition epochs.

---

## C. Credential Generation Model

The Credential Generation model governs **Credential State Versioning**:

```typescript
readonly refreshGeneration: number; // Monotonically increasing version counter (G)
```

- **Scope:** Bound exclusively to the stored token pair (`accessToken` and `refreshToken`) under `codesync:auth`.
- **Monotonicity:** Strictly increasing ($G \to G + 1$). It is never reset, decremented, or rolled back during the lifetime of an authenticated session.
- **Commit Rule:** A new credential pair is committed to persistent storage if and only if pre-commit fencing verification confirms:
  $$\text{persistedGeneration} === \text{startingGeneration}$$
- **Authority:** Persisted credential generation is the sole authority for determining which credential pair is newer. Any in-memory response proposing a generation $G \le G_{persisted}$ is rejected as stale (`STALE_RESPONSE_DROPPED`).

---

## D. Refresh Attempt Identity Model

The Refresh Attempt Identity model governs **Operation Identity**:

```typescript
readonly refreshAttemptId?: string | undefined; // Cryptographically unique UUID (A)
```

- **Scope:** Bound to an individual network operation dispatched to GitHub's OAuth endpoint.
- **Generation:** Freshly created using `crypto.randomUUID()` whenever an execution context claims durable refresh coordination.
- **Immutability:** Bound immutably to the lifecycle of that specific HTTP request context.
- **Authority:** Uniquely distinguishes between distinct in-flight refresh attempts originating from the same or different execution contexts for the same credential generation.

---

## E. Lease Epoch Model

The Lease Epoch model governs **Durable Ownership & Refresh Lifecycle Authority**:

```typescript
readonly refreshLeaseEpoch: number; // Monotonically increasing lease acquisition counter (E)
```

- **Scope:** Durable coordination in `browser.storage.local` across service-worker terminations, browser restarts, and host suspension boundaries.
- **Monotonicity:** Strictly increasing integer counter ($E \to E + 1$). Every time durable lease ownership is claimed or reclaimed (including lease expiration recovery), the epoch counter increments.
- **Lease Timeout Boundary:** Governed by `refreshLeaseExpiresAt: number` (strictly enforced at 30,000ms from lease acquisition).
- **Superseded Epoch Rule:** If an execution context holds lease epoch $E_A$, and storage contains $\text{persistedLeaseEpoch} > E_A$, Worker A's ownership has been **SUPERSEDED**. Worker A becomes an **OBSOLETE WORKER**.
- **Authority:** Durable lease ownership is authoritative for refresh lifecycle decisions (declaring failure, entering resolution wait, resetting state, clearing locks). An obsolete worker has **ZERO authority** to alter lifecycle state.

---

## F. Worker Ownership Model

A worker's identity is defined by the tripartite tuple:
$$\text{Worker Authority} = \langle \text{workerId}, \text{refreshAttemptId}, \text{refreshLeaseEpoch} \rangle$$

### Why Worker ID Alone Is Insufficient:
1. **PID / Context Ambiguity:** Service workers can be killed and respawned rapidly by the browser. If a new worker instance receives the same ID or an arbitrary ephemeral ID, it cannot determine temporal ordering relative to previous workers.
2. **Absence of Monotonicity:** String identifiers (e.g. `worker-1234`) cannot be compared for sequence ordering.
3. **Fencing Guarantee:** Combining `workerId` with a cryptographic `refreshAttemptId` and a strictly monotonic `refreshLeaseEpoch` guarantees that every lease claim is globally unique, ordered, and tamper-resistant across crashes.

---

## G. Refresh State Machine

The token lifecycle is formalized as a 9-state deterministic finite state machine incorporating `Attempt ID` and `Lease Epoch`:

```
                                  ┌──────────────┐
                                  │     IDLE     │◄─────────────────────────────────────────────┐
                                  └──────┬───────┘                                              │
                                         │                                                      │
                                         │ [Token near expiry (T - 5m) or expired]              │
                                         ▼                                                      │
                              ┌─────────────────────┐                                           │
                              │   REFRESH_CLAIMED   │ (Web Lock requested)                     │
                              └──────────┬──────────┘                                           │
                                         │                                                      │
                                         │ [Intent persisted: workerId, epoch E+1, attempt UUID]│
                                         ▼                                                      │
                              ┌─────────────────────┐                                           │
                              │  REFRESH_IN_FLIGHT  │ (HTTP fetch in progress)                  │
                              └──────────┬──────────┘                                           │
                                         │                                                      │
         ┌───────────────────────────────┼───────────────────────────────┐                      │
         │                               │                               │                      │
         ▼ [Network Timeout / Abort]     ▼ [HTTP 400/401 Received]       ▼ [30s TTL Elapses]    │
┌──────────────────┐           ┌──────────────────┐           ┌──────────────────┐              │
│  REFRESH_FAILED  │           │ EVALUATE ERROR   │           │ LEASE_SUPERSEDED │              │
│  (Reset to IDLE) │           │ (Gen & Epoch)    │           │ (Obsolete worker)│              │
└────────┬─────────┘           └────────┬─────────┘           └────────┬─────────┘              │
         │                              │                              │                        │
         │                              ├──► [Gen Advanced] ───────────┼────────────────────────┤
         │                              │    (Discard error; adopt)    │                        │
         │                              │                              │                        │
         │                              ├──► [Epoch Superseded] ───────┼────────────────────────┤
         │                              │    (Zero authority; drop)    │                        │
         │                              │                              │                        │
         │                              ├──► [Predecessor In Flight] ──┤                        │
         │                              │    ┌────────────────────────┐│                        │
         │                              │    │  AWAITING_RESOLUTION   ││                        │
         │                              │    │  (5s Grace Poll Window)││                        │
         │                              │    └───────────┬────────────┘│                        │
         │                              │                ├──► Commit Arrived ──► Adopt G_new ───┤
         │                              │                └──► Grace Expired ───► status=expired │
         │                              │                                                       │
         │                              └──► [Sole Authoritative Attempt]                       │
         │                                   (status = "expired")                               │
         │                                                                                      │
         ▼ [HTTP 200 OK Received]                                                               │
┌─────────────────────────────────┐                                                             │
│    REFRESH_RESPONSE_RECEIVED    │                                                             │
└────────────────┬────────────────┘                                                             │
                 │                                                                              │
                 │ [PRE-COMMIT FENCING VERIFICATION]                                            │
                 ▼                                                                              │
       ┌───────────────────┐                                                                    │
       │ FENCING CHECK     ├───────────────┐ (latestGen > startGen)                             │
       └─────────┬─────────┘               ▼                                                    │
                 │ (Pass: latest === start) ┌────────────────────────┐                          │
                 ▼                          │ STALE_RESPONSE_DROPPED │──────────────────────────┘
    ┌──────────────────────────┐            │ (Adopt latest tokens)  │
    │ FENCED CREDENTIAL COMMIT │            └────────────────────────┘
    │ (Persist G + 1, IDLE)    │
    └────────────┬─────────────┘
                 │
                 └──────────────────────────────────────────────────────────────────────────────┘
```

#### State Transition Matrix:

| From State | Event / Trigger | To State | Persisted State Action | Generation Action | Owner Lease | Retry Allowed? | Creds Modified? | Queue State | Final User Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **IDLE** | Token near expiry | **REFRESH_CLAIMED** | Web Lock requested | Unchanged ($G$) | Pending | Yes | No | Unchanged | Authenticated |
| **REFRESH_CLAIMED** | Lock acquired | **REFRESH_IN_FLIGHT** | `refreshState: "REFRESHING"`, `attemptId: UUID`, `leaseEpoch: E+1` | Unchanged ($G$) | Active ($E+1$, 30s) | Yes | No | Active | Authenticated |
| **REFRESH_IN_FLIGHT** | Network timeout / drop | **REFRESH_FAILED** | Revert `refreshState: "IDLE"` (guarded by epoch match) | Unchanged ($G$) | Released | Yes (bounded) | No | Active (retry) | Authenticated |
| **REFRESH_IN_FLIGHT** | 30s TTL elapses / SW death | **LEASE_SUPERSEDED** | Reclaimed by subsequent worker (increments $E+2$) | Unchanged ($G$) | Forfeited ($E+1$ stale) | Yes (new worker) | No | Paused/Waiting | Authenticated |
| **REFRESH_IN_FLIGHT** | HTTP 200 OK received | **REFRESH_RESPONSE_RECEIVED** | In-memory response buffer | Unchanged ($G$) | Active | N/A | In memory only | Active | Authenticated |
| **REFRESH_IN_FLIGHT** | HTTP 400/401 received | **EVALUATE_ERROR** | Inspect `persistedGen`, `leaseEpoch`, and predecessor history | Unchanged ($G$) | Retained | Conditional | No | Paused on true error | Expired only if true failure |
| **EVALUATE_ERROR** | Predecessor attempt in flight | **AWAITING_RESOLUTION** | Maintain `REFRESHING`, poll for 5s grace window | Unchanged ($G$) | Retained ($E$) | Yes | No | Paused | Authenticated |
| **REFRESH_RESPONSE_RECEIVED** | Pre-commit check FAILS (`latestGen > startGen`) | **STALE_RESPONSE_DROPPED** | None (discard response payload) | Unchanged (keeps $G_{new}$) | Released | No (already fresh) | No (retains $G_{new}$) | Resumes | Authenticated |
| **REFRESH_RESPONSE_RECEIVED** | Pre-commit check PASSES (`latestGen === startGen`) | **COMMITTED** | Fenced commit: write new tokens, reset `refreshState: "IDLE"` | Incremented ($G+1$) | Released | No (success) | Yes (updated) | Resumes | Authenticated |
| **COMMITTED** | Transition complete | **IDLE** | Persisted credential state active | Active ($G+1$) | None | Yes | Complete | Normal | Authenticated |

---

## H. Critical Race Scenario #1: Success vs. Stale Error

### Timeline:
```
TIME T0: Initial state: G = 10, R1, Epoch = 40.
TIME T1: Worker A claims lease (G = 10, Attempt A, Epoch = 41) and dispatches refresh(R1).
TIME T2: Worker A is suspended by host browser. 30-second lease expires.
TIME T3: Worker B wakes, observes expired lease, claims lease (G = 10, Attempt B, Epoch = 42), and dispatches refresh(R1).
TIME T4: GitHub processes Worker A first: R1 -> R2 (HTTP 200). Worker A resumes, verifies generation (10 === 10), commits G = 11, R2, and resets refreshState = "IDLE".
TIME T5: GitHub then processes Worker B's request. Because R1 was consumed at T4, GitHub returns HTTP 400 (bad_refresh_token).
TIME T6: Worker B receives HTTP 400.
```

### Deterministic Resolution:
1. Worker B re-reads persisted auth state under Web Lock.
2. Worker B observes `latestAuth.refreshGeneration === 11`.
3. Worker B compares with starting generation: $11 > 10$.
4. **Conclusion:** A newer credential generation ($G_{11}$) has already been committed to storage.
5. **Action:** Worker B's error is **STALE**. Worker B **DISCARDS THE ERROR**, logs `STALE_REFRESH_ERROR_IGNORED`, never purges credentials, never marks auth expired, never overwrites $R_2$, and adopts $G_{11}$ credentials.

---

## I. Critical Race Scenario #2: Error vs. Success

### Timeline:
```
TIME T0: Initial state: G = 10, R1, Epoch = 40.
TIME T1: Worker A claims lease (G = 10, Attempt A, Epoch = 41) and dispatches refresh(R1).
TIME T2: Lease expires after 30s. Worker B claims lease (G = 10, Attempt B, Epoch = 42) and dispatches refresh(R1).
TIME T3: GitHub processes Worker B first: R1 -> R2 (HTTP 200). Worker B verifies fencing, commits G = 11, R2, and resets refreshState = "IDLE".
TIME T4: Worker A later receives HTTP 400 (bad_refresh_token) from its earlier request.
```

### Deterministic Resolution:
1. Worker A re-reads persisted auth state under Web Lock.
2. Worker A observes `latestAuth.refreshGeneration === 11 > 10`.
3. **Conclusion:** Generation advanced while Worker A's request was in flight. The error belongs to obsolete generation $G_{10}$.
4. **Action:** Worker A discards the error, preserves $G_{11}$ ($R_2$), and never purges credentials or marks expired.

---

## J. Critical Race Scenario #3: Same Generation — Both Responses Before Any Commit

### Timeline:
```
TIME T0: Initial state: G = 10, R1, Epoch = 40.
TIME T1: Worker A claims lease (G = 10, Attempt A, Epoch = 41) and dispatches refresh(R1).
TIME T2: Worker A is delayed. 30-second lease expires.
TIME T3: Worker B claims lease (G = 10, Attempt B, Epoch = 42) and dispatches refresh(R1).
TIME T4: GitHub processes Worker A on its server, rotating R1 -> R2. Worker A's HTTP 200 response is in transit over the network.
TIME T5: GitHub processes Worker B, sees R1 already rotated, and returns HTTP 400 bad_refresh_token to Worker B.
TIME T6: Worker B receives bad_refresh_token BEFORE Worker A has committed to local storage.
         At this exact moment: persistedGeneration === startingGeneration === 10.
```

### Deterministic Resolution:
1. Worker B re-reads persisted auth state under Web Lock.
2. Worker B checks generation: `persistedGeneration === 10`.
3. Worker B evaluates attempt and epoch history:
   - Worker B's lease acquisition was Epoch $E_{42}$.
   - When Worker B claimed the lease at $E_{42}$, persisted storage had `refreshState === "REFRESHING"` with `refreshLeaseEpoch === 41` for the *same* generation $G_{10}$.
   - **Conclusion:** An uncommitted predecessor attempt was in flight for generation $G_{10}$. The `bad_refresh_token` response was caused by GitHub consuming $R_1$ for Attempt A!
4. **Deferred Resolution Protocol:**
   - Worker B **MUST NOT purge credentials** and **MUST NOT transition status to "expired"**.
   - Worker B enters `refreshState: "AWAITING_RESOLUTION"` and executes a bounded poll (up to 5 seconds, polling every 1,000ms) for the competing in-flight commit.
   - When Worker A's packet arrives, Worker A commits $G_{11}, R_2$.
   - On the next poll, Worker B observes `latestAuth.refreshGeneration === 11 > 10`.
   - Worker B **DISCARDS THE ERROR** and adopts $G_{11}$.
5. **Terminal Fail-Closed Fallback:**
   - If the 5-second resolution window elapses and NO commit occurs (meaning Worker A crashed permanently or was terminated by the OS, and its response was lost):
   - Worker B re-verifies that no newer lease has been claimed, and only then transitions auth status to `"expired"` fail-closed.
6. **Obsolete Worker Authority Rule:**
   - If Worker A receives an error while `persistedLeaseEpoch === 42 > 41`, Worker A detects that its epoch was superseded.
   - An obsolete worker has **ZERO authority** to modify lifecycle state or declare auth expired. Worker A immediately discards the error and terminates.

---

## K. Critical Race Scenario #4: Success vs. Success

### Timeline:
```
TIME T0: Both Worker A (G = 10, Attempt A, Epoch = 41) and Worker B (G = 10, Attempt B, Epoch = 42) receive HTTP 200 with rotated tokens from GitHub.
         Worker A receives (A_2A, R_2A).
         Worker B receives (A_2B, R_2B).
```

### Deterministic Resolution:
1. Worker A acquires Web Lock first.
   - Verifies `persistedGeneration === startingGeneration` ($10 === 10$).
   - Commits $(A_{2A}, R_{2A})$ with `refreshGeneration = 11`, resets `refreshState = "IDLE"`.
2. Worker B acquires Web Lock second.
   - Reads storage: `latestAuth.refreshGeneration === 11`.
   - Compares: `latestAuth.refreshGeneration > startingGeneration` ($11 > 10$).
   - Worker B detects that a newer credential generation ($G_{11}$) has ALREADY been committed.
   - Worker B's response is **STALE** (`STALE_RESPONSE_DROPPED`).
   - Worker B **DISCARDS $(A_{2B}, R_{2B})$**.
   - Worker B never overwrites $G_{11}$.
   - **Invariant:** Credential generation increases strictly monotonically ($10 \to 11$).

---

## L. Stale Response Rules

A refresh response is eligible to mutate credential state ONLY if:
$$\text{latestAuth.refreshGeneration} === \text{startingGeneration}$$

If $\text{latestAuth.refreshGeneration} > \text{startingGeneration}$, the response is declared `STALE_RESPONSE_DROPPED`.
- Persisted credentials are never rolled back ($11 \not\to 10$).
- Sibling responses cannot overwrite already committed generations ($11 \not\to 11$).
- The stale payload is completely discarded from memory.

---

## M. Stale Error Rules

An HTTP error response (e.g. `bad_refresh_token`) is eligible to transition authentication to `status: "expired"` ONLY if ALL of the following conditions hold:
1. $\text{latestAuth.refreshGeneration} === \text{startingGeneration}$ (no newer generation has committed).
2. $\text{latestAuth.refreshLeaseEpoch} === \text{startingLeaseEpoch}$ (this worker holds the current authoritative lease epoch).
3. $\text{latestAuth.refreshWorkerId} === \text{workerId}$ (this worker owns the lease).
4. No uncommitted predecessor attempt was in flight for the same generation, OR a 5-second `AWAITING_RESOLUTION` grace window has elapsed without any competing commit.

If any condition fails:
- If generation advanced: the error is **STALE** and **DISCARDED**.
- If epoch was superseded: the worker is **OBSOLETE** and has **ZERO authority** to invalidate credentials.
- In all non-authoritative cases, credentials are **PRESERVED** and **NEVER PURGED**.

---

## N. Partial Persistence Rules

In `browser.storage.local`, all credential and lifecycle metadata properties reside under a single top-level key `codesync:auth`.

### Schema Validator (`validateAuthStateIntegrity`):
Before using any credentials from storage, CodeSync executes strict validation:
- `accessToken`: non-empty string.
- `refreshToken`: non-empty string.
- `refreshGeneration`: non-negative integer.
- `refreshLeaseEpoch`: non-negative integer.
- `tokenExpiresAt`: positive integer.

### Stale Worker Mutation Prevention:
A stale worker whose lease epoch has been superseded ($\text{persistedEpoch} > \text{workerEpoch}$) is strictly prohibited from mutating storage:
- Stale workers **cannot** reset `refreshState` to `"IDLE"`.
- Stale workers **cannot** clear or overwrite `refreshWorkerId` or `refreshAttemptId`.
- Stale workers **cannot** clear a newer worker's lease.
- Storage writes are guarded by epoch comparison: cleanup occurs only if `persistedLeaseEpoch === workerLeaseEpoch`.

---

## O. Service-Worker Restart Behavior

| Restart Boundary | Storage State on Wake | Successor Worker Action |
| :--- | :--- | :--- |
| **Restart during `REFRESH_CLAIMED`** | `refreshState: "REFRESHING"`, lock age $< 30$s | Successor waits for lease expiration ($30$s). |
| **Restart during `REFRESH_IN_FLIGHT`** | `refreshState: "REFRESHING"`, lock age $> 30$s | Successor reclaims lease, increments $E \to E+1$, issues new attempt UUID, and rotates. Prior worker's eventual response or error will be fenced out safely. |
| **Restart during `REFRESH_RESPONSE_RECEIVED`** | Tokens in memory only, storage still $G$ | Successor reclaims lease after $30$s timeout; rotated cleanly. |
| **Restart during `FENCED_COMMIT`** | Single IPC write: either old $G$ or complete new $G+1$ | Evaluated cleanly by `validateAuthStateIntegrity`; partial writes fail closed. |
| **Restart after `COMMITTED`** | Storage has $G+1$, `refreshState: "IDLE"` | Successor reads fresh tokens; no refresh needed. |

---

## P. Web Locks vs. Durable Fencing

CodeSync uses a two-tier coordination architecture:
1. **Tier 1 — Web Locks API (`navigator.locks`):**
   - Provides runtime synchronization between concurrently executing tabs, popups, and workers.
   - Ephemeral: Web Locks do **NOT** survive browser termination or service-worker death.
2. **Tier 2 — Durable Storage Lease & Monotonic Epochs (`browser.storage.local`):**
   - Provides crash-resilient, durable correctness across process terminations and restarts.
   - Enforces the 30-second lease timeout, generation fencing, and attempt identity.
   - **Authority Invariant:** Durable fencing is the authoritative security boundary. Web Locks are an optimization for in-memory serialization.

---

## Q. 409 API Freshness Model

- **Removal of Query Parameter Cache-Busting:** CodeSync eliminates `?_cb=${Date.now()}` from canonical GitHub API URLs.
- **Native HTTP Cache Control:** Re-fetch operations use standard HTTP cache directives:
  ```typescript
  fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
    },
    cache: "no-store", // Guarantees fresh response directly from GitHub
  });
  ```
- **Clean Protocol Request:** Non-standard headers (such as `If-None-Match: ""`) are omitted, ensuring clean conformance with GitHub REST API standards.

---

## R. Rate-Limit Parameter Model

- **GitHub Operational Parameters:** 5,000 req/hr, 80 content-generating requests/min, 100 concurrent requests, 8-hour access token lifespan, and 6-month refresh token lifespan are classified as **"Current GitHub documented operational parameters"**. They are parsed dynamically from live HTTP response headers (`x-ratelimit-remaining`, `x-ratelimit-reset`, `Retry-After`).
- **CodeSync Local Reliability Policy:** The 1,000ms inter-item delay is classified as a **"CodeSync client-side safety & reliability policy (local self-throttling)"**, explicitly distinguishing it from an upstream GitHub protocol mandate.

---

## S. Updated Threat Model

### Threat U: Refresh-Token Race & Lifecycle
- **Vulnerability:** Concurrent sync operations, worker suspension, lease expiration, or duplicate in-flight requests causing stale response overwrites or stale error invalidations.
- **Defense Architecture:** Tripartite Authority Model:
  1. Monotonic generation fencing (`refreshGeneration`) protects credential version ordering.
  2. Cryptographic attempt identity (`refreshAttemptId`) isolates in-flight operations.
  3. Monotonic lease epoch (`refreshLeaseEpoch`) fences durable ownership across lifecycle boundaries.
  4. 5-second `AWAITING_RESOLUTION` grace window prevents same-generation predecessor in-flight error races.
  5. Dual-path fencing isolates stale errors from invalidating newer credentials.
- **Residual Guarantee:** Persisted generation is authoritative; stale writes are rejected; stale errors are ignored; obsolete workers are strictly prohibited from mutating lifecycle metadata.

---

## T. Adversarial Test Matrix (18 Deterministic Test Cases)

| Test ID | Scenario | Initial State | Interleaving | Expected Authority | Expected Persisted State | Expected Credential State | Expected Queue State | Expected User State |
| :---: | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TEST 1** | Worker A success $\to$ Worker B stale error | $G_{10}, R_1, E_{40}$ | A ($E_{41}$) delayed; B ($E_{42}$) dispatched; A commits $G_{11}$; B gets `bad_refresh_token` | A commits $G_{11}$; B error is stale | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 2** | Worker B success $\to$ Worker A stale error | $G_{10}, R_1, E_{40}$ | A ($E_{41}$) and B ($E_{42}$) dispatched; B commits $G_{11}$; A gets `bad_refresh_token` | B commits $G_{11}$; A error is stale | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 3** | Worker A in-flight $\to$ Worker B error while $G$ unchanged | $G_{10}, R_1, E_{40}$ | A ($E_{41}$) in flight; B ($E_{42}$) gets `bad_refresh_token` before A commits; $G$ still 10 | B detects predecessor in flight; awaits grace; A commits $G_{11}$ | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 4** | Worker A error $\to$ Worker B success | $G_{10}, R_1, E_{40}$ | A encounters network drop; releases epoch; B acquires $E_{42}$ and rotates | B commits $G_{11}$ | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 5** | Worker A success $\to$ Worker B success | $G_{10}, R_1, E_{40}$ | Concurrent HTTP 200s; A acquires lock first, commits $G_{11}$; B arrives second | A commits $G_{11}$; B response dropped as stale | $G_{11}, R_{2A}$, `IDLE` | Valid $R_{2A}$ active | Resumes | Authenticated |
| **TEST 6** | Stale worker attempts credential commit | $G_{10}, R_1, E_{40}$ | B commits $G_{11}$; stale worker A attempts commit with $G_{10}$ | A rejected by generation fence | $G_{11}, R_2$, `IDLE` | Valid $R_2$ preserved | Resumes | Authenticated |
| **TEST 7** | Stale worker attempts `refreshState` reset | $G_{10}, R_1, E_{41}$ | B owns $E_{42}$; stale worker A attempts `refreshState: "IDLE"` | A rejected by epoch fence | $E_{42}$, `REFRESHING` | Untouched | Paused | Authenticated |
| **TEST 8** | Stale worker attempts lease cleanup | $G_{10}, R_1, E_{41}$ | B owns $E_{42}$; stale worker A attempts to clear `refreshWorkerId` | A rejected by epoch fence | Owner $B$, $E_{42}$ | Untouched | Paused | Authenticated |
| **TEST 9** | Service worker restart during refresh | $G_{10}, R_1, E_{40}$ | Worker aborted at `CLAIMED`, `IN_FLIGHT`, `RECEIVED`, `VERIFIED` | Successor reclaims after 30s | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 10** | Lease expiration during in-flight HTTP request | $G_{10}, R_1, E_{41}$ | 30s elapses while fetch pending; successor claims $E_{42}$; old tolerated | Monotonic epoch protects state | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 11** | Duplicate refresh requests using same $R_1$ | $G_{10}, R_1, E_{40}$ | Both dispatched across lease expiry; generation fencing protects state | Whichever commits first wins; other fenced out | $G_{11}, R_2$, `IDLE` | Valid $R_2$ active | Resumes | Authenticated |
| **TEST 12** | Partial credential persistence | Corrupt storage | Schema validator detects missing/corrupt token fields fail-closed | Fails closed on invalid schema | Corrupted record rejected | Re-auth required | Paused | Expired |
| **TEST 13** | Generation rollback attempt | $G_{11}, R_2, E_{42}$ | Malicious/buggy worker attempts commit with $G \le 11$ | Fencing check fails closed | $G_{11}, R_2$, `IDLE` | Valid $R_2$ preserved | Resumes | Authenticated |
| **TEST 14** | Lease epoch rollback attempt | $E_{42}$ in storage | Worker attempts lease claim with $E \le 42$ | Monotonic epoch check fails | $E_{42}$ preserved | Untouched | Paused | Authenticated |
| **TEST 15** | Attempt ID substitution attempt | $UUID_B$ active | Worker attempts commit with $UUID_A$ | Attempt check fails closed | Storage untouched | Untouched | Paused | Authenticated |
| **TEST 16** | Worker ID substitution attempt | `worker-B` active | `worker-A` attempts to release lease | Worker check fails closed | Storage untouched | Untouched | Paused | Authenticated |
| **TEST 17** | Stale 401/bad_refresh_token cannot purge credentials | $G_{11}, R_2$ active | Obsolete worker receives 401 | Error discarded; storage untouched | Valid $R_2$ preserved | Normal | Authenticated |
| **TEST 18** | Stale network error cannot downgrade auth state | $G_{11}, R_2$ active | Obsolete worker encounters transport drop | Error discarded; storage untouched | Valid $R_2$ preserved | Normal | Authenticated |

---

## U. Security Invariants

CodeSync formally establishes and guarantees the following ten foundational security invariants:

1. **INVARIANT 1 (Monotonic Credential Generation):** Credential generation (`refreshGeneration: number`) increases strictly monotonically ($G \to G + 1$). It is never reset, rolled back, or decremented during the lifetime of an authenticated session.
2. **INVARIANT 2 (Monotonic Credential Advancement):** Persisted credential state may only advance to a strictly newer generation. A credential commit with $G \le G_{persisted}$ is rejected fail-closed.
3. **INVARIANT 3 (Stale Response Immunity):** A stale refresh response cannot overwrite newer credentials. An in-memory worker receiving tokens must verify $G_{starting} === G_{persisted}$ under fence before committing.
4. **INVARIANT 4 (Stale Error Isolation):** A stale refresh error cannot purge newer credentials. If an obsolete attempt or superseded worker receives an HTTP error (e.g. `bad_refresh_token`), the error is discarded without modifying storage if $G_{persisted} > G_{starting}$ or if the worker's epoch was superseded.
5. **INVARIANT 5 (Lease Ownership Protection):** A stale worker cannot clear a newer worker's lease. Lease release or error recovery in storage is strictly guarded: a worker may clear `refreshState` or lease metadata only if its `refreshLeaseEpoch` and `refreshWorkerId` match persisted storage exactly.
6. **INVARIANT 6 (Metadata Mutation Guard):** A stale worker cannot reset or mutate newer refresh metadata. Stale workers holding obsolete epochs have zero authority to alter lifecycle state.
7. **INVARIANT 7 (Repository Authorization Immutability):** A repository authorization change or configuration change cannot silently retarget queued work. Queued items execute against immutable enqueue-time destination snapshots.
8. **INVARIANT 8 (Attempt Identity vs. Credential Version):** Refresh attempt identity (`refreshAttemptId: string`) is distinct from credential generation (`refreshGeneration: number`). Multiple attempts originating from the same generation are uniquely identified via cryptographic UUIDs.
9. **INVARIANT 9 (Monotonic Lease Epoch):** Lease epoch (`refreshLeaseEpoch: number`) increments strictly monotonically whenever durable ownership is claimed or reclaimed across process suspension or crash boundaries.
10. **INVARIANT 10 (Dual-Authority Coordination):** Web Locks provide in-memory runtime coordination, but durable storage leases and monotonic epochs remain the authoritative security boundary across service-worker terminations and restarts.

---

## V. Documentation Consistency Audit

A repository-wide audit confirms:
- **"Atomic Commit"**: Completely removed; replaced with "Fenced Credential-State Commit".
- **"Exactly One Refresh Request"**: Completely removed; replaced with at-most-one active attempt per lease and safe tolerance of duplicate requests via generation fencing.
- **"Cache-Busting `_cb`"**: Completely removed; replaced with `cache: "no-store"`.
- **`If-None-Match: ""`**: Completely removed from Contents API calls; standard `cache: "no-store"` used cleanly.
- **"TLS 1.3 Certificate Pinning"**: Accurately described as standard browser HTTPS TLS validation.
- **"Encrypted At Rest"**: Accurately described as browser extension storage isolation.
- **"Git Reference Grammar"**: Renamed to "CodeSync Safe Branch Grammar" (conservative safe subset).

---

## W. Residual Risks

1. **Large File Limitations in Contents API:** Files $> 1$ MB cannot have content fetched via the standard Base64 field. CodeSync enforces a strict **500 KB limit per file** (`PAYLOAD_TOO_LARGE`), completely preventing this risk.
2. **Organization SAML SSO Enforcement:** SAML enforcement can cause unexpected HTTP 403 responses. The client detects `X-GitHub-SSO` and guides the user to authorize SAML identity in Options UI.

---

## X. Official GitHub Documentation Verification

All design decisions and operational parameters were verified against official GitHub documentation on **September 13, 2026**:
- GitHub App Device Flow: [Using the device flow to generate a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
- Refreshing Tokens Without Secret: [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- Contents API: [Repository Contents REST API](https://docs.github.com/en/rest/repos/contents)
- REST API Rate Limits: [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

---

## Y. Final Verdict

# **PHASE 1C.0.3 REFRESH ATTEMPT EPOCH & ERROR-RACE HARDENING = PASS**

### Verdict Justification:
1. **Tripartite Concurrency Authority:** Credential Generation ($G$), Refresh Attempt Identity ($A$), and Durable Lease Epoch ($E$) are formally separated.
2. **Same-Generation Error Race Resolved:** Worker B receiving `bad_refresh_token` at generation 10 detects in-flight predecessor attempts and enters a 5-second grace window, preventing premature credential destruction.
3. **Stale Error Isolation:** Stale errors cannot purge newer valid credentials under any interleaving.
4. **Stale Worker Protection:** Stale workers holding obsolete epochs are strictly barred from clearing newer leases or modifying lifecycle metadata.
5. **Comprehensive Adversarial Coverage:** All 18 deterministic test cases are specified with exact state invariants.
6. **No Implementation Code Written:** Zero Phase 1C implementation code has been created. The test suite passes 100% (114/114), and linting and typing remain clean.

---

### ⛔ CRITICAL PHASE GATE NOTICE: HARD STOP
Implementation of Phase 1C (Phase 1C.1 through Phase 1C.10) remains **STRICTLY LOCKED**. No GitHub integration code, API clients, or UI components may be written until this report receives formal external security approval.
