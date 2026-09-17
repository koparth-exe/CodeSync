import { describe, expect, it, beforeEach } from "vitest";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueState } from "../../src/shared/storage/types";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import type { NormalizedSubmission } from "../../src/shared/queue/types";
import { ErrorCode, StorageError } from "../../src/shared/errors";

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

describe("Systemic Failure Injection & Resilience Suite", () => {
  let localDriver: MemoryStorageDriver;
  let storage: StorageService;
  let payloadDriver: MemoryPayloadStorageDriver;
  let payloadStorage: PayloadStorage;
  let concurrency: QueueConcurrencyManager;
  let queueManager: QueueManager;

  beforeEach(() => {
    localDriver = new MemoryStorageDriver();
    storage = new StorageService(localDriver);
    payloadDriver = new MemoryPayloadStorageDriver();
    payloadStorage = new PayloadStorage(payloadDriver);
    concurrency = new QueueConcurrencyManager(storage);
    queueManager = new QueueManager(storage, payloadStorage, concurrency);
  });

  function createSubmission(
    id: string,
    code: string = "int x = 1;",
  ): NormalizedSubmission {
    return {
      id,
      platform: "leetcode",
      submissionId: `sub_${id}`,
      submissionUrl: `https://leetcode.com/submissions/${id}/`,
      targetRepository: "octocat/dsa-repo",
      targetBranch: "main",
      problemTitle: `Problem ${id}`,
      problemSlug: `problem-${id}`,
      problemId: id,
      status: "Accepted",
      language: "cpp",
      sourceCode: code,
      submittedAt: Date.now(),
      detectedAt: Date.now(),
    };
  }

  it("Scenario 1: Storage failure injection during WAL Phase 1 leaves zero orphan metadata", async () => {
    // Inject catastrophic IndexedDB failure into payloadStorage
    payloadDriver.putPayload = async () => {
      throw new StorageError(
        "Simulated IndexedDB I/O Failure: QuotaExceededError",
        ErrorCode.STORAGE_QUOTA_EXCEEDED,
      );
    };

    const sub = createSubmission("fail_1");
    await expect(queueManager.enqueueSubmission(sub)).rejects.toThrow(
      StorageError,
    );

    // Verify metadata was NEVER committed
    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(0);
  });

  it("Scenario 2: Worker process termination mid-batch and clean reboot recovery", async () => {
    const sub1 = createSubmission("item_1");
    const sub2 = createSubmission("item_2");
    const sub3 = createSubmission("item_3");

    await queueManager.enqueueSubmission(sub1);
    await queueManager.enqueueSubmission(sub2);
    await queueManager.enqueueSubmission(sub3);

    // Simulate Worker 1 starting: it completes item_1, transitions item_2 to PROCESSING,
    // and then the browser process terminates abruptly (service worker kill).
    const queue = await storage.getQueueMetadata();
    queue[0]!.state = QueueState.COMPLETED;
    queue[0]!.completedAt = Date.now();
    queue[0]!.commitSha = "sha_item_1";

    queue[1]!.state = QueueState.PROCESSING;
    queue[1]!.updatedAt = Date.now();
    // item_3 remains PENDING
    await storage.setQueueMetadata(queue);

    // Verify disk state left behind by crashed Worker 1:
    const crashedQueue = await storage.getQueueMetadata();
    expect(crashedQueue[0]!.state).toBe(QueueState.COMPLETED);
    expect(crashedQueue[1]!.state).toBe(QueueState.PROCESSING);
    expect(crashedQueue[2]!.state).toBe(QueueState.PENDING);

    // Worker 2 starts up after browser reboot:
    // drainQueue automatically invokes reconcileInterruptedItems(), reconciling item_2
    const worker2Summary = await queueManager.drainQueue(
      "startup",
      async (item, _payload) => {
        return { status: "completed", commitSha: `sha_${item.id}` };
      },
    );

    expect(worker2Summary).not.toBeNull();
    // Reconciled item_2 and pending item_3 both complete
    expect(worker2Summary?.completed).toBe(2);

    const finalQueue = await storage.getQueueMetadata();
    expect(finalQueue.every((i) => i.state === QueueState.COMPLETED)).toBe(
      true,
    );

    // Verify item_2 crashCount was incremented during the recovery
    const recoveredItem2 = finalQueue.find((i) => i.id === "item_2");
    expect(recoveredItem2?.crashCount).toBe(1);
  });

  it("Scenario 3: Missing payload in IndexedDB fails closed into REQUIRES_ATTENTION without halting queue", async () => {
    const sub1 = createSubmission("ghost_item");
    const sub2 = createSubmission("healthy_item");

    await queueManager.enqueueSubmission(sub1);
    await queueManager.enqueueSubmission(sub2);

    // Manually delete payload for ghost_item from IndexedDB to simulate corruption/premature deletion
    await payloadDriver.deletePayload(`payload:ghost_item`);

    const summary = await queueManager.drainQueue(
      "alarm",
      async (_item, _payload) => {
        return { status: "completed", commitSha: "healthy_sha" };
      },
    );

    expect(summary).not.toBeNull();
    expect(summary?.quarantined).toBe(1); // ghost_item quarantined
    expect(summary?.completed).toBe(1); // healthy_item completed successfully

    const queue = await storage.getQueueMetadata();
    const ghost = queue.find((i) => i.id === "ghost_item");
    expect(ghost?.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(ghost?.lastError?.code).toBe(ErrorCode.PAYLOAD_NOT_FOUND);

    const healthy = queue.find((i) => i.id === "healthy_item");
    expect(healthy?.state).toBe(QueueState.COMPLETED);
  });

  it("Scenario 4: High-contention race storm across 5 concurrent workers", async () => {
    const sub = createSubmission("storm_item");
    await queueManager.enqueueSubmission(sub);

    // 5 simultaneous drain attempts race for the lease
    const results = await Promise.all([
      queueManager.drainQueue("alarm", async () => ({ status: "completed" })),
      queueManager.drainQueue("submission_event", async () => ({
        status: "completed",
      })),
      queueManager.drainQueue("manual_retry", async () => ({
        status: "completed",
      })),
      queueManager.drainQueue("startup", async () => ({ status: "completed" })),
      queueManager.drainQueue("alarm", async () => ({ status: "completed" })),
    ]);

    // Exactly one worker must have successfully processed the drain; the others returned null (yielded)
    const successfulDrains = results.filter((r) => r !== null);
    const yieldedDrains = results.filter((r) => r === null);

    expect(successfulDrains).toHaveLength(1);
    expect(yieldedDrains).toHaveLength(4);

    // Final queue item is completed exactly once
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  it("Scenario 5: Retryable failures exhaust max attempts (5) and transition to REQUIRES_ATTENTION", async () => {
    const sub = createSubmission("stubborn_item");
    await queueManager.enqueueSubmission(sub);

    // Execute 5 sequential failures
    for (let attempt = 1; attempt <= 5; attempt++) {
      // Force nextRetryAt to 0 so eligible immediately
      const queue = await storage.getQueueMetadata();
      queue[0]!.nextRetryAt = 0;
      await storage.setQueueMetadata(queue);

      await queueManager.drainQueue("alarm", async () => {
        return {
          status: "failed",
          error: {
            code: "NETWORK_TIMEOUT",
            message: "Connection timed out",
            retryable: true,
          },
        };
      });
    }

    const finalQueue = await storage.getQueueMetadata();
    expect(finalQueue[0]!.attempts).toBe(5);
    expect(finalQueue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
  });
});
