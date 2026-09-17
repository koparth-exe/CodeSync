# Technology Stack Decision
## CodeSync

**Document Version:** 2.0.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1 Hardened)  
**Classification:** Technical Architecture Specification

---

## 1. Selected Stack Summary

| Category | Selection | Alternatives Evaluated | Architectural Rationale |
|---|---|---|---|
| **Language** | TypeScript 5.7+ (Strict) | JavaScript | Compile-time interface verification, strict null checks, discriminated union state machines. |
| **Extension Framework**| WXT (v0.21.x) | Plasmo, Raw MV3 | Unopinionated, lightweight, MIT-licensed, native Vite build pipeline, cross-browser MV3 manifest generation. |
| **UI Framework** | React 19 | Preact, Svelte, Solid | Industry-standard declarative UI, seamless JSX automatic string escaping (XSS prevention), mature ecosystem. |
| **State Management** | Zustand 5 | Redux Toolkit, Jotai | ~1 KB gzipped, zero boilerplate, hook-based, direct persistence middleware mapping. |
| **Styling** | Tailwind CSS 4 | Vanilla CSS, CSS Modules | Zero-runtime CSS compilation, strict design tokens, responsive layout utilities. |
| **Build & Bundling** | Vite (via WXT) | Webpack, Rollup | Sub-second HMR, native ES module transforms, optimized production tree-shaking. |
| **Manifest Target** | Manifest V3 (MV3) | Manifest V2 (Deprecated) | Compliance with Chrome Web Store and Firefox AMO standards. |
| **Primary Auth** | **GitHub App (Device Flow)** | Legacy OAuth App, PAT | Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, automatic 8h token rotation. |
| **Fallback Auth** | Fine-Grained PAT | Classic PAT | Manual fallback for restricted network environments; strict scope warning displayed. |
| **Storage Architecture**| **Hybrid: storage.local + IndexedDB** | storage.local only, IndexedDB only | `storage.local` for metadata/locks/auth (<1 MB); `IndexedDB` for source code payloads and sync history. |
| **Unit Testing** | Vitest 3 | Jest | Native ESM execution, Vite pipeline parity, built-in coverage reporting. |
| **E2E Testing** | Playwright | Cypress, Selenium | Multi-browser extension testing, service worker inspection, mock network route capabilities. |
| **Linting & Code Style**| ESLint 9 (Flat) + Prettier | Biome | Strict type-aware linting, security AST rules (`no-eval`, `no-implied-eval`), unified formatting. |

---

## 2. Dependency & Supply Chain Security Philosophy

CodeSync adopts a **zero-trust supply chain posture**:

1. **Minimal Runtime Footprint**: The production extension bundle contains **only React 19, Zustand, and CodeSync application code**.
2. **Zero Postinstall Scripts**: CI enforces `--ignore-scripts` to block malicious package installation hooks.
3. **Exact Lockfile Pinning**: `package-lock.json` is committed with exact version hashes. CI runs `npm ci` strictly.
4. **Vulnerability Auditing**: Automated CI gate executes `npm audit --audit-level=high`.
5. **No Dynamic Code Ingestion**: No remote scripts, no dynamic CDN assets, no external font loading. All fonts and assets are packaged locally.
