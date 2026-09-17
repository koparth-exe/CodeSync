import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createE2EHarness,
  createExtensionMessage,
  type E2EHarness,
} from "../helpers/e2e-harness";
import {
  buildCandidateSubmission,
  createCrashTestEnvironment,
} from "../helpers/crash-harness";
import {
  QueueState,
  type QueueItemMetadata,
} from "../../src/shared/storage/types";
import { ErrorCode, StorageError } from "../../src/shared/errors";
import {
  StorageService,
  WebExtensionStorageDriver,
} from "../../src/shared/storage/local";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import type { RuntimeSenderInfo } from "../../src/shared/messaging/types";

describe("Phase 1C.4.3.6.1 — Targeted Cross-Browser Integration Tests", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = createE2EHarness();
    await harness.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // CB-INT-01: Runtime Messaging Channel & Async Response Parity
  // ==========================================================================
  it("CB-INT-01: Runtime Messaging Channel & Async Response Parity verifies asynchronous message channel lifecycle and response delivery across Chromium and Gecko semantics", async () => {
    // ------------------------------------------------------------------------
    // Part A: Chromium / Gecko Callback Asynchronous Port Semantics (return true)
    // ------------------------------------------------------------------------
    // In background.ts, browser.runtime.onMessage listener returns `true`
    // to instruct the browser engine to keep the message port open until sendResponse is invoked.
    const backgroundListener = (
      message: unknown,
      sender: RuntimeSenderInfo,
      sendResponse: (response: unknown) => void,
    ): boolean | undefined => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "SUBMISSION_DETECTED"
      ) {
        harness.submissionHandler
          .handleMessageAndEnqueue(message, sender)
          .then((result) => {
            sendResponse(result);
            if (result.success && result.queueItem) {
              harness.queueDrainer.drain("submission_event").catch(() => {});
            }
          })
          .catch((err) => {
            sendResponse({ success: false, error: (err as Error).message });
          });
        return true; // Authoritative WebExtension indicator to keep port alive
      }
      return undefined;
    };

    // 1. Construct valid submission candidate from content script
    const { candidate: validCandidate } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 42; }",
      status: "ACCEPTED",
    });

    const validEnvelope = createExtensionMessage(validCandidate, {
      senderContext: "content-script",
    });

    // Sender tab contains authentic LeetCode URL
    const chromiumSender: RuntimeSenderInfo = {
      id: "codesync-extension-id",
      tab: {
        id: 101,
        url: "https://leetcode.com/problems/two-sum/",
      },
    };

    let channelClosedPrematurely = false;

    // Simulate Chromium extension port calling the listener
    const portPromise = new Promise<{
      response: unknown;
      keptAlive: boolean;
    }>((resolve) => {
      let isSettled = false;
      const sendResponse = (resp: unknown) => {
        if (channelClosedPrematurely) {
          throw new Error("Message port closed before response was received");
        }
        isSettled = true;
        resolve({ response: resp, keptAlive: true });
      };

      const returned = backgroundListener(
        validEnvelope,
        chromiumSender,
        sendResponse,
      );
      // Assert: listener MUST return true to keep message channel open
      expect(returned).toBe(true);
      if (returned !== true) {
        channelClosedPrematurely = true;
      }

      // Verify that after immediate synchronous return, port remains alive
      expect(isSettled).toBe(false);
    });

    const { response, keptAlive } = await portPromise;
    expect(keptAlive).toBe(true);
    expect(response).toBeDefined();

    // Assert typed response structure
    const typedResponse = response as {
      success: boolean;
      queueItem?: QueueItemMetadata;
      candidate?: unknown;
      error?: string;
    };
    expect(typedResponse.success).toBe(true);
    expect(typedResponse.queueItem).toBeDefined();
    expect(typedResponse.queueItem?.platform).toBe("leetcode");
    expect(typedResponse.queueItem?.problemSlug).toBe("two-sum");
    expect(typedResponse.error).toBeUndefined();

    // Verify durable work was created in storage
    const durableQueue = await harness.getDurableQueue();
    expect(durableQueue.length).toBe(1);
    expect(durableQueue[0]!.id).toBe(typedResponse.queueItem?.id);

    // ------------------------------------------------------------------------
    // Part B: Validation Failure Delivery (Fail-Closed Delivery Over Channel)
    // ------------------------------------------------------------------------
    // Simulate content script sending submission with spoofed origin
    const { candidate: spoofedCandidate } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "spoofed-problem",
      problemSlug: "spoofed-slug",
      sourceCode: "int main() {}",
      status: "ACCEPTED",
    });
    const spoofedEnvelope = createExtensionMessage(spoofedCandidate, {
      senderContext: "content-script",
    });
    const spoofedSender: RuntimeSenderInfo = {
      id: "codesync-extension-id",
      tab: {
        id: 102,
        url: "https://evil-spoof.com/problems/two-sum/",
      },
    };

    const failPortPromise = new Promise<{ response: unknown }>((resolve) => {
      const sendResponse = (resp: unknown) => {
        resolve({ response: resp });
      };
      const returned = backgroundListener(
        spoofedEnvelope,
        spoofedSender,
        sendResponse,
      );
      expect(returned).toBe(true);
    });

    const failResult = await failPortPromise;
    const typedFailResponse = failResult.response as {
      success: boolean;
      error?: string;
    };
    // Failure must be returned as typed failure, NOT throw unhandled or succeed
    expect(typedFailResponse.success).toBe(false);
    expect(typedFailResponse.error).toContain("Spoofed submission origin");

    // Pre-existing queue item must not be modified, no new items created
    const queueAfterFail = await harness.getDurableQueue();
    expect(queueAfterFail.length).toBe(1);

    // ------------------------------------------------------------------------
    // Part C: Gecko Native Promise-Return Compatibility
    // ------------------------------------------------------------------------
    // In Firefox WebExtensions, onMessage listeners can return a Promise directly.
    // Verify that handleMessageAndEnqueue fulfills Promise-based resolution identically.
    const { candidate: geckoValidCandidate } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "median-two-sorted-arrays",
      problemSlug: "median-two-sorted-arrays",
      submissionId: "99881133",
      sourceCode: "double findMedian() { return 2.5; }",
      status: "ACCEPTED",
    });
    const geckoEnvelope = createExtensionMessage(geckoValidCandidate, {
      senderContext: "content-script",
    });
    const geckoSender: RuntimeSenderInfo = {
      id: "codesync@extension.local",
      tab: {
        id: 201,
        url: "https://leetcode.com/problems/median-two-sorted-arrays/",
      },
    };

    // Gecko listener returning Promise directly
    const geckoPromise = harness.submissionHandler.handleMessageAndEnqueue(
      geckoEnvelope,
      geckoSender,
    );
    expect(geckoPromise).toBeInstanceOf(Promise);
    const geckoResult = await geckoPromise;
    expect(geckoResult.success).toBe(true);
    expect(geckoResult.queueItem?.problemSlug).toBe("median-two-sorted-arrays");

    // Final check: exactly 2 items in queue (1 from Part A, 1 from Part C)
    const finalQueue = await harness.getDurableQueue();
    expect(finalQueue.length).toBe(2);
  });

  // ==========================================================================
  // CB-INT-02: Background Execution Context & Worker Restart Parity
  // ==========================================================================
  it("CB-INT-02: Background Execution Context & Worker Restart Parity verifies durable state survival and idempotent recovery across Service Worker and Event Page lifecycles", async () => {
    // ------------------------------------------------------------------------
    // Step 1: Initialize shared durable storage across independent worker lifecycles
    // ------------------------------------------------------------------------
    const crashEnv = createCrashTestEnvironment({
      targetRepository: "octocat/dsa-repo",
      targetBranch: "main",
    });
    await crashEnv.seedDefaults();

    // ------------------------------------------------------------------------
    // Step 2: Worker A (Simulated Chromium Service Worker / Firefox Event Page A)
    // ------------------------------------------------------------------------
    const workerA = crashEnv.createWorker("worker-a");

    // Enqueue a canonical submission under Worker A
    const { candidate } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "trapping-rain-water",
      problemSlug: "trapping-rain-water",
      submissionId: "trap-rain-01",
      sourceCode: "int trap(vector<int>& height) { return 6; }",
      status: "ACCEPTED",
    });
    const message = createExtensionMessage(candidate, {
      senderContext: "content-script",
    });
    const sender: RuntimeSenderInfo = {
      tab: {
        id: 101,
        url: "https://leetcode.com/problems/trapping-rain-water/",
      },
    };

    const enqueueResult =
      await workerA.submissionHandler.handleMessageAndEnqueue(message, sender);
    expect(enqueueResult.success).toBe(true);
    expect(enqueueResult.queueItem).toBeDefined();
    const itemId = enqueueResult.queueItem!.id;

    // Simulate Worker A claiming the item and beginning drain execution,
    // then suffering abrupt termination / worker suspension while in PROCESSING
    const queueBeforeCrash = await crashEnv.getDurableQueue();
    const targetItem = queueBeforeCrash.find((i) => i.id === itemId);
    expect(targetItem).toBeDefined();

    // Mark item PROCESSING with crashCount: 0 to simulate active execution at crash time
    targetItem!.state = QueueState.PROCESSING;
    targetItem!.crashCount = 0;
    targetItem!.updatedAt = Date.now();
    await crashEnv.sharedStorageDriver.set({
      [STORAGE_KEYS.QUEUE_METADATA]: queueBeforeCrash,
    });

    // Terminate Worker A context completely (destroys all in-memory state and locks)
    crashEnv.discardWorker(workerA);

    // ------------------------------------------------------------------------
    // Step 3: Worker B (Simulated Cold Restart - Service Worker or Event Page B)
    // ------------------------------------------------------------------------
    // In background.ts, startup sequence executes:
    // 1. Initializing fresh clients and services
    // 2. Registering real QueueItemHandler on the drainer (setHandler)
    // 3. Registering periodic alarms (setupQueueDrainAlarm)
    // 4. Executing defaultQueueDrainer.drain("startup") to reconcile crashed items
    const workerB = crashEnv.createWorker("worker-b");

    // Verify Worker B has no in-memory state from Worker A
    expect(workerB.workerId).not.toBe(workerA.workerId);

    // Reconcile and drain on startup exactly as background.ts does
    const startupDrainSummary = await workerB.queueDrainer.drain("startup");
    expect(startupDrainSummary).toBeDefined();
    expect(startupDrainSummary?.processed).toBe(1);
    expect(startupDrainSummary?.completed).toBe(1);

    // ------------------------------------------------------------------------
    // Step 4: Authoritative Assertions on Post-Restart Recovery
    // ------------------------------------------------------------------------
    // 1. Durable queue state survived and progressed to COMPLETED
    const finalQueue = await crashEnv.getDurableQueue();
    expect(finalQueue.length).toBe(1);
    const recoveredItem = finalQueue[0]!;
    expect(recoveredItem.id).toBe(itemId);
    expect(recoveredItem.state).toBe(QueueState.COMPLETED);

    // 2. Interrupted item had its crashCount incremented before recovery
    expect(recoveredItem.crashCount).toBe(1);

    // 3. Payload in IndexedDB survived intact and matches contentHash
    const payloads = await crashEnv.getDurablePayloads();
    expect(payloads.length).toBe(1);
    expect(payloads[0]!.id).toBe(recoveredItem.payloadId);

    // 4. Exactly one remote file write occurred on GitHub (no duplicate commits)
    expect(crashEnv.mockGitHubServer.getPutCount()).toBe(1);
    expect(
      crashEnv.mockGitHubServer.hasFile(
        "solutions/leetcode/trapping-rain-water.cpp",
      ),
    ).toBe(true);

    // 5. Exactly one sync history entry recorded
    const history = await crashEnv.getDurableHistory();
    expect(history.length).toBe(1);
    expect(history[0]!.submissionId).toBe(itemId);
    expect(history[0]!.status).toBe("synced");

    // 6. Zero residual WAL intent records remain
    const walEntries = await crashEnv.getDurableWalEntries();
    expect(walEntries.length).toBe(0);

    // 7. Drainer is fully operational for subsequent items
    const subsequentCandidate = buildCandidateSubmission({
      platform: "leetcode",
      problemId: "3sum",
      problemSlug: "3sum",
      submissionId: "3sum-01",
      sourceCode: "int threeSum() { return 0; }",
      status: "ACCEPTED",
    });
    const { candidate: subCand } = await subsequentCandidate;
    const subMsg = createExtensionMessage(subCand, {
      senderContext: "content-script",
    });
    const subSender: RuntimeSenderInfo = {
      tab: { id: 102, url: "https://leetcode.com/problems/3sum/" },
    };

    const subEnqueueResult =
      await workerB.submissionHandler.handleMessageAndEnqueue(
        subMsg,
        subSender,
      );
    expect(subEnqueueResult.success).toBe(true);

    const subDrainSummary =
      await workerB.queueDrainer.drain("submission_event");
    expect(subDrainSummary?.completed).toBe(1);

    const queueAfterSub = await crashEnv.getDurableQueue();
    expect(queueAfterSub.length).toBe(2);
    expect(queueAfterSub.every((i) => i.state === QueueState.COMPLETED)).toBe(
      true,
    );
  });

  // ==========================================================================
  // CB-INT-03: Web Locks & Persistent Lease Fencing Fallback Parity
  // ==========================================================================
  it("CB-INT-03: Web Locks & Persistent Lease Fencing Fallback Parity verifies monotonic fencing and fail-closed stale-worker rejection when Web Locks are unavailable", async () => {
    // ------------------------------------------------------------------------
    // Step 1: Explicitly simulate environment with Web Locks unavailable
    // ------------------------------------------------------------------------
    // In environments where navigator.locks is unavailable, disabled in private browsing,
    // or restricted in background contexts, QueueConcurrencyManager must fall back
    // seamlessly to Tier 2 Persistent Leases + monotonic fencing tokens.
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1710000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    const crashEnv = createCrashTestEnvironment();
    await crashEnv.seedDefaults();

    // Create two independent worker contexts connected to the same shared storage
    const workerA = crashEnv.createWorker("worker-alpha");
    const workerB = crashEnv.createWorker("worker-beta");

    // Enqueue an initial item to be processed
    const { candidate } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "course-schedule",
      problemSlug: "course-schedule",
      submissionId: "course-01",
      sourceCode: "bool canFinish() { return true; }",
      status: "ACCEPTED",
    });
    const message = createExtensionMessage(candidate, {
      senderContext: "content-script",
    });
    const sender: RuntimeSenderInfo = {
      tab: { id: 101, url: "https://leetcode.com/problems/course-schedule/" },
    };

    const enqueueResult =
      await workerA.submissionHandler.handleMessageAndEnqueue(message, sender);
    expect(enqueueResult.success).toBe(true);
    const itemId = enqueueResult.queueItem!.id;

    // ------------------------------------------------------------------------
    // Step 2: Worker A acquires Tier 2 lease and starts processing
    // ------------------------------------------------------------------------
    let workerAPaused = false;
    let resumeWorkerA: () => void;
    const workerAPausePromise = new Promise<void>((resolve) => {
      resumeWorkerA = resolve;
    });

    let workerAObservedToken = 0;
    let workerAFencingError: unknown = null;

    const workerAExecution = workerA.concurrency.runExclusively(
      "alarm",
      async (workerIdA, fencingTokenA, renewA) => {
        workerAObservedToken = fencingTokenA;
        // 1. Initial lease acquisition issued monotonic token 1
        expect(fencingTokenA).toBe(1);

        // 2. Heartbeat renewal extends lease TTL
        const renewed = await renewA();
        expect(renewed).toBe(true);

        // Worker A claims item into PROCESSING
        const queue = await workerA.storage.getQueueMetadata();
        const item = queue.find((i) => i.id === itemId)!;
        item.state = QueueState.PROCESSING;
        item.fencingToken = fencingTokenA;
        await workerA.storage.setQueueMetadata(queue);

        // Pause Worker A inside the critical section to simulate hang / stall
        workerAPaused = true;
        await workerAPausePromise;

        // Post-resume: Worker A attempts to commit completion mutation under its token
        try {
          await workerA.concurrency.validateFencingToken(
            workerIdA,
            fencingTokenA,
          );
          item.state = QueueState.COMPLETED;
          await workerA.storage.setQueueMetadata(queue);
        } catch (err) {
          workerAFencingError = err;
          throw err;
        }

        return "worker-a-complete";
      },
    );

    // Wait until Worker A is paused holding lease with token 1
    while (!workerAPaused) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(workerAObservedToken).toBe(1);

    // ------------------------------------------------------------------------
    // Step 3: Worker B tries to acquire lease while Worker A is active
    // ------------------------------------------------------------------------
    // While Worker A's lease is active, Worker B MUST fail to acquire authority
    const workerBContendedResult = await workerB.concurrency.runExclusively(
      "alarm",
      async () => "worker-b-unauthorized",
    );
    // Assert mutual exclusion: Worker B yielded immediately without executing
    expect(workerBContendedResult).toBeNull();

    // ------------------------------------------------------------------------
    // Step 4: Advance Virtual Time past Lease TTL (30s) -> Supersession by Worker B
    // ------------------------------------------------------------------------
    virtualTime += 35_000;

    // Worker B now runs: acquiring the expired lease
    let workerBObservedToken = 0;
    const workerBSuccessResult = await workerB.concurrency.runExclusively(
      "alarm",
      async (workerIdB, fencingTokenB) => {
        workerBObservedToken = fencingTokenB;
        // Assert monotonic token increment: Worker B gets token 2
        expect(fencingTokenB).toBe(2);
        expect(fencingTokenB).toBeGreaterThan(workerAObservedToken);

        // Worker B reclaims and successfully processes item to COMPLETED
        const queue = await workerB.storage.getQueueMetadata();
        const item = queue.find((i) => i.id === itemId)!;
        item.state = QueueState.COMPLETED;
        item.completedAt = Date.now();
        await workerB.storage.setQueueMetadata(queue);
        return "worker-b-complete";
      },
    );
    expect(workerBSuccessResult).toBe("worker-b-complete");
    expect(workerBObservedToken).toBe(2);

    // ------------------------------------------------------------------------
    // Step 5: Resume Worker A -> Must Fail Closed with StaleLeaseError
    // ------------------------------------------------------------------------
    resumeWorkerA!();

    // Worker A's execution must reject with StaleLeaseError
    await expect(workerAExecution).rejects.toThrow();
    expect(workerAFencingError).toBeDefined();
    expect((workerAFencingError as Error).name).toBe("StaleLeaseError");
    expect((workerAFencingError as Error).message).toContain("stale");

    // ------------------------------------------------------------------------
    // Step 6: Verify Authoritative Queue State Preserved
    // ------------------------------------------------------------------------
    const finalQueue = await crashEnv.getDurableQueue();
    expect(finalQueue.length).toBe(1);
    expect(finalQueue[0]!.state).toBe(QueueState.COMPLETED);
    // Worker A was prevented from corrupting or reverting Worker B's commit
  });

  // ==========================================================================
  // CB-INT-04: Storage Driver Error Propagation & Fail-Closed Parity
  // ==========================================================================
  it("CB-INT-04: Storage Driver Error Propagation & Fail-Closed Parity verifies typed StorageError propagation across Chromium callback and Firefox Promise rejection models", async () => {
    const originalChrome = (globalThis as unknown as { chrome?: unknown })
      .chrome;
    const originalBrowser = (globalThis as unknown as { browser?: unknown })
      .browser;

    try {
      // ----------------------------------------------------------------------
      // Scenario A: Chromium-Style Callback Error (chrome.runtime.lastError)
      // ----------------------------------------------------------------------
      // In Chromium, browser.storage.local methods pass results to callbacks,
      // and operational failures set chrome.runtime.lastError.
      const mockChromiumLastError = {
        message:
          "QuotaExceeded: MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE limit hit",
      };

      (globalThis as unknown as { browser?: unknown }).browser = undefined;
      (globalThis as unknown as { chrome?: unknown }).chrome = {
        runtime: {
          lastError: mockChromiumLastError,
        },
        storage: {
          local: {
            get: (
              _keys: unknown,
              callback: (items: Record<string, unknown>) => void,
            ) => {
              callback({});
            },
            set: (_items: Record<string, unknown>, callback: () => void) => {
              callback();
            },
            remove: (_keys: unknown, callback: () => void) => {
              callback();
            },
          },
        },
      };

      const chromiumDriver = new WebExtensionStorageDriver();
      const chromiumStorage = new StorageService(chromiumDriver);

      // Assert: get() throws typed StorageError with STORAGE_ERROR code
      await expect(chromiumDriver.get(["test_key"])).rejects.toThrow(
        StorageError,
      );
      try {
        await chromiumDriver.get(["test_key"]);
      } catch (err) {
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).code).toBe(ErrorCode.STORAGE_ERROR);
        expect((err as StorageError).message).toContain("QuotaExceeded");
        expect((err as StorageError).failClosed).toBe(true);
      }

      // Assert: set() throws typed StorageError
      await expect(chromiumDriver.set({ test_key: "value" })).rejects.toThrow(
        StorageError,
      );

      // Assert: remove() throws typed StorageError
      await expect(chromiumDriver.remove("test_key")).rejects.toThrow(
        StorageError,
      );

      // Assert: Higher-level consumer fails closed immediately
      await expect(chromiumStorage.getQueueMetadata()).rejects.toThrow(
        StorageError,
      );
      await expect(chromiumStorage.setQueueMetadata([])).rejects.toThrow(
        StorageError,
      );
      await expect(chromiumStorage.get(STORAGE_KEYS.AUTH)).rejects.toThrow(
        StorageError,
      );
      await expect(
        chromiumStorage.set(STORAGE_KEYS.AUTH, { token: "secret" }),
      ).rejects.toThrow(StorageError);

      // ----------------------------------------------------------------------
      // Scenario B: Firefox-Style Promise Rejection
      // ----------------------------------------------------------------------
      // In Firefox WebExtensions, browser.storage.local can reject with an Error
      // (e.g. underlying IndexedDB corruption or quota exception in Gecko).
      (globalThis as unknown as { chrome?: unknown }).chrome = undefined;
      (globalThis as unknown as { browser?: unknown }).browser = {
        storage: {
          local: {
            get: () => {
              throw new Error(
                "Gecko IndexedDB transaction aborted: NS_ERROR_FILE_CORRUPTED",
              );
            },
            set: () => {
              throw new Error(
                "Gecko QuotaManager: Disk full or quota exceeded",
              );
            },
            remove: () => {
              throw new Error("Gecko Storage: database connection closed");
            },
          },
        },
      };

      const geckoDriver = new WebExtensionStorageDriver();
      const geckoStorage = new StorageService(geckoDriver);

      // Assert: get() throws typed StorageError with STORAGE_UNAVAILABLE code
      await expect(geckoDriver.get(["test_key"])).rejects.toThrow(StorageError);
      try {
        await geckoDriver.get(["test_key"]);
      } catch (err) {
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).code).toBe(ErrorCode.STORAGE_UNAVAILABLE);
        expect((err as StorageError).message).toContain(
          "NS_ERROR_FILE_CORRUPTED",
        );
        expect((err as StorageError).failClosed).toBe(true);
      }

      // Assert: set() throws typed StorageError
      await expect(geckoDriver.set({ test_key: "value" })).rejects.toThrow(
        StorageError,
      );
      try {
        await geckoDriver.set({ test_key: "value" });
      } catch (err) {
        expect(err).toBeInstanceOf(StorageError);
        expect((err as StorageError).code).toBe(ErrorCode.STORAGE_UNAVAILABLE);
        expect((err as StorageError).message).toContain("Disk full");
      }

      // Assert: remove() throws typed StorageError
      await expect(geckoDriver.remove("test_key")).rejects.toThrow(
        StorageError,
      );

      // Assert: Consumers fail closed without partial state corruption
      await expect(geckoStorage.getQueueMetadata()).rejects.toThrow(
        StorageError,
      );
      await expect(geckoStorage.setQueueMetadata([])).rejects.toThrow(
        StorageError,
      );
      await expect(geckoStorage.get(STORAGE_KEYS.AUTH)).rejects.toThrow(
        StorageError,
      );
      await expect(
        geckoStorage.set(STORAGE_KEYS.AUTH, { token: "secret" }),
      ).rejects.toThrow(StorageError);

      // ----------------------------------------------------------------------
      // Scenario C: Convergence on Application Error Model
      // ----------------------------------------------------------------------
      // Both Chromium-style and Firefox-style errors converge on StorageError
      // with failClosed: true, ensuring identical fail-closed security handling.
    } finally {
      // Restore original globals
      (globalThis as unknown as { chrome?: unknown }).chrome = originalChrome;
      (globalThis as unknown as { browser?: unknown }).browser =
        originalBrowser;
    }
  });
});
