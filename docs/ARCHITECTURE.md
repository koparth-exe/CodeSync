# System Architecture Specification
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** System Architecture Specification

---

## 1. Architectural Philosophy & Principles

CodeSync is a **local-first, privacy-first, event-driven, cross-browser extension** designed to reliably capture competitive programming submissions and synchronize them to GitHub.

### Foundational Invariants:
1. **Local-First & Zero Backend**: Processing runs entirely in the browser runtime. CodeSync never deploys intermediary servers or proxies.
2. **Zero-Telemetry Privacy**: Source code and credentials never touch analytics, telemetry, or third-party networks. Transits exclusively over HTTPS to `api.github.com`.
3. **Defense-in-Depth & Fail-Closed**:
   > *"Never sacrifice security for convenience, compatibility, or implementation speed. If an operation cannot be performed safely, CodeSync must fail closed or require explicit user intervention rather than weakening its security model."*
4. **Least-Privilege Authorization**: Primary GitHub auth uses a **GitHub App** with Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions.
5. **Hybrid Partitioned Storage**: `browser.storage.local` manages metadata and state; `IndexedDB` stores heavy source-code payloads and history.
6. **Two-Tier Concurrency Architecture**: Uses the standard W3C Web Locks API for active runtime serialization, backed by a persistent storage lease record in `storage.local` (without assuming compare-and-swap primitives).
7. **Confidence Is NOT Security Trust**: Extraction confidence is an empirical completeness heuristic; passing the confidence threshold (≥0.70) merely permits entry into deterministic validation and never authorizes a write by itself.
8. **Three-Pillar Path Security**: Canonicalization reduces ambiguity, but a strict safe path grammar and boundary validation determine acceptability.

---

## 2. Global Architecture & Component Topology

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HOST PLATFORM BROWSER RUNTIME                                                   │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ ZONE 0: UNTRUSTED PAGE ENVIRONMENT (Hostile Web Context)                  │  │
│  │                                                                           │  │
│  │  Coding Platform Webpage (LeetCode, Codeforces, CodeChef, GFG)             │  │
│  │  • Untrusted DOM, ad scripts, mutated variables                           │  │
│  │                                                                           │  │
│  │  Page/World Bridge Script (Main World, Injected only when needed)          │  │
│  │  • Inspects in-memory editor instances (Monaco, ACE, CodeMirror)          │  │
│  │  • Communicates strictly via custom events/postMessage with origin checks │  │
│  │                                                                           │  │
│  │  Content Script (Isolated World)                                          │  │
│  │  • Semi-trusted: DOM accessible, isolated from page JS variables          │  │
│  │  • Validates all extracted strings before forwarding to service worker    │  │
│  │  • ZERO ACCESS TO GITHUB TOKENS OR STORAGE                                │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
│                                        │ browser.runtime.sendMessage             │
│                                        │ (Typed, Nonced, Origin & Tab Verified) │
│                                        ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ ZONE 1: TRUSTED EXTENSION CORE (Origin: chrome-extension://<id>)          │  │
│  │                                                                           │  │
│  │  Service Worker / Background Core (Authoritative Context)                 │  │
│  │  ┌─────────────────────────┐      ┌────────────────────────────────────┐  │  │
│  │  │ Platform Adapter Engine │      │ Normalization & Validation         │  │  │
│  │  │ • LeetCode Adapter      │─────►│ • Confidence filter (>= 0.70)      │  │  │
│  │  │ • Codeforces Adapter    │      │ • 9-step deterministic validation  │  │  │
│  │  │ • CodeChef Adapter      │      │ • Metadata sanitization            │  │  │
│  │  │ • GFG Adapter           │      │ • Content hashing (SHA-256)        │  │  │
│  │  └─────────────────────────┘      └─────────────────┬──────────────────┘  │  │
│  │                                                     │                     │  │
│  │                                                     ▼                     │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Queue Manager (Write-Ahead Log Protocol)                            │  │  │
│  │  │ • State transitions (PENDING -> PROCESSING -> COMPLETED / FAILED)   │  │  │
│  │  │ • Two-tier concurrency: Web Locks API + Storage Lease               │  │  │
│  │  │ • Crash recovery & poison-pill quarantine (max 3 crashes)           │  │  │
│  │  │ • Jittered exponential backoff retry engine                         │  │  │
│  │  └──────────────────┬───────────────────────────────┬──────────────────┘  │  │
│  │                     │                               │                     │  │
│  │                     ▼                               ▼                     │  │
│  │  ┌────────────────────────────────────┐ ┌──────────────────────────────┐  │  │
│  │  │ Sync Engine (Validated Protocol)   │ │ Hybrid Storage Manager       │  │  │
│  │  │ • Target repo & branch validation  │ │ • browser.storage.local:     │  │  │
│  │  │ • 3-Pillar path engine (Grammar)   │ │   Settings, Queue Metadata   │  │  │
│  │  │ • Optimistic PUT with blob SHA     │ │ • IndexedDB (PayloadStore):  │  │  │
│  │  │ • 8-step 409 conflict revalidation │ │   Source payloads & history  │  │  │
│  │  │ • Deduplication policy evaluator   │ └──────────────────────────────┘  │  │
│  │  └──────────────────┬─────────────────┘                                   │  │
│  │                     │                                                     │  │
│  │  ┌──────────────────┴──────────────────────────────────────────────────┐  │  │
│  │  │ GitHub Service                                                      │  │  │
│  │  │ • GitHub App User-to-Server Auth (Device Flow)                      │  │  │
│  │  │ • 8-hour token lifecycle & automatic refresh token rotation         │  │  │
│  │  │ • Rate limit header inspection & backpressure manager               │  │  │
│  │  │ • Advanced PAT fallback handler                                     │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                           │  │
│  │  Extension UI Context (Popup & Options Pages)                             │  │
│  │  • Strict CSP: script-src 'self'; object-src 'none'                       │  │
│  │  • React 19 + Zustand state management                                    │  │
│  │  • Live path template preview & error recovery dashboard                  │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
└────────────────────────────────────────┼────────────────────────────────────────┘
                                         │ HTTPS (Browser-negotiated TLS)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ZONE 2: EXTERNAL TRUSTED SERVICE                                                │
│                                                                                 │
│  GitHub REST API v3 (api.github.com)                                            │
│  • Scoped to user-selected repository Contents (write)                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Trust Boundary Architecture

| Component | Trust Level | Capabilities | Invariants & Constraints |
|---|---|---|---|
| **Platform Webpage** | **Untrusted** | Renders contest UI, runs vendor/ad scripts. | **Zero trust**. Cannot access extension APIs. Any DOM data or window event is treated as potentially adversarial. |
| **Page/World Bridge** | **Untrusted** | Inspects in-memory editor instances in page world. | Only injected when DOM extraction fails. Has **zero** extension privileges. Communicates only via origin-checked messages. |
| **Content Script** | **Semi-Trusted** | Observes submission events, reads DOM. | Runs in isolated world. **Never holds GitHub tokens**. Validates all fields against schemas before forwarding. |
| **Service Worker** | **Authoritative Trusted** | Manages queue, coordinates storage, holds active tokens, executes API calls. | Validates all incoming message envelopes (origin, tab ID, nonce, timestamp). Sole context allowed to perform GitHub writes. |
| **Extension UI** | **Trusted** | Configures repositories, templates, renders logs. | Isolated extension origin. Strict CSP blocks dynamic script injection or eval. |
| **Storage (`storage.local`)** | **Trusted Local** | Stores configuration, queue metadata, auth tokens, leases. | Scoped to extension ID. Protected by browser extension storage isolation. Webpages cannot read. |
| **Storage (`IndexedDB`)** | **Trusted Local** | Stores large source-code payloads and sync history. | Scoped to extension origin. Prevents 10 MB `storage.local` quota exhaustion. |
| **GitHub API** | **External Trusted** | Creates/updates solution files in user repository. | Interacted with strictly over HTTPS using fine-grained GitHub App tokens. |

---

## 4. GitHub Integration Architecture: GitHub App & Write Safety

### 4.1 GitHub App Preference
CodeSync adopts a **GitHub App** architecture over legacy OAuth Apps:
- **Device Authorization Flow**: Allows client-side authentication without hosting a public backend server.
- **Repository-Level Scoping**: During authorization, users select "Only select repositories". CodeSync is restricted exclusively to the chosen solution repository.
- **Fine-Grained Permissions**: Requests Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions. Zero access to user email, issues, pull requests, workflows, or account settings.
- **Ephemeral Token Lifecycle**: Tokens expire in 8 hours and rotate automatically via refresh tokens (6-month validity).
- **Durable Refresh Fencing & Lease Expiry Authority**: Monotonic generation ($G$), unique attempt UUID ($A$), and monotonic lease epoch ($E$). Once a 30-second lease expires, local mutation authority is permanently revoked; late network completion never restores authority ($\text{NETWORK COMPLETION} \neq \text{LOCAL MUTATION AUTHORITY}$).
- **Single-Object Fenced Persistence**: Credentials serialized as one logical JSON object in `browser.storage.local` under fencing verification, avoiding false claims of cross-system database atomicity.
- **PAT Fallback**: Formally deferred for Phase 1C to minimize attack surface and avoid unrotated credentials; may be revisited in future phases for manual/enterprise environments.

### 4.2 Validated Transactional Write Protocol with Optimistic Concurrency Control

> **Non-Atomicity Invariant**:
> The complete multi-request synchronization workflow is **NOT a single atomic database transaction**.
> Because it encompasses multiple distinct asynchronous HTTP network requests (pre-flight checks, GET file state, PUT file update, and commit verification), another actor or tab may modify the repository between operations.
> CodeSync enforces data integrity via pre-condition validation, optimistic SHA checks, duplicate policy revalidation, and explicit conflict resolution:

1. Validate target repository against whitelist regex.
2. Validate target branch existence.
3. Deterministically canonicalize and validate file path against safe path grammar and base folder boundary.
4. Validate content encoding (UTF-8) and size (≤500 KB).
5. Verify token freshness; refresh if within 5 minutes of expiry.
6. Check remote file state via `GET /contents/{path}`.
7. Evaluate duplicate policy (`REPLACE_IF_DIFFERENT`, `ALWAYS_REPLACE`, `KEEP_ALL`, `CREATE_ONLY`). Skip if content SHA-256 matches.
8. Execute optimistic file write via `PUT /contents/{path}` with optimistic lock `sha`.
9. Handle remote write response & SHA conflicts (409): Execute **8-Step Conflict Protocol** (re-fetch remote state, compare content hash, re-evaluate duplicate policy; **NO blind retries**).
10. Verify commit existence via `GET /commits/{sha}` and update queue metadata.

---

## 5. Storage Architecture: Hybrid Partitioning

To avoid hitting the 10 MB `browser.storage.local` quota and optimize memory usage in ephemeral service workers:

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ browser.storage.local                │ IndexedDB (codesync_db)              │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ • codesync:auth                      │ • Store: payloads                    │
│ • codesync:config                    │   Key: payload:<uuid>                │
│ • codesync:queue:metadata            │   Value: { sourceCode, metadata }    │
│ • codesync:queue:lease               │ • Store: history                     │
│ • codesync:cache:repos               │   Full sync records (> 1000 entries) │
│ • codesync:cache:branches            │ • Store: backfill                    │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

---

## 6. Extension Permissions Specification

### 6.1 Manifest Permissions
- `storage`: Required for settings, auth credentials, queue metadata, and storage leases.
- `alarms`: Required for waking the service worker to process queued submissions and retry backoff.
- `notifications`: User notifications for sync results and error recovery prompts.

### 6.2 Host Permissions
Scoped strictly to target platforms and GitHub endpoints:
- `https://api.github.com/*`
- `https://github.com/login/*`
- `*://leetcode.com/*`
- `*://codeforces.com/*`
- `*://www.codechef.com/*`
- `*://www.geeksforgeeks.org/*`
- `*://practice.geeksforgeeks.org/*`

### 6.3 Prohibited Permissions
CodeSync **explicitly avoids**:
- `webRequest` / `webRequestBlocking`: Replaced by content script observation.
- `tabs`: Replaced by `sender.tab.id` inside message handlers.
- `cookies`: Zero requirement to read or modify browser cookies.
- `<all_urls>`: Prohibited.

---

## 7. Fail-Closed Architecture Invariants

CodeSync adheres to **FAIL CLOSED > BEST-EFFORT WRITE**:
- **Authentication Ambiguity**: Aborts sync; marks item `REQUIRES_ATTENTION`.
- **Path Traversal / Grammar Error**: Rejects path; never writes to root or arbitrary directory.
- **Extraction Confidence < 0.70**: Halts automatic sync; prompts user for manual confirmation.
- **Confidence vs Trust**: High confidence (≥0.70) must still pass all 9 deterministic validation checks before sync.
- **SHA Conflict (409)**: Stops write attempt; re-fetches remote state and re-evaluates duplicate policy. Never blind retries identical PUT.
- **Repository Mismatch**: Fails closed if active repository drifts from queued snapshot.
- **Poison Pill**: Items causing service worker crashes are isolated after 3 attempts.
