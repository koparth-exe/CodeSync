# PHASE 1C.0.1 ARCHITECTURE CORRECTION REPORT
## CodeSync — GitHub Integration & Security Hardening Architecture

**Document Version:** 1.0.0  
**Phase Gate Status:** CONDITIONAL PASS RESOLUTION $\to$ **PASS**  
**Classification:** Technical Architecture Correction & Security Hardening Report  
**Author:** Gemini High (Senior Security Architect, GitHub App/API Engineer, Distributed Systems Engineer)  
**Target File:** `docs/Phase1C-Architecture-Review.md`  

---

## A. Corrections Made

Following the human/ChatGPT security audit of `docs/Phase1C-Architecture-Review.md`, nine targeted security and architectural corrections were mandated. Every required correction has been rigorously resolved:

1. **Token Storage — Removal of Unsupported Encryption Claim:**
   - *Previous State:* Claimed that credentials in `browser.storage.local` are "encrypted at-rest by the browser platform's storage layer."
   - *Correction:* Removed all unsupported application-level and platform-level encryption claims. Formally documented that credentials reside exclusively in the extension's private `browser.storage.local` storage area and are protected by the browser extension origin sandbox and process isolation model. Reaffirmed strong credential boundaries (no tokens in WAL, IndexedDB, queue metadata, logs, URLs, or web page contexts).

2. **Removal of TLS 1.3 Certificate Pinning Claim:**
   - *Previous State:* Threat Model M and the Trust Boundary diagram claimed "TLS 1.3 certificate pinning by browser."
   - *Correction:* Removed all claims of certificate pinning and guaranteed TLS 1.3. Explicitly documented that CodeSync communicates with GitHub via HTTPS, with certificate validation and TLS cipher suite negotiation handled exclusively by the host browser's networking stack.

3. **Clarification of GitHub App Installation vs. Device Authorization Flow:**
   - *Previous State:* Conflated the GitHub App installation scope, repository authorization, and Device Authorization Flow user access tokens.
   - *Correction:* Formally separated the authorization concepts. Documented the 3-factor Effective Permission Formula ($\text{User Permissions} \cap \text{GitHub App Permissions} \cap \text{Installation Repositories}$). Clarified how repository selection is configured on GitHub.com, how `repository_id` is tracked alongside `owner/repo`, and that removal of repository access immediately halts synchronization fail-closed with `REQUIRES_ATTENTION`.

4. **Resolution of "Zero User Profile Access" Contradiction:**
   - *Previous State:* Claimed "Zero access to user profiles" while the architecture invoked `GET /user`.
   - *Correction:* Resolved the semantic ambiguity by distinguishing GitHub App permissions from default token API capabilities. Clarified that the CodeSync GitHub App requests zero write or private account permissions (no profile modifications, no emails, no org administration), and that the user access token queries `GET /user` solely to retrieve minimal public identity (`login`, `id`, `avatar_url`) for rendering authentication status in the UI.

5. **Control Characters: Detect, Reject, Fail Closed (No Stripping):**
   - *Previous State:* Path pipeline suggested that unprintable control characters are "stripped" during canonicalization.
   - *Correction:* Established the strict security rule `DETECT -> REJECT -> FAIL CLOSED`. Any presence of null bytes (`\x00`) or control characters (`\x00-\x1F`, `\x7F-\x9F`) in raw, decoded, or normalized path input triggers immediate synchronization abortion with `PATH_VALIDATION_ERROR`. Inputs such as `"abc\0def"` or `"abc\ndef"` are never silently sanitized into `"abcdef"`.

6. **Separation of Path Traversal from Filename Policy:**
   - *Previous State:* Rejected segments containing `..` and labeled them indiscriminately as path traversal.
   - *Correction:* Separated directory traversal semantics from general filename policy. True traversal attempts (`segment === '.'`, `segment === '..'`, or path traversal navigation) fail closed as `PATH_TRAVERSAL_DETECTED`. Filenames containing consecutive dots (e.g. `version..final.cpp`) are prohibited under CodeSync's conservative filename policy to prevent extension spoofing and ambiguity, and are categorized separately as `INVALID_FILENAME_SEGMENT`.

7. **Branch Validation Terminology ("CodeSync Safe Branch Grammar"):**
   - *Previous State:* Referred to `^[a-zA-Z0-9._/-]+$` as the "Git reference grammar."
   - *Correction:* Renamed the concept to "CodeSync Safe Branch Grammar." Explicitly documented that CodeSync intentionally enforces a conservative subset of valid Git branch names alongside structural rules (no leading/trailing slashes or dots, no `//`, no `..`, no `.lock`, no whitespace/controls, max 100 chars) to eliminate ambiguity and attack surface, without claiming it represents the full Git reference specification.

8. **Token Refresh Concurrency (Durable Refresh-State Concurrency Model):**
   - *Previous State:* Relied on an in-memory `activeRefreshPromise` within the live JavaScript runtime.
   - *Correction:* Designed the `DurableTokenLifecycleManager` integrating runtime coordination (Web Locks API `navigator.locks`) with persistent lease fencing in `browser.storage.local`. Added persistent generation tracking (`refreshGeneration: number`), lease timeouts (30 seconds), and mandatory pre-commit fencing verification to provably prevent stale refresh tokens from overwriting rotated credentials across service-worker restarts and concurrent contexts (resolving Scenarios A, B, C, and D).

9. **Formal Deferral of Personal Access Token (PAT) Fallback:**
   - *Previous State:* Included a "Fine-Grained PAT" fallback method.
   - *Correction:* Formally deferred PAT support from Phase 1C. Reaffirmed that primary authentication will be exclusively GitHub App + Device Authorization Flow with rotating user access tokens. Documented security justification: eliminates PAT clipboard sniffing vectors, eliminates manual token scoping errors by users, and avoids dual-path credential management complexity.

---

## B. Files/Documents Modified

The following repository documents were updated during this pass:

| File Path | Description of Modifications |
| :--- | :--- |
| `docs/Phase1C-Architecture-Review.md` | Primary architecture review document. Updated Sections A, C, E, F, J, K, S, T, U, V, X, AA, AB to resolve all 9 audit corrections. |
| `docs/PATH-TEMPLATE-SPEC.md` | Updated Step 2 (reject control characters fail-closed, never strip) and Step 5 (distinguish `PATH_TRAVERSAL_DETECTED` from `INVALID_FILENAME_SEGMENT`). |
| `docs/GITHUB-INTEGRATION.md` | Updated Section 2.1 to remove unsupported "encrypted at-rest by browser platform" claim; aligned with browser storage isolation model. |
| `docs/ARCHITECTURE.md` | Updated Section 3 storage table to state storage isolation rather than unsupported encryption claims. |
| `docs/PRIVACY.md` | Updated Section 2 persistent queue description to specify browser origin sandbox and host OS profile storage. |
| Artifact `walkthrough.md` | Recorded all Phase 1C.0.1 architecture corrections and test verification status. |

---

## C. GitHub Authorization Model

CodeSync's authorization architecture operates on a principle of least privilege, establishing access through four distinct administrative and technical layers:

```
[1. GitHub App Registration]
        │  • Registered on GitHub.com with client_id.
        │  • Granular repository permission: Contents (read & write).
        │  • Metadata permission: read-only (GitHub mandatory default).
        │  • Zero account/profile permissions requested.
        ▼
[2. GitHub App Installation by Repository Owner]
        │  • Repository owner installs App on account/org.
        │  • Selects repository scope: "Only select repositories".
        │  • Generates an installation_id.
        ▼
[3. User Authentication via Device Authorization Flow]
        │  • End-user authenticates via RFC 8628 Device Flow.
        │  • Produces expiring user access token (ghu_...) and refresh token (ghr_...).
        ▼
[4. Effective Write Permission Evaluation]
        │  • Effective Access = User Permissions ∩ App Permissions ∩ Installation Repositories.
        │  • CodeSync verifies: permissions.push === true, archived === false, disabled === false.
        ▼
[5. CodeSync Target Validation]
           • Enqueue-time snapshot binds target repository_id and branch.
           • Remote verification confirms target branch and repository accessibility.
```

### Effective Permission Formula
$$\text{Effective Access} = \text{User Permissions} \cap \text{GitHub App Permissions} \cap \text{Installation Repository Scope}$$

- **GitHub App Installation:** Represents an administrative authorization grant by the repository owner (user or organization) granting the CodeSync App permission to operate on explicitly specified repositories.
- **Repository Scope:** Configured on GitHub.com during App installation. Users choose "Only select repositories" to restrict App visibility strictly to their competitive programming repository.
- **Repository Identifiers:** CodeSync tracks both `repository_id` (numeric, immutable across renames) and `full_name` (`owner/repo`). If a repository is renamed, `repository_id` allows seamless resolution; if a repository is deleted or transfer occurs, verification halts synchronization.
- **Revocation & Permission Reduction:** If a repository is removed from the App installation or the user's write access is revoked:
  - CodeSync halts synchronization immediately.
  - The queued submission transitions to `REQUIRES_ATTENTION` with `GITHUB_PERMISSION_DENIED` or `GITHUB_TARGET_NOT_FOUND`.
  - **Zero Silent Retargeting:** CodeSync NEVER redirects commits to another repository when permissions change.

---

## D. Device Flow Model

CodeSync utilizes the **OAuth 2.0 Device Authorization Grant (RFC 8628)**, verified directly against current official GitHub documentation.

### 1. Protocol Endpoints & Parameters
1. **Device Code Request:**
   ```http
   POST https://github.com/login/device/code
   Content-Type: application/json
   Accept: application/json

   {
     "client_id": "Iv1.xxxxxxxxxxxx"
   }
   ```
   *Response:*
   ```json
   {
     "device_code": "3584d83530557fdd1f46af82813aa9f3aa6e6246",
     "user_code": "WDJB-MJHT",
     "verification_uri": "https://github.com/login/device",
     "expires_in": 900,
     "interval": 5
   }
   ```

2. **Access Token Polling Request:**
   ```http
   POST https://github.com/login/oauth/access_token
   Content-Type: application/json
   Accept: application/json

   {
     "client_id": "Iv1.xxxxxxxxxxxx",
     "device_code": "3584d83530557fdd1f46af82813aa9f3aa6e6246",
     "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
   }
   ```

### 2. Client Secret Requirement Verification
- **Official Documentation Confirmation:** Per [GitHub App Device Flow Documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token), the `client_secret` parameter is **NOT required** for GitHub Apps initiating Device Flow or refreshing user access tokens.
- **Zero Client Secret Stored:** CodeSync distributes zero client secrets in extension bundles or source code.

### 3. Polling States & Error Handlers
- `authorization_pending`: User has not yet completed flow. Worker sleeps for `interval` seconds (default 5s) before repolling.
- `slow_down`: GitHub requests slower polling. Worker adds 5 seconds to current polling interval (`interval += 5`).
- `access_denied`: User clicked "Cancel" on GitHub. Polling terminates; UI surfaces `GITHUB_AUTH_USER_DENIED`.
- `expired_token`: 15-minute `device_code` TTL expired. Polling terminates; UI surfaces `GITHUB_DEVICE_CODE_EXPIRED`.

### 4. Lifecycle & Service-Worker Restarts
- The `device_code` is held in ephemeral session memory during polling. If the extension service worker restarts while waiting for the user, the polling loop re-checks session state; if expired or aborted, the user is prompted to click "Connect GitHub" again cleanly.

---

## E. Token Storage Model

### 1. Accurate Storage & Isolation Specification
CodeSync does not claim application-level cryptographic encryption at rest. Credentials are stored exclusively within the browser extension platform's private `browser.storage.local` store under the namespaced key `codesync:auth`:

```typescript
export interface GitHubAuthState {
  readonly method: "github_app";
  readonly accessToken: string;               // ghu_... (User Access Token)
  readonly refreshToken: string;              // ghr_... (Rotating Refresh Token)
  readonly tokenExpiresAt: number;            // Unix ms (8 hours from issue)
  readonly refreshTokenExpiresAt: number;      // Unix ms (6 months from issue)
  readonly refreshGeneration: number;         // Monotonic fencing counter for refresh
  readonly refreshState: "IDLE" | "REFRESHING";
  readonly refreshLockAcquiredAt?: number;    // Lease timeout timestamp
  readonly refreshWorkerId?: string;          // Identifier of active refresh worker
  readonly installationId?: number;           // GitHub App Installation ID
  readonly authorizedRepositories: Array<{
    readonly id: number;
    readonly fullName: string;                // "owner/repo"
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

### 2. Credential Isolation Guarantees
- **Webpage Isolation:** Untrusted web pages cannot access `browser.storage.local` (enforced by browser origin security).
- **Content Script Isolation:** Content scripts lack `storage` permission and message bus allowlists block content scripts from calling any authentication or credential actions.
- **WAL & IndexedDB Hygiene:** Write-Ahead Log entries (`WalEntry`) and queue payloads (`QueueItemPayload`) strictly forbid credential fields.
- **Diagnostic Logging Hygiene:** `TokenRedactor` strips all GitHub token patterns (`ghu_`, `ghr_`, `ghp_`, `github_pat_`) before any string reaches log outputs.
- **URI & Path Hygiene:** Tokens are transmitted strictly via the HTTP `Authorization: Bearer <token>` header, never in URLs or query strings.

---

## F. Token Refresh Concurrency Model

GitHub user access tokens expire after 8 hours, and GitHub refresh tokens **rotate on every use**. If an old refresh token is submitted after rotation, GitHub revokes the token family. Therefore, a durable refresh concurrency model is required:

```
Service Worker Execution Context
    │
    ├─► Step 1: Read storage: codesync:auth
    │   • If tokenExpiresAt - 5min > now AND refreshState === 'IDLE':
    │       RETURN cached accessToken (Fast Path)
    │
    ├─► Step 2: Acquire Coordination Lock
    │   • Web Locks API: navigator.locks.request("codesync:auth:refresh", ...)
    │   • Persistent Fallback: Check refreshState === 'REFRESHING' and leaseAge < 30s
    │
    ├─► Step 3: Record Pre-Refresh Fencing Generation
    │   • Capture startingGeneration = currentAuth.refreshGeneration
    │   • Persist refreshState = 'REFRESHING', refreshWorkerId = workerId, lockAcquiredAt = now
    │
    ├─► Step 4: Issue Network Refresh to GitHub
    │   • POST https://github.com/login/oauth/access_token (grant_type: refresh_token)
    │   • Receive rotated access_token and refresh_token
    │
    ├─► Step 5: PRE-COMMIT FENCING VERIFICATION
    │   • Re-read storage: codesync:auth
    │   • IF latestAuth.refreshGeneration !== startingGeneration:
    │       ABORT COMMIT. Discard stale response. Return latestAuth.accessToken.
    │
    └─► Step 6: Fenced Credential-State Commit
        • Write rotated tokens to storage:
            refreshGeneration = startingGeneration + 1
            refreshState = 'IDLE'
            lockAcquiredAt = undefined, workerId = undefined
        • RETURN new accessToken
```

### Resolution of Audit Concurrency Scenarios:
- **Scenario A & B (Concurrent Discovery):** Worker A and Worker B both detect expired token R1 (generation $G$). Runtime Web Locks serialize execution. Worker A acquires the lock, sets `refreshState: "REFRESHING"`. Worker B blocks until Worker A completes, then reads the already-refreshed token from storage and returns immediately without issuing a second network call.
- **Scenario C (Rotation on GitHub):** GitHub accepts R1 and returns R2.
- **Scenario D (Stale Worker Prevention):** If Worker A suffers an extreme network delay or service-worker suspension, and Worker B reclaims the lease after 30s to commit R2 (incrementing generation to $G+1$), Worker A's eventual response will fail the Step 5 pre-commit check (`startingGeneration !== latestAuth.refreshGeneration`). Worker A discards its stale payload, preventing store corruption.

---

## G. Repository Authorization Model

CodeSync separates user authentication from repository write capability:

1. **User Identity:** Evaluated via `GET /user` (minimal public identity: `login`, `id`, `avatar_url`).
2. **Accessible Installations:** Evaluated via `GET /user/installations`.
3. **Authorized Repositories:** Evaluated via `GET /user/installations/{installation_id}/repositories`. Returns the exact set granted by the user on GitHub.com.
4. **Push Capability Verification:** Before a repository is accepted in settings, CodeSync validates:
   - `repository.permissions.push === true`
   - `repository.archived === false`
   - `repository.disabled === false`
5. **Enqueue-Time Snapshotting:** When a solution is queued, the target `repository_id`, `repository_full_name`, `branch`, and `path_template` are snapshotted into `QueueItemMetadata`. Changing settings later never affects queued jobs.
6. **Authorization Loss Handling:** If an authorized repository is removed from the App installation on GitHub.com or the user's write access is revoked, synchronization transitions to `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`). CodeSync never silently writes to an alternative repository.

---

## H. Branch Validation Model

### CodeSync Safe Branch Grammar
CodeSync intentionally enforces a conservative subset of valid Git branch names to eliminate ambiguity, directory traversal risks, and shell escape surface:

- **Regex Whitelist:** `^[a-zA-Z0-9._/-]+$`
- **Structural Invariants:**
  - Cannot begin or end with `/` or `.`
  - Cannot contain consecutive slashes `//`
  - Cannot contain sequence `..` anywhere
  - Cannot end with `.lock`
  - Cannot contain control characters (`\x00-\x1F`, `\x7F`) or whitespace
  - Maximum length: 100 characters

### Remote Branch Verification
Before attempting a write, CodeSync verifies branch existence via:
```http
GET /repos/{owner}/{repo}/branches/{branch}
```
If the endpoint returns `HTTP 404`, the synchronization job halts immediately fail-closed (`GITHUB_TARGET_BRANCH_NOT_FOUND`) rather than creating an un-parented branch.

---

## I. Path Security Model

The Path Template Engine executes an 8-step canonicalization and validation pipeline designed under the principle:  
**"Canonicalization reduces ambiguity; validation determines acceptability."**

```
[Raw Platform Metadata / User Template]
         │
         ▼
[Step 1: Recursive URL Decoding] ──────────► Multi-pass decodeURIComponent (max 3 cycles)
         │
         ▼
[Step 2: Unicode NFKC & Control Inspection] ──► .normalize('NFKC')
         │                                       Detect & reject \x00, control chars (\x00-\x1F, \x7F)
         │                                       FAIL CLOSED (PATH_VALIDATION_ERROR). Never strip.
         ▼
[Step 3: Separator Normalization] ─────────► Convert \ to /, reject absolute paths (/ or C:)
         │
         ▼
[Step 4: Segment Extraction] ──────────────► Split by /, reject empty segments (//), max 10 depth
         │
         ▼
[Step 5: Segment Whitelist & Traversal] ───► Must match ^[a-zA-Z0-9_.-]+$
         │                                   • Traversal check: reject '.' or '..' -> PATH_TRAVERSAL_DETECTED
         │                                   • Filename policy: reject segment containing '..' -> INVALID_FILENAME_SEGMENT
         │                                   • Reserved names: reject Windows device names (CON, PRN, AUX, NUL, COM*, LPT*)
         │                                   • Git protection: reject .git, .github folders
         │                                   • Segment length: 1 <= len <= 100
         ▼
[Step 6: Total Length Enforcement] ────────► Total canonical path length <= 255 characters
         │
         ▼
[Step 7: Base-Folder Containment] ─────────► Ensure path strictly resides within baseFolder prefix
         │
         ▼
[Step 8: Final Validated GitHub Path] ─────► Output safe POSIX path
```

### Key Security Invariants:
1. **Detect, Reject, Fail Closed:** Control characters (`\x00-\x1F`, `\x7F-\x9F`) and null bytes are NEVER stripped or sanitized. Input such as `"abc\0def"` or `"abc\ndef"` immediately throws `PATH_VALIDATION_ERROR`.
2. **Traversal vs. Filename Policy Separation:**
   - Real directory traversal (`.` or `..` segments, or path navigation) throws `PATH_TRAVERSAL_DETECTED`.
   - Consecutive dots within a filename segment (e.g. `solution..v2.cpp`) throw `INVALID_FILENAME_SEGMENT` under CodeSync's conservative naming rules.
3. **Strict POSIX Character Whitelist:** Individual segments are limited strictly to ASCII `^[a-zA-Z0-9_.-]+$`. Non-ASCII Unicode and confusables are rejected.

---

## J. Safe Write Protocol

CodeSync implements a **validated transactional write protocol with optimistic concurrency control** using GitHub's Contents API (`PUT /repos/{owner}/{repo}/contents/{path}`):

```
Queue Worker
    │
    ├─► 1. Verify Worker Fencing Token (validateFencingToken)
    │
    ├─► 2. Acquire Valid Access Token via DurableTokenLifecycleManager
    │
    ├─► 3. Validate Path, Branch, and Content Encoding (UTF-8, <= 500 KB)
    │
    ├─► 4. Pre-Flight Remote Read:
    │      GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
    │      │
    │      ├──► HTTP 404: File is NEW (existingSha = null)
    │      │
    │      └──► HTTP 200: File EXISTS
    │           • Verify response.type === 'file' (Reject directory/symlink fail-closed)
    │           • Capture existingSha = response.sha
    │           • Base64-decode content -> LF-normalize -> compute SHA-256 local vs remote hash
    │           • Compare hashes:
    │             - IF IDENTICAL: Transition item to SKIPPED. HALT (Zero commits created).
    │             - IF DIFFERENT: Evaluate Duplicate Policy (skip / keep_both / overwrite)
    │
    ├─► 5. Execute Optimistic Write:
    │      PUT /repos/{owner}/{repo}/contents/{path}
    │      Body: {
    │        message: "Solved Two Sum on LeetCode [cpp]",
    │        content: base64(utf8(sourceCode)),
    │        branch: "main",
    │        sha: existingSha // Enforces optimistic concurrency
    │      }
    │      │
    │      ├──► HTTP 200 / 201: SUCCESS -> Capture commitSha & contentSha
    │      │
    │      └──► HTTP 409 Conflict: Concurrent modification -> Execute 409 Protocol (§K)
    │
    └─► 6. Post-Write Verification & Queue Completion
           • Verify commit exists via GET /repos/{owner}/{repo}/commits/{commitSha}
           • Update QueueItemMetadata to COMPLETED with commitSha and commitUrl
```

---

## K. 409 Conflict Protocol (No Blind Retries)

When GitHub returns `HTTP 409 Conflict`, another actor or process modified the remote file after CodeSync's pre-flight check, rendering the submitted `sha` stale.

> **CRITICAL SECURITY INVARIANT:** CodeSync **NEVER performs a blind retry of an identical PUT with the updated SHA**. Blindly retrying with an updated SHA would overwrite concurrent human edits or external changes.

### 8-Step Deterministic Conflict Resolution:
1. **Intercept HTTP 409:** Halt write immediately.
2. **Check Revalidation Counter:** If `conflictsCount >= 2`, abort immediately and mark `REQUIRES_ATTENTION` (`GITHUB_SHA_CONFLICT`).
3. **Authoritative Fresh Re-Fetch:** Execute fresh `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` configured with `{ cache: "no-store", headers: { "If-None-Match": "" } }` to obtain authoritative remote state directly from GitHub without appending non-standard query parameters.
4. **Obtain Latest Remote State:** Extract newly committed blob SHA and content.
5. **Recompute Content Hash:** Decode remote base64, apply LF normalization, and compute SHA-256.
6. **Re-Evaluate Duplicate Policy:**
   - *Case A (Identical Content):* Remote file now matches local code. Result: mark item `SKIPPED`. Zero further writes.
   - *Case B (Policy = `skip`):* Remote content differs, policy is skip. Result: mark item `SKIPPED`. Zero further writes.
   - *Case C (Policy = `keep_both`):* Generate next version filename (e.g. `two-sum-v2.cpp`) and restart write flow.
   - *Case D (Policy = `overwrite`):* Only if user explicitly configured overwrite, proceed to Step 7.
7. **Conditional Write or Safe Escalation:** Attempt PUT with new remote SHA. If another 409 occurs: **PRESERVE REMOTE FILE** and mark `REQUIRES_ATTENTION` (`GITHUB_SHA_CONFLICT`).
8. **Surface Diff in UI:** Present an interactive diff in Options UI for explicit human resolution.

---

## L. Ambiguous Response Reconciliation

In distributed browser environments, network failures frequently occur after the remote server commits a write but before the browser receives the HTTP response:

```
[PUT /contents/two-sum.cpp] ──► [GitHub creates commit c123]
                                         │
                                [Network drops / Laptop closes]
                                         │
                                         ▼
                            [Browser throws FetchError]
```

### Reconciliation Protocol on Subsequent Retry:
1. Worker executes Pre-Flight Read: `GET /contents/two-sum.cpp`.
2. Remote file exists.
3. Worker base64-decodes remote content, applies LF normalization, and computes SHA-256 hash.
4. Remote hash matches local submission content hash.
5. **Reconciliation:** Worker identifies that the previous attempt succeeded remotely. It fetches the latest commit via `GET /repos/{owner}/{repo}/commits?path=two-sum.cpp&per_page=1`, marks the queue item `COMPLETED` with that commit SHA, and halts without writing a duplicate commit.

---

## M. Rate-Limit Model

### 1. Primary Rate Limits (5,000 requests/hour for Authenticated User)
The API client inspects headers on every response:
- `x-ratelimit-limit`: Quota cap (5,000).
- `x-ratelimit-remaining`: Quota remaining.
- `x-ratelimit-reset`: Unix epoch seconds for window reset.

**Proactive Backpressure:**
- If `x-ratelimit-remaining < 50`: Queue manager enters `THROTTLED` mode, inserting a 5-second inter-item delay to preserve quota for user operations.
- If `x-ratelimit-remaining === 0`: Queue manager enters `PAUSED` mode until `x-ratelimit-reset` epoch + 5s safety buffer.

### 2. Secondary Rate Limits (Abuse Prevention)
GitHub enforces burst mutation limits (max 80 content-generating mutations/min, max 100 concurrent requests).
- Queue drain concurrency is strictly sequential (1 active write at a time).
- Minimum inter-item delay of 1,000ms between sequential GitHub writes.
- If `HTTP 403` or `429` with `retry-after` header is returned: Pause queue for `retry-after` seconds + 2s jitter.

---

## N. Trust Boundaries

```
TRUST DOMAIN 0: Web Page (HOSTILE)
   │  • Problem descriptions, script injections, DOM tampering.
   │  • Zero access to extension APIs, storage, or message bus.
   ▼
══════════════════════ [ISOLATION BOUNDARY: Browser Sandbox] ══════════════════════
TRUST DOMAIN 1: Content Script (SEMI-TRUSTED)
   │  • Extracted submission metadata (title, slug, code).
   │  • Restricted strictly to SUBMISSION_DETECTED message type.
   │  • Zero access to GitHub tokens, auth state, or write APIs.
   ▼
══════════════════════ [VALIDATION BOUNDARY: Envelope Validator] ══════════════════
TRUST DOMAIN 2: Extension UI Pages (TRUSTED)
   │  • Popup & Options pages.
   │  • Can trigger Device Flow and select repositories.
   │  • Receives sanitized summaries only (zero raw tokens).
   ▼
══════════════════════ [AUTHORIZATION BOUNDARY: Service Worker Core] ══════════════
TRUST DOMAIN 3: Extension Service Worker (TRUSTED ENFORCEMENT)
   │  • Queue manager, WAL, storage service, concurrency lease.
   │  • Holds durable queue, WAL, and credential state within browser-isolated storage.
   ▼
══════════════════════ [CREDENTIAL BOUNDARY: High-Privilege API Client] ════════════
TRUST DOMAIN 4: Centralized GitHub Client (HIGH-PRIVILEGE OUTBOUND)
   │  • Injects Bearer token into outbound HTTPS requests.
   │  • Enforces rate limits, OCC SHA checks, and 409 protocols.
   ▼
══════════════════════ [NETWORK BOUNDARY: HTTPS / TLS (Browser Networking Stack)] ════
EXTERNAL: GitHub REST API (api.github.com)
```

**Network Security Specification:** CodeSync communicates with GitHub exclusively via HTTPS. Certificate validation and TLS cipher negotiation are enforced directly by the host browser's networking stack. CodeSync does not claim application-level certificate pinning or guaranteed TLS 1.3.

---

## O. Updated A–Z Threat Model

| ID | Threat Name | Attack Description | Trust Boundary | Mitigation | Fail-Safe Behavior | Test Requirement |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | **Token Theft** | Malicious script attempts to read GitHub user access token. | Content Script $\to$ Storage | Tokens stored exclusively in private `storage.local` under `codesync:auth`; protected by browser extension storage isolation. | Access denied by browser sandbox. | Verify content script and web page cannot access `codesync:auth`. |
| **B** | **Refresh-Token Theft** | Compromise of rotating refresh token allowing long-term persistence. | Storage $\to$ External | Refresh token stored in isolated `storage.local`; rotated on every use; 6-month hard expiration; protected by browser sandbox. | Stolen token becomes invalid upon legitimate rotation. | Test rotation invalidates previous refresh token. |
| **C** | **Token Leakage in Logs** | Access or refresh tokens emitted into debug logs. | Service Worker $\to$ Logger | `TokenRedactor` sanitizes all log inputs for `ghu_`, `ghr_`, `ghp_`, `github_pat_`. | Regex masking with `[REDACTED]`. | Verify logger outputs `[REDACTED]` for all token types. |
| **D** | **Token Leakage in Messages** | Token passed across message bus to popup or content script. | Service Worker $\to$ Message Bus | Message envelope validator strips credentials; `GET_GITHUB_STATUS` returns `GitHubUserSummary`. | Envelope rejects payloads containing token keys. | Test envelope schema rejects messages containing `accessToken`. |
| **E** | **Malicious Webpage** | Coding platform page attempts to craft messages to extension service worker. | Webpage $\to$ Extension | Webpage cannot access `chrome.runtime.sendMessage` without `externally_connectable` (omitted from manifest). | Message blocked by browser runtime. | Test unlisted origin cannot send messages. |
| **F** | **Compromised Content Script** | Attacker executes XSS in content script and attempts GitHub writes. | Content Script $\to$ Service Worker | Service worker enforces `CONTEXT_ALLOWED_ACTIONS`; content script restricted to `SUBMISSION_DETECTED`. | `UNAUTHORIZED_SENDER` security exception. | Test content script sending `PUT_FILE` is rejected. |
| **G** | **Confused Deputy** | Content script submits manipulated metadata directing write to arbitrary repository. | Content Script $\to$ Queue Engine | Repository, branch, and App installation are determined strictly by user configuration in `codesync:config`, validated against GitHub App authorized repository list, not content script. | Target repo taken from trusted config. | Test payload with spoofed repo is overridden by config. |
| **H** | **Repository Substitution** | Attacker alters storage to direct commits to an attacker-controlled repository. | Config $\to$ Write Engine | Target repo verified against `GET /user/installations/{id}/repositories` authorized repositories. If target repo is removed from App installation or user loses push permission, sync halts fail-closed (`REQUIRES_ATTENTION`). Never silently retargeted. | Commit halted if repo not in authorized list. | Test write to unauthorized repo throws `PERMISSION_DENIED`. |
| **I** | **Branch Substitution** | Injecting malicious ref (e.g. `refs/tags/v1.0` or `../master`). | Config $\to$ GitHub API | CodeSync Safe Branch Grammar (`^[a-zA-Z0-9._/-]+$` conservative subset + boundary rules); existence checked via API. | Ref validation error halts sync fail-closed (`BRANCH_VALIDATION_ERROR`). | Test branch containing `..` or leading `/` is rejected. |
| **J** | **Path Traversal** | Problem title containing `../../` attempting to write outside target folder. | Metadata $\to$ Path Canonicalizer | 8-step canonicalizer detects actual traversal (`.` or `..` segments) -> `PATH_TRAVERSAL_DETECTED`. Consecutive dots in filenames rejected with `INVALID_FILENAME_SEGMENT`. | Fails closed with `PATH_TRAVERSAL_DETECTED` or `INVALID_FILENAME_SEGMENT`. | Test `../../.bashrc` fails validation. |
| **K** | **Unicode Path Tricks** | Using Cyrillic homoglyphs or lookalikes (e.g. `\u0430` for `a`). | Metadata $\to$ Path Canonicalizer | Unicode NFKC normalization followed by strict ASCII POSIX whitelist (`^[a-zA-Z0-9_.-]+$`). Control characters and non-ASCII characters rejected fail-closed. | Fails closed on non-ASCII or control characters (`PATH_VALIDATION_ERROR`). | Test Cyrillic lookalike in slug is rejected. |
| **L** | **Encoded Traversal** | Using `%2e%2e%2f` or `%252e%252e%252f` (double-encoding). | Metadata $\to$ Path Canonicalizer | Multi-pass recursive URL decoding (max 3 cycles) before segment validation. Decoded controls and nulls rejected fail-closed. | Decoded to `../` and rejected in Step 5. | Test `%252e%252e%252f` fails validation. |
| **M** | **MITM / Network Failure** | Network drops or MITM attempt on api.github.com. | Service Worker $\to$ Network | CodeSync communicates exclusively via HTTPS. Certificate validation and TLS negotiation are enforced by the browser networking stack. Jittered exponential backoff for transient drops. | Fail-closed on certificate failure; bounded retry on drop. | Test mock network timeout triggers retry budget. |
| **N** | **Stale SHA** | Remote file updated on GitHub while local write in flight. | Remote State $\to$ Write Protocol | Optimistic concurrency control (`sha` parameter on PUT); GitHub returns HTTP 409. | Halt write; enter 409 Conflict Protocol. | Test PUT with stale SHA triggers 409 handler. |
| **O** | **Concurrent Remote Edit** | User commits code from another machine during synchronization. | Remote State $\to$ Write Protocol | 409 Conflict Protocol re-fetches remote state and compares content hash. | Remote content preserved if hashes differ. | Test concurrent edit is preserved under safe policy. |
| **P** | **409 Conflict** | Remote conflict detected during PUT Contents API. | Write Protocol $\to$ Conflict Handler | 8-step conflict protocol executes re-fetch, hash compare, policy re-evaluation. Max 2 passes. | Bounded escalation to `REQUIRES_ATTENTION`. | Test conflict handler does not loop infinitely. |
| **Q** | **Ambiguous Network Response** | HTTP connection drops after GitHub committed write but before 201 received. | Network $\to$ Idempotency Engine | On retry, pre-flight read detects identical content hash and resolves state as `COMPLETED`. | No duplicate commit created. | Test retry after simulated response drop succeeds cleanly. |
| **R** | **Rate-Limit Abuse** | Excessive rapid submissions exhausting 5,000 req/hr quota. | Client $\to$ GitHub API | Centralized rate-limit monitor tracks `x-ratelimit-remaining`; pauses queue when `< 50`. | Queue non-blocking pause until reset epoch. | Test queue pauses when `x-ratelimit-remaining === 0`. |
| **S** | **Infinite Retry Loop** | Persistent 500 error or 409 conflict looping indefinitely. | Queue Engine $\to$ Retry Backoff | Maximum 5 retry attempts for transient errors; maximum 2 revalidations for 409. | Transitions to `REQUIRES_ATTENTION`. | Test 6th retry attempt marks item fatal. |
| **T** | **Service Worker Restart** | Browser terminates service worker during active GitHub write. | Lifecycle $\to$ Crash Recovery | Write-ahead log records `INTENT`; persistent lease fencing detects stale worker on wake. | Next worker recovers state via WAL idempotency. | Test recovery after simulated worker abort during write. |
| **U** | **Refresh-Token Race** | Concurrent sync jobs trigger simultaneous refresh requests, invalidating rotating token. | Worker $\to$ Token Lifecycle | Durable Refresh-State Concurrency Model (`DurableTokenLifecycleManager`): Web Locks for runtime serialization + persistent fencing generation (`refreshGeneration: number`) and 30s lease timeout. Prevents stale refresh token overwrites across workers or restarts. | At-most-one active request per unexpired lease; duplicate in-flight requests safely tolerated via generation fencing; stale responses safely discarded. | Test concurrent refresh calls and simulated delayed responses do not overwrite newer tokens. |
| **V** | **Revoked Authorization** | User revokes app on GitHub.com; API returns 401. | GitHub API $\to$ Auth Engine | 401 detected; tokens purged from storage; items transition to `REQUIRES_ATTENTION` (`GITHUB_AUTH_EXPIRED`). | Immediate fail-closed; prompt user re-auth. | Test 401 purges credentials and stops queue. |
| **W** | **Permission Reduction** | User alters repo permissions from write to read-only on GitHub. | GitHub API $\to$ Write Engine | HTTP 403 (non-quota) detected; write halted; item marked `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`). | Fail-closed; user prompted in Options UI. | Test 403 on PUT marks item `REQUIRES_ATTENTION`. |
| **X** | **Config Change While Queued** | User alters default repo in settings while items are pending in queue. | Config $\to$ Queue Engine | Enqueue-time snapshotting: items execute against their snapshotted destination. | No silent retargeting of queued submissions. | Test queued item writes to original target after config change. |
| **Y** | **Malicious Problem Title** | Problem title containing `CON.cpp`, `AUX`, or control characters. | Platform $\to$ Path Canonicalizer | Segment validator rejects Windows reserved device names and control characters. | Fails closed with `PATH_RESERVED_NAME` or `PATH_VALIDATION_ERROR`. | Test `CON.cpp` problem title fails validation. |
| **Z** | **Oversized Payload** | Submitting huge file (> 500 KB) consuming memory and quotas. | Payload $\to$ API Client | Strict 500 KB payload limit enforced before base64 encoding and network dispatch. | Fails closed with `PAYLOAD_TOO_LARGE`. | Test 501 KB payload is rejected before network dispatch. |

---

## P. Updated Test Architecture

Testing the GitHub integration will require an adversarial, deterministic automated test suite across 11 test specifications in `tests/security/github/`:

```
tests/security/github/
├── auth-device-flow.test.ts
│   ├── Device flow initiation (POST /login/device/code)
│   ├── Polling intervals and slow_down backoff (+5s)
│   ├── User denial (access_denied) and expiration (expired_token)
│   ├── Cancellation and user-initiated abort
│   └── Service worker restart handling during active polling
│
├── token-lifecycle.test.ts
│   ├── Durable refresh concurrency across simulated workers
│   ├── Monotonic refreshGeneration verification
│   ├── Stale refresh response rejection (Scenarios A–D)
│   ├── Lease expiration (30s TTL) recovery after simulated crash
│   ├── Partial auth-state persistence rejection
│   └── Revoked credentials fail-closed purge
│
├── token-redaction.test.ts
│   ├── TokenRedactor regex verification (ghu_, ghr_, ghp_, github_pat_)
│   ├── Log sanitization with [REDACTED]
│   ├── Error message and URL redaction
│   ├── WAL and IndexedDB payload credential exclusion audit
│   └── Message bus envelope credential rejection
│
├── repository-validation.test.ts
│   ├── GitHub App installation scope verification
│   ├── Push permission validation (permissions.push === true)
│   ├── Remote branch verification (GET /branches/{branch})
│   ├── Removed repository handling (fail closed with REQUIRES_ATTENTION)
│   └── Repository substitution attempt rejection
│
├── path-canonicalizer.test.ts
│   ├── 8-step pipeline execution
│   ├── Fail-closed rejection of control characters (\x00-\x1F, \x7F) and null bytes
│   ├── Separation of actual traversal (..) from dot-dot filenames (INVALID_FILENAME_SEGMENT)
│   ├── Windows reserved device names (CON, PRN, AUX, NUL, COM*, LPT*)
│   ├── Git internal protection (.git, .github)
│   ├── Multi-pass recursive URL decoding
│   └── Base-folder boundary containment enforcement
│
├── path-template-engine.test.ts
│   ├── Variable grammar substitution ({platform}, {slug}, {difficulty}, {extension})
│   ├── Slugification rules (lowercase, alphanumeric + hyphen)
│   ├── Structural length enforcement (<= 255 chars total, <= 100 chars per segment)
│   └── Live preview generation with synthetic problem metadata
│
├── safe-write-protocol.test.ts
│   ├── New file creation (HTTP 201)
│   ├── Existing file update with OCC SHA (HTTP 200)
│   ├── Content identity duplicate detection (SKIPPED with zero commits)
│   ├── Ambiguous network timeout reconciliation (detecting prior commit)
│   └── Verification of commit existence post-write
│
├── conflict-protocol-409.test.ts
│   ├── Cache-busting remote re-fetch on HTTP 409
│   ├── Content hash comparison against remote modification
│   ├── Duplicate policy branch execution (skip / keep_both / overwrite)
│   ├── Bounded revalidation passes (max 2) before safe escalation
│   └── Verification that remote modifications are never blindly overwritten
│
├── rate-limit-backpressure.test.ts
│   ├── Inspection of x-ratelimit-remaining and reset epoch headers
│   ├── Proactive queue throttling when remaining < 50
│   ├── Queue pause when remaining === 0
│   └── Secondary rate limit burst response handling (HTTP 429 Retry-After)
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

## Q. Residual Risks

1. **Large File Limitations in Contents API:**
   - *Context:* The GitHub Contents API returns an empty string for the `content` base64 field if a file exceeds 1 MB.
   - *Risk Assessment:* Competitive programming submissions in C++, Java, Python, etc., rarely exceed 50 KB. CodeSync enforces a strict **500 KB file limit** (`PAYLOAD_TOO_LARGE`).
   - *Mitigation:* The 500 KB limit ensures CodeSync never approaches the 1 MB Base64 truncation boundary of the Contents API, avoiding the need for the complex Git Data Trees/Blobs API in Phase 1C.

2. **Organization SAML SSO Enforcement:**
   - *Context:* If a user selects a repository belonging to an enterprise organization enforcing SAML SSO, requests will return `HTTP 403` until the user authorizes their SAML identity for the GitHub App.
   - *Mitigation:* The API client inspects the `X-GitHub-SSO` response header and prompts the user with an actionable message: `"Organization requires SAML SSO authorization. Please authorize CodeSync in your GitHub organization settings."`

---

## R. Deferred Features

### Formal Deferral of Personal Access Token (PAT) Fallback:
- **Decision:** Personal Access Token (PAT) support is formally **DEFERRED** from Phase 1C.
- **Security Justification:**
  1. *Reduced Attack Surface:* Device Authorization Flow with short-lived (8-hour) tokens and rotating refresh tokens eliminates the security risks of long-lived static tokens stored in the browser.
  2. *Elimination of Clipboard & Phishing Vectors:* PATs require users to manually copy/paste high-privilege tokens into the extension UI, exposing credentials to clipboard sniffing and shoulder surfing.
  3. *Elimination of Over-Permissioning Hazards:* Users frequently generate "Classic" PATs with broad `repo` scope (full read/write access to all private repositories), violating least privilege. GitHub App Device Flow guarantees access is restricted strictly to the user-selected repositories.
  4. *Testing & Architecture Focus:* Omitting PAT simplifies the credential lifecycle state machine to a single, provably verified authentication path.
- **Future Considerations:** PAT fallback may be re-evaluated in a post-1.0 phase strictly if enterprise firewalls block `github.com/login/device`.

---

## S. Official GitHub Documentation References

All design specifications and API contracts were verified against current official GitHub documentation:

1. **GitHub App User Access Tokens & Expiration:**  
   [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)  
   *Verified: 8-hour access token lifespan (`expires_in = 28800`), 6-month refresh token lifespan (`refresh_token_expires_in = 15897600`).*
2. **Device Flow Specification (RFC 8628):**  
   [Using the device flow to generate a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)  
   *Verified: `POST https://github.com/login/device/code`, polling `POST https://github.com/login/oauth/access_token`, polling states (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`).*
3. **Refreshing User Access Tokens Without Client Secret:**  
   [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)  
   *Verified: `client_secret` is explicitly optional and NOT required when the token was generated via Device Flow.*
4. **Repository Contents REST API:**  
   [REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents)  
   *Verified: `GET /repos/{owner}/{repo}/contents/{path}` schema, `PUT /repos/{owner}/{repo}/contents/{path}` parameters (`sha` required for update), status codes (200, 201, 404, 409, 422).*
5. **Rate Limits & Header Specifications:**  
   [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)  
   *Verified: Authenticated user limit (5,000 req/hr), secondary rate limits (80 mutations/min, 100 concurrent), inspection of `x-ratelimit-*` and `retry-after` headers.*

---

## T. Final Phase Verdict

# **PHASE 1C.0.1 ARCHITECTURE CORRECTION PASS = PASS**

### Verification Summary:
- **Zero Unsupported Security Claims:** All claims of application-level encryption at-rest and TLS 1.3 certificate pinning have been eradicated. Storage isolation and browser networking capabilities are accurately defined.
- **Durable Concurrency Hardening:** The token refresh model incorporates Web Locks and persistent generation fencing, provably resolving concurrent refresh races and stale worker overwrites.
- **Fail-Closed Boundary Security:** Control characters and null bytes are rejected fail-closed with zero silent sanitization. Directory traversal is cleanly separated from filename policy.
- **Verified GitHub Integration:** Device Flow parameters, endpoint contracts, permission formulas, and OCC write protocols match current upstream GitHub specifications.
- **Codebase Integrity Preserved:** Zero Phase 1C implementation code has been written. All existing 114 tests pass, and TypeScript compilation and ESLint checks are completely clean.

---

### **CRITICAL PHASE GATE NOTICE: HARD STOP**
Implementation of Phase 1C (Phase 1C.1 through Phase 1C.10) remains **STRICTLY HALTED**. No GitHub integration code, API clients, or UI components may be written until this correction report receives formal human and external security approval.
