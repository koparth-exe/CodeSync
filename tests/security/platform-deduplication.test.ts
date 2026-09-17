import { describe, expect, it } from "vitest";
import { SubmissionEventDeduplicator } from "../../src/shared/adapters/deduplicator";

describe("Phase 1C.3 — Submission Event Deduplication", () => {
  it("generates deterministic identity independent of timestamp", () => {
    const dedup = new SubmissionEventDeduplicator();
    const key1 = dedup.generateKey(
      "leetcode",
      "two-sum",
      "hash123",
      "ACCEPTED",
      "sub1",
    );
    const key2 = dedup.generateKey(
      "leetcode",
      "two-sum",
      "hash123",
      "ACCEPTED",
      "sub1",
    );
    expect(key1).toBe(key2);
    expect(key1).toBe("leetcode:sub:sub1:hash123:ACCEPTED");
  });

  it("suppresses identical duplicate submission events within TTL window", () => {
    const dedup = new SubmissionEventDeduplicator({ ttlMs: 10_000 });
    const now = 1_000_000;
    const key = dedup.generateKey("leetcode", "two-sum", "hash123", "ACCEPTED");

    // First event is new
    expect(dedup.checkAndRecord(key, now)).toBe(false);

    // Immediate duplicate is detected and suppressed
    expect(dedup.isDuplicate(key, now + 100)).toBe(true);
    expect(dedup.checkAndRecord(key, now + 100)).toBe(true);

    // Duplicate within TTL (9 seconds later) is suppressed
    expect(dedup.isDuplicate(key, now + 9_000)).toBe(true);

    // After TTL expiry (11 seconds later), key has expired and can be re-recorded
    expect(dedup.isDuplicate(key, now + 11_000)).toBe(false);
  });

  it("does NOT suppress distinct submissions (different code, status, or problem)", () => {
    const dedup = new SubmissionEventDeduplicator();
    const now = 1_000_000;

    const keyAccepted = dedup.generateKey(
      "leetcode",
      "two-sum",
      "hash1",
      "ACCEPTED",
    );
    const keyRejected = dedup.generateKey(
      "leetcode",
      "two-sum",
      "hash1",
      "REJECTED",
    );
    const keyDifferentProblem = dedup.generateKey(
      "leetcode",
      "three-sum",
      "hash1",
      "ACCEPTED",
    );
    const keyDifferentCode = dedup.generateKey(
      "leetcode",
      "two-sum",
      "hash2",
      "ACCEPTED",
    );

    dedup.record(keyAccepted, now);

    expect(dedup.isDuplicate(keyRejected, now)).toBe(false);
    expect(dedup.isDuplicate(keyDifferentProblem, now)).toBe(false);
    expect(dedup.isDuplicate(keyDifferentCode, now)).toBe(false);
  });

  it("enforces bounded capacity and evicts oldest entries (FIFO)", () => {
    const dedup = new SubmissionEventDeduplicator({
      maxEntries: 3,
      ttlMs: 100_000,
    });
    const now = 1_000_000;

    dedup.record("key1", now);
    dedup.record("key2", now + 10);
    dedup.record("key3", now + 20);

    expect(dedup.size()).toBe(3);

    // Adding 4th entry triggers eviction of key1
    dedup.record("key4", now + 30);
    expect(dedup.size()).toBe(3);
    expect(dedup.isDuplicate("key1", now + 30)).toBe(false);
    expect(dedup.isDuplicate("key2", now + 30)).toBe(true);
    expect(dedup.isDuplicate("key4", now + 30)).toBe(true);
  });
});
