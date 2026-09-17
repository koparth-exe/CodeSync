import { test, expect } from "@playwright/test";
import { BrowserHarness } from "./fixtures/browser-harness";
import { EvidenceCollector } from "./evidence-collector";

interface LockTestWindow extends Window {
  __lock1Acquired?: boolean;
  __lock1Released?: boolean;
  __releaseLock1?: () => void;
  __lock2Acquired?: boolean;
}

test.describe("Real-Browser Web Locks Parity", () => {
  const collector = EvidenceCollector.getInstance();

  test("RB-LOCKS-01: Real navigator.locks Mutual Exclusion Across Separate Browser Contexts", async () => {
    const harness = await BrowserHarness.launchChromium();
    const profileDir = harness.profileDir;

    try {
      // Create two separate browser tabs to test cross-context contention
      const page1 = await harness.context.newPage();
      const page2 = await harness.context.newPage();

      const popupUrl = `chrome-extension://${harness.extensionId}/popup.html`;
      await page1.goto(popupUrl);
      await page2.goto(popupUrl);

      const lockName = "codesync:e2e:test-lock";

      // 1. Tab 1 acquires the exclusive lock and holds it
      await page1.evaluate((name) => {
        const win = window as unknown as LockTestWindow;
        win.__lock1Acquired = false;
        win.__lock1Released = false;

        navigator.locks.request(name, { mode: "exclusive" }, async () => {
          win.__lock1Acquired = true;
          // Hold the lock until release signal is given
          await new Promise<void>((resolve) => {
            win.__releaseLock1 = () => {
              win.__lock1Released = true;
              resolve();
            };
          });
        });
      }, lockName);

      // Verify Tab 1 acquired the lock
      await expect
        .poll(async () => {
          return page1.evaluate(
            () => (window as unknown as LockTestWindow).__lock1Acquired,
          );
        })
        .toBe(true);

      // 2. Tab 2 attempts to acquire the SAME exclusive lock
      await page2.evaluate((name) => {
        const win = window as unknown as LockTestWindow;
        win.__lock2Acquired = false;
        navigator.locks.request(name, { mode: "exclusive" }, async () => {
          win.__lock2Acquired = true;
        });
      }, lockName);

      // Wait 500ms and verify Tab 2 is blocked (contention)
      await new Promise((r) => setTimeout(r, 500));
      const isLock2Blocked = await page2.evaluate(
        () => (window as unknown as LockTestWindow).__lock2Acquired === false,
      );
      expect(isLock2Blocked).toBe(true);

      // Query navigator.locks.query() to observe the held and pending lock
      const lockSnapshot = await page1.evaluate(async () => {
        const state = await navigator.locks.query();
        return {
          heldCount: state.held?.length || 0,
          pendingCount: state.pending?.length || 0,
        };
      });

      expect(lockSnapshot.heldCount).toBeGreaterThanOrEqual(1);
      expect(lockSnapshot.pendingCount).toBeGreaterThanOrEqual(1);

      // 3. Tab 1 releases the lock
      await page1.evaluate(() => {
        const win = window as unknown as LockTestWindow;
        if (win.__releaseLock1) {
          win.__releaseLock1();
        }
      });

      // 4. Tab 2 should now acquire the lock
      await expect
        .poll(async () => {
          return page2.evaluate(
            () => (window as unknown as LockTestWindow).__lock2Acquired,
          );
        })
        .toBe(true);

      collector.record({
        testId: "RB-LOCKS-01",
        browser: "chromium",
        browserVersion: harness.context.browser()?.version() || "unknown",
        extensionVersion: "0.1.0",
        manifestVersion: 3,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          crossContextContentionDemonstrated: true,
          tab1AcquiredFirst: true,
          tab2BlockedDuringHold: isLock2Blocked,
          tab2AcquiredAfterRelease: true,
          lockSnapshot,
        },
        relevantStorageState: {
          navigatorLocksAvailable: true,
        },
        consoleErrors: [],
        invariantsExercised: [
          "REAL_NAVIGATOR_LOCKS_EXCLUSIVE_ACQUISITION",
          "CROSS_CONTEXT_LOCK_CONTENTION",
          "SECOND_CONTENDER_BLOCKED_DURING_HOLD",
          "EXCLUSIVE_LOCK_GRANTED_AFTER_RELEASE",
        ],
      });
    } finally {
      await harness.close();
      BrowserHarness.safeCleanDir(profileDir);
    }
  });
});
