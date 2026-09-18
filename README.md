# CodeSync (In Development)

> **Synchronize verified competitive programming solutions directly to GitHub.**

CodeSync is an open-source, local-first Manifest V3 browser extension built with TypeScript, React 19, and WXT. It observes accepted problem submissions across supported competitive programming platforms, normalizes solution code and metadata, and synchronizes them to your configured GitHub repository through a resilient transactional pipeline.

---

## Key Features & Verified Capabilities

- **Automated Submission Capture:** Observes and captures accepted solutions with zero copy-pasting required.
- **Supported Platforms:**
  - **LeetCode:** Same-origin internal API observation and verification
  - **Codeforces:** Public REST API and submission page extraction
  - **CodeChef:** Submission API observation and detail extraction
  - **GeeksforGeeks:** Submission payload interception and verification
- **Local-First Resilient Architecture:**
  - **Hybrid Partitioned Storage:** Submission metadata stored in `browser.storage.local`; solution payloads stored in `IndexedDB`.
  - **Write-Ahead Log (WAL) & Concurrency Leases:** Atomic state transitions, cross-context mutex leases, and heartbeat fencing designed to ensure crash recovery and prevent duplicate synchronization.
- **Secure GitHub Integration:**
  - **GitHub App User-to-Server Authentication:** Built using OAuth 2.0 Device Authorization Grant (RFC 8628).
  - **Durable Token Lifecycle:** Automatic token refresh, rotation, and expiration handling.
  - **Direct API Routing:** All GitHub REST requests route directly from the browser to `api.github.com` with zero third-party relays.

---

## Architecture Overview

```text
[ Platform Webpage ]
        │ (DOM / Network Observation)
        ▼
[ Content Script Adapter ]
        │ (Structured Envelope Validation)
        ▼
[ Background Service Worker ]
   ├── Event Deduplication (Sliding TTL window)
   ├── Hybrid Storage (WAL Metadata + IndexedDB Payloads)
   ├── Concurrency Lease Engine (Lock Mutex & Heartbeat Fencing)
   └── GitHub Sync Handler (Tree Conflict Resolution & Exponential Backoff)
        │ (HTTPS REST API v3)
        ▼
[ GitHub Repository ]
```

---

## Technology Stack

- **Runtime & Packaging:** Manifest V3 (MV3), [WXT Extension Framework](https://wxt.dev/) (v0.21.x)
- **Language:** TypeScript 5.7+ (Strict Mode)
- **UI & State:** React 19, Tailwind CSS
- **Test Frameworks:** Vitest 3, Playwright (Real-browser e2e)
- **Code Quality:** ESLint 9 (Flat Config), Prettier 3

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0

### Installation

```bash
# Clone the repository
git clone https://github.com/koparth-exe/CodeSync.git
cd CodeSync

# Install dependencies
npm install
```

### Development Mode

Start the extension in development mode with hot reload:

```bash
# For Chromium browsers (Chrome, Edge, Brave):
npm run dev

# For Firefox:
npm run dev:firefox
```

Load the generated `.output/chrome-mv3` or `.output/firefox-mv3` directory into your browser via `chrome://extensions` or `about:debugging`.

### Production Build

```bash
# Production build for Chromium:
npm run build

# Production build for Firefox:
npm run build:firefox
```

### Running Tests

CodeSync includes automated unit, security, and real-browser integration suites:

```bash
# Run the full Vitest suite (44 suites, 570 tests):
npm test

# Run type check and linting:
npm run compile
npm run lint

# Run real-browser Playwright test suite:
npm run test:browser
```

---

## Security & Privacy Invariants

- **Privacy-First Storage:** Authentication tokens and credentials reside strictly in extension-isolated `browser.storage.local` and are never exposed to content scripts or web pages.
- **Fail-Closed Processing:** Malformed envelopes, unverified sender origins, or unverified platform candidates are rejected fail-closed before entering the queue.
- **Zero Third-Party Telemetry:** CodeSync collects no analytics and routes no code or user data through external intermediaries.

For detailed technical specifications, consult [`docs/SECURITY.md`](./docs/SECURITY.md) and [`docs/PRIVACY.md`](./docs/PRIVACY.md).

---

## Contributing

Contributions are welcome. Please open an issue to discuss proposed changes before submitting a pull request. Ensure all contributions pass `npm run compile`, `npm run lint`, and `npm test`.

---

## License

This project is licensed under the [MIT License](./LICENSE) - see the LICENSE file for details.
