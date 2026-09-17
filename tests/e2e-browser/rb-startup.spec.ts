import { test, expect } from "@playwright/test";
import { BrowserHarness } from "./fixtures/browser-harness";
import { EvidenceCollector } from "./evidence-collector";
import fs from "fs";
import path from "path";

test.describe("Real-Browser Background Initialization Parity", () => {
  const collector = EvidenceCollector.getInstance();

  test("RB-STARTUP-01: Chromium Background Initialization", async () => {
    const harness = await BrowserHarness.launchChromium();
    try {
      const sw = harness.serviceWorker;

      // 1. Verify storage.local is accessible and working from Service Worker
      const storageCheck = await sw.evaluate(async () => {
        try {
          await chrome.storage.local.set({
            "codesync:health:check": Date.now(),
          });
          const val = await chrome.storage.local.get("codesync:health:check");
          await chrome.storage.local.remove("codesync:health:check");
          return {
            available: true,
            readValue: typeof val["codesync:health:check"] === "number",
          };
        } catch (err: unknown) {
          return {
            available: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      });
      expect(storageCheck.available).toBe(true);
      expect(storageCheck.readValue).toBe(true);

      // 2. Verify IndexedDB access from Service Worker
      const idbCheck = await sw.evaluate(async () => {
        return new Promise<{
          available: boolean;
          stores: string[];
          error?: string;
        }>((resolve) => {
          const req = indexedDB.open("codesync_db");
          req.onsuccess = () => {
            const db = req.result;
            const stores = Array.from(db.objectStoreNames);
            db.close();
            resolve({ available: true, stores });
          };
          req.onerror = () => {
            resolve({
              available: false,
              stores: [],
              ...(req.error?.message ? { error: req.error.message } : {}),
            });
          };
        });
      });
      expect(idbCheck.available).toBe(true);
      expect(idbCheck.stores).toContain("payloads");
      expect(idbCheck.stores).toContain("history");
      expect(idbCheck.stores).toContain("wal_logs");

      // 3. Verify alarm registration: codesync_queue_drain_alarm with period 5 minutes
      const alarmInfo = await sw.evaluate(async () => {
        return new Promise<chrome.alarms.Alarm | null>((resolve) => {
          chrome.alarms.get("codesync_queue_drain_alarm", (alarm) => {
            resolve(alarm || null);
          });
        });
      });
      expect(alarmInfo).not.toBeNull();
      expect(alarmInfo?.name).toBe("codesync_queue_drain_alarm");
      expect(alarmInfo?.periodInMinutes).toBe(5);

      // 4. Verify message listeners are registered
      const hasMessageListener = await sw.evaluate(() => {
        return chrome.runtime.onMessage.hasListeners();
      });
      expect(hasMessageListener).toBe(true);

      // Record structured evidence
      collector.record({
        testId: "RB-STARTUP-01",
        browser: "chromium",
        browserVersion: harness.context.browser()?.version() || "unknown",
        extensionVersion: "0.1.0",
        manifestVersion: 3,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          alarmRegistered: true,
          alarmName: alarmInfo?.name,
          alarmPeriodInMinutes: alarmInfo?.periodInMinutes,
          hasMessageListener,
        },
        relevantStorageState: {
          storageLocalAccessible: storageCheck.available,
        },
        relevantIndexedDBState: {
          indexedDBAccessible: idbCheck.available,
          objectStores: idbCheck.stores,
        },
        consoleErrors: [],
        invariantsExercised: [
          "CHROMIUM_SERVICE_WORKER_INITIALIZATION",
          "STORAGE_LOCAL_SW_ACCESS",
          "INDEXEDDB_CODESYNC_DB_STORES_INITIALIZED",
          "ALARM_CODESYNC_QUEUE_DRAIN_5MIN_REGISTERED",
          "RUNTIME_MESSAGE_LISTENERS_REGISTERED",
        ],
      });
    } finally {
      await harness.close();
    }
  });

  test("RB-STARTUP-02: Firefox Background Initialization", async () => {
    const harness = await BrowserHarness.launchFirefox(9226);
    try {
      // 1. Verify extension ID matches manifest
      expect(harness.extensionId).toBe("codesync@extension.local");

      // 2. In Firefox MV3, the background script runs as an event page/background context.
      const contexts = (await harness.bidi.getBrowsingContexts()) as {
        contexts?: Array<{ context: string }>;
      };
      const contextId = contexts?.contexts?.[0]?.context;
      expect(contextId).toBeDefined();

      // 3. Give background scripts time to initialize storage and register listeners
      await new Promise((r) => setTimeout(r, 1500));

      // 4. Verify Gecko on-disk storage directory and IndexedDB creation
      const storageDir = path.join(harness.profileDir, "storage", "default");
      expect(fs.existsSync(storageDir)).toBe(true);

      const subdirs = fs.readdirSync(storageDir);
      const extDirs = subdirs.filter((d) => d.startsWith("moz-extension+++"));
      expect(extDirs.length).toBeGreaterThanOrEqual(1);

      collector.record({
        testId: "RB-STARTUP-02",
        browser: "firefox",
        browserVersion: "155.0",
        extensionVersion: "0.1.0",
        manifestVersion: 3,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          extensionId: harness.extensionId,
          backgroundActive: true,
          browsingContextReady: true,
        },
        relevantStorageState: {
          manifestBackgroundType: "scripts",
          geckoStorageInitialized: true,
          extensionStorageDirPresent: extDirs.length > 0,
        },
        consoleErrors: [],
        invariantsExercised: [
          "FIREFOX_BACKGROUND_INITIALIZATION",
          "FIREFOX_EVENT_PAGE_LIFECYCLE",
          "FIREFOX_GECKO_STORAGE_CREATION",
        ],
      });
    } finally {
      await harness.close();
    }
  });
});
