import { describe, expect, it, beforeEach } from "vitest";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import type { QueueLeaseRecord } from "../../src/shared/storage/types";
import { StaleLeaseError } from "../../src/shared/errors";

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

describe("Queue Concurrency & Fenced Lease Model Suite (S8)", () => {
  let driver: MemoryStorageDriver;
  let storage: StorageService;
  let concurrency: QueueConcurrencyManager;

  beforeEach(() => {
    driver = new MemoryStorageDriver();
    storage = new StorageService(driver);
    concurrency = new QueueConcurrencyManager(storage);
  });

  it("successfully acquires an available persistent lease with fencingToken = 1", async () => {
    const workerId = crypto.randomUUID();
    const result = await concurrency.acquirePersistentLease(
      workerId,
      "submission_event",
    );

    expect(result.acquired).toBe(true);
    expect(result.workerId).toBe(workerId);
    expect(result.fencingToken).toBe(1);

    const lease = await storage.getLease();
    expect(lease).not.toBeNull();
    expect(lease?.workerId).toBe(workerId);
    expect(lease?.fencingToken).toBe(1);
    expect(lease?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects concurrent lease acquisition while active lease is held by another worker", async () => {
    const workerA = crypto.randomUUID();
    const workerB = crypto.randomUUID();

    const resultA = await concurrency.acquirePersistentLease(workerA, "alarm");
    expect(resultA.acquired).toBe(true);

    const resultB = await concurrency.acquirePersistentLease(
      workerB,
      "submission_event",
    );
    expect(resultB.acquired).toBe(false);
    expect(resultB.reason).toContain("Active lease held by worker");

    // Storage still holds workerA lease
    const lease = await storage.getLease();
    expect(lease?.workerId).toBe(workerA);
  });

  it("permits re-entrant lease acquisition by the same workerId preserving fencingToken", async () => {
    const workerId = crypto.randomUUID();

    const first = await concurrency.acquirePersistentLease(workerId, "startup");
    expect(first.acquired).toBe(true);
    expect(first.fencingToken).toBe(1);

    const second = await concurrency.acquirePersistentLease(
      workerId,
      "startup",
    );
    expect(second.acquired).toBe(true);
    expect(second.fencingToken).toBe(1);
  });

  it("reclaims stale lease when expired and increments fencingToken monotonically", async () => {
    const crashedWorker = crypto.randomUUID();
    const staleLease: QueueLeaseRecord = {
      workerId: crashedWorker,
      fencingToken: 1,
      acquiredAt: Date.now() - 40_000,
      expiresAt: Date.now() - 10_000, // Expired 10 seconds ago
      maxLifetimeExpiresAt: Date.now() + 260_000,
      triggerSource: "alarm",
    };
    await storage.setLease(staleLease);

    const newWorker = crypto.randomUUID();
    const result = await concurrency.acquirePersistentLease(
      newWorker,
      "submission_event",
    );

    expect(result.acquired).toBe(true);
    expect(result.workerId).toBe(newWorker);
    expect(result.fencingToken).toBe(2); // Monotonically incremented 1 -> 2

    const currentLease = await storage.getLease();
    expect(currentLease?.workerId).toBe(newWorker);
    expect(currentLease?.fencingToken).toBe(2);
  });

  it("stale worker with superseded fencing token is rejected on mutation", async () => {
    const workerA = crypto.randomUUID();
    const leaseA = await concurrency.acquirePersistentLease(workerA, "alarm");
    expect(leaseA.fencingToken).toBe(1);

    // Worker A's token is valid initially
    await expect(
      concurrency.validateFencingToken(workerA, 1),
    ).resolves.toBeUndefined();

    // Fast-forward or simulate expiration: Worker B reclaims lease with token 2
    const current = (await storage.getLease())!;
    current.expiresAt = Date.now() - 1000;
    await storage.setLease(current);

    const workerB = crypto.randomUUID();
    const leaseB = await concurrency.acquirePersistentLease(workerB, "alarm");
    expect(leaseB.fencingToken).toBe(2);

    // Stale Worker A now attempts mutation with token 1: MUST FAIL
    await expect(concurrency.validateFencingToken(workerA, 1)).rejects.toThrow(
      StaleLeaseError,
    );

    // Worker B with token 2 succeeds
    await expect(
      concurrency.validateFencingToken(workerB, 2),
    ).resolves.toBeUndefined();
  });

  it("renews lease heartbeat and extends expiresAt", async () => {
    const workerId = crypto.randomUUID();
    const acq = await concurrency.acquirePersistentLease(workerId, "alarm");

    const initialLease = await storage.getLease();
    const initialExpiry = initialLease?.expiresAt ?? 0;

    await new Promise((r) => setTimeout(r, 10));

    const renewed = await concurrency.renewHeartbeat(
      workerId,
      acq.fencingToken,
    );
    expect(renewed).toBe(true);

    const updatedLease = await storage.getLease();
    expect(updatedLease?.expiresAt).toBeGreaterThanOrEqual(initialExpiry);
  });

  it("enforces maximum worker ownership ceiling (5 minutes)", async () => {
    const workerId = crypto.randomUUID();
    const acq = await concurrency.acquirePersistentLease(workerId, "alarm");

    // Simulate worker running up against the 5-minute cap:
    const lease = (await storage.getLease())!;
    // Set maxLifetimeExpiresAt to the past
    lease.expiresAt = Date.now() + 10_000;
    (lease as { maxLifetimeExpiresAt: number }).maxLifetimeExpiresAt =
      Date.now() - 1000;
    await storage.setLease(lease);

    // Heartbeat renewal must fail
    const renewed = await concurrency.renewHeartbeat(
      workerId,
      acq.fencingToken,
    );
    expect(renewed).toBe(false);
  });

  it("orderly releases lease only if caller owns matching workerId and fencingToken", async () => {
    const workerA = crypto.randomUUID();
    const workerB = crypto.randomUUID();

    const acqA = await concurrency.acquirePersistentLease(workerA, "alarm");

    // WorkerB attempts to release WorkerA's lease
    await concurrency.releaseLease(workerB, acqA.fencingToken);

    // Lease for workerA must remain intact
    let lease = await storage.getLease();
    expect(lease?.workerId).toBe(workerA);

    // WorkerA attempts with wrong fencingToken
    await concurrency.releaseLease(workerA, 999);
    lease = await storage.getLease();
    expect(lease?.workerId).toBe(workerA);

    // WorkerA releases with matching workerId and fencingToken
    await concurrency.releaseLease(workerA, acqA.fencingToken);
    lease = await storage.getLease();
    expect(lease).toBeNull();
  });

  it("executes tasks exclusively using runExclusively with fencing token passed", async () => {
    let executed = false;
    const result = await concurrency.runExclusively(
      "submission_event",
      async (workerId, fencingToken, renew) => {
        executed = true;
        expect(typeof workerId).toBe("string");
        expect(fencingToken).toBeGreaterThanOrEqual(1);
        await renew();
        return 42;
      },
    );

    expect(executed).toBe(true);
    expect(result).toBe(42);

    // Lease should be cleared after orderly completion
    const lease = await storage.getLease();
    expect(lease).toBeNull();
  });
});
