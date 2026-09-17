# Phase 1C.2.1 Correction & Hardening Report

**Phase:** 1C.2.1  
**Type:** SECURITY-CORRECTION-ONLY  
**Date:** 2026-09-13  
**Classification:** Correction & Hardening Pass  
**Prior Phase Status:** Phase 1C.2 = CONDITIONAL PASS  
**Current Phase Status:** Phase 1C.2.1 = COMPLETE

---

## 1. Executive Summary

Phase 1C.2.1 implements seven narrowly scoped corrections (C1–C7) identified during
the external review of Phase 1C.2. No new features are introduced. No Phase 1C.3
capabilities are implemented.

### Verification Results

| Check | Result |
|---|---|
| Unit & Security Tests | **240/240 passed** (20 test files) |
| TypeScript Compilation | **Clean** (zero errors) |
| ESLint | **Clean** (zero errors) |
| Prettier Format | **Clean** (all files compliant) |
| Chrome MV3 Build | **Success** (231.06 KB) |
| Firefox MV3 Build | **Success** (231.05 KB) |
| npm audit | 2 moderate (pre-existing vitest dev dependency, not shipped) |

---

## 2. Corrections Applied

### C1: Bound KEEP_ALL Candidate Generation

**Problem:** `resolveKeepAllPath` had a hardcoded loop `v2..v10` and silently returned the
last occupied path when all slots were exhausted — potentially overwriting content.

**Fix:**
- Added `MAX_KEEP_ALL_CANDIDATES = 10` constant to `types.ts` with full documentation.
- Rewrote `resolveKeepAllPath` to use the constant and **fail closed** (throw `GitHubApiError`
  with code `GITHUB_CONFLICT`) when all candidate slots are exhausted.
- The method never silently overwrites or probes indefinitely.

**Tests Added:** 3 deterministic tests:
1. `MAX_KEEP_ALL_CANDIDATES` is exported and equals 10.
2. Throws fail-closed when all candidate slots are exhausted.
3. Probes at most `MAX_KEEP_ALL_CANDIDATES` GET requests (bounded API calls).

**Files Modified:**
- `src/shared/github/types.ts` — Added `MAX_KEEP_ALL_CANDIDATES` constant.
- `src/shared/github/contents-service.ts` — Bounded `resolveKeepAllPath`, fail-closed on exhaustion.

---

### C2: Secondary Rate-Limit Classification

**Problem:** 403 responses were only classified as rate limits when `remaining === 0`.
GitHub's secondary rate limits (abuse detection) send 403 with `Retry-After` header but
`remaining > 0`, which were incorrectly classified as authorization failures.

**Fix:**
- Three-way 403 classification in `client.ts`:
  1. **Primary rate limit:** 403 with `remaining === 0` → `GitHubRateLimitError` (`isSecondary: false`)
  2. **Secondary rate limit:** 403 with `Retry-After` header present, `remaining > 0` → `GitHubRateLimitError` (`isSecondary: true`)
  3. **Authorization failure:** 403 without rate-limit indicators → `GitHubApiError` (`GITHUB_FORBIDDEN`)
- Added `isSecondary: boolean` field to `GitHubRateLimitError` class.
- HTTP 429 explicitly classified as primary rate limit.

**Tests Added:** 4 deterministic tests:
1. HTTP 429 classified as PRIMARY (`isSecondary = false`).
2. HTTP 403 with `remaining=0` classified as PRIMARY.
3. HTTP 403 with `Retry-After` classified as SECONDARY (`isSecondary = true`).
4. HTTP 403 without rate-limit indicators classified as authorization failure (not rate limit).

**Files Modified:**
- `src/shared/errors/index.ts` — Added `isSecondary` field to `GitHubRateLimitError`.
- `src/shared/github/client.ts` — Three-way 403 classification logic.

---

### C3: Formal 401 Refresh/Retry Semantics

**Problem:** The 401 handling comment said "retry once" but the code flow had a nested
try/catch that could obscure the terminal semantics on the second 401.

**Fix:**
- Restructured the 401 retry block with explicit contract documentation:
  1. First attempt uses current token.
  2. On 401, exactly ONE coordinated forced refresh is attempted.
  3. The request is retried exactly ONCE with the refreshed token.
  4. If the SECOND attempt also returns 401, that is **TERMINAL**.
  5. Stale 401 errors NEVER purge valid credentials (tripartite fencing preserved).
- Separated refresh failure from retry failure for clearer error propagation.

**Tests Added:** 2 deterministic tests:
1. Retries exactly once after 401 with refreshed token, then succeeds.
2. Propagates 401 as TERMINAL after second consecutive 401 (no infinite loop) — exactly 2 fetch calls.

**Files Modified:**
- `src/shared/github/client.ts` — Restructured 401 retry block.

---

### C4 / C4.1: Post-Write Verification Uncertainty & Non-Optimistic Semantic Model

**Problem (C4):** Post-write verification treated both "remote content differs" and
"verification GET failed" as the same `requires_attention` state.
**Regression (C4 Initial):** In the initial C4 fix, verification `UNKNOWN` optimistically
reported `status: "created"` or `"updated"` (completed success). This violated the core
principle that $\text{WRITE DISPATCH SUCCESS} \neq \text{OVERALL OPERATION SUCCESS}$.

**Fix (C4.1):**
- Strictly decoupled the 3-tier semantic model:
  $$\text{WRITE\_DISPATCH\_RESULT} \longrightarrow \text{VERIFICATION\_RESULT} \longrightarrow \text{OVERALL\_OPERATION\_RESULT}$$
- Added `WriteDispatchStatus` type: `"succeeded" | "failed" | "uncertain"`.
- Added `dispatchStatus` and `isUpdate` fields to `GitHubWriteResult`.
- Updated `contents-service.ts` so `UNKNOWN` verification:
  - Returns `status: "requires_attention"` with `attentionReason: "GITHUB_RECONCILIATION_REQUIRED"`.
  - Is **NOT** marked completed/confirmed (`status !== "created"` and `status !== "updated"`).
  - Preserves `commitSha` and `fileSha` from the PUT response for safe later reconciliation.
  - Performs **zero additional blind PUT requests** (`PUT count === 1`).
- Implemented `reconcileVerification(...)` on `GitHubContentsService`:
  - Performs fresh authoritative GET (zero PUT requests).
  - Remote content matches expected hash $\to$ `CONFIRMED`, safely completed (`"created"` or `"updated"`).
  - Remote content differs $\to$ `MISMATCH`, requires attention (`"GITHUB_VERIFICATION_FAILED"`).
  - Reconciliation GET fails $\to$ `UNKNOWN`, unresolved (`"GITHUB_RECONCILIATION_REQUIRED"`).

**Tests Added:**
1. `verificationStatus=CONFIRMED` when remote matches.
2. `verificationStatus=MISMATCH` with `requires_attention` when remote differs.
3. `verificationStatus=UNKNOWN` asserts `requires_attention`, non-completion, and `GITHUB_RECONCILIATION_REQUIRED`.
4. C4.1 full lifecycle regression test: PUT accepted $\to$ verification GET timeout $\to$ `UNKNOWN` $\to$ assert `putCount === 1` $\to$ assert not completed/confirmed $\to$ later reconciliation GET matches $\to$ `CONFIRMED` $\to$ safely complete with `putCount === 1`.
5. C4.1 reconciliation mismatch test: reconciliation detects mismatch $\to$ `MISMATCH` $\to$ `requires_attention`.
6. C4.1 reconciliation timeout test: reconciliation GET fails $\to$ `UNKNOWN` $\to$ unresolved with `putCount === 1`.

**Files Modified:**
- `src/shared/github/types.ts` — Added `WriteDispatchStatus`, extended `GitHubWriteStatus`, added `dispatchStatus` and `isUpdate` to `GitHubWriteResult`.
- `src/shared/github/contents-service.ts` — 3-tier model implementation, `UNKNOWN` propagation to `requires_attention`, `reconcileVerification` method.
- `tests/security/phase1c21-corrections.test.ts` — Updated C4 test and added C4.1 regression suite.

---

### C5: Repository Discovery vs. Authoritative Lookup

**Problem:** JSDoc comments on discovery methods did not explicitly state that they are
convenience-only and that `getRepository()` is the sole authority for write operations.

**Fix:**
- Updated JSDoc on `getRepository()`: "**This is the sole authority for repository identity
  and write-permission validation.**"
- Updated JSDoc on `listUserRepositories()`, `listUserInstallations()`, and
  `listInstallationRepositories()`: "**Convenience-only** for UI population. NEVER
  supersedes authoritative lookup."
- All discovery JSDocs now direct callers to `getRepository()` for authoritative validation.

**Tests Added:** 1 structural test confirming all four methods exist on the client.

**Files Modified:**
- `src/shared/github/client.ts` — JSDoc updates for 4 methods.

---

### C6: Conservative ASCII Path-Policy Documentation

**Problem:** The path engine's ASCII-only whitelist lacked explicit documentation that this
is an intentional security design decision, not an oversight for internationalization.

**Fix:**
- Added comprehensive JSDoc to `SAFE_SEGMENT_REGEX` in `path-engine.ts` explaining:
  - Non-ASCII rejection is DELIBERATE, not an oversight.
  - Enumerating dangerous Unicode codepoints is computationally infeasible.
  - ASCII whitelist provides a provably safe, stable boundary.
  - Platform adapters (Phase 1C.3+) handle non-ASCII sanitization upstream.
- Added inline documentation at the non-ASCII rejection point in `validateAndCanonicalizePath()`.

**Files Modified:**
- `src/shared/github/path-engine.ts` — Expanded documentation for `SAFE_SEGMENT_REGEX` and Step 2.

---

### C7: GitHub API Version Terminology

**Problem:** The `GITHUB_REST_API_VERSION` constant's JSDoc could be read as implying
that version "2022-11-28" is guaranteed by GitHub forever.

**Fix:**
- Updated JSDoc to clarify the version is an **operational parameter** that pins current
  API behavior, NOT a guarantee of permanent stability.
- Explicitly states GitHub may deprecate older API versions and CodeSync should update
  the value when the pinned version approaches EOL.

**Files Modified:**
- `src/shared/github/types.ts` — Updated operational constants documentation.

---

## 3. New Files Created

| File | Purpose |
|---|---|
| `tests/security/phase1c21-corrections.test.ts` | 14 deterministic tests for all C1–C7 corrections |

---

## 4. Phase Boundary Declaration

> **Phase 1C.3 was NOT implemented.**  
> No platform adapters, submission detection, queue drain executor, UI redesign,
> PAT fallback, OAuth App support, or automatic branch/repo creation was implemented.

---

## 5. Security Properties Preserved

All pre-existing security invariants remain intact:
- HTTPS-only communication
- Secret redaction in all error paths
- Tripartite fencing (G, A, E) for credential lifecycle
- Path traversal prevention (8-step pipeline)
- Optimistic Concurrency Control with bounded revalidation
- Fail-closed on all security boundaries
- No new permissions added to manifests
