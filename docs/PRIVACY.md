# Privacy Architecture & Source Code Protection
## CodeSync

**Document Version:** 2.0.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1 Hardened)  
**Classification:** Product Privacy Specification

---

## 1. Core Privacy Invariant

> **CodeSync guarantees that your source code and credentials belong to you alone. They never touch any server, proxy, telemetry engine, or third party other than your own designated GitHub repository.**

CodeSync is architected as a local-first system with zero backend infrastructure. There are no analytics servers, no crash telemetry reporting, no ad trackers, and no remote diagnostic ingestion.

---

## 2. Source Code Lifecycle & Storage Boundaries

CodeSync handles users' proprietary source code and intellectual property. The table below documents the complete lifecycle of source code in the system:

| Lifecycle Stage | Memory / Storage Location | Persistence & Retention Policy | Encryption / Protection |
|---|---|---|---|
| **1. Page Extraction** | Content Script Memory | Ephemeral. Garbage collected immediately after message dispatch. | Isolated world boundary; page JS cannot inspect content script memory. |
| **2. IPC Transit** | Browser Runtime Message Bus | Ephemeral in-flight payload between content script and service worker. | Internal browser IPC mechanism; restricted to extension ID. |
| **3. Processing Memory** | Service Worker Heap | Ephemeral. Exists only during normalization and write pipeline execution. | Cleared upon service worker termination or garbage collection. |
| **4. Persistent Queue** | **IndexedDB (`codesync_db`)** | Stored in `payloads` store until sync completion + 24 hours auto-prune. | Protected by browser extension origin sandbox and host OS profile storage. |
| **5. Network Transit** | HTTPS (Browser-negotiated TLS) | Base64-encoded in PUT request body directly to `https://api.github.com`. | Encrypted in transit; strict TLS certificate validation. |
| **6. Repository Storage** | User's GitHub Repository | Stored permanently in user's selected Git branch. | Governed by user's GitHub repository settings (public or private). |
| **7. Diagnostics & Logs** | **EXPLICITLY BANNED** | **ZERO RETENTION**. Source code is NEVER logged or serialized to diagnostic stores. | Redacted by custom Logger abstraction. |

---

## 3. Data Storage & Minimization Table

| Data Element | Storage Location | Retention Limit | Purpose |
|---|---|---|---|
| **GitHub App Access Token** | `browser.storage.local` | Until expiry (8 hours) or disconnect | Authenticating GitHub API write requests. |
| **GitHub App Refresh Token** | `browser.storage.local` | Until expiry (6 months) or disconnect | Rotating user access token automatically. |
| **GitHub User Metadata** | `browser.storage.local` | Until disconnect | Displaying connected account login & avatar in UI. |
| **Target Repository & Branch** | `browser.storage.local` | Persistent until edited | Target Git destination configuration. |
| **Queue Metadata** | `browser.storage.local` | Pruned 24h after completion | Tracking sync state, retries, and error status. |
| **Source Code Payloads** | `IndexedDB (payloads)` | Pruned 24h after completion | Resilient queue replay across restarts. |
| **Sync History Metadata** | `IndexedDB (history)` | Max 1000 entries or 90 days | Showing recent sync log in extension UI. |
| **Diagnostic Events** | `browser.storage.local` | 7-day rolling window | Local user troubleshooting (never includes code/secrets). |

---

## 4. Source Code Privacy Invariants

1. **Zero External Transmission**: Source code is sent **only** to `api.github.com` via the official Contents API.
2. **Surviving Browser Restarts**: Source code in the persistent queue survives service worker termination and browser restarts via IndexedDB so that pending submissions are never lost during offline periods.
3. **No Code in Logs**: Console output, diagnostic event stores, and error telemetry **never** contain source code. Only metadata (line count, character length, language, SHA-256 hash) is recorded.
4. **Immediate Deletion Rights**: The user has the absolute right to purge all data via the "Delete All Data" button in the Options page, which executes a complete purge wiping `browser.storage.local` and `IndexedDB`.
