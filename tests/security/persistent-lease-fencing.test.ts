import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createCrashTestEnvironment,
  buildCandidateSubmission,
  createExtensionMessage,
  type CrashTestEnvironment,
} from "../helpers/crash-harness";
import {
  QueueState,
  type QueueLeaseRecord,
} from "../../src/shared/storage/types";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { StaleLeaseError } from "../../src/shared/errors";

describe("Phase 1C.4.3.2.2.1 — Persistent Lease & Fencing Integration Suite", () => {
  let env: CrashTestEnvironment;
  let originalLocks: LockManager | undefined;

  beforeEach(async () => {
    originalLocks = globalThis.navigator?.locks;
    env = createCrashTestEnvironment();
    await env.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocks !== undefined) {
      Object.defineProperty(globalThis.navigator, "locks", {
        value: originalLocks,
        configurable: true,
      });
    }
  });

  // ==========================================================================
  // FENCE-INT-01 — Multi-Generation Lease Takeover (>2 Generations)
  // ==========================================================================
  it("FENCE-INT-01: preserves monotonically increasing fencing across three successive worker generations", async () => {
    // Disable Web Locks to isolate and verify pure persistent lease recovery
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // ------------------------------------------------------------------------
    // Generation 1: Worker A boots and acquires lease
    // ------------------------------------------------------------------------
    const workerA = env.createWorker("Worker-A");
    const acqA = await workerA.concurrency.acquirePersistentLease(
      workerA.workerId,
      "startup",
    );
    expect(acqA.acquired).toBe(true);
    expect(acqA.fencingToken).toBe(1);

    // Verify durable lease state in storage.local for Generation 1
    const leaseA = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseA.workerId).toBe(workerA.workerId);
    expect(leaseA.fencingToken).toBe(1);

    // Worker A validates its own fence
    await expect(
      workerA.concurrency.validateFencingToken(workerA.workerId, 1),
    ).resolves.toBeUndefined();

    // Advance virtual time past lease TTL (30s) so Worker A's lease expires
    virtualTime += 35_000;

    // ------------------------------------------------------------------------
    // Generation 2: Worker B boots from shared durable storage
    // ------------------------------------------------------------------------
    const workerB = env.createWorker("Worker-B");

    // Fresh-Context Assertions: Worker B must not share memory with Worker A
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.concurrency).not.toBe(workerA.concurrency);
    expect(workerB.storage).not.toBe(workerA.storage);
    expect(workerB.payloadStorage).not.toBe(workerA.payloadStorage);

    // Worker B reclaims expired lease
    const acqB = await workerB.concurrency.acquirePersistentLease(
      workerB.workerId,
      "startup",
    );
    expect(acqB.acquired).toBe(true);
    expect(acqB.fencingToken).toBe(2);

    // Verify durable lease state in storage.local for Generation 2
    const leaseB = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseB.workerId).toBe(workerB.workerId);
    expect(leaseB.fencingToken).toBe(2);

    // Assert: Worker B cannot validate Worker A's old fence (token 1)
    await expect(
      workerB.concurrency.validateFencingToken(workerB.workerId, 1),
    ).rejects.toThrow(StaleLeaseError);

    // Assert: Stale Worker A cannot validate after Generation 2 takeover
    await expect(
      workerA.concurrency.validateFencingToken(workerA.workerId, 1),
    ).rejects.toThrow(StaleLeaseError);

    // Advance virtual time past lease TTL again
    virtualTime += 35_000;

    // ------------------------------------------------------------------------
    // Generation 3: Worker C boots from shared durable storage
    // ------------------------------------------------------------------------
    const workerC = env.createWorker("Worker-C");

    // Fresh-Context Assertions: Worker C must be completely distinct
    expect(workerC.queueManager).not.toBe(workerB.queueManager);
    expect(workerC.queueManager).not.toBe(workerA.queueManager);
    expect(workerC.concurrency).not.toBe(workerB.concurrency);
    expect(workerC.concurrency).not.toBe(workerA.concurrency);
    expect(workerC.storage).not.toBe(workerB.storage);
    expect(workerC.storage).not.toBe(workerA.storage);

    // Worker C reclaims expired lease
    const acqC = await workerC.concurrency.acquirePersistentLease(
      workerC.workerId,
      "startup",
    );
    expect(acqC.acquired).toBe(true);
    expect(acqC.fencingToken).toBe(3);

    // Strictly monotonic sequence verification across three successive generations
    expect(acqA.fencingToken).toBe(1);
    expect(acqB.fencingToken).toBe(2);
    expect(acqC.fencingToken).toBe(3);
    expect(acqA.fencingToken < acqB.fencingToken).toBe(true);
    expect(acqB.fencingToken < acqC.fencingToken).toBe(true);

    // Assert: Worker C cannot validate Worker B's fence (token 2)
    await expect(
      workerC.concurrency.validateFencingToken(workerC.workerId, 2),
    ).rejects.toThrow(StaleLeaseError);

    // Assert: Worker A cannot validate after Worker C is authoritative
    await expect(
      workerA.concurrency.validateFencingToken(workerA.workerId, 1),
    ).rejects.toThrow(StaleLeaseError);

    // Assert: Worker B cannot validate after Worker C is authoritative
    await expect(
      workerB.concurrency.validateFencingToken(workerB.workerId, 2),
    ).rejects.toThrow(StaleLeaseError);

    // Assert: Worker C is the sole authoritative current owner
    await expect(
      workerC.concurrency.validateFencingToken(workerC.workerId, 3),
    ).resolves.toBeUndefined();

    // Durable storage verification: contains Worker C's lease with token 3
    const leaseC = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseC.workerId).toBe(workerC.workerId);
    expect(leaseC.fencingToken).toBe(3);

    env.discardWorker(workerA);
    env.discardWorker(workerB);
    env.discardWorker(workerC);
  });

  // ==========================================================================
  // FENCE-INT-02 — Orderly Release + Token Recycling
  // ==========================================================================
  it("FENCE-INT-02: rejects stale authority after orderly release even when a new session reuses the same numeric fencing token", async () => {
    // Disable Web Locks to isolate and verify pure persistent lease semantics
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // ------------------------------------------------------------------------
    // Session 1: Worker A acquires lease with fence 1
    // ------------------------------------------------------------------------
    const workerA = env.createWorker("Worker-A");
    const acqA = await workerA.concurrency.acquirePersistentLease(
      workerA.workerId,
      "startup",
    );
    expect(acqA.acquired).toBe(true);
    expect(acqA.fencingToken).toBe(1);

    // Retain Worker A's identity and fence
    const workerAId = workerA.workerId;
    const fenceA = acqA.fencingToken;

    // Worker A validates successfully while active
    await expect(
      workerA.concurrency.validateFencingToken(workerAId, fenceA),
    ).resolves.toBeUndefined();

    // Worker A completes normally and releases its lease in an orderly fashion
    await workerA.concurrency.releaseLease(workerAId, fenceA);

    // Verify durable lease is completely absent from storage.local
    const leaseAfterRelease = await env.sharedStorageDriver.get([
      STORAGE_KEYS.QUEUE_LEASE,
    ]);
    expect(leaseAfterRelease[STORAGE_KEYS.QUEUE_LEASE]).toBeUndefined();

    // Advance virtual time by 5 minutes before Session 2 starts
    virtualTime += 300_000;

    // ------------------------------------------------------------------------
    // Session 2: Fresh Worker B starts a new independent session
    // ------------------------------------------------------------------------
    const workerB = env.createWorker("Worker-B");
    expect(workerB.workerId).not.toBe(workerAId);
    expect(workerB.concurrency).not.toBe(workerA.concurrency);

    // Worker B independently acquires the new lease
    const acqB = await workerB.concurrency.acquirePersistentLease(
      workerB.workerId,
      "startup",
    );
    expect(acqB.acquired).toBe(true);

    // Crucial Architectural Property:
    // Worker B legitimately receives fencingToken = 1 because the previous lease was orderly removed
    expect(acqB.fencingToken).toBe(1);
    expect(acqB.fencingToken).toBe(fenceA);

    // ------------------------------------------------------------------------
    // Simulate delayed/stale Worker A attempting actions with its old authority
    // ------------------------------------------------------------------------

    // 1. Worker A attempts validateFencingToken(workerA, fence=1):
    // MUST FAIL CLOSED with StaleLeaseError because storage contains workerBId
    await expect(
      workerA.concurrency.validateFencingToken(workerAId, fenceA),
    ).rejects.toThrow(StaleLeaseError);

    // 2. Worker A attempts releaseLease(workerA, fence=1):
    // MUST NOT remove Worker B's lease
    await workerA.concurrency.releaseLease(workerAId, fenceA);
    const leaseAfterStaleRelease = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseAfterStaleRelease).toBeDefined();
    expect(leaseAfterStaleRelease.workerId).toBe(workerB.workerId);
    expect(leaseAfterStaleRelease.fencingToken).toBe(1);

    // 3. Worker A attempts renewHeartbeat(workerA, fence=1):
    // MUST return false without mutating Worker B's lease
    const renewedByA = await workerA.concurrency.renewHeartbeat(
      workerAId,
      fenceA,
    );
    expect(renewedByA).toBe(false);
    const leaseAfterStaleRenew = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(leaseAfterStaleRenew.workerId).toBe(workerB.workerId);

    // 4. Worker B's validation with (workerB.workerId, 1) remains fully authoritative
    await expect(
      workerB.concurrency.validateFencingToken(workerB.workerId, 1),
    ).resolves.toBeUndefined();

    // 5. Worker B orderly releases its own lease when done
    await workerB.concurrency.releaseLease(workerB.workerId, 1);
    const leaseFinal = await env.sharedStorageDriver.get([
      STORAGE_KEYS.QUEUE_LEASE,
    ]);
    expect(leaseFinal[STORAGE_KEYS.QUEUE_LEASE]).toBeUndefined();

    // 6. When no lease is active, Worker A is STILL rejected fail-closed
    await expect(
      workerA.concurrency.validateFencingToken(workerAId, fenceA),
    ).rejects.toThrow(StaleLeaseError);

    env.discardWorker(workerA);
    env.discardWorker(workerB);
  });

  // ==========================================================================
  // FENCE-INT-03 — Stale Worker Error / Failure Mutation Boundary
  // ==========================================================================
  it("FENCE-INT-03: rejects superseded worker at the handler-error mutation boundary", async () => {
    // Disable Web Locks to isolate persistent lease takeover
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // ------------------------------------------------------------------------
    // Setup: Worker A boots and enqueues candidate submission
    // ------------------------------------------------------------------------
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 3; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Verify item is PENDING in durable queue with attempts = 0
    const queueBefore = await env.getDurableQueue();
    expect(queueBefore).toHaveLength(1);
    expect(queueBefore[0]!.state).toBe(QueueState.PENDING);
    expect(queueBefore[0]!.attempts).toBe(0);

    // Controlled failure injection:
    // Pause Worker A inside handler before pre-flight GET, and configure it
    // to throw an unhandled network error when unpaused.
    let unpauseWorkerA!: () => void;
    const pausePromise = new Promise<void>((resolve) => {
      unpauseWorkerA = resolve;
    });

    workerA.gitHubContentsService.onBeforePreFlightGet = async () => {
      await pausePromise;
      throw new Error(
        "GitHub API transport failure: Connection reset by peer mid-flight",
      );
    };

    // Launch Worker A drain pass asynchronously
    const drainPromiseA = workerA.queueDrainer.drain("submission_event");

    // Allow Worker A to claim item into PROCESSING under fence 1
    await new Promise((r) => setTimeout(r, 10));

    // Assert item is claimed by Worker A
    const queueDuringA = await env.getDurableQueue();
    expect(queueDuringA[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueDuringA[0]!.fencingToken).toBe(1);
    expect(queueDuringA[0]!.attempts).toBe(0);

    // Advance virtual time past lease TTL (30s) so Worker A's lease expires
    virtualTime += 35_000;

    // ------------------------------------------------------------------------
    // Worker B boots while Worker A is suspended
    // ------------------------------------------------------------------------
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Worker B executes startup drain:
    // Reclaims expired lease -> acquires fencing token 2 -> recovers item -> completes it
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.completed).toBe(1);

    // Verify Worker B completed the item and committed to storage
    const queueAfterB = await env.getDurableQueue();
    expect(queueAfterB[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueAfterB[0]!.fencingToken).toBe(2);
    expect(queueAfterB[0]!.attempts).toBe(0); // Crashes / takeovers do not increment attempts
    const workerBCommitSha = queueAfterB[0]!.commitSha;
    expect(workerBCommitSha).toBeDefined();

    // ------------------------------------------------------------------------
    // Unpause Worker A: Worker A resumes, throws in handler, enters catch path
    // ------------------------------------------------------------------------
    unpauseWorkerA();

    // Worker A MUST encounter StaleLeaseError at the catch-path mutation boundary (L549)!
    await expect(drainPromiseA).rejects.toThrow(StaleLeaseError);

    // Assert: Stale Worker A did NOT commit FAILED state, attempts increment, or lastError!
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED); // Remained COMPLETED by Worker B!
    expect(queueFinal[0]!.fencingToken).toBe(2); // Remained fence 2!
    expect(queueFinal[0]!.commitSha).toBe(workerBCommitSha); // Preserved Worker B's commit!
    expect(queueFinal[0]!.attempts).toBe(0); // NOT incremented to 1 by Worker A!
    expect(queueFinal[0]!.lastError).toBeUndefined(); // NOT overwritten with INVARIANT_VIOLATION!
    expect(queueFinal[0]!.nextRetryAt).toBeUndefined(); // No retry scheduled!

    // Assert: Worker A did NOT write an extra history entry
    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("synced");

    env.discardWorker(workerA);
    env.discardWorker(workerB);
  });

  // ==========================================================================
  // FENCE-INT-04 — Pure Tier-2 Concurrent Takeover Without Web Locks
  // ==========================================================================
  it("FENCE-INT-04: Probe-and-Verify resolves concurrent takeover attempts without Web Locks", async () => {
    // Disable Web Locks to verify pure Tier-2 Probe-and-Verify mutual exclusion
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    const virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Seed an expired lease in shared durable storage from crashed predecessor
    const crashedWorker = "crashed_worker";
    await env.sharedStorageDriver.set({
      [STORAGE_KEYS.QUEUE_LEASE]: {
        workerId: crashedWorker,
        fencingToken: 5,
        acquiredAt: virtualTime - 40_000,
        expiresAt: virtualTime - 10_000,
        maxLifetimeExpiresAt: virtualTime + 260_000,
        triggerSource: "alarm",
      },
    });

    // Create two genuinely independent workers from shared durable storage
    const workerB = env.createWorker("Worker-B");
    const workerC = env.createWorker("Worker-C");
    expect(workerB.workerId).not.toBe(workerC.workerId);
    expect(workerB.concurrency).not.toBe(workerC.concurrency);
    expect(workerB.storage).not.toBe(workerC.storage);

    // Orchestrate deterministic concurrency race via onBeforeCommit hook:
    // When Worker B reaches onBeforeCommit (having read expired lease and computed nextFencingToken = 6),
    // Worker C executes acquisition and successfully commits fence 6!
    let workerCRan = false;
    workerB.concurrency.onBeforeCommit = async () => {
      if (!workerCRan) {
        workerCRan = true;
        // Worker C acquires the lease directly
        const acqC = await workerC.concurrency.acquirePersistentLease(
          workerC.workerId,
          "startup",
        );
        expect(acqC.acquired).toBe(true);
        expect(acqC.fencingToken).toBe(6);

        // Verify Worker C holds the authoritative lease in durable storage
        const leaseAfterC = (
          await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
        )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
        expect(leaseAfterC.workerId).toBe(workerC.workerId);
        expect(leaseAfterC.fencingToken).toBe(6);
      }
    };

    // Worker B attempts to acquire the lease concurrently
    const acqB = await workerB.concurrency.acquirePersistentLease(
      workerB.workerId,
      "alarm",
    );

    // Assert: Worker B MUST yield with acquired: false due to pre-commit collision check
    expect(acqB.acquired).toBe(false);
    expect(acqB.fencingToken).toBe(6);
    expect(acqB.reason).toContain("Interleaving lease acquired by worker");
    expect(workerCRan).toBe(true);

    // Assert: Exactly ONE worker became authoritative (Worker C)
    const currentLease = (
      await env.sharedStorageDriver.get([STORAGE_KEYS.QUEUE_LEASE])
    )[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord;
    expect(currentLease.workerId).toBe(workerC.workerId);
    expect(currentLease.fencingToken).toBe(6);

    // Assert: Worker C is authoritative; Worker B is rejected fail-closed
    await expect(
      workerC.concurrency.validateFencingToken(workerC.workerId, 6),
    ).resolves.toBeUndefined();
    await expect(
      workerB.concurrency.validateFencingToken(workerB.workerId, 6),
    ).rejects.toThrow(StaleLeaseError);

    // Clean up
    await workerC.concurrency.releaseLease(workerC.workerId, 6);
    env.discardWorker(workerB);
    env.discardWorker(workerC);
  });
});
