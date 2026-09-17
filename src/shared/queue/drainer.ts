import { createLogger } from "../logger";
import { defaultQueueManager, QueueManager } from "./manager";
import type { TriggerSource } from "./concurrency";
import type {
  DrainSummary,
  QueueItemMetadata,
  QueueItemPayload,
  SyncResult,
} from "./types";

const logger = createLogger("QueueDrainer");

export const QUEUE_DRAIN_ALARM_NAME = "codesync_queue_drain_alarm";
export const QUEUE_DRAIN_ALARM_PERIOD_MINUTES = 5;

/**
 * Ensures the periodic queue drain alarm is registered without duplicates.
 */
export async function setupQueueDrainAlarm(): Promise<void> {
  try {
    if (typeof browser !== "undefined" && browser.alarms) {
      const existing = await browser.alarms.get(QUEUE_DRAIN_ALARM_NAME);
      if (!existing) {
        browser.alarms.create(QUEUE_DRAIN_ALARM_NAME, {
          periodInMinutes: QUEUE_DRAIN_ALARM_PERIOD_MINUTES,
        });
        logger.info("Registered periodic queue drain alarm", {
          alarmName: QUEUE_DRAIN_ALARM_NAME,
          periodInMinutes: QUEUE_DRAIN_ALARM_PERIOD_MINUTES,
        });
      }
    }
  } catch (err) {
    logger.warn("Failed to register queue drain alarm", {
      error: (err as Error).message,
    });
  }
}

export type QueueItemHandler = (
  item: QueueItemMetadata,
  payload: QueueItemPayload,
) => Promise<SyncResult>;

export interface QueueDrainerOptions {
  readonly queueManager?: QueueManager | undefined;
  readonly handler?: QueueItemHandler | undefined;
}

/**
 * QueueDrainer coordinates queue processing across external triggers
 * (submission detection, periodic alarms, startup/recovery) and delegates
 * execution exclusively to QueueManager.drainQueue.
 *
 * Invariants (Phase 1C.4.2.1 Correction):
 * - Fail-closed no-op when unconfigured: If no synchronization handler is
 *   installed, drain() does NOT call QueueManager.drainQueue(), claims no items,
 *   mutates no states, consumes no retry attempts, and returns null.
 * - Does NOT implement custom locking or concurrency guards; delegates all
 *   mutual exclusion, persistent leasing, and fencing to QueueManager.drainQueue.
 * - Supports dependency injection for QueueManager and QueueItemHandler.
 * - Multiple concurrent triggers safely coalesce through QueueManager's two-tier lock.
 * - Security boundary: UNTRUSTED PAGE / CONTENT SCRIPT -> VALIDATED EXTENSION MESSAGE
 *   -> SERVICE-WORKER AUTHORIZATION -> PERMITTED OPERATION ONLY.
 */
export class QueueDrainer {
  private readonly queueManager: QueueManager;
  private handler?: QueueItemHandler | undefined;

  constructor(options?: QueueDrainerOptions) {
    this.queueManager = options?.queueManager ?? defaultQueueManager;
    this.handler = options?.handler;
  }

  /**
   * Sets or unsets the active queue item synchronization handler.
   */
  setHandler(handler?: QueueItemHandler | undefined): void {
    this.handler = handler;
  }

  /**
   * Retrieves the current handler, if configured.
   */
  getHandler(): QueueItemHandler | undefined {
    return this.handler;
  }

  /**
   * Returns true if a real synchronization handler is currently registered.
   */
  hasHandler(): boolean {
    return typeof this.handler === "function";
  }

  /**
   * Initiates a queue drain pass for the specified trigger source.
   *
   * Invariant (Phase 1C.4.2.1 Correction):
   * When no active synchronization handler is registered (Phase 1C.4.2.1 baseline
   * prior to Phase 1C.4.2.2 integration), QueueDrainer safely refuses to drain.
   * It performs NO queue mutation, invokes NO QueueManager draining, claims NO items,
   * consumes ZERO retry attempts, and returns null immediately.
   */
  async drain(triggerSource: TriggerSource): Promise<DrainSummary | null> {
    if (!this.handler) {
      logger.info(
        "Queue drain pass skipped: no active synchronization handler registered (safe no-op)",
        { triggerSource },
      );
      return null;
    }

    logger.info("Initiating queue drain pass", { triggerSource });
    return await this.queueManager.drainQueue(triggerSource, this.handler);
  }
}

export const defaultQueueDrainer = new QueueDrainer();
