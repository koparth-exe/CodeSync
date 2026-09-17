# ADR-0002: WXT as Extension Framework

**Status:** Accepted  
**Date:** 2026-09-12  
**Deciders:** Architecture team

---

## Context

Building a cross-browser extension requires choosing between a framework (WXT, Plasmo) or raw Manifest V3 scaffolding. The framework must support Chrome, Edge, and Firefox from a single codebase with TypeScript and React.

## Decision

**Use WXT (Web Extension Tools) as the extension framework.**

WXT v0.21.x is an open-source (MIT), community-maintained framework that generates browser-specific builds from a single codebase. It provides file-based entrypoints, HMR, TypeScript by default, and cross-browser manifest generation.

## Alternatives Considered

### A. Plasmo
- VC-backed browser extension framework
- **Pros:** Larger community, first-class React support via CSUI, built-in messaging abstraction
- **Rejected because:** Higher vendor lock-in risk (proprietary patterns like CSUI), company-dependent maintenance, heavier bundle, less control over content script and service worker lifecycle

### B. Raw Manifest V3
- No framework, manual configuration
- **Pros:** Zero abstraction overhead, full control
- **Rejected because:** Manual manifest management per browser is error-prone, no HMR, no TypeScript build pipeline out of the box, duplicated boilerplate for content script registration, significantly slower development velocity

### C. WXT (selected)
- **Pros:** MIT licensed, community-driven, less opinionated (stays close to raw APIs), cross-browser builds from single config, Vite-based (fast builds), supports any UI framework, lower lock-in risk
- **Cons:** Smaller community than Plasmo, slightly less "batteries included"

## Consequences

**Positive:**
- Single `wxt.config.ts` generates Chrome, Edge, Firefox manifests
- File-based entrypoints reduce boilerplate
- HMR and auto-reload during development
- Low abstraction — adapters interact with standard `browser.*` APIs
- Lower vendor lock-in than Plasmo
- Active maintenance (v0.21.4 as of September 2026)

**Negative:**
- Pre-1.0 — API may change (mitigated by version pinning)
- Smaller community may mean fewer third-party plugins
- Less automated messaging abstraction (we build our own typed message bus)
