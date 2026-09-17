import type { QueueItemPayload, SyncHistoryEntry, WalEntry } from "./types";
import { ErrorCode, StorageError } from "../errors";

export const DB_NAME = "codesync_db";
export const DB_VERSION = 1;
export const MAX_PAYLOAD_SIZE_BYTES = 500 * 1024; // 500 KB per source file

export interface PayloadStorageDriver {
  putPayload(payload: QueueItemPayload): Promise<void>;
  getPayload(id: string): Promise<QueueItemPayload | null>;
  deletePayload(id: string): Promise<void>;
  getAllPayloadKeys(): Promise<string[]>;
  getAllPayloads(): Promise<QueueItemPayload[]>;
  putHistory(entry: SyncHistoryEntry): Promise<void>;
  getHistory(limit?: number): Promise<SyncHistoryEntry[]>;
  putWalEntry(entry: WalEntry): Promise<void>;
  getWalEntry(id: string): Promise<WalEntry | null>;
  deleteWalEntry(id: string): Promise<void>;
  getAllWalEntries(): Promise<WalEntry[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Standard W3C IndexedDB implementation of PayloadStorageDriver.
 */
export class W3CIndexedDBDriver implements PayloadStorageDriver {
  private db: IDBDatabase | null = null;
  private dbFactory: IDBFactory;

  constructor(factory?: IDBFactory) {
    if (factory) {
      this.dbFactory = factory;
    } else if (typeof indexedDB !== "undefined") {
      this.dbFactory = indexedDB;
    } else if (typeof globalThis !== "undefined" && globalThis.indexedDB) {
      this.dbFactory = globalThis.indexedDB;
    } else {
      throw new StorageError(
        "IndexedDB is unavailable in the current runtime environment.",
        ErrorCode.STORAGE_UNAVAILABLE,
      );
    }
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = this.dbFactory.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("payloads")) {
          db.createObjectStore("payloads", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("history")) {
          db.createObjectStore("history", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("wal_logs")) {
          db.createObjectStore("wal_logs", { keyPath: "id" });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };

      request.onerror = () => {
        reject(
          new StorageError(
            `Failed to open IndexedDB: ${request.error?.message ?? "Unknown error"}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      };
    });
  }

  async putPayload(payload: QueueItemPayload): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["payloads"], "readwrite");
        const store = tx.objectStore("payloads");
        const req = store.put(payload);

        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed writing payload: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getPayload(id: string): Promise<QueueItemPayload | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["payloads"], "readonly");
        const store = tx.objectStore("payloads");
        const req = store.get(id);

        req.onsuccess = () => resolve((req.result as QueueItemPayload) ?? null);
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading payload: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async deletePayload(id: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["payloads"], "readwrite");
        const store = tx.objectStore("payloads");
        const req = store.delete(id);

        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed deleting payload: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getAllPayloadKeys(): Promise<string[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["payloads"], "readonly");
        const store = tx.objectStore("payloads");
        const req = store.getAllKeys();

        req.onsuccess = () => resolve((req.result as string[]) ?? []);
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading payload keys: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getAllPayloads(): Promise<QueueItemPayload[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["payloads"], "readonly");
        const store = tx.objectStore("payloads");
        const req = store.getAll();

        req.onsuccess = () => resolve((req.result as QueueItemPayload[]) ?? []);
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading payloads: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async putHistory(entry: SyncHistoryEntry): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["history"], "readwrite");
        const store = tx.objectStore("history");
        const req = store.put(entry);

        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed writing history entry: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getHistory(limit: number = 50): Promise<SyncHistoryEntry[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["history"], "readonly");
        const store = tx.objectStore("history");
        const req = store.getAll();

        req.onsuccess = () => {
          const results = (req.result as SyncHistoryEntry[]) ?? [];
          results.sort((a, b) => b.completedAt - a.completedAt);
          resolve(results.slice(0, limit));
        };
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading history: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async putWalEntry(entry: WalEntry): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["wal_logs"], "readwrite");
        const store = tx.objectStore("wal_logs");
        const req = store.put(entry);

        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed writing WAL entry: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getWalEntry(id: string): Promise<WalEntry | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["wal_logs"], "readonly");
        const store = tx.objectStore("wal_logs");
        const req = store.get(id);

        req.onsuccess = () => resolve((req.result as WalEntry) ?? null);
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading WAL entry: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async deleteWalEntry(id: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["wal_logs"], "readwrite");
        const store = tx.objectStore("wal_logs");
        const req = store.delete(id);

        req.onsuccess = () => resolve();
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed deleting WAL entry: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async getAllWalEntries(): Promise<WalEntry[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(["wal_logs"], "readonly");
        const store = tx.objectStore("wal_logs");
        const req = store.getAll();

        req.onsuccess = () => resolve((req.result as WalEntry[]) ?? []);
        req.onerror = () =>
          reject(
            new StorageError(
              `Failed reading WAL entries: ${req.error?.message}`,
              ErrorCode.STORAGE_ERROR,
            ),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB transaction error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(
          ["payloads", "history", "wal_logs"],
          "readwrite",
        );
        tx.objectStore("payloads").clear();
        tx.objectStore("history").clear();
        tx.objectStore("wal_logs").clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () =>
          reject(
            new StorageError("Failed clearing stores", ErrorCode.STORAGE_ERROR),
          );
      } catch (e) {
        reject(
          new StorageError(
            `IndexedDB clear error: ${(e as Error).message}`,
            ErrorCode.STORAGE_ERROR,
          ),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * In-memory fallback driver for deterministic testing and environments without native IndexedDB.
 */
export class MemoryPayloadStorageDriver implements PayloadStorageDriver {
  private payloads = new Map<string, QueueItemPayload>();
  private history = new Map<string, SyncHistoryEntry>();
  private walLogs = new Map<string, WalEntry>();

  async putPayload(payload: QueueItemPayload): Promise<void> {
    this.payloads.set(payload.id, JSON.parse(JSON.stringify(payload)));
  }

  async getPayload(id: string): Promise<QueueItemPayload | null> {
    const found = this.payloads.get(id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async deletePayload(id: string): Promise<void> {
    this.payloads.delete(id);
  }

  async getAllPayloadKeys(): Promise<string[]> {
    return Array.from(this.payloads.keys());
  }

  async getAllPayloads(): Promise<QueueItemPayload[]> {
    return Array.from(this.payloads.values()).map((p) =>
      JSON.parse(JSON.stringify(p)),
    );
  }

  async putHistory(entry: SyncHistoryEntry): Promise<void> {
    this.history.set(entry.id, JSON.parse(JSON.stringify(entry)));
  }

  async getHistory(limit: number = 50): Promise<SyncHistoryEntry[]> {
    const list = Array.from(this.history.values());
    list.sort((a, b) => b.completedAt - a.completedAt);
    return list.slice(0, limit);
  }

  async putWalEntry(entry: WalEntry): Promise<void> {
    this.walLogs.set(entry.id, JSON.parse(JSON.stringify(entry)));
  }

  async getWalEntry(id: string): Promise<WalEntry | null> {
    const found = this.walLogs.get(id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async deleteWalEntry(id: string): Promise<void> {
    this.walLogs.delete(id);
  }

  async getAllWalEntries(): Promise<WalEntry[]> {
    return Array.from(this.walLogs.values()).map((e) =>
      JSON.parse(JSON.stringify(e)),
    );
  }

  async clear(): Promise<void> {
    this.payloads.clear();
    this.history.clear();
    this.walLogs.clear();
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }
}

/**
 * PayloadStorage service enforcing storage limits and managing heavy payload persistence.
 */
export class PayloadStorage {
  private driver: PayloadStorageDriver;

  constructor(driver?: PayloadStorageDriver) {
    if (driver) {
      this.driver = driver;
    } else if (
      typeof indexedDB !== "undefined" ||
      (typeof globalThis !== "undefined" && globalThis.indexedDB)
    ) {
      this.driver = new W3CIndexedDBDriver();
    } else {
      this.driver = new MemoryPayloadStorageDriver();
    }
  }

  setDriver(driver: PayloadStorageDriver): void {
    this.driver = driver;
  }

  /**
   * Persists a payload after enforcing strict 500 KB limit.
   */
  async putPayload(payload: QueueItemPayload): Promise<void> {
    const byteLength = new TextEncoder().encode(payload.sourceCode).length;
    if (byteLength > MAX_PAYLOAD_SIZE_BYTES) {
      throw new StorageError(
        `Payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_PAYLOAD_SIZE_BYTES} bytes (500 KB).`,
        ErrorCode.PAYLOAD_TOO_LARGE,
        "Source code payload is too large to synchronize.",
      );
    }
    await this.driver.putPayload(payload);
  }

  async getPayload(id: string): Promise<QueueItemPayload | null> {
    return await this.driver.getPayload(id);
  }

  async deletePayload(id: string): Promise<void> {
    await this.driver.deletePayload(id);
  }

  async getAllPayloadKeys(): Promise<string[]> {
    return await this.driver.getAllPayloadKeys();
  }

  async getAllPayloads(): Promise<QueueItemPayload[]> {
    return await this.driver.getAllPayloads();
  }

  async putHistory(entry: SyncHistoryEntry): Promise<void> {
    await this.driver.putHistory(entry);
  }

  async getHistory(limit?: number): Promise<SyncHistoryEntry[]> {
    return await this.driver.getHistory(limit);
  }

  async putWalEntry(entry: WalEntry): Promise<void> {
    await this.driver.putWalEntry(entry);
  }

  async getWalEntry(id: string): Promise<WalEntry | null> {
    return await this.driver.getWalEntry(id);
  }

  async deleteWalEntry(id: string): Promise<void> {
    await this.driver.deleteWalEntry(id);
  }

  async getAllWalEntries(): Promise<WalEntry[]> {
    return await this.driver.getAllWalEntries();
  }

  async clear(): Promise<void> {
    await this.driver.clear();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/** Default singleton instance */
export const defaultPayloadStorage = new PayloadStorage();
