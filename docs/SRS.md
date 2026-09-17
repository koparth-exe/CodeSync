# Software Requirements Specification (SRS)
## CodeSync — Competitive Programming Solution Syncer

**Document Version:** 2.1.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1.1 Precision Pass)  
**Classification:** Product Specification

---

## 1. Introduction

### 1.1 Purpose
This document specifies the functional, non-functional, security, and interface requirements for CodeSync, a cross-browser extension that automatically detects coding submissions on competitive programming platforms, extracts verified source code and metadata, and synchronizes solutions to a user-configured GitHub repository.

### 1.2 Scope
CodeSync operates entirely within the browser client runtime under a strict local-first architecture. It requires no backend server, no cloud proxies, and zero telemetry. All processing occurs locally in the extension's service worker, content scripts, and storage layers.

---

## 2. Core Functional Requirements

### 2.1 Submission Detection (F1)
- **F1.1**: The system SHALL detect when a user submits a solution on a supported platform (LeetCode, Codeforces, CodeChef, GeeksforGeeks).
- **F1.2**: Detection SHALL use content-script observation (same-origin API responses, page-context fetch/XHR observation via world bridge, or form submission hooks). Detection SHALL NOT use `webRequest`.
- **F1.3**: Detection SHALL be strictly bounded to URLs matching the active platform adapter's declared patterns.
- **F1.4**: Detection SHALL NOT alter or delay the platform's native submission judging flow.

### 2.2 Submission Status Determination (F2)
- **F2.1**: The system SHALL determine the final judging verdict (Accepted, Wrong Answer, TLE, etc.).
- **F2.2**: The system SHALL support configurable status filters (default: sync only `Accepted` submissions).
- **F2.3**: If judging verdict is ambiguous or pending, the system SHALL keep the submission in a polling state or mark it `REQUIRES_ATTENTION`; it SHALL NOT guess the outcome.

### 2.3 Source Code Extraction & Validation (F3)
- **F3.1**: The system SHALL extract the exact submitted source code using a layered strategy (Platform API → Authenticated Endpoint → Submission Detail Page → Editor Bridge → DOM Fallback).
- **F3.2**: Each extraction layer SHALL calculate an extraction confidence score (0.0 to 1.0) as a quality heuristic. If confidence is below 0.70, the system SHALL fail closed and prompt for User-Assisted Recovery. If confidence is ≥ 0.70, the payload SHALL be required to pass the 9-step deterministic validation pipeline before synchronization. Confidence alone SHALL NEVER authorize a GitHub write.
- **F3.3**: Extracted source code SHALL NOT be modified, formatted, or minified, preserving the user's exact indentation and style.
- **F3.4**: Source code payloads SHALL be capped at 500 KB and verified to be valid UTF-8 text free of null bytes.

### 2.4 Problem Metadata Extraction (F4)
- **F4.1**: The system SHALL extract problem title, problem slug, problem ID, difficulty/rating, and platform name.
- **F4.2**: All extracted metadata strings SHALL be sanitized (HTML entity stripping, control character removal, length limiting) before entering the normalization pipeline.

### 2.5 GitHub Authentication (F6)
- **F6.1**: The system SHALL use **GitHub App User-to-Server Authentication via the OAuth Device Authorization Flow** as the primary authentication mechanism.
- **F6.2**: The system SHALL request Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions.
- **F6.3**: Tokens SHALL have an 8-hour lifespan and rotate automatically using 6-month refresh tokens.
- **F6.4**: Personal Access Token (PAT) fallback is formally DEFERRED for Phase 1C to prevent static unrotated credential exposure.
- **F6.5**: The system SHALL provide an instant "Disconnect GitHub" function that wipes local credentials (`codesync:auth`) and cache fail-closed. Remote token revocation via client-secret endpoints is deferred to direct user management on GitHub.com due to public client security constraints.

### 2.6 Path Template Resolution & Three-Pillar Defense (F8)
- **F8.1**: The system SHALL resolve user-configurable path templates supporting universal variables (`{platform}`, `{slug}`, `{difficulty}`, `{language}`, `{extension}`) and platform-specific variables.
- **F8.2**: Path security SHALL enforce a three-pillar model: Canonicalization (multi-pass URL decode, NFKC normalization, separator normalization) + Strict Safe Path Grammar (POSIX portable ASCII whitelist `^[a-zA-Z0-9_.-]+$`, no ambiguous/confusable Unicode, no control/null bytes, no DOS reserved names) + Base Folder Boundary Validation. Canonicalization alone SHALL NOT determine acceptability.
- **F8.3**: If path validation fails, the system SHALL fail closed and alert the user in the recovery UI.

### 2.7 Duplicate Detection (F9)
- **F9.1**: The system SHALL compare the SHA-256 hash of the submitted source code against the existing GitHub file content.
- **F9.2**: Under the default policy (`REPLACE_IF_DIFFERENT`), if the remote content hash matches, the sync operation SHALL be marked `SKIPPED` without creating an empty GitHub commit.

### 2.8 GitHub Write Protocol & Conflict Handling (F10)
- **F10.1**: GitHub file writes SHALL execute via a **validated transactional write protocol with optimistic concurrency control** using expected blob SHAs. The system SHALL recognize that the multi-request HTTP sequence is not literally an atomic transaction.
- **F10.2**: Upon encountering an HTTP 409 Conflict, the system SHALL execute the 8-Step Conflict Protocol: halt write, re-fetch remote state, compare content hash, and re-evaluate duplicate policy. The system SHALL NOT perform blind retries of an identical write.

### 2.9 Persistent Queue Management & Concurrency (F12)
- **F12.1**: The system SHALL persist every detected submission immediately using a two-phase Write-Ahead Log (WAL) before initiating any GitHub network requests.
- **F12.2**: Source code payloads SHALL be persisted to `IndexedDB`; queue metadata and state indices SHALL be persisted to `browser.storage.local`.
- **F12.3**: Concurrency control SHALL implement a two-tier model: native Web Locks API (`navigator.locks`) for active session serialization, backed by a persistent storage lease record in `storage.local` with a probe-and-verify protocol (not assuming compare-and-swap primitives).
- **F12.4**: The queue SHALL enforce exponential backoff with jitter on transient failures and isolate poison-pill items that crash the service worker (max 3 crashes).

---

## 3. Security & Non-Functional Requirements

### 3.1 Least-Privilege Permissions
- The extension SHALL NOT request `webRequest`, `webRequestBlocking`, `tabs`, `cookies`, `history`, `clipboardRead`, or `<all_urls>`.
- The extension SHALL only request `storage`, `alarms`, and `notifications`, with host permissions limited to target platform domains and GitHub.

### 3.2 Content Security Policy (CSP)
- The extension pages SHALL enforce: `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';`.
- No inline scripts, `eval()`, `Function()`, or remote CDN scripts are permitted.

### 3.3 Privacy & Data Protection
- **Zero Telemetry**: No tracking, analytics, or error monitoring services.
- User source code and GitHub tokens SHALL NEVER be output to console logs or included in exported diagnostics.

### 3.4 Fail-Closed Architecture
- In any condition of credential ambiguity, template error, SHA conflict exhaustion, or platform metadata corruption, CodeSync SHALL stop execution and require explicit user resolution.
