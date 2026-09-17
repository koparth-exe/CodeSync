# CodeSync Phase 1C: GitHub Integration Architecture & Security Design Review

**Document Version:** 1.3.0-hardened (Phase 1C.0.5 Lease-Expiry Authority & Terminology Consistency Pass)  
**Date:** 2026-09-13  
**Role:** Senior Security Architect, GitHub App/API Engineer, Browser-Extension Security Engineer, Distributed-Systems Engineer, Adversarial Concurrency Reviewer  
**Project:** CodeSync (Production-Grade Cross-Browser Browser Extension)  
**Status:** ARCHITECTURE & SECURITY DESIGN REVIEW — HARDENED (PHASE 1C.0.5)  
**Scope Gate:** Phase 1C Architecture Gate (No production implementation code permitted in this phase)  

---

## A. Executive Summary

Phase 1C designs the high-privilege GitHub synchronization subsystem for CodeSync. This subsystem is responsible for authenticating with GitHub, discovering and validating repositories, canonicalizing repository paths, evaluating content identity against remote repository state, and safely committing solution files with optimistic concurrency control.

Because this subsystem will possess authorization to modify a user's GitHub repositories, it represents a **critical security boundary**. A flaw in token storage could compromise user accounts; an unvetted path could enable arbitrary repository overwrites; a naive retry on HTTP 409 could silently destroy user commits; a race condition during token rotation could irreversibly brick authentication.

To address these hazards, this architecture establishes the following non-negotiable security designs:

1. **Authoritative GitHub App + Device Authorization Flow (RFC 8628):**
   - Purely client-side authentication without third-party proxies or backend servers.
   - **Zero Client Secret:** Verified directly against official GitHub documentation, GitHub App Device Flow requires *only* `client_id` and `device_code` for authorization and *only* `client_id` and `refresh_token` for token rotation. No client secret is ever embedded in the extension bundle.
   - **Least Privilege:** Granular repository permissions (`Contents: read and write`) scoped exclusively to user-selected repositories via GitHub's native installation picker. Zero access to user settings, issues, pull requests, actions, webhooks, or organizations.
   - **PAT Fallback Deferred:** To minimize attack surface and avoid unrotated credential pathways, Personal Access Token (PAT) support is formally deferred from Phase 1C.
2. **Short-Lived Credentials with Durable Refresh Concurrency & Lease-Expiry Revocation:**
   - Current GitHub documented operational parameters: user access tokens expire in 8 hours (`ghu_...`); refresh tokens expire in 6 months (`ghr_...`) and rotate on every use.
   - Decouples network request completion from local mutation authority: $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$.
   - Once a durable 30-second refresh lease expires in persistent storage, the previous worker **permanently loses local mutation authority** for that refresh attempt. No grace period restores authority.
   - A **Durable Refresh-State Concurrency Model** (combining persistent monotonic generation tokens, unique attempt UUIDs, monotonic lease epochs, and 30-second lease timeouts with runtime Web Locks coordination). Recognizes that while host process suspension and lease expiration mean exactly-once network dispatch cannot be guaranteed, generation fencing and full predicate verification guarantee that stale refresh responses (success or error) cannot overwrite or invalidate newer rotated credentials.
3. **High-Privilege Credential Isolation & Single-Object Fenced Persistence:**
   - Tokens reside exclusively in `browser.storage.local` under `codesync:auth`, protected by the browser extension storage and origin isolation model (without claiming unsupported application-level encryption at rest).
   - Inviolable Trust Boundary: Content scripts, web pages, logs, error objects, queue metadata, and WAL records are strictly forbidden from receiving, logging, or handling GitHub credentials.
   - Fenced Credential Persistence: All authentication fields are stored as a single logical JSON document committed under fencing verification, explicitly distinguishing single-object serialization from database-grade cross-system atomicity.
4. **Validated Transactional Write Protocol with Optimistic Concurrency Control:**
   - Acknowledges that multi-step HTTP synchronization is **not an atomic database transaction**.
   - Enforces pre-condition validation, remote SHA retrieval, content-identity comparison, and optimistic locking via the `sha` parameter in `PUT /repos/{owner}/{repo}/contents/{path}`.
5. **Deterministic 8-Step 409 Conflict Protocol (Zero Blind Retries):**
   - HTTP 409 Conflict triggers immediate halt, authoritative fresh re-fetch of remote state (via `cache: "no-store"` bypassing local HTTP caches without ad-hoc query parameters), content-hash comparison, and duplicate policy re-evaluation. A blind retry with an updated SHA is strictly prohibited. Bounded at a maximum of 2 revalidation passes before fail-closed escalation to `REQUIRES_ATTENTION`.
6. **Three-Pillar Path & Template Security Engine:**
   - Multi-pass URL decoding, Unicode NFKC canonicalization, control character detection and rejection (never silent stripping), separator normalization, POSIX portable filename whitelisting (`^[a-zA-Z0-9_.-]+$`), Windows reserved device name rejection (`CON`, `PRN`, `AUX`, `NUL`, etc.), Git internal directory protection (`.git`, `.github`), total length ($\le 255$) and depth ($\le 10$) validation, and base-folder containment.
7. **Immutable Job Specification (Enqueue-Time Snapshotting):**
   - Sync jobs snapshot their target repository, target branch, and resolved path at the moment of submission capture. Subsequent configuration changes in extension settings never silently retarget pending queue items.


---

## B. Current Architecture Integration Point

Phase 1C integrates directly into the hardened Phase 1B.1 extension foundation without compromising existing guarantees:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                BROWSER RUNTIME BOUNDARY                                │
├───────────────────────────────┬────────────────────────────────────────────────────────┤
│ CONTENT SCRIPT (SEMI-TRUSTED) │ POPUP / OPTIONS UI (TRUSTED EXTENSION PAGE)           │
│ • Detects submission event    │ • Displays auth status summary (login, avatarUrl)      │
│ • Sends SUBMISSION_DETECTED   │ • Initiates Device Flow (INITIATE_GITHUB_AUTH)         │
│ • ZERO access to credentials  │ • Selects target repository & branch from cached list  │
└───────────────┬───────────────┴───────────────────────────┬────────────────────────────┘
                │                                           │
                ▼                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SERVICE WORKER (TRUSTED ENFORCEMENT)                            │
│                                                                                        │
│  ┌─────────────────────────┐  Enqueue WAL Intent  ┌─────────────────────────────────┐  │
│  │   Message Bus Router    │─────────────────────►│     Queue Manager (Phase 1B)    │  │
│  │   & Envelope Validator  │                      │ • Hybrid Storage (local + IDB)  │  │
│  └─────────────────────────┘                      │ • Persistent Fenced Lease       │  │
│                                                   │ • Durable WAL & Crash Recovery  │  │
│                                                   └────────────────┬────────────────┘  │
│                                                                    │                    │
│                                                                    │ Dequeue Job        │
│                                                                    ▼                    │
│                                                   ┌─────────────────────────────────┐  │
│                                                   │       GitHub Sync Engine        │  │
│                                                   │ • Validates Fencing Token       │  │
│                                                   │ • Verifies Enqueue-Time Target  │  │
│                                                   │ • Resolves Canonical Path       │  │
│                                                   └────────────────┬────────────────┘  │
│                                                                    │                    │
│                                                                    │ Request Exec       │
│                                                                    ▼                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │                   Centralized GitHub Service (HIGH-PRIVILEGE)                    │  │
│  │  ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐  │  │
│  │  │ Auth & Token Mutex     │  │ Repository & Branch    │  │ Safe Write &       │  │  │
│  │  │ • Device Flow Polling  │  │ Validator              │  │ 409 Conflict OCC   │  │  │
│  │  │ • Single-Flight Mutex  │  │ • Permissions Check    │  │ • Remote GET       │  │  │
│  │  │ • Storage: codesync:auth│ │ • Branch Ref Check     │  │ • OCC PUT + SHA    │  │  │
│  │  └────────────────────────┘  └────────────────────────┘  └────────────────────┘  │  │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Centralized API Client (Fetch + Headers + Rate Limit Backpressure + Retries)│  │  │
│  │  └────────────────────────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────┬─────────────────────────────────────────┘  │
└───────────────────────────────────────────┼────────────────────────────────────────────┘
                                            │ HTTPS / REST (api.github.com)
                                            ▼
                                   ┌─────────────────┐
                                   │   GitHub API    │
                                   └─────────────────┘
```

### Key Integration Contracts
- **Queue Subsystem (`src/shared/queue/`):** The queue manager remains completely agnostic of GitHub HTTP mechanics. It passes a `QueueItemMetadata` and `QueueItemPayload` to the `GitHubSyncEngine`, which returns a strictly typed `SyncResult`.
- **Fencing Tokens:** The worker's active `fencingToken` is passed into every sync execution. If the lease expires or is superseded by another worker while an HTTP call is in flight, the resulting state write is rejected fail-closed with `StaleLeaseError`.
- **Storage Subsystem (`src/shared/storage/`):** Authentication state resides exclusively in `browser.storage.local` under `codesync:auth` (`STORAGE_KEYS.AUTH`). Queue records and WAL entries store only repository names, branch names, and commit SHAs — never credentials.

---

## C. GitHub Authentication Architecture

### 1. Authoritative Method: GitHub App User Access Tokens
CodeSync uses a **GitHub App** with user access tokens generated via the **OAuth 2.0 Device Authorization Grant (RFC 8628)**.

### 2. Architectural Comparison Matrix

| Security / Operational Dimension | Legacy OAuth App | Personal Access Token (Classic) | Personal Access Token (Fine-Grained) | **GitHub App (CodeSync Authoritative)** |
| :--- | :--- | :--- | :--- | :--- |
| **Permission Granularity** | Monolithic (`repo` grants full write across all repos, issues, hooks, wikis) | Monolithic (`repo` grants full account-wide access) | Scoped to select repositories and permissions | **Strictly Fine-Grained:** Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions |
| **Repository Containment** | Account-wide (all public & private repos) | Account-wide | User-selected repositories | **Built-in Repository Isolation:** User selects "Only select repositories" during install |
| **Client Secret Requirement** | Required for Web Flow; Device Flow still issues indefinite tokens | None (user manually generates) | None (user manually generates) | **Zero Client Secret Required:** GitHub App Device Flow requires *no* client secret |
| **Token Lifetime** | Indefinite (lives forever until revoked) | Indefinite or manual expiry (up to 1 year) | Configurable (up to 1 year) | **8-Hour Expiry:** Tokens expire after 8 hours; automatic rotation |
| **Automated Rotation** | None | None (sync breaks upon expiry) | None (sync breaks upon expiry) | **6-Month Refresh Token:** Automated single-flight rotation via service worker |
| **User Setup Friction** | Low | High (developer settings, manual scopes, copy-paste) | Very High (complex resource pickers, permissions) | **Seamless:** Guided browser tab authorization on `github.com/login/device` |
| **Attack Blast Radius** | Account-wide read/write compromise | Complete account compromise | Restricted repo compromise (up to 1 year) | **Minimized:** 8-hour token lifetime, scoped strictly to single repository contents |

### 3. Architectural Decision on Personal Access Tokens (PAT): DEFERRED

For Phase 1C, **Personal Access Token (PAT) support is formally DEFERRED.**

**Security & Architectural Justification:**
1. **Attack Surface Reduction:** Supporting PAT introduces a secondary credential-management path with manual input forms, clipboard sniffing vectors, and storage branching.
2. **Eliminating Scoping Errors:** Users routinely struggle with GitHub's granular PAT creation interface, frequently defaulting to classic PATs with monolithic `repo` scope or setting "No expiration".
3. **No Automated Rotation:** PATs do not support OAuth refresh tokens. When a PAT expires, synchronization breaks abruptly without programmatic recovery.
4. **Lean Implementation Contract:** By focusing exclusively on GitHub App + Device Flow, Phase 1C implementation and verification remain tightly scoped, provably secure, and free of legacy credential baggage.
5. **Future Roadmap:** PAT support will only be revisited in future phases if strict enterprise firewall requirements genuinely necessitate a manual fallback.

---

### 4. Clarification: GitHub App Installation vs. Device Authorization Flow

To prevent any architectural conflation, the distinct responsibilities of the GitHub App, App Installation, Device Flow, and Repository Authorization are formally decoupled:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. GITHUB APP REGISTRATION (Global)                                                    │
│    • Globally defines permissions: Repository -> Contents: Read and write              │
│    • Provides public client_id                                                         │
└──────────────────────────────────────┬─────────────────────────────────────────────────┘
                                       │
                                       ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 2. APP INSTALLATION ON GITHUB.COM (Account Level)                                      │
│    • User installs the CodeSync GitHub App on their GitHub account or org.             │
│    • User selects: "Only select repositories" (e.g. owner/leetcode-solutions).         │
│    • Creates an installation_id.                                                       │
│    • Determines the MAXIMUM repository boundary accessible to the app.                 │
└──────────────────────────────────────┬─────────────────────────────────────────────────┘
                                       │
                                       ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 3. DEVICE AUTHORIZATION FLOW (User Level)                                              │
│    • Authenticates the physical human user to the GitHub App (RFC 8628).               │
│    • Issues a short-lived User Access Token (ghu_...) and Refresh Token (ghr_...).     │
└──────────────────────────────────────┬─────────────────────────────────────────────────┘
                                       │
                                       ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 4. EFFECTIVE PERMISSIONS & REPOSITORY DISCOVERY                                        │
│    • User access token acts on behalf of the user within the installed scope.         │
│    • Effective Access = User Permissions ∩ App Permissions ∩ Installed Repositories    │
│    • CodeSync calls GET /user/installations/{id}/repositories                          │
│    • CodeSync filters for repository.permissions.push === true                         │
│    • User selects which verified repository CodeSync should target in Settings.        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Detailed Breakdown of Key Authorization Questions:
1. **What the GitHub App Installation Represents:** The installation is the organizational grant binding the CodeSync GitHub App to a specific user account or organization, assigning it an `installation_id`.
2. **How Repository Selection is Performed:** Repository selection is executed natively on GitHub.com during app installation (or via app configuration settings). Users explicitly select "Only select repositories".
3. **What Repository Access is Granted to the App:** The app is granted `Contents: read and write` *only* on the repositories explicitly checked during installation. All other repositories on the user's account are completely invisible to the app.
4. **What the Device Flow Authenticates:** The Device Flow authenticates the *user's identity* and authorizes the app to act on behalf of that user, generating a user access token (`ghu_...`).
5. **How the User Access Token is Constrained:** A user access token can never exceed the permissions of *either* the user *or* the app installation. If the app has write access to repository A, but the user only has read access, the token has read-only access.
6. **How CodeSync Determines Repositories that May Be Written:** CodeSync queries `GET /user/installations/{installation_id}/repositories` using the user access token and inspects `permissions.push === true`. Only repositories where `permissions.push` is true are presented for selection.
7. **Whether `repository_id` is Used in Device Flow:** GitHub's device token exchange endpoint supports an optional `repository_id` parameter to scope a user access token down to a single repository. For CodeSync's primary workflow, tokens are scoped to the user's app installation (which is already restricted to user-selected repositories on GitHub.com). This allows users who configure multiple solution repositories (e.g. one for LeetCode, one for Codeforces) to switch target repositories in CodeSync Options without re-running the entire Device Flow.
8. **When Repository Scope is Selected:** The user grants repository scope on GitHub.com during installation, and selects their active solution repository inside the CodeSync Options page.
9. **How Repository Scope is Revalidated:**
   - At configuration time in Options: `GET /user/installations/{id}/repositories` dynamically refreshes the list.
   - At write time in Queue Worker: Pre-flight check verifies `GET /repos/{owner}/{repo}` to ensure write capability before committing files.
10. **What Happens if a Repository is Removed from the App Installation on GitHub:** If a user unchecks a repository in GitHub App settings, subsequent API calls to that repository return `HTTP 404 Not Found` or `HTTP 403 Forbidden`. The sync engine detects this on pre-flight read and transitions the queued item to `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED` or `GITHUB_TARGET_NOT_FOUND`). It **never** silently retargets.
11. **What Happens if User Permissions Change on GitHub:** If the user's repository collaborator access is downgraded to read-only, the `PUT /contents` call fails with `HTTP 403 Forbidden`. The item transitions to `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).

---

### 5. Resolution of User Profile Access vs. `GET /user`

Previous drafts contained a semantic contradiction claiming "Zero access to user profiles" while simultaneously querying `GET /user`. This is formally clarified:

- **GitHub App Permissions (Least Privilege):** The CodeSync GitHub App requests **ZERO account or user profile permissions**. It does not request `User: read and write`, does not request `User email: read`, and cannot access private user profile data, billing, security keys, or personal emails.
- **API Endpoint (`GET /user`):** Under GitHub's REST API, any valid user access token (`ghu_...`) is authorized to call `GET /user` to retrieve the authenticated user's minimal public identity (`login`, `id`, `avatar_url`).
- **Data Minimization Purpose:** CodeSync retrieves *only* `login`, `id`, and `avatar_url` strictly to render the connected account identity in the Options UI and to verify commit authorship. No other user data is requested, parsed, or stored.

---

## D. Device Authorization Flow Specification

The Device Authorization Flow allows the extension to authenticate users without hosting a redirection server and without embedding a client secret.

```
CodeSync Service Worker                      User Browser Tab                         GitHub API
───────────────────────                      ────────────────                         ──────────
          │                                         │                                      │
1. User clicks "Connect GitHub"                     │                                      │
   SW calls Device Code Endpoint                    │                                      │
   POST https://github.com/login/device/code ───────┼─────────────────────────────────────►│
   Body: { client_id }                              │                                      │
          │                                         │                                      │
2. Receive Device Code Response ◄───────────────────┼──────────────────────────────────────┤
   { device_code, user_code,                        │                                      │
     verification_uri, interval: 5, expires_in: 900 }│                                     │
          │                                         │                                      │
3. Open GitHub Tab & Display Code                   │                                      │
   chrome.tabs.create(verification_uri) ───────────►│                                      │
   Options UI renders user_code                     │                                      │
          │                                         │                                      │
4. Polling Loop Begins                              │ 5. User enters user_code             │
   POST /login/oauth/access_token ──────────────────┼───► github.com/login/device ────────►│
   Body: { client_id, device_code, grant_type }     │    Authorizes App & Selects Repo     │
          │                                         │                                      │
   ◄───── Response: { error: "authorization_pending" }                                     │
          │ (Sleep interval = 5s)                   │                                      │
          │                                         │                                      │
   POST /login/oauth/access_token ──────────────────┼─────────────────────────────────────►│
   ◄───── Response: { access_token: "ghu_...",      │                                      │
                      expires_in: 28800,            │                                      │
                      refresh_token: "ghr_...",     │                                      │
                      refresh_token_expires_in: 15897600 }                                 │
          │                                         │                                      │
6. Persist tokens in codesync:auth                  │                                      │
   Fetch user identity (GET /user)                  │                                      │
   Notify UI of success                             │                                      │
```

### Detailed Protocol Mechanics
1. **Initiation Request:**
   - Endpoint: `POST https://github.com/login/device/code`
   - Headers: `Accept: application/json`
   - Body: `{ "client_id": "<GITHUB_APP_CLIENT_ID>" }`
   - Security: `client_id` is a public identifier registered with the GitHub App.
2. **Polling Loop Rules:**
   - Initial interval: `interval` seconds (default 5s).
   - Rate limiting: If GitHub responds with `{ "error": "slow_down", "interval": N }`, the polling interval is updated to $N$ (or previous interval + 5s).
   - Termination conditions:
     - `access_denied`: User clicked "Cancel" on GitHub $\to$ Terminate flow, clear session, notify UI (`AUTH_USER_DENIED`).
     - `expired_token`: 15-minute window elapsed $\to$ Terminate flow, clear session, notify UI (`AUTH_DEVICE_CODE_EXPIRED`).
     - Success: Receive `access_token` and `refresh_token` $\to$ Persist in storage, terminate polling.
     - User cancellation from Options UI $\to$ AbortController cancels in-flight poll, clears session.
3. **Service## F. Token Refresh & Rotation Model

### 1. Core Security Principle
The primary invariant governing all credential lifecycle operations in CodeSync is:

> **"If CodeSync cannot prove which refresh attempt is authoritative, it MUST NOT mutate or purge credential state.**
> 
> **It must either:**
> **A. reconcile using authoritative persisted state, or**
> **B. fail closed to explicit re-authentication.**
> 
> **Uncertainty must never be converted into credential destruction."**

This principle has strict, overriding priority over convenience, automated background recovery, avoiding re-authentication, or minimizing API calls.

```
                  AUTHORITY HIERARCHY
                         CERTAINTY
                            ↓
                   SAFE STATE MUTATION
                            ↓
                         RECOVERY
                            ↓
                      USER RE-AUTH
                            ↓
                       CONVENIENCE
```

---

### 2. Critical Protocol Boundaries: What GitHub Guarantees vs. What CodeSync Guarantees

To prevent dangerous architectural assumptions, CodeSync strictly separates the server-side semantics of GitHub's OAuth endpoint from extension client-side guarantees:

| Dimension | What GitHub Guarantees | What CodeSync Guarantees |
| :--- | :--- | :--- |
| **Token Lifetime** | Nominally 8h for user access tokens (`ghu_...`); nominally 6 months for refresh tokens (`ghr_...`). | CodeSync dynamically derives exact `tokenExpiresAt` and `refreshTokenExpiresAt` from response metadata without hardcoding constants. |
| **Token Rotation** | Exchanging a refresh token permanently consumes it and issues a new rotating token. | CodeSync treats every refresh token exchange as single-use. |
| **Idempotency** | **NONE.** GitHub provides NO transaction IDs, NO client request IDs, and NO server-side idempotency keys for OAuth token exchange. | CodeSync models token refresh as an inherently non-idempotent operation. |
| **Delivery / Ack** | GitHub does NOT guarantee that an issued response packet successfully reaches the extension client. | CodeSync models the possibility of dropped responses and in-transit termination. |
| **Server State Knowledge** | If a response packet is lost on the network, GitHub provides NO mechanism to query whether a prior refresh token was consumed. | When response loss occurs, CodeSync represents the outcome as `REFRESH_OUTCOME_UNKNOWN` rather than guessing. |
| **Concurrency Fencing** | GitHub rejects subsequent requests using an already-consumed refresh token with HTTP 400 `bad_refresh_token`. | CodeSync uses monotonic generation tokens ($G$), attempt UUIDs ($A$), and lease epochs ($E$) to protect local credentials against stale overwrites. |

---

### 3. Critical Corrections to Prior Concurrency Assumptions

#### Correction 1: Fixed Grace Period Is NOT Proof (TIMEOUT ≠ PROOF OF REFRESH FAILURE)
Prior iterations introduced a 5-second wait window under the assumption that if no commit landed within 5 seconds, the predecessor refresh attempt had definitely failed. **This assumption is formally rejected as invalid.**

In modern browser extension architectures, the browser host platform may throttle or delay:
- Service-worker wake-up and execution
- HTTP response delivery and TCP packet processing
- Asynchronous storage IPC operations (`browser.storage.local`)
- JavaScript microtask queues during CPU contention or laptop lid closure

for significantly longer than 5 seconds (frequently 15–45 seconds).

**Architectural Rule:**
$$\text{TIMEOUT} \neq \text{PROOF OF REFRESH FAILURE}$$
A bounded wait window may serve as an operational UX/latency heuristic, but it **MUST NOT** be treated as cryptographic or protocol proof. Expiration of a wait window never proves that GitHub did not process the request or that a refresh token was not consumed upstream.

#### Correction 2: Do NOT Blindly Reuse an Uncertain Refresh Token
Consider credential generation $G_{10}$ with refresh token $R_1$:
1. Worker A dispatches `refresh(R1)`.
2. Worker A's execution is suspended or delayed across the 30-second lease boundary.
3. Worker B wakes after lease expiration.

The architecture **MUST NOT** assume: *"Worker A probably failed, therefore Worker B can safely dispatch `refresh(R1)`."*

If GitHub already consumed $R_1$ and issued $R_2$ while Worker A's response was delayed or lost, Worker B dispatching `refresh(R1)` will immediately fail with HTTP 400 `bad_refresh_token`. If Worker B were to naively interpret this error as session revocation, it would destroy valid credentials!

Therefore, CodeSync introduces `REFRESH_OUTCOME_UNKNOWN` as a first-class lifecycle condition. When a refresh attempt becomes uncertain across a lease or timeout boundary:
$$\text{AN UNCERTAIN REFRESH TOKEN MUST NEVER BE BLINDLY REUSED.}$$

#### Correction 3: Generation Equality Alone Is Insufficient to Authorize Commits
Checking merely that `currentGeneration === responseGeneration` ($G_{10} === G_{10}$) is insufficient. If Worker A's lease expired and Worker B took over lifecycle authority, Worker A must not commit merely because the credential version has not yet advanced. Commits and error handling require full **Authoritative Response Fencing**.

---

### 4. Conceptual Foundation: The Tripartite Refresh Authority Model

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

1. **Credential Generation (`refreshGeneration: number` — $G$):**
   - Represents the version of the persisted token pair (`accessToken` + `refreshToken`).
   - Increments strictly monotonically ($G \to G + 1$) when a verified token pair is committed to persistent storage.
   - Authoritative for determining whether local credentials are newer than an incoming response.

2. **Refresh Attempt Identity (`attemptId: string` — $A$):**
   - A unique UUID generated fresh for each outbound HTTP request.
   - Authoritative for distinguishing between distinct in-flight refresh attempts originating from the same or different workers.

3. **Refresh Lease Ownership (`refreshLeaseEpoch: number` — $E$, `refreshWorkerId: string` — $W$, `refreshLeaseExpiresAt: number`):**
   - Monotonically increasing lease ownership counter ($E \to E + 1$).
   - Bound to an execution context (`workerId`) and an unexpired lease duration (30s TTL).
   - Authoritative for durable lifecycle actions (claiming refresh, declaring error, clearing locks, transitioning states).

---

### 5. Network Request Lifetime vs. Local Mutation Authority & Lease-Expiry Revocation

#### Core Axiom: Network Completion ≠ Local Mutation Authority
CodeSync establishes an architectural distinction of foundational security significance:
$$\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$$
$$\text{NETWORK SUCCESS} \neq \text{PROOF OF LOCAL MUTATION AUTHORITY}$$

In a distributed browser-extension runtime operating on ephemeral service workers, network request execution and local state mutation authority are strictly decoupled:
1. **Network Request Completion:** An outbound HTTP request (`POST /login/oauth/access_token`) dispatched to GitHub travels across physical network links, is processed by GitHub's OAuth authorization servers, and returns an HTTP response packet (200 OK or 400 Bad Request) to the browser's underlying networking stack.
2. **Local Mutation Authority:** The right of a specific service worker execution context to alter, overwrite, or mutate the extension's durable credential state in `browser.storage.local`.

A previously dispatched refresh request may complete over the network long after:
- The originating service worker was suspended by the host browser.
- The service worker crashed or was terminated.
- The durable 30-second refresh lease expired.
- A successor service worker took over the lease.
- Another worker became authoritative, began reconciliation, or committed a newer credential generation.

**Non-Negotiable Architecture Invariant:**
> **"Once the durable refresh lease expires, the previous worker has permanently lost mutation authority for that refresh attempt, regardless of whether an already-dispatched network request later succeeds."**

This is a deliberate, fail-closed fencing rule. Under no circumstances may a worker infer authority from:
- Request age
- Elapsed time
- Perceived network delay or latency
- Likelihood or heuristics that no other worker refreshed
- Successful HTTP response status (HTTP 200) alone
- Any ad-hoc or fixed grace period (zero grace period restoration)

The network request may still return a successful response, but that response **MUST** be treated as stale and non-authoritative unless the documented durable authority predicate proves that the response still belongs to the currently authoritative refresh attempt.

#### Detailed Scenario Walkthrough: Worker A Suspension vs. Worker B Takeover

Consider the following adversarial timeline:

```
Timeline: Worker A Suspension, Lease Expiration, Worker B Takeover, Late Response Arrival
────────────────────────────────────────────────────────────────────────────────────────
T0: Worker A acquires lease (Epoch E1, Generation G10, Attempt A1, TTL: T0 + 30s)
    Worker A dispatches HTTP POST /login/oauth/access_token (using refresh token R1)
    Request is in-flight across the network.
────────────────────────────────────────────────────────────────────────────────────────
T1: (T0 + 5s) Host browser suspends Worker A (e.g. OS sleep, battery saving, tab backgrounding)
    Worker A's execution thread is halted; network socket remains buffered by OS network stack.
────────────────────────────────────────────────────────────────────────────────────────
T2: (T0 + 30s) Durable lease expires in browser.storage.local.
    ★ FENCING RULE TRIGGERED: Worker A permanently loses all local mutation authority.
────────────────────────────────────────────────────────────────────────────────────────
T3: (T0 + 32s) Worker B wakes on sync alarm or submission event.
    Worker B reads storage: observes lease expired and activeAttempt A1 uncommitted.
    Worker B marks Attempt A1 as UNKNOWN / RECONCILIATION_REQUIRED in predecessor history.
    Worker B acquires lease (Epoch E2 = E1 + 1, WorkerId = Worker_B).
    Worker B initiates reconciliation protocol or prepares new flow.
────────────────────────────────────────────────────────────────────────────────────────
T4: (T0 + 35s) Host browser wakes Worker A.
    OS networking delivers HTTP 200 OK with new tokens (G11 tokens: R2) to Worker A callback.
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

#### Required System Behavior:
1. **Worker A's late response MUST NOT automatically mutate credentials.**
2. **Lease expiry has permanently and irrevocably extinguished Worker A's local authority.**
3. **The late response is evaluated strictly through the durable authority predicate (`isResponseAuthoritative`).**
4. **Because authority is not proven, the response is dropped as stale fail-closed.**
5. **No fixed grace period may restore authority.**
6. **This behavior is intentional security fencing designed to eliminate distributed split-brain writes, not an implementation anomaly.**

---

### 6. The 12 Formal Rules of Refresh Lifecycle Authority

To guarantee distributed safety across all browser runtimes and service worker lifecycle boundaries, CodeSync codifies the following twelve formal rules:

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

### 7. Durable Refresh Attempt Record Schema & History Retention

To enable successor workers to evaluate predecessor lifecycle history across worker terminations, CodeSync persists explicit attempt records in `browser.storage.local` under `codesync:auth`.

```typescript
export type AttemptState =
  | "CREATED"                 // Record initialized before network dispatch
  | "IN_FLIGHT"                // HTTP request dispatched across network
  | "SUCCESS_RECEIVED"        // HTTP 200 received in memory, awaiting fenced commit
  | "COMMITTED"               // Fenced commit succeeded; generation incremented
  | "ERROR_RECEIVED"          // HTTP error received in memory, awaiting evaluation
  | "UNKNOWN"                 // Lease expired or worker died while attempt was in flight
  | "SUPERSEDED"              // Attempt superseded by newer lease epoch
  | "RECONCILIATION_REQUIRED" // Ambiguous failure; requires verification before action
  | "REAUTH_REQUIRED";        // Unresolvable ambiguity; fail-closed to user login

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
  readonly resolutionStatus: AttemptResolutionStatus; // Final or intermediate resolution
  readonly errorClassification?: string | undefined; // Redacted error category (zero secrets)
}
```

#### Inviolable Rules for Attempt Records:
1. **Zero Secret Storage:** Refresh tokens and access tokens are **STRICTLY EXCLUDED** from `RefreshAttemptRecord`. Storing tokens in history records would defeat token minimization and risk credential leakage.
2. **Predecessor History Retention:**
   - Active attempt is stored in `activeAttempt?: RefreshAttemptRecord`.
   - When a successor worker takes over or an attempt completes, the prior record is prepended to `predecessorAttempts: ReadonlyArray<RefreshAttemptRecord>`.
   - **Bounded Audit Size:** `predecessorAttempts` retains a maximum of **5 predecessor records**.
   - **Pruning Policy:** Records older than **7 days** or exceeding the capacity of 5 are pruned FIFO upon commit.
   - **Storage Full Safety:** If storage quota is constrained, completed records with `status: "committed"` or `"dropped_stale"` are dropped first. Unresolved records (`"unknown"`, `"reconciliation_required"`) are preserved.

---

### 8. Formal Attempt Lifecycle State Machine

```
              ┌────────────────────────────────────────────────────────────────────────┐
              │                                 IDLE                                   │
              └───────────────────────────────────┬────────────────────────────────────┘
                                                  │
                                                  │ [Token near expiry (T - 5m) or expired]
                                                  ▼
              ┌────────────────────────────────────────────────────────────────────────┐
              │                                CREATED                                 │
              │ • Generate attemptId (UUID)                                            │
              │ • Increment leaseEpoch (E + 1)                                         │
              │ • Persist activeAttempt record                                         │
              └───────────────────────────────────┬────────────────────────────────────┘
                                                  │
                                                  │ [Dispatch HTTP POST /oauth/access_token]
                                                  ▼
              ┌────────────────────────────────────────────────────────────────────────┐
              │                               IN_FLIGHT                                │
              │ • Request traversing network                                           │
              └───────┬───────────────────────────┼───────────────────────────┬────────┘
                      │                           │                           │
  [HTTP 200 Received] │       [HTTP 400 Received] │       [30s Lease Expires] │
                      ▼                           ▼                           ▼
       ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐
       │    SUCCESS_RECEIVED    │  │     ERROR_RECEIVED     │  │        UNKNOWN         │
       │ • In-memory validation │  │ • Classify error       │  │ • SW died or suspended │
       └──────────────┬─────────┘  └──────────────┬─────────┘  │ • Outcome unknown      │
                      │                           │            └───────────┬────────────┘
        [Pass Fencing]│             [Eval Fencing]│                        │
                      ▼                           ▼                        ▼
       ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐
       │       COMMITTED        │  │   EVALUATE AUTHORITY   │  │RECONCILIATION_REQUIRED │
       │ • Persist G + 1        │  ├────────────────────────┤  │ • Cannot reuse token   │
       │ • Reset state: IDLE    │  │ Gen advanced?          │  │ • Probe or re-auth     │
       └────────────────────────┘  │  → Discard (stale)     │  └───────────┬────────────┘
                                   │ Epoch superseded?      │              │
                                   │  → Zero authority      │              │
                                   │ Predecessor in flight? │              ▼
                                   │  → UNKNOWN             │  ┌────────────────────────┐
                                   │ Authoritative failure? │  │    REAUTH_REQUIRED     │
                                   │  → REAUTH_REQUIRED     │  │ • Safe terminal state  │
                                   └────────────────────────┘  │ • Preserves user data  │
                                                               └────────────────────────┘
```

#### State Transition Specifications:

| State | Entry Condition | Allowed Next States | Prohibited Next States | Lifecycle Owner | Recovery Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **IDLE** | System initialized or commit finalized. | `CREATED` | `IN_FLIGHT`, `COMMITTED` | None | None needed. |
| **CREATED** | Worker acquired lock, generated attempt UUID, incremented epoch. | `IN_FLIGHT`, `IDLE` | `COMMITTED`, `SUCCESS_RECEIVED` | Claiming Worker ($W$, $E$) | If aborted before dispatch, revert to `IDLE` (guarded by epoch). |
| **IN_FLIGHT** | HTTP fetch initiated across network. | `SUCCESS_RECEIVED`, `ERROR_RECEIVED`, `UNKNOWN` | `IDLE`, `COMMITTED` | Dispatched Worker ($W$, $E$) | If 30s TTL expires, transitions to `UNKNOWN`. |
| **SUCCESS_RECEIVED** | HTTP 200 payload received in memory. | `COMMITTED`, `SUPERSEDED` | `ERROR_RECEIVED`, `UNKNOWN` | Receiving Worker ($W$, $E$) | Subject to Authoritative Response Fencing before commit. |
| **COMMITTED** | Successful fenced write to storage. | `IDLE` | All others | Committing Worker | Monotonically increments $G \to G + 1$. |
| **ERROR_RECEIVED** | HTTP 400/401 received in memory. | `SUPERSEDED`, `RECONCILIATION_REQUIRED`, `REAUTH_REQUIRED` | `COMMITTED`, `SUCCESS_RECEIVED` | Receiving Worker ($W$, $E$) | Evaluated against authority predicate; never purges immediately. |
| **UNKNOWN** | 30s lease TTL elapsed or worker died during `IN_FLIGHT`. | `RECONCILIATION_REQUIRED`, `SUPERSEDED` | `COMMITTED`, `IDLE` | None (orphaned) | Successor worker moves record to predecessor history; flags reconciliation. |
| **SUPERSEDED** | Incoming response or error belongs to older epoch ($E < E_{current}$) or older gen ($G < G_{current}$). | *Terminal for attempt* | `COMMITTED`, `ERROR_RECEIVED` | Obsolete Worker | Response dropped fail-safe (`STALE_RESPONSE_DROPPED`). Zero state mutation. |
| **RECONCILIATION_REQUIRED** | Ambiguity detected: predecessor attempt in flight or lease expired without commit. | `COMMITTED` (if resolved), `REAUTH_REQUIRED` | `IN_FLIGHT` (using same token) | Active Worker | Probe authoritative evidence. If unresolved, escalate to `REAUTH_REQUIRED`. |
| **REAUTH_REQUIRED** | Credential validity cannot be established with certainty. | `CREATED` (via new Device Flow) | `COMMITTED`, `IDLE` | User Interaction | Terminal fail-closed state. Preserves existing metadata; prompts re-auth. |

---

### 9. Authoritative Response Fencing Predicate

A response (success or error) may mutate credentials or lifecycle state **ONLY** when the response's authority remains completely valid. CodeSync replaces generation-only checking with the following comprehensive authority predicate:

```typescript
export interface RefreshResponseMetadata {
  readonly attemptId: string;
  readonly credentialGeneration: number;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

/**
 * Evaluates whether an incoming HTTP response retains authoritative ownership
 * to mutate credential or lifecycle state.
 */
export function isResponseAuthoritative(
  response: RefreshResponseMetadata,
  currentAuth: GitHubAuthState
): boolean {
  // 1. Generation Fencing: Response must match the starting credential version exactly
  if (currentAuth.refreshGeneration !== response.credentialGeneration) {
    return false;
  }

  // 2. Attempt Identity Fencing: Must match the active attempt UUID
  if (currentAuth.activeAttempt?.attemptId !== response.attemptId) {
    return false;
  }

  // 3. Lease Epoch Fencing: Must match the current authoritative epoch
  if (currentAuth.refreshLeaseEpoch !== response.leaseEpoch) {
    return false;
  }

  // 4. Worker Ownership Fencing: Must be executed by the current lease holder
  if (currentAuth.refreshWorkerId !== response.workerId) {
    return false;
  }

  // 5. Lifecycle State Fencing: System must still be in active REFRESHING state
  if (currentAuth.refreshState !== "REFRESHING") {
    return false;
  }

  // 6. Durable Lease Boundary: Local lease TTL must not have expired
  if (Date.now() > (currentAuth.refreshLeaseExpiresAt ?? 0)) {
    return false;
  }

  return true;
}
```

#### Deconstruction of Predicate Components:
Each check in `isResponseAuthoritative` enforces an independent, irreplaceable security dimension:
1. **Credential Generation (`refreshGeneration`):** Identifies the credential-state lineage. Proves whether local stored credentials have already advanced to a newer version ($G_{persisted} > G_{response}$). If generation advanced, the incoming response is obsolete by definition.
2. **Refresh Attempt Identity (`activeAttempt?.attemptId`):** Identifies the specific, unique refresh attempt. Proves whether the response belongs to the actively dispatched network operation or to an orphaned/predecessor attempt.
3. **Refresh Lease Epoch (`refreshLeaseEpoch`):** Identifies the ownership epoch. Proves that no successor worker has incremented the lease epoch ($E \to E + 1$) to claim ownership or initiate reconciliation.
4. **Worker Identity (`refreshWorkerId`):** Identifies the current worker. Guarantees that the execution context receiving the response matches the execution context that currently holds the durable lease.
5. **Lifecycle Refresh State (`refreshState`):** Identifies whether the state machine currently permits that response. Must be in the active `"REFRESHING"` state; cannot commit if the state has transitioned to `"RECONCILIATION_REQUIRED"`, `"IDLE"`, or `"REAUTH_REQUIRED"`.
6. **Durable Lease Expiration (`refreshLeaseExpiresAt`):** Determines whether the worker still possesses local mutation authority. Once `Date.now() > refreshLeaseExpiresAt`, local mutation authority is permanently extinguished fail-closed.

If **ANY** of the six conditions fail:
$$\text{STALE\_RESPONSE\_DROPPED}$$
The response is rejected, and **NO CREDENTIAL MUTATION IS PERMITTED.**

---

### 10. Evidence Hierarchy: What Can Actually Prove Success?

When evaluating recovery or lifecycle decisions, evidence is strictly categorized:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   EVIDENCE HIERARCHY                                   │
├───────────────────────────────┬─────────────────────────┬──────────────────────────────┤
│ Evidence Type                 │ Classification          │ Evidentiary Scope            │
├───────────────────────────────┼─────────────────────────┼──────────────────────────────┤
│ Persisted Credential Commit   │ AUTHORITATIVE           │ Proves G+1 tokens committed  │
│ Active Refresh Attempt Record │ AUTHORITATIVE           │ Proves local ownership/state │
│ Persisted Credential Gen (G)  │ AUTHORITATIVE           │ Proves credential version    │
│ Re-authentication (Device)    │ AUTHORITATIVE           │ Establishes new root tokens  │
│ Authoritative HTTP Response   │ AUTHORITATIVE (Point)   │ Proves server outcome to (W) │
│ Access-Token Validation       │ SUPPORTING              │ Proves old token active      │
│ Elapsed Time (Timeout)        │ NON-AUTHORITATIVE       │ NEVER proves failure         │
│ Absence of Response           │ NON-AUTHORITATIVE       │ NEVER proves failure         │
│ Local Lease Expiration        │ NON-AUTHORITATIVE (Net) │ NEVER proves server drop     │
└───────────────────────────────┴─────────────────────────┴──────────────────────────────┘
```

#### Critical Evidence Clarifications:
1. **Access Token Still Valid (What it CAN and CANNOT Prove):**
   - *Can Prove:* Calling `GET /user` with the existing access token confirms the user account exists and this access token has not been revoked.
   - *Cannot Prove:* **It DOES NOT prove that the previous refresh attempt failed!** Under GitHub's OAuth specification, an existing access token remains valid until its 8-hour expiration even after its paired refresh token has been rotated into a new refresh token. Thus, an active access token does not prove the refresh token was not consumed upstream.
2. **Access Token Invalid (What it CAN and CANNOT Prove):**
   - *Can Prove:* The access token has expired or was revoked.
   - *Cannot Prove:* **It DOES NOT prove that the refresh attempt succeeded.** Expiration may simply be due to the natural passage of time, or revocation may be due to user action on GitHub.com.
3. **Elapsed Time:**
   - Mere passage of time proves only that local execution took $T$ milliseconds. It provides zero protocol evidence regarding server-side state.

---

### 11. Detailed Algorithms for Response Processing

#### 13-Step Success Response Algorithm (Fenced Credential-State Commit)
```typescript
/**
 * Executes authoritative fenced credential commit upon receiving HTTP 200.
 */
async function handleRefreshSuccess(
  response: RefreshResponseMetadata,
  tokenData: { access_token: string; refresh_token: string; expires_in: number; refresh_token_expires_in: number },
  storage: StorageService
): Promise<string> {
  // 1. In-memory schema validation of response tokens
  if (!tokenData.access_token?.startsWith("ghu_") || !tokenData.refresh_token?.startsWith("ghr_")) {
    throw new GitHubAuthError("Malformed token response from GitHub", ErrorCode.GITHUB_REFRESH_FAILED);
  }

  // 2. Acquire exclusive runtime Web Lock for storage synchronization
  return navigator.locks.request("codesync:auth:refresh", { mode: "exclusive" }, async () => {
    // 3. Load current durable auth state from browser.storage.local
    const rawAuth = await storage.get<unknown>(STORAGE_KEYS.AUTH);
    
    // 4. Validate durable storage integrity
    const currentAuth = validateAuthStateIntegrity(rawAuth);

    // 5. Evaluate Authoritative Response Fencing Predicate
    if (!isResponseAuthoritative(response, currentAuth)) {
      // 6. Fencing Failed: Stale response dropped fail-safe
      console.warn("Stale refresh response dropped: authority check failed.", {
        responseAttempt: response.attemptId,
        currentAttempt: currentAuth.activeAttempt?.attemptId,
        currentGen: currentAuth.refreshGeneration,
      });
      // 7. If storage generation already advanced, adopt newer tokens
      if (currentAuth.refreshGeneration > response.credentialGeneration) {
        return currentAuth.accessToken;
      }
      throw new GitHubAuthError("Refresh response lost authority.", ErrorCode.GITHUB_REFRESH_FAILED);
    }

    // 8. Construct updated attempt record
    const resolvedAttempt: RefreshAttemptRecord = {
      ...currentAuth.activeAttempt!,
      state: "COMMITTED",
      resolutionStatus: "committed",
    };

    // 9. Prune predecessor history (max 5, prune > 7 days)
    const updatedPredecessors = [resolvedAttempt, ...currentAuth.predecessorAttempts]
      .filter(att => Date.now() - att.startedAt < 7 * 86_400_000)
      .slice(0, 5);

    // 10. Construct new cohesive credential state (Single Logical Object)
    const nextAuth: GitHubAuthState = {
      ...currentAuth,
      status: "authenticated",
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpiresAt: Date.now() + tokenData.expires_in * 1000,
      refreshTokenExpiresAt: Date.now() + tokenData.refresh_token_expires_in * 1000,
      refreshGeneration: currentAuth.refreshGeneration + 1, // Monotonic increment G -> G + 1
      refreshState: "IDLE",
      activeAttempt: undefined,
      predecessorAttempts: updatedPredecessors,
      refreshWorkerId: undefined,
      refreshLockAcquiredAt: undefined,
      refreshLeaseExpiresAt: undefined,
      lastValidatedAt: Date.now(),
    };

    // 11. Single-object fenced credential-state persistence to browser.storage.local
    await storage.set(STORAGE_KEYS.AUTH, nextAuth);

    // 12. Return verified access token
    return nextAuth.accessToken;
  });
}
```

#### 12-Step Error Response Algorithm (Fenced Error Evaluation)
```typescript
/**
 * Evaluates HTTP error response against authoritative fencing before modifying state.
 */
async function handleRefreshError(
  response: RefreshResponseMetadata,
  errorData: { error: string; error_description?: string },
  storage: StorageService
): Promise<string> {
  return navigator.locks.request("codesync:auth:refresh", { mode: "exclusive" }, async () => {
    // 1. Load current durable auth state
    const rawAuth = await storage.get<unknown>(STORAGE_KEYS.AUTH);
    const currentAuth = validateAuthStateIntegrity(rawAuth);

    // 2. Check Generation Advancement: Newer credentials already committed!
    if (currentAuth.refreshGeneration > response.credentialGeneration) {
      console.warn("Stale refresh error ignored: generation advanced.", { error: errorData.error });
      return currentAuth.accessToken; // Discard error, adopt newer tokens
    }

    // 3. Check Lease Epoch Authority: If superseded, worker has ZERO authority
    if (currentAuth.refreshLeaseEpoch !== response.leaseEpoch || currentAuth.refreshWorkerId !== response.workerId) {
      console.warn("Stale refresh error ignored: worker lease superseded.", { error: errorData.error });
      throw new GitHubAuthError(`Obsolete refresh error discarded: ${errorData.error}`, ErrorCode.GITHUB_REFRESH_FAILED);
    }

    // 4. Inspect Predecessor History: Did an earlier attempt run for this same generation?
    const hasInFlightPredecessor = currentAuth.predecessorAttempts.some(
      att => att.credentialGeneration === response.credentialGeneration &&
             (att.resolutionStatus === "in_flight" || att.resolutionStatus === "unknown")
    );

    // 5. Same-Generation Error Race Detection
    if (hasInFlightPredecessor) {
      console.warn("Same-generation error race detected: predecessor attempt was in flight.");
      // MUST NOT conclude failure! Transition to RECONCILIATION_REQUIRED
      const updatedAttempt: RefreshAttemptRecord = {
        ...currentAuth.activeAttempt!,
        state: "RECONCILIATION_REQUIRED",
        resolutionStatus: "reconciliation_required",
        errorClassification: errorData.error,
      };

      await storage.set(STORAGE_KEYS.AUTH, {
        ...currentAuth,
        status: "reconciliation_required",
        refreshState: "RECONCILIATION_REQUIRED",
        activeAttempt: undefined,
        predecessorAttempts: [updatedAttempt, ...currentAuth.predecessorAttempts].slice(0, 5),
      });

      throw new GitHubAuthError(
        "Refresh outcome uncertain due to competing predecessor attempt. Reconciliation required.",
        ErrorCode.GITHUB_REFRESH_FAILED
      );
    }

    // 6. Determine whether error is authoritative terminal failure (e.g. refresh token revoked on GitHub)
    if (errorData.error === "bad_refresh_token" || errorData.error === "invalid_grant") {
      // 7. Verify no concurrent commit occurred during check
      const recheckAuth = validateAuthStateIntegrity(await storage.get<unknown>(STORAGE_KEYS.AUTH));
      if (recheckAuth.refreshGeneration > response.credentialGeneration) {
        return recheckAuth.accessToken;
      }

      // 8. Transition to REAUTH_REQUIRED (Never silently destroy tokens)
      const failedAttempt: RefreshAttemptRecord = {
        ...currentAuth.activeAttempt!,
        state: "REAUTH_REQUIRED",
        resolutionStatus: "reauth_required",
        errorClassification: errorData.error,
      };

      await storage.set(STORAGE_KEYS.AUTH, {
        ...currentAuth,
        status: "reauth_required",
        refreshState: "IDLE",
        activeAttempt: undefined,
        predecessorAttempts: [failedAttempt, ...currentAuth.predecessorAttempts].slice(0, 5),
        refreshWorkerId: undefined,
        refreshLeaseExpiresAt: undefined,
      });

      throw new GitHubAuthError(
        `GitHub refresh token is invalid or revoked: ${errorData.error_description || errorData.error}. Re-authentication required.`,
        ErrorCode.GITHUB_AUTH_REQUIRED
      );
    }

    // 9. Transient Error (Network glitch, 502/503/504, rate limit): Revert state to IDLE
    if (currentAuth.refreshLeaseEpoch === response.leaseEpoch) {
      await storage.set(STORAGE_KEYS.AUTH, {
        ...currentAuth,
        refreshState: "IDLE",
        activeAttempt: undefined,
        refreshWorkerId: undefined,
        refreshLeaseExpiresAt: undefined,
      });
    }

    throw new GitHubAuthError(`Transient refresh failure: ${errorData.error}`, ErrorCode.GITHUB_REFRESH_FAILED);
  });
}
```

#### Terminology Precision: Fenced Persistence vs. Validated Transactional Write Protocol

CodeSync strictly rejects misleading claims of database-grade atomicity across independent systems. The architecture establishes the following precise operational terminology:

1. **Single-Object Fenced Credential-State Persistence:**
   All authentication and credential lifecycle properties (`accessToken`, `refreshToken`, `tokenExpiresAt`, `refreshGeneration`, `refreshState`, `activeAttempt`, `predecessorAttempts`, `refreshWorkerId`, `refreshLeaseEpoch`, `refreshLeaseExpiresAt`) are serialized together into a single cohesive JSON object committed to `browser.storage.local` under the key `codesync:auth`. This prevents split-state corruption where an access token is updated without its corresponding refresh token or generation counter. However, this is *single-object storage persistence*, NOT a distributed two-phase commit or transactional database engine.
2. **Durable Fencing:**
   Fencing tokens (monotonic generation $G$, unique attempt UUID $A$, monotonic lease epoch $E$, worker identity $W$, and lease expiration timestamp) protect durable state against stale writes. If an execution context cannot prove all fencing preconditions, its write is rejected fail-closed. Fencing guarantees safety in asynchronous and multi-worker environments where locks cannot span process crashes.
3. **Version Validation:**
   Runtime schema validation (via `validateAuthStateIntegrity`) validates all invariants and structural constraints before and after persistence.
4. **Optimistic Concurrency Control (OCC):**
   Remote state mutations on GitHub (such as file commits via Contents API `PUT /repos/{owner}/{repo}/contents/{path}`) use the remote file's Git blob SHA as an optimistic lock. The write succeeds only if the remote file has not been modified since it was read.
5. **Validated Transactional Write Protocol:**
   The multi-step GitHub file update pipeline (repository check, branch verification, path validation, pre-flight GET, duplicate check, OCC PUT, commit verification) is structured as a disciplined protocol with pre-condition validation and rollback/reconciliation handling. It is explicitly **NOT an atomic database transaction**, as network disconnections or concurrent external commits may intervene between distinct HTTP requests.

---

### 12. Deterministic Recovery Across Service-Worker Restart Scenarios (Cases A–G)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        SERVICE-WORKER RESTART RECOVERY MATRIX                          │
├──────┬──────────────────────┬────────────────────────┬─────────────────────────────────┤
│ Case │ Restart Point        │ Persisted State at Wake│ Successor Deterministic Action  │
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ A    │ Before request       │ refreshState: IDLE     │ Normal start. Worker acquires   │
│      │ dispatch             │ Epoch E, Gen G         │ lease E+1, creates attempt UUID.│
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ B    │ Immediately after    │ refreshState: REFRESH  │ Lease active. Successor awaits  │
│      │ dispatch (in transit)│ Attempt A in-flight    │ unexpired lease TTL (30s).      │
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ C    │ In-flight; lease     │ refreshState: REFRESH  │ Successor marks Attempt A as    │
│      │ expires (> 30s)      │ Lease TTL expired      │ UNKNOWN, enters RECONCILIATION. │
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ D    │ GitHub processed;    │ refreshState: REFRESH  │ Response packet lost in transit.│
│      │ response in transit  │ Lease TTL expired      │ Attempt A outcome UNKNOWN.      │
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ E    │ Success received;    │ refreshState: REFRESH  │ Old worker died before commit.  │
│      │ died before commit   │ Tokens in volatile RAM │ R2 lost. Successor enters REAUTH│
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ F    │ During credential    │ Fenced single-object   │ Schema validator passes G+1 OR  │
│      │ storage.set IPC      │ persistence: G or G+1  │ detects partial $\to$ REAUTH.   │
├──────┼──────────────────────┼────────────────────────┼─────────────────────────────────┤
│ G    │ Immediately after    │ refreshState: IDLE     │ Commit complete. Successor reads│
│      │ storage commit       │ Gen G+1, tokens active │ valid G+1 tokens directly.      │
└──────┴──────────────────────┴────────────────────────┴─────────────────────────────────┘
```

#### Detailed Scenario Handlers:

##### Scenario M: Success Response Lost (Case E / Case D)
- **Failure Model:** Worker A sends `refresh(R1)`. GitHub consumes $R_1$ and issues $R_2$. The browser terminates Worker A before $R_2$ is committed to storage. Worker B wakes later. $R_1$ is consumed upstream, but $R_2$ is permanently lost.
- **Architectural Defense:** Worker B observes `activeAttempt` with status `UNKNOWN` or lease expired. Worker B **CANNOT reuse $R_1$**. If Worker B dispatches `refresh(R1)`, GitHub returns HTTP 400. Worker B detects that Attempt A's outcome is unknown.
- **Fail-Closed Resolution:** CodeSync transitions auth state to `status: "reauth_required"`. It preserves user configuration and queued jobs, but prompts the user to reconnect. **Occasional re-authentication is explicitly accepted as the necessary cost of maintaining credential integrity without a backend proxy.**

##### Scenario N: Error Response Lost
- **Failure Model:** Worker A sends `refresh(R1)`. GitHub rejects it with HTTP 400. Worker A terminates before receiving the error. Worker B wakes.
- **Architectural Defense:** Worker B observes an uncommitted attempt across a lease boundary. Worker B flags the outcome as `UNKNOWN`, not assumed failure. It checks supporting evidence (access token validity) before escalating to `REAUTH_REQUIRED`.

---

### 13. Mandatory Adversarial Concurrency Matrix (Scenarios A through L)

The following matrix formally specifies CodeSync's deterministic behavior across all twelve adversarial edge cases identified in the security review:

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

### 14. Stale Worker Authority Prohibition Rules

An obsolete worker whose lease epoch was superseded ($E_{persisted} > E_{worker}$) or whose generation advanced ($G_{persisted} > G_{worker}$) is strictly prohibited from executing any of the following mutations:
1. **NO Credential Commits:** Cannot write access or refresh tokens.
2. **NO State Resets:** Cannot reset `refreshState` to `"IDLE"`.
3. **NO Ownership Tampering:** Cannot clear or modify `refreshWorkerId`, `refreshAttemptId`, or `activeAttempt`.
4. **NO Lease Modifications:** Cannot extend or invalidate a newer worker's lease epoch or expiration time.
5. **NO Predecessor Deletions:** Cannot clear, truncate, or overwrite `predecessorAttempts`.
6. **NO Status Downgrades:** Cannot transition `status` to `"expired"`, `"revoked"`, or `"reauth_required"`.

---

### 15. Reference Specification: Hardened `DurableTokenLifecycleManager`

```typescript
export class DurableTokenLifecycleManager {
  private static readonly REFRESH_LEASE_TTL_MS = 30_000; // 30-second durable lease
  private static readonly PRE_FLIGHT_BUFFER_MS = 300_000; // 5-minute pre-expiry buffer
  private static readonly RECONCILIATION_POLL_INTERVAL_MS = 1_000;
  private static readonly MAX_RECONCILIATION_WAIT_MS = 5_000;

  constructor(
    private readonly storageService: StorageService,
    private readonly clientId: string
  ) {}

  async getValidAccessToken(workerId: string): Promise<string> {
    const rawAuth = await this.storageService.get<unknown>(STORAGE_KEYS.AUTH);
    const auth = validateAuthStateIntegrity(rawAuth);

    if (auth.status === "reauth_required") {
      throw new GitHubAuthError("GitHub re-authentication is required.", ErrorCode.GITHUB_AUTH_REQUIRED);
    }
    if (auth.status !== "authenticated" && auth.status !== "reconciliation_required") {
      throw new GitHubAuthError("User authentication is required.", ErrorCode.GITHUB_AUTH_REQUIRED);
    }

    // Fast path: Token valid and system idle
    const isFresh = Date.now() < auth.tokenExpiresAt - DurableTokenLifecycleManager.PRE_FLIGHT_BUFFER_MS;
    if (isFresh && auth.refreshState === "IDLE") {
      return auth.accessToken;
    }

    return this.executeCoordinatedRefresh(workerId);
  }

  private async executeCoordinatedRefresh(workerId: string): Promise<string> {
    const doRefresh = async (): Promise<string> => {
      // 1. Re-read storage inside lock boundary
      const currentAuth = validateAuthStateIntegrity(await this.storageService.get<unknown>(STORAGE_KEYS.AUTH));

      if (currentAuth.status === "reauth_required") {
        throw new GitHubAuthError("Re-authentication required.", ErrorCode.GITHUB_AUTH_REQUIRED);
      }

      // Check if another worker already refreshed
      if (Date.now() < currentAuth.tokenExpiresAt - DurableTokenLifecycleManager.PRE_FLIGHT_BUFFER_MS &&
          currentAuth.refreshState === "IDLE") {
        return currentAuth.accessToken;
      }

      // 2. Evaluate existing in-flight lease
      if (currentAuth.refreshState === "REFRESHING") {
        const leaseAge = Date.now() - (currentAuth.refreshLockAcquiredAt ?? 0);
        if (leaseAge < DurableTokenLifecycleManager.REFRESH_LEASE_TTL_MS) {
          // Bounded wait for concurrent worker
          await new Promise(r => setTimeout(r, 1000));
          const refreshed = validateAuthStateIntegrity(await this.storageService.get<unknown>(STORAGE_KEYS.AUTH));
          if (Date.now() < refreshed.tokenExpiresAt - DurableTokenLifecycleManager.PRE_FLIGHT_BUFFER_MS) {
            return refreshed.accessToken;
          }
        }
        // Lease expired (>30s) -> Quarantine expired attempt before claiming
      }

      // 3. Prepare fresh attempt record & monotonic lease claim
      const startingGeneration = currentAuth.refreshGeneration;
      const startingLeaseEpoch = (currentAuth.refreshLeaseEpoch ?? 0) + 1;
      const attemptId = crypto.randomUUID();
      const leaseExpiresAt = Date.now() + DurableTokenLifecycleManager.REFRESH_LEASE_TTL_MS;

      const attemptRecord: RefreshAttemptRecord = {
        attemptId,
        credentialGeneration: startingGeneration,
        leaseEpoch: startingLeaseEpoch,
        workerId,
        startedAt: Date.now(),
        leaseExpiresAt,
        state: "CREATED",
        resolutionStatus: "in_flight",
      };

      // Archive prior active attempt if uncommitted
      const predecessors = currentAuth.activeAttempt
        ? [{ ...currentAuth.activeAttempt, state: "UNKNOWN" as AttemptState, resolutionStatus: "unknown" as AttemptResolutionStatus }, ...currentAuth.predecessorAttempts].slice(0, 5)
        : currentAuth.predecessorAttempts;

      // 4. Persist durable lease intent
      await this.storageService.set(STORAGE_KEYS.AUTH, {
        ...currentAuth,
        refreshState: "REFRESHING",
        activeAttempt: attemptRecord,
        predecessorAttempts: predecessors,
        refreshLockAcquiredAt: Date.now(),
        refreshLeaseExpiresAt: leaseExpiresAt,
        refreshWorkerId: workerId,
        refreshLeaseEpoch: startingLeaseEpoch,
      });

      const responseMeta: RefreshResponseMetadata = {
        attemptId,
        credentialGeneration: startingGeneration,
        leaseEpoch: startingLeaseEpoch,
        workerId,
      };

      // 5. Dispatch HTTP Refresh Request
      let tokenData: any;
      try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            client_id: this.clientId,
            grant_type: "refresh_token",
            refresh_token: currentAuth.refreshToken,
          }),
        });
        tokenData = await res.json();
      } catch (networkErr) {
        // Safe transient error cleanup: clear lease only if this worker still holds epoch
        const checkAuth = validateAuthStateIntegrity(await this.storageService.get<unknown>(STORAGE_KEYS.AUTH));
        if (checkAuth.refreshLeaseEpoch === startingLeaseEpoch && checkAuth.refreshWorkerId === workerId) {
          await this.storageService.set(STORAGE_KEYS.AUTH, {
            ...checkAuth,
            refreshState: "IDLE",
            activeAttempt: undefined,
            refreshWorkerId: undefined,
            refreshLeaseExpiresAt: undefined,
          });
        }
        throw networkErr;
      }

      // 6. Route response through authoritative algorithms
      if (tokenData.error) {
        return handleRefreshError(responseMeta, tokenData, this.storageService);
      }

      return handleRefreshSuccess(responseMeta, tokenData, this.storageService);
    };

    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("codesync:auth:refresh", { mode: "exclusive" }, doRefresh);
    }
    return doRefresh();
  }
}
```

---

## G. Token Security Threat Model

The table below catalogs every potential credential leakage vector and its architectural mitigation:

| Leakage Vector | Risk Description | Architectural Mitigation |
| :--- | :--- | :--- |
| **`console.log` / Diagnostics** | Developer debug statements outputting raw request headers or token strings. | `TokenRedactor` in `src/shared/logger/redactor.ts` strips tokens via regex (`ghu_`, `ghr_`, `ghp_`, `github_pat_`). Static ESLint rules prohibit raw `console.log` in source code. |
| **Error Objects / Stack Traces** | Network error or fetch exception containing the Authorization header in error message. | Custom `GitHubApiError` explicitly redacts headers and truncates URLs to origin + path, never exposing query params or auth headers. |
| **Message Bus Interception** | Content script listening to extension messages or spoofing an internal request to obtain tokens. | Context-to-action allowlists (`CONTEXT_ALLOWED_ACTIONS`) block content scripts from calling any auth action. `GET_GITHUB_STATUS` returns strictly `GitHubUserSummary` (zero tokens). |
| **`browser.storage.local` Inspection** | Untrusted web page attempting to read extension storage. | Browser extensions enforce origin isolation: web pages cannot read `browser.storage.local`. Content scripts are blocked by manifest boundary. |
| **IndexedDB Leakage** | Tokens leaking into WAL entries or payload records. | `WalEntry` and `QueueItemPayload` data models strictly omit credential fields. Storage schema tests verify zero token strings exist in `IndexedDB`. |
| **URL Parameter Snooping** | Sending tokens as query parameters (e.g. `?access_token=...`). | Tokens are transmitted strictly via the HTTP `Authorization: Bearer <token>` header. Never in URLs. |
| **Build Artifacts & Source Maps** | Committing client secrets or private keys to Git. | No client secret is used. `wxt.config.ts` excludes secrets. `.gitignore` forbids `.env` files. Static scan in `code-hygiene.test.ts` fails build if secrets are detected. |
| **Test Fixtures & Snapshots** | Live GitHub tokens saved in test files or snapshot outputs. | All tests use synthetic mock strings (e.g. `mock_ghu_test_token_12345`). Live credentials fail `code-hygiene.test.ts`. |

---

## H. Centralized GitHub API Client Architecture

All outbound HTTP calls to `api.github.com` pass strictly through the centralized `GitHubApiClient`. Direct `fetch()` calls to GitHub outside this service are forbidden.

### 1. Standard Request Contract
- **Base URL:** `https://api.github.com`
- **Standard Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer <token>`
  - `X-GitHub-Api-Version: 2026-03-10`
  - `User-Agent: CodeSync-Extension/0.1.0`
- **Timeout & Cancellation:** Every request uses an `AbortController` bounded by a strict 15-second timeout.
- **Payload Validation:** Response JSON is validated against Zod or strict TypeScript type guards before being returned to callers.

### 2. Error Normalization Pipeline
Raw HTTP responses are mapped deterministically to `GitHubApiError` subclasses:

```
[Raw HTTP Fetch Response]
         │
         ├──► Status 200 / 201 ──► Validate JSON Schema ──► Return Typed Data
         │
         ├──► Status 401 ───────► GitHubAuthError (AUTH_EXPIRED / INVALID_CREDENTIALS)
         │
         ├──► Status 403 ───────► Rate Limit Header Check:
         │                         • Remaining === 0 ──► GitHubRateLimitError (PRIMARY_LIMIT)
         │                         • Retry-After ──────► GitHubRateLimitError (SECONDARY_LIMIT)
         │                         • Other ────────────► GitHubPermissionError (INSUFFICIENT_PERMISSIONS)
         │
         ├──► Status 404 ───────► GitHubNotFoundError (TARGET_NOT_FOUND)
         │
         ├──► Status 409 ───────► GitHubConflictError (SHA_CONFLICT)
         │
         ├──► Status 422 ───────► GitHubValidationError (VALIDATION_FAILED)
         │
         ├──► Status 5xx ───────► GitHubServerError (TRANSIENT_SERVER_ERROR)
         │
         └──► Network Abort ────► GitHubNetworkError (TIMEOUT / OFFLINE)
```

---

## I. Repository Discovery & Permission Validation Architecture

### 1. Formal Repository Authorization Invariant
> **CORE AUTHORIZATION INVARIANT:**  
> **"A repository selected in CodeSync configuration is never considered authorized merely because it exists in local configuration."**

Local configuration represents only user intent, not authoritative permission. Every write operation must dynamically validate the target repository through the five-stage validation pipeline:

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

If **ANY** validation stage fails:
- The synchronization job halts immediately fail-closed.
- The queue item transitions to **`REQUIRES_ATTENTION`**.
- **NEVER SILENTLY RETARGET:** CodeSync strictly forbids redirecting a commit to another repository or branch without explicit user re-configuration.

### 2. Effective Permission Formula
$$\text{Effective Access} = \text{User Permissions} \cap \text{GitHub App Permissions} \cap \text{Installation Repository Scope}$$

### 3. Discovery APIs
1. **User Identity:** `GET /user` $\to$ Returns authenticated user login and account ID.
2. **Accessible Installations:** `GET /user/installations` $\to$ Returns installations of the CodeSync GitHub App accessible to this user.
3. **Accessible Repositories:** `GET /user/installations/{installation_id}/repositories` $\to$ Returns the exact set of repositories explicitly selected by the repository owner during App installation.

### 4. Write Capability Verification
Before allowing repository selection in the Options UI or committing a file, CodeSync validates:
- `repository.permissions.push === true` (or `admin === true`).
- `repository.archived === false` (cannot commit to archived repositories).
- `repository.disabled === false`.

### 5. Deterministic Handling of Repository Lifecycle & Permission Changes:
- **Repository Rename:** CodeSync tracks `repository_id` alongside `full_name`. If a repository is renamed, CodeSync re-queries installations using `repository_id`. If confirmed within the installation scope, the path/name is safely updated in local cache. If `repository_id` is missing, execution halts with `REQUIRES_ATTENTION` (`GITHUB_TARGET_NOT_FOUND`).
- **Repository Transfer:** If a repository is transferred to another user or organization outside the current GitHub App installation scope, subsequent API calls return `HTTP 404` or `403`. Execution halts with `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).
- **Repository Deletion:** Returns `HTTP 404 Not Found`. Sync halts fail-closed; queue item transitions to `REQUIRES_ATTENTION` (`GITHUB_TARGET_NOT_FOUND`).
- **GitHub App Uninstallation:** If the user or org revokes/uninstalls the CodeSync App on GitHub.com, calls to `/user/installations` omit the installation ID. Sync halts immediately; auth status is marked `revoked`; queue items transition to `REQUIRES_ATTENTION` (`GITHUB_AUTH_EXPIRED`).
- **Repository Removed from Installation Scope:** If the repository owner modifies the GitHub App installation from "All repositories" to "Selected repositories" and omits CodeSync's target, calls return `HTTP 404` or `403`. The job transitions to `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`).
- **User Push Permission Removed:** If the user is demoted from `Write` to `Read` on a collaborator repository, `permissions.push` returns `false`, and PUT returns `HTTP 403`. Sync halts fail-closed (`GITHUB_PERMISSION_DENIED`).
- **Organization Policy / SAML SSO Changes:** If the organization enforces SAML SSO or IP restrictions, GitHub returns `HTTP 403` with header `X-GitHub-SSO`. CodeSync captures the header, halts sync, and prompts the user in Options UI to authorize their SAML identity.

---

## J. Branch Validation Architecture

Branch names originate from user configuration or platform metadata and represent untrusted input.

### 1. CodeSync Safe Branch Grammar
CodeSync intentionally supports a conservative subset of valid Git branch names to reduce ambiguity and attack surface. CodeSync does not claim that this regex alone encompasses all valid Git reference syntax under `git check-ref-format`. Rather, CodeSync enforces this conservative grammar alongside explicit structural constraints:
- **Conservative Safe Grammar:** Must match regex `^[a-zA-Z0-9._/-]+$`
- **Boundary Rules:** Cannot begin or end with `/` or `.`
- **Consecutive Separator Prevention:** Cannot contain consecutive slashes `//`
- **Traversal Prevention:** Cannot contain sequence `..` anywhere
- **Lock File Prevention:** Cannot end with `.lock`
- **Control & Whitespace Prohibition:** Cannot contain control characters (`\x00-\x1F`, `\x7F`) or any whitespace characters
- **Length Constraint:** Maximum length of 100 characters

If a branch violates any of these constraints, synchronization halts immediately with `BRANCH_VALIDATION_ERROR` fail-closed.

### 2. Remote Branch Verification
Before attempting to write a solution file, the service verifies that the target branch exists on the remote repository via:
```http
GET /repos/{owner}/{repo}/branches/{branch}
```
If the endpoint returns `404 Not Found`, the synchronization job halts immediately fail-closed (`GITHUB_TARGET_BRANCH_NOT_FOUND`) rather than creating an un-parented orphan branch.

---

## K. Path & Template Security Architecture

Path construction is the most critical trust boundary in the synchronization pipeline. If a problem title contains malicious traversal or control sequences, an insecure path generator could compromise repository integrity, `.github/workflows`, or host filesystems.

### 1. The Three-Pillar Defense Model
> **Core Security Principle:** "Canonicalization reduces ambiguity; validation determines acceptability."  
> Unicode NFKC normalization alone is not a security barrier. It must be paired with strict grammar whitelisting and boundary containment checks.

```
[Raw Platform Metadata / User Template]
         │
         ▼
[Step 1: Recursive URL Decoding] ──────────► Multi-pass decodeURIComponent (max 3 cycles)
         │
         ▼
[Step 2: Unicode NFKC & Control Inspection] ──► .normalize('NFKC')
         │                                       Detect & reject \x00, control chars (\x00-\x1F, \x7F)
         │                                       FAIL CLOSED (PATH_VALIDATION_ERROR)
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

### 2. Control Characters: Detect, Reject, Fail Closed
> **NON-NEGOTIABLE RULE:** CodeSync **NEVER strips or silently sanitizes** control characters or null bytes at security boundaries.  
> Malicious or malformed inputs such as `"abc\0def"`, `"abc\ndef"`, `"abc\rdef"`, or `"abc\u001bdef"` MUST NOT be silently transformed into `"abcdef"`.  
> Any presence of null bytes (`\x00`) or control characters (`\x00-\x1F`, `\x7F-\x9F`) triggers immediate **fail-closed rejection** (`PATH_VALIDATION_ERROR`).

### 3. Traversal Semantics vs. Filename Policy Separation
CodeSync maintains a strict conceptual distinction between directory traversal attacks and general filename policy:
- **Actual Path Traversal:** Segments equal to `.` or `..`, or sequences that attempt to navigate directory hierarchies (`/../`, `\..\`, leading `..`), are categorized strictly as **`PATH_TRAVERSAL_DETECTED`**.
- **Consecutive Dot Filename Policy:** Filenames such as `version..final.cpp` do not constitute directory traversal, but are prohibited under CodeSync's conservative filename policy to eliminate ambiguities in file extension resolution and cross-platform file handling. These are categorized as **`INVALID_FILENAME_SEGMENT`**.

### 4. Template Variables & Normalization
Allowed template variables:
- `{platform}`: Sanitized alphanumeric (`LeetCode`, `Codeforces`).
- `{slug}`: Strict lowercase slug (`two-sum`, `watermelon`). Generated via `slugify(title)`.
- `{difficulty}`: Strictly `Easy`, `Medium`, or `Hard`.
- `{language}`: Normalized language identifier (`cpp`, `python3`, `java`).
- `{extension}`: Alphanumeric file extension (`cpp`, `py`, `java`).

**Fail-Closed Invariant:** If a platform metadata field contains characters that cannot be safely normalized to the grammar, the path generator **fails closed** and marks the item `REQUIRES_ATTENTION` (`PATH_VALIDATION_ERROR`). It **never** silently discards segments or produces an ambiguous target.

---

## L. Validated Transactional Write Protocol with Optimistic Concurrency Control

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
    │           • Verify response.type === 'file' (Reject dir/symlink fail-closed)
    │           • Capture existingSha = response.sha
    │           • Decode response.content (base64) -> normalize LF -> compute remoteHash
    │           • Compare remoteHash === localHash:
    │             - IF IDENTICAL: Transition item to SKIPPED. HALT (Zero commits created).
    │             - IF DIFFERENT: Evaluate Duplicate Policy:
    │               * Policy 'skip': Mark SKIPPED. HALT.
    │               * Policy 'keep_both': Generate suffix (two-sum-v2.cpp) & re-route.
    │               * Policy 'overwrite': Proceed to Step 5.
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
    │      └──► HTTP 409 Conflict: TOCTOU race -> Execute 409 Conflict Protocol (§M)
    │
    └─► 6. Post-Write Verification & Queue Completion
           • Verify commit exists via GET /repos/{owner}/{repo}/commits/{commitSha}
           • Update QueueItemMetadata to COMPLETED with commitSha and commitUrl
```

---

## M. Hardened GitHub 409 Conflict Protocol (No Blind Retries)

When the GitHub Contents API returns `HTTP 409 Conflict`, it indicates that another actor or process modified the remote file between CodeSync's pre-flight check (Step 4) and write attempt (Step 5), rendering the submitted `sha` stale.

> **CRITICAL SECURITY INVARIANT:**  
> **CodeSync NEVER performs a blind retry of an identical PUT with the updated SHA.**  
> Blindly retrying with an updated SHA would silently destroy modifications made to the repository by the user from another machine or IDE.

### The 8-Step Deterministic Conflict Resolution Protocol
1. **Intercept HTTP 409:** Halt write execution immediately.
2. **Increment Conflict Counter:** Check item conflict counter (`conflictsCount`). If `conflictsCount >= 2`, abort immediately and mark `REQUIRES_ATTENTION` (`SHA_CONFLICT`).
3. **Authoritative Fresh Re-Fetch:** Execute fresh `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` configured with `{ cache: "no-store" }` to obtain authoritative remote state directly from GitHub without appending non-standard query parameters or headers.
4. **Obtain Latest Remote State:** Extract newly committed blob SHA and base64 content.
5. **Recompute Content Hash:** Decode remote base64, apply LF normalization, and compute SHA-256 hash.
6. **Re-Evaluate Duplicate Policy:**
   - **Case A (Identical Content):** The remote file was updated by another process to the exact same solution. Result: mark item `SKIPPED`. Zero further writes.
   - **Case B (Policy = `skip`):** Remote content differs, user policy is `skip`. Result: mark item `SKIPPED`. Zero further writes.
   - **Case C (Policy = `keep_both`):** Generate next numeric filename (e.g. `two-sum-v2.cpp`) and restart safe write flow.
   - **Case D (Policy = `overwrite`):** Only if user explicitly selected overwrite, proceed to Step 7.
7. **Conditional Write or Safe Escalation:**
   - Attempt write with new remote SHA. If another 409 occurs: **PRESERVE REMOTE FILE**. Mark item `REQUIRES_ATTENTION` with error code `SHA_CONFLICT`.
8. **Surface Diff in UI:** Present an interactive diff in the Options UI so the user can explicitly resolve the conflict.

---

## N. Idempotency Strategy

In distributed browser environments, network failures frequently occur *after* the remote server accepts a write but *before* the browser receives the HTTP response.

### 1. The Ambiguous Timeout Scenario
1. CodeSync issues `PUT /contents/two-sum.cpp`.
2. GitHub writes the file, creates commit `c123`, and begins returning HTTP 201.
3. The user closes their laptop or Wi-Fi drops; fetch throws `TypeError: Failed to fetch`.
4. The queue worker crashes or triggers a retry.

### 2. Idempotent Reconciliation Protocol
On the subsequent retry attempt:
1. The worker executes Pre-Flight Read: `GET /contents/two-sum.cpp`.
2. The remote file exists.
3. The worker decodes the remote file and computes its SHA-256 content hash.
4. The remote content hash matches the local submission's content hash.
5. **Reconciliation:** The worker recognizes that the previous write actually succeeded. It retrieves the latest commit from `GET /commits?path=two-sum.cpp&per_page=1`, marks the queue item `COMPLETED` with that commit SHA, and halts without writing a duplicate commit.

---

## O. Network Retries & Backoff Strategy

### Retry Classification Table

| Error Type | HTTP Status | Retryable? | Strategy & Limits |
| :--- | :---: | :---: | :--- |
| **Transient Network Drop** | 0 / FetchError | YES | Jittered exponential backoff: $2000 \times 2^{\text{attempt}-1} \pm 20\%$. Max 5 attempts. |
| **GitHub Gateway Timeout** | 502, 503, 504 | YES | Jittered exponential backoff. Max 5 attempts. |
| **Internal Server Error** | 500 | YES | Jittered exponential backoff. Max 3 attempts. |
| **Primary Rate Limit** | 403 (rem=0) | YES (PAUSED) | Non-blocking queue pause until `x-ratelimit-reset` timestamp + 5s. Zero immediate retries. |
| **Secondary Rate Limit** | 403 / 429 | YES (PAUSED) | Non-blocking queue pause for `Retry-After` seconds (or 60s default). |
| **Authentication Expired** | 401 | NO | Fail-closed immediately. Clear tokens. Prompt user re-auth. Item $\to$ `REQUIRES_ATTENTION`. |
| **Permission Denied** | 403 (non-quota) | NO | Fail-closed immediately. Prompt repo selection. Item $\to$ `REQUIRES_ATTENTION`. |
| **Target Missing** | 404 (repo/branch) | NO | Fail-closed immediately. Check repo/branch. Item $\to$ `REQUIRES_ATTENTION`. |
| **SHA Conflict** | 409 | CONDITIONAL | Max 2 revalidation passes (§M). Never blind retry. Then $\to$ `REQUIRES_ATTENTION`. |
| **Validation Failed** | 422 | NO | Fail-closed immediately. Path/message invalid. Item $\to$ `REQUIRES_ATTENTION`. |

---

## P. Rate-Limit Strategy, Operational Parameters & Backpressure

### 1. Architectural Classification of Limits & Policies
To ensure precision, the architecture explicitly distinguishes external service limits from local extension policies:
- **Primary Rate Limits (External Service Quota):** Enforced by GitHub per authenticated user window.
- **Secondary Rate Limits (External Abuse Prevention):** Enforced by GitHub against rapid bursts of concurrent or mutating requests.
- **Application Backpressure (Reactive Queue Control):** CodeSync's dynamic reaction to HTTP response headers (`x-ratelimit-*`, `Retry-After`).
- **Local Throttling (Client-Side Reliability Policy):** CodeSync's defensive client-side pacing to prevent burst penalties.

### 2. Primary Rate Limit (Current GitHub Operational Parameter: 5,000 requests/hour)
GitHub documents an hourly quota of nominally 5,000 requests for authenticated user tokens. CodeSync treats this as an external operational parameter and parses live response headers rather than assuming a fixed limit:
- `x-ratelimit-limit`: Live quota cap.
- `x-ratelimit-remaining`: Remaining requests in current window.
- `x-ratelimit-reset`: Unix epoch timestamp for window reset.

**Reactive Application Backpressure:**
- If `x-ratelimit-remaining < 50`: The queue enters `THROTTLED` mode, inserting a 5-second delay between sequential items to preserve remaining quota for user operations.
- If `x-ratelimit-remaining === 0`: The queue enters `PAUSED` mode until `x-ratelimit-reset` epoch + 5s safety buffer.

### 3. Secondary Rate Limits & CodeSync Local Throttling Policy
GitHub enforces heuristic secondary rate limits (nominally documented as max 80 content-generating mutations per minute, 500 per hour, and 100 concurrent requests).

**CodeSync Defensive Mitigation Strategy:**
- **Strictly Sequential Concurrency:** Queue processing is strictly serialized (concurrency = 1); exactly one write operation is active at any time.
- **CodeSync Local Self-Throttling Policy:** CodeSync enforces a client-side minimum inter-item spacing of 1,000ms between sequential writes. *(Note: This is a CodeSync defensive reliability policy designed to smooth burst traffic, not a mandatory GitHub protocol constant).*
- **Retry-After Backpressure:** If GitHub returns `HTTP 403` or `429` with a `Retry-After` header, the queue pauses non-blocking for `Retry-After` seconds + 2s jitter before resuming.

---

## Q. Queue Integration Contract

The interface between the Phase 1B Queue Engine and Phase 1C GitHub Sync Engine is strictly decoupled:

```typescript
export interface GitHubSyncEngine {
  /**
   * Processes a single submission item through the safe write protocol.
   *
   * @param item Queue metadata snapshot
   * @param payload Full source code payload from IndexedDB
   * @param fencingToken Active worker lease generation number
   */
  processSubmission(
    item: QueueItemMetadata,
    payload: QueueItemPayload,
    fencingToken: number
  ): Promise<SyncJobResult>;
}

export type SyncJobResult =
  | { readonly status: "SUCCESS"; readonly commitSha: string; readonly commitUrl: string }
  | { readonly status: "SKIPPED"; readonly reason: "IDENTICAL_CONTENT" | "POLICY_SKIP" }
  | { readonly status: "RETRYABLE_ERROR"; readonly error: CodeSyncError; readonly retryAfterMs?: number }
  | { readonly status: "FATAL_ERROR"; readonly error: CodeSyncError; readonly code: ErrorCode };
```

---

## R. Configuration Snapshot Strategy (Enqueue-Time Immutability)

### The Dilemma
A user captures a LeetCode submission configured for `repoA / branch main`. While the item is pending in the queue, the user navigates to Settings and changes their target repository to `repoB` and branch to `dev`.

### Evaluated Models:
- **Model A (Snapshot at Enqueue Time):** The submission captures its target repository, branch, path template, and duplicate policy at the moment of submission.
- **Model B (Dynamic Resolution at Drain Time):** The worker reads the latest configuration from `browser.storage.local` at the moment of execution.

### Architectural Decision: Model A (Enqueue-Time Snapshotting)
**Justification:**
1. **Principle of Least Surprise:** A user who submitted code to Repository A would be alarmed if that code was silently written to Repository B because they changed settings 5 minutes later.
2. **Auditability & Integrity:** The Write-Ahead Log (`WalEntry`) requires an unambiguous intended state. Retargeting queued jobs on the fly creates race conditions between user edits and worker drains.
3. **Fail-Closed Safety:** If the snapshotted repository `repoA` is no longer accessible, the job transitions to `REQUIRES_ATTENTION` (`TARGET_REPOSITORY_UNAVAILABLE`) rather than guessing user intent.

---

## S. Comprehensive Error Taxonomy

All GitHub integration errors extend `CodeSyncError` with `failClosed = true`:

```typescript
export enum ErrorCode {
  // Existing Phase 1B codes preserved...
  
  // Phase 1C GitHub Authentication & Token Codes
  GITHUB_AUTH_REQUIRED = "GITHUB_AUTH_REQUIRED",
  GITHUB_AUTH_EXPIRED = "GITHUB_AUTH_EXPIRED",
  GITHUB_AUTH_USER_DENIED = "GITHUB_AUTH_USER_DENIED",
  GITHUB_DEVICE_CODE_EXPIRED = "GITHUB_DEVICE_CODE_EXPIRED",
  GITHUB_REFRESH_FAILED = "GITHUB_REFRESH_FAILED",
  
  // Phase 1C GitHub API & Authorization Codes
  GITHUB_PERMISSION_DENIED = "GITHUB_PERMISSION_DENIED",
  GITHUB_TARGET_NOT_FOUND = "GITHUB_TARGET_NOT_FOUND",
  GITHUB_TARGET_BRANCH_NOT_FOUND = "GITHUB_TARGET_BRANCH_NOT_FOUND",
  GITHUB_TARGET_IS_DIRECTORY = "GITHUB_TARGET_IS_DIRECTORY",
  GITHUB_RATE_LIMITED = "GITHUB_RATE_LIMITED",
  GITHUB_SECONDARY_RATE_LIMITED = "GITHUB_SECONDARY_RATE_LIMITED",
  
  // Phase 1C Write Protocol & OCC Codes
  GITHUB_SHA_CONFLICT = "GITHUB_SHA_CONFLICT",
  GITHUB_VERIFICATION_FAILED = "GITHUB_VERIFICATION_FAILED",
  GITHUB_VALIDATION_FAILED = "GITHUB_VALIDATION_FAILED",
  GITHUB_SERVER_ERROR = "GITHUB_SERVER_ERROR",
  
  // Phase 1C Path Security & Branch Codes
  PATH_VALIDATION_ERROR = "PATH_VALIDATION_ERROR",
  PATH_TRAVERSAL_DETECTED = "PATH_TRAVERSAL_DETECTED",
  INVALID_FILENAME_SEGMENT = "INVALID_FILENAME_SEGMENT",
  PATH_RESERVED_NAME = "PATH_RESERVED_NAME",
  PATH_BOUNDARY_EXCEEDED = "PATH_BOUNDARY_EXCEEDED",
  BRANCH_VALIDATION_ERROR = "BRANCH_VALIDATION_ERROR",
}
```

---

## T. Trust Boundaries

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

> **Network Security Specification:** CodeSync communicates with GitHub exclusively via HTTPS. TLS version negotiation and certificate validation are managed directly by the host browser's networking stack. CodeSync does not claim application-level certificate pinning or guaranteed TLS 1.3, but relies on the host browser platform's TLS validation.

---

## U. Threat Model A–Z

The following threat matrix analyzes all 26 threat scenarios specified in the phase requirements:

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
| **M** | **Network & Transport Failure** | Transport drop, DNS failure, TLS cert error, or ambiguous HTTP response during API calls. | Service Worker $\to$ Network | Layered handling: TLS cert errors fail closed immediately via browser stack. Transient transport drops trigger bounded jittered exponential backoff (max 5). Ambiguous timeouts trigger pre-flight hash reconciliation (§N). | Fail-closed on cert/HTTP errors; bounded retry on transient drops; idempotent recovery on timeouts. | Test transport drops, cert rejections, and ambiguous PUT response reconciliation. |
| **N** | **Stale SHA** | Remote file updated on GitHub while local write in flight. | Remote State $\to$ Write Protocol | Optimistic concurrency control (`sha` parameter on PUT); GitHub returns HTTP 409. | Halt write; enter 409 Conflict Protocol. | Test PUT with stale SHA triggers 409 handler. |
| **O** | **Concurrent Remote Edit** | User commits code from another machine during synchronization. | Remote State $\to$ Write Protocol | 409 Conflict Protocol re-fetches remote state and compares content hash. | Remote content preserved if hashes differ. | Test concurrent edit is preserved under safe policy. |
| **P** | **409 Conflict** | Remote conflict detected during PUT Contents API. | Write Protocol $\to$ Conflict Handler | 8-step conflict protocol executes re-fetch, hash compare, policy re-evaluation. Max 2 passes. | Bounded escalation to `REQUIRES_ATTENTION`. | Test conflict handler does not loop infinitely. |
| **Q** | **Ambiguous Network Response** | HTTP connection drops after GitHub committed write but before 201 received. | Network $\to$ Idempotency Engine | On retry, pre-flight read detects identical content hash and resolves state as `COMPLETED`. | No duplicate commit created. | Test retry after simulated response drop succeeds cleanly. |
| **R** | **Rate-Limit Abuse** | Excessive rapid submissions exhausting 5,000 req/hr quota. | Client $\to$ GitHub API | Centralized rate-limit monitor tracks `x-ratelimit-remaining`; pauses queue when `< 50`. | Queue non-blocking pause until reset epoch. | Test queue pauses when `x-ratelimit-remaining === 0`. |
| **S** | **Infinite Retry Loop** | Persistent 500 error or 409 conflict looping indefinitely. | Queue Engine $\to$ Retry Backoff | Maximum 5 retry attempts for transient errors; maximum 2 revalidations for 409. | Transitions to `REQUIRES_ATTENTION`. | Test 6th retry attempt marks item fatal. |
| **T** | **Service Worker Restart** | Browser terminates service worker during active GitHub write. | Lifecycle $\to$ Crash Recovery | Write-ahead log records `INTENT`; persistent lease fencing detects stale worker on wake. | Next worker recovers state via WAL idempotency. | Test recovery after simulated worker abort during write. |
| **U1** | **Duplicate Refresh Dispatch** | Concurrent sync operations dispatch multiple identical refresh requests using same $R_1$. | Worker $\to$ Token Lifecycle | Monotonic generation fencing ($G$) + Web Locks + durable lease ($E$). Only authoritative attempt can commit. | First commit advances $G \to G + 1$; duplicate responses dropped. | Test 11. |
| **U2** | **Stale Success Overwrite** | Delayed HTTP 200 arrives after lease expired and successor began. | Worker $\to$ Token Storage | Authoritative Response Fencing (`isResponseAuthoritative` checks $G$, attempt UUID, lease epoch, worker ID, TTL). | Response dropped (`STALE_RESPONSE_DROPPED`). Never overwrites newer credentials. | Test 6, Test 20. |
| **U3** | **Stale Error Invalidation** | Delayed HTTP 400 arrives after generation advanced ($G_{11} > G_{10}$). | Worker $\to$ Token Lifecycle | Pre-commit check discovers $G_{persisted} > G_{starting}$. | Error discarded (`STALE_REFRESH_ERROR_IGNORED`). Valid tokens preserved. | Test 1, Test 2. |
| **U4** | **Success Response Loss** | GitHub rotates $R_1 \to R_2$, but network drops before client receives $R_2$; SW terminates. | Network $\to$ Client Lifecycle | Successor detects uncommitted attempt across lease boundary; marks outcome `UNKNOWN` / `RECONCILIATION_REQUIRED`. Never blindly reuses $R_1$. | Bounded probe or fail-closed escalation to `REAUTH_REQUIRED`. | Test 22, Test 24. |
| **U5** | **Error Response Loss** | GitHub rejects refresh request; error packet lost before worker receives it. | Network $\to$ Client Lifecycle | Predecessor attempt remains uncommitted. Successor marks `UNKNOWN`. | Evaluates supporting evidence; avoids assumed failure. | Test 23. |
| **U6** | **Service-Worker Termination** | Browser kills service worker during active refresh fetch. | Lifecycle $\to$ Crash Recovery | Durable attempt record persists in `codesync:auth`. Successor claims epoch $E + 1$, preserves predecessor record. | No deadlock; old attempt quarantined as `UNKNOWN`. | Test 9. |
| **U7** | **Lease Expiration Ambiguity** | Local 30s lease expires while network request still traversing Internet. | Local Storage $\to$ Network Stack | Architecture recognizes `lease expiration ≠ network cancellation ≠ refresh failure`. | Successor fences lifecycle; old worker cannot commit if expired. | Test 10, Test 20. |
| **U8** | **Same-Generation Error Race** | Worker B receives `bad_refresh_token` for $G_{10}$ while Worker A's $G_{10}$ commit is in flight. | Worker A $\to$ Worker B Concurrency | Predecessor in-flight detection flags race; transitions to `RECONCILIATION_REQUIRED` instead of purging. | Credentials preserved; never purged on ambiguous evidence. | Test 3, Test 21. |
| **U9** | **Uncertain Upstream Token Rotation** | Refresh token consumed upstream without client confirmation. | Client $\to$ GitHub OAuth Boundary | State model defines `REFRESH_OUTCOME_UNKNOWN`. Blind reuse of uncertain token strictly forbidden. | Fails closed to `REAUTH_REQUIRED` rather than destroying credentials. | Test 22, Test 29. |
| **U10** | **Stale Metadata Mutation** | Obsolete worker attempts to reset `refreshState` to `IDLE` or clear lease owner. | Obsolete Worker $\to$ Storage | Epoch-guarded mutations: worker can clear state only if its `refreshLeaseEpoch` matches storage. | Mutation rejected. Stale worker has zero lifecycle authority. | Test 7, Test 8, Test 27. |
| **U11** | **Attempt-ID Substitution** | Misbehaving or concurrent worker attempts to commit under mismatched attempt UUID. | Worker $\to$ Fencing Engine | Attempt UUID verification in `isResponseAuthoritative`. | Commit rejected fail-closed. | Test 15. |
| **U12** | **Lease-Epoch Rollback** | Out-of-order storage write attempts to claim lease with $E \le E_{persisted}$. | Concurrency $\to$ Storage Service | Strict monotonic epoch verification ($E_{new} > E_{persisted}$). | Lease claim rejected fail-closed. | Test 14. |
| **U13** | **Generation Rollback** | Stale commit attempts to write tokens with $G \le G_{persisted}$. | Worker $\to$ Credential Storage | Monotonic generation invariant ($G_{new} > G_{persisted}$). | Commit rejected fail-closed. | Test 13. |
| **V** | **Revoked Authorization** | User revokes app on GitHub.com; API returns 401. | GitHub API $\to$ Auth Engine | 401 detected; tokens purged from storage; items transition to `REQUIRES_ATTENTION` (`GITHUB_AUTH_EXPIRED`). | Immediate fail-closed; prompt user re-auth. | Test 401 purges credentials and stops queue. |
| **W** | **Permission Reduction** | User alters repo permissions from write to read-only on GitHub. | GitHub API $\to$ Write Engine | HTTP 403 (non-quota) detected; write halted; item marked `REQUIRES_ATTENTION` (`GITHUB_PERMISSION_DENIED`). | Fail-closed; user prompted in Options UI. | Test 403 on PUT marks item `REQUIRES_ATTENTION`. |
| **X** | **Config Change While Queued** | User alters default repo in settings while items are pending in queue. | Config $\to$ Queue Engine | Enqueue-time snapshotting: items execute against their snapshotted destination. | No silent retargeting of queued submissions. | Test queued item writes to original target after config change. |
| **Y** | **Malicious Problem Title** | Problem title containing `CON.cpp`, `AUX`, or control characters. | Platform $\to$ Path Canonicalizer | Segment validator rejects Windows reserved device names and control characters. | Fails closed with `PATH_RESERVED_NAME` or `PATH_VALIDATION_ERROR`. | Test `CON.cpp` problem title fails validation. |
| **Z** | **Oversized Payload** | Submitting huge file (> 500 KB) consuming memory and quotas. | Payload $\to$ API Client | Strict 500 KB payload limit enforced before base64 encoding and network dispatch. | Fails closed with `PAYLOAD_TOO_LARGE`. | Test 501 KB payload is rejected before network dispatch. |

---

## V. Test Architecture

Testing the GitHub integration requires an adversarial, deterministic automated test suite covering authentication, credentials, path traversal, concurrency, network resilience, and error recovery:

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
│   ├── TEST 1: Worker A success -> Worker B stale error (B discards bad_refresh_token, adopts G11)
│   ├── TEST 2: Worker B success -> Worker A stale error (A discards bad_refresh_token, preserves R2)
│   ├── TEST 3: Worker A in-flight -> Worker B error while G unchanged (B transitions to RECONCILIATION_REQUIRED, preserves credentials)
│   ├── TEST 4: Worker A error -> Worker B success (A releases epoch, B rotates cleanly to G11)
│   ├── TEST 5: Worker A success -> Worker B success (concurrent 200s; first commits G11, second drops stale)
│   ├── TEST 6: Stale worker attempts credential commit (G10 commit rejected when storage has G11)
│   ├── TEST 7: Stale worker attempts refreshState reset (E41 worker cannot reset E42 state)
│   ├── TEST 8: Stale worker attempts lease cleanup (E41 worker cannot clear E42 lease owner)
│   ├── TEST 9: Service worker restart during refresh (recovery at CLAIMED, IN_FLIGHT, RECEIVED, VERIFIED)
│   ├── TEST 10: Lease expiration during in-flight HTTP request (successor claims E+1, old tolerated safely)
│   ├── TEST 11: Duplicate refresh requests using same R1 (both dispatched, generation fencing protects state)
│   ├── TEST 12: Partial credential persistence (schema validator rejects corrupt/missing fields fail-closed)
│   ├── TEST 13: Generation rollback attempt (commit with G <= G_persisted rejected fail-closed)
│   ├── TEST 14: Lease epoch rollback attempt (claim with E <= E_persisted rejected fail-closed)
│   ├── TEST 15: Attempt ID substitution attempt (mismatched attempt UUID rejected on commit)
│   ├── TEST 16: Worker ID substitution attempt (mismatched worker ID on cleanup rejected)
│   ├── TEST 17: Stale 401/bad_refresh_token cannot purge newer credentials (valid R2 untouched)
│   ├── TEST 18: Stale network error cannot downgrade authenticated state (session remains valid)
│   ├── TEST 19: Success response delayed beyond grace window (no false assumption of failure; TIMEOUT != PROOF)
│   ├── TEST 20: Success response arrives after lease expiration (old worker cannot commit; STALE_RESPONSE_DROPPED)
│   ├── TEST 21: Error arrives while predecessor success is in flight (transitions to RECONCILIATION_REQUIRED)
│   ├── TEST 22: Success response is permanently lost (no unsafe refresh-token reuse; fails closed to REAUTH_REQUIRED)
│   ├── TEST 23: Error response is permanently lost (marked UNKNOWN, not assumed failure)
│   ├── TEST 24: Service worker terminates after GitHub rotates token but before local commit (safe reconciliation or REAUTH_REQUIRED)
│   ├── TEST 25: Success arrives after successor attempt begins (stale response fencing drops older commit)
│   ├── TEST 26: Stale worker attempts to clear predecessor record (rejected fail-closed)
│   ├── TEST 27: Stale worker attempts to alter current attempt record (rejected fail-closed)
│   ├── TEST 28: Attempt A record overwritten by Attempt B (test MUST fail if implementation allows loss of predecessor evidence)
│   ├── TEST 29: Unknown outcome incorrectly converted to "expired" (rejected fail-closed; uncertainty preserved)
│   ├── TEST 30: Fixed grace period incorrectly treated as proof (rejected fail-closed; timeout != proof)
│   ├── TEST 31: Proof of Axiom 1: TIMEOUT != PROOF OF FAILURE (delay does not infer upstream drop)
│   ├── TEST 32: Proof of Axiom 2: NETWORK SUCCESS != PROOF OF LOCAL MUTATION AUTHORITY (post-expiry 200 dropped)
│   ├── TEST 33: Wrong Worker ID Rejection (Worker A cannot commit response received by Worker B; Check 4 fail)
│   ├── TEST 34: Invalid Refresh State Rejection (Response arriving during RECONCILIATION_REQUIRED or IDLE dropped; Check 5 fail)
│   ├── TEST 35: Terminology Consistency Verification (Audit rejects false claims of atomic multi-step or cross-store operations)
│   └── TEST 36: Documentation-Only Status Verification (Audit verifies zero production runtime code in src/ prior to gate pass)
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

### 18-Point Verification Matrix (Core Axioms & Lifecycle Fencing)

The test architecture formally maps all required lifecycle and fencing dimensions to automated test verification:

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

## W. Mock GitHub Server Design

To ensure 100% deterministic testing without hitting live GitHub rate limits or introducing live network dependencies, a high-fidelity mock server is specified to be constructed using Vitest and custom Fetch interception:

```typescript
export interface MockGitHubState {
  user: { login: string; id: number };
  installations: Array<{ id: number; account: string }>;
  repositories: Map<string, {
    owner: string;
    repo: string;
    permissions: { push: boolean; admin: boolean };
    branches: Map<string, { name: string; commitSha: string }>;
    files: Map<string, { content: string; sha: string }>;
  }>;
  rateLimit: {
    limit: number;
    remaining: number;
    reset: number;
  };
  deviceFlow: {
    pendingCodes: Map<string, { userCode: string; status: "pending" | "approved" | "denied"; expiresAt: number }>;
  };
  injectedFaults: {
    dropNextPut?: boolean;
    force409NextPut?: boolean;
    force500Count?: number;
    rateLimitRemainingZero?: boolean;
  };
}
```

### Supported Test Scenarios
- Normal file creation (HTTP 201) and update (HTTP 200).
- Stale SHA conflict (HTTP 409) with identical and differing content.
- Primary rate limit exhaustion (`x-ratelimit-remaining: 0`).
- Secondary rate limit burst response (`HTTP 429` with `Retry-After: 5`).
- Simulated network failure after write commit (Ambiguous Timeout).
- Concurrent token refresh requests verifying single network call.
- Revoked token returning `HTTP 401 Bad Credentials`.

---

## X. Required Permissions Specification

### 1. Browser Extension Manifest Permissions
CodeSync maintains its minimal permission footprint:
- **`permissions`:** `["storage"]` only.
- **`host_permissions`:**
  - `https://api.github.com/*` (Required for GitHub REST API communication).
  - `https://github.com/*` (Required for Device Flow token exchange endpoints).
- **Strictly Omitted:** `webRequest`, `declarativeNetRequest`, `cookies`, `<all_urls>`, broad host permissions.

### 2. GitHub App Granular Permissions
The CodeSync GitHub App requests exclusively:
- **Repository Permissions:**
  - `Contents: read and write` (Required to read existing solution files and commit new solutions).
- **Metadata Permissions:**
  - `Metadata: read-only` (Mandatory default for all GitHub Apps).
- **Zero Account / Org Permissions:** The GitHub App requests zero write or private account permissions (no email access, org management, gists, or security keys). CodeSync accesses only minimal authenticated user identity (login, account ID, avatar URL) via standard `GET /user` using the user access token solely for UI authentication status display.
- **Zero Extended Repo Permissions:** Zero access to actions, administration, environments, issues, pull requests, secrets, or webhooks.

---

## Y. Official GitHub Documentation References & Verification

All external service parameters, endpoint specifications, and authentication flows were verified against official GitHub documentation (Verification Date: September 13, 2026):

1. **GitHub App User Access Tokens & Expiration:**  
   [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)  
   *Verified: 8-hour access token lifespan (`expires_in = 28800`), 6-month refresh token lifespan (`refresh_token_expires_in = 15897600`). Classified as current GitHub documented operational parameters.*
2. **Device Flow Specification (RFC 8628):**  
   [Using the device flow to generate a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)  
   *Verified: `POST https://github.com/login/device/code`, polling `POST https://github.com/login/oauth/access_token`, error states (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`).*
3. **Refreshing User Access Tokens Without Client Secret:**  
   [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)  
   *Verified: `client_secret` is explicitly optional and NOT required when the token was generated via Device Flow.*
4. **Repository Contents REST API:**  
   [REST API endpoints for repository contents](https://docs.github.com/en/rest/repos/contents)  
   *Verified: `GET /repos/{owner}/{repo}/contents/{path}` schema, `PUT /repos/{owner}/{repo}/contents/{path}` parameters (`sha` required for update), status codes (200, 201, 404, 409, 422).*
5. **Rate Limits & Header Specifications:**  
   [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)  
   *Verified: Authenticated user limit (5,000 req/hr), secondary rate limits (80 mutations/min, 100 concurrent), inspection of `x-ratelimit-*` and `retry-after` headers. Local 1,000ms inter-item delay is explicitly classified as a CodeSync client-side reliability policy, not a GitHub API requirement.*

---

## Z. Open Questions & Residual Risks

### 1. Large File Limitations in Contents API
- **Context:** The GitHub Contents API documentation notes that files $> 1$ MB cannot have their content fetched via the standard `content` Base64 field (it returns an empty string).
- **Risk Assessment:** Competitive programming solutions in C++, Python, Java, etc., rarely exceed 50 KB. CodeSync enforces a strict **500 KB limit per file** (`PAYLOAD_TOO_LARGE`).
- **Mitigation:** The 500 KB limit ensures CodeSync never hits the 1 MB Base64 truncation boundary of the Contents API, completely avoiding the need for the complex Git Data Trees/Blobs API in Phase 1C.

### 2. Organization SAML SSO Enforcement
- **Context:** If a user chooses a repository belonging to an enterprise organization enforcing SAML SSO, token requests will fail with `403` until the user authorizes their SAML identity.
- **Mitigation:** The API client detects the `X-GitHub-SSO` response header and prompts the user with an actionable message: `"Organization requires SAML SSO authorization. Please authorize CodeSync in your GitHub organization settings."`

---

## AA. Core Security Invariants & Formal Authority Rules

### 1. Foundational Security Invariants
The CodeSync GitHub integration formally guarantees the following thirteen foundational security invariants:

1. **INVARIANT 1 (Monotonic Credential Generation):** Credential generation (`refreshGeneration: number`) increases strictly monotonically ($G \to G + 1$). It is never reset, rolled back, or decremented during the lifetime of an authenticated session.
2. **INVARIANT 2 (Credential Version Semantics):** Credential generation represents credential VERSION, not refresh-operation identity. Multiple attempts originating from the same generation share the same version root.
3. **INVARIANT 3 (Unique Attempt Identity):** Every refresh operation has a unique durable attempt identity (`attemptId: string` UUID).
4. **INVARIANT 4 (Monotonic Lease Epoch):** Every durable ownership transition has a monotonic lease epoch (`refreshLeaseEpoch: number`).
5. **INVARIANT 5 (Lease Expiration Independence):** Lease expiration does not prove network failure (`lease expiration ≠ network cancellation ≠ refresh failure`).
6. **INVARIANT 6 (Authoritative Response Fencing):** A response may mutate credentials only while its attempt remains authoritative under `isResponseAuthoritative`.
7. **INVARIANT 7 (Stale Response Immunity):** A stale response cannot overwrite newer credentials (`STALE_RESPONSE_DROPPED`).
8. **INVARIANT 8 (Stale Error Isolation):** A stale error cannot purge valid credentials.
9. **INVARIANT 9 (Unknown Outcome Integrity):** Unknown refresh outcome cannot be treated as confirmed failure (`TIMEOUT ≠ PROOF OF FAILURE`).
10. **INVARIANT 10 (Uncertain Refresh-Token Protection):** An uncertain rotating refresh token must not be blindly reused.
11. **INVARIANT 11 (Predecessor History Retention):** Predecessor attempt evidence must survive successor takeover until safe resolution or bounded quarantine (`predecessorAttempts` bounded FIFO).
12. **INVARIANT 12 (Dual-Authority Boundary):** Web Locks provide in-memory runtime coordination, but durable storage leases and monotonic epochs remain the authoritative security boundary across service-worker terminations and restarts.
13. **INVARIANT 13 (Fail-Closed Re-Authentication Hierarchy):** If credential validity cannot be safely established, CodeSync fails closed to explicit re-authentication rather than destroying or guessing credential state.

### 2. The 12 Formal Rules of Refresh Lifecycle Authority
To guarantee uncompromised distributed safety across all service-worker lifecycle boundaries, CodeSync codifies the following twelve formal rules:

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

## AB. Proposed Phase 1C Implementation Decomposition

To maintain strict phase gate integrity and avoid monolithic unreviewable commits, Phase 1C implementation is specified to be executed across 10 disciplined sub-phases:

```
Phase 1C.1: GitHub Domain Models, Error Taxonomy & Storage Schema
            ├── Define GitHubAuthState, GitHubApiError hierarchy, SyncJobResult
            └── Unit tests for schema validation and error code mapping

Phase 1C.2: Device Authorization Flow Engine
            ├── POST /login/device/code, polling loop, backoff on slow_down
            └── Tests for user approval, denial, expiry, cancellation, SW restart

Phase 1C.3: Token Storage, Durable Refresh Concurrency & Rotation
            ├── StorageService integration, DurableTokenLifecycleManager
            └── Tests verifying generation fencing, 30s lease, attempt UUID, and lease epoch

Phase 1C.4: Centralized GitHub API Client
            ├── Standard headers, timeouts, AbortController, rate-limit parser
            └── Tests for header inspection, rate-limit backpressure, error mapping

Phase 1C.5: Repository Discovery & Permission Verification
            ├── GET /user, GET /user/installations, permissions.push check
            └── Tests for repo listing, branch check, unauthorized repo rejection

Phase 1C.6: Path Template Engine & 8-Step Path Canonicalizer
            ├── Specification / implementation of 8-step pipeline (fail-closed control rejection, traversal vs filename policy)
            └── Comprehensive test suite covering traversal, Unicode, control rejection, Windows names

Phase 1C.7: Safe Write Protocol & Optimistic Concurrency Control
            ├── Pre-flight GET, hash comparison, PUT with sha, 200/201 handling
            └── Tests for new file creation, update with sha, content-identity skip, ambiguous PUT reconciliation

Phase 1C.8: Hardened 409 Conflict Protocol & Idempotent Reconciliation
            ├── 8-step conflict handler, authoritative fresh re-fetch (cache: "no-store"), duplicate policies
            └── Tests for max 2 passes, remote preservation, ambiguous timeout recovery

Phase 1C.9: Queue Engine Integration & Enqueue-Time Snapshotting
            ├── GitHubSyncEngine specification / implementation, worker fencing validation
            └── Tests for immutable destination execution and state transitions

Phase 1C.10: Mock GitHub Server & Adversarial Security Test Suite
             ├── Comprehensive test suite covering Threat Model A–Z
             └── Full build, lint, typecheck, format, and manifest audit
```

---

## AC. Final Security Verdict

# **PHASE 1C.0.5 LEASE-EXPIRY AUTHORITY & TERMINOLOGY CONSISTENCY PASS = PASS**

### Architectural Justification
1. **Zero Credential Exposure:** Tokens are confined exclusively to the service worker storage boundary; content scripts, web pages, logs, and queue metadata are excluded by construction.
2. **Zero Secret Footprint:** GitHub App Device Flow eliminates client secrets entirely from the client-side extension distribution.
3. **Provable Optimistic Concurrency:** File writes enforce OCC via blob SHAs, and the 409 Conflict Protocol eliminates blind overwrite vulnerabilities using authoritative fresh re-fetches without ad-hoc query parameters or headers.
4. **Tripartite Refresh Concurrency Authority:** The formal separation of Credential Generation ($G$), Refresh Attempt Identity ($A$), and Durable Lease Epoch ($E$) resolves all same-generation error races, stale response overwrites, and process restart ambiguities.
5. **Decoupled Network Completion & Local Authority:** Formally codifies $\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$ and $\text{NETWORK SUCCESS} \neq \text{PROOF OF LOCAL MUTATION AUTHORITY}$. Once the durable 30s lease expires, local mutation authority is permanently extinguished fail-closed.
6. **Elimination of False Guarantees & Misleading Terminology:** Eradicated false claims of cross-system atomicity and replaced them with precise definitions: single-object fenced credential persistence, version validation, durable fencing, and validated transactional write protocol with OCC.
7. **Authoritative Response Fencing:** Fenced commits require passing all 6 components of `isResponseAuthoritative` (matching generation lineage, active attempt UUID, lease epoch, worker ID, active `REFRESHING` state, and unexpired lease TTL).
8. **Durable Predecessor Evidence:** Bounded retention of predecessor attempts guarantees successor workers cannot overwrite or destroy in-flight attempt evidence.
9. **Safe Re-Authentication Fallback:** Prohibits blind reuse of uncertain rotating refresh tokens. Re-authentication is established as the safe, data-preserving terminal recovery state.
10. **Formal Repository Authorization Invariant:** Repositories are never trusted merely because they exist in local config; they must pass dynamic multi-stage authorization checks.
11. **Rigorous Path Traversal & Control Defense:** The 8-step canonicalization pipeline guarantees that hostile problem titles cannot escape the repository boundary and rejects all control characters fail-closed.
12. **Complete 36-Test Adversarial Matrix:** Expanded `token-lifecycle.test.ts` to 36 deterministic test specifications including explicit verification of core axioms, stale worker rejections, terminology hygiene, and documentation-only status.

### Non-Negotiable Gate Conditions
- **ZERO Production Code Changes:** No implementation code has been created or modified in `src/`.
- **Phase 1C.1 Remains LOCKED:** Phase 1C.1 remains **STRICTLY LOCKED** until Phase 1C.0.5 receives formal external review approval.

*(Reminder: Per Phase Gate rules, implementation remains halted until explicit human/ChatGPT audit approval.)*

