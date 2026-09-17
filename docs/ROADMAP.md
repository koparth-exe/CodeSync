# Development Roadmap
## CodeSync

**Document Version:** 2.0.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1 Hardened)  
**Classification:** Product Roadmap

---

## Overview

CodeSync follows a disciplined, phased-gated development process. Each phase produces a complete, testable increment. No phase begins without explicit sign-off on the prior phase gate.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DEVELOPMENT PHASES                                                          │
│                                                                             │
│  Phase 0: Initial Architecture & Planning                      [COMPLETED]  │
│  Phase 0.1: Security & Architecture Hardening Gate             [CURRENT]    │
│  Phase 1: Core Infrastructure & Hardened Services              [PENDING]    │
│  Phase 2: LeetCode Platform Adapter & Options UI               [PENDING]    │
│  Phase 3: Multi-Platform Expansion (CF, CC, GFG)               [PENDING]    │
│  Phase 4: Cross-Browser Verification & Web Store Readiness     [PENDING]    │
│  Phase 5: Post-Launch & Future Capabilities (Backfill, etc.)   [FUTURE]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 0: Initial Architecture & Planning ✅
- Initial SRS, system architecture, data models, queue design, adapter specs, and baseline ADRs produced.

---

## Phase 0.1: Security & Architecture Hardening Gate ✅ (Current)

**Objective:** Hardening all architectural specifications before any source code is written.

### Deliverables:
- [x] Comprehensive 26-scenario Threat Model (A through Z) documented in `SECURITY.md`.
- [x] GitHub App migration with Device Flow and Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions.
- [x] 10-step validated transactional write protocol with optimistic concurrency control and 8-step 409 conflict revalidation.
- [x] Hybrid Storage partitioning specification (`browser.storage.local` + `IndexedDB` PayloadStore).
- [x] Hardened Path Security architecture: Canonicalization + Strict Safe Grammar + Boundary Validation defending against traversal, non-ASCII/confusable Unicode, encodings, null bytes, and Windows reserved names.
- [x] Layered extraction hierarchy defined per-platform; explicit rejection of universal network interception.
- [x] Fail-closed architectural invariants established across all services.
- [x] Security testing strategy expanded with 19 specialized test suites in `TESTING-STRATEGY.md`.
- [x] Accurate, evidence-based differentiation in `COMPETITOR-ANALYSIS.md`.
- [x] Updated ADRs (ADR-0003, ADR-0004, ADR-0005, ADR-0006).

**Gate Condition:** Full documentation audit verification and human/ChatGPT sign-off. Zero implementation code created.

---

## Phase 1: Core Infrastructure & Hardened Services

**Goal:** Build the extension foundation and core services without platform adapters.

### Deliverables:
1. **WXT Setup**: `wxt init` with React 19, TypeScript (strict), and Tailwind CSS 4.
2. **Hybrid Storage Layer**: `StorageService` (`storage.local` for metadata/locks/auth) and `PayloadStorage` (`IndexedDB` for source code payloads and history).
3. **Typed Message Bus**: Envelope validation (UUID v4 nonce, timestamp window, sender context checks).
4. **GitHub App Service**: Device Authorization Flow, token refresh lifecycle (8-hour tokens, 6-month refresh tokens), repo-scoped Contents API client.
5. **Safe Write Engine**: 10-step validated transactional write protocol with optimistic concurrency control (blob SHA) and 8-step 409 conflict revalidation.
6. **Path Template Engine**: Deterministic canonicalization, strict safe path grammar validation, and repository base boundary enforcement.
7. **Queue Manager**: Write-Ahead Log, state transitions, two-tier concurrency control (Web Locks API + persistent lease record with probe-and-verify), crash counter, and poison-pill isolation.
8. **Deduplication Engine**: SHA-256 line-ending normalized content comparison.
9. **Diagnostics & Logger**: Secure logging abstraction with automatic credential and source code redaction.
10. **Security Test Suite Implementation**: Automated execution of security test suites S1 through S19.

**Gate Condition:** All core services pass unit/integration tests (85%+ coverage). Build succeeds for Chrome, Edge, and Firefox. 0 platform adapters implemented.

---

## Phase 2: LeetCode Platform Adapter & Options UI

**Goal:** End-to-end working sync for LeetCode submissions; verified Options & Popup UI.

### Deliverables:
1. **LeetCode Adapter**: Same-origin GraphQL API observation, submission check polling, Monaco editor bridge.
2. **Options UI**: GitHub App connection flow, repository picker, live path template preview with instant syntax validation.
3. **Popup UI**: Sync status, recent syncs, queue health, manual retry button.
4. **User-Assisted Recovery**: Interactive UI prompt when extraction confidence < 0.70.
5. **Fixture Test Suite**: Version-controlled LeetCode fixtures for judging and problem schemas.

**Gate Condition:** Successfully detect, extract, queue, and sync accepted LeetCode submissions to a test repository. Duplicate detection skips identical code. Conflict retry verified.

---

## Phase 3: Multi-Platform Expansion

**Goal:** Implement Codeforces, CodeChef, and GeeksforGeeks platform adapters.

### Deliverables:
1. **Codeforces Adapter**: Public REST API polling + same-origin submission page HTML parsing.
2. **CodeChef Adapter**: IDE submission API observation + submission detail API.
3. **GeeksforGeeks Adapter**: Submission payload interception + editor state fallback.
4. **Per-Platform Templates**: Default path templates and platform-specific variables (`{rating}`, `{problem_code}`).
5. **Fixture Test Suites**: Fixtures captured for Codeforces, CodeChef, and GFG.

**Gate Condition:** All 4 platforms synchronize accepted submissions cleanly across Chrome, Edge, and Firefox.

---

## Phase 4: Polish, Cross-Browser Verification & Release Prep

**Goal:** Extension store readiness and cross-browser testing.

### Deliverables:
1. **Automated Cross-Browser E2E**: Playwright tests executing against Chromium and Firefox.
2. **Security Audit**: Dependency vulnerability scan, manifest permissions check, CSP compliance verification.
3. **Store Packaging**: Zip artifact builds for Chrome Web Store, Microsoft Edge Add-ons, and Firefox AMO.
4. **Documentation**: User guide, migration guide from LeetHub, and troubleshooting documentation.

**Gate Condition:** Extension passes automated security checks and store packaging validation.

---

## Phase 5: Post-Launch & Future Capabilities (Deferred)

- Submission history backfill capabilities.
- Additional platform adapters (AtCoder, HackerRank, Kattis).
- Codolio portfolio synchronization integration (if public API becomes available).