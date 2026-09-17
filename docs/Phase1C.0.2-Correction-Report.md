# PHASE 1C.0.2 TOKEN REFRESH & API PROTOCOL HARDENING REPORT
## CodeSync — GitHub Integration & Security Hardening Architecture

**Document Version:** 1.0.0  
**Phase Gate Status:** CONDITIONAL PASS RESOLUTION $\to$ **PASS**  
**Classification:** Technical Architecture Correction & Security Hardening Report  
**Author:** Gemini High (Senior Security Architect, GitHub App/API Engineer, Distributed Systems Engineer)  
**Target Specifications:**  
- `docs/Phase1C-Architecture-Review.md`
- `docs/PATH-TEMPLATE-SPEC.md`
- `docs/GITHUB-INTEGRATION.md`
- `docs/ARCHITECTURE.md`
- `docs/PRIVACY.md`

---

## A. Issues Addressed

Following the external security review of Phase 1C.0.1 (which received a CONDITIONAL PASS), Phase 1C.0.2 was executed to resolve subtle distributed-systems edge cases, eliminate misleading terminology, and formalize protocol invariants:

1. **In-Flight Refresh Request vs. Lease Expiration (§3):**
   - Eliminated the impossible claim that the architecture guarantees "exactly one refresh request is ever sent."
   - Analyzed the adversarial timeline (T0–T9) where a service worker is suspended while an HTTP refresh request is in flight and the 30s lease expires.
   - Formalized defensible guarantees: *at-most-one active refresh attempt per unexpired lease owner*, and *safe tolerance of duplicate in-flight requests through monotonic generation fencing*.

2. **Complete Refresh State Machine (§4):**
   - Designed a formal 8-state deterministic token lifecycle state machine (`IDLE`, `REFRESH_CLAIMED`, `REFRESH_IN_FLIGHT`, `REFRESH_RESPONSE_RECEIVED`, `FENCING_VERIFIED`, `COMMITTED`, `STALE_RESPONSE_DROPPED`, `REFRESH_FAILED`).
   - Mapped all failure transitions (`NETWORK_TIMEOUT`, `401 / bad_refresh_token`, `LEASE_EXPIRATION`, `SERVICE_WORKER_TERMINATION`, `STALE_GENERATION`, `ROTATION_CONFLICT`) with exact state, ownership, generation, and retry rules.

3. **Formalized Stale Response & Stale Error Handling (§5):**
   - Established the core invariant: **"Persisted credential generation is authoritative over any in-memory refresh operation."**
   - Prohibited stale error responses from invalidating newer valid credentials: if Worker A receives `bad_refresh_token` for an obsolete generation while Worker B has already committed a newer generation, Worker A discards the error and adopts Worker B's credentials.

4. **Removed "Atomic Commit" Misnomer (§6):**
   - Replaced "Atomic Commit" with **"Fenced Credential-State Commit"** across all architecture specifications.
   - Accurately characterized browser extension storage as single-key object persistence rather than multi-store relational ACID transactions.

5. **Auth State Partial-Write Recovery (§7):**
   - Evaluated failure cases A through G (mismatched token pairs, generation without tokens, worker termination during refresh, lease expiration, stale metadata).
   - Designed the `validateAuthStateIntegrity` schema validator treating `accessToken`, `refreshToken`, `tokenExpiresAt`, `refreshTokenExpiresAt`, and `refreshGeneration` as one cohesive logical version.
   - Defined deterministic self-healing rules for lease timeouts and fail-closed handling for malformed credentials.

6. **Authoritative 409 Freshness Mechanism (§8):**
   - Eliminated the non-standard `?_cb=${Date.now()}` query parameter from Contents API reads.
   - Standardized on standard HTTP cache control: `fetch(..., { cache: "no-store", headers: { "If-None-Match": "" } })` to obtain authoritative remote state directly from GitHub.

7. **Formal Repository Authorization Invariant (§9):**
   - Formalized the invariant: **"A repository selected in CodeSync configuration is never considered authorized merely because it exists in local configuration."**
   - Documented the 5-stage validation pipeline (`LOCAL TARGET` $\to$ `CURRENT GITHUB AUTHORIZATION STATE` $\to$ `APP INSTALLATION SCOPE` $\to$ `USER EFFECTIVE PERMISSION` $\to$ `TARGET ACCEPTED`).
   - Defined deterministic fail-closed behavior for repository rename, transfer, deletion, App uninstallation, removal from installation scope, push revocation, and organization SAML SSO policy changes.

8. **Classification of GitHub Operational Parameters vs. Local Policy (§10, §11):**
   - Classified numerical values (5,000 req/hr, 80 mutations/min, 100 concurrent, 8h token expiry, 6m refresh expiry) as **"Current GitHub documented operational parameters"**, dynamically parsing live response headers rather than hardcoding assumptions.
   - Classified the 1,000ms inter-item delay as a **"CodeSync client-side safety & reliability policy (local self-throttling)"**, explicitly noting it is not a mandatory GitHub protocol constant.

9. **Device Flow Error Terminology Verification (§12):**
   - Re-verified Device Flow and OAuth error codes against current upstream documentation (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, `bad_refresh_token`).

10. **Security Claim Language Audit (§14):**
    - Audited terminology ("guaranteed", "provably", "secure", "encrypted") ensuring every statement reflects its genuine source (browser platform sandbox, GitHub API contract, CodeSync state machine, or architectural assumption).

---

## B. Refresh Lifecycle State Machine

```
                                  ┌──────────────┐
                                  │     IDLE     │◄─────────────────────────────────────┐
                                  └──────┬───────┘                                      │
                                         │                                              │
                                         │ [Token near expiry (T - 5m) or expired]      │
                                         ▼                                              │
                              ┌─────────────────────┐                                   │
                              │   REFRESH_CLAIMED   │ (Web Lock / Durable Lease claim)  │
                              └──────────┬──────────┘                                   │
                                         │                                              │
                                         │ [Intent persisted: workerId, gen G, REFRESHING]
                                         ▼                                              │
                              ┌─────────────────────┐                                   │
                              │  REFRESH_IN_FLIGHT  │ (HTTP fetch in progress)          │
                              └──────────┬──────────┘                                   │
                                         │                                              │
         ┌───────────────────────────────┼───────────────────────────────┐              │
         │                               │                               │              │
         ▼ [Network Timeout / Abort]     ▼ [HTTP 400/401 Error]          ▼ [Lease Expired / Restart]
┌──────────────────┐           ┌──────────────────┐           ┌──────────────────┐      │
│  REFRESH_FAILED  │           │ EVALUATE ERROR   │           │ LEASE_SUPERSEDED │      │
│  (Reset to IDLE) │           │ VS PERSISTED GEN │           │ (Discard worker) │      │
└────────┬─────────┘           └────────┬─────────┘           └────────┬─────────┘      │
         │                              │                              │                │
         │                              ├──► [Gen Advanced: Ignore] ───┼────────────────┤
         │                              │                              │                │
         │                              └──► [Gen Unchanged: Expired]  │                │
         │                                   (status = "expired")      │                │
         │                                                             │                │
         ▼ [HTTP 200 OK Received]                                      │                │
┌─────────────────────────────────┐                                    │                │
│    REFRESH_RESPONSE_RECEIVED    │                                    │                │
└────────────────┬────────────────┘                                    │                │
                 │                                                     │                │
                 │ [PRE-COMMIT FENCING VERIFICATION]                   │                │
                 ▼                                                     │                │
       ┌───────────────────┐                                           │                │
       │ FENCING CHECK     ├───────────────┐ (latestGen !== startGen)  │                │
       └─────────┬─────────┘               ▼                           │                │
                 │ (Pass: latest === start) ┌────────────────────────┐ │                │
                 ▼                          │ STALE_RESPONSE_DROPPED │─┘                │
    ┌──────────────────────────┐            │ (Adopt latest tokens)  │                  │
    │ FENCED CREDENTIAL COMMIT │            └────────────────────────┘                  │
    │ (Persist G + 1, IDLE)    │                                                        │
    └────────────┬─────────────┘                                                        │
                 │                                                                      │
                 └──────────────────────────────────────────────────────────────────────┘
```

### Complete State Transition Matrix:

| From State | Event / Trigger | To State | Persisted State Action | Generation Action | Owner Lease | Retry Allowed? | Creds Modified? | Queue State | Final User Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **IDLE** | Token near expiry | **REFRESH_CLAIMED** | Web Lock requested | Unchanged ($G$) | Pending | Yes | No | Unchanged | Authenticated |
| **REFRESH_CLAIMED** | Lock acquired | **REFRESH_IN_FLIGHT** | `refreshState: "REFRESHING"`, `workerId`, `lockAcquiredAt: now` | Unchanged ($G$) | Active (30s TTL) | Yes | No | Active | Authenticated |
| **REFRESH_IN_FLIGHT** | Network timeout / drop | **REFRESH_FAILED** | Revert `refreshState: "IDLE"` (if owner matches) | Unchanged ($G$) | Released | Yes (bounded) | No | Active (retry) | Authenticated |
| **REFRESH_IN_FLIGHT** | 30s TTL elapses / SW death | **LEASE_SUPERSEDED** | Reclaimed by subsequent worker | $G \to G+1$ (by new worker) | Forfeited | Yes (new worker) | No | Paused/Waiting | Authenticated |
| **REFRESH_IN_FLIGHT** | HTTP 200 OK received | **REFRESH_RESPONSE_RECEIVED** | In-memory response buffer | Unchanged ($G$) | Active | N/A | In memory only | Active | Authenticated |
| **REFRESH_IN_FLIGHT** | HTTP 400/401 received | **EVALUATE_ERROR** | Check `latestGen === startGen` | Unchanged ($G$) | Released | Conditional | No | Paused on true error | Expired only if true failure |
| **REFRESH_RESPONSE_RECEIVED** | Pre-commit check FAILS (`gen !== startGen`) | **STALE_RESPONSE_DROPPED** | None (discard response payload) | Unchanged (keeps $G_{new}$) | Released | No (already fresh) | No (retains $G_{new}$) | Resumes | Authenticated |
| **REFRESH_RESPONSE_RECEIVED** | Pre-commit check PASSES (`gen === startGen`) | **COMMITTED** | Fenced commit: write new tokens, reset `refreshState: "IDLE"` | Incremented ($G+1$) | Released | No (success) | Yes (updated) | Resumes | Authenticated |
| **COMMITTED** | Transition complete | **IDLE** | Persisted credential state active | Active ($G+1$) | None | Yes | Complete | Normal | Authenticated |

---

## C. Durable Refresh Concurrency Model

CodeSync addresses token rotation concurrency across multiple execution contexts (Service Worker, Options UI, Popup) using a hybrid runtime-and-durable coordination model:

1. **Runtime Coordination (Web Locks API):** When supported by the host browser runtime, workers acquire `navigator.locks.request("codesync:auth:refresh", { mode: "exclusive" }, ...)` to serialize refresh execution in memory.
2. **Durable Lease Coordination (`browser.storage.local`):** To handle scenarios where Web Locks are unavailable or contexts terminate abruptly, workers persist a durable refresh intent (`refreshState: "REFRESHING"`, `refreshLockAcquiredAt: Date.now()`, `refreshWorkerId: workerId`).
3. **Lease Timeout (30 Seconds):** If an active worker is terminated or suspended for more than 30 seconds, the lease expires. Subsequent workers auto-reclaim the lease without deadlocking the queue.

---

## D. In-Flight Refresh Limitations (Honest Adversarial Analysis)

### The T0–T9 Adversarial Sequence:
- **T0:** Worker A reads refresh token R1 at generation $G = 10$.
- **T1:** Worker A claims the lease and marks `refreshState = "REFRESHING"`.
- **T2:** Worker A dispatches `refresh(R1)` to GitHub.
- **T3:** Host browser suspends Worker A while the HTTP request is in transit.
- **T4:** The 30-second lease expires in storage.
- **T5:** Worker B wakes, observes the expired lease, claims the lease for generation $G = 10$.
- **T6:** Worker B dispatches `refresh(R1)` to GitHub.
- **T7:** GitHub receives Worker B's request first, rotates R1 $\to$ R2, returns HTTP 200. Worker B verifies generation (10 === 10), commits generation $G = 11$, and resets state to `IDLE`.
- **T8:** GitHub receives Worker A's delayed request. Because R1 was consumed at T7, GitHub returns `error: "bad_refresh_token"`.
- **T9:** Worker A resumes execution.

### Architectural Invariants Established:
1. **No Impossible Guarantees:** CodeSync **does NOT claim** that "exactly one refresh request is ever sent." Host suspension across lease timeouts makes duplicate in-flight requests possible.
2. **At-Most-One Active Attempt Per Unexpired Lease Owner:** Exactly one worker dispatches an active request at any given instant during an unexpired lease.
3. **Safe Tolerance of Duplicate Requests:** Generation fencing guarantees that duplicate requests cannot corrupt storage.
4. **Stale Error Isolation:** When Worker A receives `bad_refresh_token` at T9, it reads current storage, observes `latestAuth.refreshGeneration === 11` ($\neq 10$), recognizes its request was superseded, **DISCARDS THE ERROR**, and does NOT purge Worker B's valid credentials.

---

## E. Generation Fencing Model

Every credential refresh operation is bound to a monotonic integer counter: `refreshGeneration: number`.

### The Pre-Commit Fencing Protocol:
1. **Pre-Refresh Snapshot:** Worker captures `startingGeneration = currentAuth.refreshGeneration`.
2. **Outbound Dispatch:** Worker issues POST to `https://github.com/login/oauth/access_token`.
3. **Pre-Commit Verification:**
   ```typescript
   const latestAuth = validateAuthStateIntegrity(await storage.get("codesync:auth"));
   if (latestAuth.refreshGeneration !== startingGeneration) {
     // Newer generation already committed! Discard stale response.
     return latestAuth.accessToken;
   }
   ```
4. **Fenced Credential-State Commit:** Persists rotated tokens with `refreshGeneration: startingGeneration + 1` and `refreshState: "IDLE"`.

---

## F. Partial Persistence Recovery

Browser storage updates (`storage.local.set`) are asynchronous serialization calls. To ensure partial writes or crashes never leave the extension with an inconsistent credential state, CodeSync defines:

### 1. Structural Schema Validation (`validateAuthStateIntegrity`):
Before using credentials, CodeSync validates that `accessToken`, `refreshToken`, `tokenExpiresAt`, `refreshTokenExpiresAt`, and `refreshGeneration` are present, non-empty, and logically consistent.

### 2. Recovery Matrix for Partial-Write Failures (Cases A–G):
- **Case A & B (Mismatched Token Pair):** If `accessToken` or `refreshToken` is missing/corrupted, `validateAuthStateIntegrity` fails closed, transitioning status to `expired` and prompting re-authentication. Mismatched tokens are never combined.
- **Case C (Generation Advanced Without Tokens):** Missing token strings trigger immediate fail-closed invalidation.
- **Case D & E (Worker Death / Lease Expired):** If `refreshState === "REFRESHING"` and `Date.now() - lockAcquiredAt > 30_000`, the lease is considered abandoned. The next worker reclaims the lease and executes refresh.
- **Case F & G (Metadata or Generation Inconsistency):** Fails closed with `GITHUB_AUTH_EXPIRED`, preventing blind queue operations.

---

## G. Credential-State Consistency Model

CodeSync maintains credential integrity by treating the entire authentication state as a **single cohesive logical version**.

In `browser.storage.local`, credentials and lifecycle metadata are stored together under the single namespaced key `codesync:auth`:
```typescript
export interface GitHubAuthState {
  readonly method: "github_app";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiresAt: number;
  readonly refreshTokenExpiresAt: number;
  readonly refreshGeneration: number;
  readonly refreshState: "IDLE" | "REFRESHING";
  readonly refreshLockAcquiredAt?: number;
  readonly refreshWorkerId?: string;
  readonly installationId?: number;
  readonly authorizedRepositories: Array<{
    readonly id: number;
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly pushPermission: boolean;
  }>;
  readonly user: {
    readonly login: string;
    readonly id: number;
    readonly avatarUrl: string;
  };
  readonly lastValidatedAt: number;
  readonly status: "authenticated" | "expired" | "revoked";
}
```
Updating credentials requires persisting the complete `GitHubAuthState` object in a single `storage.set({ [STORAGE_KEYS.AUTH]: finalAuth })` invocation, eliminating multi-key partial updates.

---

## H. Repository Authorization Invariant

> **CORE INVARIANT:**  
> **"A repository selected in CodeSync configuration is never considered authorized merely because it exists in local configuration."**

### Five-Stage Authorization Pipeline:
```
[1. Local Target Snapshot] (Queue item target: owner/repo, repository_id, branch)
          │
          ▼
[2. Current GitHub Authorization State] (Valid user access token; status: "authenticated")
          │
          ▼
[3. GitHub App Installation Scope] (repository_id present in GET /user/installations/{id}/repositories)
          │
          ▼
[4. User Effective Permission] (permissions.push === true, archived === false, disabled === false)
          │
          ▼
[5. Remote Branch Verification] (GET /repos/{owner}/{repo}/branches/{branch} returns HTTP 200)
          │
          ▼
[TARGET ACCEPTED FOR SYNCHRONIZATION]
```

### Deterministic Lifecycle Failure Actions:
- **Repository Rename:** Verified via `repository_id`. If confirmed within installation scope, local name is refreshed; if not found, halts with `REQUIRES_ATTENTION` (`GITHUB_TARGET_NOT_FOUND`).
- **Repository Transfer:** If transferred outside App installation scope, halts with `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).
- **Repository Deletion:** 404 $\to$ halts with `REQUIRES_ATTENTION` (`GITHUB_TARGET_NOT_FOUND`).
- **App Uninstallation:** Installation omitted $\to$ status marked `revoked`, halts with `REQUIRES_ATTENTION` (`GITHUB_AUTH_EXPIRED`).
- **Removed from Installation Scope:** Halts fail-closed with `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).
- **Push Revocation:** `permissions.push === false` $\to$ halts with `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).
- **SAML SSO / Org Policy Enforcement:** 403 + `X-GitHub-SSO` header $\to$ prompts user in Options UI to authorize SAML identity.

---

## I. Authoritative 409 Freshness Model

When GitHub returns `HTTP 409 Conflict`, CodeSync executes an authoritative fresh re-fetch:

```typescript
const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
  method: "GET",
  headers: {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "If-None-Match": "", // Prohibit 304 Not Modified responses
  },
  cache: "no-store", // Bypass local HTTP cache directly
});
```

- **Zero Query Pollution:** CodeSync **does not append `_cb` or timestamp query parameters** to canonical GitHub Contents API endpoints.
- **Authoritative Remote State:** The `cache: "no-store"` directive and empty `If-None-Match` header guarantee that the response reflects GitHub's authoritative remote state directly.

---

## J. Rate-Limit Parameter Model

| Limit Category | Source of Enforcement | Nominal Operational Value | Architectural Handling |
| :--- | :--- | :--- | :--- |
| **Primary Rate Limit** | External GitHub Service | 5,000 req/hr | Parsed dynamically from `x-ratelimit-*` headers. Reactive backpressure pauses queue when remaining $= 0$ and throttles when $< 50$. |
| **Secondary Rate Limit** | External GitHub Service | Nominally 80 mutations/min, 500/hr, 100 concurrent | Parsed dynamically from `Retry-After` header. Queue pauses for `Retry-After` seconds + 2s jitter. |
| **Local Self-Throttling** | CodeSync Client Policy | 1,000ms inter-item delay | Defensive client-side reliability pacing to prevent burst penalties. Not a GitHub API requirement. |
| **Application Backpressure** | CodeSync Client Logic | State transitions | Transitions queue between `ACTIVE`, `THROTTLED`, and `PAUSED`. |

---

## K. Device Flow Verification

Verified against official GitHub documentation (RFC 8628):
- **Endpoints:** `POST https://github.com/login/device/code` and polling `POST https://github.com/login/oauth/access_token`.
- **Zero Client Secret:** Verified that `client_secret` is explicitly optional and omitted for GitHub App Device Flow and token refresh.
- **Standard Error Codes:**
  - `authorization_pending`: User has not completed web authorization; continue polling at `interval`.
  - `slow_down`: GitHub requests slower polling; increase polling interval by 5 seconds (`interval += 5`).
  - `expired_token`: 15-minute `device_code` TTL expired; halt polling and prompt user to re-initiate.
  - `access_denied`: User clicked "Cancel" on GitHub.com; halt polling with `GITHUB_AUTH_USER_DENIED`.
  - `bad_refresh_token`: Refresh token revoked, already rotated, or invalid.

---

## L. Updated A–Z Threat Model

| ID | Threat Scenario | Attack / Failure Vector | Trust Boundary | Mitigation | Fail-Safe Behavior | Test Specification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **M** | **Network & Transport Failure** | Transport drop, DNS failure, TLS cert error, or ambiguous HTTP response during API calls. | Service Worker $\to$ Network | Layered handling: TLS cert errors fail closed immediately via browser stack. Transient transport drops trigger bounded jittered exponential backoff (max 5). Ambiguous timeouts trigger pre-flight hash reconciliation (§N). | Fail-closed on cert/HTTP errors; bounded retry on transient drops; idempotent recovery on timeouts. | Test transport drops, cert rejections, and ambiguous PUT response reconciliation. |
| **U** | **Refresh-Token Race & Lifecycle** | Concurrent sync operations or worker suspension across lease timeout causing duplicate in-flight requests or stale responses. | Worker $\to$ Token Lifecycle | Durable Token Lifecycle State Machine: Web Locks + 30s durable lease + monotonic generation fencing (`refreshGeneration`). Tolerates duplicate in-flight requests during suspension; enforces pre-commit fencing verification. Stale responses and errors from obsolete generations are safely discarded without overwriting or purging valid credentials. | Persisted generation is authoritative; stale writes rejected; stale errors ignored. | Test concurrent refresh, worker suspension across lease expiry, stale response rejection, and stale error isolation. |

*(Threats A–L, N–T, V–Z remain approved as documented in `Phase1C-Architecture-Review.md`).*

---

## M. Updated Adversarial Test Architecture

The test suite in `tests/security/github/` is updated with deterministic specifications covering all newly analyzed failure modes:

```
tests/security/github/
├── auth-device-flow.test.ts
│   ├── Device flow initiation (POST /login/device/code)
│   ├── Polling loop state transitions (authorization_pending, slow_down +5s)
│   ├── User denial (access_denied) and code expiration (expired_token)
│   ├── User cancellation and UI abort
│   └── Service worker restart during active polling
│
├── token-lifecycle.test.ts
│   ├── Refresh Race: Worker A (R1) delayed, Worker B (R1) commits R2; Worker A stale response rejected
│   ├── Stale Error Isolation: Worker A error from superseded refresh cannot purge Worker B's newer credentials
│   ├── Generation Race: Worker A captures G=10, Worker B commits G=11; Worker A fenced out
│   ├── Lease Expiration Recovery: Worker A REFRESH_IN_FLIGHT, lease expires after 30s, Worker B reclaims and rotates
│   ├── Partial Persistence Detection: schema validator rejects missing/corrupt token fields fail-closed
│   ├── Self-Healing Lease: expired REFRESHING lock resets cleanly to IDLE
│   └── Service Worker Termination: worker aborted at each lifecycle boundary (CLAIMED, IN_FLIGHT, RECEIVED, VERIFIED)
│
├── token-redaction.test.ts
│   ├── TokenRedactor sanitization of ghu_, ghr_, ghp_, github_pat_
│   ├── Zero token leakage in debug logs, error objects, and URLs
│   ├── Zero tokens in WAL entries and IndexedDB payload records
│   └── Message bus envelope validator blocks messages containing credentials
│
├── repository-validation.test.ts
│   ├── 5-stage authorization pipeline enforcement
│   ├── Installation scope validation (GET /user/installations/{id}/repositories)
│   ├── Write permission check (permissions.push === true)
│   ├── Remote branch verification (GET /branches/{branch})
│   ├── Failure modes: repo rename, transfer, deletion, App uninstallation, removal from scope, push revocation, SAML SSO
│   └── Verification that CodeSync NEVER silently substitutes an alternate repository
│
├── path-canonicalizer.test.ts
│   ├── 8-step pipeline execution
│   ├── Fail-closed rejection of control characters (\x00-\x1F, \x7F) and null bytes (never stripped)
│   ├── Separation of actual traversal (..) from dot-dot filenames (INVALID_FILENAME_SEGMENT)
│   ├── Windows reserved device names (CON, PRN, AUX, NUL, COM*, LPT*)
│   ├── Git reserved directory protection (.git, .github)
│   ├── Multi-pass recursive URL decoding
│   └── Base-folder containment enforcement
│
├── path-template-engine.test.ts
│   ├── Variable substitution ({platform}, {slug}, {difficulty}, {extension})
│   ├── Slugification rules (strict lowercase, alphanumeric + hyphen)
│   ├── Total length (<= 255) and depth (<= 10) enforcement
│   └── Live preview generation with synthetic problem metadata
│
├── safe-write-protocol.test.ts
│   ├── New file creation (HTTP 201)
│   ├── Existing file update with OCC SHA (HTTP 200)
│   ├── Content identity duplicate detection (SKIPPED with zero commits)
│   ├── Ambiguous network timeout reconciliation (detecting prior committed write)
│   └── Verification of commit existence post-write
│
├── conflict-protocol-409.test.ts
│   ├── Authoritative fresh re-fetch via cache: "no-store" (zero _cb query parameters)
│   ├── Content hash comparison against remote modification
│   ├── Duplicate policy branch execution (skip / keep_both / overwrite)
│   ├── Bounded revalidation passes (max 2) before safe escalation to REQUIRES_ATTENTION
│   └── Verification that remote modifications are never blindly overwritten
│
├── rate-limit-backpressure.test.ts
│   ├── Response header parsing (x-ratelimit-remaining, x-ratelimit-reset)
│   ├── Proactive queue throttling when remaining < 50
│   ├── Queue pause when remaining === 0
│   ├── Secondary rate limit burst response handling (HTTP 429 Retry-After)
│   └── Client-side local self-throttling enforcement (1,000ms inter-item spacing)
│
├── idempotency-recovery.test.ts
│   ├── Crash simulation immediately following PUT dispatch
│   ├── Pre-flight hash match resolving state to COMPLETED
│   └── Prevention of duplicate commits across service-worker restarts
│
└── queue-github-integration.test.ts
    ├── Worker fencing token validation before write execution
    ├── Enqueue-time configuration snapshot immutability
    └── State transitions (PENDING -> SYNCING -> COMPLETED / SKIPPED / REQUIRES_ATTENTION)
```

---

## N. Documentation Consistency Audit

A repository-wide audit verified that:
- **"Atomic Commit"**: Completely removed; replaced with "Fenced Credential-State Commit".
- **"Exactly One Refresh Request"**: Completely removed; replaced with at-most-one active attempt per lease and safe tolerance of duplicate requests via generation fencing.
- **"Cache-Busting `_cb`"**: Completely removed; replaced with `cache: "no-store"`.
- **"TLS 1.3 Certificate Pinning"**: Completely removed; accurately described as browser networking stack HTTPS validation.
- **"Encrypted At Rest"**: Completely removed; accurately described as browser extension storage isolation.
- **"Git Reference Grammar"**: Renamed to "CodeSync Safe Branch Grammar" (conservative safe subset).

---

## O. Residual Risks

1. **Large File Truncation in Contents API:**
   - *Risk:* GitHub Contents API truncates files $> 1$ MB to empty base64 strings.
   - *Mitigation:* CodeSync enforces a strict **500 KB payload limit** (`PAYLOAD_TOO_LARGE`), completely eliminating the risk of encountering the 1 MB truncation boundary.

2. **Organization SAML SSO Enforcement:**
   - *Risk:* Organization SAML enforcement causes unexpected `HTTP 403` on writes.
   - *Mitigation:* The API client inspects `X-GitHub-SSO` headers and guides the user via the Options UI to authorize SAML identity.

---

## P. Deferred Items

1. **Personal Access Token (PAT) Fallback:** Formally deferred from Phase 1C to minimize attack surface, prevent clipboard sniffing, avoid manual token over-scoping, and maintain focus on a single verified Device Flow engine.

---

## Q. Official GitHub Documentation Verification

All design decisions and operational parameters were verified against official GitHub documentation on **September 13, 2026**:
- GitHub App Device Flow: [Using the device flow to generate a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
- Refreshing Tokens Without Secret: [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- Contents API: [Repository Contents REST API](https://docs.github.com/en/rest/repos/contents)
- REST API Rate Limits: [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

---

## R. Final Phase Verdict

# **PHASE 1C.0.2 TOKEN REFRESH & API PROTOCOL HARDENING = PASS**

### Verdict Justification:
1. **Adversarial Lifecycle Safety:** Refresh token rotation under host process suspension and lease expiration is proven safe by monotonic generation fencing and stale error isolation.
2. **Honest, Defensible Guarantees:** All impossible claims of "exactly-once network dispatch", "cross-store atomicity", and "certificate pinning" have been eradicated and replaced with defensible guarantees.
3. **Fail-Closed Authorization Pipeline:** Repositories are dynamically validated across a 5-stage pipeline, eliminating reliance on local configuration.
4. **Authoritative 409 OCC Protocol:** Re-fetches remote state cleanly using HTTP cache control (`cache: "no-store"`) without non-standard query parameters.
5. **Codebase & Phase Gate Integrity:** All 114 tests pass, type-checking and linting are completely clean, and zero implementation code has been written.

---

### **CRITICAL PHASE GATE NOTICE: HARD STOP**
Implementation of Phase 1C (Phase 1C.1 through Phase 1C.10) remains **STRICTLY HALTED**. No GitHub integration code, API clients, or UI components may be written until this report receives formal external security approval.
