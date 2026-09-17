import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createCrashTestEnvironment,
  ProcessTerminatedError,
  type CrashTestEnvironment,
} from "../helpers/crash-harness";
import {
  QueueState,
  WalPhase,
  type WalEntry,
  type QueueLeaseRecord,
} from "../../src/shared/storage/types";
import type { NormalizedSubmission } from "../../src/shared/queue/types";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { StaleLeaseError } from "../../src/shared/errors";
import { computeContentHash } from "../../src/shared/deduplication";

describe("Phase 1C.4.3.2.2.2.1 — Targeted Recovery Integration Suite", () => {
  let env: CrashTestEnvironment;

  beforeEach(async () => {
    env = createCrashTestEnvironment();
    await env.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createSubmission(
    id: string,
    overrides: Partial<NormalizedSubmission> = {},
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
      sourceCode: "int solution() { return 1; }\n",
      submittedAt: Date.now(),
      detectedAt: Date.now(),
      ...overrides,
    };
  }

  // ==========================================================================
  // WAL-REC-01 — Interrupted Recovery Pass
  // ==========================================================================
  it("WAL-REC-01: recovers safely when a worker crashes after metadata reconstruction but before WAL deletion", async () => {
    const opId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const payloadId = `payload:${itemId}`;
    const sub = createSubmission(itemId, {
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 101; }\n",
    });

    // 1. Initial durable state: WAL INTENT exists, payload exists, metadata is missing (Boundary C)
    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: itemId,
      payloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: {
        submission: sub,
      },
    };
    await env.sharedPayloadDriver.putWalEntry(walEntry);

    await env.sharedPayloadDriver.putPayload({
      id: payloadId,
      sourceCode: sub.sourceCode,
      createdAt: Date.now(),
    });

    // Assert initial state before recovery
    expect(await env.getDurableWalEntries()).toHaveLength(1);
    expect(await env.getDurablePayloads()).toHaveLength(1);
    expect(await env.getDurableQueue()).toHaveLength(0);

    // 2. Worker A boots and begins recovery
    const workerA = env.createWorker("Worker-A");

    // Intercept Worker A at the exact crash boundary:
    // When Worker A calls deleteWalEntry (which occurs right after metadata persistence),
    // terminate Worker A abruptly.
    workerA.payloadDriver.deleteWalEntry = async () => {
      workerA.terminate();
      throw new ProcessTerminatedError(
        "Worker A terminated abruptly after metadata write before WAL deletion",
      );
    };

    // Worker A runs recovery — aborts fail-closed due to process termination
    await expect(workerA.queueManager.reconcileWalAndOrphans()).rejects.toThrow(
      ProcessTerminatedError,
    );
    expect(workerA.isTerminated()).toBe(true);
    env.discardWorker(workerA);

    // 3. Verify durable state at crash point:
    // Metadata was reconstructed, payload is intact, but residual WAL entry remains
    const queueAtCrash = await env.getDurableQueue();
    expect(queueAtCrash).toHaveLength(1);
    expect(queueAtCrash[0]!.id).toBe(itemId);
    expect(queueAtCrash[0]!.state).toBe(QueueState.PENDING);

    const payloadsAtCrash = await env.getDurablePayloads();
    expect(payloadsAtCrash).toHaveLength(1);
    expect(payloadsAtCrash[0]!.id).toBe(payloadId);

    const walAtCrash = await env.getDurableWalEntries();
    expect(walAtCrash).toHaveLength(1);
    expect(walAtCrash[0]!.id).toBe(opId);

    // 4. Fresh Worker B starts up with independent service graph
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.storage).not.toBe(workerA.storage);
    expect(workerB.payloadStorage).not.toBe(workerA.payloadStorage);

    // Worker B performs recovery: identifies metadata as already reconstructed and removes residual WAL entry
    const reconB = await workerB.queueManager.reconcileWalAndOrphans();
    expect(reconB.recoveredOrphanPayloads).toBe(0);
    expect(reconB.quarantinedOrphanMetadata).toBe(0);

    // 5. Verify final durable state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal).toHaveLength(1);
    expect(queueFinal[0]!.id).toBe(itemId);
    expect(queueFinal[0]!.state).toBe(QueueState.PENDING);

    const payloadsFinal = await env.getDurablePayloads();
    expect(payloadsFinal).toHaveLength(1);
    expect(payloadsFinal[0]!.id).toBe(payloadId);

    // WAL is completely pruned
    const walFinal = await env.getDurableWalEntries();
    expect(walFinal).toHaveLength(0);

    // Zero GitHub calls made merely by recovery
    expect(env.mockGitHubServer.getPutCount()).toBe(0);

    // 6. Recovery idempotence: second pass produces zero side effects
    const reconB2 = await workerB.queueManager.reconcileWalAndOrphans();
    expect(reconB2.reconciledWalCount).toBe(0);
    expect(reconB2.recoveredOrphanPayloads).toBe(0);
    expect(reconB2.quarantinedOrphanMetadata).toBe(0);

    const queueAfterSecondPass = await env.getDurableQueue();
    expect(queueAfterSecondPass).toEqual(queueFinal);

    env.discardWorker(workerB);
  });

  // ==========================================================================
  // WAL-REC-02 — Corrupted WAL Record Handling
  // ==========================================================================
  it("WAL-REC-02: handles a corrupted WAL record fail-closed without blocking valid recovery", async () => {
    const validOpId = "wal_valid_op";
    const validItemId = "item_valid";
    const validPayloadId = `payload:${validItemId}`;
    const validSub = createSubmission(validItemId, {
      problemSlug: "valid-problem",
      sourceCode: "int valid() { return 1; }\n",
    });

    // 1. Valid WAL entry + payload
    const validWal: WalEntry = {
      id: validOpId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: validItemId,
      payloadId: validPayloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: {
        submission: validSub,
      },
    };
    await env.sharedPayloadDriver.putWalEntry(validWal);
    await env.sharedPayloadDriver.putPayload({
      id: validPayloadId,
      sourceCode: validSub.sourceCode,
      createdAt: Date.now(),
    });

    // 2. Corrupted WAL record: invalid operationType, invalid phase, malformed snapshot
    const corruptWalId = "wal_corrupt_op";
    const corruptedWal = {
      id: corruptWalId,
      operationType:
        "MALFORMED_CORRUPTED_OP" as unknown as WalEntry["operationType"],
      entityId: "corrupt_item",
      payloadId: "payload:corrupt_item",
      intendedState: "INVALID_STATE" as unknown as QueueState,
      phase: "CORRUPTED_PHASE" as unknown as WalPhase,
      createdAt: "corrupted_timestamp" as unknown as number,
      updatedAt: Date.now(),
      snapshot: null,
    };
    await env.sharedPayloadDriver.putWalEntry(
      corruptedWal as unknown as WalEntry,
    );

    expect(await env.getDurableWalEntries()).toHaveLength(2);

    // 3. Worker boots and executes recovery
    const worker = env.createWorker("Worker-Corrupt-Test");

    // Recovery MUST NOT throw or crash
    const recon = await worker.queueManager.reconcileWalAndOrphans();
    expect(recon.reconciledWalCount).toBe(1); // Valid WAL was reconciled

    // 4. Assertions:
    // Valid queue item was safely reconstructed
    const queue = await env.getDurableQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe(validItemId);
    expect(queue[0]!.state).toBe(QueueState.PENDING);

    // Valid payload remains intact
    const payload = await env.sharedPayloadDriver.getPayload(validPayloadId);
    expect(payload?.sourceCode).toBe(validSub.sourceCode);

    // Corrupted WAL data was NOT treated as valid submission data (no corrupt item created)
    expect(queue.find((i) => i.id === "corrupt_item")).toBeUndefined();

    // Zero unauthorized GitHub calls
    expect(env.mockGitHubServer.getPutCount()).toBe(0);

    // 5. Deterministic on second pass
    const recon2 = await worker.queueManager.reconcileWalAndOrphans();
    expect(recon2.reconciledWalCount).toBe(0);
    const queue2 = await env.getDurableQueue();
    expect(queue2).toEqual(queue);

    env.discardWorker(worker);
  });

  // ==========================================================================
  // WAL-REC-03 — Multi-WAL Content-Hash Collision
  // ==========================================================================
  it("WAL-REC-03: preserves distinct submission identities across identical content hashes during multi-WAL recovery", async () => {
    const sharedSourceCode =
      "int twoSum(vector<int>& nums, int target) { return 42; }\n";
    const sharedContentHash = await computeContentHash(sharedSourceCode);

    const entityIdA = "item_A_distinct";
    const entityIdB = "item_B_distinct";
    const opIdA = "wal_op_A";
    const opIdB = "wal_op_B";
    const payloadIdA = `payload:${entityIdA}`;
    const payloadIdB = `payload:${entityIdB}`;

    const subA = createSubmission(entityIdA, {
      problemSlug: "two-sum",
      submissionId: "submission_AAA_101",
      sourceCode: sharedSourceCode,
      contentHash: sharedContentHash,
    });

    const subB = createSubmission(entityIdB, {
      problemSlug: "two-sum",
      submissionId: "submission_BBB_202",
      sourceCode: sharedSourceCode,
      contentHash: sharedContentHash,
    });

    // Content hashes are identical, but submission identities are distinct
    expect(subA.contentHash).toBe(subB.contentHash);
    expect(subA.submissionId).not.toBe(subB.submissionId);

    // Place both into recoverable Boundary C state
    const walA: WalEntry = {
      id: opIdA,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: entityIdA,
      payloadId: payloadIdA,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      snapshot: {
        submission: subA,
      },
    };

    const walB: WalEntry = {
      id: opIdB,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: entityIdB,
      payloadId: payloadIdB,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now() - 2000,
      updatedAt: Date.now() - 2000,
      snapshot: {
        submission: subB,
      },
    };

    await env.sharedPayloadDriver.putWalEntry(walA);
    await env.sharedPayloadDriver.putPayload({
      id: payloadIdA,
      sourceCode: sharedSourceCode,
      createdAt: Date.now() - 5000,
    });

    await env.sharedPayloadDriver.putWalEntry(walB);
    await env.sharedPayloadDriver.putPayload({
      id: payloadIdB,
      sourceCode: sharedSourceCode,
      createdAt: Date.now() - 2000,
    });

    // Assert initial setup
    expect(await env.getDurableWalEntries()).toHaveLength(2);
    expect(await env.getDurablePayloads()).toHaveLength(2);
    expect(await env.getDurableQueue()).toHaveLength(0);

    // Fresh worker runs recovery
    const worker = env.createWorker("Worker-Multi-WAL");
    const summary = await worker.queueManager.reconcileWalAndOrphans();
    expect(summary.reconciledWalCount).toBe(2);

    // Assertions:
    // 1. Both logical submissions reconstructed
    const queue = await env.getDurableQueue();
    expect(queue).toHaveLength(2);

    const itemA = queue.find((i) => i.id === entityIdA);
    const itemB = queue.find((i) => i.id === entityIdB);
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemA!.submissionId).toBe(subA.submissionId);
    expect(itemB!.submissionId).toBe(subB.submissionId);
    expect(itemA!.contentHash).toBe(itemB!.contentHash);

    // 2. Both payload identities remain distinct
    const payloads = await env.getDurablePayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads.find((p) => p.id === payloadIdA)).toBeDefined();
    expect(payloads.find((p) => p.id === payloadIdB)).toBeDefined();

    // 3. Both WAL entries deleted
    expect(await env.getDurableWalEntries()).toHaveLength(0);

    // 4. Recovery remains deterministic on repeat
    const summary2 = await worker.queueManager.reconcileWalAndOrphans();
    expect(summary2.reconciledWalCount).toBe(0);
    expect(await env.getDurableQueue()).toHaveLength(2);

    env.discardWorker(worker);
  });

  // ==========================================================================
  // WAL-REC-04 — Stale Recovery Mutation Under Superseded Lease
  // ==========================================================================
  it("WAL-REC-04: rejects stale recovery mutation under superseded lease", async () => {
    // Disable Web Locks to isolate and verify pure persistent lease recovery
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    const opId = "wal_op_rec_04";
    const itemId = "item_rec_04";
    const payloadId = `payload:${itemId}`;
    const sub = createSubmission(itemId, {
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 404; }\n",
    });

    // Place into recoverable Boundary C state: WAL INTENT + payload exists, metadata missing
    const walEntry: WalEntry = {
      id: opId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: itemId,
      payloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: virtualTime,
      updatedAt: virtualTime,
      snapshot: {
        submission: sub,
      },
    };
    await env.sharedPayloadDriver.putWalEntry(walEntry);
    await env.sharedPayloadDriver.putPayload({
      id: payloadId,
      sourceCode: sub.sourceCode,
      createdAt: virtualTime,
    });

    // 1. Worker A boots and acquires lease (fence 1)
    const workerA = env.createWorker("Worker-A");
    const acqA = await workerA.concurrency.acquirePersistentLease(
      workerA.workerId,
      "startup",
    );
    expect(acqA.acquired).toBe(true);
    expect(acqA.fencingToken).toBe(1);

    // Configure Worker A to pause immediately after reading WAL but BEFORE committing recovery mutation
    let unpauseWorkerA!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      unpauseWorkerA = resolve;
    });

    let notifyWorkerAPaused!: () => void;
    const workerAPausedPromise = new Promise<void>((resolve) => {
      notifyWorkerAPaused = resolve;
    });

    // Hook Worker A's storageDriver.set to pause at metadata commit
    const originalSet = workerA.storageDriver.set.bind(workerA.storageDriver);
    let workerAPaused = false;
    workerA.storageDriver.set = async (items: Record<string, unknown>) => {
      if (items[STORAGE_KEYS.QUEUE_METADATA] && !workerAPaused) {
        workerAPaused = true;
        notifyWorkerAPaused();
        // Pause Worker A at the controlled mutation boundary
        await pausePromise;
        // Upon resume, Worker A must validate its fencing token before mutation
        await workerA.concurrency.validateFencingToken(
          workerA.workerId,
          acqA.fencingToken,
        );
      }
      return await originalSet(items);
    };

    // Launch Worker A recovery pass asynchronously
    const recoveryPromiseA = workerA.queueManager.reconcileWalAndOrphans();

    // Deterministically await Worker A reaching the mutation barrier
    await workerAPausedPromise;
    expect(workerAPaused).toBe(true);

    // 2. Advance virtual time past Worker A lease TTL (30s)
    virtualTime += 35_000;

    // 3. Worker B boots from shared durable storage and reclaims lease (fence 2)
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    const acqB = await workerB.concurrency.acquirePersistentLease(
      workerB.workerId,
      "startup",
    );
    expect(acqB.acquired).toBe(true);
    expect(acqB.fencingToken).toBe(2);

    // Verify durable lease belongs to Worker B with fence 2
    const leaseDurable = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseDurable.workerId).toBe(workerB.workerId);
    expect(leaseDurable.fencingToken).toBe(2);

    // 4. Resume Worker A: Worker A attempts to proceed with recovery mutation
    unpauseWorkerA();

    // Worker A MUST be rejected fail-closed with StaleLeaseError
    await expect(recoveryPromiseA).rejects.toThrow(StaleLeaseError);

    // 5. Assert: Stale Worker A did NOT mutate durable state
    expect(await env.getDurableQueue()).toHaveLength(0); // Metadata NOT committed by Worker A!
    expect(await env.getDurableWalEntries()).toHaveLength(1); // WAL NOT deleted by Worker A!
    expect(await env.getDurablePayloads()).toHaveLength(1); // Payload NOT deleted by Worker A!

    // 6. Worker B can subsequently recover the WAL safely
    const reconB = await workerB.queueManager.reconcileWalAndOrphans();
    expect(reconB.reconciledWalCount).toBe(1);

    const queueFinal = await env.getDurableQueue();
    expect(queueFinal).toHaveLength(1);
    expect(queueFinal[0]!.id).toBe(itemId);
    expect(queueFinal[0]!.state).toBe(QueueState.PENDING);
    expect(await env.getDurableWalEntries()).toHaveLength(0);

    env.discardWorker(workerA);
    env.discardWorker(workerB);
  });
});
