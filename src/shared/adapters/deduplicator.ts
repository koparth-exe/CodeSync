/**
 * Submission Event Deduplicator (Phase 1C.3)
 *
 * Prevents rapid event flooding caused by DOM mutations, consecutive clicks,
 * or SPA polling without discarding genuinely distinct submissions.
 *
 * Invariants:
 * - Timestamps ALONE are never used as identity.
 * - Key components: platform + (submissionId || problemId) + contentHash + status.
 * - Strictly bounded memory cache with sliding TTL window and LRU/FIFO eviction.
 * - Distinct from downstream repository write deduplication.
 */

export interface DeduplicatorOptions {
  readonly maxEntries?: number | undefined;
  readonly ttlMs?: number | undefined;
}

export class SubmissionEventDeduplicator {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, number>();

  constructor(options: DeduplicatorOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 60_000; // 60 seconds default
  }

  /**
   * Generates a deterministic deduplication key for a submission event.
   */
  generateKey(
    platform: string,
    problemId: string,
    contentHash: string,
    status: string,
    submissionId?: string,
  ): string {
    const idComponent = submissionId
      ? `sub:${submissionId}`
      : `prob:${problemId}`;
    return `${platform.toLowerCase()}:${idComponent}:${contentHash.toLowerCase()}:${status.toUpperCase()}`;
  }

  /**
   * Prunes expired keys based on TTL.
   */
  private prune(now: number): void {
    for (const [key, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Checks if an event key was already processed within the TTL window.
   */
  isDuplicate(key: string, now: number = Date.now()): boolean {
    this.prune(now);
    const existing = this.cache.get(key);
    if (existing !== undefined && now - existing <= this.ttlMs) {
      return true;
    }
    return false;
  }

  /**
   * Records an event key in the bounded cache.
   */
  record(key: string, now: number = Date.now()): void {
    this.prune(now);

    // Enforce capacity bounds (FIFO eviction if over capacity)
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, now);
  }

  /**
   * Atomically checks if the event is a duplicate and records it if it is not.
   * Returns true if it was a duplicate (already seen), false if it is new.
   */
  checkAndRecord(key: string, now: number = Date.now()): boolean {
    if (this.isDuplicate(key, now)) {
      return true;
    }
    this.record(key, now);
    return false;
  }

  /**
   * Returns current cache size.
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clears the cache completely.
   */
  clear(): void {
    this.cache.clear();
  }
}
