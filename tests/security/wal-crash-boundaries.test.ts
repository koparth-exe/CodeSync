import { describe, expect, it, beforeEach } from "vitest";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueState, WalPhase } from "../../src/shared/storage/types";
import type { WalEntry } from "../../src/shared/storage/types";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import type { NormalizedSubmission } from "../../src/shared/queue/types";
import { ErrorCode } from "../../src/shared/errors";

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

describe("Durable WAL Crash Boundaries & Idempotent Recovery Matrix (Section 5)", () => {
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
    code: string = "int solution() { return 1; }",
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

  it("Boundary A: Crash before WAL Intent — clean state, zero orphan records", async () => {
    // Zero writes initiated
    const recon = await queueManager.reconcileWalAndOrphans();
    expect(recon.reconciledWalCount).toBe(0);
    expect(recon.recoveredOrphanPayloads).toBe(0);
    expect(recon.quarantinedOrphanMetadata).toBe(0);

    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(0);
    const walEntries = await payloadStorage.getAllWalEntries();
    expect(walEntries).toHaveLength(0);
  });

  it("Boundary B: Crash after WAL Intent, before Payload write — cleans up uncommitted intent", async () => {
    const opId = crypto.randomUUID();
    const sub = createSubmission("boundary_b");

    // Persist WAL INTENT only
    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: sub.id,
      payloadId: `payload:${sub.id}`,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: { submission: sub },
    };
    await payloadStorage.putWalEntry(walEntry);

    // Recovery runs: sees INTENT without payload written
    const recon = await queueManager.reconcileWalAndOrphans();
    expect(recon.reconciledWalCount).toBe(0);

    // WAL entry must be cleaned up; zero partial metadata created
    const remainingWal = await payloadStorage.getWalEntry(opId);
    expect(remainingWal).toBeNull();
    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(0);
  });

  it("Boundary C: Crash after Payload write, before Metadata write — recovers metadata deterministically", async () => {
    const opId = crypto.randomUUID();
    const sub = createSubmission("boundary_c");
    const payloadId = `payload:${sub.id}`;

    // WAL INTENT written
    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: sub.id,
      payloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: { submission: sub },
    };
    await payloadStorage.putWalEntry(walEntry);

    // Payload written to IndexedDB
    await payloadStorage.putPayload({
      id: payloadId,
      sourceCode: sub.sourceCode,
      createdAt: Date.now(),
    });
    // Crash occurs before metadata write to storage.local!

    // Recovery runs: reconstructs metadata from WAL snapshot and payload
    const recon = await queueManager.reconcileWalAndOrphans();
    expect(recon.reconciledWalCount).toBe(1);

    // Verify metadata was recovered into storage.local
    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(sub.id);
    expect(queue[0]!.state).toBe(QueueState.PENDING);

    // WAL entry must be pruned
    expect(await payloadStorage.getWalEntry(opId)).toBeNull();
  });

  it("Boundary D: Crash after Metadata write, before WAL COMMITTED — cleanly completes WAL", async () => {
    const opId = crypto.randomUUID();
    const sub = createSubmission("boundary_d");
    const payloadId = `payload:${sub.id}`;

    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: sub.id,
      payloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: { submission: sub },
    };
    await payloadStorage.putWalEntry(walEntry);

    await payloadStorage.putPayload({
      id: payloadId,
      sourceCode: sub.sourceCode,
      createdAt: Date.now(),
    });

    await storage.setQueueMetadata([
      {
        id: sub.id,
        payloadId,
        platform: sub.platform,
        problemSlug: sub.problemSlug,
        problemTitle: sub.problemTitle,
        targetRepository: sub.targetRepository,
        targetBranch: sub.targetBranch,
        language: sub.language,
        status: sub.status,
        contentHash: "hash_d",
        state: QueueState.PENDING,
        attempts: 0,
        crashCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    // Recovery sees both exist: cleanly prunes WAL
    await queueManager.reconcileWalAndOrphans();
    expect(await payloadStorage.getWalEntry(opId)).toBeNull();

    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(1);
  });

  it("Boundary E: Crash after WAL COMMITTED, before cleanup — prunes committed WAL entry", async () => {
    const opId = crypto.randomUUID();
    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: "item_e",
      payloadId: "payload:item_e",
      intendedState: QueueState.PENDING,
      phase: WalPhase.COMMITTED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await payloadStorage.putWalEntry(walEntry);

    await queueManager.reconcileWalAndOrphans();
    expect(await payloadStorage.getWalEntry(opId)).toBeNull();
  });

  it("Boundary F: Metadata exists but Payload missing (Orphan Metadata) — quarantined safely", async () => {
    const sub = createSubmission("orphan_meta");
    // Enqueue properly
    await queueManager.enqueueSubmission(sub);

    // Delete payload behind its back
    await payloadDriver.deletePayload(`payload:${sub.id}`);

    // Recovery runs
    const recon = await queueManager.reconcileWalAndOrphans();
    expect(recon.quarantinedOrphanMetadata).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.PAYLOAD_NOT_FOUND);
  });

  it("Boundary G: Payload exists but Metadata missing (Orphan Payload) — recovered to REQUIRES_ATTENTION without data loss", async () => {
    // A payload was persisted (e.g. from an interrupted operation or legacy import)
    const payloadId = "payload:lost_treasure";
    await payloadStorage.putPayload({
      id: payloadId,
      sourceCode: "void recoverMe() {}",
      createdAt: Date.now(),
    });

    // Zero metadata exists in storage.local
    expect(await storage.getQueueMetadata()).toHaveLength(0);

    // Recovery runs: MUST NOT delete payload! Reconstructs quarantine metadata
    const recon = await queueManager.reconcileWalAndOrphans();
    expect(recon.recoveredOrphanPayloads).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.payloadId).toBe(payloadId);
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.status).toBe("RECOVERED_ORPHAN_PAYLOAD");

    // Verify source code remains 100% intact in IndexedDB
    const payload = await payloadStorage.getPayload(payloadId);
    expect(payload?.sourceCode).toBe("void recoverMe() {}");
  });

  it("Boundary H: WAL exists but neither payload nor metadata exists — safely pruned", async () => {
    const opId = crypto.randomUUID();
    await payloadStorage.putWalEntry({
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: "ghost_entity",
      payloadId: "payload:ghost",
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await queueManager.reconcileWalAndOrphans();
    expect(await payloadStorage.getWalEntry(opId)).toBeNull();
  });

  it("Boundary I: Stale / Incomplete WAL entry rolled back safely", async () => {
    const opId = crypto.randomUUID();
    await payloadStorage.putWalEntry({
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: "stale_entity",
      payloadId: "payload:stale",
      intendedState: QueueState.PENDING,
      phase: WalPhase.ROLLED_BACK,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 120_000,
    });

    await queueManager.reconcileWalAndOrphans();
    expect(await payloadStorage.getWalEntry(opId)).toBeNull();
  });

  it("Boundary J & K: Recovery Idempotence — running recovery twice leaves state identical", async () => {
    const sub = createSubmission("idempotence_check");
    await queueManager.enqueueSubmission(sub);

    // Simulate an orphan payload
    await payloadStorage.putPayload({
      id: "payload:extra_orphan",
      sourceCode: "int extra = 99;",
      createdAt: Date.now(),
    });

    // Run recovery pass 1
    const recon1 = await queueManager.reconcileWalAndOrphans();
    expect(recon1.recoveredOrphanPayloads).toBe(1);

    const queuePass1 = await storage.getQueueMetadata();
    const countPass1 = queuePass1.length;

    // Run recovery pass 2 immediately
    const recon2 = await queueManager.reconcileWalAndOrphans();
    expect(recon2.recoveredOrphanPayloads).toBe(0);
    expect(recon2.reconciledWalCount).toBe(0);

    const queuePass2 = await storage.getQueueMetadata();
    expect(queuePass2.length).toBe(countPass1);
    expect(queuePass2).toEqual(queuePass1);
  });
});
