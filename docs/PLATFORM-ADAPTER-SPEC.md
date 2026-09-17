# Platform Adapter Specification & Extraction Hardening
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Technical Architecture Specification

---

## 1. Layered Extraction Philosophy & Safety Hierarchy

The extraction architecture rejects the assumption that "network interception" is a universal or homogeneous mechanism across platforms. Every coding platform has a distinct architectural surface: some expose authenticated GraphQL APIs, others have public REST APIs, and others render server-side HTML.

CodeSync defines an explicit **Safety and Feasibility Hierarchy**:

```
Priority 1: Official / Public REST API (Highest reliability, least intrusive)
Priority 2: Same-Origin Authenticated Endpoint (Internal platform session)
Priority 3: Submission-Detail Page Data Extraction (Direct page fetch)
Priority 4: Page-Context Fetch/XHR Observation (World-bridge observation where strictly required)
Priority 5: In-Memory Editor State Bridge (Monaco / CodeMirror instance inspection)
Priority 6: Scoped DOM Extraction (CSS selector fallback)
Priority 7: User-Assisted Recovery (Interactive prompt, zero guessing)
```

---

## 2. Platform-Specific Extraction & Security Specifications

### 2.1 LeetCode Adapter

| Dimension | Specification |
|---|---|
| **URL Patterns** | `https://leetcode.com/problems/*/`, `https://leetcode.com/contest/*/problems/*/` |
| **Exact Extraction Source** | Same-Origin Internal GraphQL API (`https://leetcode.com/graphql`) + Submission Check Polling (`https://leetcode.com/submissions/detail/{id}/check/`). |
| **Authentication Assumptions** | User is actively logged in to LeetCode in the browser. Browser automatically attaches same-origin session cookies (`LEETCODE_SESSION`) to requests made by the content script / page context. |
| **Trust Level** | **Semi-Trusted Input**: While LeetCode is an established platform, GraphQL responses are external inputs that must be validated against Zod schemas. |
| **Extraction Sequence** | 1. Observe submit button / network trigger to capture `submissionId`.<br>2. Poll `/submissions/detail/{id}/check/` until status is no longer `PENDING`.<br>3. Extract verdict and submitted source code from response JSON.<br>4. Secondary fallback: Query LeetCode GraphQL `submissionDetails` query.<br>5. Tertiary fallback: In-memory Monaco editor state via main-world bridge. |
| **Failure Behavior** | If polling times out after 60s or returns an unexpected schema, extraction fails closed. Emits `EXTRACTION_TIMEOUT` and transitions to User-Assisted Recovery. |
| **Security Risks & Mitigations** | **GraphQL Schema Drift**: Mitigated by strict optional schema parsing.<br>**Rate Limiting**: Polling interval capped at 2s with exponential backoff.<br>**Monaco Bridge Hijacking**: World-bridge script uses unidirectional `postMessage` with origin checking. |

---

### 2.2 Codeforces Adapter

| Dimension | Specification |
|---|---|
| **URL Patterns** | `https://codeforces.com/problemset/problem/*`, `https://codeforces.com/contest/*/problem/*`, `https://codeforces.com/gym/*/problem/*` |
| **Exact Extraction Source** | Official Public REST API (`https://codeforces.com/api/user.status`) + Same-Origin Submission Page HTML (`https://codeforces.com/contest/{cId}/submission/{sId}`). |
| **Authentication Assumptions** | User handle is identified from the page DOM or Codeforces header. Source code retrieval from the submission page requires the user's active session cookie on Codeforces. |
| **Trust Level** | **Untrusted / Semi-Trusted**: Public API responses and server-rendered HTML must be strictly sanitized. |
| **Extraction Sequence** | 1. Detect form submission on problem page.<br>2. Query public REST API `user.status?handle={handle}&from=1&count=1` to observe submission verdict.<br>3. When verdict is final (e.g. `OK` or `WRONG_ANSWER`), fetch the submission HTML page.<br>4. Extract source code from the syntax-highlighted `<pre id="program-source-text">` element.<br>5. Fallback: ACE editor instance content. |
| **Failure Behavior** | If user handle cannot be detected or API is down, fails closed. Prompts user to verify Codeforces handle in options. |
| **Security Risks & Mitigations** | **HTML Entity Injection in `<pre>`**: Source code extracted from DOM `<pre>` elements undergoes strict HTML entity decoding (`&lt;` → `<`, `&amp;` → `&`) to prevent code corruption.<br>**CSRF Protection**: CodeSync only reads data, never performs submissions on user's behalf. |

---

### 2.3 CodeChef Adapter

| Dimension | Specification |
|---|---|
| **URL Patterns** | `https://www.codechef.com/problems/*`, `https://www.codechef.com/*/problems/*` |
| **Exact Extraction Source** | Submission API Response Observation (`/api/ide/submit`) + Same-Origin Submission Detail API (`/api/submissions/{id}`). |
| **Authentication Assumptions** | Active CodeChef session in browser. |
| **Trust Level** | **Untrusted**: CodeChef UI updates frequently; responses treated as raw untrusted JSON. |
| **Extraction Sequence** | 1. Content script observes IDE submission endpoint response.<br>2. Extract submission ID from response JSON.<br>3. Poll `/api/submissions/{id}` for judging completion.<br>4. Extract source code and status from JSON payload.<br>5. Fallback: Editor instance extraction (CodeMirror/Monaco). |
| **Failure Behavior** | If API changes or judging fails to complete within 90s, extraction marks item `FAILED` and offers User-Assisted Recovery. |
| **Security Risks & Mitigations** | **Unstable Internal API**: Endpoints are reverse-engineered. Adapters wrap parsing in defensive try-catch blocks and validate all fields against strict Zod models. |

---

### 2.4 GeeksforGeeks (GFG) Adapter

| Dimension | Specification |
|---|---|
| **URL Patterns** | `https://www.geeksforgeeks.org/problems/*`, `practice.geeksforgeeks.org/problems/*` |
| **Exact Extraction Source** | Submission Request Body Interception + Judging Response API + Editor State. |
| **Authentication Assumptions** | Active GFG account session. |
| **Trust Level** | **Untrusted**: GFG platform HTML contains numerous ad scripts and complex trackers. |
| **Extraction Sequence** | 1. Intercept submission POST request payload containing submitted code directly.<br>2. Listen for compilation/verdict websocket or polling response.<br>3. Fallback: In-memory editor instance extraction via world bridge.<br>4. Tertiary fallback: User-Assisted Recovery. |
| **Failure Behavior** | If payload is missing or corrupted, fails closed immediately. Zero guessing of code content. |
| **Security Risks & Mitigations** | **Ad-Script Tampering**: Content script strictly ignores any window messages not matching the exact CodeSync internal UUID nonce and schema. |

---

### 2.5 Codolio Evaluation (Deferred Status)

| Dimension | Assessment |
|---|---|
| **Platform Nature** | Portfolio aggregator (`codolio.com`), **NOT** an online judge. |
| **Verdict** | **NO ADAPTER CREATED**. Codolio has no code editor, no submission judge, and no submitted source code to capture. |
| **Future Scope** | If Codolio provides a public API, CodeSync could optionally send sync notifications to update the user's portfolio stats. It is entirely excluded from Phase 1–3 sync pipelines. |

---

## 3. Defense Against Hostile & Malformed Platform Metadata

Coding platforms can return hostile, malformed, or adversarial metadata. Every field MUST be strictly validated before being accepted into a `NormalizedSubmission`:

```typescript
export class MetadataValidator {
  /**
   * Validate and sanitize problem titles.
   * Defends against directory traversal (../../evil), HTML tags (<script>), control chars.
   */
  public static sanitizeTitle(rawTitle: string): string {
    if (!rawTitle || typeof rawTitle !== 'string') return 'Untitled-Problem';
    return rawTitle
      .replace(/<[^>]*>/g, '')                 // Strip HTML tags
      .replace(/[<>:"/\\|?*]/g, '-')          // Replace filesystem reserved characters
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '')   // Strip control characters
      .replace(/\.{2,}/g, '.')                // Collapse multiple dots
      .trim()
      .substring(0, 100) || 'Untitled-Problem';
  }

  /**
   * Validate problem slugs.
   * Must conform strictly to URL-safe alphanumeric hyphenated format.
   */
  public static validateSlug(rawSlug: string): string {
    if (!rawSlug || typeof rawSlug !== 'string') return 'unnamed-slug';
    const cleaned = rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 100);
    return cleaned || 'unnamed-slug';
  }

  /**
   * Validate platform ratings (e.g. Codeforces 800 - 3500).
   * Defends against NaN, Infinity, negative ratings, or integer overflow.
   */
  public static validateRating(rawRating: unknown): number | undefined {
    if (typeof rawRating !== 'number' || !Number.isFinite(rawRating)) return undefined;
    const intRating = Math.floor(rawRating);
    if (intRating < 0 || intRating > 5000) return undefined; // Reasonable CP rating range
    return intRating;
  }

  /**
   * Validate and canonicalize programming languages.
   * Defends against script tags or unexpected platform strings.
   */
  public static validateLanguage(rawLanguage: string, mapping: Record<string, Language>): Language {
    if (!rawLanguage || typeof rawLanguage !== 'string') return Language.UNKNOWN;
    const sanitized = rawLanguage.trim().toLowerCase().replace(/[^a-z0-9#+]/g, '');
    return mapping[sanitized] ?? Language.UNKNOWN;
  }

  /**
   * Validate source code payload.
   * Defends against binary blobs, null-byte corruption, and oversized files.
   */
  public static validateSourceCode(code: string): { isValid: boolean; error?: string } {
    if (typeof code !== 'string' || code.trim().length === 0) {
      return { isValid: false, error: 'SOURCE_CODE_EMPTY' };
    }
    if (code.length > 500 * 1024) { // 500 KB limit
      return { isValid: false, error: 'SOURCE_CODE_EXCEEDS_500KB' };
    }
    if (/[\x00\u0000]/.test(code)) {
      return { isValid: false, error: 'SOURCE_CODE_CONTAINS_NULL_BYTES' };
    }
    return { isValid: true };
  }
}
```

---

## 4. Extraction Confidence vs Deterministic Security Validation

### 4.1 Fundamental Invariant: Confidence Is NOT Trust

> **CRITICAL ARCHITECTURE INVARIANT**:
> **Extraction Confidence** is an empirical **quality and completeness heuristic** (estimating how reliably the adapter extracted data from platform elements).
> **Security Trust / Authenticity** is a **deterministic validation requirement** enforced by the service worker.
>
> **Confidence >= 0.70 DOES NOT mean the payload is authentic or safe.**
> Passing the confidence threshold alone **MUST NEVER authorize a GitHub write**.
> Instead, confidence acts as a preliminary gate:
> - If `confidence < 0.70`: **FAIL CLOSED immediately**. Do not proceed; trigger User-Assisted Recovery.
> - If `confidence >= 0.70`: The extraction result is permitted to enter the **Deterministic Validation Pipeline**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ EXTRACTION STAGE                                                            │
│ Adapter executes extraction layers (API -> Endpoint -> Detail -> Editor)    │
│ Computes confidence heuristic based on layer provenance and completeness    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Confidence Score >= 0.70 Check    │
                     └─────────────────┬─────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │                                           │
         NO (< 0.70)                                 YES (>= 0.70)
                 │                                           │
                 ▼                                           ▼
┌───────────────────────────────────┐       ┌─────────────────────────────────┐
│ FAIL CLOSED                       │       │ DETERMINISTIC VALIDATION        │
│ • Block synchronization           │       │ • Validate submission ID        │
│ • Item -> REQUIRES_ATTENTION      │       │ • Validate status enum          │
│ • Surface User-Assisted Recovery  │       │ • Validate platform context     │
└───────────────────────────────────┘       │ • Validate slug format          │
                                            │ • Validate language mapping     │
                                            │ • Validate UTF-8 source code    │
                                            │ • Validate metadata consistency │
                                            └────────────────┬────────────────┘
                                                             │
                                             ┌───────────────┴───────────────┐
                                             │                               │
                                           PASS                            FAIL
                                             │                               │
                                             ▼                               ▼
                              ┌─────────────────────────────┐ ┌─────────────────────────────┐
                              │ PERMIT ENQUEUE (WAL)        │ │ FAIL CLOSED                 │
                              │ Write to IndexedDB payload  │ │ Discard payload             │
                              │ Write metadata to storage   │ │ Emit security audit error   │
                              │ Proceed to Sync Engine      │ │ Halt synchronization        │
                              └─────────────────────────────┘ └─────────────────────────────┘
```

### 4.2 Extraction Confidence Heuristic Thresholds

| Confidence Range | Layer Provenance & Heuristic Criteria | System Action |
|---|---|---|
| **0.90 – 1.00** | Direct official/same-origin API response with matching platform submission ID and complete metadata. | Eligible to enter Deterministic Validation Pipeline. |
| **0.75 – 0.89** | Submission detail HTML page parse or verified Monaco editor instance extraction. | Eligible to enter Deterministic Validation Pipeline. |
| **0.50 – 0.74** | Scoped DOM fallback extraction or incomplete metadata fields. | **FAIL CLOSED**. Below threshold (< 0.70). Blocks automatic sync; triggers User-Assisted Recovery. |
| **< 0.50** | Ambiguous editor match, fragmented text, or partial response. | **FAIL CLOSED**. Rejects payload immediately. |

### 4.3 Deterministic Validation Pipeline (Mandatory Before Synchronization)

Before any submission is enqueued or written to GitHub, the service worker validates all 9 deterministic invariants:

1. **Submission Identity**: Platform submission ID exists and matches expected format (`^\d+$` or platform-specific alphanumeric identifier).
2. **Submission Verdict**: Status matches a valid, finalized `SubmissionStatus` enum (e.g. `ACCEPTED`, `WRONG_ANSWER`); never `PENDING` or `UNKNOWN`.
3. **Platform Match**: Platform matches the declared `PlatformId` of the sender context tab URL.
4. **Problem Identity & Slug**: Problem ID is non-empty; slug matches strict URL-safe regex `^[a-z0-9-]+$`.
5. **Canonical Language**: Platform language string maps cleanly to a supported `Language` enum member; not `UNKNOWN`.
6. **Source Code Presence & Type**: Source code is a non-empty string, length ≤ 500 KB, valid UTF-8, zero null bytes (`\0`).
7. **Metadata Consistency Check**: Derived file extension matches canonical language (e.g. `Language.CPP` must produce `extension: 'cpp'`).
8. **Session & Origin Boundary**: Content script sender tab URL matches the platform's origin and path pattern.
9. **Authorized Extraction Source**: Extraction method is recorded and supported by the adapter.

**If all 9 checks pass**, the submission is normalized, hashed (SHA-256), and persisted via the Write-Ahead Log protocol.
