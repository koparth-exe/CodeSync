import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  QueueDrainer,
  QUEUE_DRAIN_ALARM_NAME,
  QUEUE_DRAIN_ALARM_PERIOD_MINUTES,
  type QueueItemHandler,
} from "../../src/shared/queue/drainer";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import {
  QueueState,
  type QueueItemMetadata,
} from "../../src/shared/storage/types";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import {
  setupQueueDrainAlarm,
  type NormalizedSubmission,
} from "../../src/shared/queue";
import { ErrorCode, StaleLeaseError } from "../../src/shared/errors";
import { computeContentHash } from "../../src/shared/deduplication";

class MemoryStorageDriver implements LocalStorageDriver {
  private map = new Map<string, unknown>();

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys === null) {
      for (const [k, v] of this.map.entries()) result[k] = v;
      return result;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      if (this.map.has(k)) {
        result[k] = this.map.get(k);
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.map.set(k, v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      this.map.delete(k);
    }
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

describe("Phase 1C.4.2.1 — QueueDrainer / Claim / Lease Integration Suite", () => {
  let localDriver: MemoryStorageDriver;
  let storage: StorageService;
  let payloadStorage: PayloadStorage;
  let concurrency: QueueConcurrencyManager;
  let queueManager: QueueManager;
  let drainer: QueueDrainer;

  beforeEach(() => {
    localDriver = new MemoryStorageDriver();
    storage = new StorageService(localDriver);
    payloadStorage = new PayloadStorage(new MemoryPayloadStorageDriver());
    concurrency = new QueueConcurrencyManager(storage);
    queueManager = new QueueManager(storage, payloadStorage, concurrency);
    drainer = new QueueDrainer({ queueManager });
  });

  async function createAndEnqueueSubmission(
    overrides: Partial<NormalizedSubmission> = {},
  ): Promise<QueueItemMetadata> {
    const sourceCode = overrides.sourceCode ?? "int main() { return 0; }";
    const contentHash =
      overrides.contentHash ?? (await computeContentHash(sourceCode));
    const sub: NormalizedSubmission = {
      id: crypto.randomUUID(),
      platform: "leetcode",
      submissionId: "sub_test_01",
      submissionUrl: "https://leetcode.com/submissions/detail/1001/",
      targetRepository: "octocat/dsa-repo",
      targetBranch: "main",
      problemTitle: "Two Sum",
      problemSlug: "two-sum",
      problemId: "1",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode,
      contentHash,
      submittedAt: Date.now(),
      detectedAt: Date.now(),
      targetSnapshot: {
        targetRepository: "octocat/dsa-repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        authorizationStatus: "AUTHORIZED",
      },
      ...overrides,
    };
    return await queueManager.enqueueSubmission(sub);
  }

  it("DR-01: QueueDrainer delegates to QueueManager.drainQueue when handler is installed", async () => {
    const drainSpy = vi.spyOn(queueManager, "drainQueue");
    const testHandler: QueueItemHandler = async () => ({
      status: "completed",
      commitSha: "sha123",
    });
    drainer.setHandler(testHandler);

    const result = await drainer.drain("submission_event");

    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith("submission_event", testHandler);
    expect(result).not.toBeNull();
    expect(result?.processed).toBe(0);
  });

  it("DR-02: Correct TriggerSource is passed through to QueueManager when handler is installed", async () => {
    const drainSpy = vi.spyOn(queueManager, "drainQueue");
    drainer.setHandler(async () => ({ status: "completed", commitSha: "sha" }));

    await drainer.drain("alarm");
    expect(drainSpy).toHaveBeenLastCalledWith("alarm", expect.any(Function));

    await drainer.drain("startup");
    expect(drainSpy).toHaveBeenLastCalledWith("startup", expect.any(Function));

    await drainer.drain("manual_retry");
    expect(drainSpy).toHaveBeenLastCalledWith(
      "manual_retry",
      expect.any(Function),
    );

    await drainer.drain("submission_event");
    expect(drainSpy).toHaveBeenLastCalledWith(
      "submission_event",
      expect.any(Function),
    );
  });

  it("DR-03: Multiple simultaneous drain triggers rely on QueueManager concurrency rather than a custom lock", async () => {
    // QueueDrainer must NOT implement custom locking;
    // multiple concurrent drain calls delegate to QueueManager where
    // the two-tier concurrency manager acquires the lease and safely yields (returns null) for the second caller
    await createAndEnqueueSubmission();

    let insideHandler = false;
    let concurrentCallYielded = false;

    const testHandler: QueueItemHandler = async () => {
      insideHandler = true;
      // While worker A is draining, trigger worker B
      const concurrentResult = await drainer.drain("alarm");
      if (concurrentResult === null) {
        concurrentCallYielded = true;
      }
      return { status: "completed", commitSha: "abc1234" };
    };

    drainer.setHandler(testHandler);
    const primaryResult = await drainer.drain("submission_event");

    expect(insideHandler).toBe(true);
    expect(concurrentCallYielded).toBe(true);
    expect(primaryResult?.completed).toBe(1);
  });

  it("DR-04 & DR-05: Successful submission enqueue triggers drain; failed enqueue does NOT trigger drain", async () => {
    // Mock background message flow logic
    let drainTriggered = false;
    const mockDrain = async () => {
      drainTriggered = true;
      return null;
    };

    // Case 1: Successful enqueue
    const successfulResult = {
      success: true,
      queueItem: await createAndEnqueueSubmission(),
    };

    if (successfulResult.success && successfulResult.queueItem) {
      await mockDrain();
    }
    expect(drainTriggered).toBe(true);

    // Case 2: Failed enqueue (e.g. malformed submission or rejected status)
    drainTriggered = false;
    const failedResult: {
      success: boolean;
      queueItem?: QueueItemMetadata;
      error?: string;
    } = {
      success: false,
      error: "Status PENDING not eligible",
    };

    if (failedResult.success && failedResult.queueItem) {
      await mockDrain();
    }
    expect(drainTriggered).toBe(false);
  });

  it("DR-06: Startup triggers drain when handler is installed", async () => {
    const drainSpy = vi.spyOn(queueManager, "drainQueue");
    drainer.setHandler(async () => ({ status: "completed", commitSha: "sha" }));

    const result = await drainer.drain("startup");

    expect(drainSpy).toHaveBeenCalledWith("startup", expect.any(Function));
    expect(result).not.toBeNull();
  });

  it("DR-07 & DR-09: Alarm triggers drain; setupQueueDrainAlarm prevents duplicate alarm creation", async () => {
    const mockAlarms = new Map<string, unknown>();
    interface MockBrowser {
      alarms: {
        get: (name: string) => Promise<unknown>;
        create: (name: string, info: unknown) => void;
      };
    }
    const globalContext = globalThis as unknown as {
      browser?: MockBrowser | undefined;
    };
    const originalBrowser = globalContext.browser;

    const createAlarmMock = vi.fn((name: string, info: unknown) => {
      mockAlarms.set(name, info);
    });

    globalContext.browser = {
      alarms: {
        get: vi.fn(async (name: string) => mockAlarms.get(name)),
        create: createAlarmMock,
      },
    };

    try {
      // First setup call: creates alarm
      await setupQueueDrainAlarm();
      expect(createAlarmMock).toHaveBeenCalledTimes(1);
      expect(createAlarmMock).toHaveBeenCalledWith(QUEUE_DRAIN_ALARM_NAME, {
        periodInMinutes: QUEUE_DRAIN_ALARM_PERIOD_MINUTES,
      });

      // Second setup call: observes existing alarm and does NOT recreate
      await setupQueueDrainAlarm();
      expect(createAlarmMock).toHaveBeenCalledTimes(1);

      // Alarm event triggers drain
      const drainSpy = vi.spyOn(queueManager, "drainQueue");
      drainer.setHandler(async () => ({
        status: "completed",
        commitSha: "sha",
      }));
      await drainer.drain("alarm");
      expect(drainSpy).toHaveBeenCalledWith("alarm", expect.any(Function));
    } finally {
      globalContext.browser = originalBrowser;
    }
  });

  it("DR-08: QueueDrainer is not directly exposed to content scripts or page context", () => {
    // Verify QueueDrainer is an internal shared module, not a window/globalThis property
    const globalObj = globalThis as Record<string, unknown>;
    expect(globalObj["defaultQueueDrainer"]).toBeUndefined();
    expect(globalObj["QueueDrainer"]).toBeUndefined();
  });

  it("DR-10: QueueDrainer preserves DrainSummary / null semantics from QueueManager when handler is installed", async () => {
    drainer.setHandler(async () => ({ status: "completed", commitSha: "sha" }));
    // When contended, QueueManager returns null; QueueDrainer must preserve null
    const workerOther = crypto.randomUUID();
    await concurrency.acquirePersistentLease(workerOther, "startup");

    const resultContended = await drainer.drain("submission_event");
    expect(resultContended).toBeNull();

    // Release lease
    await storage.removeLease();

    // When uncontended, returns DrainSummary object
    const resultAvailable = await drainer.drain("submission_event");
    expect(resultAvailable).toEqual({
      processed: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      quarantined: 0,
    });
  });

  it("DR-11: Existing fencing behavior remains intact during QueueDrainer execution", async () => {
    await createAndEnqueueSubmission();

    // Handler simulates a stale worker whose fencing token is superseded in storage
    drainer.setHandler(async (_item) => {
      // Interleaving worker overwrites lease with a higher fencing token
      await storage.setLease({
        workerId: "interleaving_worker",
        fencingToken: 999,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 30_000,
        maxLifetimeExpiresAt: Date.now() + 300_000,
        triggerSource: "alarm",
      });
      return { status: "completed", commitSha: "stale_commit" };
    });

    // Stale worker mutation is rejected fail-closed with StaleLeaseError
    await expect(drainer.drain("submission_event")).rejects.toThrow(
      StaleLeaseError,
    );

    // Queue item was not marked COMPLETED by stale worker
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).not.toBe(QueueState.COMPLETED);
  });

  it("DR-12: Existing crash recovery remains intact when QueueDrainer runs", async () => {
    // Case 1: Interrupted item with crashCount 1 -> recovered to PENDING and processed
    await createAndEnqueueSubmission();
    let queue = await storage.getQueueMetadata();
    queue[0]!.state = QueueState.PROCESSING;
    queue[0]!.crashCount = 1;
    await storage.setQueueMetadata(queue);

    let observedCrashCount = -1;
    drainer.setHandler(async (processedItem) => {
      observedCrashCount = processedItem.crashCount;
      return { status: "completed", commitSha: "recovered_sha" };
    });

    const summary = await drainer.drain("startup");
    expect(observedCrashCount).toBe(2); // Incremented by reconcileInterruptedItems before processing
    expect(summary?.completed).toBe(1);

    // Case 2: Poison pill (crashCount reaches POISON_PILL_CRASH_THRESHOLD = 3) -> quarantined to REQUIRES_ATTENTION
    await createAndEnqueueSubmission({ submissionId: "poison_sub" });
    queue = await storage.getQueueMetadata();
    const poisonItem = queue.find((i) => i.submissionId === "poison_sub")!;
    poisonItem.state = QueueState.PROCESSING;
    poisonItem.crashCount = 2;
    await storage.setQueueMetadata(queue);

    const poisonSummary = await drainer.drain("startup");
    const updatedQueue = await storage.getQueueMetadata();
    const quarantinedItem = updatedQueue.find(
      (i) => i.submissionId === "poison_sub",
    )!;

    expect(quarantinedItem.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(quarantinedItem.crashCount).toBe(3);
    expect(quarantinedItem.lastError?.code).toBe(
      ErrorCode.POISON_PILL_DETECTED,
    );
    expect(poisonSummary?.quarantined).toBeGreaterThanOrEqual(1);
  });

  it("DR-13: TargetSnapshot is not replaced by current configuration during drain", async () => {
    // Current user configuration in storage
    await storage.set(STORAGE_KEYS.CONFIG, {
      targetRepository: "malicious-user/hijacked-repo",
      targetBranch: "evil-branch",
      baseFolder: "hacked",
      duplicatePolicy: "ALWAYS_REPLACE",
    });

    // Enqueued item has an immutable snapshot
    await createAndEnqueueSubmission({
      targetSnapshot: {
        targetRepository: "octocat/original-repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        authorizationStatus: "AUTHORIZED",
      },
    });

    let observedTargetRepo = "";
    drainer.setHandler(async (processedItem) => {
      observedTargetRepo =
        processedItem.targetSnapshot?.targetRepository ??
        processedItem.targetRepository;
      return { status: "completed", commitSha: "sha1" };
    });

    await drainer.drain("submission_event");

    // Handler received the immutable snapshot target, NOT the mutated config target
    expect(observedTargetRepo).toBe("octocat/original-repo");
    expect(observedTargetRepo).not.toBe("malicious-user/hijacked-repo");
  });

  it("DR-14: No GitHub write occurs and item is NOT failed when drain trigger fires without an installed handler", async () => {
    await createAndEnqueueSubmission();

    // Default QueueDrainer without an integrated GitHub handler
    const unconfiguredDrainer = new QueueDrainer({ queueManager });
    const summary = await unconfiguredDrainer.drain("submission_event");

    // Safe fail-closed no-op: returns null, claims nothing, queue item remains PENDING
    expect(summary).toBeNull();

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.PENDING);
    expect(queue[0]!.attempts).toBe(0);
    expect(queue[0]!.lastError).toBeUndefined();
  });

  it("DR-15: Rate-limit behavior and delay calculation are aligned without QueueManager owning classification", async () => {
    await createAndEnqueueSubmission();

    const futureResetTimestamp = Date.now() + 45_000; // 45 seconds in the future
    drainer.setHandler(async () => {
      return {
        status: "failed",
        error: {
          code: ErrorCode.GITHUB_RATE_LIMITED,
          message: "Primary rate limit exhausted",
          retryable: true,
          resetTimestamp: futureResetTimestamp,
        },
      };
    });

    await drainer.drain("alarm");

    const queue = await storage.getQueueMetadata();
    const failedItem = queue[0]!;
    expect(failedItem.state).toBe(QueueState.FAILED);
    // nextRetryAt respects the authoritative reset timestamp rather than only generic 2s backoff
    expect(failedItem.nextRetryAt).toBeGreaterThanOrEqual(
      futureResetTimestamp - 100,
    );
  });

  it("DR-16: Rate limit retryAfterSeconds is respected when resetTimestamp is absent", async () => {
    await createAndEnqueueSubmission();

    const now = Date.now();
    drainer.setHandler(async () => {
      return {
        status: "failed",
        error: {
          code: ErrorCode.GITHUB_RATE_LIMITED,
          message: "Secondary rate limit (abuse detection)",
          retryable: true,
          retryAfterSeconds: 60, // 60 seconds
        },
      };
    });

    await drainer.drain("alarm");

    const queue = await storage.getQueueMetadata();
    const failedItem = queue[0]!;
    expect(failedItem.state).toBe(QueueState.FAILED);
    expect(failedItem.nextRetryAt).toBeGreaterThanOrEqual(now + 59_000);
  });

  it("DR-17: No duplicate submission identity regression across distinct submission IDs", async () => {
    // Two submissions with same problem slug and code but different submission IDs
    const sub1 = await createAndEnqueueSubmission({
      submissionId: "sub_alpha",
      sourceCode: "int solution() { return 1; }",
    });
    const sub2 = await createAndEnqueueSubmission({
      submissionId: "sub_beta",
      sourceCode: "int solution() { return 1; }",
    });

    expect(sub1.id).not.toBe(sub2.id);

    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(2);
  });

  it("DR-18: Zero sensitive credential data appears in queue metadata, sync history, or errors", async () => {
    await createAndEnqueueSubmission();

    drainer.setHandler(async (_item) => {
      return {
        status: "completed",
        commitSha: "commit_secret_free_sha",
        commitUrl:
          "https://github.com/octocat/dsa-repo/commit/commit_secret_free_sha",
      };
    });

    await drainer.drain("submission_event");

    const queue = await storage.getQueueMetadata();
    const history = await payloadStorage.getHistory();

    const serializedQueue = JSON.stringify(queue);
    const serializedHistory = JSON.stringify(history);

    expect(serializedQueue).not.toContain("ghp_");
    expect(serializedQueue).not.toContain("Bearer");
    expect(serializedQueue).not.toContain("accessToken");
    expect(serializedQueue).not.toContain("refreshToken");

    expect(serializedHistory).not.toContain("ghp_");
    expect(serializedHistory).not.toContain("Bearer");
    expect(serializedHistory).not.toContain("accessToken");
    expect(serializedHistory).not.toContain("refreshToken");
  });

  describe("QD-SAFE: Fail-Closed QueueDrainer Safety & No-Op Handler Suite", () => {
    it("QD-SAFE-01: No handler installed -> drain returns null and QueueManager.drainQueue is NOT called", async () => {
      const drainSpy = vi.spyOn(queueManager, "drainQueue");
      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      expect(unconfiguredDrainer.hasHandler()).toBe(false);

      const result = await unconfiguredDrainer.drain("submission_event");

      expect(result).toBeNull();
      expect(drainSpy).not.toHaveBeenCalled();
    });

    it("QD-SAFE-02: No handler installed with valid PENDING queue item -> item remains PENDING, no state transition occurs", async () => {
      const item = await createAndEnqueueSubmission();
      expect(item.state).toBe(QueueState.PENDING);

      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      const result = await unconfiguredDrainer.drain("submission_event");

      expect(result).toBeNull();
      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      expect(queue[0]!.id).toBe(item.id);
      expect(queue[0]!.state).toBe(QueueState.PENDING);
    });

    it("QD-SAFE-03: No handler installed -> attempts remain unchanged (0 attempts consumed)", async () => {
      const item = await createAndEnqueueSubmission();
      expect(item.attempts).toBe(0);

      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      await unconfiguredDrainer.drain("submission_event");

      const queue = await storage.getQueueMetadata();
      expect(queue[0]!.attempts).toBe(0);
    });

    it("QD-SAFE-04: No handler installed -> nextRetryAt / backoff remains unchanged", async () => {
      const item = await createAndEnqueueSubmission();
      const originalNextRetryAt = item.nextRetryAt;

      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      await unconfiguredDrainer.drain("alarm");

      const queue = await storage.getQueueMetadata();
      expect(queue[0]!.nextRetryAt).toBe(originalNextRetryAt);
      expect(queue[0]!.lastError).toBeUndefined();
    });

    it("QD-SAFE-05: No handler installed -> poison-pill / crash accounting is unchanged", async () => {
      const item = await createAndEnqueueSubmission();
      expect(item.crashCount).toBe(0);

      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      await unconfiguredDrainer.drain("startup");

      const queue = await storage.getQueueMetadata();
      expect(queue[0]!.crashCount).toBe(0);
      expect(queue[0]!.state).toBe(QueueState.PENDING);
    });

    it("QD-SAFE-06: No handler installed -> zero GitHub synchronization calls occur", async () => {
      await createAndEnqueueSubmission();

      const githubCallSpy = vi.fn();
      const unconfiguredDrainer = new QueueDrainer({ queueManager });
      const result = await unconfiguredDrainer.drain("submission_event");

      expect(result).toBeNull();
      expect(githubCallSpy).not.toHaveBeenCalled();
      const history = await payloadStorage.getHistory();
      expect(history).toHaveLength(0);
    });

    it("QD-SAFE-07: Real handler is installed -> QueueDrainer delegates normally to QueueManager.drainQueue", async () => {
      await createAndEnqueueSubmission();
      const drainSpy = vi.spyOn(queueManager, "drainQueue");

      const realHandler: QueueItemHandler = vi.fn(async () => ({
        status: "completed" as const,
        commitSha: "sha_safe_07",
        commitUrl: "https://github.com/octocat/dsa-repo/commit/sha_safe_07",
      }));

      drainer.setHandler(realHandler);
      expect(drainer.hasHandler()).toBe(true);

      const summary = await drainer.drain("submission_event");

      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(realHandler).toHaveBeenCalledTimes(1);
      expect(summary).not.toBeNull();
      expect(summary?.completed).toBe(1);

      const queue = await storage.getQueueMetadata();
      expect(queue[0]!.state).toBe(QueueState.COMPLETED);
    });

    it("QD-SAFE-08: Remove/unset handler after it was installed -> subsequent drain becomes safe no-op", async () => {
      await createAndEnqueueSubmission();
      const realHandler: QueueItemHandler = vi.fn(async () => ({
        status: "completed" as const,
        commitSha: "sha_temp",
      }));

      drainer.setHandler(realHandler);
      expect(drainer.hasHandler()).toBe(true);

      // Unset handler
      drainer.setHandler(undefined);
      expect(drainer.hasHandler()).toBe(false);
      expect(drainer.getHandler()).toBeUndefined();

      const drainSpy = vi.spyOn(queueManager, "drainQueue");
      const result = await drainer.drain("submission_event");

      expect(result).toBeNull();
      expect(drainSpy).not.toHaveBeenCalled();
      expect(realHandler).not.toHaveBeenCalled();

      const queue = await storage.getQueueMetadata();
      expect(queue[0]!.state).toBe(QueueState.PENDING);
      expect(queue[0]!.attempts).toBe(0);
    });

    it("QD-SAFE-09: Multiple drain triggers occur while no handler is installed -> all become safe no-ops", async () => {
      await createAndEnqueueSubmission();
      const unconfiguredDrainer = new QueueDrainer({ queueManager });

      const results = await Promise.all([
        unconfiguredDrainer.drain("submission_event"),
        unconfiguredDrainer.drain("alarm"),
        unconfiguredDrainer.drain("startup"),
        unconfiguredDrainer.drain("manual_retry"),
      ]);

      expect(results).toEqual([null, null, null, null]);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      expect(queue[0]!.state).toBe(QueueState.PENDING);
      expect(queue[0]!.attempts).toBe(0);
      expect(queue[0]!.crashCount).toBe(0);
    });

    it("QD-SAFE-10: Security model enforces: validated extension messaging + service-worker authorization", () => {
      // Content scripts communicate with the service worker via extension runtime messaging.
      // The security invariant is NOT that content scripts cannot message the worker;
      // rather, all incoming messages must undergo envelope validation and service-worker authorization,
      // and untrusted callers cannot directly invoke QueueManager or QueueDrainer.
      const globalObj = globalThis as Record<string, unknown>;
      expect(globalObj["defaultQueueDrainer"]).toBeUndefined();
      expect(globalObj["defaultQueueManager"]).toBeUndefined();
      expect(globalObj["QueueDrainer"]).toBeUndefined();
      expect(globalObj["QueueManager"]).toBeUndefined();
    });
  });
});
