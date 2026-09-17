import {
  SubmissionHandler,
  createDefaultRegistry,
  type CanonicalSubmissionCandidate,
} from "../../src/shared/adapters";
import { MessageEnvelopeValidator } from "../../src/shared/messaging/validator";
import { type RuntimeSenderInfo } from "../../src/shared/messaging/types";
import {
  StorageService,
  type LocalStorageDriver,
} from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
  type PayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import {
  QueueDrainer,
  createGitHubQueueItemHandler,
  type QueueItemHandler,
} from "../../src/shared/queue";
import { GitHubApiClient } from "../../src/shared/github/client";
import { GitHubContentsService } from "../../src/shared/github/contents-service";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { MockGitHubApiServer } from "./mock-github-api";
import { MemoryStorageDriver, createExtensionMessage } from "./e2e-harness";
import { computeContentHash } from "../../src/shared/deduplication";
import type {
  QueueItemMetadata,
  QueueItemPayload,
  SyncHistoryEntry,
  WalEntry,
} from "../../src/shared/storage/types";

export { createExtensionMessage };

/**
 * Thrown when a worker execution context is terminated abruptly (simulated process kill).
 */
export class ProcessTerminatedError extends Error {
  constructor(message: string = "Process context terminated abruptly") {
    super(message);
    this.name = "ProcessTerminatedError";
  }
}

/**
 * Storage driver wrapper that aborts all subsequent I/O once the worker is terminated.
 * Prevents a dying worker from modifying shared durable storage after crash.
 */
export class TerminableStorageDriver implements LocalStorageDriver {
  private terminated = false;

  constructor(private readonly shared: LocalStorageDriver) {}

  terminate(): void {
    this.terminated = true;
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  private checkTerminated(): void {
    if (this.terminated) {
      throw new ProcessTerminatedError(
        "Storage operation rejected: Worker process has been terminated",
      );
    }
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    this.checkTerminated();
    return await this.shared.get(keys);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.checkTerminated();
    await this.shared.set(items);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.checkTerminated();
    await this.shared.remove(keys);
  }

  async clear(): Promise<void> {
    this.checkTerminated();
    if (this.shared.clear) {
      await this.shared.clear();
    }
  }
}

/**
 * Payload driver wrapper that aborts all subsequent IndexedDB operations once terminated.
 */
export class TerminablePayloadDriver implements PayloadStorageDriver {
  private terminated = false;

  constructor(private readonly shared: PayloadStorageDriver) {}

  terminate(): void {
    this.terminated = true;
  }

  isTerminated(): boolean {
    return this.terminated;
  }

  private checkTerminated(): void {
    if (this.terminated) {
      throw new ProcessTerminatedError(
        "IndexedDB operation rejected: Worker process has been terminated",
      );
    }
  }

  async putPayload(payload: QueueItemPayload): Promise<void> {
    this.checkTerminated();
    await this.shared.putPayload(payload);
  }

  async getPayload(id: string): Promise<QueueItemPayload | null> {
    this.checkTerminated();
    return await this.shared.getPayload(id);
  }

  async deletePayload(id: string): Promise<void> {
    this.checkTerminated();
    await this.shared.deletePayload(id);
  }

  async getAllPayloadKeys(): Promise<string[]> {
    this.checkTerminated();
    return await this.shared.getAllPayloadKeys();
  }

  async getAllPayloads(): Promise<QueueItemPayload[]> {
    this.checkTerminated();
    return await this.shared.getAllPayloads();
  }

  async putHistory(entry: SyncHistoryEntry): Promise<void> {
    this.checkTerminated();
    await this.shared.putHistory(entry);
  }

  async getHistory(limit?: number): Promise<SyncHistoryEntry[]> {
    this.checkTerminated();
    return await this.shared.getHistory(limit);
  }

  async putWalEntry(entry: WalEntry): Promise<void> {
    this.checkTerminated();
    await this.shared.putWalEntry(entry);
  }

  async getWalEntry(id: string): Promise<WalEntry | null> {
    this.checkTerminated();
    return await this.shared.getWalEntry(id);
  }

  async deleteWalEntry(id: string): Promise<void> {
    this.checkTerminated();
    await this.shared.deleteWalEntry(id);
  }

  async getAllWalEntries(): Promise<WalEntry[]> {
    this.checkTerminated();
    return await this.shared.getAllWalEntries();
  }

  async clear(): Promise<void> {
    this.checkTerminated();
    await this.shared.clear();
  }

  async close(): Promise<void> {
    this.checkTerminated();
    await this.shared.close();
  }
}

/**
 * Isolated execution context representing a single Service Worker instance.
 */
export interface WorkerContext {
  readonly workerId: string;
  readonly storageDriver: TerminableStorageDriver;
  readonly storage: StorageService;
  readonly payloadDriver: TerminablePayloadDriver;
  readonly payloadStorage: PayloadStorage;
  readonly concurrency: QueueConcurrencyManager;
  readonly queueManager: QueueManager;
  readonly gitHubClient: GitHubApiClient;
  readonly gitHubContentsService: GitHubContentsService;
  syncHandler: QueueItemHandler;
  readonly queueDrainer: QueueDrainer;
  readonly submissionHandler: SubmissionHandler;
  readonly validator: MessageEnvelopeValidator;

  /**
   * Simulates immediate, unhandled worker process termination (SIGKILL / unhandled crash).
   * Freezes all worker I/O so no subsequent writes reach shared durable storage.
   */
  terminate(): void;
  isTerminated(): boolean;
}

export interface CrashTestEnvironment {
  readonly sharedStorageDriver: MemoryStorageDriver;
  readonly sharedPayloadDriver: MemoryPayloadStorageDriver;
  readonly mockGitHubServer: MockGitHubApiServer;

  seedDefaults(options?: {
    targetRepository?: string;
    targetBranch?: string;
    duplicatePolicy?: "skip" | "overwrite" | "keep_both" | "prompt_user";
    baseFolder?: string;
  }): Promise<void>;

  /**
   * Spawns a completely fresh worker execution context connected to shared durable storage.
   */
  createWorker(label?: string): WorkerContext;

  /**
   * Discards a worker context, terminating any pending operations and rendering instances unreachable.
   */
  discardWorker(worker: WorkerContext): void;

  getDurableQueue(): Promise<QueueItemMetadata[]>;
  getDurablePayloads(): Promise<QueueItemPayload[]>;
  getDurableWalEntries(): Promise<WalEntry[]>;
  getDurableHistory(): Promise<SyncHistoryEntry[]>;
}

export function createCrashTestEnvironment(
  options: {
    targetRepository?: string;
    targetBranch?: string;
  } = {},
): CrashTestEnvironment {
  const targetRepository = options.targetRepository ?? "octocat/dsa-repo";
  const targetBranch = options.targetBranch ?? "main";
  const [owner, repo] = targetRepository.split("/");

  const sharedStorageDriver = new MemoryStorageDriver();
  const sharedPayloadDriver = new MemoryPayloadStorageDriver();

  const mockGitHubServer = new MockGitHubApiServer({
    owner: owner ?? "octocat",
    repo: repo ?? "dsa-repo",
    branch: targetBranch,
  });

  async function seedDefaults(
    seedOpts: {
      targetRepository?: string;
      targetBranch?: string;
      duplicatePolicy?: "skip" | "overwrite" | "keep_both" | "prompt_user";
      baseFolder?: string;
    } = {},
  ): Promise<void> {
    const sRepo = seedOpts.targetRepository ?? targetRepository;
    const sBranch = seedOpts.targetBranch ?? targetBranch;
    const policy = seedOpts.duplicatePolicy ?? "skip";
    const folder = seedOpts.baseFolder ?? "solutions";

    await sharedStorageDriver.set({
      [STORAGE_KEYS.CONFIG]: {
        version: 1,
        targetRepository: sRepo,
        targetBranch: sBranch,
        baseFolder: folder,
        duplicatePolicy: policy,
        enabledPlatforms: {
          leetcode: true,
          codeforces: true,
          codechef: true,
          geeksforgeeks: true,
        },
      },
      [STORAGE_KEYS.AUTH]: {
        method: "github_app",
        status: "authenticated",
        accessToken: "dummy_access_token_123",
        refreshToken: "dummy_refresh_token_123",
        tokenExpiresAt: Date.now() + 3600_000,
        refreshTokenExpiresAt: Date.now() + 86400_000,
        refreshGeneration: 1,
        refreshState: "IDLE",
        authorizedRepositories: [sRepo],
        user: {
          login: sRepo.split("/")[0] ?? "octocat",
          id: 12345,
          avatarUrl: "https://example.com/avatar.png",
        },
        lastValidatedAt: Date.now(),
        authenticatedAt: Date.now(),
      },
    });
  }

  function createWorker(label?: string): WorkerContext {
    const workerId = label ?? `worker-${crypto.randomUUID().slice(0, 8)}`;

    const storageDriver = new TerminableStorageDriver(sharedStorageDriver);
    const storage = new StorageService(storageDriver);

    const payloadDriver = new TerminablePayloadDriver(sharedPayloadDriver);
    const payloadStorage = new PayloadStorage(payloadDriver);

    const concurrency = new QueueConcurrencyManager(storage);
    const queueManager = new QueueManager(storage, payloadStorage, concurrency);

    const gitHubClient = new GitHubApiClient({
      baseUrl: "https://api.github.com",
      fetchFn: mockGitHubServer.createFetchHandler(),
      tokenSupplier: async () => "dummy_access_token_123",
    });

    const gitHubContentsService = new GitHubContentsService({
      client: gitHubClient,
    });

    const syncHandler = createGitHubQueueItemHandler({
      contentsService: gitHubContentsService,
      storage,
    });

    const queueDrainer = new QueueDrainer({
      queueManager,
      handler: syncHandler,
    });

    const validator = new MessageEnvelopeValidator();
    const submissionHandler = new SubmissionHandler(
      validator,
      createDefaultRegistry(),
      {
        queueManager,
        storage,
      },
    );

    function terminate(): void {
      storageDriver.terminate();
      payloadDriver.terminate();
    }

    function isTerminated(): boolean {
      return storageDriver.isTerminated() && payloadDriver.isTerminated();
    }

    return {
      workerId,
      storageDriver,
      storage,
      payloadDriver,
      payloadStorage,
      concurrency,
      queueManager,
      gitHubClient,
      gitHubContentsService,
      syncHandler,
      queueDrainer,
      submissionHandler,
      validator,
      terminate,
      isTerminated,
    };
  }

  function discardWorker(worker: WorkerContext): void {
    worker.terminate();
  }

  async function getDurableQueue(): Promise<QueueItemMetadata[]> {
    const raw = await sharedStorageDriver.get([STORAGE_KEYS.QUEUE_METADATA]);
    return (raw[STORAGE_KEYS.QUEUE_METADATA] as QueueItemMetadata[]) ?? [];
  }

  async function getDurablePayloads(): Promise<QueueItemPayload[]> {
    return await sharedPayloadDriver.getAllPayloads();
  }

  async function getDurableWalEntries(): Promise<WalEntry[]> {
    return await sharedPayloadDriver.getAllWalEntries();
  }

  async function getDurableHistory(): Promise<SyncHistoryEntry[]> {
    return await sharedPayloadDriver.getHistory();
  }

  return {
    sharedStorageDriver,
    sharedPayloadDriver,
    mockGitHubServer,
    seedDefaults,
    createWorker,
    discardWorker,
    getDurableQueue,
    getDurablePayloads,
    getDurableWalEntries,
    getDurableHistory,
  };
}

export async function buildCandidateSubmission(
  overrides: Partial<CanonicalSubmissionCandidate> = {},
): Promise<{
  candidate: CanonicalSubmissionCandidate;
  sender: RuntimeSenderInfo;
}> {
  const sourceCode =
    overrides.sourceCode ??
    "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {};\n    }\n};\n";
  const contentHash =
    overrides.contentHash ?? (await computeContentHash(sourceCode));

  return {
    candidate: {
      platform: overrides.platform ?? "leetcode",
      problemId: overrides.problemId ?? "two-sum",
      problemSlug: overrides.problemSlug ?? "two-sum",
      problemTitle: overrides.problemTitle ?? "Two Sum",
      status: overrides.status ?? "ACCEPTED",
      language: overrides.language ?? "cpp",
      sourceCode,
      contentHash,
      submittedAt: overrides.submittedAt ?? Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.95,
      extractionLayer: "dom",
      submissionId: overrides.submissionId ?? "99881122",
      platformMetadata: overrides.platformMetadata,
    },
    sender: {
      tab: { id: 100, url: "https://leetcode.com/problems/two-sum/" },
    },
  };
}
