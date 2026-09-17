# ADR-0006: Hardened Path Template Engine & Traversal Defense

**Status:** Accepted (Amended & Hardened in Phase 0.1)  
**Date:** 2026-09-12 (Amended: 2026-09-13)  
**Deciders:** Architecture & Security Team

---

## Context
Customizable folder structures are the most requested feature by users. However, constructing repository file paths by concatenating user templates and untrusted platform metadata presents severe security risks, including directory traversal (`../`), encoded path escapes (`%2e%2e%2f`), Unicode homoglyphs, null-byte truncation, and Windows device name collisions (`CON`, `PRN`, `AUX`, `NUL`).

CodeSync requires a path template engine that empowers user customization while deterministically preventing path traversal attacks and boundary escapes.

---

## Decision
**Implement a declarative curly-brace template engine (`{platform}/{difficulty}/{slug}.{extension}`) backed by a Three-Pillar Security Architecture (Canonicalization + Strict Safe Path Grammar + Boundary Validation) that fails closed upon any traversal token or invalid character:**

1. **Three-Pillar Path Security**:
   - **Canonicalization**: Multi-pass URL decoding (max 3 cycles), Unicode NFKC normalization, separator normalization (`\` to `/`), and null-byte rejection. *Canonicalization reduces ambiguity; it does not determine acceptability.*
   - **Strict Safe Path Grammar**: Segments must strictly match the POSIX portable ASCII character set `^[a-zA-Z0-9_.-]+$`. Non-ASCII Unicode (homoglyphs, confusables, BIDI overrides, zero-width spaces), whitespace, control characters, Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, etc.), and `.git` internal paths are categorically rejected.
   - **Boundary Validation**: Path must be strictly relative and reside within the user's configured base folder without escape.
2. **Fail-Closed Principle**: If any step fails, the engine halts the sync and marks the item `REQUIRES_ATTENTION`. It **never** attempts "best-effort" corrections (e.g. stripping `..` and writing to the root directory).
3. **Edit-Time Live Preview**: The Options UI validates templates in real-time and renders an instant preview using fixture data, disabling saving if syntax or security checks fail.

---

## Consequences

### Positive:
- **Zero Directory Traversal**: Comprehensive defense against encoded, double-encoded, and Unicode traversal attacks.
- **Repository Isolation**: Solutions can never escape the repository root or the user's configured base directory.
- **Cross-Platform Safety**: Prevents Windows-specific DOS device collisions when repository is cloned on Windows machines.

### Negative / Trade-Offs:
- Highly esoteric directory structures containing symbols like `+`, `@`, or `%` are disallowed by the strict character whitelist (`[a-zA-Z0-9_.-]`).
