import { StorageService, defaultStorageService } from "../storage/local";
import { PayloadStorage, defaultPayloadStorage } from "../storage/indexeddb";
import type {
  QueueItemMetadata,
  QueueItemPayload,
  SyncHistoryEntry,
  TargetSnapshot,
  WalEntry,
} from "../storage/types";
import { QueueState, WalPhase } from "../storage/types";
import {
  QueueConcurrencyManager,
  defaultConcurrencyManager,
  type TriggerSource,
} from "./concurrency";
import { computeBackoffDelay } from "./backoff";
import type {
  DrainSummary,
  NormalizedSubmission,
  ReconciliationResult,
  SyncResult,
} from "./types";
import { computeContentHash } from "../deduplication";
import { ErrorCode, QueueError } from "../errors";

export const MAX_QUEUE_ITEMS = 200;
export const MAX_ATTEMPTS = 5;
export const POISON_PILL_CRASH_THRESHOLD = 3;

/**
 * QueueManager executes durable Write-Ahead Logging (WAL) with idempotent recovery,
 * fenced state transitions, crash reconciliation, and poison-pill isolation.
 */
export class QueueManager {
  private storage: StorageService;
  private payloadStorage: PayloadStorage;
  private concurrency: QueueConcurrencyManager;

  constructor(
    storage?: StorageService,
    payloadStorage?: PayloadStorage,
    concurrency?: QueueConcurrencyManager,
  ) {
    this.storage = storage ?? defaultStorageService;
    this.payloadStorage = payloadStorage ?? defaultPayloadStorage;
    this.concurrency = concurrency ?? defaultConcurrencyManager;
  }

  /**
   * Enqueues a normalized submission following the Durable Write-Ahead Log (WAL) protocol:
   * 1. Validate operation (payload size, queue capacity).
   * 2. Generate unique operation ID and entity IDs.
   * 3. Persist WAL INTENT to IndexedDB (wal_logs).
   * 4. Perform mutations (IndexedDB payload, then storage.local metadata).
   * 5. Persist WAL COMMITTED.
   * 6. Cleanup WAL entry upon durable completion.
   */
  async enqueueSubmission(
    raw: NormalizedSubmission,
  ): Promise<QueueItemMetadata> {
    const queue = await this.storage.getQueueMetadata();

    // Step 1: Validate operation bounds
    const activeCount = queue.filter(
      (i) =>
        i.state === QueueState.PENDING ||
        i.state === QueueState.PROCESSING ||
        i.state === QueueState.FAILED,
    ).length;

    if (activeCount >= MAX_QUEUE_ITEMS) {
      throw new QueueError(
        `Queue capacity exceeded maximum limit of ${MAX_QUEUE_ITEMS} active items.`,
        ErrorCode.QUEUE_FULL,
        "Queue is full. Please review pending items or allow existing items to sync.",
      );
    }

    // Step 2: Compute content hash & check for active duplicate enqueue
    const contentHash =
      raw.contentHash ?? (await computeContentHash(raw.sourceCode));

    const duplicate = queue.find((i) => {
      // Duplicate detection only applies to active items (PENDING or PROCESSING)
      if (i.state !== QueueState.PENDING && i.state !== QueueState.PROCESSING) {
        return false;
      }

      // Hierarchy 1: Exact internal queue item ID match
      if (raw.id && i.id === raw.id) {
        return true;
      }

      // Hierarchy 2: If both items have a platform submission ID,
      // match strictly on platform + submissionId.
      // Two submissions with DIFFERENT submission IDs MUST NOT be collapsed
      // even if platform, problemSlug, and contentHash are identical!
      if (raw.submissionId && i.submissionId) {
        return (
          i.platform === raw.platform && i.submissionId === raw.submissionId
        );
      }

      // Hierarchy 3: Fallback when platform submission ID is absent on both items:
      // match on platform + problemSlug + contentHash.
      if (!raw.submissionId && !i.submissionId) {
        return (
          i.platform === raw.platform &&
          i.problemSlug === raw.problemSlug &&
          i.contentHash === contentHash
        );
      }

      return false;
    });
    if (duplicate) {
      return duplicate;
    }

    // Step 3: Generate unique IDs
    const walId = crypto.randomUUID();
    const itemId = raw.id || crypto.randomUUID();
    const payloadId = `payload:${itemId}`;

    const targetSnapshot: TargetSnapshot =
      raw.targetSnapshot ??
      Object.freeze({
        targetRepository: raw.targetRepository,
        targetBranch: raw.targetBranch,
        basePath: "solutions",
        duplicatePolicy: "skip",
        authorizationStatus: "CONFIGURED_UNVERIFIED",
      });

    // Step 4: Persist WAL INTENT BEFORE any mutations occur
    const walEntry: WalEntry = {
      id: walId,
      operationType: "ENQUEUE_SUBMISSION",
      entityId: itemId,
      payloadId,
      intendedState: QueueState.PENDING,
      phase: WalPhase.INTENT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: { submission: { ...raw, contentHash, targetSnapshot } },
    };
    await this.payloadStorage.putWalEntry(walEntry);

    try {
      // Step 5a: Persist source code payload to IndexedDB (enforces 500 KB limit)
      await this.payloadStorage.putPayload({
        id: payloadId,
        sourceCode: raw.sourceCode,
        platformMetadata: raw.platformMetadata,
        createdAt: Date.now(),
      });

      // Step 5b: Persist lightweight queue item metadata to storage.local
      const metadata: QueueItemMetadata = {
        id: itemId,
        payloadId,
        platform: raw.platform,
        problemSlug: raw.problemSlug,
        problemTitle: raw.problemTitle,
        targetRepository: raw.targetRepository,
        targetBranch: raw.targetBranch,
        language: raw.language,
        status: raw.status,
        contentHash,
        targetSnapshot,
        submissionId: raw.submissionId,
        sourceProvenance: raw.sourceProvenance,
        validatedBy: raw.validatedBy ?? "SERVICE_WORKER",
        state: QueueState.PENDING,
        attempts: 0,
        crashCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      queue.push(metadata);
      await this.storage.setQueueMetadata(queue);

      // Step 6: Mark WAL entry as COMMITTED
      walEntry.phase = WalPhase.COMMITTED;
      walEntry.updatedAt = Date.now();
      await this.payloadStorage.putWalEntry(walEntry);

      // Step 7: Prune committed WAL entry
      await this.payloadStorage.deleteWalEntry(walId);

      return metadata;
    } catch (err) {
      // If mutation fails, mark WAL as ROLLED_BACK or let recovery reconcile
      walEntry.phase = WalPhase.ROLLED_BACK;
      walEntry.updatedAt = Date.now();
      await this.payloadStorage.putWalEntry(walEntry).catch(() => {});
      throw err;
    }
  }

  /**
   * Reconciles Write-Ahead Log (WAL) entries, orphaned payloads, and orphaned metadata.
   * Guaranteed to be idempotent: running multiple times leaves state cleanly unchanged.
   */
  async reconcileWalAndOrphans(
    workerId?: string,
    fencingToken?: number,
  ): Promise<{
    reconciledWalCount: number;
    recoveredOrphanPayloads: number;
    quarantinedOrphanMetadata: number;
  }> {
    let reconciledWalCount = 0;
    let recoveredOrphanPayloads = 0;
    let quarantinedOrphanMetadata = 0;

    // 1. Reconcile WAL entries in wal_logs
    const walEntries = await this.payloadStorage.getAllWalEntries();
    const queue = await this.storage.getQueueMetadata();
    const existingQueueIds = new Set(queue.map((i) => i.id));
    const walIdsToDelete: string[] = [];

    for (const wal of walEntries) {
      if (wal.phase === WalPhase.COMMITTED) {
        // Already committed; cleanup WAL record
        walIdsToDelete.push(wal.id);
        continue;
      }

      if (wal.phase === WalPhase.INTENT) {
        const payload = await this.payloadStorage.getPayload(wal.payloadId);

        if (payload) {
          // Payload was written; verify metadata in storage.local
          if (!existingQueueIds.has(wal.entityId)) {
            // Crash Boundary C: Payload written, metadata missing. Recover metadata!
            const sub = wal.snapshot?.submission;
            const recoveredMetadata: QueueItemMetadata = {
              id: wal.entityId,
              payloadId: wal.payloadId,
              platform: sub?.platform ?? "unknown",
              problemSlug: sub?.problemSlug ?? "recovered-submission",
              problemTitle: sub?.problemTitle ?? "Recovered Submission",
              targetRepository: sub?.targetRepository ?? "unknown/repo",
              targetBranch: sub?.targetBranch ?? "main",
              language: sub?.language ?? "unknown",
              status: sub?.status ?? "Pending",
              contentHash:
                sub?.contentHash ??
                (await computeContentHash(payload.sourceCode)),
              targetSnapshot: sub?.targetSnapshot,
              submissionId: sub?.submissionId,
              sourceProvenance: sub?.sourceProvenance,
              validatedBy: sub?.validatedBy ?? "SERVICE_WORKER",
              state: QueueState.PENDING,
              attempts: 0,
              crashCount: 1,
              createdAt: wal.createdAt,
              updatedAt: Date.now(),
            };
            queue.push(recoveredMetadata);
            existingQueueIds.add(wal.entityId);
            reconciledWalCount++;
          }
          walIdsToDelete.push(wal.id);
        } else {
          // Crash Boundary B: Incomplete intent before payload write.
          // Delete uncommitted WAL entry cleanly
          walIdsToDelete.push(wal.id);
        }
      } else if (wal.phase === WalPhase.ROLLED_BACK) {
        walIdsToDelete.push(wal.id);
      }
    }

    // 2. Reconcile Orphan Payloads (IndexedDB payloads missing in storage.local)
    const allPayloadKeys = await this.payloadStorage.getAllPayloadKeys();
    const activePayloadIds = new Set(queue.map((i) => i.payloadId));

    for (const pKey of allPayloadKeys) {
      if (!activePayloadIds.has(pKey)) {
        // Orphan payload detected! Never discard user source code silently.
        const orphanPayload = await this.payloadStorage.getPayload(pKey);
        if (orphanPayload) {
          const orphanId = pKey.startsWith("payload:")
            ? pKey.replace("payload:", "")
            : crypto.randomUUID();

          if (!existingQueueIds.has(orphanId)) {
            const orphanMeta: QueueItemMetadata = {
              id: orphanId,
              payloadId: pKey,
              platform: "unknown",
              problemSlug: "recovered-orphan",
              problemTitle: "Recovered Orphan Payload",
              targetRepository: "unknown/repo",
              targetBranch: "main",
              language: "unknown",
              status: "RECOVERED_ORPHAN_PAYLOAD",
              contentHash: await computeContentHash(orphanPayload.sourceCode),
              state: QueueState.REQUIRES_ATTENTION,
              attempts: 0,
              crashCount: 0,
              lastError: {
                code: ErrorCode.INVARIANT_VIOLATION,
                message:
                  "Payload existed in IndexedDB without queue metadata index.",
                timestamp: Date.now(),
              },
              createdAt: orphanPayload.createdAt,
              updatedAt: Date.now(),
            };
            queue.push(orphanMeta);
            existingQueueIds.add(orphanId);
            recoveredOrphanPayloads++;
          }
        }
      }
    }

    // 3. Reconcile Orphan Metadata (Metadata in storage.local missing in IndexedDB)
    for (const item of queue) {
      if (
        item.state !== QueueState.REQUIRES_ATTENTION &&
        item.state !== QueueState.COMPLETED
      ) {
        const payloadExists = await this.payloadStorage.getPayload(
          item.payloadId,
        );
        if (!payloadExists) {
          item.state = QueueState.REQUIRES_ATTENTION;
          item.lastError = {
            code: ErrorCode.PAYLOAD_NOT_FOUND,
            message: "Source code payload missing from IndexedDB store.",
            timestamp: Date.now(),
          };
          quarantinedOrphanMetadata++;
        }
      }
    }

    // Step 4: Persist metadata durably FIRST under fencing authority
    if (workerId !== undefined && fencingToken !== undefined) {
      await this.concurrency.validateFencingToken(workerId, fencingToken);
    }
    await this.storage.setQueueMetadata(queue);

    // Step 5: Only after metadata is confirmed durable, delete resolved WAL entries under fencing authority
    for (const walId of walIdsToDelete) {
      if (workerId !== undefined && fencingToken !== undefined) {
        await this.concurrency.validateFencingToken(workerId, fencingToken);
      }
      await this.payloadStorage.deleteWalEntry(walId);
    }

    return {
      reconciledWalCount,
      recoveredOrphanPayloads,
      quarantinedOrphanMetadata,
    };
  }

  /**
   * Reconciles items interrupted by service worker suspension or crash.
   * Items stuck in PROCESSING have crashCount incremented.
   * If crashCount >= 3, quarantined to REQUIRES_ATTENTION (poison-pill protection).
   */
  async reconcileInterruptedItems(
    workerId?: string,
    fencingToken?: number,
  ): Promise<ReconciliationResult> {
    const queue = await this.storage.getQueueMetadata();
    let reconciledCount = 0;
    let quarantinedCount = 0;
    let modified = false;

    for (const item of queue) {
      if (item.state === QueueState.PROCESSING) {
        item.crashCount += 1;
        item.updatedAt = Date.now();
        modified = true;

        if (item.crashCount >= POISON_PILL_CRASH_THRESHOLD) {
          item.state = QueueState.REQUIRES_ATTENTION;
          item.lastError = {
            code: ErrorCode.POISON_PILL_DETECTED,
            message:
              "Item repeatedly caused worker crashes; quarantined to protect queue availability.",
            timestamp: Date.now(),
          };
          quarantinedCount++;
        } else {
          item.state = QueueState.PENDING;
          reconciledCount++;
        }
      }
    }

    if (modified) {
      if (workerId !== undefined && fencingToken !== undefined) {
        await this.concurrency.validateFencingToken(workerId, fencingToken);
      }
      await this.storage.setQueueMetadata(queue);
    }

    return { reconciledCount, quarantinedCount };
  }

  /**
   * Drains eligible pending queue items sequentially under two-tier concurrency and fencing lock.
   * All mutations validate the current fencingToken to guarantee stale workers cannot mutate state.
   */
  async drainQueue(
    triggerSource: TriggerSource,
    handler: (
      item: QueueItemMetadata,
      payload: QueueItemPayload,
    ) => Promise<SyncResult>,
  ): Promise<DrainSummary | null> {
    return await this.concurrency.runExclusively(
      triggerSource,
      async (workerId, fencingToken, renew) => {
        // 1. Reconcile WAL logs, orphans, and crashed items
        const orphanRecon = await this.reconcileWalAndOrphans(
          workerId,
          fencingToken,
        );
        const recon = await this.reconcileInterruptedItems(
          workerId,
          fencingToken,
        );

        const summary: DrainSummary = {
          processed: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          quarantined:
            recon.quarantinedCount + orphanRecon.quarantinedOrphanMetadata,
        };

        const now = Date.now();
        const queue = await this.storage.getQueueMetadata();

        for (let i = 0; i < queue.length; i++) {
          const item = queue[i];
          if (!item) continue;

          // Check if eligible for processing
          const isEligible =
            item.state === QueueState.PENDING ||
            (item.state === QueueState.FAILED &&
              (item.nextRetryAt ?? 0) <= now);

          if (!isEligible) {
            continue;
          }

          // Fencing Check: Ensure worker lease is still authoritative before mutation
          await this.concurrency.validateFencingToken(workerId, fencingToken);

          // Transition to PROCESSING
          item.state = QueueState.PROCESSING;
          item.fencingToken = fencingToken;
          item.updatedAt = Date.now();
          await this.storage.setQueueMetadata(queue);

          // Retrieve heavy payload
          const payload = await this.payloadStorage.getPayload(item.payloadId);
          if (!payload) {
            // Fencing Check before writing quarantine
            await this.concurrency.validateFencingToken(workerId, fencingToken);
            item.state = QueueState.REQUIRES_ATTENTION;
            item.lastError = {
              code: ErrorCode.PAYLOAD_NOT_FOUND,
              message: "Source code payload missing from IndexedDB store.",
              timestamp: Date.now(),
            };
            summary.quarantined++;
            await this.storage.setQueueMetadata(queue);
            continue;
          }

          summary.processed++;

          try {
            const result = await handler(item, payload);

            // Fencing Check before committing handler outcome
            await this.concurrency.validateFencingToken(workerId, fencingToken);

            if (result.status === "completed") {
              item.state = QueueState.COMPLETED;
              item.completedAt = Date.now();
              item.commitSha = result.commitSha;
              item.commitUrl = result.commitUrl;
              summary.completed++;

              // Record in sync history
              const historyEntry: SyncHistoryEntry = {
                id: crypto.randomUUID(),
                submissionId: item.id,
                platform: item.platform,
                problemTitle: item.problemTitle,
                problemSlug: item.problemSlug,
                targetRepository: item.targetRepository,
                targetBranch: item.targetBranch,
                language: item.language,
                contentHash: item.contentHash,
                commitSha: result.commitSha,
                commitUrl: result.commitUrl,
                completedAt: Date.now(),
                status: "synced",
              };
              await this.payloadStorage.putHistory(historyEntry);
            } else if (result.status === "skipped") {
              item.state = QueueState.SKIPPED;
              item.completedAt = Date.now();
              summary.skipped++;

              const historyEntry: SyncHistoryEntry = {
                id: crypto.randomUUID(),
                submissionId: item.id,
                platform: item.platform,
                problemTitle: item.problemTitle,
                problemSlug: item.problemSlug,
                targetRepository: item.targetRepository,
                targetBranch: item.targetBranch,
                language: item.language,
                contentHash: item.contentHash,
                completedAt: Date.now(),
                status: "skipped",
              };
              await this.payloadStorage.putHistory(historyEntry);
            } else if (result.status === "failed") {
              item.attempts += 1;
              if (item.attempts >= MAX_ATTEMPTS) {
                item.state = QueueState.REQUIRES_ATTENTION;
                summary.quarantined++;
              } else {
                item.state = QueueState.FAILED;
                const backoffDelay = computeBackoffDelay(item.attempts);
                let rateLimitDelay = 0;
                if (result.error?.resetTimestamp) {
                  rateLimitDelay = Math.max(
                    0,
                    result.error.resetTimestamp - Date.now(),
                  );
                } else if (result.error?.retryAfterSeconds) {
                  rateLimitDelay = result.error.retryAfterSeconds * 1000;
                }
                const effectiveDelay = Math.max(backoffDelay, rateLimitDelay);
                item.nextRetryAt = Date.now() + effectiveDelay;
                summary.failed++;
              }
              if (result.error) {
                item.lastError = {
                  code: result.error.code,
                  message: result.error.message,
                  timestamp: Date.now(),
                };
              }
            } else if (result.status === "requires_attention") {
              item.state = QueueState.REQUIRES_ATTENTION;
              summary.quarantined++;
              if (result.error) {
                item.lastError = {
                  code: result.error.code,
                  message: result.error.message,
                  timestamp: Date.now(),
                };
              }
            }
          } catch (err) {
            // Fencing Check before writing error state
            await this.concurrency.validateFencingToken(workerId, fencingToken);
            item.attempts += 1;
            item.state =
              item.attempts >= MAX_ATTEMPTS
                ? QueueState.REQUIRES_ATTENTION
                : QueueState.FAILED;
            item.lastError = {
              code: ErrorCode.INVARIANT_VIOLATION,
              message:
                (err as Error).message ?? "Handler threw unhandled error",
              timestamp: Date.now(),
            };
            summary.failed++;
          }

          item.updatedAt = Date.now();
          await this.storage.setQueueMetadata(queue);

          // Renew lease heartbeat
          await renew();
        }

        return summary;
      },
    );
  }

  /**
   * Retrieves active items from queue.
   */
  async getQueue(): Promise<QueueItemMetadata[]> {
    return await this.storage.getQueueMetadata();
  }

  /**
   * Purges completed and skipped items older than retention window.
   */
  async purgeCompleted(
    retentionMs: number = 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const queue = await this.storage.getQueueMetadata();
    const threshold = Date.now() - retentionMs;
    const remaining: QueueItemMetadata[] = [];
    let purged = 0;

    for (const item of queue) {
      if (
        (item.state === QueueState.COMPLETED ||
          item.state === QueueState.SKIPPED) &&
        (item.completedAt ?? item.updatedAt) < threshold
      ) {
        await this.payloadStorage.deletePayload(item.payloadId).catch(() => {});
        purged++;
      } else {
        remaining.push(item);
      }
    }

    if (purged > 0) {
      await this.storage.setQueueMetadata(remaining);
    }

    return purged;
  }
}

export const defaultQueueManager = new QueueManager();
