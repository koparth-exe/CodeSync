# Path Template Specification & Path Traversal Hardening
## CodeSync

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Technical Architecture Specification

---

## 1. Overview & Core Security Invariant

The Path Template Engine compiles user-defined path patterns (e.g., `{platform}/{difficulty}/{slug}.{extension}`) and resolves them into concrete GitHub repository file paths.

### 1.1 The Three-Pillar Path Security Architecture

Because path template inputs combine **user configuration** (semi-trusted) with **platform metadata** (untrusted, potentially hostile), CodeSync enforces security across three distinct pillars:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. CANONICALIZATION                                                         │
│    Reduces input representation ambiguity (URL unescaping, NFKC folding).  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. STRICT SAFE PATH GRAMMAR                                                 │
│    Determines syntactic acceptability via a conservative portable whitelist.│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. REPOSITORY BOUNDARY VALIDATION                                           │
│    Enforces strict containment within user's configured base folder.        │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **CORE SECURITY INVARIANT**:
> **"Canonicalization reduces ambiguity; validation determines acceptability."**
>
> Unicode NFKC normalization alone **is NOT a security barrier** and does not prevent path traversal or confusable-character attacks. Security is achieved because canonicalized strings must strictly conform to an **explicit, conservative safe path grammar** and pass **boundary containment validation**. If any validation check fails, the engine **fails closed** and halts synchronization.

---

## 2. Template Variables Specification

### 2.1 Universal Variables

| Variable | Description | Allowed Grammar | Max Length | Example |
|---|---|---|---|---|
| `{platform}` | Canonical platform display name | `[a-zA-Z0-9]` | 20 | `LeetCode`, `Codeforces` |
| `{platform_lower}`| Lowercase platform name | `[a-z0-9]` | 20 | `leetcode`, `codeforces` |
| `{slug}` | URL-safe problem slug | `[a-z0-9-]` | 100 | `two-sum`, `watermelon` |
| `{title}` | Sanitized human title | `[a-zA-Z0-9_-]` | 100 | `Two-Sum`, `Watermelon` |
| `{problem_id}` | Platform problem identifier | `[a-zA-Z0-9_-]` | 30 | `1`, `4A`, `FLOW001` |
| `{language}` | Canonical language name | `[a-zA-Z0-9]` | 20 | `CPP`, `Java`, `Python3` |
| `{language_lower}`| Lowercase language name | `[a-z0-9]` | 20 | `cpp`, `java`, `python3` |
| `{extension}` | File extension (no dot) | `[a-z0-9]` | 10 | `cpp`, `java`, `py` |
| `{status}` | Submission status | `[a-zA-Z0-9_]` | 20 | `Accepted`, `Wrong_Answer`|
| `{date}` | Submission date (UTC) | `\d{4}-\d{2}-\d{2}` | 10 | `2026-09-13` |
| `{timestamp}` | Unix timestamp (seconds) | `\d{10}` | 10 | `1789300000` |

### 2.2 Platform-Specific Variables

| Variable | Platform | Allowed Grammar | Max Length | Example |
|---|---|---|---|---|
| `{difficulty}` | LeetCode, CodeChef, GFG | `[a-zA-Z]` | 15 | `Easy`, `Medium`, `Hard` |
| `{rating}` | Codeforces | `\d{3,4}` | 5 | `800`, `1400`, `2400` |
| `{contest_id}` | All (where applicable) | `[a-zA-Z0-9_-]` | 30 | `weekly-400`, `1900` |
| `{problem_code}`| Codeforces, CodeChef | `[a-zA-Z0-9]` | 10 | `A`, `B1`, `FLOW001` |
| `{division}` | Codeforces, CodeChef | `[a-z0-9]` | 10 | `div2`, `div1` |

---

## 3. Strict Safe Path Grammar Specification

The generated path must satisfy the following formal grammar rules before being accepted:

### 3.1 Segment Character Whitelist (POSIX Portable Filename Character Set)
- Every individual path segment between `/` separators **MUST** match the strict regex:
  ```regexp
  ^[a-zA-Z0-9_.-]+$
  ```
- **Categorical Disallowance**: Rather than attempting to enumerate infinite Unicode confusables, the engine enforces a conservative ASCII whitelist. The following are **strictly disallowed**:
  - **All Non-ASCII Unicode**: Cyrillic/Greek homoglyphs, accented characters, ideographs.
  - **Bidirectional Overrides & Invisible Characters**: Left-to-right overrides, right-to-left marks (`\u200E`, `\u200F`, `\u202E`), zero-width spaces (`\u200B`), non-joiners (`\u200C`).
  - **Whitespace**: Spaces, non-breaking spaces, tabs, and newlines are rejected.
  - **Control Characters**: All characters in ranges `\x00-\x1F` and `\x7F-\x9F`.
  - **Null Bytes**: Any `\x00` or `%00` triggers immediate fail-closed termination.
  - **Shell & Regex Metacharacters**: `$`, `&`, `;`, `|`, `` ` ``, `<`, `>`, `*`, `?`, `\`, quotes.

### 3.2 Segment Structural Rules
- **No Empty Segments**: Consecutive separators (`//`) or empty strings are rejected.
- **No Relative Traversal Tokens**: Segments equal to `.`, `..`, or containing `..` anywhere are rejected.
- **No Leading/Trailing Dots or Spaces**: Segments cannot start or end with a period `.` or space.
- **Windows Reserved Device Names**: Segments matching the following pattern (case-insensitive) are rejected, with or without any file extension:
  ```regexp
  ^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$
  ```
- **Git Internal Directory Protection**: Segments beginning with `.git` or `.github` are rejected.

### 3.3 Structural Limits & Boundaries
- **Segment Length**: `1 <= segment.length <= 100 characters`.
- **Segment Count (Depth)**: `1 <= segments.length <= 10 levels`.
- **Total Path Length**: `1 <= path.length <= 255 characters`.
- **Path Separators**: Forward slashes (`/`) only. Backslashes (`\`) are normalized to `/` during canonicalization and rejected if any remain.
- **No Absolute Paths**: Cannot start with `/` or match a drive letter (`^[a-zA-Z]:`).
- **Base Folder Containment**: If a repository base folder is configured (e.g. `solutions/`), the canonical path must strictly begin with `solutions/` and cannot contain any sequence that navigates outside it.

---

## 4. Deterministic Canonicalization & Validation Pipeline

Every resolved path string MUST pass sequentially through the 8-step pipeline:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Multi-Pass Recursive URL Decoding (Canonicalization)                │
│    • Iteratively apply decodeURIComponent (max 3 cycles).                   │
│    • If URIError thrown or decoding does not stabilize: REJECT.             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Unicode Normalization & Control Byte Inspection (Canonicalization)  │
│    • Apply String.prototype.normalize('NFKC') to fold compatibility glyphs. │
│    • Check for null bytes (\x00, \u0000). If found: REJECT.                 │
│    • Detect and reject control characters (\x00-\x1F, \x7F-\x9F). If found: │
│      REJECT fail-closed (PATH_VALIDATION_ERROR). Never strip.               │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Separator Normalization & Absolute Path Rejection (Canonicalization)│
│    • Convert all backslashes (\) to forward slashes (/).                   │
│    • Check if path begins with '/' or matches ^[a-zA-Z]:. If so: REJECT.   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Segment Extraction & Empty Segment Elimination (Grammar Check)      │
│    • Split path by '/'.                                                     │
│    • Check for empty segments (//). If found: REJECT.                       │
│    • Check total segment count: must be <= 10. If exceeded: REJECT.         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: Segment Whitelisting & Traversal Check (Grammar Check)              │
│    For each segment:                                                        │
│    • Traversal: if segment === '.' or segment === '..' :                    │
│      REJECT fail-closed (PATH_TRAVERSAL_DETECTED).                          │
│    • Filename Policy: if segment contains '..' anywhere :                   │
│      REJECT fail-closed (INVALID_FILENAME_SEGMENT).                         │
│    • Check Windows reserved device names (CON, PRN, AUX, NUL, COM*, LPT*):  │
│      If matched: REJECT.                                                    │
│    • Check Git reserved names (.git, .github):                              │
│      If matched: REJECT.                                                    │
│    • Validate characters against strict grammar: ^[a-zA-Z0-9_.-]+$          │
│      If any non-whitelisted character is present: REJECT.                   │
│    • Enforce segment length: 1 <= segment.length <= 100.                    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Total Length Enforcement (Grammar Check)                            │
│    • Reconstructed path string must satisfy: length <= 255 characters.      │
│    • If violated: REJECT.                                                   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 7: Base-Folder Boundary Containment Verification (Boundary Check)      │
│    • If user configured base repository folder (e.g. "solutions/"):         │
│      - Ensure canonical path strictly starts with base folder prefix.       │
│      - Ensure relative remainder does not escape via any relative trick.    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 8: Final Path Assembly & Verification                                  │
│    • Rejoin validated segments with '/'.                                    │
│    • Return canonical path for GitHub Contents API.                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Reference Implementation: PathCanonicalizer

```typescript
export interface PathValidationResult {
  readonly isValid: boolean;
  readonly canonicalPath?: string;
  readonly error?: string;
}

export class PathCanonicalizer {
  private static readonly MAX_DECODE_CYCLES = 3;
  private static readonly MAX_TOTAL_LENGTH = 255;
  private static readonly MAX_SEGMENT_LENGTH = 100;
  private static readonly MAX_SEGMENTS = 10;
  private static readonly RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
  private static readonly ALLOWED_CHARS = /^[a-zA-Z0-9_.-]+$/;

  public static canonicalizeAndValidate(rawPath: string, baseFolder: string = ''): PathValidationResult {
    if (!rawPath || typeof rawPath !== 'string') {
      return { isValid: false, error: 'PATH_EMPTY_OR_INVALID_TYPE' };
    }

    // Step 1: Recursive URL Decoding (Canonicalization)
    let decoded = rawPath;
    try {
      for (let i = 0; i < this.MAX_DECODE_CYCLES; i++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    } catch {
      return { isValid: false, error: 'PATH_MALFORMED_URL_ENCODING' };
    }

    // Step 2: Unicode NFKC Normalization & Null Byte Check (Canonicalization)
    const normalized = decoded.normalize('NFKC');
    if (/[\x00\u0000]/.test(normalized)) {
      return { isValid: false, error: 'PATH_CONTAINS_NULL_BYTE' };
    }

    // Strip unprintable control characters
    const cleanChars = normalized.replace(/[\x01-\x1F\x7F-\x9F]/g, '');

    // Step 3: Separator Normalization and Absolute Path Rejection
    const forwardSlashed = cleanChars.replace(/\\/g, '/');
    if (forwardSlashed.startsWith('/') || /^[a-zA-Z]:/.test(forwardSlashed)) {
      return { isValid: false, error: 'PATH_ABSOLUTE_NOT_ALLOWED' };
    }

    // Step 4: Segment Extraction & Empty Segment Rejection
    const rawSegments = forwardSlashed.split('/');
    if (rawSegments.some(s => s.length === 0)) {
      return { isValid: false, error: 'PATH_CONTAINS_EMPTY_SEGMENTS' };
    }

    if (rawSegments.length > this.MAX_SEGMENTS) {
      return { isValid: false, error: 'PATH_EXCEEDS_MAX_SEGMENTS' };
    }

    // Step 5: Segment Grammar Validation & Traversal Checks
    const validatedSegments: string[] = [];
    for (const segment of rawSegments) {
      // Rejection of .. or traversal
      if (segment === '.' || segment === '..' || segment.includes('..')) {
        return { isValid: false, error: 'PATH_TRAVERSAL_DETECTED' };
      }

      // Check leading/trailing dots or whitespace
      if (/^[.\s]/.test(segment) || /[.\s]$/.test(segment)) {
        return { isValid: false, error: 'PATH_SEGMENT_LEADING_TRAILING_DOTS_OR_SPACES' };
      }

      if (segment.length > this.MAX_SEGMENT_LENGTH) {
        return { isValid: false, error: 'PATH_SEGMENT_TOO_LONG' };
      }

      // Check Windows reserved device names
      if (this.RESERVED_NAMES.test(segment)) {
        return { isValid: false, error: `PATH_RESERVED_DEVICE_NAME: ${segment}` };
      }

      // Check Git internal paths
      if (segment.toLowerCase().startsWith('.git')) {
        return { isValid: false, error: `PATH_GIT_INTERNAL_RESERVED: ${segment}` };
      }

      // Strict grammar check: only portable ASCII characters permitted
      if (!this.ALLOWED_CHARS.test(segment)) {
        return { isValid: false, error: `PATH_INVALID_CHARACTERS: ${segment}` };
      }

      validatedSegments.push(segment);
    }

    // Step 6: Total length check
    const finalRelative = validatedSegments.join('/');
    const fullPath = baseFolder ? `${baseFolder.replace(/\/+$/, '')}/${finalRelative}` : finalRelative;

    if (fullPath.length > this.MAX_TOTAL_LENGTH) {
      return { isValid: false, error: 'PATH_EXCEEDS_MAX_TOTAL_LENGTH' };
    }

    // Step 7: Base folder boundary containment check
    if (baseFolder) {
      const normalizedBase = baseFolder.replace(/^\/+|\/+$/g, '');
      if (!fullPath.startsWith(normalizedBase + '/') && fullPath !== normalizedBase) {
        return { isValid: false, error: 'PATH_ESCAPES_BASE_FOLDER_BOUNDARY' };
      }
    }

    return {
      isValid: true,
      canonicalPath: fullPath,
    };
  }
}
```

---

## 6. Template Configuration Validation & Preview

When a user defines or edits a template in the Options UI:
1. **Required Token Check**: Template must contain `{extension}` AND either `{slug}` or `{problem_id}`.
2. **Variable Whitelist**: Every `{token}` must exist in the known universal or platform variable list.
3. **Separator Validation**: Prohibit `//`, `\`, leading `/`, or `..`.
4. **Live Preview**: Generate an immediate simulated path using fixture data rendered in real-time. If the template produces a validation error, the UI displays the exact token in red and blocks saving.
