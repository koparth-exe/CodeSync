# Phase 1C.2.1 — Correction & Hardening Walkthrough

## Summary

Phase 1C.2.1 implements **7 narrowly scoped corrections** to the Phase 1C.2 GitHub integration layer. No new features. No Phase 1C.3 code.

## Verification Results

| Check | Result |
|---|---|
| Tests | **240/240 passed** (14 new correction tests) |
| TypeScript | **Clean** |
| ESLint | **Clean** |
| Prettier | **Clean** |
| Chrome Build | ✅ |
| Firefox Build | ✅ |

---

## C1: Bounded KEEP_ALL Candidate Generation

**Before:** `resolveKeepAllPath` silently returned the last occupied path when all v2–v10 slots were full, potentially overwriting existing content.

**After:** Bounded by `MAX_KEEP_ALL_CANDIDATES = 10`. Throws `GitHubApiError(GITHUB_CONFLICT)` when exhausted — **fail-closed**.

```diff
+export const MAX_KEEP_ALL_CANDIDATES = 10;

-    // If all versions 2-10 exist, return last versioned path
-    return checkPath;
+    throw new GitHubApiError(
+      `KEEP_ALL candidate exhaustion: all ${MAX_KEEP_ALL_CANDIDATES} versioned slots...`,
+      { code: ErrorCode.GITHUB_CONFLICT },
+    );
```

**Tests:** 3 tests — constant export, fail-closed on exhaustion, bounded API call count.

---

## C2: Secondary Rate-Limit Classification

**Before:** 403 responses were only classified as rate limits when `remaining === 0`. Secondary rate limits (abuse detection with `Retry-After`) were misclassified as authorization failures.

**After:** Three-way 403 classification:

| Condition | Classification | `isSecondary` |
|---|---|---|
| 429 | Primary rate limit | `false` |
| 403 + `remaining === 0` | Primary rate limit | `false` |
| 403 + `Retry-After` header | Secondary rate limit | `true` |
| 403 (no indicators) | Authorization failure | N/A |

```diff
+  readonly isSecondary: boolean;
```

**Tests:** 4 tests — all four classification branches verified deterministically.

---

## C3: Formal 401 Refresh/Retry Semantics

**Before:** 401 handling worked correctly but had unclear error propagation in the nested try/catch.

**After:** Explicit contract:
1. First attempt → current token
2. 401 → exactly ONE forced refresh
3. Retry exactly ONCE with refreshed token
4. Second 401 → **TERMINAL** (propagates immediately)
5. Never purges valid credentials

**Tests:** 2 tests — successful retry, and terminal failure with exactly 2 fetch calls.

---

## C4: Post-Write Verification Uncertainty

**Before:** Both "content mismatch" and "verification GET network failure" produced the same `requires_attention` state.

**After:** Three-way `VerificationStatus`:

| Status | Meaning |
|---|---|
| `CONFIRMED` | Remote content hash matches intended |
| `MISMATCH` | Remote exists but hash differs → `requires_attention` |
| `UNKNOWN` | Verification GET itself failed → write status preserved |

**Tests:** 3 tests — one for each verification outcome.

---

## C5: Discovery vs. Authoritative Lookup

**Change:** Updated JSDoc on all 4 methods:
- `getRepository()` → **"sole authority for repository identity and write-permission validation"**
- `listUserRepositories()`, `listUserInstallations()`, `listInstallationRepositories()` → **"convenience-only"**

---

## C6: Conservative ASCII Path-Policy

**Change:** Added explicit documentation that the ASCII-only whitelist is a **deliberate security design decision**, not an internationalization oversight. Non-ASCII sanitization is the responsibility of platform adapters (Phase 1C.3+).

---

## C7: API Version Terminology

**Change:** Clarified `GITHUB_REST_API_VERSION` as an **"operational parameter"** that pins current behavior, not a guarantee that GitHub will support the version indefinitely.

---

## Files Modified

| File | Changes |
|---|---|
| [`types.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/github/types.ts) | C1, C4, C7: `MAX_KEEP_ALL_CANDIDATES`, `VerificationStatus`, API version docs |
| [`contents-service.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/github/contents-service.ts) | C1, C4: Bounded KEEP_ALL, three-way verification |
| [`client.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/github/client.ts) | C2, C3, C5: Rate-limit classification, 401 semantics, discovery docs |
| [`errors/index.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/errors/index.ts) | C2: `isSecondary` flag on `GitHubRateLimitError` |
| [`path-engine.ts`](file:///d:/Parth/Projects/CodeSync/src/shared/github/path-engine.ts) | C6: ASCII path-policy documentation |

## New Files

| File | Purpose |
|---|---|
| [`phase1c21-corrections.test.ts`](file:///d:/Parth/Projects/CodeSync/tests/security/phase1c21-corrections.test.ts) | 14 deterministic tests for C1–C7 |
| [`Phase1C.2.1-Correction-Report.md`](file:///d:/Parth/Projects/CodeSync/docs/Phase1C.2.1-Correction-Report.md) | Full correction report |

---

> **Phase 1C.3 was NOT implemented. HARD STOP.**
