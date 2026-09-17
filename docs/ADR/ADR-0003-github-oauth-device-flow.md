# ADR-0003: GitHub App with Device Authorization Flow & Fine-Grained Permissions

**Status:** Accepted (Amended & Hardened in Phase 0.1)  
**Date:** 2026-09-12 (Amended: 2026-09-13)  
**Deciders:** Architecture & Security Team

---

## Context
CodeSync requires authenticated access to the GitHub REST API to synchronize solution files to user repositories. Traditional browser extensions either rely on:
1. **Personal Access Tokens (PAT)**: Requiring users to copy and paste high-entropy secrets that often have over-broad scopes (e.g. monolithic `repo` access) and indefinite lifetimes.
2. **Legacy OAuth Apps with Device Flow**: Avoiding server-side redirect handling, but still requesting monolithic `repo` or `public_repo` scopes that grant broad read/write access across all user repositories, pull requests, and settings.

CodeSync requires an authentication architecture following the Principle of Least Privilege, repository-level isolation, and automatic credential rotation without requiring a public backend proxy server.

---

## Decision
**Adopt a GitHub App architecture utilizing the OAuth Device Authorization Flow for user-to-server tokens, requesting Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions. Maintain fine-grained PAT as an advanced manual fallback only.**

### Architecture Characteristics:
1. **No Backend Required**: The Device Authorization Flow (`https://github.com/login/device/code`) executes purely client-side from the browser extension service worker.
2. **Repository-Level Scoping**: During GitHub App installation/authorization on github.com, users select "Only select repositories" to isolate CodeSync strictly to their solution repository.
3. **Fine-Grained Permissions**: The GitHub App requests Repository Contents permission sufficient for the required read and write operations ('Contents: read and write'), scoped to explicitly authorized repositories, with no unrelated repository permissions. It has zero access to issues, pull requests, actions, webhooks, or user account settings.
4. **Automated Credential Rotation**: User access tokens expire in 8 hours and rotate automatically using 6-month refresh tokens via the service worker.
5. **Fallback Policy**: Personal Access Tokens (PAT) are supported strictly as an advanced/manual fallback, requiring fine-grained token creation with explicit repository restrictions.

---

## Alternatives Considered

### A. Personal Access Token (PAT) as Primary
- **Evaluated**: User pastes a GitHub PAT directly into the extension.
- **Rejected as Primary**: Poor security posture. Users routinely create classic tokens with full `repo` access, lack repository isolation, copy tokens to clipboards with snooping risks, and face sync failures upon manual token expiration.

### B. Legacy OAuth App with Device Flow
- **Evaluated**: Traditional OAuth App using device flow.
- **Rejected as Primary**: Legacy OAuth Apps can only request broad scopes (`repo`), which grants read/write access to **all** private repositories, issues, wiki, and settings, and issues indefinite access tokens.

### C. GitHub App with Server-Side Installation Webhooks
- **Evaluated**: Standard backend server exchanging server-to-server installation tokens.
- **Rejected**: Violates CodeSync's foundational local-first, zero-telemetry invariant and introduces server maintenance and infrastructure costs.

### D. GitHub App with Device Flow User Access Tokens (Selected)
- **Selected**: Combines the client-side simplicity of Device Flow with the fine-grained repository permissions and 8-hour token rotation of GitHub Apps.

---

## Consequences

### Positive:
- **Least Privilege**: Token has zero access outside the explicitly selected repository.
- **Credential Hygiene**: 8-hour access token lifecycle minimizes the blast radius of potential local token theft.
- **Zero Backend**: Preserves local-first architecture with zero hosting costs.
- **Familiar UX**: User authorizes directly on `github.com/login/device`.

### Negative / Trade-Offs:
- Device flow requires user to switch to a GitHub tab and enter a short user code.
- Service worker must manage refresh token rotation before access tokens expire.
- If user revokes app permissions on GitHub, the extension must fail closed and handle `AUTH_EXPIRED`.
