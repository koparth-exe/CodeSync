import { describe, expect, it } from "vitest";
import {
  detectBrowser,
  getBrowserCapabilities,
  getExtensionRuntime,
  getExtensionStorage,
} from "../../src/shared/browser";
import { BrowserRuntimeError, ErrorCode } from "../../src/shared/errors";

describe("Browser Compatibility & Abstraction Layer (S12)", () => {
  it("detects runtime environment safely without throwing", () => {
    const browserType = detectBrowser();
    expect(["chrome", "edge", "firefox", "unknown"]).toContain(browserType);
  });

  it("provides structured browser capabilities", () => {
    const caps = getBrowserCapabilities();
    expect(typeof caps.browserType).toBe("string");
    expect(typeof caps.isChromium).toBe("boolean");
    expect(typeof caps.isGecko).toBe("boolean");
    expect(typeof caps.supportsWebLocks).toBe("boolean");
    expect(["service_worker", "event_page"]).toContain(caps.backgroundType);
  });

  it("fails closed with typed BrowserRuntimeError when extension runtime is unavailable", () => {
    expect(() => getExtensionRuntime()).toThrow(BrowserRuntimeError);
    try {
      getExtensionRuntime();
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserRuntimeError);
      expect((e as BrowserRuntimeError).code).toBe(
        ErrorCode.BROWSER_RUNTIME_UNAVAILABLE,
      );
      expect((e as BrowserRuntimeError).failClosed).toBe(true);
    }
  });

  it("fails closed with typed BrowserRuntimeError when storage API is unavailable", () => {
    expect(() => getExtensionStorage()).toThrow(BrowserRuntimeError);
    try {
      getExtensionStorage();
    } catch (e) {
      expect(e).toBeInstanceOf(BrowserRuntimeError);
      expect((e as BrowserRuntimeError).code).toBe(
        ErrorCode.STORAGE_UNAVAILABLE,
      );
      expect((e as BrowserRuntimeError).failClosed).toBe(true);
    }
  });
});
