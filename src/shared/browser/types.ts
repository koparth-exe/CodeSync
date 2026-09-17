/**
 * Supported browser targets for CodeSync
 */
export type BrowserType = "chrome" | "edge" | "firefox" | "unknown";

/**
 * Common capabilities and configuration differences across target browsers
 */
export interface BrowserCapabilities {
  readonly browserType: BrowserType;
  readonly isChromium: boolean;
  readonly isGecko: boolean;
  readonly supportsWebLocks: boolean;
  readonly backgroundType: "service_worker" | "event_page";
}
