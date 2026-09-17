import { describe, expect, it, beforeEach } from "vitest";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
  MAX_PAYLOAD_SIZE_BYTES,
} from "../../src/shared/storage/indexeddb";
import { QueueManager, MAX_QUEUE_ITEMS } from "../../src/shared/queue/manager";
import { QueueState } from "../../src/shared/storage/types";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import type { NormalizedSubmission } from "../../src/shared/queue/types";
import { ErrorCode, QueueError, StorageError } from "../../src/shared/errors";

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

describe("Hybrid Storage Partitioning, WAL & Poison Pill Suite (S16 & Storage)", () => {
  let localDriver: MemoryStorageDriver;
  let storage: StorageService;
  let payloadStorage: PayloadStorage;
  let concurrency: QueueConcurrencyManager;
  let queueManager: QueueManager;

  beforeEach(() => {
    localDriver = new MemoryStorageDriver();
    storage = new StorageService(localDriver);
    payloadStorage = new PayloadStorage(new MemoryPayloadStorageDriver());
    concurrency = new QueueConcurrencyManager(storage);
    queueManager = new QueueManager(storage, payloadStorage, concurrency);
  });

  function createSampleSubmission(
    overrides: Partial<NormalizedSubmission> = {},
  ): NormalizedSubmission {
    return {
      id: crypto.randomUUID(),
      platform: "leetcode",
      submissionId: "sub_1001",
      submissionUrl: "https://leetcode.com/submissions/detail/1001/",
      targetRepository: "octocat/dsa-solutions",
      targetBranch: "main",
      problemTitle: "Two Sum",
      problemSlug: "two-sum",
      problemId: "1",
      status: "Accepted",
      language: "cpp",
      sourceCode: `int twoSum() { return 0; }`,
      submittedAt: Date.now(),
      detectedAt: Date.now(),
      ...overrides,
    };
  }

  it("enforces hybrid partitioning: payload in IndexedDB, metadata in storage.local", async () => {
    const sub = createSampleSubmission();
    const meta = await queueManager.enqueueSubmission(sub);

    expect(meta.id).toBe(sub.id);
    expect(meta.payloadId).toBe(`payload:${sub.id}`);
    expect(meta.state).toBe(QueueState.PENDING);

    // Verify metadata exists in storage.local without full sourceCode string
    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(sub.id);
    expect(
      (queue[0]! as unknown as { sourceCode?: string }).sourceCode,
    ).toBeUndefined();

    // Verify source code payload is in PayloadStorage (IndexedDB)
    const payload = await payloadStorage.getPayload(meta.payloadId);
    expect(payload).not.toBeNull();
    expect(payload?.sourceCode).toBe(sub.sourceCode);
  });

  it("rejects payloads exceeding the 500 KB limit and writes nothing to storage", async () => {
    const hugeCode = "x".repeat(MAX_PAYLOAD_SIZE_BYTES + 1024);
    const sub = createSampleSubmission({ sourceCode: hugeCode });

    await expect(queueManager.enqueueSubmission(sub)).rejects.toThrow(
      StorageError,
    );

    // Verify zero orphan metadata written to storage
    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(0);
  });

  it("enforces maximum queue capacity (200 items)", async () => {
    // Fill queue to 200
    const queue = await storage.getQueueMetadata();
    for (let i = 0; i < MAX_QUEUE_ITEMS; i++) {
      queue.push({
        id: `item_${i}`,
        payloadId: `payload:item_${i}`,
        platform: "leetcode",
        problemSlug: "two-sum",
        problemTitle: "Two Sum",
        targetRepository: "octocat/dsa",
        targetBranch: "main",
        language: "cpp",
        status: "Accepted",
        contentHash: "dummyhash",
        state: QueueState.PENDING,
        attempts: 0,
        crashCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    await storage.setQueueMetadata(queue);

    // 201st enqueue must fail closed
    const sub = createSampleSubmission();
    await expect(queueManager.enqueueSubmission(sub)).rejects.toThrow(
      QueueError,
    );
    try {
      await queueManager.enqueueSubmission(sub);
    } catch (e) {
      expect((e as QueueError).code).toBe(ErrorCode.QUEUE_FULL);
    }
  });

  it("detects corrupted storage metadata, isolates it to codesync:corrupted, and recovers safely", async () => {
    // Inject hostile non-array data into codesync:queue:metadata
    await localDriver.set({
      "codesync:queue:metadata": "malicious_string_instead_of_array",
    });

    const items = await storage.getQueueMetadata();
    // Must return safe empty array without throwing
    expect(items).toEqual([]);

    // Corrupted record must be quarantined in codesync:corrupted
    const corrupted = await storage.getCorruptedRecords();
    expect(corrupted).toHaveLength(1);
    expect(corrupted[0]!.rawContent).toBe("malicious_string_instead_of_array");
  });

  it("reconciles crashed worker items and quarantines poison pills after 3 crashes", async () => {
    const sub = createSampleSubmission();
    await queueManager.enqueueSubmission(sub);

    // Simulate worker crashing mid-processing on this item:
    const queue = await storage.getQueueMetadata();
    queue[0]!.state = QueueState.PROCESSING;
    queue[0]!.crashCount = 0;
    await storage.setQueueMetadata(queue);

    // Crash 1: Reconciles back to PENDING, crashCount = 1
    const r1 = await queueManager.reconcileInterruptedItems();
    expect(r1.reconciledCount).toBe(1);
    expect(r1.quarantinedCount).toBe(0);
    let currentQueue = await storage.getQueueMetadata();
    expect(currentQueue[0]!.state).toBe(QueueState.PENDING);
    expect(currentQueue[0]!.crashCount).toBe(1);

    // Worker picks it up again and crashes a second time:
    currentQueue[0]!.state = QueueState.PROCESSING;
    await storage.setQueueMetadata(currentQueue);

    // Crash 2: Reconciles to PENDING, crashCount = 2
    const r2 = await queueManager.reconcileInterruptedItems();
    expect(r2.reconciledCount).toBe(1);
    expect(r2.quarantinedCount).toBe(0);
    currentQueue = await storage.getQueueMetadata();
    expect(currentQueue[0]!.crashCount).toBe(2);

    // Worker picks it up again and crashes a 3rd time:
    currentQueue[0]!.state = QueueState.PROCESSING;
    await storage.setQueueMetadata(currentQueue);

    // Crash 3: Quarantines to REQUIRES_ATTENTION with POISON_PILL_DETECTED
    const r3 = await queueManager.reconcileInterruptedItems();
    expect(r3.reconciledCount).toBe(0);
    expect(r3.quarantinedCount).toBe(1);

    currentQueue = await storage.getQueueMetadata();
    expect(currentQueue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(currentQueue[0]!.crashCount).toBe(3);
    expect(currentQueue[0]!.lastError?.code).toBe(
      ErrorCode.POISON_PILL_DETECTED,
    );
  });
});
