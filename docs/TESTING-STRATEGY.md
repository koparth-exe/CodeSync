# Testing Strategy & Security Test Suite Specification
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Technical Architecture Specification

---

## 1. Testing Pyramid & Verification Methodology

```
          ┌───────────┐
          │  E2E      │  ~5%  (Playwright: full browser extension loading,
          │  Tests    │        popup, options UI, mock GitHub service)
         ┌┴───────────┴┐
         │ Integration  │ ~25% (Vitest: cross-module pipelines, queue + storage,
         │ Tests        │       adapter to normalizer, safe write engine)
        ┌┴──────────────┴┐
        │   Unit Tests    │ ~70% (Vitest: canonicalization, safe grammar, schema
        │                 │       validation, deduplication, retry algorithms)
        └─────────────────┘
```

CodeSync adheres to a **fixture-based, deterministic testing discipline**. Platform adapters are tested against version-controlled JSON/HTML fixtures captured from live platform states, ensuring reliable regression detection without flaky live network dependencies in CI.

---

## 2. Comprehensive Security Test Suite Specification (Future Implementation Requirements)

The following 19 security test suites are formalized as mandatory requirements for Phase 1–4 implementation:

### S1: Path Traversal Defense Suite
- Verify rejection of `../`, `..\\`, `..`, and multiple consecutive traversal sequences.
- Verify rejection of absolute paths (`/root/solution.cpp`, `C:\Windows\system32`).
- Verify rejection of root-relative escapes when a base folder (e.g. `solutions/`) is specified.

### S2: Encoded & Multi-Pass Traversal Suite
- Test single URL encoding (`%2e%2e%2f`, `%2e%2e/`, `..%2f`).
- Test double URL encoding (`%252e%252e%252f`).
- Test Unicode homoglyphs and full-width dots (`\uff0e\uff0e\uff0f`).
- Test null byte injection (`solution.cpp%00.txt`, `\0`).

### S3: Malformed Platform Metadata Suite
- Test hostile problem titles (`../../evil`, `<script>alert(1)</script>`, unprintable ASCII).
- Test malformed slugs with spaces, uppercase, and special characters.
- Test ratings with `NaN`, `Infinity`, negative numbers, floats, and integer overflow values.
- Test languages containing injection payloads (`<script>`, SQL fragments).

### S4: XSS & DOM Injection Neutralization Suite
- Verify extension UI components (Popup, Options) never use `dangerouslySetInnerHTML`.
- Test that problem titles with embedded HTML entities render as pure text strings in React JSX.
- Verify injected toasts use shadow DOM and strict `textContent`.

### S5: Message Envelope Validation Suite
- Verify rejection of messages missing UUID v4 nonce or valid timestamp.
- Verify rejection of messages with unknown `type` or malformed `payload`.
- Verify rejection of expired messages (>30s old or >5s in the future).

### S6: Unauthorized Sender & Context Spoofing Suite
- Test message rejection when `sender.id !== runtime.id`.
- Verify content scripts cannot trigger privileged administrative actions (e.g. `PURGE_QUEUE`, `REVOKE_AUTH`, `UPDATE_CONFIG`).
- Verify sender tab ID matches expected platform URL pattern.

### S7: Token & Secret Leakage Prevention Suite
- Assert that console logs and diagnostic stores **never** contain substrings matching `ghu_`, `ghr_`, `ghp_`, or `Bearer`.
- Assert that error objects caught during GitHub API failures have headers and tokens scrubbed before serialization.
- Assert that exported diagnostic files contain zero authentication or source code strings.

### S8: Queue Concurrency & Robust Lease Model Suite
- Test Web Locks API serialization (`navigator.locks`): verify concurrent drain triggers queue up without racing.
- Test Probe-and-Verify lease protocol: simulate two workers attempting lease probe simultaneously; verify only one claims ownership and the other yields with jittered backoff.
- Test stale lease recovery: mock worker termination leaving an expired lease; assert next worker reclaims ownership after 30s TTL.
- Test heartbeat renewal: verify active worker refreshes `expiresAt` during multi-item batch execution.
- Test orderly release: verify worker clears lease only if `lease.workerId === this.workerId`.

### S9: Duplicate & Replay Rejection Suite
- Replay a previously successful extraction message; verify duplicate rejection by UUID and content hash.
- Test `REPLACE_IF_DIFFERENT` policy: verify identical content hash produces `SKIPPED` state with zero GitHub commits.

### S10: GitHub SHA Conflict (TOCTOU) & Revalidation Suite
- Mock GitHub Contents API returning `HTTP 409 Conflict` on PUT.
- **Assert write stops immediately**: verify NO blind retry of identical PUT occurs.
- Verify engine executes fresh `GET /contents/{path}` bypassing local cache.
- Test content hash comparison against newly fetched remote content:
  - When remote content is identical: verify transition to `SKIPPED` without further writes.
  - When policy is `CREATE_ONLY`: verify transition to `SKIPPED / ALREADY_EXISTS`.
  - When policy is `KEEP_ALL`: verify filename version suffix increments (e.g. `-v2.cpp`).
  - When policy is `REPLACE_IF_DIFFERENT` with differing content: verify conditional PUT uses newly obtained remote SHA.
  - When a second conflict occurs or policy does not cleanly resolve: verify remote content is preserved, sync halts, and item transitions to `REQUIRES_ATTENTION` with side-by-side diff.

### S11: Repository & Configuration Drift Suite
- Enqueue item for `repo-A`; change active extension settings to `repo-B`.
- Verify the queued item executes against `repo-A` (the snapshotted target at detection time) or fails closed safely, never corrupting `repo-B`.

### S12: Malicious / Hostile GitHub API Response Suite
- Test handling of GitHub returning HTTP 500, 502, 503, 504.
- Test handling of rate-limit responses (`HTTP 403` with `X-RateLimit-Remaining: 0`); verify queue enters paused mode until reset timestamp.
- Test oversized or truncated JSON responses from GitHub API.

### S13: Malformed Platform Judging Response Suite
- Test LeetCode GraphQL returning unexpected mutation response schemas.
- Test Codeforces `user.status` returning HTML error page instead of JSON.
- Test judging timeout scenarios; verify transition to User-Assisted Recovery.

### S14: Cross-Browser Security Equivalence Suite
- Verify identical CSP enforcement in Chromium and Gecko test runners.
- Verify manifest validity for Chrome MV3 and Firefox MV3 builds.

### S15: Manifest Permissions Audit Suite
- Automated AST/JSON inspection asserting that `webRequest`, `tabs`, `cookies`, `<all_urls>`, and other prohibited permissions are absent from manifests.

### S16: Storage Corruption & Poison Pill Suite
- Inject malformed/corrupted JSON into `codesync:queue:metadata`.
- Verify extension isolates corrupted items into `codesync:corrupted` without crashing.
- Test poison-pill simulation: item causing service worker crashes 3 times is quarantined into `REQUIRES_ATTENTION`.

### S17: Dependency Vulnerability & Integrity Suite
- CI execution of `npm audit --audit-level=high`.
- Verify `package-lock.json` integrity and absence of postinstall scripts.

### S18: Extraction Confidence vs Deterministic Validation Suite
- **High Confidence + Invalid Data**: Mock extraction with confidence `0.95` but malformed problem slug (`../../evil`); assert deterministic validation rejects payload and blocks sync.
- **High Confidence + Inconsistent Metadata**: Mock confidence `0.90` where language is `Language.CPP` but extension is `'py'`; assert consistency check rejects payload.
- **Low Confidence + Plausible Data**: Mock extraction with confidence `0.65` (scoped DOM fallback); assert payload fails closed into User-Assisted Recovery regardless of apparent syntactic validity.
- **High Confidence + Valid Invariants**: Mock confidence `0.95` passing all 9 deterministic invariants; assert clean progression to Write-Ahead Log enqueue.

### S19: Path / Unicode Strict Safe Grammar Suite
- **Unicode Homoglyphs**: Test problem titles containing Cyrillic 'а', Greek 'о', or full-width characters; assert canonicalization folds/strips them, and strict grammar whitelist (`^[a-zA-Z0-9_.-]+$`) rejects any non-ASCII characters.
- **Bidirectional Overrides**: Test strings containing BIDI override `\u202E`; assert rejection by safe grammar.
- **Invisible Characters**: Test zero-width spaces (`\u200B`) and joiners (`\u200C`); assert rejection by safe grammar.
- **Whitespace & Control Characters**: Test tabs, internal spaces, and non-printable bytes; assert rejection.
- **DOS Device Collisions**: Test paths containing `CON.cpp`, `aux.py`, `NUL`, `com1.txt`; assert rejection.
- **Base Folder Containment**: Configure base folder `solutions/`; test paths attempting to write outside it; assert boundary rejection.
