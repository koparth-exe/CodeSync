# ADR-0001: Local-First Architecture (No Backend)

**Status:** Accepted  
**Date:** 2026-09-12  
**Deciders:** Architecture team

---

## Context

CodeSync needs to sync code submissions from browser tabs to GitHub. This requires deciding whether to route data through a backend server or operate entirely within the browser extension.

## Decision

**Adopt a local-first, client-only architecture with no backend server.**

The extension communicates directly with the GitHub API. All processing (detection, extraction, normalization, queuing, syncing) occurs within the browser extension runtime.

## Alternatives Considered

### A. Backend proxy server
- Extension sends data to our server, server pushes to GitHub
- **Pros:** Easier token management, can batch operations, server-side logging
- **Rejected because:** Introduces a single point of failure, requires hosting costs, creates privacy risk (user source code transits our server), adds latency, requires user trust

### B. Serverless functions (AWS Lambda / Cloudflare Workers)
- Extension calls a serverless endpoint that proxies to GitHub
- **Pros:** Lower hosting burden than a full server
- **Rejected because:** Same privacy concerns as backend proxy, adds operational complexity, GitHub API is directly accessible from the extension

### C. Local-first (selected)
- Extension → GitHub API directly
- **Pros:** Zero infrastructure cost, maximum privacy (code never leaves user's machine except to their own GitHub), no server downtime dependency, simplest deployment
- **Cons:** GitHub rate limiting applies per-user, token management is extension-side only, no server-side logging

## Consequences

**Positive:**
- Zero operational cost
- Maximum user privacy — source code never transits any intermediary
- No server availability dependency
- Simpler architecture (fewer moving parts)
- Extension works offline (queue with retry)

**Negative:**
- Cannot aggregate usage metrics (by design — no telemetry)
- Cannot do server-side rate limit pooling
- Token storage is limited to browser extension storage APIs
- No centralized error reporting (by design)

**Neutral:**
- GitHub API rate limits (5,000/hr authenticated) are sufficient for individual users
- Extension store is the only distribution channel
