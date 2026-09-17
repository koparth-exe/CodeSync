import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  SubmissionHandler,
  type CanonicalSubmissionCandidate,
  createDefaultRegistry,
} from "../../src/shared/adapters";
import {
  type ExtensionMessage,
  type RuntimeSenderInfo,
} from "../../src/shared/messaging/types";
import { MessageEnvelopeValidator } from "../../src/shared/messaging/validator";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import {
  QueueState,
  WalPhase,
  type QueueItemMetadata,
} from "../../src/shared/storage/types";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import {
  ConfigurationError,
  EnvelopeValidationError,
  ErrorCode,
  PlatformAdapterError,
  SecurityError,
  StaleLeaseError,
} from "../../src/shared/errors";
import {
  computeContentHash,
  normalizeSourceCode,
} from "../../src/shared/deduplication";
import { MAX_SOURCE_PAYLOAD_BYTES } from "../../src/shared/github/types";
import { TrustBoundary } from "../../src/shared/types/trust";
import { LeetCodeAdapter } from "../../src/shared/adapters/leetcode/leetcode-adapter";
import { parseHTML } from "../helpers/mock-dom";
import { validateRepositoryIdentity } from "../../src/shared/config";

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

describe("Phase 1C.4.1 — Submission → Durable WAL/Queue Integration Suite", () => {
  let localDriver: MemoryStorageDriver;
  let storage: StorageService;
  let payloadDriver: MemoryPayloadStorageDriver;
  let payloadStorage: PayloadStorage;
  let concurrency: QueueConcurrencyManager;
  let queueManager: QueueManager;
  let validator: MessageEnvelopeValidator;
  let handler: SubmissionHandler;

  const validSender: RuntimeSenderInfo = {
    tab: {
      id: 1,
      url: "https://leetcode.com/problems/two-sum/",
    },
  };

  beforeEach(async () => {
    localDriver = new MemoryStorageDriver();
    storage = new StorageService(localDriver);
    payloadDriver = new MemoryPayloadStorageDriver();
    payloadStorage = new PayloadStorage(payloadDriver);
    concurrency = new QueueConcurrencyManager(storage);
    queueManager = new QueueManager(storage, payloadStorage, concurrency);
    validator = new MessageEnvelopeValidator();

    handler = new SubmissionHandler(validator, createDefaultRegistry(), {
      queueManager,
      storage,
    });

    // Seed default verified extension configuration
    await storage.set(STORAGE_KEYS.CONFIG, {
      version: 1,
      targetRepository: "octocat/leetcode-solutions",
      targetBranch: "main",
      baseFolder: "solutions",
      duplicatePolicy: "skip",
      enabledPlatforms: { leetcode: true },
    });

    // Seed default authenticated auth state
    await storage.set(STORAGE_KEYS.AUTH, {
      method: "github_app",
      status: "authenticated",
      accessToken: "ghu_dummy_token_123",
      refreshToken: "ghr_dummy_refresh_123",
      tokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 86400_000,
      refreshGeneration: 1,
      refreshState: "IDLE",
      authorizedRepositories: ["octocat/leetcode-solutions"],
      user: {
        login: "octocat",
        id: 1,
        avatarUrl: "https://example.com/avatar",
      },
      lastValidatedAt: Date.now(),
      authenticatedAt: Date.now(),
    });
  });

  function createValidCandidate(
    overrides: Partial<CanonicalSubmissionCandidate> = {},
  ): CanonicalSubmissionCandidate {
    return {
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: "int twoSum() { return 0; }\n",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.95,
      extractionLayer: "dom",
      ...overrides,
    };
  }

  function createValidMessage(
    payload: CanonicalSubmissionCandidate = createValidCandidate(),
    id: string = crypto.randomUUID(),
  ): ExtensionMessage<CanonicalSubmissionCandidate> {
    return {
      id,
      type: "SUBMISSION_DETECTED",
      payload,
      timestamp: Date.now(),
      senderContext: "content-script",
      trustBoundary: TrustBoundary.SEMI_TRUSTED,
    };
  }

  // ==========================================================================
  // 1. SUBMISSION HANDOFF
  // ==========================================================================
  describe("Submission Handoff & Sender Authorization", () => {
    it("1. Valid canonical submission reaches the service worker", () => {
      const message = createValidMessage();
      const result = handler.handleMessage(message, validSender);
      expect(result.success).toBe(true);
      expect(result.candidate?.platform).toBe("leetcode");
      expect(result.candidate?.problemId).toBe("two-sum");
    });

    it("2. Valid submission becomes a durable queue item in PENDING state", async () => {
      const message = createValidMessage();
      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );

      expect(result.success).toBe(true);
      expect(result.queueItem).toBeDefined();
      expect(result.queueItem?.state).toBe(QueueState.PENDING);
      expect(result.queueItem?.platform).toBe("leetcode");
      expect(result.queueItem?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(result.queueItem?.targetBranch).toBe("main");

      // Verify persistence in storage.local
      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.id).toBe(result.queueItem?.id);

      // Verify payload persistence in IndexedDB
      const payload = await payloadStorage.getPayload(
        result.queueItem!.payloadId,
      );
      expect(payload).not.toBeNull();
      expect(payload?.sourceCode).toBe("int twoSum() { return 0; }\n");
    });

    it("3. Invalid candidate is rejected fail-closed", async () => {
      const invalidCandidate = createValidCandidate({
        problemSlug: "invalid/slug/with/slashes",
      });
      const message = createValidMessage(invalidCandidate);

      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(PlatformAdapterError);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });

    it("4. Invalid provenance is rejected fail-closed", async () => {
      const invalidProvenance = {
        ...createValidCandidate(),
        sourceProvenance:
          "SPOOFED_PROVENANCE" as unknown as "AUTHORITATIVE_SUBMISSION_SOURCE",
      };
      const message = createValidMessage(invalidProvenance);

      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(PlatformAdapterError);
    });

    it("5. Page-controlled authoritative provenance is rejected fail-closed", async () => {
      const adapter = new LeetCodeAdapter();
      const candidate = await adapter.extractSubmission({
        document: parseHTML(
          `<!DOCTYPE html><html><body><div data-cy="question-title">Two Sum</div></body></html>`,
        ) as unknown as Document,
        window: {} as Window,
        location: new URL("https://leetcode.com/problems/two-sum/"),
        authoritativeSource: {
          code: "evil_code",
          authority: "EXTENSION_INTERNAL",
          token: "FORGED_UNAUTHORIZED_TOKEN",
        },
      });

      // Adapter must fall back and never assign AUTHORITATIVE_SUBMISSION_SOURCE
      expect(candidate?.sourceProvenance).not.toBe(
        "AUTHORITATIVE_SUBMISSION_SOURCE",
      );
    });

    it("6. Unauthorized sender context is rejected fail-closed", async () => {
      const message: ExtensionMessage = {
        ...createValidMessage(),
        senderContext: "popup", // Malicious content script attempting privilege escalation
      };

      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(SecurityError);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });

    it("6b. Rejects non-ACCEPTED submissions from entering the queue", async () => {
      const rejectedCandidate = createValidCandidate({ status: "REJECTED" });
      const message = createValidMessage(rejectedCandidate);

      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Only ACCEPTED submissions qualify");

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 2. NORMALIZATION & CONTENT IDENTITY
  // ==========================================================================
  describe("Normalization & Content Identity", () => {
    it("7. Equivalent line endings produce identical normalized source and contentHash", async () => {
      const lfCode = "int main() {\n    return 0;\n}\n";
      const crlfCode = "int main() {\r\n    return 0;\r\n}\r\n";
      const crCode = "int main() {\r    return 0;\r}\r";

      const hashLF = await computeContentHash(lfCode);
      const hashCRLF = await computeContentHash(crlfCode);
      const hashCR = await computeContentHash(crCode);

      expect(hashLF).toBe(hashCRLF);
      expect(hashLF).toBe(hashCR);
      expect(normalizeSourceCode(crlfCode)).toBe(normalizeSourceCode(lfCode));
    });

    it("8. Content hash is deterministic 64-character lowercase hex SHA-256", async () => {
      const code = "int main() { return 42; }\n";
      const hash1 = await computeContentHash(code);
      const hash2 = await computeContentHash(code);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("9. Oversized payload exceeding 500KB is rejected fail-closed", async () => {
      const oversizedCode = "x".repeat(MAX_SOURCE_PAYLOAD_BYTES + 10);
      const candidate = createValidCandidate({ sourceCode: oversizedCode });
      const message = createValidMessage(candidate);

      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(PlatformAdapterError);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 3. TARGET SNAPSHOT
  // ==========================================================================
  describe("Immutable Target Snapshot", () => {
    it("10. Target snapshot is captured at enqueue time", async () => {
      const message = createValidMessage();
      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );

      expect(result.queueItem?.targetSnapshot).toBeDefined();
      expect(result.queueItem?.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(result.queueItem?.targetSnapshot?.targetBranch).toBe("main");
      expect(result.queueItem?.targetSnapshot?.basePath).toBe("solutions");
      expect(result.queueItem?.targetSnapshot?.duplicatePolicy).toBe(
        "REPLACE_IF_DIFFERENT",
      );
    });

    it("11. Later config mutation does not alter queue item target snapshot", async () => {
      const message = createValidMessage();
      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );
      const itemId = result.queueItem!.id;

      // User subsequently modifies global settings in extension
      await storage.set(STORAGE_KEYS.CONFIG, {
        version: 1,
        targetRepository: "different-owner/other-repo",
        targetBranch: "develop",
        baseFolder: "new-path",
        duplicatePolicy: "overwrite",
        enabledPlatforms: { leetcode: true },
      });

      // The queued item must remain targeted at the snapshot taken at enqueue
      const queue = await storage.getQueueMetadata();
      const item = queue.find((i) => i.id === itemId);
      expect(item).toBeDefined();
      expect(item?.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(item?.targetSnapshot?.targetBranch).toBe("main");
      expect(item?.targetSnapshot?.basePath).toBe("solutions");
      expect(item?.targetSnapshot?.duplicatePolicy).toBe(
        "REPLACE_IF_DIFFERENT",
      );
    });

    it("12. Invalid target configuration is rejected fail-closed", async () => {
      // Malicious or corrupted branch traversal in config
      await storage.set(STORAGE_KEYS.CONFIG, {
        version: 1,
        targetRepository: "octocat/leetcode-solutions",
        targetBranch: "main/../v1", // Directory traversal sequence
        baseFolder: "solutions",
        duplicatePolicy: "skip",
      });

      const message = createValidMessage();
      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(ConfigurationError);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });

    it("12b. Invalid target repository format is rejected fail-closed", async () => {
      await storage.set(STORAGE_KEYS.CONFIG, {
        version: 1,
        targetRepository: "invalid-repo-without-slash",
        targetBranch: "main",
        baseFolder: "solutions",
        duplicatePolicy: "skip",
      });

      const message = createValidMessage();
      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow(ConfigurationError);
    });
  });

  // ==========================================================================
  // 4. WRITE-AHEAD LOG (WAL) & CRASH BOUNDARIES
  // ==========================================================================
  describe("Write-Ahead Log (WAL) & Crash Boundaries", () => {
    it("13. WAL intent is persisted before payload write", async () => {
      const intentRecorded = vi.fn();
      const originalPutPayload = payloadStorage.putPayload.bind(payloadStorage);

      // Spy on putPayload to verify that putWalEntry was called first
      vi.spyOn(payloadStorage, "putPayload").mockImplementation(async (p) => {
        const walEntries = await payloadStorage.getAllWalEntries();
        expect(walEntries.length).toBeGreaterThanOrEqual(1);
        expect(walEntries[0]?.phase).toBe(WalPhase.INTENT);
        intentRecorded();
        return originalPutPayload(p);
      });

      const message = createValidMessage();
      await handler.handleMessageAndEnqueue(message, validSender);
      expect(intentRecorded).toHaveBeenCalled();
    });

    it("14. Payload write failure leaves recoverable WAL state (marked rolled back)", async () => {
      vi.spyOn(payloadStorage, "putPayload").mockRejectedValue(
        new Error("IndexedDB quota exceeded or disk failure"),
      );

      const message = createValidMessage();
      await expect(
        handler.handleMessageAndEnqueue(message, validSender),
      ).rejects.toThrow("IndexedDB quota exceeded or disk failure");

      // WAL entry was written and marked ROLLED_BACK on failure
      const walEntries = await payloadStorage.getAllWalEntries();
      expect(walEntries).toHaveLength(1);
      expect(walEntries[0]?.phase).toBe(WalPhase.ROLLED_BACK);

      // Reconciler safely cleans up rolled back entries
      const recon = await queueManager.reconcileWalAndOrphans();
      expect(recon.reconciledWalCount).toBe(0);
      const remainingWal = await payloadStorage.getAllWalEntries();
      expect(remainingWal).toHaveLength(0);
    });

    it("15. Metadata failure leaves recoverable WAL state and restores to PENDING (Crash Boundary C)", async () => {
      // Simulate Crash Boundary C: WAL Intent written, payload written to IndexedDB,
      // but process crashed before metadata write to storage.local could complete
      const entityId = crypto.randomUUID();
      const walId = crypto.randomUUID();
      const payloadId = `payload:${entityId}`;
      const code = "int crashBoundaryCSolution() { return 100; }\n";

      await payloadStorage.putWalEntry({
        id: walId,
        operationType: "ENQUEUE_SUBMISSION",
        entityId,
        payloadId,
        intendedState: QueueState.PENDING,
        phase: WalPhase.INTENT,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        snapshot: {
          submission: {
            id: entityId,
            platform: "leetcode",
            submissionId: "sub_boundary_c",
            submissionUrl: "https://leetcode.com",
            targetRepository: "octocat/leetcode-solutions",
            targetBranch: "main",
            problemTitle: "Boundary C Problem",
            problemSlug: "boundary-c-problem",
            problemId: "boundary_c",
            status: "ACCEPTED",
            language: "cpp",
            sourceCode: code,
            submittedAt: Date.now(),
            detectedAt: Date.now(),
            targetSnapshot: {
              targetRepository: "octocat/leetcode-solutions",
              targetBranch: "main",
              basePath: "solutions",
              duplicatePolicy: "REPLACE_IF_DIFFERENT",
            },
          },
        },
      });

      await payloadStorage.putPayload({
        id: payloadId,
        sourceCode: code,
        createdAt: Date.now(),
      });

      // Execute crash recovery
      const recon = await queueManager.reconcileWalAndOrphans();
      expect(recon.reconciledWalCount).toBe(1);

      // Verify metadata was recovered into storage.local with PENDING state
      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.id).toBe(entityId);
      expect(queue[0]?.state).toBe(QueueState.PENDING);
      expect(queue[0]?.crashCount).toBe(1);
      expect(queue[0]?.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(queue[0]?.targetSnapshot?.targetBranch).toBe("main");

      // WAL entry must be pruned upon recovery
      const walEntries = await payloadStorage.getAllWalEntries();
      expect(walEntries).toHaveLength(0);
    });

    it("16. WAL replay and recovery is strictly idempotent", async () => {
      // Simulate uncommitted WAL intent where payload exists
      const walId = crypto.randomUUID();
      const entityId = crypto.randomUUID();
      const payloadId = `payload:${entityId}`;
      await payloadStorage.putPayload({
        id: payloadId,
        sourceCode: "int main() {}\n",
        createdAt: Date.now(),
      });
      await payloadStorage.putWalEntry({
        id: walId,
        operationType: "ENQUEUE_SUBMISSION",
        entityId,
        payloadId,
        intendedState: QueueState.PENDING,
        phase: WalPhase.INTENT,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        snapshot: {
          submission: {
            id: entityId,
            platform: "leetcode",
            submissionId: "sub_1",
            submissionUrl: "https://leetcode.com",
            targetRepository: "octocat/leetcode-solutions",
            targetBranch: "main",
            problemTitle: "Recovered",
            problemSlug: "recovered",
            problemId: "1",
            status: "ACCEPTED",
            language: "cpp",
            sourceCode: "int main() {}\n",
            submittedAt: Date.now(),
            detectedAt: Date.now(),
          },
        },
      });

      // First recovery pass reconciles 1 item
      const pass1 = await queueManager.reconcileWalAndOrphans();
      expect(pass1.reconciledWalCount).toBe(1);

      // Second recovery pass is strictly idempotent (0 changes)
      const pass2 = await queueManager.reconcileWalAndOrphans();
      expect(pass2.reconciledWalCount).toBe(0);
      expect(pass2.recoveredOrphanPayloads).toBe(0);
      expect(pass2.quarantinedOrphanMetadata).toBe(0);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
    });

    it("17. Crash/restart recovery works cleanly", async () => {
      const message = createValidMessage();
      await handler.handleMessageAndEnqueue(message, validSender);

      // Simulate extension service worker restart: new QueueManager instance
      const restartedQueue = new QueueManager(
        storage,
        payloadStorage,
        concurrency,
      );
      const recon = await restartedQueue.reconcileWalAndOrphans();
      expect(recon.reconciledWalCount).toBe(0);
      expect(recon.recoveredOrphanPayloads).toBe(0);
      expect(recon.quarantinedOrphanMetadata).toBe(0);

      const items = await restartedQueue.getQueue();
      expect(items).toHaveLength(1);
      expect(items[0]?.state).toBe(QueueState.PENDING);
    });

    it("18. Orphan payload handling recovers into REQUIRES_ATTENTION without data loss", async () => {
      // Payload exists in IndexedDB without queue metadata
      const orphanId = "payload:orphan-123";
      await payloadStorage.putPayload({
        id: orphanId,
        sourceCode: "int orphanCode() { return 99; }\n",
        createdAt: Date.now(),
      });

      const recon = await queueManager.reconcileWalAndOrphans();
      expect(recon.recoveredOrphanPayloads).toBe(1);

      const queue = await storage.getQueueMetadata();
      const recovered = queue.find((i) => i.payloadId === orphanId);
      expect(recovered).toBeDefined();
      expect(recovered?.state).toBe(QueueState.REQUIRES_ATTENTION);
      expect(recovered?.status).toBe("RECOVERED_ORPHAN_PAYLOAD");
    });

    it("19. Orphan metadata handling quarantines to REQUIRES_ATTENTION (PAYLOAD_NOT_FOUND)", async () => {
      // Metadata in storage.local points to non-existent IndexedDB payload
      const fakeMetadata: QueueItemMetadata = {
        id: crypto.randomUUID(),
        payloadId: "payload:does-not-exist",
        platform: "leetcode",
        problemSlug: "ghost-problem",
        problemTitle: "Ghost Problem",
        targetRepository: "octocat/repo",
        targetBranch: "main",
        language: "cpp",
        status: "ACCEPTED",
        contentHash: "a".repeat(64),
        state: QueueState.PENDING,
        attempts: 0,
        crashCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await storage.setQueueMetadata([fakeMetadata]);

      const recon = await queueManager.reconcileWalAndOrphans();
      expect(recon.quarantinedOrphanMetadata).toBe(1);

      const queue = await storage.getQueueMetadata();
      expect(queue[0]?.state).toBe(QueueState.REQUIRES_ATTENTION);
      expect(queue[0]?.lastError?.code).toBe(ErrorCode.PAYLOAD_NOT_FOUND);
    });
  });

  // ==========================================================================
  // 5. DUPLICATE ENQUEUE PROTECTION
  // ==========================================================================
  describe("Duplicate Enqueue Protection", () => {
    it("20. Duplicate submission event does not create uncontrolled duplicate queue work", async () => {
      const candidate = createValidCandidate();
      const message1 = createValidMessage(candidate, crypto.randomUUID());
      const message2 = createValidMessage(candidate, crypto.randomUUID()); // New message with same candidate code & problem

      const result1 = await handler.handleMessageAndEnqueue(
        message1,
        validSender,
      );
      expect(result1.success).toBe(true);

      const result2 = await handler.handleMessageAndEnqueue(
        message2,
        validSender,
      );
      expect(result2.success).toBe(true);

      // Both calls return the exact same queue item ID
      expect(result2.queueItem?.id).toBe(result1.queueItem?.id);

      // Queue contains exactly one item
      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 6. CONCURRENCY & FENCING
  // ==========================================================================
  describe("Concurrency & Fencing Preservation", () => {
    it("21. Concurrent enqueue operations preserve queue consistency", async () => {
      const candidates = [
        createValidCandidate({ problemSlug: "two-sum", problemId: "1" }),
        createValidCandidate({
          problemSlug: "add-two-numbers",
          problemId: "2",
        }),
        createValidCandidate({
          problemSlug: "longest-substring",
          problemId: "3",
        }),
      ];

      // Enqueue concurrently
      await Promise.all(
        candidates.map((c) =>
          handler.handleMessageAndEnqueue(createValidMessage(c), validSender),
        ),
      );

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(3);
      const slugs = queue.map((i) => i.problemSlug);
      expect(slugs).toContain("two-sum");
      expect(slugs).toContain("add-two-numbers");
      expect(slugs).toContain("longest-substring");
    });

    it("22. Existing fencing behavior remains intact", async () => {
      const workerId = crypto.randomUUID();
      const lease = await concurrency.acquirePersistentLease(
        workerId,
        "submission_event",
      );
      expect(lease.acquired).toBe(true);
      expect(lease.fencingToken).toBe(1);

      await expect(
        concurrency.validateFencingToken(workerId, lease.fencingToken),
      ).resolves.not.toThrow();
    });

    it("23. Stale worker cannot mutate protected state", async () => {
      const workerA = crypto.randomUUID();
      const leaseA = await concurrency.acquirePersistentLease(workerA, "alarm");

      // Fast-forward / expire leaseA, and Worker B acquires lease with token 2
      const lease = (await storage.getLease())!;
      lease.expiresAt = Date.now() - 1000;
      await storage.setLease(lease);

      const workerB = crypto.randomUUID();
      const leaseB = await concurrency.acquirePersistentLease(workerB, "alarm");
      expect(leaseB.fencingToken).toBe(2);

      // Worker A attempts to validate with stale token 1
      await expect(
        concurrency.validateFencingToken(workerA, leaseA.fencingToken),
      ).rejects.toThrow(StaleLeaseError);
    });
  });

  // ==========================================================================
  // 7. PRIVACY & SECURITY
  // ==========================================================================
  describe("Privacy & Leak Prevention", () => {
    it("24. Queue metadata contains no credentials or tokens", async () => {
      const message = createValidMessage();
      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );
      const metadata = result.queueItem!;

      const metadataString = JSON.stringify(metadata);
      expect(metadataString).not.toContain("ghu_");
      expect(metadataString).not.toContain("ghr_");
      expect(metadataString).not.toContain("token");
      expect(metadataString).not.toContain("secret");
      expect(metadataString).not.toContain("password");
    });

    it("25. Diagnostics contain no raw source code", async () => {
      const candidateWithDiagnostics = createValidCandidate({
        diagnostics: {
          domSnapshot: "div.container",
          detectedLines: 15,
        },
      });
      const message = createValidMessage(candidateWithDiagnostics);
      const result = await handler.handleMessageAndEnqueue(
        message,
        validSender,
      );

      const metadata = result.queueItem!;
      expect(JSON.stringify(metadata)).not.toContain("int twoSum");
    });

    it("26. Errors do not leak raw source code", async () => {
      const secretSource = "const superSecretSourceCode = 12345;\n";
      const candidate = createValidCandidate({
        sourceCode: secretSource,
        problemSlug: "invalid/slug/traversal/..",
      });
      const message = createValidMessage(candidate);

      try {
        await handler.handleMessageAndEnqueue(message, validSender);
        expect.unreachable("Should have failed validation");
      } catch (err) {
        const errorMsg = (err as Error).message;
        expect(errorMsg).not.toContain("superSecretSourceCode");
      }
    });
  });

  // ==========================================================================
  // 8. PRIMARY END-TO-END INTEGRATION TEST (Section 24)
  // ==========================================================================
  describe("Primary End-to-End Integration Test (Section 24)", () => {
    it("executes simulated accepted platform submission → durable PENDING queue item", async () => {
      // 1. Simulated accepted platform submission on LeetCode
      const leetcodeHtml = `
        <!DOCTYPE html>
        <html>
          <body>
            <div data-cy="question-title">3. Longest Substring Without Repeating Characters</div>
            <div data-e2e-locator="submission-result">Accepted</div>
            <div class="submission-detail-code">class Solution { public: int lengthOfLongestSubstring(string s) { return 3; } };</div>
          </body>
        </html>
      `;
      const adapter = new LeetCodeAdapter();
      const candidate = await adapter.extractSubmission({
        document: parseHTML(leetcodeHtml) as unknown as Document,
        window: {} as Window,
        location: new URL(
          "https://leetcode.com/problems/longest-substring-without-repeating-characters/",
        ),
      });

      expect(candidate).not.toBeNull();
      expect(candidate?.status).toBe("ACCEPTED");

      // 2. Typed extension message from content script
      const message: ExtensionMessage<CanonicalSubmissionCandidate> = {
        id: crypto.randomUUID(),
        type: "SUBMISSION_DETECTED",
        payload: candidate!,
        timestamp: Date.now(),
        senderContext: "content-script",
        trustBoundary: TrustBoundary.SEMI_TRUSTED,
      };

      const lcSender: RuntimeSenderInfo = {
        tab: {
          id: 10,
          url: "https://leetcode.com/problems/longest-substring-without-repeating-characters/",
        },
      };

      // 3. Service worker message boundary & ingestion
      const result = await handler.handleMessageAndEnqueue(message, lcSender);

      // 4. Assertions per Section 24:
      // Exactly one queue item
      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      const item = queue[0]!;

      // Expected submission identity
      expect(item.id).toBe(result.queueItem?.id);
      expect(item.platform).toBe("leetcode");
      expect(item.problemSlug).toBe(
        "longest-substring-without-repeating-characters",
      );

      // Expected content hash
      const expectedNormalized = normalizeSourceCode(candidate!.sourceCode);
      const expectedHash = await computeContentHash(expectedNormalized);
      expect(item.contentHash).toBe(expectedHash);

      // Expected immutable target snapshot
      expect(item.targetSnapshot).toBeDefined();
      expect(item.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(item.targetSnapshot?.targetBranch).toBe("main");
      expect(item.targetSnapshot?.basePath).toBe("solutions");
      expect(item.targetSnapshot?.duplicatePolicy).toBe("REPLACE_IF_DIFFERENT");
      expect(item.targetSnapshot?.authorizationStatus).toBe("AUTHORIZED");
      expect(item.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
      expect(item.validatedBy).toBe("SERVICE_WORKER");

      // Expected payload reference
      expect(item.payloadId).toBe(`payload:${item.id}`);
      const storedPayload = await payloadStorage.getPayload(item.payloadId);
      expect(storedPayload).not.toBeNull();
      expect(storedPayload?.sourceCode).toBe(expectedNormalized);

      // Expected PENDING state
      expect(item.state).toBe(QueueState.PENDING);

      // Recoverable WAL state (all WAL entries pruned upon commit)
      const walLogs = await payloadStorage.getAllWalEntries();
      expect(walLogs).toHaveLength(0);

      // No credential exposure
      const serialized = JSON.stringify(item);
      expect(serialized).not.toContain("ghu_");
      expect(serialized).not.toContain("ghr_");
    });
  });

  // ==========================================================================
  // 9. CORRECTION PASS — FINDING 1: DUPLICATE ENQUEUE IDENTITY
  // ==========================================================================
  describe("Correction Pass — Finding 1: Duplicate Enqueue Identity (DUP-01 to DUP-06)", () => {
    it("DUP-01: Same event/submission delivered twice → exactly one active queue item", async () => {
      const candidate = createValidCandidate({ submissionId: "sub_101" });
      const msg1 = createValidMessage(candidate, crypto.randomUUID());
      const msg2 = createValidMessage(candidate, crypto.randomUUID());

      const res1 = await handler.handleMessageAndEnqueue(msg1, validSender);
      expect(res1.success).toBe(true);

      const res2 = await handler.handleMessageAndEnqueue(msg2, validSender);
      expect(res2.success).toBe(true);
      expect(res2.queueItem?.id).toBe(res1.queueItem?.id);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
    });

    it("DUP-02: Same platform + same problem + same contentHash but DIFFERENT submissionId → MUST NOT be incorrectly collapsed", async () => {
      const candidate1 = createValidCandidate({
        problemSlug: "two-sum",
        submissionId: "sub_101",
        sourceCode: "int solution() { return 1; }\n",
      });
      const candidate2 = createValidCandidate({
        problemSlug: "two-sum",
        submissionId: "sub_102", // Different submission on the platform!
        sourceCode: "int solution() { return 1; }\n", // Identical source code!
      });

      const res1 = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate1),
        validSender,
      );
      const res2 = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate2),
        validSender,
      );

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res1.queueItem?.id).not.toBe(res2.queueItem?.id);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(2);
      expect(queue[0]?.submissionId).toBe("sub_101");
      expect(queue[1]?.submissionId).toBe("sub_102");
      expect(queue[0]?.contentHash).toBe(queue[1]?.contentHash);
    });

    it("DUP-03: Same submissionId delivered twice → exactly one queue item", async () => {
      const candidate = createValidCandidate({ submissionId: "sub_dup_3" });
      await handler.handleMessageAndEnqueue(
        createValidMessage(candidate, crypto.randomUUID()),
        validSender,
      );
      await handler.handleMessageAndEnqueue(
        createValidMessage(candidate, crypto.randomUUID()),
        validSender,
      );

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
      expect(queue[0]?.submissionId).toBe("sub_dup_3");
    });

    it("DUP-04: Distinct submissions with identical source → verify intended behavior explicitly", async () => {
      const subA = createValidCandidate({
        problemSlug: "problem-a",
        submissionId: "sub_a",
        sourceCode: "return 42;\n",
      });
      const subB = createValidCandidate({
        problemSlug: "problem-b",
        submissionId: "sub_b",
        sourceCode: "return 42;\n",
      });

      const resA = await handler.handleMessageAndEnqueue(
        createValidMessage(subA),
        validSender,
      );
      const resB = await handler.handleMessageAndEnqueue(
        createValidMessage(subB),
        validSender,
      );

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.queueItem?.id).not.toBe(resB.queueItem?.id);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(2);
    });

    it("DUP-05: Replay of the same message/event → no uncontrolled duplicate enqueue", async () => {
      const candidate = createValidCandidate({ submissionId: "sub_replay_5" });
      const msg = createValidMessage(candidate);

      const res1 = await handler.handleMessageAndEnqueue(msg, validSender);
      expect(res1.success).toBe(true);

      // Replaying identical message nonce triggers replay attack error fail-closed:
      await expect(
        handler.handleMessageAndEnqueue(msg, validSender),
      ).rejects.toThrow(EnvelopeValidationError);

      // Re-delivering same candidate with fresh nonces returns existing queue item:
      for (let i = 0; i < 4; i++) {
        const freshMsg = createValidMessage(candidate, crypto.randomUUID());
        const res = await handler.handleMessageAndEnqueue(
          freshMsg,
          validSender,
        );
        expect(res.success).toBe(true);
        expect(res.queueItem?.id).toBe(res1.queueItem?.id);
      }

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(1);
    });

    it("DUP-06: Restart/recovery after enqueue → recovery does not create another logical submission", async () => {
      const candidate = createValidCandidate({ submissionId: "sub_recover_6" });
      await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      const queueBefore = await storage.getQueueMetadata();
      expect(queueBefore).toHaveLength(1);

      // Trigger recovery
      await queueManager.reconcileWalAndOrphans();

      const queueAfter = await storage.getQueueMetadata();
      expect(queueAfter).toHaveLength(1);
      expect(queueAfter[0]?.submissionId).toBe("sub_recover_6");
    });
  });

  // ==========================================================================
  // 10. CORRECTION PASS — FINDING 2: EXTRACTION PROVENANCE vs VALIDATION AUTHORITY
  // ==========================================================================
  describe("Correction Pass — Finding 2: Extraction Provenance vs Validation Authority (PROV-01 to PROV-08)", () => {
    it("PROV-01: EDITOR_SOURCE candidate → remains identifiable as editor-derived after enqueue", async () => {
      const candidate = createValidCandidate({
        sourceProvenance: "EDITOR_SOURCE",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.sourceProvenance).toBe("EDITOR_SOURCE");
      expect(res.queueItem?.validatedBy).toBe("SERVICE_WORKER");

      const queue = await storage.getQueueMetadata();
      expect(queue[0]?.sourceProvenance).toBe("EDITOR_SOURCE");
      expect(queue[0]?.validatedBy).toBe("SERVICE_WORKER");
    });

    it("PROV-02: SUBMISSION_PAGE_SOURCE candidate → remains identifiable as submission-page-derived", async () => {
      const candidate = createValidCandidate({
        sourceProvenance: "SUBMISSION_PAGE_SOURCE",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
      expect(res.queueItem?.validatedBy).toBe("SERVICE_WORKER");
    });

    it("PROV-03: AUTHORITATIVE_SUBMISSION_SOURCE → remains reserved for genuinely authoritative extraction", async () => {
      const candidate = createValidCandidate({
        sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.sourceProvenance).toBe(
        "AUTHORITATIVE_SUBMISSION_SOURCE",
      );
      expect(res.queueItem?.validatedBy).toBe("SERVICE_WORKER");
    });

    it("PROV-04: Service-worker validation authority → does not overwrite extraction provenance", async () => {
      const candidate = createValidCandidate({
        sourceProvenance: "DOM_FALLBACK_SOURCE",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      // Must NOT be rewritten to AUTHORITATIVE_SUBMISSION_SOURCE
      expect(res.queueItem?.sourceProvenance).toBe("DOM_FALLBACK_SOURCE");
      expect(res.queueItem?.sourceProvenance).not.toBe(
        "AUTHORITATIVE_SUBMISSION_SOURCE",
      );
      // But validatedBy explicitly documents the service worker validation authority
      expect(res.queueItem?.validatedBy).toBe("SERVICE_WORKER");
    });

    it("PROV-05: Page-controlled provenance spoofing → rejected", async () => {
      const invalidCandidate = createValidCandidate({
        sourceProvenance:
          "PAGE_SCRIPT_AUTHORITATIVE" as unknown as "AUTHORITATIVE_SUBMISSION_SOURCE",
      });
      await expect(
        handler.handleMessageAndEnqueue(
          createValidMessage(invalidCandidate),
          validSender,
        ),
      ).rejects.toThrow(PlatformAdapterError);

      const queue = await storage.getQueueMetadata();
      expect(queue).toHaveLength(0);
    });

    it("PROV-06: Tampered provenance transition → rejected/fails closed", async () => {
      const tamperedCandidate = createValidCandidate({
        sourceProvenance:
          "AUTHORITATIVE_SERVICE_WORKER" as unknown as "AUTHORITATIVE_SUBMISSION_SOURCE",
      });
      await expect(
        handler.handleMessageAndEnqueue(
          createValidMessage(tamperedCandidate),
          validSender,
        ),
      ).rejects.toThrow(PlatformAdapterError);
    });

    it("PROV-07: WAL recovery → preserves the original extraction provenance", async () => {
      const itemId = crypto.randomUUID();
      const walId = crypto.randomUUID();
      const payloadId = `payload:${itemId}`;

      await payloadStorage.putWalEntry({
        id: walId,
        operationType: "ENQUEUE_SUBMISSION",
        entityId: itemId,
        payloadId,
        intendedState: QueueState.PENDING,
        phase: WalPhase.INTENT,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        snapshot: {
          submission: {
            id: itemId,
            platform: "leetcode",
            submissionId: "sub_wal_prov",
            submissionUrl: "https://leetcode.com",
            targetRepository: "octocat/leetcode-solutions",
            targetBranch: "main",
            problemTitle: "Two Sum",
            problemSlug: "two-sum",
            problemId: "1",
            status: "ACCEPTED",
            language: "cpp",
            sourceCode: "int x = 1;\n",
            contentHash: "hash-val",
            submittedAt: Date.now(),
            detectedAt: Date.now(),
            sourceProvenance: "EDITOR_SOURCE",
            validatedBy: "SERVICE_WORKER",
            targetSnapshot: {
              targetRepository: "octocat/leetcode-solutions",
              targetBranch: "main",
              basePath: "solutions",
              duplicatePolicy: "skip",
              authorizationStatus: "AUTHORIZED",
            },
          },
        },
      });

      await payloadStorage.putPayload({
        id: payloadId,
        sourceCode: "int x = 1;\n",
        createdAt: Date.now(),
      });

      // Recover
      await queueManager.reconcileWalAndOrphans();

      const queue = await storage.getQueueMetadata();
      const recovered = queue.find((i) => i.id === itemId);
      expect(recovered).toBeDefined();
      expect(recovered?.sourceProvenance).toBe("EDITOR_SOURCE");
      expect(recovered?.validatedBy).toBe("SERVICE_WORKER");
    });

    it("PROV-08: Queue metadata → preserves provenance semantics without granting it security authority", async () => {
      const candidate = createValidCandidate({
        sourceProvenance: "EDITOR_SOURCE",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.sourceProvenance).toBe("EDITOR_SOURCE");
      expect(res.queueItem?.validatedBy).toBe("SERVICE_WORKER");
      expect(res.queueItem?.state).toBe(QueueState.PENDING);
    });
  });

  // ==========================================================================
  // 11. CORRECTION PASS — FINDING 3: TARGET REPOSITORY AUTHORIZATION
  // ==========================================================================
  describe("Correction Pass — Finding 3: Target Repository Authorization (AUTHZ-01 to AUTHZ-09)", () => {
    it("AUTHZ-01: Syntactically valid repository configuration → passes local syntax validation", () => {
      expect(validateRepositoryIdentity("octocat/leetcode-solutions")).toBe(
        "octocat/leetcode-solutions",
      );
      expect(validateRepositoryIdentity("my-org/my.repo_1")).toBe(
        "my-org/my.repo_1",
      );
    });

    it("AUTHZ-02: Invalid repository syntax → rejected", () => {
      expect(() => validateRepositoryIdentity("invalid-syntax")).toThrow(
        ConfigurationError,
      );
      expect(() => validateRepositoryIdentity("owner/repo/extra")).toThrow(
        ConfigurationError,
      );
      expect(() => validateRepositoryIdentity("../evil/repo")).toThrow(
        ConfigurationError,
      );
      expect(() => validateRepositoryIdentity("owner/repo;rm")).toThrow(
        ConfigurationError,
      );
    });

    it("AUTHZ-03: Target snapshot contains only trusted extension configuration data", async () => {
      const candidate = createValidCandidate();
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(res.queueItem?.targetSnapshot?.targetBranch).toBe("main");
      expect(res.queueItem?.targetSnapshot?.basePath).toBe("solutions");
      expect(res.queueItem?.targetSnapshot?.duplicatePolicy).toBe(
        "REPLACE_IF_DIFFERENT",
      );
    });

    it("AUTHZ-04: Content script cannot supply/override target repository", async () => {
      const candidate = createValidCandidate();
      (candidate as unknown as Record<string, unknown>).targetRepository =
        "attacker/compromised-repo";

      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
      expect(res.queueItem?.targetRepository).toBe(
        "octocat/leetcode-solutions",
      );
    });

    it("AUTHZ-05: Content script cannot supply/override branch", async () => {
      const candidate = createValidCandidate();
      (candidate as unknown as Record<string, unknown>).targetBranch =
        "malicious-branch";

      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.targetBranch).toBe("main");
      expect(res.queueItem?.targetBranch).toBe("main");
    });

    it("AUTHZ-06: Content script cannot supply/override base path", async () => {
      const candidate = createValidCandidate();
      (candidate as unknown as Record<string, unknown>).basePath =
        "../../etc/cron.d";

      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.basePath).toBe("solutions");
    });

    it("AUTHZ-07: Content script cannot supply/override duplicate policy", async () => {
      const candidate = createValidCandidate();
      (candidate as unknown as Record<string, unknown>).duplicatePolicy =
        "UNSAFE_FORCE_OVERWRITE";

      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.duplicatePolicy).toBe(
        "REPLACE_IF_DIFFERENT",
      );
    });

    it("AUTHZ-08: If authorization is not yet verified in 1C.4.1, the system MUST NOT falsely mark the target as GitHub-authorized", async () => {
      await storage.set(STORAGE_KEYS.CONFIG, {
        targetRepository: "unverified-org/unverified-repo",
        targetBranch: "main",
        baseFolder: "solutions",
        duplicatePolicy: "skip",
        enabledPlatforms: { leetcode: true },
      });

      const candidate = createValidCandidate({
        submissionId: "sub_unverified",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      expect(res.queueItem?.targetSnapshot?.authorizationStatus).toBe(
        "CONFIGURED_UNVERIFIED",
      );
      expect(res.queueItem?.targetSnapshot?.authorizationStatus).not.toBe(
        "AUTHORIZED",
      );
    });

    it("AUTHZ-09: Later queue processing remains responsible for authoritative GitHub repository authorization", async () => {
      await storage.set(STORAGE_KEYS.CONFIG, {
        targetRepository: "drain-org/pending-auth-repo",
        targetBranch: "main",
        baseFolder: "solutions",
        duplicatePolicy: "skip",
        enabledPlatforms: { leetcode: true },
      });

      const candidate = createValidCandidate({
        submissionId: "sub_authz_09",
      });
      const res = await handler.handleMessageAndEnqueue(
        createValidMessage(candidate),
        validSender,
      );

      expect(res.success).toBe(true);
      const item = res.queueItem!;
      expect(item.state).toBe(QueueState.PENDING);
      expect(item.targetSnapshot?.authorizationStatus).toBe(
        "CONFIGURED_UNVERIFIED",
      );
      expect(item.targetRepository).toBe("drain-org/pending-auth-repo");
    });
  });
});
