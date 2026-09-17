# CodeSync

> **Automatically sync your competitive programming solutions to GitHub.**

CodeSync is a cross-browser extension that detects when you submit a coding problem on supported platforms, captures your verified source code and metadata, and synchronizes solutions to a GitHub repository of your choice — with configurable path templates, deduplication, and a persistent, crash-resilient retry queue.

## Status

🟡 **Phase 0.1.2 — Final Documentation Consistency Gate** (Complete — Awaiting Review)

No source code has been implemented yet. This phase establishes a hardened security model, comprehensive threat modeling (Scenarios A through Z), least-privilege GitHub App authentication, hybrid partitioned storage, two-tier concurrency control, validated transactional write protocol, deterministic path traversal defenses, and strict fail-closed invariants before Phase 1 begins.

## Supported Platforms (Planned)

| Platform | Status | Extraction Strategy |
|---|---|---|
| LeetCode | 🟡 Planned | Same-Origin Internal GraphQL API + Polling |
| Codeforces | 🟡 Planned | Public REST API + Submission Page Parse |
| CodeChef | 🟡 Planned | Submission API Observation + Detail API |
| GeeksforGeeks | 🟡 Planned | Submission Payload Intercept + Editor Bridge |
| Codolio | ⚪ Deferred | Portfolio Aggregator (No judge or code submissions) |

## Browser Support (Planned)

| Browser | Manifest | Status |
|---|---|---|
| Google Chrome | MV3 | 🟡 Primary (Tier 1) |
| Microsoft Edge | MV3 | 🟡 Primary (Tier 1) |
| Mozilla Firefox | MV3 | 🟡 Secondary (Tier 2) |
| Apple Safari | MV3 | ⚪ Future (Tier 3) |

## Tech Stack (Hardened)

- **Language:** TypeScript 5.7+ (Strict mode)
- **Extension Framework:** WXT (Web Extension Tools v0.21.x)
- **UI:** React 19 + Tailwind CSS 4
- **State Management:** Zustand 5
- **Build Engine:** Vite (via WXT)
- **Testing:** Vitest 3 + Playwright
- **Storage:** Hybrid (`browser.storage.local` metadata + `IndexedDB` payloads)
- **GitHub Integration:** GitHub App User-to-Server Auth (Device Flow) + REST API v3
- **Security:** Strict MV3 CSP, least-privilege permissions, zero telemetry, fail-closed architecture

## Development Workflow

This project uses a **phased gated development** process:

1. **ChatGPT** — Architecture, security audit, planning, risk analysis
2. **Antigravity** — Implementation, testing, execution

No phase may begin without explicit approval of the prior phase gate.

## Documentation Set

All Phase 0 / Phase 0.1 architecture documents are located in [`/docs`](./docs/):

- [SRS](./docs/SRS.md) — Software Requirements Specification
- [Architecture](./docs/ARCHITECTURE.md) — System Architecture Specification
- [Tech Stack](./docs/TECH-STACK.md) — Technology Decisions & Supply Chain Security
- [Security](./docs/SECURITY.md) — Threat Model (Scenarios A–Z) & Security Architecture
- [Privacy](./docs/PRIVACY.md) — Privacy Architecture & Source Code Protection
- [Platform Adapter Spec](./docs/PLATFORM-ADAPTER-SPEC.md) — Adapter Interface & Extraction Strategy
- [GitHub Integration](./docs/GITHUB-INTEGRATION.md) — Auth & Validated Transactional Write Protocol
- [Data Model](./docs/DATA-MODEL.md) — Core Data Structures & Storage Schemas
- [Queue Design](./docs/QUEUE-DESIGN.md) — Hybrid Storage Queue & Concurrency Lease Engine
- [Path Template Spec](./docs/PATH-TEMPLATE-SPEC.md) — Three-Pillar Path Engine & Traversal Defense Pipeline
- [Testing Strategy](./docs/TESTING-STRATEGY.md) — Testing Architecture & 19 Security Suites
- [Competitor Analysis](./docs/COMPETITOR-ANALYSIS.md) — Factual Market & Architecture Differentiation
- [Browser Compatibility](./docs/BROWSER-COMPATIBILITY.md) — Cross-Browser Plan & Ephemeral Lifecycle
- [Roadmap](./docs/ROADMAP.md) — Phased Gated Development Plan
- [ADR Index](./docs/ADR/) — Architecture Decision Records (ADR-0001 through ADR-0007)

## License

TBD

---

*Built with precision. Designed to survive platform redesigns, API changes, and network failures.*
