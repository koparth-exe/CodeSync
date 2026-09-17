# Cross-Browser Compatibility & Security Specification
## CodeSync

**Document Version:** 2.0.0-hardened  
**Date:** 2026-09-13  
**Status:** Approved Architecture (Phase 0.1 Hardened)  
**Classification:** Technical Architecture Specification

---

## 1. Target Browsers & Tier Definitions

| Browser | Engine | Manifest | Support Tier | Minimum Supported Version |
|---|---|---|---|---|
| **Google Chrome** | Chromium | MV3 | **Tier 1 (Primary)** | 120+ |
| **Microsoft Edge** | Chromium | MV3 | **Tier 1 (Primary)** | 120+ |
| **Mozilla Firefox** | Gecko | MV3 | **Tier 2 (Secondary)**| 128+ (Stable MV3 GA) |
| **Apple Safari** | WebKit | MV3 | **Tier 3 (Future)** | Safari 17.4+ (Via Xcode Web Extension converter) |

### Tier Invariants:
- **Tier 1 (Primary)**: Automated E2E testing in CI via Playwright. Any functional or security failure blocks release.
- **Tier 2 (Secondary)**: Automated build validation and manual smoke testing. Must achieve full security and functional parity.
- **Common Security Invariant**: Under no circumstances shall a browser-specific workaround or fallback weaken the common security model. If a browser cannot support secure credential isolation or deterministic path canonicalization, CodeSync will not release on that target.

---

## 2. API & Security Equivalence Matrix

| API / Feature Area | Chromium (Chrome / Edge) | Firefox (Gecko) | Security / Architectural Impact |
|---|---|---|---|
| **Namespace** | `chrome.*` & `browser.*` (via polyfill) | Native `browser.*` (Promise-based) | WXT provides a unified `browser.*` Promise API across all targets. |
| **Background Model** | Service Worker (Ephemeral, no DOM) | Background Script / Event Page (Ephemeral) | Both treat the background as ephemeral. State must persist across termination via Write-Ahead Log. |
| **Background Lifetime** | Terminates after ~30s idle or 5 min active | Terminates after ~30s idle | Woken deterministically via `browser.alarms`. Locks use 30s TTL with heartbeat. |
| **Storage Quota (`storage.local`)** | 10 MB default quota | 10 MB default quota | CodeSync strictly keeps metadata in `storage.local` (<1 MB) to stay well within limits. |
| **Payload Storage (`IndexedDB`)** | Supported; quota based on disk % | Supported; quota based on disk % | Unbounded storage for large source payloads and sync history. Identical transactional API. |
| **Content Script Worlds** | `world: "ISOLATED"` & `world: "MAIN"` | `world: "ISOLATED"` & `world: "MAIN"` (128+) | Isolated world for content script; main world bridge for in-memory editor extraction. |
| **Content Security Policy** | Strict MV3 CSP enforced | Strict MV3 CSP enforced | Common policy: `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none';`. |
| **Host Permissions** | Optional / Runtime or Install prompt | Prompts user on extension installation | Broad permissions (`<all_urls>`) banned; scoped strictly to target platform domains. |

---

## 3. Ephemeral Lifecycle & Background Reconciliation

Chromium service workers and Firefox event pages terminate aggressively. CodeSync handles this uniformly:

```typescript
// Rehydrate and reconcile on extension or alarm startup
browser.runtime.onStartup.addListener(async () => {
  await BackgroundReconciler.rehydrate();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'codesync:drain-queue') {
    await QueueManager.processPendingItems();
  }
});
```

### Background Reconciliation Sequence:
1. Re-establish storage connections to `browser.storage.local` and `IndexedDB`.
2. Inspect `codesync:queue:lock`. If a previous worker died while holding the lock and `Date.now() > lock.expiresAt`, release the stale lock.
3. Check for any queue item stuck in `PROCESSING`. Increment its `crashCount`. If `crashCount >= 3`, quarantine it to `REQUIRES_ATTENTION` (Poison Pill mitigation); otherwise, reset to `PENDING`.
4. Trigger queue drain.

---

## 4. Build Matrix & WXT Packaging

WXT builds separate artifacts from a unified TypeScript source tree without code divergence:

```bash
# Production Manifest V3 builds
wxt build                  # Outputs to .output/chrome-mv3/
wxt build --browser edge   # Outputs to .output/edge-mv3/
wxt build --browser firefox# Outputs to .output/firefox-mv3/
```
