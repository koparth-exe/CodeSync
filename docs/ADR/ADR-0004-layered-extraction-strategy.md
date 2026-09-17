# ADR-0004: Layered Platform Extraction Strategy & Safety Hierarchy

**Status:** Accepted (Amended & Hardened in Phase 0.1)  
**Date:** 2026-09-12 (Amended: 2026-09-13)  
**Deciders:** Architecture & Security Team

---

## Context
Capturing verified source code and metadata across heterogeneous competitive programming websites is a core challenge. Competitor extensions rely exclusively on brittle DOM selectors that break whenever a platform redesigns its frontend, or they make flawed architectural assumptions that "network interception" can be applied uniformly to all platforms.

CodeSync requires a resilient, secure extraction strategy that recognizes platform differences and enforces defense-in-depth without violating the principle of least privilege.

---

## Decision
**Adopt a layered extraction strategy ordered by safety and feasibility, tailored per platform rather than treating network interception as universal:**

```
Priority 1: Official / Public REST API (e.g. Codeforces API)
Priority 2: Same-Origin Authenticated Endpoint (e.g. LeetCode GraphQL / Submission Check)
Priority 3: Submission-Detail Page Data Extraction (Direct HTML/JSON page fetch)
Priority 4: Page-Context Fetch/XHR Observation (World bridge observation where required)
Priority 5: In-Memory Editor State Bridge (Monaco / CodeMirror instance inspection)
Priority 6: Scoped DOM Extraction (CSS selector fallback)
Priority 7: User-Assisted Recovery (Interactive prompt, zero guessing)
```

### Key Principles:
1. **No Universal Network Interception**: Network interception is not a magic bullet. Adapters implement only the specific layers viable for their platform.
2. **Confidence Heuristic vs Security Trust**: Extraction confidence (0.0 to 1.0) is strictly an empirical completeness heuristic, NOT a measure of security authenticity. If confidence < 0.70, CodeSync **fails closed** and prompts for User-Assisted Recovery. If confidence >= 0.70, the payload is permitted to enter the 9-step deterministic validation pipeline. **Confidence alone NEVER authorizes a GitHub write.**
3. **Deterministic Validation**: Critical properties (submission ID format, status enum, platform context, slug grammar, UTF-8 source code, language consistency) must pass deterministic validation before enqueuing.
4. **Defense Against Hostile Metadata**: All extracted strings undergo strict schema validation and sanitization before entering the normalization pipeline.

---

## Consequences

### Positive:
- **Resilience**: Survives platform UI redesigns by prioritizing stable API and submission check layers.
- **Least Privilege**: Avoids broad, intrusive network interception where public or same-origin APIs suffice.
- **Fail-Closed Safety**: Confidence scoring prevents garbage or partial code from corrupting GitHub repositories.

### Negative / Trade-Offs:
- Requires custom adapter logic and fixture-based tests for each supported platform.
- Main-world bridge injection for editor inspection requires careful origin and nonce verification.
