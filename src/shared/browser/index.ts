import type { BrowserCapabilities, BrowserType } from "./types";
import { BrowserRuntimeError, ErrorCode } from "../errors";

export * from "./types";

/**
 * Detects the current browser engine in a cross-platform manner.
 */
export function detectBrowser(): BrowserType {
  if (typeof navigator === "undefined") {
    return "unknown";
  }

  const userAgent = navigator.userAgent.toLowerCase();

  if (userAgent.includes("edg/")) {
    return "edge";
  }
  if (userAgent.includes("firefox/") || userAgent.includes("gecko/")) {
    return "firefox";
  }
  if (userAgent.includes("chrome/") || userAgent.includes("chromium/")) {
    return "chrome";
  }

  return "unknown";
}

/**
 * Returns capabilities and architecture characteristics for current runtime.
 */
export function getBrowserCapabilities(): BrowserCapabilities {
  const browserType = detectBrowser();
  const isGecko = browserType === "firefox";
  const isChromium = browserType === "chrome" || browserType === "edge";

  return {
    browserType,
    isChromium,
    isGecko,
    supportsWebLocks: typeof navigator !== "undefined" && "locks" in navigator,
    backgroundType: isGecko ? "event_page" : "service_worker",
  };
}

/**
 * Safely retrieves the WebExtension runtime API namespace.
 * Throws BrowserRuntimeError if called outside an extension context.
 */
export function getExtensionRuntime(): typeof chrome.runtime {
  if (typeof browser !== "undefined" && browser.runtime) {
    return browser.runtime as unknown as typeof chrome.runtime;
  }
  if (typeof chrome !== "undefined" && chrome.runtime) {
    return chrome.runtime;
  }

  throw new BrowserRuntimeError(
    "WebExtension runtime API is not available in the current context.",
    "Extension runtime unavailable.",
    ErrorCode.BROWSER_RUNTIME_UNAVAILABLE,
  );
}

/**
 * Safely retrieves the WebExtension storage API namespace.
 * Throws BrowserRuntimeError if called outside an extension context.
 */
export function getExtensionStorage(): typeof chrome.storage {
  if (typeof browser !== "undefined" && browser.storage) {
    return browser.storage as unknown as typeof chrome.storage;
  }
  if (typeof chrome !== "undefined" && chrome.storage) {
    return chrome.storage;
  }

  throw new BrowserRuntimeError(
    "WebExtension storage API is not available in the current context.",
    "Extension storage unavailable.",
    ErrorCode.STORAGE_UNAVAILABLE,
  );
}
