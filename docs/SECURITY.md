# Security Architecture & Comprehensive Threat Model
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Public Architecture Specification

---

## 1. Core Security Principle

> **"Never sacrifice security for convenience, compatibility, or implementation speed. If an operation cannot be performed safely, CodeSync must fail closed or require explicit user intervention rather than weakening its security model."**

CodeSync operates on a strict defense-in-depth model. We recognize that no software is 100% secure; therefore, we explicitly identify trust boundaries, model attack scenarios from A to Z, enforce least privilege across all integrations, and explicitly document all residual risks.

---

## 2. System Assets & Trust Boundaries

### 2.1 Critical Assets

| Asset ID | Asset Name | Description | Confidentiality | Integrity | Availability |
|---|---|---|---|---|---|
| **A-1** | GitHub User Access Tokens | Bearer tokens for GitHub API operations | **CRITICAL** | **CRITICAL** | High |
| **A-2** | User Source Code | Proprietary code submissions in memory / transit / queue | **CRITICAL** | **CRITICAL** | High |
| **A-3** | Target Repository Content | Existing code files and Git commit history | **CRITICAL** | **CRITICAL** | High |
| **A-4** | Extension Configuration | Target repo, branch, base path, sync templates, duplicate policy | High | **CRITICAL** | High |
| **A-5** | Persistent Queue State | Submissions pending sync, state machines, retry counters | High | **CRITICAL** | **CRITICAL** |
| **A-6** | Platform Session Cookies | Cookies & sessions on LeetCode, Codeforces, etc. | **CRITICAL** (Zero Access) | N/A | N/A |

### 2.2 Security Zones & Component Classification

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ZONE 0: UNTRUSTED / ADVERSARIAL ENVIRONMENT                                     │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 1. Coding Platform Webpage (Hostile Web Context)                          │  │
│  │    • Hostile scripts, third-party trackers, ad scripts, mutated DOM       │  │
│  │    • Untrusted metadata, spoofed submission events, malicious titles      │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
│                                        │ window.postMessage (Strict Origin &     │
│                                        │ Type Validation + Schema Sanitization)  │
│                                        ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 2. Page/World Bridge Script (Main World, Isolated Execution)              │  │
│  │    • Only injected when direct DOM access is insufficient (e.g. Monaco)   │  │
│  │    • Zero access to extension APIs, zero secrets, zero token access       │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
│                                        │ Custom Event / postMessage             │
│                                        ▼                                        │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 3. Content Script (Semi-Trusted, Isolated World)                          │  │
│  │    • Content script isolated world prevents direct JS variable theft      │  │
│  │    • Still vulnerable to DOM manipulation, prototype tampering on DOM     │  │
│  │    • STRICT RULE: WEBPAGE != TRUSTED, CONTENT SCRIPT != TRUSTED           │  │
│  │    • ZERO token access. Validates all inputs before forwarding.           │  │
│  └─────────────────────────────────────┬─────────────────────────────────────┘  │
└────────────────────────────────────────┼────────────────────────────────────────┘
                                         │ browser.runtime.sendMessage
                                         │ (Typed, Nonced, Schema-Validated,
                                         │  Sender Origin & Tab ID Verified)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ZONE 1: TRUSTED EXTENSION CORE (Origin: chrome-extension://<id>)                │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 4. Service Worker / Background Core (Authoritative Context)               │  │
│  │    • Holds GitHub credentials in memory only during active calls          │  │
│  │    • Enforces message schemas, path bounds, write safety pipeline         │  │
│  │    • Authorizes all state transitions, handles queue and rate limits      │  │
│  │    • Enforces Two-Tier Concurrency: Web Locks API + Storage Lease         │  │
│  │    • Enforces 9-Step Deterministic Validation (Confidence is NOT Trust)   │  │
│  └──────────────────┬─────────────────────────────────────┬──────────────────┘  │
│                     │                                     │                     │
│                     ▼                                     ▼                     │
│  ┌──────────────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │ 5. Local Storage (browser.storage)   │  │ 6. IndexedDB (Payload Storage)  │  │
│  │    • Auth metadata, settings, leases │  │    • Private isolated source    │  │
│  │    • Queue metadata & retry state    │  │      payloads & history         │  │

│  └──────────────────────────────────────┘  └─────────────────────────────────┘  │
│                     ▲                                                           │
│                     │ browser.runtime.sendMessage                               │
│  ┌──────────────────┴────────────────────────────────────────────────────────┐  │
│  │ 7. Extension UI Context (Popup & Options Pages)                           │  │
│  │    • Trusted extension origin, strictly isolated from web DOM             │  │
│  │    • Strict CSP: script-src 'self'; object-src 'none'; no eval            │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ HTTPS (Browser-negotiated TLS, Strict SNI)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ZONE 2: EXTERNAL TRUSTED SERVICE                                                │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ 8. GitHub API (api.github.com)                                            │  │
│  │    • Authenticated via fine-grained GitHub App user access token          │  │
│  │    • Scoped strictly to user-selected repository Contents (write)         │  │
│  │    • Validated transactional write protocol with optimistic concurrency   │  │
│  │    • 8-Step Conflict Protocol: Revalidation over blind retries            │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Boundary Enforcement Invariants

1. **Webpage != Trusted**: Any string, event, or object originating from the web page is treated as an active injection attempt.
2. **Content Script != Trusted**: Even though content scripts run in an isolated world, the DOM they inspect is controllable by page JavaScript. The service worker must independently validate every payload field received from a content script.
3. **No Credential Boundary Crossing**: GitHub tokens, authorization codes, and refresh tokens **MUST NEVER** cross into content scripts, page bridges, webpage DOM, URL query parameters, console output, or diagnostics.
4. **Least-Privilege Token Invariant**: The service worker only requests Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions. It never requests administrative, organization-wide, or broad `repo` scopes.
5. **Confidence Is NOT Security Trust**: Extraction confidence is an empirical completeness heuristic. High confidence (≥0.70) does not imply authenticity and never authorizes a write by itself; deterministic validation is mandatory.

---

## 3. Formal Threat Model (Scenarios A through Z)

The following 26 threat scenarios represent the core adversarial matrix audited for CodeSync.

| ID | Scenario | Attack Vector | Severity | Mitigation & Defense-in-Depth | Residual Risk |
|---|---|---|---|---|---|
| **A** | Malicious coding platform webpage | A compromised or rogue contest page injects scripts to manipulate extension behavior. | High | Content scripts validate all extracted data against strict Zod schemas; the service worker re-validates all fields. No credentials exist in page context. | Platform UI change may cause benign extraction failure (fails closed). |
| **B** | Malicious page content / script injection | Injected scripts alter DOM elements or intercept `window.postMessage` to send forged payloads. | High | Origin check (`event.origin === window.location.origin`), typed message envelope, strict payload schema validation, discarding unexpected properties. | Malicious page can falsify DOM text for problem title; neutralized by path sanitization. |
| **C** | Compromised/unexpected platform API response | Platform API returns malformed JSON, SQL injection strings, or 50MB blobs. | Medium | Content-length and payload-size caps (max 500 KB per source file). Zod schema parsing with safe defaults; fail-closed on type mismatch. | High-frequency API failure marks queue item `REQUIRES_ATTENTION`. |
| **D** | Malicious repository / path input | Attacker inputs a malicious repository name (`owner/repo; rm -rf`) or traversal template. | High | Strict regex validation on repo (`^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$`), branch whitelist, and deterministic path canonicalization. | None. Invalid inputs rejected immediately in UI and background. |
| **E** | Malicious metadata (slug, title, language, difficulty) | Problem title contains `../../evil` or `<script>` tags, or rating is `NaN`/huge float. | High | Strict character whitelisting (`[a-zA-Z0-9_-]`), length truncation (max 100 chars per segment), integer boundary checks, HTML entity stripping. | Cosmetic truncation of extraordinarily long problem names. |
| **F** | Token theft | Attacker attempts to read GitHub App user access token. | Critical | Token stored exclusively in extension-only `browser.storage.local`. Content scripts never receive tokens. Zero web-accessible storage. | Compromise of client OS or host browser sandbox itself. |
| **G** | Token leakage through logs/errors | Stack trace or debug log inadvertently prints auth headers or token strings. | Critical | Custom `Logger` redacts any Bearer header, token pattern (`ghu_`, `ghr_`, `ghp_`, `gho_`), and sanitizes error objects before output. | Direct memory inspection via browser DevTools if DevTools opened by user. |
| **H** | Compromised extension context | Content script compromised through 0-day DOM clobbering or browser flaw. | High | Content script has zero privileges; cannot write to storage, cannot call GitHub API, cannot obtain tokens. Service worker verifies tab ID and origin. | Attacker can trigger bogus queue items, which fail closed or are rate-limited. |
| **I** | Malicious extension messages | Third-party extension or malicious script sends messages via `runtime.sendMessage`. | High | Service worker checks `sender.id === runtime.id`. Messages from external extensions (`onMessageExternal`) are disabled entirely. | None. External messaging disabled. |
| **J** | Replayed messages/events | Attacker captures a valid extraction message and replays it repeatedly. | Medium | Every message includes a UUID v4 nonce and timestamp (valid for 30s). Queue deduplicates identical submission IDs and content hashes. | Network/CPU overhead of processing duplicate rejection. |
| **K** | Duplicate submissions | User clicks submit multiple times or refreshes page during judging. | Low | Content SHA-256 comparison against existing file. If identical, policy `REPLACE_IF_DIFFERENT` cleanly skips commit without API write. | Redundant local queue check; zero GitHub clutter. |
| **L** | Concurrent queue processing | Multiple tabs trigger submissions simultaneously, racing queue workers. | High | Two-tier concurrency: Native Web Locks API (`navigator.locks`) within session + storage lease record with probe-and-verify protocol in `storage.local`. | Max lease duration capped at 30s; heartbeat renewal every 10s. |
| **M** | GitHub SHA race conditions | Two tabs attempt to update the same file simultaneously, causing 409 Conflict. | High | Optimistic concurrency lock with blob SHA. If 409 Conflict occurs, stop write attempt, re-fetch remote state, re-evaluate duplicate policy with new content hash. Zero blind retries of identical PUT. If unresolved, mark `REQUIRES_ATTENTION`. | Concurrent edits may require user resolution via diff UI. |
| **N** | Repository confusion | User switches active repository in options while a sync is queued. | High | Each `QueueItem` snapshots the target repository, branch, and auth context at enqueue time, preventing inflight configuration drift. | User must manually re-route queued items if they intended them for new repo. |
| **O** | Branch confusion | Synchronizing to default branch when target branch does not exist or was renamed. | Medium | Exact branch name validated against GitHub `GET /repos/{owner}/{repo}/branches/{branch}` before write. Fails closed if branch missing. | Initial setup requires branch creation on GitHub if non-default. |
| **P** | Path traversal | Path template contains `../` or resolves to parent directories. | Critical | Deterministic canonicalization rejects any `..` segment, leading `/`, Windows drive letters (`C:`), or root-relative escapes. Fails closed. | Disallowed complex nested folder paths with `..` aliases. |
| **Q** | Encoded path traversal & Unicode tricks | Encoded (`%2e%2e%2f`), double-encoded, homoglyphs (`\uff0e\uff0e`), BIDI overrides. | Critical | Three-pillar path defense: Multi-pass URL decode and NFKC canonicalization + strict safe path grammar (portable ASCII whitelist `^[a-zA-Z0-9_.-]+$`) + base-folder boundary check. Canonicalization reduces ambiguity; grammar validation determines acceptability. | Confusable Unicode characters categorically rejected by safe grammar. |
| **R** | Cross-Site Scripting (XSS) | Problem description or user input injected into extension UI popup/options. | High | React 19 JSX automatic string escaping; absolute ban on `dangerouslySetInnerHTML`. Extension CSP blocks inline scripts (`script-src 'self'`). | None. No raw HTML rendering. |
| **S** | DOM injection | Injecting malicious elements into platform DOM via toasts or overlays. | Medium | All injected UI (toasts) uses isolated Shadow DOM or pure SVG/text nodes with `textContent` only; never `innerHTML`. | Platform CSS bleeding into extension elements (isolated via Shadow Root). |
| **T** | Prototype pollution | Malformed JSON response attempts to overwrite `Object.prototype`. | Medium | Using `Object.create(null)` for maps, freezing configuration dictionaries, avoiding recursive vulnerable `deepMerge` utilities, validating schemas. | Minor memory footprint from defensive object cloning. |
| **U** | Dependency/supply-chain compromise | Malicious npm package update introduces credential stealer or back door. | High | Lockfile strictly pinned; zero runtime dependencies beyond React, Zustand, and WXT; zero postinstall scripts; `npm audit` enforced in CI. | Compromise of core framework (WXT/React) itself; mitigated by minimal dependencies. |
| **V** | Malicious extension update | Compromised developer account pushes malicious extension version. | Critical | GitHub Releases signed with 2FA; Web Store accounts secured with hardware keys; reproducibility checks; no remote code execution allowed by MV3. | Threat external to codebase; addressed by operational controls. |
| **W** | Browser-specific security differences | Differences in CSP enforcement, storage quotas, or background lifecycle. | Medium | Standardized WXT cross-browser abstraction; ephemeral service worker model applied uniformly across Chromium and Gecko; strictest common CSP. | Firefox requires `background.scripts` rather than service worker; handled by WXT. |
| **X** | Accidental source code disclosure | User's private code leaked to third-party telemetry, analytics, or search engines. | Critical | **Zero telemetry**. Zero analytics. Zero third-party networks. HTTPS-only directly to `api.github.com`. Diagnostic logs NEVER contain code. | Diagnostics export must be manually reviewed if user shares with developers. |
| **Y** | Excessive GitHub permissions | Extension requests broad `repo` scope, exposing private keys and all user repositories. | High | Migrated to **GitHub App** architecture: Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions. No access to issues, PRs, or admin. | Users must install the GitHub App on their selected repos. |
| **Z** | Denial-of-service / queue abuse | Malicious page triggers 10,000 rapid submissions, flooding storage and GitHub API. | Medium | Per-domain rate limiting in content script; max queue cap (200 items); payload size limit (500 KB); exponential backoff on GitHub 429. | Heavy contest spam drops oldest completed items, preserving pending items. |

---

## 4. Extension Permissions & Principle of Least Privilege

### 4.1 Manifest Permission Audit

Every permission requested by CodeSync is documented below with its functional requirement, security risk assessment, and justification for why it cannot be avoided.

| Permission | Functional Requirement | Capability Enabled | Security Risk Analysis | Can It Be Avoided? | Browser Differences |
|---|---|---|---|---|---|
| `storage` | Core persistence of queue, configuration, and token. | Access to `browser.storage.local`. | Local data tampering if extension origin compromised. | **No**. Required for offline persistence and service worker survival. | 10 MB default quota in Chrome/Firefox. |
| `alarms` | Periodic queue draining and retry scheduling. | Wakes service worker at scheduled intervals (e.g. every 1 min). | Minimal. Scheduled wakeups consume minor CPU/battery. | **No**. Service workers are terminated after ~30s idle; alarms are the standard MV3 wakeup mechanism. | Identical behavior across Chromium and Firefox. |
| `notifications` | Informing user of successful syncs or sync failures. | Displaying system desktop notifications. | Low. Could be used for notification spam if logic compromised. | **Yes, but degrades UX**. Can be made optional/configurable in settings. | Native OS integration differs slightly across platforms. |

### 4.2 Explicitly Prohibited Permissions

The following permissions are **STRICTLY FORBIDDEN** in CodeSync:

- `webRequest` / `webRequestBlocking`: Broad network interception violates least privilege and is restricted in MV3. Replaced by content script observation.
- `declarativeNetRequest`: Not needed; CodeSync observes submissions rather than modifying network packets.
- `tabs`: Exposes full browsing URLs and titles across all open tabs. CodeSync only accesses the active tab ID from `sender.tab.id` inside `runtime.onMessage`.
- `cookies`: Exposes platform credentials. CodeSync relies entirely on same-origin browser session execution and never touches cookies.
- `history` / `bookmarks`: Zero functional requirement; invasive privacy violation.
- `clipboardRead` / `clipboardWrite`: Banned to prevent clipboard sniffing of passwords or sensitive data.
- `<all_urls>`: Banned. Only explicit coding platform host permissions are declared.

### 4.3 Host Permissions Audit

Host permissions are strictly scoped to the platform domains where extraction is required, plus GitHub authentication and API endpoints:

```json
{
  "host_permissions": [
    "https://api.github.com/*",
    "https://github.com/login/*",
    "https://leetcode.com/*",
    "https://codeforces.com/*",
    "https://www.codechef.com/*",
    "https://www.geeksforgeeks.org/*",
    "https://practice.geeksforgeeks.org/*"
  ]
}
```

---

## 5. Extension Message Security

### 5.1 Communication Rules

1. **Origin Verification**: Every message listener checks `sender.id === chrome.runtime.id`.
2. **Sender Context Verification**:
   - Content script messages must have a valid `sender.tab` with `sender.tab.url` matching an enabled platform adapter pattern.
   - UI messages (from popup/options) must have `sender.url` matching `chrome-extension://${runtime.id}/`.
3. **Strict Typed Envelope**: Every message must conform to the `ExtensionEnvelope` schema:

```typescript
interface ExtensionEnvelope<T = unknown> {
  readonly id: string;           // UUID v4 message identifier (anti-replay)
  readonly type: ExtensionMessageType;
  readonly payload: T;
  readonly timestamp: number;    // Replay window: rejected if > 30s old or in future
  readonly senderContext: 'content-script' | 'popup' | 'options';
}
```

4. **Sensitive Operation Authorization**: The service worker is the sole authoritative context. Operations such as token revocation, repository configuration change, queue purging, and manual file push **CANNOT** be triggered from content scripts; they require verified UI origin messages.

---

## 6. Content Security Policy (CSP)

CodeSync enforces a hardened Content Security Policy across all extension pages (Popup, Options):

```
script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline';
```

- **`object-src 'none'`**: Disallows Flash, Java, and legacy browser plugins.
- **`base-uri 'none'`**: Prevents `<base>` tag injection attacks that alter relative URLs.
- **`frame-ancestors 'none'`**: Prevents clickjacking by prohibiting extension pages from being embedded in iframes.
- **No `eval()` or `Function()` constructor**: Dynamic code generation is banned.
- **No Remote Scripts**: All code is bundled locally.

---

## 7. Fail-Closed Design Architecture

In any security or integrity ambiguity, **CodeSync fails closed**. It never attempts a "best-effort" write that could corrupt repository contents or write to an unauthorized path.

### 7.1 Fail-Closed Invariants

| Failure Condition | Unsafe Behavior (BANNED) | Hardened Fail-Closed Action |
|---|---|---|
| Ambiguous authentication | Try writing with cached or default credentials | Abort sync; mark item `REQUIRES_ATTENTION`; prompt user re-auth. |
| Path template produces invalid characters | Strip characters and write to root or guessed path | Reject path; halt queue item; notify user in error recovery UI. |
| Repository identity mismatch | Write to whichever repository is currently active | Snapshot repo at enqueue; abort if active repo differs from item repo. |
| Platform status ambiguous / judging in progress | Assume Accepted or discard submission | Keep item in `PENDING` status; poll until final verdict or timeout. |
| Extraction confidence < 0.70 | Write incomplete or fallback dummy text | Abort automatic sync; prompt user for manual recovery verification. |
| Extraction confidence >= 0.70 but fails deterministic validation | Assume high confidence implies authenticity | **FAIL CLOSED**. Discard payload; block synchronization; log audit error. |
| SHA conflict (409) | Blindly retry identical PUT or force push | **HALT WRITE**. Execute 8-Step Conflict Protocol: re-fetch remote state, compare content hash, re-evaluate policy. If unresolved, mark `REQUIRES_ATTENTION`. |
| Storage or queue corruption | Silently re-initialize and wipe pending items | Quarantine corrupted records into `codesync:corrupted`; alert user. |

---

## 8. Logging & Diagnostics Redaction Policy

To prevent credential leakage and source-code privacy violations:

1. **Tokens and Secrets**: Absolute redaction. Any string matching authorization bearer tokens, `ghu_`, `ghr_`, `ghp_`, or `client_secret` is replaced with `[REDACTED_SECRET]`.
2. **Source Code**: User source code is **NEVER** logged to the console, stored in diagnostic logs, or serialized in error contexts. Only metadata (character count, SHA-256 hash, language) is logged.
3. **URL Query Parameters**: Any sensitive query parameters in platform URLs are sanitized before logging.
4. **Diagnostics Export**: When users export diagnostics for troubleshooting, CodeSync generates a sanitized JSON file with a visible banner confirming that zero source code and zero credentials are included.

---

## 9. Dependency & Supply Chain Security

1. **Minimal Dependencies**: The production bundle includes only **React 19**, **Zustand**, and **WXT** core. No bloated utility libraries (`lodash`, `moment`, etc.) are permitted.
2. **Lockfile Enforcement**: `package-lock.json` is committed and strictly enforced in CI via `npm ci --ignore-scripts`.
3. **Dependency Auditing**: Automated CI step runs `npm audit --audit-level=high`.
4. **Pinning**: All dependencies use exact versions (no `^` or `~` ranges in production dependencies).
5. **No Dynamic Imports from Remote CDNs**: All code, styles, and assets are local to the extension package.
