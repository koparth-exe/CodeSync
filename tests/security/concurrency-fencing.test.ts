import { describe, expect, it, beforeEach } from "vitest";
import {
  QueueConcurrencyManager,
  MAX_WORKER_OWNERSHIP_MS,
} from "../../src/shared/queue/concurrency";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import type { QueueLeaseRecord } from "../../src/shared/storage/types";
import { StaleLeaseError } from "../../src/shared/errors";

class ControlledStorageDriver implements LocalStorageDriver {
  public map = new Map<string, unknown>();
  public onBeforeSet?: (() => Promise<void>) | undefined;

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
    if (this.onBeforeSet) {
      await this.onBeforeSet();
    }
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

describe("Adversarial Concurrency Interleaving & Fencing Suite (Section 6 & 7)", () => {
  let driver: ControlledStorageDriver;
  let storage: StorageService;
  let concurrency: QueueConcurrencyManager;

  beforeEach(() => {
    driver = new ControlledStorageDriver();
    storage = new StorageService(driver);
    concurrency = new QueueConcurrencyManager(storage);
  });

  it("Deterministic Interleaving: Worker A paused mid-probe, Worker B acquires with newer token, Worker A yields", async () => {
    const workerA = "worker_A";
    const workerB = "worker_B";

    // Setup initial expired lease with fencingToken = 1
    const expiredLease: QueueLeaseRecord = {
      workerId: "crashed_worker",
      fencingToken: 1,
      acquiredAt: Date.now() - 40_000,
      expiresAt: Date.now() - 10_000,
      maxLifetimeExpiresAt: Date.now() + 260_000,
      triggerSource: "alarm",
    };
    await storage.setLease(expiredLease);

    // When Worker A pauses before committing ownership, Worker B executes acquisition first!
    let workerBExecuted = false;
    concurrency.onBeforeCommit = async () => {
      if (!workerBExecuted) {
        workerBExecuted = true;
        // Worker B acquires the lease right here
        const resB = await concurrency.acquirePersistentLease(workerB, "alarm");
        expect(resB.acquired).toBe(true);
        expect(resB.fencingToken).toBe(2);
      }
    };

    // Worker A runs probe
    const resA = await concurrency.acquirePersistentLease(
      workerA,
      "manual_retry",
    );

    // Worker A MUST fail due to interleaving acquisition by Worker B
    expect(resA.acquired).toBe(false);
    expect(resA.reason).toBeDefined();

    // Worker B remains authoritative with fencingToken = 2
    const currentLease = await storage.getLease();
    expect(currentLease?.workerId).toBe(workerB);
    expect(currentLease?.fencingToken).toBe(2);
  });

  it("Stale Worker Mutation Rejections: Stale token N cannot mutate state when token N+1 exists", async () => {
    const workerA = "worker_A";
    const workerB = "worker_B";

    // Worker A acquires lease with token 1
    const acqA = await concurrency.acquirePersistentLease(workerA, "startup");
    expect(acqA.fencingToken).toBe(1);

    // Worker A's token 1 is initially valid
    await expect(
      concurrency.validateFencingToken(workerA, 1),
    ).resolves.toBeUndefined();

    // Fast-forward / expire lease, and Worker B acquires lease with token 2
    const lease = (await storage.getLease())!;
    lease.expiresAt = Date.now() - 1000;
    await storage.setLease(lease);

    const acqB = await concurrency.acquirePersistentLease(workerB, "alarm");
    expect(acqB.fencingToken).toBe(2);

    // 1. Worker A attempts queue mutation with token 1 -> MUST BE REJECTED
    await expect(concurrency.validateFencingToken(workerA, 1)).rejects.toThrow(
      StaleLeaseError,
    );

    // 2. Worker A attempts heartbeat renewal with token 1 -> MUST BE REJECTED
    const renewed = await concurrency.renewHeartbeat(workerA, 1);
    expect(renewed).toBe(false);

    // 3. Worker A attempts orderly release with token 1 -> MUST NOT touch Worker B's lease
    await concurrency.releaseLease(workerA, 1);
    const leaseAfterStaleRelease = await storage.getLease();
    expect(leaseAfterStaleRelease?.workerId).toBe(workerB);
    expect(leaseAfterStaleRelease?.fencingToken).toBe(2);

    // Worker B with token 2 remains fully authoritative
    await expect(
      concurrency.validateFencingToken(workerB, 2),
    ).resolves.toBeUndefined();
  });

  it("Enforces 5-minute absolute lifetime ceiling even with continuous heartbeats", async () => {
    const workerId = "marathon_worker";
    const acq = await concurrency.acquirePersistentLease(workerId, "alarm");
    const token = acq.fencingToken;

    // Simulate 4 minutes of successful heartbeats
    const lease = (await storage.getLease())!;
    expect(lease.maxLifetimeExpiresAt).toBe(
      lease.acquiredAt + MAX_WORKER_OWNERSHIP_MS,
    );

    // Fast-forward to 5 minutes + 1 ms
    (lease as { maxLifetimeExpiresAt: number }).maxLifetimeExpiresAt =
      Date.now() - 1;
    await storage.setLease(lease);

    // Heartbeat MUST fail because ceiling was hit
    const renewed = await concurrency.renewHeartbeat(workerId, token);
    expect(renewed).toBe(false);
  });
});

describe("Web Locks Failure & Unavailability Resilience Suite (Section 8)", () => {
  let driver: ControlledStorageDriver;
  let storage: StorageService;
  let concurrency: QueueConcurrencyManager;

  beforeEach(() => {
    driver = new ControlledStorageDriver();
    storage = new StorageService(driver);
    concurrency = new QueueConcurrencyManager(storage);
  });

  it("falls back safely to persistent lease when Web Locks API throws unexpectedly", async () => {
    // Mock navigator.locks.request to throw
    const originalLocks = globalThis.navigator?.locks;
    try {
      Object.defineProperty(globalThis.navigator, "locks", {
        value: {
          request: async () => {
            throw new Error("Simulated Web Locks internal failure");
          },
        },
        configurable: true,
      });

      let executed = false;
      const result = await concurrency.runExclusively(
        "alarm",
        async (workerId, fencingToken, renew) => {
          executed = true;
          expect(typeof workerId).toBe("string");
          expect(fencingToken).toBeGreaterThanOrEqual(1);
          await renew();
          return "fallback_success";
        },
      );

      // Successfully executed via persistent lease fallback!
      expect(executed).toBe(true);
      expect(result).toBe("fallback_success");
    } finally {
      if (originalLocks) {
        Object.defineProperty(globalThis.navigator, "locks", {
          value: originalLocks,
          configurable: true,
        });
      }
    }
  });

  it("coordinates safely using persistent lease when navigator.locks is unavailable", async () => {
    // Simulate runtime without navigator.locks
    const originalLocks = globalThis.navigator?.locks;
    try {
      Object.defineProperty(globalThis.navigator, "locks", {
        value: undefined,
        configurable: true,
      });

      let executed = false;
      const result = await concurrency.runExclusively(
        "submission_event",
        async (workerId, fencingToken) => {
          executed = true;
          expect(fencingToken).toBe(1);
          return "pure_lease_success";
        },
      );

      expect(executed).toBe(true);
      expect(result).toBe("pure_lease_success");

      // Lease properly released after run
      expect(await storage.getLease()).toBeNull();
    } finally {
      if (originalLocks) {
        Object.defineProperty(globalThis.navigator, "locks", {
          value: originalLocks,
          configurable: true,
        });
      }
    }
  });

  it("reclaims expired persistent lease even when Web Lock was released unexpectedly", async () => {
    // Simulate previous worker dying while holding lock/lease
    const crashedWorker = "crashed_worker";
    await storage.setLease({
      workerId: crashedWorker,
      fencingToken: 5,
      acquiredAt: Date.now() - 40_000,
      expiresAt: Date.now() - 10_000, // Expired
      maxLifetimeExpiresAt: Date.now() + 260_000,
      triggerSource: "alarm",
    });

    const newWorker = "recovery_worker";
    const res = await concurrency.acquirePersistentLease(newWorker, "startup");

    expect(res.acquired).toBe(true);
    expect(res.workerId).toBe(newWorker);
    expect(res.fencingToken).toBe(6); // Incremented from 5 to 6
  });
});
