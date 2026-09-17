# ADR-0007: Content Hashing for Duplicate Detection

**Status:** Accepted  
**Date:** 2026-09-12  
**Deciders:** Architecture team

---

## Context

Users often submit the same solution multiple times (debugging, re-submitting after a timeout, re-running after contest ends). Competitors create a new commit on every submission, cluttering the Git history with identical content. CodeSync should detect when a submission is identical to what's already in the repository and skip unnecessary commits.

## Decision

**Use SHA-256 content hashing (after line-ending normalization) to detect duplicate submissions. Default policy: replace only if content differs, skip if identical.**

## Alternatives Considered

### A. No duplicate detection
- Always create/update the file regardless
- **Pros:** Simplest implementation
- **Rejected because:** Creates unnecessary commits, clutters Git history, wastes GitHub API calls

### B. Filename-based detection
- Check if a file exists at the target path
- **Pros:** Simple — just check HTTP 200 vs 404
- **Rejected as sufficient because:** File existence alone doesn't indicate content match. A user might submit a different solution to the same problem. We need to compare content.

### C. Git SHA comparison
- Use Git's internal SHA-1 hash of the blob
- **Pros:** Uses Git's native hashing, available in the GitHub Contents API response
- **Rejected because:** Git blob SHA includes a header (`blob <size>\0`) and uses SHA-1, which is being deprecated. We'd need to replicate Git's exact hashing algorithm. Fragile if GitHub changes internal representation.

### D. Content SHA-256 hash comparison (selected)
- Compute SHA-256 of the source code (after normalizing `\r\n` → `\n`) and compare with the SHA-256 of the existing file content (decoded from the GitHub API response)
- **Pros:** Standard, reliable, independent of Git internals, handles line-ending differences across platforms
- **Cons:** Requires fetching existing file content from GitHub (one API call)

## Consequences

**Positive:**
- No unnecessary commits — Git history stays clean
- Saves GitHub API calls (skip the PUT when content is identical)
- Line-ending normalization prevents false negatives (Windows `\r\n` vs Unix `\n`)
- Configurable policy: users can choose `ALWAYS_REPLACE`, `KEEP_ALL`, `CREATE_ONLY`, or `REPLACE_IF_DIFFERENT`

**Negative:**
- Requires an extra API call (`GET /contents/{path}`) before every sync to fetch existing content
- Mitigated: This call is already needed to get the file's `sha` for update operations
- SHA-256 computation on large files adds minor CPU overhead
- Negligible for source code sizes (typically < 50 KB)

**Duplicate policies:**
| Policy | Behavior |
|---|---|
| `REPLACE_IF_DIFFERENT` (default) | Update file only if content changed. Skip if identical. |
| `ALWAYS_REPLACE` | Always update, even if content is identical. |
| `KEEP_ALL` | Append numeric suffix to filename for each submission. |
| `CREATE_ONLY` | Only create new files, never overwrite. |
