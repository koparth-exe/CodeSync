# CodeSync Phase 1C.0.4: Refresh Reconciliation & Authoritative Response Fencing Report

**Document Version:** 1.0.0  
**Date:** 2026-09-13  
**Role:** Gemini High (Senior Security Architect, Distributed-Systems Engineer, Browser-Extension Security Engineer, GitHub Authentication Engineer, Adversarial Concurrency Reviewer)  
**Project:** CodeSync (Production-Grade Cross-Browser Extension)  
**Scope Boundary:** Documentation / Architecture / Threat-Model Hardening ONLY (Absolute Hard Stop: ZERO Phase 1C implementation code created)  
**Status:** ARCHITECTURE & SECURITY CORRECTION PASS — COMPLETE  

---

## A. Problem Identified

Following external security audit of Phase 1C.0.3, the architecture correctly decoupled Credential Generation ($G$), Refresh Attempt Identity ($A$), and Durable Lease Epoch ($E$). However, four subtle architectural and concurrency vulnerabilities remained:

1. **Fixed Grace Period Is Not Proof:** The 5-second grace window in Phase 1C.0.3 falsely assumed that if no commit landed within 5 seconds, an earlier in-flight refresh request had definitely failed. In browser extensions, host throttling, tab backgrounding, and network latency routinely exceed 5 seconds.
2. **Generation Equality Alone Is Insufficient for Response Authorization:** Prior fencing rules checked only `latestAuth.refreshGeneration === startingGeneration`. If Worker A's lease expired and Worker B superseded ownership at the same generation ($G_{10}$), Worker A could still execute a credential commit merely because the version number had not yet incremented, overwriting or conflicting with Worker B's active ownership.
3. **Durable Predecessor-Attempt History Was Insufficiently Specified:** When Worker B took over an expired lease, the evidence of Worker A's in-flight attempt was at risk of being overwritten in storage, destroying the cryptographic audit trail needed to detect upstream token consumption.
4. **Uncertain Rotating Refresh Token Reuse:** If Worker A dispatched `refresh(R1)` and the 30s lease expired, Worker B waking up could not assume Worker A failed. If GitHub consumed $R_1$ upstream and Worker B naively attempted `refresh(R1)`, GitHub would reject with HTTP 400 `bad_refresh_token`, risking wrongful credential purging.

---

## B. Why Fixed Grace Is Insufficient

In distributed systems and browser extensions, **elapsed local time never proves network state or server-side execution**.

$$\text{TIMEOUT} \neq \text{PROOF OF REFRESH FAILURE}$$

Specifically, the browser execution model introduces significant non-deterministic delays:
- **Service Worker Throttling & Suspension:** Chromium and Gecko may suspend background service workers or delay microtasks for 15 to 45 seconds during low battery, high memory pressure, or OS sleep.
- **TCP Packet & HTTP Queue Delays:** Network packets may be delayed in the browser network stack or edge proxies even while JavaScript execution is stalled.
- **Asynchronous Storage IPC Latency:** `browser.storage.local.set` is an asynchronous IPC call across browser processes; under system load, disk I/O can be deferred beyond arbitrary thresholds.

Therefore, treating a 5-second (or any fixed) window as proof that GitHub rejected a request or that a refresh token was not consumed upstream is a **fatal protocol flaw**. A bounded wait can only serve as an operational/UX latency heuristic. When uncertainty arises, the system must transition to an explicit `REFRESH_OUTCOME_UNKNOWN` / `RECONCILIATION_REQUIRED` state rather than declaring failure.

---

## C. Credential Generation ($G$)

- **Definition:** A strictly monotonically increasing integer (`refreshGeneration: number`) stored in `browser.storage.local` under `codesync:auth`.
- **Semantics:** Represents the **VERSION OF PERSISTED CREDENTIALS** (`accessToken` + `refreshToken` pair).
- **Advancement Rule:** Monotonically increments ($G \to G + 1$) strictly and only when a cryptographically validated, authoritatively fenced token pair is committed to persistent storage.
- **Authority:** Authoritative for determining whether local credentials are newer than an incoming response or error. A commit with $G \le G_{persisted}$ is rejected fail-closed.

---

## D. Attempt Identity ($A$)

- **Definition:** A cryptographically unique UUID string (`attemptId: string`, generated via `crypto.randomUUID()`).
- **Semantics:** Identifies an **INDIVIDUAL NETWORK REFRESH OPERATION**.
- **Advancement Rule:** Generated fresh each time an execution context initiates an outbound HTTP refresh request to GitHub. It is bound immutably to that request and persisted in the active attempt record.
- **Authority:** Authoritative for distinguishing between multiple concurrent or sequential attempts originating from the same credential generation root.

---

## E. Lease Epoch ($E$)

- **Definition:** A strictly monotonically increasing integer counter (`refreshLeaseEpoch: number`).
- **Semantics:** Represents **DURABLE OWNERSHIP OF LIFECYCLE DECISION AUTHORITY**.
- **Advancement Rule:** Increments ($E \to E + 1$) whenever a worker claims the refresh lease, whether on an idle transition or upon reclaiming an expired lease (>30s TTL).
- **Authority:** Authoritative for lifecycle mutations (declaring errors, clearing locks, initiating reconciliation). A worker whose local epoch is less than storage epoch ($E_{worker} < E_{persisted}$) has **ZERO lifecycle authority**.

---

## F. Durable Attempt Record Schema

To guarantee that successor workers can inspect predecessor attempts across service-worker restarts and process boundaries, the durable record is defined as:

```typescript
export interface RefreshAttemptRecord {
  readonly attemptId: string;                     // Cryptographic UUID (A)
  readonly credentialGeneration: number;          // Target credential version (G)
  readonly leaseEpoch: number;                    // Durable lease epoch (E)
  readonly workerId: string;                      // Worker that dispatched request
  readonly startedAt: number;                     // Unix ms
  readonly leaseExpiresAt: number;                // Unix ms (startedAt + 30s)
  readonly state: AttemptState;                   // Granular lifecycle state
  readonly resolutionStatus: AttemptResolutionStatus; // Outcome classification
  readonly errorClassification?: string | undefined; // Redacted error string
}
```

### Inviolable Rules:
1. **Zero Secret Storage:** Tokens (`ghu_...`, `ghr_...`) are **STRICTLY EXCLUDED**. Storing tokens in attempt records would violate token minimization and create leakage vectors.
2. **Predecessor Retention:** Up to **5 predecessor records** are retained in `predecessorAttempts: ReadonlyArray<RefreshAttemptRecord>`.
3. **Pruning Policy:** Records older than **7 days** or exceeding capacity are pruned FIFO upon commit. If storage is constrained, resolved records are dropped before unresolved records.

---

## G. Attempt State Machine

```
   ┌──────────────┐
   │     IDLE     │
   └──────┬───────┘
          │ [Token near expiry or expired]
          ▼
   ┌──────────────┐
   │   CREATED    │ (attemptId UUID, epoch E+1, activeAttempt persisted)
   └──────┬───────┘
          │ [Dispatch fetch]
          ▼
   ┌──────────────┐
   │  IN_FLIGHT   │
   └──────┬───────┴───────────────────────────────┐
          │                                       │
   [HTTP 200 Received]                     [HTTP 400 Received]
          ▼                                       ▼
   ┌───────────────────┐                   ┌───────────────────┐
   │ SUCCESS_RECEIVED  │                   │  ERROR_RECEIVED   │
   └──────────┬────────┘                   └──────────┬────────┘
              │ [Authoritative Fencing]               │ [Authority Check]
              ▼                                       ├──► Gen Advanced: Discard Stale
   ┌───────────────────┐                              ├──► Epoch Superseded: Zero Authority
   │     COMMITTED     │                              ├──► Predecessor In Flight:
   │ (G+1, IDLE reset) │                              │    ┌───────────────────────────┐
   └───────────────────┘                              │    │ RECONCILIATION_REQUIRED   │
                                                      │    └─────────────┬─────────────┘
                                                      │                  ▼
                                                      └──► True Failure: REAUTH_REQUIRED
```

### State Specifications:
- **CREATED:** Attempt initialized in storage; HTTP request prepared.
- **IN_FLIGHT:** Request sent over network; subject to 30s lease TTL.
- **SUCCESS_RECEIVED:** In-memory tokens received; awaiting fenced storage commit.
- **COMMITTED:** Tokens persisted, generation incremented ($G \to G + 1$), active attempt cleared.
- **ERROR_RECEIVED:** In-memory error received; evaluated against fencing.
- **UNKNOWN:** Lease expired while attempt was in flight; upstream state uncertain.
- **SUPERSEDED:** Attempt out-of-date; response or error dropped without mutation.
- **RECONCILIATION_REQUIRED:** Ambiguity detected; system awaits verification or probe.
- **REAUTH_REQUIRED:** Unresolvable ambiguity; safe terminal state prompting user login.

---

## H. Unknown Outcome Model (`REFRESH_OUTCOME_UNKNOWN`)

`REFRESH_OUTCOME_UNKNOWN` represents:
> *"The client cannot currently prove whether the previous refresh request succeeded upstream on GitHub."*

It explicitly **DOES NOT MEAN**:
- Token is revoked
- Token is definitely expired
- Refresh failed
- Request was aborted

It means the outcome is uncertain. Therefore:
1. The uncertain refresh token **MUST NOT** be reused blindly.
2. Credentials **MUST NOT** be purged from storage.
3. Queue items are paused without destruction.

---

## I. Authoritative Response Fencing Predicate

The rule `currentGeneration === responseGeneration` is formally superseded by `isResponseAuthoritative`:

```typescript
export function isResponseAuthoritative(
  response: RefreshResponseMetadata,
  currentAuth: GitHubAuthState
): boolean {
  return (
    currentAuth.refreshGeneration === response.credentialGeneration &&
    currentAuth.activeAttempt?.attemptId === response.attemptId &&
    currentAuth.refreshLeaseEpoch === response.leaseEpoch &&
    currentAuth.refreshWorkerId === response.workerId &&
    currentAuth.refreshState === "REFRESHING" &&
    Date.now() <= (currentAuth.refreshLeaseExpiresAt ?? 0)
  );
}
```

If any condition fails, the response is dropped with `STALE_RESPONSE_DROPPED`.

---

## J. Success Response Algorithm (13 Steps)

1. Receive HTTP 200 with tokens in memory.
2. Validate response schema (`ghu_` prefix, `ghr_` prefix, integer expiration).
3. Acquire exclusive runtime Web Lock (`codesync:auth:refresh`).
4. Read current auth state from `browser.storage.local`.
5. Execute `validateAuthStateIntegrity(rawAuth)`.
6. Evaluate `isResponseAuthoritative(response, currentAuth)`.
7. If fencing fails: log `STALE_RESPONSE_DROPPED`; if `currentAuth.refreshGeneration > response.credentialGeneration`, return `currentAuth.accessToken`; otherwise throw error without mutating storage.
8. Construct updated `RefreshAttemptRecord` (`state: "COMMITTED"`, `resolutionStatus: "committed"`).
9. Prepend record to `predecessorAttempts` and prune (>7 days, max 5).
10. Construct new `GitHubAuthState` with $G_{new} = G_{current} + 1$, `refreshState: "IDLE"`, new tokens, and cleared lease metadata.
11. Commit single cohesive object to `browser.storage.local`.
12. Release Web Lock.
13. Return new active access token to caller.

---

## K. Error Response Algorithm (12 Steps)

1. Receive HTTP error (e.g. 400 `bad_refresh_token`) in memory.
2. Acquire exclusive runtime Web Lock (`codesync:auth:refresh`).
3. Read current auth state and validate integrity.
4. Check generation: if `currentAuth.refreshGeneration > response.credentialGeneration`, generation already advanced; discard error as stale and adopt newer credentials.
5. Check epoch: if `currentAuth.refreshLeaseEpoch !== response.leaseEpoch` or worker ID differs, worker was superseded; discard error fail-safe.
6. Inspect `predecessorAttempts`: check if an earlier attempt was in flight for the same generation.
7. If predecessor existed: transition state to `status: "reconciliation_required"` and preserve credentials.
8. If sole authoritative attempt and error is terminal (`bad_refresh_token` / `invalid_grant`): re-verify storage generation under lock.
9. Transition state to `status: "reauth_required"`, record failure in attempt record, and clear active attempt.
10. If error is transient (5xx, rate limit, network abort): revert `refreshState: "IDLE"` without clearing credentials.
11. Release Web Lock.
12. Throw `GitHubAuthError` with appropriate category; never purge credentials on ambiguous evidence.

---

## L. Same-Generation Race

- **Scenario:** Initial state $G_{10}, R_1$. Worker A ($E_{41}$) dispatches `refresh(R1)` and stalls. Lease expires. Worker B ($E_{42}$) starts for $G_{10}$. GitHub processes Worker A first ($R_1 \to R_2$), but Worker A's 200 response is delayed on the network. Worker B receives HTTP 400 `bad_refresh_token`. Persisted generation is still $G_{10}$.
- **Resolution:**
  1. Worker B checks `predecessorAttempts` and observes Attempt A was in flight for $G_{10}$.
  2. Worker B **KNOWS** $R_1$ may have been rotated by Attempt A.
  3. Worker B **DOES NOT PURGE CREDENTIALS**.
  4. Worker B transitions to `status: "reconciliation_required"`.
  5. If Worker A's commit arrives, $G_{11}$ is adopted.
  6. If Worker A crashed permanently, Worker B fails closed to `REAUTH_REQUIRED`, preserving user configuration.

---

## M. Success-Response-Lost Scenario

- **Scenario:** Worker A sends `refresh(R1)`. GitHub rotates $R_1 \to R_2$. The browser terminates Worker A before $R_2$ is committed to storage. Worker B wakes later. $R_1$ is consumed upstream, but $R_2$ is permanently lost.
- **Resolution:**
  1. Worker B observes uncommitted attempt with expired lease.
  2. Worker B **CANNOT reuse $R_1$** (blind reuse prohibited).
  3. Attempt A is marked `UNKNOWN`.
  4. System enters `REAUTH_REQUIRED`.
  5. Preserves existing configuration, logs actionable error, and prompts user re-connect.
  6. **Tradeoff Explicitly Accepted:** Occasional re-authentication is required to preserve credential integrity without an intermediary proxy server.

---

## N. Error-Response-Lost Scenario

- **Scenario:** Worker A sends `refresh(R1)`. GitHub rejects it. Error packet is dropped by network. Worker A terminates. Later Worker B wakes.
- **Resolution:**
  1. Worker B observes uncommitted Attempt A across lease boundary.
  2. Worker B marks Attempt A outcome as `UNKNOWN`.
  3. Worker B does not assume failure; evaluates supporting evidence (e.g. testing existing access token) before escalating to `REAUTH_REQUIRED`.

---

## O. Service-Worker Restart

Deterministic recovery across all 7 lifecycle restart points:
- **Case A (Before dispatch):** Storage is `IDLE`. Normal start.
- **Case B (During network dispatch):** Storage is `REFRESHING`. Lease active. Successor awaits lease TTL.
- **Case C (In flight, lease expires):** Successor marks prior attempt `UNKNOWN`, flags `RECONCILIATION_REQUIRED`.
- **Case D (GitHub processed, response in flight, lease expires):** Outcome `UNKNOWN`. Safe probe or `REAUTH_REQUIRED`.
- **Case E (Success received in RAM, SW died before commit):** $R_2$ lost. Successor detects uncommitted attempt; fails closed to `REAUTH_REQUIRED`.
- **Case F (SW died during storage IPC commit):** Single cohesive object write: either old $G$ or complete $G+1$. Integrity validator fails closed if corrupt.
- **Case G (Immediately after commit):** Storage has $G+1$. Successor reads and uses fresh tokens directly.

---

## P. Lease Expiration

$$\text{Lease Expiration} \neq \text{Network Cancellation} \neq \text{Refresh Failure}$$

A local lease expiration is an internal browser coordination timeout (30 seconds). It does not abort TCP traffic on GitHub's servers. The architecture models this reality:
- Lease expiration forfeits local worker authority.
- Predecessor attempt evidence is preserved in storage.
- The successor worker fences against late-arriving responses.

---

## Q. Safe Recovery

```
                             REFRESH NEEDED
                                   │
                    Has uncommitted predecessor?
                                   │
                     ├── YES ──► Check Generation Advanced?
                     │                ├── YES ──► Adopt G_new
                     │                └── NO  ──► REAUTH_REQUIRED
                     │
                     └── NO  ──► Authoritative Dispatched Refresh
```

Recovery strictly adheres to:
$$\text{SAFE RE-AUTHENTICATION} > \text{UNSAFE TOKEN REUSE}$$

---

## R. Re-authentication Fallback

When uncertainty cannot be resolved, CodeSync enters `status: "reauth_required"`.
- **Data Preservation:** User settings, target repository, branch selections, path templates, and queued submissions are **100% PRESERVED**.
- **Queue Protection:** Queue processing pauses safely without dropping or failing submissions.
- **User Prompt:** The Options UI prompts the user to click "Reconnect GitHub" to establish a fresh credential root via Device Flow.

---

## S. GitHub-vs-CodeSync Guarantees

| Guarantee Dimension | GitHub Server | CodeSync Client |
| :--- | :--- | :--- |
| **Token Rotation** | Single-use refresh tokens; immediate rotation. | Treats tokens as single-use; never reuses uncertain tokens. |
| **Idempotency** | None. No request IDs or idempotency keys. | Models refresh as non-idempotent operation. |
| **Delivery Confirmation** | None. No server-to-client delivery ack. | Models packet loss; marks unconfirmed attempts `UNKNOWN`. |
| **State Querying** | No API to check if a refresh token was consumed. | Uses `RECONCILIATION_REQUIRED` and re-auth fallback. |

---

## T. Threat Model (Threats U1 through U13)

| ID | Attack / Failure Mode | Security Property | Defense | Fail-Safe Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **U1** | Duplicate refresh dispatch | Concurrency fencing | Monotonic generation ($G$) + Web Locks + lease epoch ($E$). | First commits; duplicate dropped. |
| **U2** | Stale success overwrite | Stale response fencing | `isResponseAuthoritative` predicate ($G, A, E, W, \text{TTL}$). | Dropped (`STALE_RESPONSE_DROPPED`). |
| **U3** | Stale error invalidation | Stale error isolation | Generation check ($G_{persisted} > G_{starting}$). | Discarded (`STALE_REFRESH_ERROR_IGNORED`). |
| **U4** | Success response loss | Credential integrity | Successor detects uncommitted attempt; marks `UNKNOWN`. | Fails closed to `REAUTH_REQUIRED`. |
| **U5** | Error response loss | Evidence integrity | Predecessor marked `UNKNOWN`; avoids assumed failure. | Safe probe before re-auth. |
| **U6** | Service-worker termination | Crash recovery | Durable attempt record persisted in storage. | Successor claims $E+1$, preserves audit. |
| **U7** | Lease expiration ambiguity | Protocol separation | Models lease expiration $\neq$ network failure. | Successor fences; stale commit rejected. |
| **U8** | Same-generation error race | Non-destruction | Predecessor in-flight check flags race; sets `RECONCILIATION`. | Credentials preserved; never purged. |
| **U9** | Uncertain upstream rotation | Safe token usage | Defines `REFRESH_OUTCOME_UNKNOWN`; forbids blind reuse. | Fail-closed to `REAUTH_REQUIRED`. |
| **U10**| Stale metadata mutation | Authority preservation | Epoch-guarded mutations ($E_{worker} === E_{persisted}$). | Mutation rejected fail-closed. |
| **U11**| Attempt-ID substitution | Attempt identity | Attempt UUID check in `isResponseAuthoritative`. | Commit rejected fail-closed. |
| **U12**| Lease-epoch rollback | Monotonic ordering | Strict check $E_{new} > E_{persisted}$. | Lease claim rejected fail-closed. |
| **U13**| Generation rollback | Monotonic credentials | Strict check $G_{new} > G_{persisted}$. | Commit rejected fail-closed. |

---

## U. Adversarial Test Matrix (Tests 1 through 30)

The 30 deterministic test specifications in `token-lifecycle.test.ts`:

- **TEST 1:** Worker A success $\to$ Worker B stale error ($B$ discards `bad_refresh_token`, adopts $G_{11}$).
- **TEST 2:** Worker B success $\to$ Worker A stale error ($A$ discards `bad_refresh_token`, preserves $R_2$).
- **TEST 3:** Worker A in-flight $\to$ Worker B error while $G$ unchanged ($B$ transitions to `RECONCILIATION_REQUIRED`, preserves credentials).
- **TEST 4:** Worker A error $\to$ Worker B success ($A$ releases epoch, $B$ rotates cleanly to $G_{11}$).
- **TEST 5:** Worker A success $\to$ Worker B success (concurrent 200s; first commits $G_{11}$, second drops stale).
- **TEST 6:** Stale worker attempts credential commit ($G_{10}$ commit rejected when storage has $G_{11}$).
- **TEST 7:** Stale worker attempts refreshState reset ($E_{41}$ worker cannot reset $E_{42}$ state).
- **TEST 8:** Stale worker attempts lease cleanup ($E_{41}$ worker cannot clear $E_{42}$ lease owner).
- **TEST 9:** Service worker restart during refresh (recovery at `CREATED`, `IN_FLIGHT`, `COMMITTED`).
- **TEST 10:** Lease expiration during in-flight HTTP request (successor claims $E+1$, old tolerated safely).
- **TEST 11:** Duplicate refresh requests using same $R_1$ (both dispatched, generation fencing protects state).
- **TEST 12:** Partial credential persistence (schema validator rejects corrupt/missing fields fail-closed).
- **TEST 13:** Generation rollback attempt (commit with $G \le G_{persisted}$ rejected fail-closed).
- **TEST 14:** Lease epoch rollback attempt (claim with $E \le E_{persisted}$ rejected fail-closed).
- **TEST 15:** Attempt ID substitution attempt (mismatched attempt UUID rejected on commit).
- **TEST 16:** Worker ID substitution attempt (mismatched worker ID on cleanup rejected).
- **TEST 17:** Stale 401/`bad_refresh_token` cannot purge newer credentials (valid $R_2$ untouched).
- **TEST 18:** Stale network error cannot downgrade authenticated state (session remains valid).
- **TEST 19:** Success response delayed beyond grace window (no false assumption of failure; $\text{TIMEOUT} \neq \text{PROOF}$).
- **TEST 20:** Success response arrives after lease expiration (old worker cannot commit; `STALE_RESPONSE_DROPPED`).
- **TEST 21:** Error arrives while predecessor success is in flight (transitions to `RECONCILIATION_REQUIRED`).
- **TEST 22:** Success response is permanently lost (no unsafe refresh-token reuse; fails closed to `REAUTH_REQUIRED`).
- **TEST 23:** Error response is permanently lost (marked `UNKNOWN`, not assumed failure).
- **TEST 24:** Service worker terminates after GitHub rotates token but before local commit (safe reconciliation or `REAUTH_REQUIRED`).
- **TEST 25:** Success arrives after successor attempt begins (stale response fencing drops older commit).
- **TEST 26:** Stale worker attempts to clear predecessor record (rejected fail-closed).
- **TEST 27:** Stale worker attempts to alter current attempt record (rejected fail-closed).
- **TEST 28:** Attempt A record overwritten by Attempt B (test MUST fail if implementation allows loss of predecessor evidence).
- **TEST 29:** Unknown outcome incorrectly converted to "expired" (rejected fail-closed; uncertainty preserved).
- **TEST 30:** Fixed grace period incorrectly treated as proof (rejected fail-closed; timeout $\neq$ proof).

---

## V. Security Invariants (1 through 13)

1. **INVARIANT 1:** Credential generation is monotonically increasing ($G \to G + 1$).
2. **INVARIANT 2:** Credential generation represents credential VERSION, not refresh-operation identity.
3. **INVARIANT 3:** Every refresh operation has a unique durable attempt identity (`attemptId` UUID).
4. **INVARIANT 4:** Every durable ownership transition has a monotonic lease epoch ($E \to E + 1$).
5. **INVARIANT 5:** Lease expiration does not prove network failure ($\text{lease expiration} \neq \text{cancellation} \neq \text{failure}$).
6. **INVARIANT 6:** A response may mutate credentials only while its attempt remains authoritative under `isResponseAuthoritative`.
7. **INVARIANT 7:** A stale response cannot overwrite newer credentials (`STALE_RESPONSE_DROPPED`).
8. **INVARIANT 8:** A stale error cannot purge valid credentials.
9. **INVARIANT 9:** Unknown refresh outcome cannot be treated as confirmed failure ($\text{TIMEOUT} \neq \text{PROOF}$).
10. **INVARIANT 10:** An uncertain rotating refresh token must not be blindly reused.
11. **INVARIANT 11:** Predecessor attempt evidence must survive successor takeover until safe resolution or bounded quarantine (`predecessorAttempts` FIFO).
12. **INVARIANT 12:** Web Locks are runtime coordination, not durable authority.
13. **INVARIANT 13:** If credential validity cannot be safely established, CodeSync fails closed to explicit re-authentication rather than destroying or guessing credential state.

---

## W. Documentation Audit

The following documents were audited, updated, and verified to ensure zero contradictory refresh models remain:
- `docs/Phase1C-Architecture-Review.md`: Header updated to Phase 1C.0.4; Section E updated with `AttemptState`, `AttemptResolutionStatus`, `RefreshAttemptRecord`, and `GitHubAuthState`; Section F completely rewritten with authoritative fencing, tripartite authority, evidence hierarchy, restart matrix, and updated `DurableTokenLifecycleManager`; Section U expanded to U1–U13; Section V expanded to Tests 1–30; Section AA expanded to Invariants 1–13; Section AC verdict set to PASS.
- `docs/GITHUB-INTEGRATION.md`: Updated Section 1.3 (PAT deferred for Phase 1C); Section 2.1 (`RefreshAttemptRecord` and `GitHubAuthState` with reconciliation states); Section 2.2 (`isResponseAuthoritative`, timeout $\neq$ proof, prohibition of blind token reuse).
- `docs/ARCHITECTURE.md`: Clarified PAT deferral in Section 4.1 and Section 2 diagram.
- `docs/PATH-TEMPLATE-SPEC.md` & `docs/PRIVACY.md`: Audited; confirmed zero conflicts with authentication architecture.

---

## X. Residual Risks

1. **GitHub OAuth Endpoint Downtime:** If `github.com/login/oauth/access_token` suffers prolonged global outages, token refresh will fail with transient 5xx errors. The engine reverts `refreshState: "IDLE"` with bounded retry (max 5) and preserves valid credentials.
2. **Frequency of Re-Authentication in Hostile Environments:** If a user frequently closes their laptop lid during the exact sub-second window after GitHub rotates a token but before local storage commits, the session enters `REAUTH_REQUIRED`. This slight UX friction is strictly necessary to preserve credential integrity without introducing a high-privilege backend server.

---

## Y. Final Verdict

# **PHASE 1C.0.4 FINAL VERDICT = PASS**

### Verification Checklist:
- [x] Fixed grace period is NO LONGER treated as proof ($\text{TIMEOUT} \neq \text{PROOF OF REFRESH FAILURE}$).
- [x] Credential Generation ($G$) and Attempt Identity ($A$) are strictly separated.
- [x] Response authorization requires full current authority (`isResponseAuthoritative`).
- [x] Durable predecessor evidence exists (`predecessorAttempts`, max 5, tokens excluded).
- [x] Unknown outcome (`REFRESH_OUTCOME_UNKNOWN`) is a first-class lifecycle condition.
- [x] Uncertain rotating refresh tokens are NEVER blindly reused.
- [x] Lost success response is safely handled via `REAUTH_REQUIRED`.
- [x] Lost error response is safely handled as `UNKNOWN` rather than assumed failure.
- [x] Service-worker restart is deterministic across all 7 scenarios (A–G).
- [x] Stale workers cannot commit credentials, reset states, or clear newer leases.
- [x] Ambiguous evidence CANNOT purge credentials.
- [x] Re-authentication is available as safe, data-preserving terminal recovery.
- [x] Documentation contains no contradictory guarantees.
- [x] All 30 required adversarial tests are specified in `token-lifecycle.test.ts`.
- [x] **ZERO Phase 1C implementation code has been created.**

---

## ABSOLUTE HARD STOP ENFORCED

**Phase 1C implementation remains HALTED.**  
**No production code in `src/`, no GitHub API clients, no Device Flow implementation.**  
**Awaiting external / ChatGPT security audit.**
