/**
 * Core Trust Boundary Hierarchy in CodeSync
 *
 * Architecture Invariants:
 * 1. Webpage != Trusted: Webpage DOM, scripts, and window messages are hostile.
 * 2. Content Script != Trusted: Runs in isolated worlds, but can be influenced by DOM.
 * 3. Service Worker = Trusted: Authoritative extension context with storage & API access.
 * 4. Data crossing boundary levels MUST undergo strict runtime schema validation.
 * 5. TypeScript types provide compile-time guarantees only, NOT runtime security.
 */

export enum TrustBoundary {
  /**
   * Untrusted: Platform webpage execution context, DOM elements, page scripts,
   * unvalidated window.postMessage events.
   */
  UNTRUSTED = "UNTRUSTED",

  /**
   * Semi-Trusted: Extension content scripts running in isolated worlds.
   * Isolated from page JavaScript variables, but directly interacting with untrusted DOM.
   */
  SEMI_TRUSTED = "SEMI_TRUSTED",

  /**
   * Trusted: Extension Background Service Worker, secure storage APIs,
   * Extension Popup and Options UI execution contexts.
   */
  TRUSTED = "TRUSTED",

  /**
   * External: Authenticated external APIs (e.g. api.github.com) accessed
   * over TLS.
   */
  EXTERNAL = "EXTERNAL",
}
