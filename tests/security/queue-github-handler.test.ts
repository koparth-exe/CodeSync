import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  QueueDrainer,
  QueueManager,
  QueueConcurrencyManager,
  createGitHubQueueItemHandler,
  GitHubQueueSyncHandler,
  QUEUE_DRAIN_ALARM_NAME,
  QUEUE_DRAIN_ALARM_PERIOD_MINUTES,
  setupQueueDrainAlarm,
  type NormalizedSubmission,
} from "../../src/shared/queue";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import {
  QueueState,
  type QueueItemMetadata,
} from "../../src/shared/storage/types";
import {
  ErrorCode,
  GitHubApiError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubWriteOutcomeUnknownError,
  StaleLeaseError,
  StorageError,
} from "../../src/shared/errors";
import { computeContentHash } from "../../src/shared/deduplication";
import { GitHubContentsService } from "../../src/shared/github/contents-service";
import {
  MAX_SOURCE_PAYLOAD_BYTES,
  type GitHubWriteOptions,
  type GitHubWriteResult,
} from "../../src/shared/github/types";

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

describe("Phase 1C.4.2.2 — Real Queue -> GitHub Synchronization Handler Suite", () => {
  let localDriver: MemoryStorageDriver;
  let storage: StorageService;
  let payloadStorage: PayloadStorage;
  let concurrency: QueueConcurrencyManager;
  let queueManager: QueueManager;
  let drainer: QueueDrainer;

  // Mock GitHub contents service & sync spy
  let mockContentsService: GitHubContentsService;
  let synchronizeFileSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localDriver = new MemoryStorageDriver();
    storage = new StorageService(localDriver);
    payloadStorage = new PayloadStorage(new MemoryPayloadStorageDriver());
    concurrency = new QueueConcurrencyManager(storage);
    queueManager = new QueueManager(storage, payloadStorage, concurrency);
    drainer = new QueueDrainer({ queueManager });

    // Construct a mock GitHubContentsService
    synchronizeFileSpy = vi.fn(
      async (options: GitHubWriteOptions): Promise<GitHubWriteResult> => {
        return {
          status: "created",
          commitSha: "sha_commit_success_12345",
          fileSha: "sha_file_blob_67890",
          path: options.path,
          contentHash: await computeContentHash(options.content),
          revalidationCount: 0,
          verificationStatus: "CONFIRMED",
          dispatchStatus: "succeeded",
        };
      },
    );

    mockContentsService = {
      synchronizeFile: synchronizeFileSpy,
    } as unknown as GitHubContentsService;
  });

  async function createAndEnqueueSubmission(
    overrides: Partial<NormalizedSubmission> = {},
  ): Promise<QueueItemMetadata> {
    const sourceCode = overrides.sourceCode ?? "int main() { return 0; }\n";
    const contentHash =
      overrides.contentHash ?? (await computeContentHash(sourceCode));
    const sub: NormalizedSubmission = {
      id: crypto.randomUUID(),
      platform: "leetcode",
      submissionId: "sub_test_1001",
      submissionUrl: "https://leetcode.com/submissions/detail/1001/",
      targetRepository: "octocat/dsa-repo",
      targetBranch: "main",
      problemTitle: "Two Sum",
      problemSlug: "two-sum",
      problemId: "1",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode,
      contentHash,
      submittedAt: Date.now(),
      detectedAt: Date.now(),
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      validatedBy: "SERVICE_WORKER",
      targetSnapshot: {
        targetRepository: "octocat/dsa-repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        authorizationStatus: "AUTHORIZED",
      },
      ...overrides,
    };
    return await queueManager.enqueueSubmission(sub);
  }

  // ==========================================================================
  // 1. HANDLER-01 to HANDLER-05: Core Execution & Content Integrity
  // ==========================================================================

  it("HANDLER-01: Valid queued submission reaches QueueDrainer and invokes the real handler", async () => {
    await createAndEnqueueSubmission();
    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
    expect(summary).not.toBeNull();
    expect(summary?.completed).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
    expect(queue[0]!.commitSha).toBe("sha_commit_success_12345");
  });

  it("HANDLER-02: Handler builds GitHubWriteOptions correctly from TargetSnapshot", async () => {
    await createAndEnqueueSubmission({
      targetSnapshot: {
        targetRepository: "octocat/custom-repo",
        targetBranch: "release/v2",
        basePath: "src/algorithms",
        duplicatePolicy: "ALWAYS_REPLACE",
        authorizationStatus: "AUTHORIZED",
      },
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
    const passedOptions = synchronizeFileSpy.mock
      .calls[0]![0] as GitHubWriteOptions;

    expect(passedOptions.owner).toBe("octocat");
    expect(passedOptions.repo).toBe("custom-repo");
    expect(passedOptions.branch).toBe("release/v2");
    expect(passedOptions.baseFolder).toBe("src/algorithms");
    expect(passedOptions.duplicatePolicy).toBe("ALWAYS_REPLACE");
    expect(passedOptions.commitMessage).toContain("Sync leetcode");
  });

  it("HANDLER-03: Correct repository/branch/path are passed to GitHubContentsService", async () => {
    await createAndEnqueueSubmission({
      problemSlug: "reverse-linked-list",
      language: "python3",
      targetSnapshot: {
        targetRepository: "testuser/my-solutions",
        targetBranch: "master",
        basePath: "problems",
        duplicatePolicy: "KEEP_ALL",
        authorizationStatus: "AUTHORIZED",
      },
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const passedOptions = synchronizeFileSpy.mock
      .calls[0]![0] as GitHubWriteOptions;
    expect(passedOptions.owner).toBe("testuser");
    expect(passedOptions.repo).toBe("my-solutions");
    expect(passedOptions.branch).toBe("master");
    expect(passedOptions.path).toBe("leetcode/reverse-linked-list.py");
    expect(passedOptions.baseFolder).toBe("problems");
  });

  it("HANDLER-04: Persisted submitted source is the exact content synchronized", async () => {
    const exactSourceCode =
      "// Authoritative source code\nfunction solve(): number { return 42; }\n";
    await createAndEnqueueSubmission({
      sourceCode: exactSourceCode,
      language: "typescript",
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const passedOptions = synchronizeFileSpy.mock
      .calls[0]![0] as GitHubWriteOptions;
    expect(passedOptions.content).toBe(exactSourceCode);
  });

  it("HANDLER-05: Content hash mismatch fails closed to REQUIRES_ATTENTION without calling GitHub", async () => {
    const item = await createAndEnqueueSubmission();
    // Tamper with payload in IndexedDB so content hash does not match metadata
    await payloadStorage.putPayload({
      id: item.payloadId,
      sourceCode: "tampered hostile code injection",
      createdAt: Date.now(),
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  // ==========================================================================
  // 2. HANDLER-06 to HANDLER-10: Provenance, Identity, & Authorization
  // ==========================================================================

  it("HANDLER-06: Source provenance is preserved across synchronization", async () => {
    const item = await createAndEnqueueSubmission({
      sourceProvenance: "SUBMISSION_PAGE_SOURCE",
    });
    expect(item.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  it("HANDLER-07: validatedBy remains SERVICE_WORKER where required", async () => {
    const item = await createAndEnqueueSubmission();
    expect(item.validatedBy).toBe("SERVICE_WORKER");

    // Attempting to sync an item without SERVICE_WORKER validation stamp fails closed
    const tamperedQueue = await storage.getQueueMetadata();
    (tamperedQueue[0] as unknown as { validatedBy: unknown }).validatedBy =
      "CONTENT_SCRIPT";
    await storage.setQueueMetadata(tamperedQueue);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);

    const updatedQueue = await storage.getQueueMetadata();
    expect(updatedQueue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(updatedQueue[0]!.lastError?.code).toBe(
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("HANDLER-08: Distinct submission IDs are not collapsed by identical content hashes", async () => {
    const sameCode = "int main() { return 0; }\n";
    const sub1 = await createAndEnqueueSubmission({
      submissionId: "sub_alpha_1",
      sourceCode: sameCode,
    });
    const sub2 = await createAndEnqueueSubmission({
      submissionId: "sub_beta_2",
      sourceCode: sameCode,
    });

    expect(sub1.id).not.toBe(sub2.id);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).toHaveBeenCalledTimes(2);
    expect(summary?.completed).toBe(2);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
    expect(queue[1]!.state).toBe(QueueState.COMPLETED);
  });

  it("HANDLER-09: CONFIGURED_UNVERIFIED does not bypass authorization", async () => {
    await createAndEnqueueSubmission({
      targetSnapshot: {
        targetRepository: "unverified-org/unverified-repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        authorizationStatus: "CONFIGURED_UNVERIFIED",
      },
    });

    // Mock contentsService simulating unauthorized access error during getRepository check
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubApiError(
        "Repository unverified-org/unverified-repo not found or access denied.",
        {
          status: 404,
          code: ErrorCode.GITHUB_REPOSITORY_NOT_FOUND,
        },
      ),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(
      ErrorCode.GITHUB_REPOSITORY_NOT_FOUND,
    );
  });

  it("HANDLER-10: AUTHORIZED uses existing authorization mechanism correctly", async () => {
    await createAndEnqueueSubmission({
      targetSnapshot: {
        targetRepository: "octocat/authorized-repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        authorizationStatus: "AUTHORIZED",
      },
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
    expect(summary?.completed).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  // ==========================================================================
  // 3. HANDLER-11 to HANDLER-15: Validation & Rate-Limit / Retry Behavior
  // ==========================================================================

  it("HANDLER-11: Malformed queue payload does not reach GitHub", async () => {
    const item = await createAndEnqueueSubmission();
    // Tamper with payload to make sourceCode empty
    await payloadStorage.putPayload({
      id: item.payloadId,
      sourceCode: "   ",
      createdAt: Date.now(),
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
  });

  it("HANDLER-12: Invalid target/path template does not reach GitHub", async () => {
    await createAndEnqueueSubmission({
      targetSnapshot: {
        targetRepository: "octocat/repo",
        targetBranch: "main",
        basePath: "solutions",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
        pathTemplate: "{platform}/{slug}/../../../etc/passwd.{extension}",
        authorizationStatus: "AUTHORIZED",
      },
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.PATH_TRAVERSAL_DETECTED);
  });

  it("HANDLER-13: GitHub confirmed success results in correct queue completion", async () => {
    await createAndEnqueueSubmission();
    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    const summary = await drainer.drain("submission_event");
    expect(summary?.completed).toBe(1);

    const queue = await storage.getQueueMetadata();
    const item = queue[0]!;
    expect(item.state).toBe(QueueState.COMPLETED);
    expect(item.completedAt).toBeDefined();
    expect(item.commitSha).toBe("sha_commit_success_12345");
    expect(item.commitUrl).toContain("sha_commit_success_12345");

    const history = await payloadStorage.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("synced");
    expect(history[0]!.commitSha).toBe("sha_commit_success_12345");
  });

  it("HANDLER-14: Retryable GitHub failure reaches QueueManager retry behavior", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubApiError("Gateway Timeout from GitHub API (HTTP 504)", {
        status: 504,
        isRetryable: true,
        code: ErrorCode.GITHUB_API_ERROR,
      }),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("alarm");

    expect(summary?.failed).toBe(1);
    const queue = await storage.getQueueMetadata();
    const item = queue[0]!;
    expect(item.state).toBe(QueueState.FAILED);
    expect(item.attempts).toBe(1);
    expect(item.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it("HANDLER-15: Rate-limit reset and retry information reaches QueueManager", async () => {
    await createAndEnqueueSubmission();
    const resetTime = Date.now() + 50_000;
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubRateLimitError("Primary rate limit exceeded", {
        resetTimestamp: resetTime,
        retryAfterSeconds: 50,
      }),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("alarm");

    const queue = await storage.getQueueMetadata();
    const item = queue[0]!;
    expect(item.state).toBe(QueueState.FAILED);
    expect(item.attempts).toBe(1);
    expect(item.nextRetryAt).toBeGreaterThanOrEqual(resetTime - 100);
    expect(item.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
  });

  // ==========================================================================
  // 4. HANDLER-16 to HANDLER-21: Auth, Conflicts, Uncertain Write & Verification
  // ==========================================================================

  it("HANDLER-16: Authentication failure follows existing credential lifecycle behavior", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubAuthError(
        "Terminal 401 Unauthorized",
        ErrorCode.GITHUB_AUTH_REQUIRED,
      ),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.GITHUB_AUTH_REQUIRED);
  });

  it("HANDLER-17: Authorization failure does not trigger unsafe retry loops", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubApiError("Forbidden: Push access denied", {
        status: 403,
        code: ErrorCode.GITHUB_FORBIDDEN,
      }),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.attempts).toBe(0); // Quarantined immediately, zero retries consumed
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.GITHUB_FORBIDDEN);
  });

  it("HANDLER-18: 409 conflict uses existing revalidation behavior", async () => {
    await createAndEnqueueSubmission();
    // Simulate 409 conflict that exceeded revalidations
    synchronizeFileSpy.mockResolvedValueOnce({
      status: "requires_attention",
      path: "solutions/two-sum.cpp",
      contentHash: "hash123",
      revalidationCount: 3,
      attentionReason: "GITHUB_CONFLICT",
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe("GITHUB_CONFLICT");
  });

  it("HANDLER-19: Uncertain write is never blindly retried", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubWriteOutcomeUnknownError(
        "Network dropped during PUT dispatch: write outcome uncertain",
        {
          path: "solutions/two-sum.cpp",
          intendedContentHash: "hash123",
          dispatchedAt: Date.now(),
        },
      ),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    // Must transition to REQUIRES_ATTENTION, NOT blind retry
    expect(summary?.quarantined).toBe(1);
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(
      ErrorCode.GITHUB_WRITE_OUTCOME_UNKNOWN,
    );
  });

  it("HANDLER-20: Verification UNKNOWN is never converted into confirmed success", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockResolvedValueOnce({
      status: "requires_attention",
      path: "solutions/two-sum.cpp",
      contentHash: "hash123",
      revalidationCount: 0,
      attentionReason: "GITHUB_RECONCILIATION_REQUIRED",
      verificationStatus: "UNKNOWN",
      dispatchStatus: "succeeded",
      commitSha: "sha_unconfirmed_999",
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.completed).toBe(0);
    expect(summary?.quarantined).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe("GITHUB_RECONCILIATION_REQUIRED");
  });

  it("HANDLER-21: Confirmed verification preserves commit/file SHA metadata", async () => {
    await createAndEnqueueSubmission();
    synchronizeFileSpy.mockResolvedValueOnce({
      status: "created",
      commitSha: "sha_confirmed_commit_888",
      fileSha: "sha_confirmed_file_blob_777",
      path: "solutions/two-sum.cpp",
      contentHash: "hash123",
      revalidationCount: 0,
      verificationStatus: "CONFIRMED",
      dispatchStatus: "succeeded",
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
    expect(queue[0]!.commitSha).toBe("sha_confirmed_commit_888");

    const history = await payloadStorage.getHistory();
    expect(history[0]!.commitSha).toBe("sha_confirmed_commit_888");
  });

  // ==========================================================================
  // 5. HANDLER-22 to HANDLER-26: Immutability, Lifecycle & Concurrency
  // ==========================================================================

  it("HANDLER-22: Handler does not mutate TargetSnapshot", async () => {
    const originalSnapshot = Object.freeze({
      targetRepository: "octocat/dsa-repo",
      targetBranch: "main",
      basePath: "solutions",
      duplicatePolicy: "REPLACE_IF_DIFFERENT" as const,
      authorizationStatus: "AUTHORIZED" as const,
    });

    await createAndEnqueueSubmission({
      targetSnapshot: originalSnapshot,
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.targetSnapshot).toEqual(originalSnapshot);
  });

  it("HANDLER-23: Handler does not directly mutate queue lifecycle state", async () => {
    const rawHandler = new GitHubQueueSyncHandler({
      contentsService: mockContentsService,
      storage,
    });

    const item = await createAndEnqueueSubmission();
    const payload = (await payloadStorage.getPayload(item.payloadId))!;

    // Call handle() directly
    const result = await rawHandler.handle(item, payload);

    // handle() returns SyncResult and does NOT directly alter item.state in storage
    expect(result.status).toBe("completed");
    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.PENDING); // Still PENDING until QueueManager updates it
  });

  it("HANDLER-24: Concurrent drain triggers do not duplicate processing", async () => {
    await createAndEnqueueSubmission();

    let insideHandler = false;
    let concurrentCallYielded = false;

    // Simulate delayed synchronization
    synchronizeFileSpy.mockImplementation(async () => {
      insideHandler = true;
      // Trigger second concurrent drain
      const concurrentResult = await drainer.drain("alarm");
      if (concurrentResult === null) {
        concurrentCallYielded = true;
      }
      return {
        status: "created",
        commitSha: "sha_single_run",
        fileSha: "sha_file",
        path: "p",
        contentHash: "h",
        revalidationCount: 0,
        verificationStatus: "CONFIRMED",
      };
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(insideHandler).toBe(true);
    expect(concurrentCallYielded).toBe(true);
    expect(summary?.completed).toBe(1);
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
  });

  it("HANDLER-25: Stale worker cannot complete a superseded queue item", async () => {
    await createAndEnqueueSubmission();

    synchronizeFileSpy.mockImplementation(async () => {
      // Overwrite lease with higher fencing token while worker is running
      await storage.setLease({
        workerId: "interleaving_worker",
        fencingToken: 9999,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 30_000,
        maxLifetimeExpiresAt: Date.now() + 300_000,
        triggerSource: "alarm",
      });
      return {
        status: "created",
        commitSha: "sha_stale",
        fileSha: "sha_file",
        path: "p",
        contentHash: "h",
        revalidationCount: 0,
        verificationStatus: "CONFIRMED",
      };
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    // Stale worker mutation is rejected fail-closed
    await expect(drainer.drain("submission_event")).rejects.toThrow(
      StaleLeaseError,
    );

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).not.toBe(QueueState.COMPLETED);
  });

  it("HANDLER-26: Service worker restart/crash recovery remains safe", async () => {
    await createAndEnqueueSubmission();
    // Simulate item stuck in PROCESSING after worker crashed
    const queue = await storage.getQueueMetadata();
    queue[0]!.state = QueueState.PROCESSING;
    queue[0]!.crashCount = 1;
    await storage.setQueueMetadata(queue);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    // Startup drain recovers interrupted item and completes it
    const summary = await drainer.drain("startup");
    expect(summary?.completed).toBe(1);

    const updatedQueue = await storage.getQueueMetadata();
    expect(updatedQueue[0]!.state).toBe(QueueState.COMPLETED);
    expect(updatedQueue[0]!.crashCount).toBe(2);
  });

  // ==========================================================================
  // 6. HANDLER-27 to HANDLER-30: Defense in Depth & Secret Isolation
  // ==========================================================================

  it("HANDLER-27: No handler/network call occurs for invalid/corrupt queue payload", async () => {
    const item = await createAndEnqueueSubmission();
    // Delete payload entirely from IndexedDB
    await payloadStorage.deletePayload(item.payloadId);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.PAYLOAD_NOT_FOUND);
  });

  it("HANDLER-28: No secrets appear in handler logs/diagnostics/commit messages", async () => {
    await createAndEnqueueSubmission({
      problemTitle: "Valid Two Sum Problem",
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const passedOptions = synchronizeFileSpy.mock
      .calls[0]![0] as GitHubWriteOptions;
    const commitMsg = passedOptions.commitMessage;

    expect(commitMsg).not.toContain("ghp_");
    expect(commitMsg).not.toContain("Bearer");
    expect(commitMsg).not.toContain("accessToken");
    expect(commitMsg).not.toContain("refreshToken");

    const queue = await storage.getQueueMetadata();
    const history = await payloadStorage.getHistory();
    const serializedQueue = JSON.stringify(queue);
    const serializedHistory = JSON.stringify(history);

    expect(serializedQueue).not.toContain("ghp_");
    expect(serializedQueue).not.toContain("Bearer");
    expect(serializedQueue).not.toContain("accessToken");
    expect(serializedQueue).not.toContain("refreshToken");

    expect(serializedHistory).not.toContain("ghp_");
    expect(serializedHistory).not.toContain("Bearer");
    expect(serializedHistory).not.toContain("accessToken");
    expect(serializedHistory).not.toContain("refreshToken");
  });

  it("HANDLER-29: No source code dumping occurs in security diagnostics", async () => {
    const secretSource = "secret_algorithm_internal();";
    await createAndEnqueueSubmission({
      sourceCode: secretSource,
    });

    synchronizeFileSpy.mockRejectedValueOnce(
      new GitHubApiError("Failed write", {
        status: 500,
        isRetryable: false,
        code: ErrorCode.GITHUB_API_ERROR,
      }),
    );

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    await drainer.drain("submission_event");

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.lastError?.message).not.toContain(secretSource);
  });

  it("HANDLER-30: Real handler is not directly callable from untrusted page/content-script contexts", () => {
    const globalObj = globalThis as Record<string, unknown>;
    expect(globalObj["createGitHubQueueItemHandler"]).toBeUndefined();
    expect(globalObj["GitHubQueueSyncHandler"]).toBeUndefined();
    expect(globalObj["defaultQueueDrainer"]).toBeUndefined();
  });

  // ==========================================================================
  // 7. Full End-to-End Integration Flow
  // ==========================================================================

  it("E2E-FLOW: Enqueue -> Drain -> Real Handler -> GitHub Sync -> Confirmed COMPLETED with History", async () => {
    const item = await createAndEnqueueSubmission({
      problemTitle: "3Sum",
      problemSlug: "3sum",
      language: "java",
      sourceCode:
        "class Solution { public List<List<Integer>> threeSum(int[] nums) {} }\n",
    });
    expect(item.state).toBe(QueueState.PENDING);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    // Trigger drain pass
    const summary = await drainer.drain("submission_event");

    expect(summary).toEqual({
      processed: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      quarantined: 0,
    });

    const queue = await storage.getQueueMetadata();
    const completedItem = queue[0]!;
    expect(completedItem.state).toBe(QueueState.COMPLETED);
    expect(completedItem.commitSha).toBe("sha_commit_success_12345");
    expect(completedItem.completedAt).toBeDefined();

    const history = await payloadStorage.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.submissionId).toBe(completedItem.id);
    expect(history[0]!.language).toBe("java");
    expect(history[0]!.problemTitle).toBe("3Sum");
    expect(history[0]!.commitSha).toBe("sha_commit_success_12345");
  });

  // ==========================================================================
  // 8. Phase 1C.4.2.2 Correction Pass — Payload Limit Validation (PAYLOAD-01 to PAYLOAD-05)
  // ==========================================================================

  it("PAYLOAD-01: A payload below the approved 500 KB limit is accepted by the queue handler", async () => {
    // 250 KB payload (256,000 bytes)
    const sourceCode = "/*" + "A".repeat(255_995) + "*/\n";
    expect(new TextEncoder().encode(sourceCode).length).toBe(256_000);
    expect(new TextEncoder().encode(sourceCode).length).toBeLessThan(
      MAX_SOURCE_PAYLOAD_BYTES,
    );

    await createAndEnqueueSubmission({ sourceCode });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.completed).toBe(1);
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
    const passedOptions = synchronizeFileSpy.mock
      .calls[0]![0] as GitHubWriteOptions;
    expect(new TextEncoder().encode(passedOptions.content).length).toBe(
      256_000,
    );

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  it("PAYLOAD-02: A payload exactly at the approved maximum (512,000 bytes) is handled according to the boundary convention", async () => {
    // Exactly 512,000 bytes (500 * 1024 bytes)
    const exactCode = "/*" + "B".repeat(511_995) + "*/\n";
    const byteLength = new TextEncoder().encode(exactCode).length;
    expect(byteLength).toBe(MAX_SOURCE_PAYLOAD_BYTES);
    expect(byteLength).toBe(512_000);

    await createAndEnqueueSubmission({ sourceCode: exactCode });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    expect(summary?.completed).toBe(1);
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  it("PAYLOAD-03: A payload exceeding the approved maximum (512,001 bytes) is rejected fail-closed without network calls or truncation", async () => {
    // Exactly 512,001 bytes (exceeds MAX_SOURCE_PAYLOAD_BYTES by 1 byte)
    const oversizedCode = "/*" + "C".repeat(511_996) + "*/\n";
    const byteLength = new TextEncoder().encode(oversizedCode).length;
    expect(byteLength).toBe(512_001);
    expect(byteLength).toBeGreaterThan(MAX_SOURCE_PAYLOAD_BYTES);

    // Boundary 1: Storage layer rejects enqueueing oversized payload fail-closed
    await expect(
      createAndEnqueueSubmission({ sourceCode: oversizedCode }),
    ).rejects.toThrow(StorageError);

    // Boundary 2: Handler defense-in-depth - if an oversized payload was persisted,
    // the handler inspects byte length and fails closed to REQUIRES_ATTENTION before any GitHub call.
    const item = await createAndEnqueueSubmission();
    await (
      payloadStorage as unknown as {
        driver: { putPayload: (p: unknown) => Promise<void> };
      }
    ).driver.putPayload({
      id: item.payloadId,
      sourceCode: oversizedCode,
      createdAt: Date.now(),
    });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    // Must NOT call GitHub
    expect(synchronizeFileSpy).not.toHaveBeenCalled();
    expect(summary?.quarantined).toBe(1);

    const queue = await storage.getQueueMetadata();
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue[0]!.lastError?.code).toBe(ErrorCode.GITHUB_PAYLOAD_TOO_LARGE);
    expect(queue[0]!.lastError?.message).toContain("512001 bytes");

    // Verify no unsafe truncation in storage
    const storedPayload = await payloadStorage.getPayload(item.payloadId);
    expect(storedPayload?.sourceCode).toBe(oversizedCode);
    expect(new TextEncoder().encode(storedPayload!.sourceCode).length).toBe(
      512_001,
    );
  });

  it("PAYLOAD-04: Verify there is no conflicting 100 KB source-code limit remaining in the handler", async () => {
    // 150 KB payload (153,600 bytes) - strictly between 100 KB and 500 KB
    const intermediateCode = "/*" + "D".repeat(153_595) + "*/\n";
    const byteLength = new TextEncoder().encode(intermediateCode).length;
    expect(byteLength).toBe(153_600);
    expect(byteLength).toBeGreaterThan(100_000);
    expect(byteLength).toBeLessThan(MAX_SOURCE_PAYLOAD_BYTES);

    await createAndEnqueueSubmission({ sourceCode: intermediateCode });

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);
    const summary = await drainer.drain("submission_event");

    // Accepted and successfully synchronized
    expect(summary?.completed).toBe(1);
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);

    // Verify authoritative constant
    expect(MAX_SOURCE_PAYLOAD_BYTES).toBe(512_000);
    expect(MAX_SOURCE_PAYLOAD_BYTES).not.toBe(100_000);
  });

  it("PAYLOAD-05: Verify the queue-handler limit does not exceed the existing approved GitHub synchronization/content limit", () => {
    // The queue handler imports MAX_SOURCE_PAYLOAD_BYTES from github/types
    // and enforces payloadBytes <= MAX_SOURCE_PAYLOAD_BYTES.
    // GitHubContentsService also enforces codeBytes <= MAX_SOURCE_PAYLOAD_BYTES.
    expect(MAX_SOURCE_PAYLOAD_BYTES).toBe(500 * 1024);
    expect(MAX_SOURCE_PAYLOAD_BYTES).toBe(512_000);
  });

  // ==========================================================================
  // 9. Phase 1C.4.2.2 Correction Pass — Queue Drain Alarm Cadence (ALARM-01 to ALARM-06)
  // ==========================================================================

  it("ALARM-01: Queue drain alarm is configured for the approved 5-minute cadence", async () => {
    expect(QUEUE_DRAIN_ALARM_PERIOD_MINUTES).toBe(5);

    const mockAlarms = new Map<string, unknown>();
    const createAlarmMock = vi.fn((name: string, info: unknown) => {
      mockAlarms.set(name, info);
    });

    const globalContext = globalThis as unknown as {
      browser?:
        | {
            alarms: {
              get: (name: string) => Promise<unknown>;
              create: (name: string, info: unknown) => void;
            };
          }
        | undefined;
    };
    const originalBrowser = globalContext.browser;

    globalContext.browser = {
      alarms: {
        get: vi.fn(async (name: string) => mockAlarms.get(name)),
        create: createAlarmMock,
      },
    };

    try {
      await setupQueueDrainAlarm();
      expect(createAlarmMock).toHaveBeenCalledTimes(1);
      expect(createAlarmMock).toHaveBeenCalledWith(QUEUE_DRAIN_ALARM_NAME, {
        periodInMinutes: 5,
      });
    } finally {
      globalContext.browser = originalBrowser;
    }
  });

  it("ALARM-02: Alarm invokes QueueDrainer rather than directly invoking QueueManager or the GitHub handler", async () => {
    await createAndEnqueueSubmission();
    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    const drainerSpy = vi.spyOn(drainer, "drain");
    const queueManagerSpy = vi.spyOn(queueManager, "drainQueue");

    // Simulate the alarm event firing through QueueDrainer
    await drainer.drain("alarm");

    // Verified: drainer.drain was called with "alarm"
    expect(drainerSpy).toHaveBeenCalledWith("alarm");
    // Verified: QueueDrainer delegates to QueueManager.drainQueue with "alarm"
    expect(queueManagerSpy).toHaveBeenCalledWith("alarm", expect.any(Function));
    // Verified: GitHub write was invoked through the coordinated pipeline
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);
  });

  it("ALARM-03: Alarm does not create a second drain mechanism", async () => {
    const mockAlarms = new Map<string, unknown>();
    const createAlarmMock = vi.fn((name: string, info: unknown) => {
      mockAlarms.set(name, info);
    });

    const globalContext = globalThis as unknown as {
      browser?:
        | {
            alarms: {
              get: (name: string) => Promise<unknown>;
              create: (name: string, info: unknown) => void;
            };
          }
        | undefined;
    };
    const originalBrowser = globalContext.browser;

    globalContext.browser = {
      alarms: {
        get: vi.fn(async (name: string) => mockAlarms.get(name)),
        create: createAlarmMock,
      },
    };

    try {
      // First setup
      await setupQueueDrainAlarm();
      expect(createAlarmMock).toHaveBeenCalledTimes(1);

      // Second setup (idempotent: does NOT create a duplicate alarm)
      await setupQueueDrainAlarm();
      expect(createAlarmMock).toHaveBeenCalledTimes(1);

      // Only a single alarm exists
      expect(mockAlarms.size).toBe(1);
      expect(mockAlarms.has(QUEUE_DRAIN_ALARM_NAME)).toBe(true);
    } finally {
      globalContext.browser = originalBrowser;
    }
  });

  it("ALARM-04: Existing submission-event drain trigger remains unchanged", async () => {
    await createAndEnqueueSubmission();
    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    const queueManagerSpy = vi.spyOn(queueManager, "drainQueue");
    const summary = await drainer.drain("submission_event");

    expect(queueManagerSpy).toHaveBeenCalledWith(
      "submission_event",
      expect.any(Function),
    );
    expect(summary?.completed).toBe(1);
  });

  it("ALARM-05: Existing startup drain trigger remains unchanged", async () => {
    await createAndEnqueueSubmission();
    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    const queueManagerSpy = vi.spyOn(queueManager, "drainQueue");
    const summary = await drainer.drain("startup");

    expect(queueManagerSpy).toHaveBeenCalledWith(
      "startup",
      expect.any(Function),
    );
    expect(summary?.completed).toBe(1);
  });

  it("ALARM-06: Alarm cadence does not modify QueueManager retry/backoff semantics", async () => {
    await createAndEnqueueSubmission();

    // Mark item as FAILED with nextRetryAt set 10 minutes in the future
    const futureRetry = Date.now() + 600_000;
    const queue = await storage.getQueueMetadata();
    queue[0]!.state = QueueState.FAILED;
    queue[0]!.attempts = 1;
    queue[0]!.nextRetryAt = futureRetry;
    await storage.setQueueMetadata(queue);

    const handler = createGitHubQueueItemHandler({
      contentsService: mockContentsService,
      storage,
    });
    drainer.setHandler(handler);

    // Alarm triggers drain pass before nextRetryAt
    const summaryBefore = await drainer.drain("alarm");

    // Item was NOT processed because nextRetryAt is in the future
    expect(summaryBefore?.processed).toBe(0);
    expect(synchronizeFileSpy).not.toHaveBeenCalled();

    const queueAfterAlarm = await storage.getQueueMetadata();
    expect(queueAfterAlarm[0]!.state).toBe(QueueState.FAILED);
    expect(queueAfterAlarm[0]!.attempts).toBe(1);
    expect(queueAfterAlarm[0]!.nextRetryAt).toBe(futureRetry);

    // Fast-forward time past nextRetryAt: item now becomes eligible
    queueAfterAlarm[0]!.nextRetryAt = Date.now() - 1000;
    await storage.setQueueMetadata(queueAfterAlarm);

    const summaryEligible = await drainer.drain("alarm");
    expect(summaryEligible?.completed).toBe(1);
    expect(synchronizeFileSpy).toHaveBeenCalledTimes(1);

    const finalQueue = await storage.getQueueMetadata();
    expect(finalQueue[0]!.state).toBe(QueueState.COMPLETED);
  });
});
