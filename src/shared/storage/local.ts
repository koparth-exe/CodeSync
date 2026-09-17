import { STORAGE_KEYS } from "./keys";
import type {
  CorruptedStorageRecord,
  QueueItemMetadata,
  QueueLeaseRecord,
} from "./types";
import { getExtensionStorage } from "../browser";
import { ErrorCode, StorageError } from "../errors";

/**
 * Storage driver interface permitting dependency injection and testing.
 */
export interface LocalStorageDriver {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear?(): Promise<void>;
}

/**
 * Default driver backed by WebExtension browser.storage.local / chrome.storage.local.
 */
export class WebExtensionStorageDriver implements LocalStorageDriver {
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    try {
      const storage = getExtensionStorage();
      return await new Promise((resolve, reject) => {
        storage.local.get(keys ?? undefined, (items) => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            reject(
              new StorageError(
                err.message ?? "Unknown storage error",
                ErrorCode.STORAGE_ERROR,
              ),
            );
          } else {
            resolve((items as Record<string, unknown>) ?? {});
          }
        });
      });
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw new StorageError(
        `Failed reading storage: ${(e as Error).message}`,
        ErrorCode.STORAGE_UNAVAILABLE,
      );
    }
  }

  async set(items: Record<string, unknown>): Promise<void> {
    try {
      const storage = getExtensionStorage();
      await new Promise<void>((resolve, reject) => {
        storage.local.set(items, () => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            reject(
              new StorageError(
                err.message ?? "Unknown storage error",
                ErrorCode.STORAGE_ERROR,
              ),
            );
          } else {
            resolve();
          }
        });
      });
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw new StorageError(
        `Failed writing storage: ${(e as Error).message}`,
        ErrorCode.STORAGE_UNAVAILABLE,
      );
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    try {
      const storage = getExtensionStorage();
      await new Promise<void>((resolve, reject) => {
        storage.local.remove(keys, () => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            reject(
              new StorageError(
                err.message ?? "Unknown storage error",
                ErrorCode.STORAGE_ERROR,
              ),
            );
          } else {
            resolve();
          }
        });
      });
    } catch (e) {
      if (e instanceof StorageError) throw e;
      throw new StorageError(
        `Failed removing storage keys: ${(e as Error).message}`,
        ErrorCode.STORAGE_UNAVAILABLE,
      );
    }
  }
}

/**
 * Centralized service managing lightweight extension state in browser.storage.local.
 */
export class StorageService {
  private driver: LocalStorageDriver;

  constructor(driver?: LocalStorageDriver) {
    this.driver = driver ?? new WebExtensionStorageDriver();
  }

  /**
   * Overrides current storage driver (used for unit tests and failure injection).
   */
  setDriver(driver: LocalStorageDriver): void {
    this.driver = driver;
  }

  /**
   * Retrieves queue metadata with automatic corruption detection and quarantine.
   */
  async getQueueMetadata(): Promise<QueueItemMetadata[]> {
    const raw = await this.driver.get([STORAGE_KEYS.QUEUE_METADATA]);
    const items = raw[STORAGE_KEYS.QUEUE_METADATA];

    if (items === undefined || items === null) {
      return [];
    }

    if (!Array.isArray(items)) {
      await this.isolateCorrupted(
        items,
        "Expected array for queue metadata, found non-array type.",
      );
      await this.driver.set({ [STORAGE_KEYS.QUEUE_METADATA]: [] });
      return [];
    }

    // Validate each item structure
    const validItems: QueueItemMetadata[] = [];
    let hasCorrupted = false;

    for (const item of items) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as QueueItemMetadata).id === "string" &&
        typeof (item as QueueItemMetadata).payloadId === "string" &&
        typeof (item as QueueItemMetadata).state === "string"
      ) {
        validItems.push(item as QueueItemMetadata);
      } else {
        hasCorrupted = true;
      }
    }

    if (hasCorrupted) {
      await this.isolateCorrupted(
        items,
        "Malformed items detected in queue metadata array.",
      );
      await this.driver.set({ [STORAGE_KEYS.QUEUE_METADATA]: validItems });
    }

    return validItems;
  }

  /**
   * Persists updated queue metadata array.
   */
  async setQueueMetadata(items: QueueItemMetadata[]): Promise<void> {
    if (!Array.isArray(items)) {
      throw new StorageError(
        "Queue metadata must be an array.",
        ErrorCode.VALIDATION_FAILED,
      );
    }
    await this.driver.set({ [STORAGE_KEYS.QUEUE_METADATA]: items });
  }

  /**
   * Retrieves persistent queue lease record, if any.
   */
  async getLease(): Promise<QueueLeaseRecord | null> {
    const raw = await this.driver.get([STORAGE_KEYS.QUEUE_LEASE]);
    const lease = raw[STORAGE_KEYS.QUEUE_LEASE] as QueueLeaseRecord | undefined;

    if (!lease || typeof lease !== "object") {
      return null;
    }

    if (
      typeof lease.workerId !== "string" ||
      typeof lease.acquiredAt !== "number" ||
      typeof lease.expiresAt !== "number"
    ) {
      await this.isolateCorrupted(lease, "Malformed queue lease record.");
      await this.removeLease();
      return null;
    }

    return lease;
  }

  /**
   * Stores active queue lease record.
   */
  async setLease(lease: QueueLeaseRecord): Promise<void> {
    await this.driver.set({ [STORAGE_KEYS.QUEUE_LEASE]: lease });
  }

  /**
   * Removes persistent queue lease record.
   */
  async removeLease(): Promise<void> {
    await this.driver.remove([STORAGE_KEYS.QUEUE_LEASE]);
  }

  /**
   * Generic typed retrieval from storage.
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.driver.get([key]);
    return raw[key] as T | undefined;
  }

  /**
   * Generic typed persistence to storage.
   */
  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.driver.set({ [key]: value });
  }

  /**
   * Generic removal of key from storage.
   */
  async remove(key: string): Promise<void> {
    await this.driver.remove([key]);
  }

  /**
   * Isolates corrupted storage objects to codesync:corrupted for safe inspection.
   */
  async isolateCorrupted(
    rawContent: unknown,
    reason: string,
    originalKey: string = STORAGE_KEYS.QUEUE_METADATA,
  ): Promise<void> {
    try {
      const records = await this.getCorruptedRecords();
      const newRecord: CorruptedStorageRecord = {
        id: crypto.randomUUID(),
        originalKey,
        isolatedAt: Date.now(),
        reason,
        rawContent,
      };

      // Cap at 20 quarantine entries to avoid unbounded growth
      const updated = [...records.slice(-19), newRecord];
      await this.driver.set({ [STORAGE_KEYS.CORRUPTED]: updated });
    } catch {
      // Fail closed without throwing to prevent cascading crashes during recovery
    }
  }

  /**
   * Returns list of quarantined corrupted storage records.
   */
  async getCorruptedRecords(): Promise<CorruptedStorageRecord[]> {
    try {
      const raw = await this.driver.get([STORAGE_KEYS.CORRUPTED]);
      const list = raw[STORAGE_KEYS.CORRUPTED];
      return Array.isArray(list) ? (list as CorruptedStorageRecord[]) : [];
    } catch {
      return [];
    }
  }
}

/** Default singleton instance */
export const defaultStorageService = new StorageService();
