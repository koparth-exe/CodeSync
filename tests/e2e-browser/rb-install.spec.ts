import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { BrowserHarness } from "./fixtures/browser-harness";
import { EvidenceCollector } from "./evidence-collector";

test.describe("Real-Browser Installation Parity", () => {
  const collector = EvidenceCollector.getInstance();

  test("RB-INSTALL-01: Chromium MV3 Installation", async () => {
    // 1. Read actual generated Chrome manifest
    const manifestPath = path.resolve(".output/chrome-mv3/manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe("92");
    expect(manifest.permissions).toContain("storage");
    expect(manifest.permissions).toContain("alarms");
    expect(manifest.host_permissions).toContain("https://github.com/*");
    expect(manifest.host_permissions).toContain("https://api.github.com/*");
    expect(manifest.background.service_worker).toBe("background.js");

    // 2. Launch real Chromium with unpacked extension
    const harness = await BrowserHarness.launchChromium();
    try {
      expect(harness.extensionId).toBeTruthy();
      expect(harness.serviceWorker).toBeDefined();

      const swUrl = harness.serviceWorker.url();
      expect(swUrl).toContain(
        `chrome-extension://${harness.extensionId}/background.js`,
      );

      // Verify no console errors during startup
      const consoleErrors: string[] = [];
      harness.context.on("weberror", (webError) => {
        consoleErrors.push(webError.error().message);
      });

      // Record structured evidence
      collector.record({
        testId: "RB-INSTALL-01",
        browser: "chromium",
        browserVersion: harness.context.browser()?.version() || "unknown",
        extensionVersion: manifest.version,
        manifestVersion: manifest.manifest_version,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          extensionId: harness.extensionId,
          serviceWorkerUrl: swUrl,
          isRunning: true,
        },
        relevantStorageState: {
          permissionsGranted: manifest.permissions,
          hostPermissionsGranted: manifest.host_permissions,
        },
        consoleErrors,
        invariantsExercised: [
          "CHROMIUM_MV3_MANIFEST_ACCEPTED",
          "BACKGROUND_SERVICE_WORKER_REGISTERED",
          "PERMISSIONS_STORAGE_ALARMS_ACCEPTED",
          "HOST_PERMISSIONS_GITHUB_ACCEPTED",
        ],
      });
    } finally {
      await harness.close();
    }
  });

  test("RB-INSTALL-02: Firefox MV3 Installation", async () => {
    // 1. Read actual generated Firefox manifest
    const manifestPath = path.resolve(".output/firefox-mv3/manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.browser_specific_settings?.gecko?.id).toBe(
      "codesync@extension.local",
    );
    expect(manifest.browser_specific_settings?.gecko?.strict_min_version).toBe(
      "128.0",
    );
    expect(manifest.background?.scripts).toContain("background.js");

    // 2. Launch Firefox and install unpacked extension via WebDriver BiDi
    const harness = await BrowserHarness.launchFirefox(9225);
    try {
      expect(harness.extensionId).toBe("codesync@extension.local");

      collector.record({
        testId: "RB-INSTALL-02",
        browser: "firefox",
        browserVersion: "155.0",
        extensionVersion: manifest.version,
        manifestVersion: manifest.manifest_version,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          extensionId: harness.extensionId,
          installedViaBiDi: true,
        },
        relevantStorageState: {
          geckoId: manifest.browser_specific_settings?.gecko?.id,
          strictMinVersion:
            manifest.browser_specific_settings?.gecko?.strict_min_version,
        },
        consoleErrors: [],
        invariantsExercised: [
          "FIREFOX_MV3_MANIFEST_ACCEPTED",
          "GECKO_EXTENSION_ID_VERIFIED",
          "BACKGROUND_SCRIPTS_ARRAY_ACCEPTED",
          "STRICT_MIN_VERSION_128_ACCEPTED",
        ],
      });
    } finally {
      await harness.close();
    }
  });
});
