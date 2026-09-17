import { StorageService, defaultStorageService } from "../storage/local";
import type { QueueLeaseRecord } from "../storage/types";
import { getBrowserCapabilities } from "../browser";
import { StaleLeaseError } from "../errors";

export const LEASE_TTL_MS = 30_000; // 30 seconds
export const HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
export const MAX_WORKER_OWNERSHIP_MS = 300_000; // 5 minutes maximum lifetime
export const WEB_LOCK_NAME = "codesync_queue_drain";

export type TriggerSource =
  "alarm" | "submission_event" | "manual_retry" | "startup";

export interface LeaseAcquisitionResult {
  readonly acquired: boolean;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly reason?: string;
}

/**
 * Manages two-tier concurrency control:
 * Tier 1: Native Web Locks API (navigator.locks) for in-session active mutual exclusion.
 * Tier 2: Persistent storage lease record with monotonic fencing tokens and Probe-and-Verify
 *         for cross-session durable coordination and stale-worker protection.
 */
export class QueueConcurrencyManager {
  private storage: StorageService;
  public onBeforeCommit?: (() => Promise<void>) | undefined;

  constructor(storage?: StorageService) {
    this.storage = storage ?? defaultStorageService;
  }

  /**
   * Executes Probe-and-Verify persistent lease acquisition with monotonic fencing tokens.
   */
  async acquirePersistentLease(
    workerId: string,
    triggerSource: TriggerSource,
  ): Promise<LeaseAcquisitionResult> {
    const now = Date.now();
    const existing = await this.storage.getLease();

    // Step 1: Check existing lease
    if (existing && now < existing.expiresAt) {
      if (existing.workerId === workerId) {
        // Re-entrant acquisition by same worker with same fencing token
        return {
          acquired: true,
          workerId,
          fencingToken: existing.fencingToken,
        };
      }
      // Active lease owned by another worker; yield immediately
      return {
        acquired: false,
        workerId,
        fencingToken: existing.fencingToken,
        reason: `Active lease held by worker ${existing.workerId} (token ${existing.fencingToken}) until ${existing.expiresAt}.`,
      };
    }

    // Step 2: Compute next monotonic fencing token
    const nextFencingToken = existing ? existing.fencingToken + 1 : 1;

    // Optional pause hook to test deterministic concurrency interleavings
    if (this.onBeforeCommit) {
      await this.onBeforeCommit();
    }

    // Re-verify immediately before write to prevent overwriting an interleaving worker
    const preCommitCheck = await this.storage.getLease();
    if (
      preCommitCheck &&
      now < preCommitCheck.expiresAt &&
      preCommitCheck.workerId !== workerId
    ) {
      return {
        acquired: false,
        workerId,
        fencingToken: preCommitCheck.fencingToken,
        reason: `Interleaving lease acquired by worker ${preCommitCheck.workerId} (token ${preCommitCheck.fencingToken}) before commit.`,
      };
    }

    // Probe candidate lease write
    const candidateLease: QueueLeaseRecord = {
      workerId,
      fencingToken: nextFencingToken,
      acquiredAt: now,
      expiresAt: now + LEASE_TTL_MS,
      maxLifetimeExpiresAt: now + MAX_WORKER_OWNERSHIP_MS,
      triggerSource,
    };
    await this.storage.setLease(candidateLease);

    // Step 3: Verification read-back
    const verified = await this.storage.getLease();
    if (
      verified &&
      verified.workerId === workerId &&
      verified.fencingToken === nextFencingToken
    ) {
      return { acquired: true, workerId, fencingToken: nextFencingToken };
    }

    // Race collision occurred; another worker overwrote candidate
    return {
      acquired: false,
      workerId,
      fencingToken: verified?.fencingToken ?? nextFencingToken,
      reason: "Lease collision detected during verification read-back.",
    };
  }

  /**
   * Renews heartbeat for active lease held by workerId and fencingToken.
   * Rejects renewal if lease was superseded or if max lifetime (5 minutes) is exceeded.
   */
  async renewHeartbeat(
    workerId: string,
    fencingToken: number,
  ): Promise<boolean> {
    const existing = await this.storage.getLease();
    if (
      !existing ||
      existing.workerId !== workerId ||
      existing.fencingToken !== fencingToken
    ) {
      return false; // Lease was superseded or released
    }

    const now = Date.now();
    // Enforce maximum worker ownership ceiling (5 minutes)
    if (now >= existing.maxLifetimeExpiresAt) {
      return false; // Max worker lifetime reached; must relinquish lease
    }

    const updated: QueueLeaseRecord = {
      ...existing,
      expiresAt: Math.min(now + LEASE_TTL_MS, existing.maxLifetimeExpiresAt),
    };
    await this.storage.setLease(updated);
    return true;
  }

  /**
   * Validates that the caller's fencing token is still authoritative.
   * Throws StaleLeaseError if the lease has been superseded by a newer generation.
   */
  async validateFencingToken(
    workerId: string,
    fencingToken: number,
  ): Promise<void> {
    const existing = await this.storage.getLease();
    if (
      !existing ||
      existing.workerId !== workerId ||
      existing.fencingToken !== fencingToken
    ) {
      const currentDesc = existing
        ? `worker ${existing.workerId}, token ${existing.fencingToken}`
        : "no active lease";
      throw new StaleLeaseError(
        `Worker ${workerId} (token ${fencingToken}) is stale. Current authoritative lease is ${currentDesc}.`,
      );
    }

    if (Date.now() > existing.expiresAt) {
      throw new StaleLeaseError(
        `Worker ${workerId} lease expired at ${existing.expiresAt}.`,
      );
    }
  }

  /**
   * Releases lease in an orderly fashion.
   * Invariant: Never removes a lease held by a different workerId or fencingToken.
   */
  async releaseLease(workerId: string, fencingToken: number): Promise<void> {
    const existing = await this.storage.getLease();
    if (
      existing &&
      existing.workerId === workerId &&
      existing.fencingToken === fencingToken
    ) {
      await this.storage.removeLease();
    }
  }

  /**
   * Coordinates execution under Tier 1 Web Lock and Tier 2 Persistent Lease with fencing.
   */
  async runExclusively<T>(
    triggerSource: TriggerSource,
    action: (
      workerId: string,
      fencingToken: number,
      renew: () => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T | null> {
    const workerId = crypto.randomUUID();
    const caps = getBrowserCapabilities();

    const executeWithLease = async (): Promise<T | null> => {
      const leaseResult = await this.acquirePersistentLease(
        workerId,
        triggerSource,
      );
      if (!leaseResult.acquired) {
        return null; // Yield gracefully when contended
      }

      const fencingToken = leaseResult.fencingToken;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      try {
        heartbeatTimer = setInterval(() => {
          this.renewHeartbeat(workerId, fencingToken).catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);

        const result = await action(workerId, fencingToken, () =>
          this.renewHeartbeat(workerId, fencingToken),
        );
        return result;
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        await this.releaseLease(workerId, fencingToken);
      }
    };

    // Tier 1: Web Locks API if supported and available
    if (
      caps.supportsWebLocks &&
      typeof navigator !== "undefined" &&
      navigator.locks
    ) {
      let lockAcquired = false;
      try {
        return await navigator.locks.request(
          WEB_LOCK_NAME,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (!lock) {
              // Another runtime execution context holds the Web Lock; yield immediately
              return null;
            }
            lockAcquired = true;
            return await executeWithLease();
          },
        );
      } catch (err) {
        if (lockAcquired) {
          throw err;
        }
        // If Web Locks throws unexpectedly, fallback securely to Tier 2 persistent lease
        return await executeWithLease();
      }
    }

    // Fall back directly to Tier 2 Persistent Lease when Web Locks unavailable
    return await executeWithLease();
  }
}

export const defaultConcurrencyManager = new QueueConcurrencyManager();
