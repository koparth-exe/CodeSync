# GitHub Integration & Safe Write Protocol Specification
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Technical Architecture Specification

---

## 1. Authentication Architecture: GitHub App + Device Flow

### 1.1 Primary Method: GitHub App User-to-Server Authorization

CodeSync adopts a **GitHub App** architecture utilizing the **OAuth Device Authorization Flow** for user-to-server tokens.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. User clicks "Connect GitHub" in CodeSync Options                         │
│    Service Worker initiates Device Authorization Flow:                       │
│    POST https://github.com/login/device/code                                │
│    Body: { client_id: "<GITHUB_APP_CLIENT_ID>" }                           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. GitHub returns:                                                          │
│    { device_code, user_code, verification_uri, interval, expires_in }       │
│    Service Worker stores device_code in session memory (not storage).        │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Extension opens tab to https://github.com/login/device                   │
│    Options UI displays user_code with "Copy Code" helper.                   │
│    User enters user_code on GitHub's secure domain.                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. GitHub Authorization & Repository Installation:                          │
│    • User authorizes the GitHub App.                                        │
│    • GitHub prompts user for repository access:                              │
│      - Option A: "All repositories"                                         │
│      - Option B: "Only select repositories" (RECOMMENDED)                   │
│    • Permissions granted: Repository Contents permission sufficient for read and write. │
│    • Zero access to Issues, Pull Requests, Workflows, Admin, or Orgs.       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Service Worker polls POST https://github.com/login/oauth/access_token     │
│    Body: { client_id, device_code, grant_type: "device_code" }              │
│    Respects polling `interval` header (default 5s) to avoid slow_down.       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. GitHub issues User Access Token:                                         │
│    { access_token: "ghu_...", expires_in: 28800,                            │
│      refresh_token: "ghr_...", refresh_token_expires_in: 15552000 }         │
│    Stored securely in browser.storage.local (Never exposed to web/scripts).  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Why GitHub App is Preferred Over Legacy OAuth App & PAT

| Dimension | Legacy OAuth App | Personal Access Token (PAT) | **GitHub App (CodeSync Architecture)** |
|---|---|---|---|
| **Permission Scope** | Monolithic (`repo` scope grants full read/write to all repos, issues, hooks, admin) | Classic PAT has identical monolithic risks; Fine-grained PAT requires manual setup | **Strictly Fine-Grained**: Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions |
| **Repository Selection** | All public and private repositories accessible by user account | Classic PAT: All repos; Fine-grained PAT: Selected repos (manual configuration) | **Built-in Repository Isolation**: User explicitly chooses "Only select repositories" during install |
| **Token Lifespan** | Indefinite (lives forever until manual revocation) | Configurable (often set to "No expiration" by users for convenience) | **8-Hour Expiry**: User access tokens expire in 8 hours; rotated automatically via refresh token |
| **User Experience** | Simple device flow, but leaves lingering broad access token | Severe friction: requires navigating developer settings, configuring scopes, copy-pasting | **Seamless & Secure**: Native device flow with browser-guided repository selection |
| **Attack Blast Radius** | If token is stolen, attacker has full access to user's entire GitHub identity | Stolen PAT exposes entire account or broad repo set | Stolen token expires in ≤8h and only has access to write contents in designated repo |

### 1.3 Personal Access Token (PAT) Fallback: DEFERRED FOR PHASE 1C

Per the Phase 1C Architecture & Security Design Review, **Personal Access Token (PAT) support is formally DEFERRED**. All Phase 1C implementations and reviews focus exclusively on GitHub App + Device Authorization Flow (RFC 8628) to eliminate static credential attack vectors, unrotated tokens, and manual scoping errors. PAT support may only be revisited in future phases if strict enterprise firewall requirements demand a manual fallback.

---

## 2. Token Lifecycle & Storage Specification

### 2.1 Storage Model & Attempt Record

Authentication credentials and durable attempt metadata are stored exclusively within the extension's private `browser.storage.local` storage area under the namespaced key `codesync:auth`:

```typescript
export type AttemptState =
  | "CREATED"
  | "IN_FLIGHT"
  | "SUCCESS_RECEIVED"
  | "COMMITTED"
  | "ERROR_RECEIVED"
  | "UNKNOWN"
  | "SUPERSEDED"
  | "RECONCILIATION_REQUIRED"
  | "REAUTH_REQUIRED";

export type AttemptResolutionStatus =
  | "in_flight"
  | "committed"
  | "dropped_stale"
  | "unknown"
  | "reconciliation_required"
  | "reauth_required";

export interface RefreshAttemptRecord {
  readonly attemptId: string;                     // Cryptographic UUID (A)
  readonly credentialGeneration: number;          // Target credential version (G)
  readonly leaseEpoch: number;                    // Durable lease epoch (E)
  readonly workerId: string;                      // Worker that dispatched request
  readonly startedAt: number;                     // Unix ms
  readonly leaseExpiresAt: number;                // Unix ms (startedAt + 30s)
  readonly state: AttemptState;                   // Granular attempt state
  readonly resolutionStatus: AttemptResolutionStatus;
  readonly errorClassification?: string | undefined; // Non-sensitive category (zero secrets)
}

export interface GitHubAuthState {
  readonly method: 'github_app';
  readonly status: 'authenticated' | 'expired' | 'revoked' | 'reconciliation_required' | 'reauth_required';
  readonly accessToken: string;          // Bearer token (ghu_...)
  readonly refreshToken: string;         // Rotating refresh token (ghr_...)
  readonly tokenExpiresAt: number;       // Unix ms
  readonly refreshTokenExpiresAt: number; // Unix ms
  readonly refreshGeneration: number;    // Monotonically increasing version counter (G)
  readonly refreshState: 'IDLE' | 'REFRESHING' | 'RECONCILIATION_REQUIRED';
  readonly activeAttempt?: RefreshAttemptRecord | undefined; // Current in-flight attempt (A)
  readonly predecessorAttempts: ReadonlyArray<RefreshAttemptRecord>; // Bounded audit history (max 5)
  readonly refreshLeaseEpoch: number;   // Monotonic lease ownership epoch counter (E)
  readonly refreshWorkerId?: string | undefined;
  readonly refreshLockAcquiredAt?: number | undefined;
  readonly refreshLeaseExpiresAt?: number | undefined;
  readonly installationId?: number;      // GitHub App Installation ID
  readonly authorizedRepositories: ReadonlyArray<string>; // ["owner/leetcode-solutions"]
  readonly user: {
    readonly login: string;
    readonly id: number;
    readonly avatarUrl: string;
  };
  readonly lastValidatedAt: number;
  readonly authenticatedAt: number;
}
```

### 2.2 Token Refresh & Rotation Protocol (Authoritative Response Fencing & Lease-Expiry Revocation)

1. **Core Security Invariant**: If CodeSync cannot prove which refresh attempt is authoritative, it **MUST NOT** mutate or purge credential state. Uncertainty must never be converted into credential destruction.
2. **Network Request Lifetime vs. Local Mutation Authority**:
   - $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$
   - $\text{NETWORK SUCCESS} \neq \text{PROOF OF LOCAL MUTATION AUTHORITY}$
   - An already-dispatched network request may complete after worker suspension, restart, or lease expiry. However, **once the durable refresh lease (30s TTL) expires, the previous worker has permanently and irrevocably lost mutation authority for that refresh attempt**, regardless of whether an already-dispatched network request later succeeds.
   - Zero fixed grace periods may restore or revive authority. A late-arriving HTTP 200 response from a stale worker is dropped fail-safe (`STALE_RESPONSE_DROPPED`).
3. **Tripartite Authority Model**: Refresh operations separate Credential Generation ($G$), Refresh Attempt Identity ($A$, UUID), and Durable Lease Epoch ($E$).
4. **Authoritative Response Fencing (`isResponseAuthoritative`)**: Commits and state transitions require passing the full 6-point authority predicate before any mutation is permitted:
   - `credentialGeneration` matches (verifies credential-state lineage)
   - active `attemptId` matches (identifies specific in-flight attempt UUID)
   - `refreshLeaseEpoch` matches (verifies lease ownership epoch)
   - `refreshWorkerId` matches (verifies claiming worker identity)
   - `refreshState === "REFRESHING"` (verifies lifecycle state machine permits response)
   - `Date.now() <= refreshLeaseExpiresAt` (verifies durable lease unexpired)
   If any check fails, the response is discarded as `STALE_RESPONSE_DROPPED` with zero credential mutation.
5. **Single-Object Fenced Credential-State Persistence**:
   All credential fields are committed together to `browser.storage.local` under `codesync:auth` as a single logical JSON document under fencing verification ($G \to G + 1$). This eliminates split-state partial updates without making false claims of cross-store or cross-system database atomicity.
6. **No Blind Token Reuse & Unknown Outcome**: A local timeout or lease expiration is **NOT** proof of refresh failure ($\text{TIMEOUT} \neq \text{PROOF OF FAILURE}$). If an attempt's outcome is uncertain across lease boundaries, it is marked `UNKNOWN` / `RECONCILIATION_REQUIRED`. An uncertain rotating refresh token **MUST NEVER** be blindly reused.
7. **Same-Generation Error Isolation**: If an error (e.g. `bad_refresh_token`) is received while an uncommitted predecessor attempt was in flight for the same generation, CodeSync transitions to `RECONCILIATION_REQUIRED` and preserves valid credentials.
8. **Safe Terminal Re-Authentication**: If credential validity cannot be safely established with certainty, CodeSync fails closed to `REAUTH_REQUIRED`, preserving user configuration, templates, and queued submissions rather than destroying or guessing credential state.

### 2.3 Revocation Protocol (Disconnect)

When the user clicks "Disconnect GitHub":
1. Service worker executes local disconnect by clearing `codesync:auth` in `browser.storage.local`, resetting in-memory cached credentials, and setting status to `unauthenticated`.
2. Remote OAuth application revocation endpoints (`DELETE /applications/{client_id}/grant`) require client-secret Basic authentication, which is strictly prohibited in public client browser extensions (zero embedded secrets). Remote token revocation is managed upstream by the user via GitHub.com (Settings -> Authorized GitHub Apps), while local credentials and cached state are wiped fail-closed.
3. Locally clears cached repository lists, branch metadata, and in-memory credential references.
4. Non-authentication user configuration (target branch, folder templates, queue metadata) is preserved.

---

## 3. Validated Transactional Write Protocol with Optimistic Concurrency Control

### 3.1 Non-Atomicity Invariant & Concurrency Reality

> **Critical Architecture Invariant**:
> The complete multi-request synchronization workflow is **NOT a single atomic transaction**.
> Because it encompasses multiple distinct asynchronous HTTP network operations (repository/branch verification, pre-flight content retrieval, optimistic PUT file write, and commit verification), another actor, process, or browser tab may modify the target repository between these operations.
>
> CodeSync models this interaction as a **validated transactional write protocol with optimistic concurrency control**, rather than an atomic database transaction. Data integrity is enforced via pre-condition validation, optimistic SHA checks, duplicate policy revalidation, and explicit conflict resolution.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. Validate Target Repository Identity                                      │
│    • Verify owner/repo matches configured repository regex.                 │
│    • Verify repository is present in user's authorized repository list.     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Validate Target Branch                                                   │
│    • Verify branch name does not contain control chars, spaces, or '..'.    │
│    • Verify branch exists via cached GET /repos/{owner}/{repo}/branches.    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Deterministic Path Canonicalization & Boundary Check                     │
│    • Canonicalize via 8-step pipeline; validate against safe path grammar.  │
│    • Ensure path strictly resides inside repository base-folder boundary.   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Validate Submission Content & Encoding                                   │
│    • Verify sourceCode is valid UTF-8 text; reject binary content/null bytes.│
│    • Enforce maximum file size (500 KB).                                    │
│    • Compute SHA-256 hash of normalized content (LF line endings).          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Confirm Authorization & Token Freshness                                  │
│    • Check token TTL; refresh token if < 5 minutes remaining.                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. Resolve Existing File State (Remote GET)                                 │
│    • GET /repos/{owner}/{repo}/contents/{path}?ref={branch}                 │
│    • If HTTP 404: File is NEW. Existing SHA = null.                         │
│    • If HTTP 200: File EXISTS. Capture remote blob SHA and remote content.  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. Apply Duplicate Policy Check                                             │
│    • Compare content SHA-256 against remote content SHA-256.                 │
│    • If identical and policy == REPLACE_IF_DIFFERENT:                        │
│      -> Transition item to SKIPPED. HALT (Zero commits created).            │
│    • If policy == CREATE_ONLY and file exists:                              │
│      -> Transition to SKIPPED / ALREADY_EXISTS.                             │
│    • If policy == KEEP_ALL and file exists:                                 │
│      -> Compute next numeric suffix (e.g. two-sum-v2.cpp) and re-verify.    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. Execute Optimistic File Write (PUT Contents)                             │
│    • PUT /repos/{owner}/{repo}/contents/{path}                              │
│    • Body: { message, content: base64(utf8(sourceCode)), branch, sha }      │
│    • Pass `sha` parameter for existing files to enforce optimistic lock.    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 9. Handle Remote Write Response & Deterministic SHA Conflict Revalidation   │
│    • If HTTP 200/201: Write succeeded. Capture commit SHA.                  │
│    • If HTTP 409 Conflict: HALT WRITE. Execute Conflict Protocol (§3.2).    │
│      -> NEVER execute blind retry of identical PUT.                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 10. Verify Resulting Commit State                                           │
│    • Verify commit object exists via GET /repos/{owner}/{repo}/commits/{sha}│
│    • Update local queue state to COMPLETED. Cache new file SHA.             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 Hardened GitHub 409 Conflict Protocol (No Blind Retries)

When the GitHub Contents API returns `HTTP 409 Conflict`, it indicates a TOCTOU race condition: the remote file was created or updated between CodeSync's pre-flight check (Step 6) and write attempt (Step 8), making the provided blob `sha` stale.

> **CRITICAL RULE**: **CodeSync NEVER performs a blind retry of an identical PUT.** A blind retry with an updated SHA could silently overwrite code committed by the user from another machine or editor.

Instead, the synchronization engine executes the deterministic **8-Step Conflict Protocol**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DETECT CONFLICT: Intercept HTTP 409 Conflict from PUT Contents API.      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. HALT WRITE: Stop write attempt. Increment item conflict counter.         │
│    If conflict counter > 2: Halt immediately, mark REQUIRES_ATTENTION.      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. RE-FETCH REMOTE STATE: Execute fresh GET /contents/{path}?ref={branch}.  │
│    Bypass local ETag/SHA cache to guarantee fresh remote metadata.          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. OBTAIN LATEST METADATA: Extract latest remote blob SHA and decode         │
│    remote file content from base64.                                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. RECOMPUTE CONTENT HASH: Compute SHA-256 of decoded remote content with   │
│    normalized LF line endings.                                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. RE-EVALUATE CONFIGURED CONFLICT/DUPLICATE POLICY:                        │
│    • If remote SHA-256 === local SHA-256 (identical content):               │
│      -> The remote file already contains this exact solution.               │
│      -> Transition item to SKIPPED. HALT. Zero further writes.              │
│    • If policy == CREATE_ONLY:                                              │
│      -> File now exists; mark SKIPPED / ALREADY_EXISTS. HALT.               │
│    • If policy == KEEP_ALL:                                                 │
│      -> Generate next numeric suffix (e.g. two-sum-v2.cpp) and re-route.   │
│    • If policy == REPLACE_IF_DIFFERENT or ALWAYS_REPLACE:                   │
│      -> Proceed to Step 7 only if policy explicitly permits overwrite.      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. CONDITIONAL RE-WRITE OR SAFE ESCALATION:                                 │
│    • If overwrite permitted: Execute PUT with newly obtained remote SHA.    │
│    • If second conflict occurs or policy does not cleanly resolve:          │
│      -> PRESERVE REMOTE CONTENT. DO NOT WRITE.                              │
│      -> Transition item to REQUIRES_ATTENTION with code SHA_CONFLICT.       │
│      -> Surface side-by-side diff in Options UI for explicit user decision. │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. AUDIT & LOGGING: Log structured conflict event with remote and local     │
│    content hashes (never logging raw source code).                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Comprehensive Error Taxonomy & Handling Matrix

CodeSync rigorously distinguishes error classes to prevent inappropriate retries:

| Error Category | Indicators | Root Cause | System Handling Action | Retry Behavior |
|---|---|---|---|---|
| **Transient Network Failure** | `TypeError: Failed to fetch`, DNS error, socket hangup, HTTP 500, 502, 503, 504 | Temporary connectivity drop or GitHub gateway glitch. | Jittered exponential backoff. Queue item remains `PENDING`. | Retry up to 5 attempts, then mark `REQUIRES_ATTENTION`. |
| **Rate Limit Near-Exhaustion** | `X-RateLimit-Remaining < 50` | User or extension approaching 5,000 req/hr quota. | Pause background queue drains until rate consumption cools down. | Non-blocking pause; resumes automatically. |
| **Rate Limit Exhaustion** | HTTP 403 with `X-RateLimit-Remaining: 0` | GitHub quota fully depleted. | Pause entire queue processing until timestamp in `X-RateLimit-Reset` + 5s jitter. | Paused until reset timestamp. Zero immediate retries. |
| **Authentication Failure** | HTTP 401 Unauthorized, `bad_refresh_token` | Token expired, revoked, or invalidated. | Purge credentials from storage; transition item to `REQUIRES_ATTENTION`; prompt user re-auth. | **Zero retries**. Immediate fail-closed. |
| **Authorization Failure** | HTTP 403 Forbidden (not rate-limited) | GitHub App lacks permissions or app uninstalled from target repo. | Transition item to `REQUIRES_ATTENTION` (`INSUFFICIENT_SCOPE`); prompt repo selection. | **Zero retries**. Immediate fail-closed. |
| **SHA Concurrency Conflict** | HTTP 409 Conflict | Remote file modified concurrently (TOCTOU race). | Execute **8-Step Conflict Protocol** (§3.2): re-fetch, compare hash, re-evaluate policy. | **Zero blind retries**. Max 2 revalidation passes. |
| **Target Missing** | HTTP 404 Not Found on repo or branch | Repository deleted, renamed, or branch missing. | Mark item `REQUIRES_ATTENTION` (`TARGET_NOT_FOUND`). Prompt user in options. | **Zero retries**. Immediate fail-closed. |
| **Invalid Path / Traversal** | Path canonicalizer failure, HTTP 422 | Path escaped boundary, reserved Windows name, or invalid characters. | Reject path; mark item `REQUIRES_ATTENTION` (`PATH_VALIDATION_ERROR`). | **Zero retries**. Immediate fail-closed. |
| **Unexpected Remote State** | HTTP 200 returns directory/submodule rather than blob | Target path in Git is a folder or submodule. | Mark item `REQUIRES_ATTENTION` (`TARGET_IS_DIRECTORY`). | **Zero retries**. Immediate fail-closed. |

---

## 5. Rate Limiting & GitHub API Resilience

### 5.1 Header Inspection

CodeSync inspects GitHub rate-limit headers on every response:
- `X-RateLimit-Limit`: Maximum hourly requests (5,000 for authenticated user tokens).
- `X-RateLimit-Remaining`: Remaining request allowance.
- `X-RateLimit-Reset`: Unix timestamp when quota resets.

### 5.2 Proactive Backpressure & Quota Protection

```typescript
function handleRateLimitHeaders(headers: Headers): void {
  const remaining = parseInt(headers.get('X-RateLimit-Remaining') ?? '5000', 10);
  const resetTimestamp = parseInt(headers.get('X-RateLimit-Reset') ?? '0', 10) * 1000;

  if (remaining < 50) {
    // Critical quota threshold: pause non-urgent queue processing
    const pauseDurationMs = Math.max(0, resetTimestamp - Date.now());
    QueueManager.pauseQueue(pauseDurationMs, 'GITHUB_RATE_LIMIT_NEAR_EXHAUSTION');
  }
}
```

If GitHub returns `HTTP 403` with `X-RateLimit-Remaining: 0`, the queue automatically enters paused mode until the timestamp specified in `X-RateLimit-Reset`, plus a 5-second safety jitter buffer.

---

## 6. Commit Message Templating & Security

Default Commit Template:
```
Solved {title} on {platform} [{language}]
```

### 6.1 Variable Whitelisting & Formatting
All commit message variables are strictly sanitized to prevent Git header injection, multiline carriage-return attacks, or terminal escape injection:
- Newlines (`\r`, `\n`) are stripped from all variable substitutions.
- Total commit message length is capped at **200 characters** for the summary line, with an optional body limited to **1,000 characters**.
- Non-ASCII control characters (`[\x00-\x1F\x7F]`) are stripped.
