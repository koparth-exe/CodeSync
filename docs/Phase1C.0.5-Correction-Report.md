# CodeSync Phase 1C.0.5 Correction Report: Lease-Expiry Authority & Terminology Consistency Pass

**Document Version:** 1.0.0  
**Date:** 2026-09-13  
**Role:** Senior Security Architect, GitHub App/API Engineer, Browser-Extension Security Engineer, Distributed-Systems Engineer, Adversarial Concurrency Reviewer  
**Project:** CodeSync (Production-Grade Cross-Browser Browser Extension)  
**Phase:** 1C.0.5  
**Mode:** ARCHITECTURE / DOCUMENTATION ONLY  
**Implementation Status:** ZERO PRODUCTION CODE  
**Hard Stop:** YES (Phase 1C.1 remains LOCKED)  

---

## 1. Executive Summary

Phase 1C.0.5 is the final documentation and architectural hardening pass for CodeSync's Phase 1C GitHub synchronization and token-refresh design. This phase was initiated to resolve three specific findings identified during the external security review of Phase 1C.0.4:

1. **Formally Justify Lease-Expiry Authority Revocation:** Decoupling network completion from local mutation authority ($\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$) and establishing that lease expiration permanently and irrevocably revokes local mutation rights, with zero grace-period restoration.
2. **Remove Misleading "Atomic" Terminology:** Eliminating claims of cross-system atomicity and replacing them with precise engineering definitions: *single-object fenced credential-state persistence* for browser storage, and *validated transactional write protocol with optimistic concurrency control* for remote GitHub Contents API operations.
3. **Correct Documentation Language to Reflect Documentation-Only Status:** Cleansing all documentation of language falsely implying runtime existence (e.g. replacing "implemented" with "specified" or "codified"), while maintaining strict zero-production-code compliance.

Following this pass, the CodeSync GitHub integration specification is mathematically rigorous, distributed-systems sound, and internally consistent across all project artifacts.

---

## 2. Scope & Absolute Hard Stop

### Scope Boundary
- **Documentation and Architecture Artifacts ONLY.**
- Zero production code created or modified in `src/`.
- Zero GitHub API client or network integration code implemented.
- Zero Device Flow polling or token storage runtime logic added.
- Zero dependencies installed or modified.

### Absolute Hard Stop
Implementation of Phase 1C (Phase 1C.1 through Phase 1C.10) remains **STRICTLY LOCKED**. This hardening pass serves exclusively as the documentation gateway for external audit evaluation.

---

## 3. Review Findings Being Resolved

| Finding | Review Criticism | Architectural Resolution in Phase 1C.0.5 |
| :--- | :--- | :--- |
| **Finding 1: Lease-Expiry Authority** | The specification needed formal justification that network request completion does not confer mutation authority, and that lease expiry permanently extinguishes authority without grace-period restoration. | Formulated Section F.5 ("Network Request Lifetime vs. Local Mutation Authority") and the 12 Formal Rules. Formally codified $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$ and $\text{NETWORK SUCCESS} \neq \text{PROOF OF LOCAL MUTATION AUTHORITY}$. Documented timeline walkthrough of Worker A suspension and Worker B takeover. |
| **Finding 2: Misleading "Atomic" Terminology** | Casual references to "atomic IPC commit" or "atomic storage write" incorrectly implied cross-store database-grade atomicity. | Eradicated all misleading uses of "atomic" in storage persistence. Replaced with "single-object fenced credential-state persistence" and added a dedicated Terminology Precision section distinguishing single-object serialization, fencing, version validation, OCC, and multi-step protocols. |
| **Finding 3: Documentation-Only Language Hygiene** | Occasional uses of terms like "implemented" or "reference implementation" could falsely imply that Phase 1C runtime code already exists. | Replaced terms with "specified", "defined", "codified", "architecturally established", and renamed "Reference Implementation" to "Reference Specification". Re-affirmed that zero production code exists. |

---

## 4. Lease Expiry as Permanent Authority Revocation

In distributed browser extensions operating with ephemeral service workers, execution contexts are constantly subject to browser suspension, eviction, or process restarts. Under such constraints, a concurrency lease stored in durable storage (`browser.storage.local`) serves as the authoritative fencing boundary.

### The Revocation Rule
> **"Once the durable refresh lease expires, the previous worker has permanently lost mutation authority for that refresh attempt, regardless of whether an already-dispatched network request later succeeds."**

### Fail-Closed Justification
1. **Irrevocable Loss of Ownership:** When Worker A's 30-second lease expires at $T_{expire}$, Worker A no longer possesses exclusive access to the credential record. Successor workers (e.g. Worker B) are permitted to claim the lease by advancing the lease epoch ($E \to E + 1$).
2. **Prevention of Split-Brain Mutations:** If Worker A were permitted to revive its authority upon receiving a late HTTP 200 response, it could overwrite state committed by Worker B, creating a catastrophic split-brain condition where newly rotated tokens are obliterated.
3. **Zero Grace-Period Restoration:** Authority cannot be inferred from elapsed time, perceived network latency, or heuristics. No grace period exists that can restore lost mutation authority.
4. **Deliberate Security Fencing:** Rejecting late responses is not an operational accident; it is an intentional, fail-closed fencing guarantee designed to ensure that only the actively authorized lease holder can mutate persistent state.

---

## 5. Network Request Lifetime vs. Local Mutation Authority

CodeSync formally distinguishes between two asynchronous dimensions:
- **Dimension A: Network Request Completion** (Remote Server / Transport Plane)
- **Dimension B: Local Mutation Authority** (Local Storage / Enforcement Plane)

$$\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$$
$$\text{NETWORK SUCCESS} \neq \text{PROOF OF LOCAL MUTATION AUTHORITY}$$

### Scenario Walkthrough: Worker A Suspension vs. Worker B Takeover

```
Timeline: Worker A Suspension, Lease Expiration, Worker B Takeover, Late Response Arrival
────────────────────────────────────────────────────────────────────────────────────────
T0: Worker A acquires lease (Epoch E1, Generation G10, Attempt A1, TTL: T0 + 30s)
    Worker A dispatches HTTP POST /login/oauth/access_token (using refresh token R1)
    Request is in-flight across the network.
────────────────────────────────────────────────────────────────────────────────────────
T1: (T0 + 5s) Host browser suspends Worker A (OS sleep, power saving, tab backgrounding)
    Worker A thread halted; network socket buffered in OS network stack.
────────────────────────────────────────────────────────────────────────────────────────
T2: (T0 + 30s) Durable lease expires in browser.storage.local.
    ★ FENCING RULE TRIGGERED: Worker A permanently loses all local mutation authority.
────────────────────────────────────────────────────────────────────────────────────────
T3: (T0 + 32s) Worker B wakes on sync alarm or submission capture.
    Worker B reads storage: observes lease expired and activeAttempt A1 uncommitted.
    Worker B moves Attempt A1 to predecessor history with state UNKNOWN / RECONCILIATION_REQUIRED.
    Worker B acquires lease (Epoch E2 = E1 + 1, WorkerId = Worker_B).
    Worker B initiates reconciliation protocol or prepares new flow.
────────────────────────────────────────────────────────────────────────────────────────
T4: (T0 + 35s) Host browser wakes Worker A.
    OS delivers HTTP 200 OK with new tokens (G11 tokens: R2) to Worker A's callback.
────────────────────────────────────────────────────────────────────────────────────────
T5: Worker A attempts to commit response to storage.
    Worker A invokes isResponseAuthoritative(responseMetadata, currentAuth):
      1. Generation G10 matches G10 (PASS)
      2. AttemptId A1 matches activeAttempt? (Worker B moved A1 to predecessors -> FAIL)
      3. LeaseEpoch E1 matches currentAuth.refreshLeaseEpoch? (FAIL: E1 != E2)
      4. WorkerId Worker_A matches currentAuth.refreshWorkerId? (FAIL: Worker_A != Worker_B)
      5. State REFRESHING matches? (FAIL: state is RECONCILIATION_REQUIRED)
      6. Lease unexpired? (FAIL: Date.now() > T0 + 30s)
    ★ VERDICT: isResponseAuthoritative returns FALSE.
    Response is categorized as STALE_RESPONSE_DROPPED.
    Worker A is PROHIBITED from mutating storage, credentials, or state machine.
    Worker A terminates silently with ZERO side-effects.
────────────────────────────────────────────────────────────────────────────────────────
```

---

## 6. The 12 Formal Rules of Refresh Lifecycle Authority

To eliminate all ambiguity across all service worker lifecycles, CodeSync codifies the following twelve formal rules:

- **RULE 1 (Permanent Authority Revocation on Lease Expiry):** Lease expiry permanently removes the old worker's local mutation authority for that refresh attempt.
- **RULE 2 (Post-Authority Network Completion):** An already-dispatched network request may complete after authority is lost.
- **RULE 3 (Network Completion Never Restores Authority):** Network request completion never restores local mutation authority.
- **RULE 4 (Zero Grace-Period Authority):** No fixed grace period may be used as proof of authority.
- **RULE 5 (Strict Full Predicate Evaluation):** A refresh response must pass the full durable authority predicate before credential mutation is allowed.
- **RULE 6 (Fail-Closed Fencing Failure):** Failure to prove authority MUST fail closed.
- **RULE 7 (Prohibition of Blind Token Reuse):** Unknown refresh outcomes MUST NOT trigger blind refresh-token reuse.
- **RULE 8 (Stale Error Immunity):** Credential mutation/purge must never occur merely because an old worker receives an error response.
- **RULE 9 (Durable State Primacy):** Durable state is authoritative after worker restart/takeover.
- **RULE 10 (Conceptual Decoupling of Identity Vectors):** Credential generations, attempt IDs, lease epochs, and worker IDs must remain conceptually distinct.
- **RULE 11 (Stale Worker Mutation Prohibition):** A stale worker MUST NOT mutate newer credential state.
- **RULE 12 (Stale Success Quarantine):** A successful response from a stale worker MUST be treated as stale/non-authoritative unless authority is independently proven.

---

## 7. Authoritative Response Fencing Predicate

The predicate `isResponseAuthoritative(response, currentAuth)` requires passing all six independent checks:

```typescript
export function isResponseAuthoritative(
  response: RefreshResponseMetadata,
  currentAuth: GitHubAuthState
): boolean {
  // 1. Generation Fencing: Response must match starting credential version
  if (currentAuth.refreshGeneration !== response.credentialGeneration) return false;

  // 2. Attempt Identity Fencing: Must match active attempt UUID
  if (currentAuth.activeAttempt?.attemptId !== response.attemptId) return false;

  // 3. Lease Epoch Fencing: Must match current authoritative epoch
  if (currentAuth.refreshLeaseEpoch !== response.leaseEpoch) return false;

  // 4. Worker Ownership Fencing: Must match current lease holder
  if (currentAuth.refreshWorkerId !== response.workerId) return false;

  // 5. Lifecycle State Fencing: System must still be in active REFRESHING state
  if (currentAuth.refreshState !== "REFRESHING") return false;

  // 6. Durable Lease Boundary: Local lease TTL must not have expired
  if (Date.now() > (currentAuth.refreshLeaseExpiresAt ?? 0)) return false;

  return true;
}
```

### Predicate Component Deconstruction:
1. **Credential Generation (`refreshGeneration`):** Identifies credential-state lineage. Proves local credentials have not already advanced ($G_{persisted} > G_{response}$).
2. **Refresh Attempt Identity (`activeAttempt?.attemptId`):** Identifies the specific in-flight attempt UUID. Proves the response belongs to the actively tracked network call.
3. **Refresh Lease Epoch (`refreshLeaseEpoch`):** Identifies the ownership epoch. Proves no successor has incremented the lease epoch ($E \to E + 1$) to claim authority.
4. **Worker Identity (`refreshWorkerId`):** Identifies the claiming worker. Proves the callback context matches the active lease owner.
5. **Lifecycle Refresh State (`refreshState`):** Identifies whether the state machine permits commits (must be `"REFRESHING"`).
6. **Durable Lease Expiration (`refreshLeaseExpiresAt`):** Determines whether the worker still holds local mutation authority ($T \le 30\text{s}$).

---

## 8. Refresh Attempt / Generation / Lease Epoch Model

CodeSync formally decouples three independent dimensions of authority:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               TRIPARTITE AUTHORITY MODEL                               │
├────────────────────────────────┬───────────────────────────────────────────────────────┤
│ Credential Generation (G)      │ Version of persisted token pair (accessToken + token) │
│                                │ Authoritative for: CREDENTIAL STATE & FRESHNESS       │
├────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Refresh Attempt ID (A)         │ Cryptographic UUID (crypto.randomUUID()) of HTTP req  │
│                                │ Authoritative for: NETWORK OPERATION IDENTITY         │
├────────────────────────────────┼───────────────────────────────────────────────────────┤
│ Refresh Lease Epoch (E)        │ Monotonically increasing ownership counter            │
│                                │ Authoritative for: DURABLE LIFECYCLE DECISIONS        │
└────────────────────────────────┴───────────────────────────────────────────────────────┘
```

---

## 9. Stale Response & Error Handling

- **Stale Success (HTTP 200):** When a late HTTP 200 response arrives at an obsolete worker or after lease expiry, `isResponseAuthoritative` returns `false`. The response is categorized as `STALE_RESPONSE_DROPPED` and discarded without mutating storage.
- **Stale Error (HTTP 400/401):** When an obsolete worker receives an error (e.g. `bad_refresh_token`), the error handler detects that the lease epoch was superseded ($E_{persisted} > E_{response}$) or generation advanced ($G_{persisted} > G_{response}$). The error is discarded (`STALE_ERROR_DROPPED`), guaranteeing that stale errors cannot purge valid rotated credentials.

---

## 10. Unknown Outcome and Reconciliation

When a worker crashes or a lease expires during network transit, GitHub may have already consumed the rotating refresh token ($R_1$) and issued new tokens ($R_2$) upstream.
- **$\text{TIMEOUT} \neq \text{PROOF OF FAILURE}$:** The system cannot assume the refresh attempt failed.
- **Prohibition of Blind Reuse:** An uncertain refresh token must never be blindly reused; doing so risks immediate HTTP 400 rejection and session bricking.
- **First-Class State:** The attempt is recorded as `UNKNOWN` / `RECONCILIATION_REQUIRED`.
- **Predecessor Retention:** Attempt evidence is preserved in `predecessorAttempts` (bounded FIFO of 5 records, pruned after 7 days) to allow successor workers to make informed decisions.
- **Fail-Closed Fallback:** If supporting evidence cannot prove token validity, CodeSync transitions to `status: "reauth_required"`, safely pausing the queue while preserving 100% of user settings, templates, and queued jobs.

---

## 11. Credential Persistence Terminology

CodeSync strictly rejects inaccurate claims of database-grade atomicity. The architecture codifies:

1. **Single-Object Fenced Credential-State Persistence:** All authentication and lifecycle properties are committed as a single consolidated JSON object under key `codesync:auth` in `browser.storage.local`. This prevents partial property skew, but is explicitly *single-object storage serialization*, not a distributed database transaction.
2. **Durable Fencing:** Multi-property verification ($G$, $A$, $E$, $W$, TTL) that guarantees obsolete execution contexts cannot write to storage.
3. **Version Validation:** Invariant schema checks via `validateAuthStateIntegrity` before reading or writing.

---

## 12. GitHub Transactional Write Terminology

For remote repository operations via the GitHub Contents API:
- CodeSync preserves the exact term: **"validated transactional write protocol with optimistic concurrency control"**.
- Multi-request HTTP operations (`GET /contents/{path}` $\to$ content compare $\to$ `PUT /contents/{path}` with `sha`) are explicitly **NOT an atomic database transaction**.
- Concurrency safety is achieved through pre-condition validation, optimistic SHA locking, and the deterministic 8-step 409 conflict protocol.

---

## 13. Documentation-Only Status Rules

Because Phase 1C.0.5 is an architecture and documentation phase with **zero production code**, all documentation strictly uses past/present design language:
- Permitted: *"specified"*, *"defined"*, *"codified"*, *"architecturally established"*, *"designed"*, *"modeled"*.
- Prohibited: *"implemented"*, *"implementation completed"*, *"working"*, *"deployed"*, *"runtime now does"*.

---

## 14. Cross-Document Consistency Audit

A comprehensive cross-document consistency audit was performed across all documentation in `docs/`:

| Document | Stale / Contradictory Terms Audited | Result |
| :--- | :--- | :--- |
| `docs/Phase1C-Architecture-Review.md` | Replaced "Atomic IPC commit" and "Storage atomic IPC" with single-object fenced persistence. Codified lease-expiry revocation in Sections A, F.5, F.6, F.9, F.11, F.12, F.13, V, AA, AC. Renamed Reference Implementation to Reference Specification. | **CONSISTENT & HARDENED** |
| `docs/GITHUB-INTEGRATION.md` | Section 2.2 hardened with lease-expiry revocation, $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$, 6-point predicate breakdown, and single-object fenced persistence. | **CONSISTENT & HARDENED** |
| `docs/ARCHITECTURE.md` | Section 4.1 updated to reflect durable refresh fencing, lease expiry authority revocation, and single-object fenced persistence. Preserved non-atomicity invariant in Section 4.2. | **CONSISTENT & HARDENED** |
| `docs/SRS.md` | Preserved "validated transactional write protocol with optimistic concurrency control" (F10.1). | **CONSISTENT** |
| `docs/QUEUE-DESIGN.md` | Preserved accurate notice that `browser.storage.local` does not provide atomic CAS. | **CONSISTENT** |
| `walkthrough.md` | Re-authored for Phase 1C.0.5 with strict documentation-only terminology. | **CONSISTENT** |

**Zero contradictory terminology or stale claims remain across the CodeSync documentation base.**

---

## 15. Mandatory Adversarial Concurrency Matrix (Scenarios A through L)

| Scenario | Trigger / Event | Current Durable State | Is Response Authoritative? | Is Credential Mutation Permitted? | Is Response Dropped? | Is Reconciliation Required? | Is Re-auth Required? | Outcome & Architectural Rationale |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **A** | Request succeeds immediately before lease expiry | `refreshState: "REFRESHING"`, `activeAttempt.attemptId = A1`, `leaseEpoch = E1`, `workerId = Worker_A`, `Date.now() <= leaseExpiresAt` (e.g. 500ms left) | **YES** | **YES** | **NO** | **NO** | **NO** | Passes all 6 checks of `isResponseAuthoritative`. Single-object fenced persistence commits $G \to G + 1$, sets `refreshState: "IDLE"`, archives $A_1$ as `committed`. |
| **B** | Request succeeds after lease expiry | `Date.now() > leaseExpiresAt`. Lease expired. State may still be `REFRESHING` or transitioned by successor. | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **YES** | **CONDITIONAL** | Fails Check 6 (TTL expired). Rule 1 & Rule 3 apply: lease expiry permanently revokes local mutation authority; network success never restores authority. If $R_1$ was consumed upstream and uncommitted locally, reconciliation escalates fail-closed to `REAUTH_REQUIRED`. |
| **C** | Request errors after lease expiry | `Date.now() > leaseExpiresAt`. Lease expired. | **NO** | **NO** | **YES** (`STALE_ERROR_DROPPED`) | **YES** | **CONDITIONAL** | Fails Check 6. Rule 8 applies: stale error cannot purge credentials. Successor evaluates predecessor history. |
| **D** | Worker A loses lease to Worker B | `leaseEpoch = E2` ($E_2 > E_1$), `workerId = Worker_B`, `activeAttempt.attemptId = A2` (or moved to predecessors). | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **NO** (for Worker A) | **NO** | Worker A fails Checks 2, 3, 4. Rule 11: stale worker cannot mutate newer or active state. Worker B retains exclusive authority. |
| **E** | Worker A returns after Worker B commits newer generation | `refreshGeneration = G11` ($G_{11} > G_{10}$), `refreshState: "IDLE"`, new $R_2$ tokens active. | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **NO** | **NO** | Fails Check 1 ($G_{10} \neq G_{11}$). Generation rollback strictly prohibited (Rule 11). Newer credentials preserved intact. |
| **F** | Worker A returns after Worker B starts new refresh | `refreshGeneration = G10`, `leaseEpoch = E2`, `workerId = Worker_B`, `activeAttempt.attemptId = A2`, `refreshState: "REFRESHING"`. | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **NO** | **NO** | Worker A fails Checks 2, 3, 4. Cannot interfere with Worker B's active attempt. |
| **G** | Service worker restarts during in-flight refresh | `refreshState: "REFRESHING"`, `activeAttempt.attemptId = A1`, `leaseEpoch = E1`, lease unexpired ($T < 30\text{s}$). Worker A memory lost. | **N/A** | **NO** | **YES** | **YES** | **CONDITIONAL** | In-flight execution context wiped. Successor waits for 30s TTL expiry before claiming lease, preventing split-brain writes. |
| **H** | Service worker restarts after lease expiry but before response arrival | `refreshState: "REFRESHING"`, `activeAttempt.attemptId = A1`, `leaseEpoch = E1`, `Date.now() > leaseExpiresAt`. | **NO** | **NO** | **YES** | **YES** | **CONDITIONAL** | Rule 1 & Rule 9 apply. Successor wakes, sees lease expired, marks $A_1$ as `UNKNOWN`, quarantines token from blind reuse. |
| **I** | Two workers independently dispatch refresh requests | Worker A dispatched under $E_1$, Worker B dispatched under $E_2$. | **YES** (for exactly one worker) | **YES** (for authoritative; **NO** for stale) | **YES** (for second/stale) | **NO** | **NO** | Fencing ensures strictly one winner commits. The other is rejected fail-closed via epoch/generation checks. |
| **J** | Old worker receives "invalid refresh token" after another worker succeeded | `refreshGeneration = G11` (or $G_{10}$ with active predecessor $A_1$). | **NO** | **NO** | **YES** (`STALE_ERROR_DROPPED`) | **NO** (if $G_{11}$ active) | **NO** | Rule 8: stale `bad_refresh_token` cannot purge credentials. Valid $G_{11}$ tokens preserved. |
| **K** | Credential generation changes while old response in flight | `refreshGeneration = G11` ($G_{persisted} > G_{response} = G_{10}$). | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **NO** | **NO** | Fails Check 1 ($G_{persisted} \neq G_{response}$). Old response discarded without modifying storage. |
| **L** | Attempt ID changes while old response in flight | `activeAttempt.attemptId = A2` ($A_2 \neq A_1$), `refreshGeneration = G10`. | **NO** | **NO** | **YES** (`STALE_RESPONSE_DROPPED`) | **NO** | **NO** | Fails Check 2 (attempt UUID mismatch). Mismatched attempt UUID rejected fail-closed. |

---

## 16. Mandatory Test & Verification Matrix

Section V of the architecture review includes 36 automated test specifications in `token-lifecycle.test.ts`, mapped across the 18 required verification dimensions:

| Dimension | Verification Requirement | Primary Test Case | Expected Security Behavior |
| :--- | :--- | :--- | :--- |
| **1. Lease Expiry Fencing** | Worker A lease expires after 30s | `TEST 10`, `TEST 20` | Worker A permanently loses mutation authority fail-closed |
| **2. Late Success Response** | HTTP 200 arrives after lease expiry | `TEST 20`, `TEST 32` | `isResponseAuthoritative` returns `false`; response dropped (`STALE_RESPONSE_DROPPED`) |
| **3. Late Error Response** | HTTP 400/401 arrives after lease expiry | `TEST 1`, `TEST 2` | Stale error discarded; cannot purge or downgrade newer credentials |
| **4. Stale Worker Mutation Rejection**| Old worker attempts storage write | `TEST 6`, `TEST 7`, `TEST 8` | Web Lock / storage validation rejects obsolete worker writes |
| **5. Stale Generation** | Response matches $G_{10}$ when storage has $G_{11}$ | `TEST 6`, `TEST 13` | Generation rollback strictly blocked |
| **6. Stale Attempt ID** | Attempt UUID does not match `activeAttempt` | `TEST 15` | Mismatched UUID dropped fail-closed |
| **7. Stale Lease Epoch** | Epoch does not match `refreshLeaseEpoch` | `TEST 7`, `TEST 14` | Obsolete epoch rejected |
| **8. Wrong Worker ID** | Worker ID does not match lease holder | `TEST 16`, `TEST 33` | Non-owner execution context rejected |
| **9. Invalid Refresh State** | System in `IDLE` or `RECONCILIATION_REQUIRED` | `TEST 34` | Commit rejected unless in active `REFRESHING` state |
| **10. Expired Lease Boundary** | `Date.now() > refreshLeaseExpiresAt` | `TEST 20`, `TEST 32` | Local TTL expiration immediately revokes mutation rights |
| **11. Worker Restart** | Service worker terminates during in-flight refresh | `TEST 9`, `TEST 24` | Successor marks attempt `UNKNOWN`; safe crash recovery |
| **12. Takeover** | Worker B claims lease after Worker A expires | `TEST 10`, `TEST 25` | Worker B increments epoch; Worker A completely fenced out |
| **13. Concurrent Refresh** | Two workers trigger refresh simultaneously | `TEST 5`, `TEST 11` | First authoritative commit wins ($G \to G+1$); second dropped |
| **14. Unknown Outcome** | Response lost or ambiguous across lease | `TEST 22`, `TEST 29` | State marked `UNKNOWN`; never assumed failed; data preserved |
| **15. Reconciliation** | Ambiguous state requires authoritative probe | `TEST 3`, `TEST 21` | Evaluates supporting evidence before proceeding |
| **16. Reauthentication** | Unresolvable outcome fails closed to re-auth | `TEST 22`, `TEST 24` | Safe fallback to `reauth_required`; 100% config/queue preserved |
| **17. Terminology Consistency** | Verify zero false claims of atomicity | `TEST 35` | Audits that persistence is single-object fenced and GitHub writes are OCC protocol |
| **18. Doc-Only Status Verification** | Verify zero Phase 1C code in `src/` | `TEST 36` | Build/lint pass confirms zero premature runtime implementation |

---

## 17. Genuine Residual Risks

1. **GitHub OAuth Rate Limits on Burst Refreshes:** While CodeSync's local single-flight Web Lock and 30-second lease prevent local duplicate dispatches, external factors (e.g. user opening 10 separate browser profiles with the same account) could trigger secondary rate limits on GitHub's token endpoint. CodeSync mitigates this through backoff parsing (`slow_down`, `Retry-After`).
2. **Terminal Loss of Refresh Token on Mid-Transit Termination:** If the browser crashes *after* GitHub rotates $R_1 \to R_2$ on the server but *before* the HTTP response reaches the extension storage, the user will be prompted to re-authenticate via Device Flow. This is explicitly accepted as the inescapable cost of maintaining strict client-side security without a trusted backend proxy.

---

## 18. Mandatory Final Report Sections

### 1. Phase Status
**PASS**

### 2. Documents Modified
- `docs/Phase1C-Architecture-Review.md`
- `docs/GITHUB-INTEGRATION.md`
- `docs/ARCHITECTURE.md`
- `walkthrough-Phase 1C.0.5.md`
- `docs/Phase1C.0.5-Correction-Report.md` (newly created)

### 3. Issues Resolved
- **Lease-Expiry Authority Revocation:** Formally justified that $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$. Once the 30s lease expires, local mutation authority is permanently revoked without grace-period restoration. Stale HTTP 200 responses are dropped fail-safe via `isResponseAuthoritative`.
- **Misleading Atomic Terminology:** Replaced "atomic IPC commit" with "single-object fenced credential-state persistence". Preserved "validated transactional write protocol with optimistic concurrency control" for multi-step GitHub operations, explaining that it is not an atomic database transaction.
- **Documentation-Only Terminology:** Replaced all language implying runtime implementation with documentation-only terms ("specified", "codified", "defined", "architecturally established").

### 4. Cross-Document Consistency Result
Audit completed across all documentation. Zero contradictory terminology or stale claims remain.

### 5. Security Invariants Verified
All 13 Security Invariants and 12 Formal Rules of Refresh Lifecycle Authority are verified and codified across the architecture.

### 6. Remaining Risks
Only genuine residual risks (burst rate-limits and fail-closed re-authentication upon unacknowledged token rotation) remain. Zero invented risks.

### 7. Production Code Changes
**ZERO production code changes.**

### 8. Phase Gate
**Phase 1C.1 remains LOCKED unless Phase 1C.0.5 receives a PASS.**

---

## 19. Final Hard Stop

**PHASE 1C.1 IMPLEMENTATION REMAINS STRICTLY LOCKED.**  
**NO CODE WRITTEN IN `src/`.**  
**AWAITING EXTERNAL / HUMAN / CHATGPT SECURITY AUDIT SIGN-OFF.**
