# Walkthrough — Phase 1C.3: Platform Adapter Architecture & Submission Detection

## 1. Overview & Objective

Phase 1C.3 builds the platform-adapter subsystem allowing CodeSync to detect coding-platform submissions and extract the actual submitted solution plus canonical metadata across four initial platforms:
1. **LeetCode** (`leetcode.com`)
2. **CodeChef** (`codechef.com`)
3. **Codeforces** (`codeforces.com`)
4. **GeeksforGeeks** (`geeksforgeeks.org` / `practice.geeksforgeeks.org`)

### Core Principles Enforced:
- **Strict Trust Boundary**:
  ```text
  Webpage (UNTRUSTED) → Content Script (SEMI-TRUSTED) → Service Worker (AUTHORITATIVE) → GitHub (EXTERNAL)
  ```
- **Candidate Data, Not Authorization**: Data extracted from DOM/APIs by an adapter is strictly a candidate. Extracted candidates never authorize automatic GitHub writes or queue bypasses.
- **Fail-Closed Security**: Rejects lookalike domains, malformed schemas, oversized sources (>500KB), control/binary characters, unapproved URL schemes (`javascript:`, `data:`, `blob:`), and replayed messages.
- **Controlled Scope Boundary**: No automatic GitHub syncing, no automatic queue draining, no PAT fallback, no backend, no Codolio adapter, no broad permissions (`<all_urls>`, `webRequest`).

---

## 2. Architecture & Pipeline

```text
       Platform Webpage (DOM / Mutation / Clicks)
                            ↓
Content Script (Bounded Event Listeners, LRU Event Deduplication)
                            ↓
Platform Adapter (LeetCode / CodeChef / Codeforces / GeeksforGeeks)
                            ↓
Canonical Submission Candidate (Platform-Independent, UTF-8 Normalization, SHA-256)
                            ↓
Secure Extension Messaging (UUID v4 Nonce, Freshness Window, Replay-Protected)
                            ↓
Service Worker SubmissionHandler (Authoritative Schema & Origin Verification)
```

---

## 3. Key Components Implemented

### 1. Platform Adapters Core Interface & Types
- [src/shared/adapters/types.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/types.ts)
  - `PlatformId`: `"leetcode" | "codechef" | "codeforces" | "geeksforgeeks"`
  - `CanonicalSubmissionStatus`: `"ACCEPTED" | "REJECTED" | "PENDING" | "UNKNOWN"`
  - `CanonicalSubmissionCandidate`: Strongly-typed canonical representation separating core fields (`platform`, `problemId`, `status`, `language`, `sourceCode`, `contentHash`, `submittedAt`, `sourceUrl`, `problemUrl`), optional metadata (`difficulty`, `submissionId`, `contestId`), and diagnostics (`extractionConfidence`, `extractionLayer`).
  - `PlatformAdapter`: Interface with `canHandle`, `detectSubmission`, and `extractSubmission`.

### 2. Validation & Normalization
- [src/shared/adapters/validator.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/validator.ts)
  - `validatePlatformOrigin`: Strict hostname and scheme validation preventing lookalike attacks (`evil-leetcode.com`, `leetcode.com.evil.test`).
  - `normalizeSourceCode`: UTF-8 validation, CRLF/CR to LF normalization, trimming trailing whitespace per line, single trailing newline guarantee.
  - `validateCanonicalSubmission`: String length bounds, URL schemes (`http:`/`https:` only), status allowlist, ASCII control character & null-byte rejection, and payload size bounds (`MAX_SOURCE_PAYLOAD_BYTES`).

### 3. Event Deduplication
- [src/shared/adapters/deduplicator.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/deduplicator.ts)
  - `SubmissionEventDeduplicator`: In-memory bounded LRU cache (default 200 entries, 30s window) with composite deterministic identity: `platform:problemId:sourceHash:status:submissionId`.

### 4. Adapter Registry & Base Adapter
- [src/shared/adapters/base-adapter.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/base-adapter.ts): Common abstract adapter providing SHA-256 computation, candidate bounds validation, source normalization, and status mapping.
- [src/shared/adapters/registry.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/registry.ts): Extension-controlled central registry enforcing unique adapter IDs, valid origins, method implementation, and URL routing.
- [src/shared/adapters/index.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/index.ts): Barrel export and `createDefaultRegistry()` factory.

### 5. Platform Adapters
- [LeetCodeAdapter](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/leetcode/leetcode-adapter.ts): Handles `leetcode.com`, detects submit button clicks, result banner mutations (`submission-result`), extracts problem slug/title/difficulty, language, Monaco editor view-lines or textarea fallback, and submission detail ID.
- [CodeChefAdapter](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/codechef/codechef-adapter.ts): Handles `codechef.com`, detects submit clicks (`#edit-submit`) and verdict banners, extracts problem code, language selector, textarea/Monaco source code, and submission ID.
- [CodeforcesAdapter](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/codeforces/codeforces-adapter.ts): Handles `codeforces.com` contests and problemsets, detects submission clicks and verdict mutations, extracts contest/problem ID (`1850A`), language compiler select, textarea source, and submission ID.
- [GeeksforGeeksAdapter](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/geeksforgeeks/geeksforgeeks-adapter.ts): Handles `geeksforgeeks.org` and `practice.geeksforgeeks.org`, detects submit buttons and "Problem Solved Successfully" banners, extracts problem slug/title, language button, ACE editor lines / textarea, and submission ID.

### 6. Execution Runtime & Service Worker Handler
- [src/entrypoints/content.ts](file:///d:/Parth/Projects/CodeSync/src/entrypoints/content.ts): Resolves active adapter from current URL, installs bounded DOM click listeners and MutationObservers on result containers, deduplicates detection events, and dispatches typed `SUBMISSION_DETECTED` messages to background.
- [src/shared/adapters/submission-handler.ts](file:///d:/Parth/Projects/CodeSync/src/shared/adapters/submission-handler.ts): Service worker handler verifying message envelope, checking sender tab URL against adapter supported origins (spoof prevention), and validating candidate schema authoritatively.
- [src/entrypoints/background.ts](file:///d:/Parth/Projects/CodeSync/src/entrypoints/background.ts): Dispatches `SUBMISSION_DETECTED` messages to `SubmissionHandler`.

---

## 4. Verification Results

### Automated Test Suite: 30/30 Test Files Passing, 305/305 Tests Passing
```text
Test Files  30 passed (30)
Tests       305 passed (305)
Duration    ~5.6s
```
- **Pre-existing baseline**: 243 tests (Phase 0 – 1C.2.1) → **Zero regressions**.
- **New tests added**: 62 automated tests covering:
  - Adapter registry validation & duplicate rejection (`tests/security/platform-registry.test.ts`)
  - Platform origin security & adversarial lookalike rejection (`tests/security/platform-origin-security.test.ts`)
  - LeetCode detection, extraction & fallback (`tests/security/platform-leetcode.test.ts`)
  - CodeChef detection, extraction & fallback (`tests/security/platform-codechef.test.ts`)
  - Codeforces detection, extraction & contest parsing (`tests/security/platform-codeforces.test.ts`)
  - GeeksforGeeks detection, extraction & fallback (`tests/security/platform-geeksforgeeks.test.ts`)
  - Normalization & SHA-256 determinism (`tests/security/platform-normalization.test.ts`)
  - Event deduplication LRU cache (`tests/security/platform-deduplication.test.ts`)
  - Cross-platform adapter isolation (`tests/security/platform-isolation.test.ts`)
  - Service worker messaging, replay protection, bounds, and spoofing tests (`tests/security/platform-messaging.test.ts`)

### Quality Gates
1. **TypeScript Typecheck**: `npx tsc --noEmit` — 0 errors (clean)
2. **ESLint**: `npx eslint .` — 0 errors (clean)
3. **Prettier**: `npx prettier --check "src/**/*.ts" "tests/**/*.ts"` — All matched files use Prettier code style
4. **Chrome MV3 Build**: `npm run build` — 255.63 kB bundle built successfully
5. **Firefox MV3 Build**: `npm run build:firefox` — 255.62 kB bundle built successfully
