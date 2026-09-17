# Walkthrough: Phase 1C.2 GitHub Repository Intelligence & Validated Contents Write Engine

## Overview

CodeSync **Phase 1C.2: GitHub Repository Intelligence & Validated Contents Write Engine** has been implemented, tested, and verified under strict phase gating.

Phase 1C.2 establishes the secure GitHub integration layer connecting the extension service worker to GitHub's REST API. It implements authoritative repository and branch validation, the Three-Pillar path security engine, allowlisted path templates, optimistic concurrency control (OCC) for file updates, the mandatory 8-step 409 conflict protocol, uncertain write outcome reconciliation, and deterministic content deduplication.

> [!IMPORTANT]
> **Strict Scope Boundary:**  
> Phase 1C.2 is complete and verified.  
> **Phase 1C.3 is STRICTLY LOCKED.** Zero Phase 1C.3 or later functionality has been implemented.

---

## 1. What Was Implemented

```
src/shared/github/
├── types.ts              # Authoritative domain types, operational constants, and schemas
├── client.ts             # Centralized HTTPS GitHub REST API client (timeouts, headers, redaction)
├── path-engine.ts        # Three-Pillar Path Security & Allowlisted Template Resolver
├── contents-service.ts   # 12-Step Validated Transactional Write Protocol with OCC
└── index.ts              # Public module exports
```

1. **Centralized GitHub API Client (`GitHubApiClient`)**:
   - Centralizes all GitHub network requests. Direct `fetch` calls to GitHub from other modules are prohibited.
   - Enforces HTTPS-only (`https://api.github.com`).
   - Centralized headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `cache: "no-store"`.
   - `AbortController` timeout handling (15s default).
   - Injects `Authorization: Bearer <token>` into request headers only; tokens are never placed in URLs.
   - Comprehensive rate-limit header parsing (`x-ratelimit-remaining`, `x-ratelimit-reset`, `retry-after`).
   - Secret redaction ensuring tokens never appear in errors, stack traces, or logs.
2. **Three-Pillar Path Security Engine (`validateAndCanonicalizePath`)**:
   - **Pillar 1: Canonicalization**: Bounded URL decoding (max 3 cycles), NFKC normalization, non-ASCII and Unicode homoglyph rejection, null-byte rejection without stripping, control-character rejection without stripping, whitespace rejection, separator normalization (`\` $\to$ `/`).
   - **Pillar 2: Strict Safe Path Grammar**: POSIX portable ASCII whitelist (`^[a-zA-Z0-9_.-]+$`), relative traversal rejection (`.` and `..`), leading/trailing dot rejection, DOS reserved device name rejection (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without extensions), Git reserved directory protection (`.git`, `.github`), segment length limit (1-100), total length limit (1-255), depth limit (≤10).
   - **Pillar 3: Base-Folder Boundary Containment**: User-configured base folder is validated and prepended, ensuring paths cannot escape via relative tricks.
3. **Allowlisted Path Template Resolver (`resolvePathTemplate`)**:
   - Evaluates `{platform}`, `{platform_lower}`, `{slug}`, `{title}`, `{problem_id}`, `{language}`, `{language_lower}`, `{extension}`, `{difficulty}`, `{rating}`, `{contest_id}`, `{problem_code}`, `{division}`, `{status}`, `{date}`, `{timestamp}`.
   - Unknown variables, malformed braces, or missing values fail closed immediately.
   - Completely non-executable (no eval, no Function, no arbitrary property lookup).
4. **Contents API Read & Write Engine (`GitHubContentsService`)**:
   - 12-Step Validated Transactional Write Protocol with Optimistic Concurrency Control (OCC).
   - 500 KB source payload limit.
   - Normalized SHA-256 content hashing (LF line endings, trimmed trailing whitespace) vs Git blob SHA distinction.
   - Duplicate policies: `REPLACE_IF_DIFFERENT` (default), `ALWAYS_REPLACE`, `CREATE_ONLY`, `KEEP_ALL`.
   - 8-Step 409 Conflict Protocol with max 2 revalidation passes.
   - Uncertain write outcome reconciliation (`WRITE_OUTCOME_UNKNOWN`).
   - Post-write authoritative verification GET.

---

## 2. Key Architectural Workflows

### How a Repository is Authorized
1. The repository owner and name segments are validated locally against `/^[a-zA-Z0-9_.-]+$/`.
2. `client.getRepository(owner, repo)` executes `GET /repos/{owner}/{repo}` with `cache: "no-store"`.
3. The authoritative response is inspected for GitHub's immutable numeric repository ID (`id: number`) and write permissions (`permissions.push: true`).
4. If an installation scope is active, CodeSync verifies that the repository belongs to the authorized installation.
5. Local configuration cannot expand remote authorization; remote GitHub state is the sole authority.

### How a Branch is Validated
1. Branch name is checked against CodeSync's conservative local grammar (`^[a-zA-Z0-9._/-]+$`, zero relative traversal, no leading/trailing slashes).
2. `client.getBranch(owner, repo, branch)` queries `GET /repos/{owner}/{repo}/branches/{branch}`.
3. If GitHub returns 404, CodeSync throws `GitHubApiError` with `ErrorCode.GITHUB_BRANCH_NOT_FOUND` and halts synchronization fail-closed.
4. **Zero automatic branch creation** and **zero silent fallback to the default branch**.

### How a Path Becomes Safe
1. **Multi-pass URL decoding** stabilizes encoded sequences (max 3 cycles); lingering percent sequences trigger immediate rejection.
2. **Unicode inspection** rejects all non-ASCII characters, homoglyphs (Cyrillic, fullwidth dots/hyphens), and BIDI overrides.
3. **Null-byte and control-byte checks** fail closed immediately. Dangerous characters are **never stripped**.
4. **Separator normalization** converts backslashes to forward slashes; absolute paths, drive letters, and UNC prefixes are rejected.
5. **Segment extraction** splits by `/`, rejecting empty segments (`//`), trailing slashes, and paths deeper than 10 levels.
6. **Segment grammar** validates each segment against `^[a-zA-Z0-9_.-]+$`, rejects `.` and `..` traversal, rejects leading/trailing dots, rejects DOS device names (`NUL`, `CON`, etc.), and rejects `.git` / `.github`.
7. **Total length** enforces $\le 255$ characters.
8. **Boundary check** enforces containment within the user's base folder. Output is a clean, repository-relative POSIX path.

### How a File is Read
1. `client.getFileContents(owner, repo, path, branch)` executes `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` with `cache: "no-store"`.
2. If GitHub returns HTTP 404, it returns `null` (file is new).
3. If GitHub returns an array, the target is a directory: throws `GITHUB_TARGET_IS_DIRECTORY`.
4. If file size exceeds 500 KB, throws `GITHUB_PAYLOAD_TOO_LARGE`.
5. Base64 payload is decoded safely into UTF-8 text across both Node.js and browser extension environments.
6. Normalized content hash (SHA-256) and Git blob SHA are extracted and returned.

### How a File is Created vs. Updated (SHA / OCC)
- **CREATE**: When pre-flight GET returns `null` (404), PUT is dispatched **without** a `sha` field. GitHub creates the file.
- **UPDATE**: When pre-flight GET finds an existing file, the authoritative remote Git blob SHA is captured. The PUT request **must include** `sha: remoteSha`. GitHub checks that the file has not changed since CodeSync's read.
- **OCC Protection**: If another commit occurred between CodeSync's read and write, GitHub rejects the write with HTTP 409 Conflict.

### What Happens on HTTP 409 Conflict (8-Step Protocol)
1. **Detect**: Intercept HTTP 409 Conflict from PUT.
2. **Halt**: Stop write attempt. Increment conflict revalidation counter.
3. **Re-fetch**: Execute fresh authoritative `GET /contents/{path}?ref={branch}` bypassing cache.
4. **Extract**: Obtain new remote blob SHA and decode latest remote content.
5. **Recompute**: Normalize remote content and compute fresh SHA-256.
6. **Re-evaluate Policy**:
   - If remote content now matches local content $\to$ return `skipped_identical`. Zero further writes!
   - If policy is `CREATE_ONLY` $\to$ return `skipped_exists`. Zero further writes!
   - If overwrite permitted $\to$ proceed to Step 7.
7. **Conditional Re-Write**: Dispatch PUT with the **new** remote blob SHA.
8. **Bounded Escalation**: If another conflict occurs, repeat up to **maximum 2 revalidations**. If still unresolved, halt immediately and transition to `requires_attention` (`attentionReason: "GITHUB_CONFLICT"`). **Zero blind retries.**

### What Happens When a Write Outcome is Unknown
If a network disconnect, socket drop, or timeout occurs after PUT dispatch:
1. The operation is flagged as `WRITE_OUTCOME_UNKNOWN`.
2. CodeSync does **NOT** assume failure and does **NOT** blindly repeat the PUT.
3. Executes a fresh authoritative GET.
4. Compares remote content hash with the intended local content hash.
5. If remote content matches $\to$ the commit succeeded upstream! Returns success (`created` or `updated`).
6. If remote content does not match $\to$ throws `GitHubWriteOutcomeUnknownError` safely.

### How Duplicate Policies Work
- `REPLACE_IF_DIFFERENT` (Default): If remote normalized content hash === local normalized content hash, returns `skipped_identical` with zero commits created. Line ending differences (Windows CRLF vs Linux LF) and trailing whitespace are normalized before comparison.
- `CREATE_ONLY`: If target file exists, returns `skipped_exists` with zero commits created.
- `ALWAYS_REPLACE`: Updates target file even if content is identical.
- `KEEP_ALL`: Generates deterministic numeric version suffixes (`two-sum-v2.cpp`, `two-sum-v3.cpp`) and checks existence until an unused filename is found.

### Interaction with Fenced Token Lifecycle
- On HTTP 401 Unauthorized, CodeSync does **NOT** purge credentials from `browser.storage.local`.
- Invokes `DurableTokenLifecycleManager.getValidAccessToken({ forceRefresh: true })` to execute the approved tripartite fenced refresh protocol ($G \to G + 1$).
- Retries the operation once with the refreshed token.
- Stale or uncertain auth responses from superseded requests are dropped safely without damaging active credentials.

---

## 3. Verification & Validation Evidence

### Executable Test Suite
```
Test Files  19 passed (19)
     Tests  226 passed (226)
  Duration  2.57s
```

- **Path Security & Template Tests (`github-path-security.test.ts`)**: 32 passed
  - Template substitution, unknown variable rejection, malformed syntax rejection.
  - Traversal attacks, encoded traversal, null bytes, control characters, whitespace.
  - Absolute paths, Windows drive paths, UNC paths, empty segments.
  - Reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with extensions).
  - Git internal directories, segment length limits, total length limits, depth limits.
  - Unicode homoglyphs and confusable characters.
  - Base-folder boundary containment.
  - Safe commit message formatting.
  - 50+ procedurally generated adversarial path fuzz variants.
- **Centralized API Client Tests (`github-client.test.ts`)**: 23 passed
  - HTTPS enforcement, headers audit, token injection in header only.
  - Safe URL construction, CRLF and null-byte injection rejection.
  - Rate-limit tracking (429 and 403 with `remaining === 0`).
  - Error taxonomy classification (401, 403, 404, 409, 5xx, network failure).
  - Secret redaction in error messages.
  - Coordinated 401 token refresh with single retry boundary.
  - Authoritative branch validation and failure on missing branch.
  - Contents API read/write and payload size limit enforcement.
- **Contents Write Protocol Tests (`github-contents-write.test.ts`)**: 16 passed
  - New file creation (PUT without SHA).
  - Existing file update (PUT with authoritative blob SHA).
  - Directory target detection and fail-closed rejection.
  - 500 KB payload constraint enforcement.
  - Duplicate policies (`REPLACE_IF_DIFFERENT`, `CREATE_ONLY`, `ALWAYS_REPLACE`, `KEEP_ALL`).
  - CRLF vs LF and trailing whitespace normalization equivalence.
  - 8-Step 409 Conflict Protocol with remote state re-fetch and duplicate policy re-evaluation.
  - Max 2 conflict revalidation passes and escalation to `requires_attention`.
  - Uncertain write outcome reconciliation (remote commit verified after network drop).
  - Post-write authoritative verification failure detection.
  - Deterministic A/B concurrency race using interleaving hooks.
- **Existing Security & Infrastructure Tests**: 155 passed across 16 other test files.

### Quality & Build Verification Gates
1. `npm test` $\to$ **PASS** (19 test files, 226 tests).
2. `npm run compile` $\to$ **PASS** (0 TypeScript errors, `tsc --noEmit` exit code 0).
3. `npm run lint` $\to$ **PASS** (0 ESLint errors, 0 warnings).
4. `npm run format:check` $\to$ **PASS** (All files formatted with Prettier).
5. `npm run build` $\to$ **PASS** (Chrome MV3 production build: 231.06 kB).
6. `npm run build:firefox` $\to$ **PASS** (Firefox MV3 production build: 231.05 kB).
7. `npm audit` $\to$ **PASS** (0 production/runtime vulnerabilities).

---

## 4. Phase Gate Status

**PHASE 1C.2 — COMPLETE & APPROVED FOR REVIEW**  
**PHASE 1C.3 REMAINS STRICTLY LOCKED.**  
**HARD STOP REACHED. AWAITING EXTERNAL REVIEW.**
