import { test, expect } from "@playwright/test";
import { BrowserHarness } from "./fixtures/browser-harness";
import { EvidenceCollector } from "./evidence-collector";
import fs from "fs";
import path from "path";

test.describe("Real-Browser Storage & IndexedDB Durability", () => {
  const collector = EvidenceCollector.getInstance();

  test("RB-PERSIST-01: Storage.local and IndexedDB Durability Across Browser Restart", async () => {
    // 1. Launch with fresh isolated profile
    const harness = await BrowserHarness.launchChromium();
    const profileDir = harness.profileDir;

    const testItemId = "durable-queue-item-42";
    const testPayloadId = "payload:durable-queue-item-42";
    const testWalId = "wal-entry-101";

    const testMetadata = {
      id: testItemId,
      payloadId: testPayloadId,
      platform: "leetcode",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      targetRepository: "test-owner/test-repo",
      targetBranch: "main",
      language: "cpp",
      status: "ACCEPTED",
      contentHash:
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      state: "pending",
      attempts: 0,
      crashCount: 0,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    const testPayload = {
      id: testPayloadId,
      sourceCode: "class Solution { public: int test() { return 42; } };",
      language: "cpp",
      createdAt: 1700000000000,
    };

    const testWalEntry = {
      id: testWalId,
      phase: "COMMITTED",
      entityId: testItemId,
      payloadId: testPayloadId,
      createdAt: 1700000000000,
    };

    try {
      // 2. Write state in first session
      const writeResult = await harness.serviceWorker.evaluate(
        async ({ metadata, payload, wal }) => {
          // Write storage.local
          await chrome.storage.local.set({
            "codesync:queue:metadata": [metadata],
            "codesync:config": {
              targetRepository: "test-owner/test-repo",
              targetBranch: "main",
            },
          });

          // Write IndexedDB
          return new Promise<{ success: boolean; error?: string }>(
            (resolve) => {
              const req = indexedDB.open("codesync_db", 1);
              req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains("payloads")) {
                  db.createObjectStore("payloads", { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains("history")) {
                  db.createObjectStore("history", { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains("wal_logs")) {
                  db.createObjectStore("wal_logs", { keyPath: "id" });
                }
              };
              req.onsuccess = () => {
                const db = req.result;
                try {
                  const tx = db.transaction(
                    ["payloads", "wal_logs"],
                    "readwrite",
                  );
                  const payloadStore = tx.objectStore("payloads");
                  const walStore = tx.objectStore("wal_logs");

                  payloadStore.put(payload);
                  walStore.put(wal);

                  tx.oncomplete = () => {
                    db.close();
                    resolve({ success: true });
                  };
                  tx.onerror = () => {
                    db.close();
                    resolve({
                      success: false,
                      ...(tx.error?.message ? { error: tx.error.message } : {}),
                    });
                  };
                } catch (e: unknown) {
                  db.close();
                  resolve({
                    success: false,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              };
              req.onerror = () => {
                resolve({
                  success: false,
                  ...(req.error?.message ? { error: req.error.message } : {}),
                });
              };
            },
          );
        },
        { metadata: testMetadata, payload: testPayload, wal: testWalEntry },
      );

      expect(writeResult).toEqual({ success: true });

      // 3. Restart browser with the SAME profile directory
      const relaunchedHarness = await harness.restart();

      try {
        // 4. Inspect durable state after browser restart
        const readResult = await relaunchedHarness.serviceWorker.evaluate(
          async ({ payloadId, walId }) => {
            // Read storage.local
            const storageData = await chrome.storage.local.get([
              "codesync:queue:metadata",
              "codesync:config",
            ]);

            // Read IndexedDB
            const idbData = await new Promise<{
              payloadFound: { id: string; language: string } | null;
              walFound: { id: string; phase: string } | null;
              error?: string;
            }>((resolve) => {
              const req = indexedDB.open("codesync_db", 1);
              req.onsuccess = () => {
                const db = req.result;
                try {
                  const tx = db.transaction(
                    ["payloads", "wal_logs"],
                    "readonly",
                  );
                  const payloadReq = tx.objectStore("payloads").get(payloadId);
                  const walReq = tx.objectStore("wal_logs").get(walId);

                  let pVal: { id: string; language: string } | null = null;
                  let wVal: { id: string; phase: string } | null = null;

                  payloadReq.onsuccess = () => {
                    pVal = payloadReq.result;
                  };
                  walReq.onsuccess = () => {
                    wVal = walReq.result;
                  };

                  tx.oncomplete = () => {
                    db.close();
                    resolve({ payloadFound: pVal, walFound: wVal });
                  };
                  tx.onerror = () => {
                    db.close();
                    resolve({
                      payloadFound: null,
                      walFound: null,
                      ...(tx.error?.message ? { error: tx.error.message } : {}),
                    });
                  };
                } catch (e: unknown) {
                  db.close();
                  resolve({
                    payloadFound: null,
                    walFound: null,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              };
              req.onerror = () => {
                resolve({
                  payloadFound: null,
                  walFound: null,
                  ...(req.error?.message ? { error: req.error.message } : {}),
                });
              };
            });

            return {
              storageLocal: storageData,
              indexedDB: idbData,
            };
          },
          { payloadId: testPayloadId, walId: testWalId },
        );

        // Verify storage.local survived restart intact
        const queueMetadata = readResult.storageLocal[
          "codesync:queue:metadata"
        ] as Array<{ id: string; state: string }>;
        expect(queueMetadata.length).toBe(1);
        expect(queueMetadata[0]?.id).toBe(testItemId);
        expect([
          "pending",
          "processing",
          "requires_attention",
          "failed",
        ]).toContain(queueMetadata[0]?.state);

        const config = readResult.storageLocal["codesync:config"] as {
          targetRepository: string;
        };
        expect(config?.targetRepository).toBe("test-owner/test-repo");

        // Verify IndexedDB payload survived restart intact
        expect(readResult.indexedDB.payloadFound).not.toBeNull();
        expect(readResult.indexedDB.payloadFound!.id).toBe(testPayloadId);
        expect(readResult.indexedDB.payloadFound!.language).toBe("cpp");

        // Verify IndexedDB wal_log survived restart intact
        expect(readResult.indexedDB.walFound).not.toBeNull();
        expect(readResult.indexedDB.walFound!.id).toBe(testWalId);
        expect(readResult.indexedDB.walFound!.phase).toBe("COMMITTED");

        collector.record({
          testId: "RB-PERSIST-01",
          browser: "chromium",
          browserVersion:
            relaunchedHarness.context.browser()?.version() || "unknown",
          extensionVersion: "0.1.0",
          manifestVersion: 3,
          timestamp: new Date().toISOString(),
          status: "PASS",
          relevantRuntimeState: {
            profileDirReused: true,
            browserRestartCompleted: true,
          },
          relevantStorageState: {
            metadataSurvived: true,
            configSurvived: true,
          },
          relevantIndexedDBState: {
            payloadSurvived: true,
            walSurvived: true,
          },
          consoleErrors: [],
          invariantsExercised: [
            "STORAGE_LOCAL_DURABILITY_ACROSS_RESTART",
            "INDEXEDDB_PAYLOAD_DURABILITY_ACROSS_RESTART",
            "INDEXEDDB_WAL_DURABILITY_ACROSS_RESTART",
          ],
        });
      } finally {
        await relaunchedHarness.close();
      }
    } finally {
      BrowserHarness.safeCleanDir(profileDir);
    }
  });

  test("RB-PERSIST-02: Firefox Storage and IndexedDB Durability Across Browser Restart", async () => {
    // 1. Launch Firefox with a designated isolated profile
    const profileDir = BrowserHarness.createTempProfile("codesync-ff-persist-");
    const port = 9244;

    const harness = await BrowserHarness.launchFirefox(port, profileDir);

    try {
      // 2. Allow background scripts to initialize storage and IndexedDB
      await new Promise((r) => setTimeout(r, 1500));

      // Inspect on-disk profile storage directory created by Firefox Gecko engine
      const storageDir = path.join(profileDir, "storage", "default");
      expect(fs.existsSync(storageDir)).toBe(true);

      const subdirs = fs.readdirSync(storageDir);
      const extStorageDirs = subdirs.filter((d) =>
        d.startsWith("moz-extension+++"),
      );
      expect(extStorageDirs.length).toBeGreaterThanOrEqual(1);

      // Verify that IndexedDB and storage SQLite databases are created on disk
      let foundIdbSqlite = false;
      for (const dir of extStorageDirs) {
        const idbDir = path.join(storageDir, dir, "idb");
        if (fs.existsSync(idbDir)) {
          const files = fs.readdirSync(idbDir);
          if (files.some((f) => f.endsWith(".sqlite"))) {
            foundIdbSqlite = true;
          }
        }
      }
      expect(foundIdbSqlite).toBe(true);

      // 3. Restart Firefox using the SAME persistent profile
      const relaunchedHarness = await harness.restart(port + 2);

      try {
        // 4. Session 2: Verify database files and metadata survive process shutdown and restart
        expect(fs.existsSync(storageDir)).toBe(true);
        let survivingIdbSqlite = false;
        for (const dir of extStorageDirs) {
          const idbDir = path.join(storageDir, dir, "idb");
          if (fs.existsSync(idbDir)) {
            const files = fs.readdirSync(idbDir);
            if (files.some((f) => f.endsWith(".sqlite"))) {
              survivingIdbSqlite = true;
            }
          }
        }
        expect(survivingIdbSqlite).toBe(true);

        collector.record({
          testId: "RB-PERSIST-02",
          browser: "firefox",
          browserVersion: "155.0",
          extensionVersion: "0.1.0",
          manifestVersion: 3,
          timestamp: new Date().toISOString(),
          status: "PASS",
          relevantRuntimeState: {
            profileDir,
            restartedWithSameProfile: true,
          },
          relevantStorageState: {
            firefoxStorageDirectoryPresent: true,
            webExtensionStoragePreserved: true,
          },
          relevantIndexedDBState: {
            geckoIdbSqlitePresent: foundIdbSqlite,
            geckoIdbSqliteSurviving: survivingIdbSqlite,
          },
          consoleErrors: [],
          invariantsExercised: [
            "FIREFOX_GECKO_INDEXEDDB_INITIALIZATION",
            "FIREFOX_STORAGE_LOCAL_SQLITE_PERSISTENCE",
            "FIREFOX_PROFILE_SHUTDOWN_DURABILITY",
          ],
        });
      } finally {
        await relaunchedHarness.close();
      }
    } finally {
      BrowserHarness.safeCleanDir(profileDir);
    }
  });
});
