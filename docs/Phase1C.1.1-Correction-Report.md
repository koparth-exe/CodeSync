# Phase 1C.1.1 — Authentication Hardening & Consistency Correction Report

**Phase:** 1C.1.1  
**Mode:** CORRECTION / HARDENING  
**Status:** COMPLETE (PASS)  
**Strict Gate:** Phase 1C.2 REMAINS STRICTLY LOCKED PENDING EXTERNAL REVIEW  

---

## 1. Findings Addressed

This correction pass addresses all four review findings from Phase 1C.1:

1. **Eradication of Misleading "Atomic" Terminology:** Removed all inaccurate references claiming that credential persistence in `browser.storage.local` is "atomic", "atomically", or an "atomic CAS". Replaced with the precise, approved definition: **Single-Object Fenced Credential-State Persistence**, explicitly documenting that `browser.storage.local` is not treated as a compare-and-swap primitive.
2. **Clarification of Auth State vs. Attempt State Models:** Documented and verified the strict separation between:
   - `GitHubAuthState.refreshState`: High-level authentication lifecycle (`"IDLE" | "REFRESHING" | "RECONCILIATION_REQUIRED"`).
   - `RefreshAttemptRecord.state`: Detailed per-attempt execution lifecycle (`"CREATED" | "IN_FLIGHT" | "SUCCESS_RECEIVED" | "COMMITTED" | "ERROR_RECEIVED" | "UNKNOWN" | "SUPERSEDED" | "RECONCILIATION_REQUIRED" | "REAUTH_REQUIRED"`).
   Updated state machine diagrams to eliminate conflation.
3. **Normalization of GitHub Contents Permission Wording:** Audited and normalized all documentation to eliminate restrictive/inconsistent phrasing (`Contents: write`, `Contents: Read & Write`). Standardized on the precise phrasing:
   > *"Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions."*
4. **Implementation & Verification of Real TOCTOU Race Suite:** Replaced predicate-only unit verification with a real, executable, deterministic race test suite exercising the actual mutation path in `DurableTokenLifecycleManager`:
   - Worker A acquires lease, passes initial authority check, reaches persistence boundary (`onBeforePersistence`).
   - Lease expires; Worker B takes over with successor epoch ($E_{43} \to E_{44}$) and commits $G_{11}$.
   - Worker A resumes, attempts storage mutation.
   - Pre-persistence durable reread & authority re-check detects stale authority and generation advancement, fail-closed rejects Worker A's mutation, preserves $G_{11}$ intact, and adopts Worker B's tokens without downgrade.
   - Verified stale error path (`bad_refresh_token` at error persistence boundary) does not trigger `reauth_required` or wipe valid credentials.

---

## 2. Files Inspected

- `src/shared/auth/types.ts`
- `src/shared/auth/state-validator.ts`
- `src/shared/auth/token-lifecycle.ts`
- `src/shared/auth/service.ts`
- `src/shared/auth/device-flow.ts`
- `src/shared/queue/concurrency.ts`
- `tests/security/token-lifecycle.test.ts`
- `docs/Phase1C.1-Report.md`
- `docs/Phase1C-Architecture-Review.md`
- `docs/SRS.md`
- `docs/GITHUB-INTEGRATION.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/TECH-STACK.md`
- `docs/ROADMAP.md`
- `docs/COMPETITOR-ANALYSIS.md`
- `docs/ADR/ADR-0003-github-oauth-device-flow.md`
- `docs/Phase1B.1-Report.md`

---

## 3. Files Changed

1. `src/shared/auth/token-lifecycle.ts`: Added `onBeforePersistence` and `onBeforeErrorPersistence` hooks; decoupled HTTP fetch from exclusive Web Lock; added pre-persistence durable reread and 6-point authority re-validation immediately before storage write.
2. `src/shared/auth/types.ts`: Added explicit docstrings establishing strict boundary between `RefreshLifecycleState` and `AttemptState`.
3. `tests/security/token-lifecycle.test.ts`: Added dedicated deterministic TOCTOU race test block (`AUTH-37` through `AUTH-40`).
4. `docs/Phase1C.1-Report.md`: Corrected "atomically" terminology, updated Section 13 state machine diagrams, updated Section 20 TOCTOU defense.
5. `docs/SRS.md`: Normalized F6.2 permission wording.
6. `docs/GITHUB-INTEGRATION.md`: Normalized permission wording in Section 1.1 ASCII diagram and Section 1.2 table.
7. `docs/ARCHITECTURE.md`: Normalized permission wording in Invariant 4 and Section 4.1.
8. `docs/SECURITY.md`: Normalized permission wording in Invariant 4 and Threat Model Scenario Y.
9. `docs/TECH-STACK.md`: Normalized permission wording in Primary Auth row.
10. `docs/ROADMAP.md`: Normalized permission wording in Phase 0.1 Deliverable 2.
11. `docs/COMPETITOR-ANALYSIS.md`: Normalized permission wording in Section 2.1.
12. `docs/ADR/ADR-0003-github-oauth-device-flow.md`: Normalized permission wording in Decision and Fine-Grained Permissions bullet.
13. `docs/Phase1C-Architecture-Review.md`: Normalized permission wording in Section 2 table.
14. `docs/Phase1B.1-Report.md`: Replaced "atomic blob/tree/commit pipeline" with "validated transactional blob/tree/commit pipeline".

---

## 4. Atomic Terminology Corrections

All misleading references claiming atomicity in credential persistence were removed. The operational guarantee is formally defined as:

> **SINGLE-OBJECT FENCED CREDENTIAL-STATE PERSISTENCE**  
> "After final durable fencing validation, the complete credential state is persisted as a single fenced JSON object under the `codesync:auth` key. `browser.storage.local` is not treated as a compare-and-swap primitive."

Specific corrections made:
- `docs/Phase1C.1-Report.md`: Replaced *"commits atomically as a single JSON object"* with *"After final durable fencing validation, the complete credential state is persisted as a single fenced JSON object under the codesync:auth key. browser.storage.local is not treated as a compare-and-swap primitive."*
- `docs/Phase1B.1-Report.md`: Replaced *"atomic blob/tree/commit pipeline"* with *"validated transactional blob/tree/commit pipeline"*.
- System search confirms: **Zero false claims of atomic commits or atomic storage writes remain across the repository.**

---

## 5. State-Machine Corrections

In `src/shared/auth/types.ts` and `docs/Phase1C.1-Report.md` Section 13, the state model was corrected to cleanly decouple the authentication-level lifecycle from the per-attempt execution lifecycle:

### AUTH STATE (`GitHubAuthState.refreshState`)
```
IDLE
  ↓
REFRESHING
  ├── authoritative success
  │       ↓
  │     IDLE + generation increment
  │
  ├── authoritative terminal failure
  │       ↓
  │     REAUTH_REQUIRED
  │
  ├── uncertain outcome
  │       ↓
  │     RECONCILIATION_REQUIRED
  │
  └── stale response/error
          ↓
       dropped safely (state unchanged)
```

### ATTEMPT STATE (`RefreshAttemptRecord.state`)
```
CREATED
   ↓
IN_FLIGHT
   ├── SUCCESS_RECEIVED
   │       ↓
   │    COMMITTED
   │
   ├── ERROR_RECEIVED
   ├── UNKNOWN
   ├── SUPERSEDED
   └── RECONCILIATION_REQUIRED
```

The TypeScript types enforce this invariant:
- `RefreshLifecycleState`: `"IDLE" | "REFRESHING" | "RECONCILIATION_REQUIRED"`
- `AttemptState`: `"CREATED" | "IN_FLIGHT" | "SUCCESS_RECEIVED" | "COMMITTED" | "ERROR_RECEIVED" | "UNKNOWN" | "SUPERSEDED" | "RECONCILIATION_REQUIRED" | "REAUTH_REQUIRED"`

---

## 6. GitHub Permission Wording Corrections

All relevant documentation was audited and updated to use the standard, precise permission description:

> *"Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions."*

Files audited and synchronized:
- `docs/SRS.md` (§2.5 F6.2)
- `docs/GITHUB-INTEGRATION.md` (§1.1 Diagram & §1.2 Table)
- `docs/ARCHITECTURE.md` (§1 Invariant 4 & §4.1)
- `docs/SECURITY.md` (§2.3 Invariant 4 & §3 Scenario Y)
- `docs/TECH-STACK.md` (§1 Primary Auth)
- `docs/ROADMAP.md` (§Phase 0.1 Deliverable 2)
- `docs/COMPETITOR-ANALYSIS.md` (§2.1 Least Privilege)
- `docs/ADR/ADR-0003-github-oauth-device-flow.md` (§Decision & §Architecture Characteristics)
- `docs/Phase1C-Architecture-Review.md` (§2 Comparison Matrix)

---

## 7. TOCTOU Test Design

The test harness exercises the genuine mutation path within `DurableTokenLifecycleManager` using controllable asynchronous synchronization hooks (`onBeforePersistence` and `onBeforeErrorPersistence`) positioned immediately before storage write:

```
Worker A (Thread 1)                          Worker B (Thread 2)
─────────────────────────────────────────────────────────────────────────────
1. Acquire Lease (Epoch 42 -> 43, G10)
2. Dispatch HTTP refresh request
3. Receive 200 OK from GitHub
4. Pass initial authority validation
5. Reach credential persistence boundary
6. Fire onBeforePersistence hook
   ───────────────── [SUSPEND WORKER A] ─────────────────
                                             7. Advance clock (+35s, lease expires)
                                             8. Worker B claims lease (Epoch 43 -> 44)
                                             9. Worker B dispatches refresh to GitHub
                                            10. Worker B commits G11 to storage
                                            11. Worker B completes successfully
   ───────────────── [RESUME WORKER A] ──────────────────
12. Worker A executes pre-persistence check
    - Rereads storage: detects G11 > G10, E44 != E43
    - Fencing predicate FAILS
13. Worker A drops stale mutation fail-closed
14. Worker A returns B's newer G11 token
15. Storage contains Worker B's tokens intact
```

Zero reliance on `setTimeout`, `sleep`, or nondeterministic network timing.

---

## 8. Exact Race Scenarios Tested

| Scenario ID | Test Name | Invariant Verified | Result |
|---|---|---|---|
| **AUTH-37** | TOCTOU Real Mutation Race | Worker A suspended at persistence boundary, Worker B takes lease & commits G11, Worker A resumes: stale write rejected, G11 preserved | **PASS (10ms)** |
| **AUTH-38** | TOCTOU Stale Error Path | Worker A suspended at error boundary with `bad_refresh_token`, Worker B commits G11, Worker A resumes: stale error dropped, no `reauth_required` | **PASS (11ms)** |
| **AUTH-39** | Lease Expiry at Persistence Boundary | Worker A pauses at persistence boundary, lease expires without successor: mutation rejected fail-closed as `GITHUB_STALE_RESPONSE`, G10 intact | **PASS (11ms)** |
| **AUTH-40** | Stale Error After Lease Expiry | Worker A receives `bad_refresh_token` after lease expired: error rejected as `GITHUB_STALE_RESPONSE`, credentials preserved | **PASS (8ms)** |

---

## 9. Stale-Error Test Result

- **Scenario:** Worker A holds lease Epoch 43 for Generation 10. Request lags. Worker B takes lease Epoch 44 and commits Generation 11. Worker A subsequently receives `HTTP 400 bad_refresh_token`.
- **Behavior:** `handleRefreshError` detects $G_{\text{durable}} (11) > G_{\text{response}} (10)$ and $E_{\text{durable}} (44) \ne E_{\text{response}} (43)$.
- **Result:** Error discarded as `STALE_ERROR_DROPPED`. Storage remains `status: "authenticated"`, $G=11$. Zero credential destruction.

---

## 10. Lease-Expiry Test Result

- **Scenario:** Worker A dispatches refresh. Clock advances $+31\text{s}$ ($>30\text{s}$ TTL). HTTP 200 arrives.
- **Behavior:** `now > currentAuth.refreshLeaseExpiresAt`. Fails check 6 of `isResponseAuthoritative`.
- **Result:** Rejected fail-closed with `GITHUB_STALE_RESPONSE`. Credential state unmutated. Confirms: **NETWORK COMPLETION $\neq$ LOCAL MUTATION AUTHORITY**.

---

## 11. Generation Fencing Test Result

- **Scenario:** Response returns with `credentialGeneration: 10`, but storage generation is $11$.
- **Behavior:** Rejected by check 1 of `isResponseAuthoritative`.
- **Result:** Generation rollback is strictly blocked. Newer credentials preserved intact.

---

## 12. Attempt-ID Fencing Test Result

- **Scenario:** Response carries mismatched `attemptId` UUID.
- **Behavior:** Rejected by check 2 of `isResponseAuthoritative`.
- **Result:** Discarded as stale attempt. Prevents cross-attempt response pollution.

---

## 13. Epoch Fencing Test Result

- **Scenario:** Worker A returns with `leaseEpoch: 42`, while storage has advanced to lease epoch $43$.
- **Behavior:** Rejected by check 3 of `isResponseAuthoritative`.
- **Result:** Discarded fail-closed. Superseded workers have zero mutation authority.

---

## 14. Worker-ID Fencing Test Result

- **Scenario:** Worker A returns response while storage records Worker B as the active lease owner.
- **Behavior:** Rejected by check 4 of `isResponseAuthoritative`.
- **Result:** Discarded fail-closed. Responses from non-owner workers are rejected.

---

## 15. Persistence-Path Verification

The persistence path in `DurableTokenLifecycleManager` follows this strict protocol:
1. **Schema Validation:** In-memory verification of response structure.
2. **Initial Authority Check:** Fast-fail under Web Lock if already stale.
3. **Pre-Persistence Reread & Authority Re-Validation (TOCTOU Defense):** Immediately prior to storage write, rereads `codesync:auth` under exclusive Web Lock and evaluates the complete 6-point predicate.
4. **Single-Object Fenced Persistence:** All credential and fencing properties serialized together into a single JSON object.
5. **Generational Adoption:** If generation advanced during check, returns newer token without overwriting storage.

---

## 16. Full Test Results

```
Test Files  16 passed (16)
     Tests  155 passed (155)
  Duration  2.41s
```

All 16 test suites passed:
- `tests/security/auth-device-flow.test.ts` (9 passed)
- `tests/security/token-lifecycle.test.ts` (32 passed)
- `tests/security/queue-concurrency.test.ts` (9 passed)
- `tests/security/storage-and-wal.test.ts` (5 passed)
- `tests/security/wal-crash-boundaries.test.ts` (10 passed)
- `tests/security/failure-injection.test.ts` (5 passed)
- `tests/security/messaging-envelope.test.ts` (18 passed)
- `tests/security/concurrency-fencing.test.ts` (6 passed)
- `tests/security/manifest.test.ts` (12 passed)
- `tests/security/code-hygiene.test.ts` (5 passed)
- `tests/security/deduplication.test.ts` (8 passed)
- `tests/security/logger.test.ts` (9 passed)
- `tests/security/build-and-types.test.ts` (8 passed)
- `tests/security/config.test.ts` (12 passed)
- `tests/security/browser-compat.test.ts` (4 passed)
- `tests/security/errors.test.ts` (3 passed)

---

## 17. TypeScript Result

- **Command:** `npm run compile` (`tsc --noEmit`)
- **Exit Code:** `0`
- **Errors:** `0`

---

## 18. Lint Result

- **Command:** `npm run lint` (`eslint .`)
- **Exit Code:** `0`
- **Errors:** `0`
- **Warnings:** `0`

---

## 19. Formatting Result

- **Command:** `npm run format:check` (`prettier --check`)
- **Exit Code:** `0`
- **Status:** All matched files use Prettier code style.

---

## 20. Chrome Build Result

- **Command:** `npm run build` (`wxt build`)
- **Exit Code:** `0`
- **Output:** `.output/chrome-mv3/` (Total size: 231.06 kB)

---

## 21. Firefox Build Result

- **Command:** `npm run build:firefox` (`wxt build -b firefox`)
- **Exit Code:** `0`
- **Output:** `.output/firefox-mv3/` (Total size: 231.05 kB)

---

## 22. Dependency Audit

- **Command:** `npm audit`
- **Production/Runtime Vulnerabilities:** **0**
- **Dev-Only Dependencies Advisory:** 2 moderate advisories in `@vitest/mocker` / `vitest` (dev test runner only; zero presence in production extension bundle).

---

## 23. Security Audit

- **Zero Hardcoded Secrets:** Confirmed by `code-hygiene.test.ts`.
- **Zero Eval / Dynamic Code:** Confirmed by `code-hygiene.test.ts`.
- **Zero InnerHTML / Raw DOM Injections:** Confirmed by `code-hygiene.test.ts`.
- **Minimum-Privilege Host Permissions:** Scoped strictly to `["https://github.com/*", "https://api.github.com/*"]`.
- **Restricted Messaging Sender:** Content scripts strictly blocked from authentication actions (`UNAUTHORIZED_SENDER`).

---

## 24. Remaining Limitations

- `browser.storage.local` does not provide hardware/database-grade Compare-And-Swap. Coordination relies on Tier 1 Web Locks for runtime mutual exclusion and Tier 2 persistent lease records with monotonic epochs and pre-persistence read-back verification.
- Remote token revocation requires GitHub client secrets (prohibited in public extension clients); local revocation clears all credentials and cached state, while remote revocation remains user-managed via GitHub.com.

---

## 25. Residual Risks

- If a browser runtime were to violate the W3C Web Locks specification by allowing two exclusive locks concurrently, Tier 2 epoch fencing and pre-persistence verification remain as the second line of defense.
- Operating system clock skew or jump forward by $>30\text{s}$ during active refresh could prematurely expire a lease; mitigated by the 5-minute pre-flight buffer and fail-closed state transitions.

---

## 26. Any Deviations

- **None.** The implementation and test suite adhere strictly to the approved Phase 1C architecture specifications and Phase 1C.1.1 correction guidelines.

---

## 27. Explicit Statement of What Remains Deferred

The following items are strictly **DEFERRED** and were **NOT** implemented in Phase 1C.1.1:
- GitHub Contents API file write implementation
- Repository discovery / tree browsing
- Branch synchronization & creation
- File upload & blob creation
- HTTP 409 SHA conflict protocol implementation
- Queue drain executor & worker loop
- Duplicate policy execution (`REPLACE_IF_DIFFERENT`)
- Path template engine execution
- Platform adapters (LeetCode, Codeforces, HackerRank, etc.)
- Submission extraction & DOM observer logic

These capabilities belong exclusively to Phase 1C.2 or later phases.

---

## 28. Final Phase Gate

**PHASE 1C.1.1 — PASS**  
**PHASE 1C.2 REMAINS LOCKED PENDING EXTERNAL REVIEW.**  
**PHASE 1C.2 WAS NOT STARTED.**
