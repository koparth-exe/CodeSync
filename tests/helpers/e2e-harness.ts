import {
  SubmissionHandler,
  createDefaultRegistry,
  type CanonicalSubmissionCandidate,
} from "../../src/shared/adapters";
import { MessageEnvelopeValidator } from "../../src/shared/messaging/validator";
import {
  type ExtensionMessage,
  type RuntimeSenderInfo,
} from "../../src/shared/messaging/types";
import {
  StorageService,
  type LocalStorageDriver,
} from "../../src/shared/storage/local";
import {
  PayloadStorage,
  MemoryPayloadStorageDriver,
} from "../../src/shared/storage/indexeddb";
import { QueueManager } from "../../src/shared/queue/manager";
import { QueueConcurrencyManager } from "../../src/shared/queue/concurrency";
import {
  QueueDrainer,
  createGitHubQueueItemHandler,
} from "../../src/shared/queue";
import { GitHubApiClient } from "../../src/shared/github/client";
import { GitHubContentsService } from "../../src/shared/github/contents-service";
import { DurableTokenLifecycleManager } from "../../src/shared/auth/token-lifecycle";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { MockGitHubApiServer } from "./mock-github-api";
import { TrustBoundary } from "../../src/shared/types/trust";
import type {
  QueueItemMetadata,
  QueueItemPayload,
  SyncHistoryEntry,
  WalEntry,
} from "../../src/shared/storage/types";
import type { DrainSummary } from "../../src/shared/queue/types";

export class MemoryStorageDriver implements LocalStorageDriver {
  private map = new Map<string, unknown>();

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys === null) {
      for (const [k, v] of this.map.entries()) {
        result[k] = JSON.parse(JSON.stringify(v));
      }
      return result;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      if (this.map.has(k)) {
        result[k] = JSON.parse(JSON.stringify(this.map.get(k)));
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.map.set(k, JSON.parse(JSON.stringify(v)));
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

export interface E2EHarness {
  readonly localDriver: MemoryStorageDriver;
  readonly storage: StorageService;
  readonly payloadDriver: MemoryPayloadStorageDriver;
  readonly payloadStorage: PayloadStorage;
  readonly concurrency: QueueConcurrencyManager;
  readonly queueManager: QueueManager;
  readonly mockGitHubServer: MockGitHubApiServer;
  readonly gitHubClient: GitHubApiClient;
  readonly gitHubContentsService: GitHubContentsService;
  readonly queueDrainer: QueueDrainer;
  readonly validator: MessageEnvelopeValidator;
  readonly submissionHandler: SubmissionHandler;
  readonly lifecycleManager?: DurableTokenLifecycleManager | undefined;

  seedDefaults(options?: {
    targetRepository?: string;
    targetBranch?: string;
    duplicatePolicy?: "skip" | "overwrite" | "keep_both" | "prompt_user";
    baseFolder?: string;
  }): Promise<void>;

  dispatchBackgroundMessage(
    message: unknown,
    sender?: RuntimeSenderInfo,
  ): Promise<{
    enqueueResult: {
      success: boolean;
      queueItem?: QueueItemMetadata | undefined;
      candidate?: CanonicalSubmissionCandidate | undefined;
      error?: string | undefined;
    };
    drainSummary: DrainSummary | null;
  }>;

  getDurableQueue(): Promise<QueueItemMetadata[]>;
  getDurablePayloads(): Promise<QueueItemPayload[]>;
  getDurableWalEntries(): Promise<WalEntry[]>;
  getDurableHistory(): Promise<SyncHistoryEntry[]>;
}

export interface CreateHarnessOptions {
  readonly targetRepository?: string | undefined;
  readonly targetBranch?: string | undefined;
  readonly duplicatePolicy?:
    "skip" | "overwrite" | "keep_both" | "prompt_user" | undefined;
  readonly baseFolder?: string | undefined;
  readonly tokenSupplier?: (() => Promise<string>) | undefined;
  readonly lifecycleManager?: DurableTokenLifecycleManager | undefined;
  readonly lifecycleManagerFactory?:
    ((storage: StorageService) => DurableTokenLifecycleManager) | undefined;
}

/**
 * Constructs an isolated, fully-integrated, deterministic E2E test harness.
 */
export function createE2EHarness(
  options: CreateHarnessOptions = {},
): E2EHarness {
  const targetRepository = options.targetRepository ?? "octocat/dsa-repo";
  const targetBranch = options.targetBranch ?? "main";
  const [owner, repo] = targetRepository.split("/");

  const localDriver = new MemoryStorageDriver();
  const storage = new StorageService(localDriver);

  const payloadDriver = new MemoryPayloadStorageDriver();
  const payloadStorage = new PayloadStorage(payloadDriver);

  const concurrency = new QueueConcurrencyManager(storage);
  const queueManager = new QueueManager(storage, payloadStorage, concurrency);

  const mockGitHubServer = new MockGitHubApiServer({
    owner: owner ?? "octocat",
    repo: repo ?? "dsa-repo",
    branch: targetBranch,
  });

  const lifecycleManager = options.lifecycleManagerFactory
    ? options.lifecycleManagerFactory(storage)
    : options.lifecycleManager;

  const gitHubClient = new GitHubApiClient({
    baseUrl: "https://api.github.com",
    fetchFn: mockGitHubServer.createFetchHandler(),
    ...(lifecycleManager
      ? { lifecycleManager }
      : {
          tokenSupplier:
            options.tokenSupplier ?? (async () => "dummy_access_token_123"),
        }),
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

  async function seedDefaults(
    seedOpts: {
      targetRepository?: string;
      targetBranch?: string;
      duplicatePolicy?: "skip" | "overwrite" | "keep_both" | "prompt_user";
      baseFolder?: string;
    } = {},
  ): Promise<void> {
    const repo = seedOpts.targetRepository ?? targetRepository;
    const branch = seedOpts.targetBranch ?? targetBranch;
    const policy =
      seedOpts.duplicatePolicy ?? options.duplicatePolicy ?? "skip";
    const folder = seedOpts.baseFolder ?? options.baseFolder ?? "solutions";

    await storage.set(STORAGE_KEYS.CONFIG, {
      version: 1,
      targetRepository: repo,
      targetBranch: branch,
      baseFolder: folder,
      duplicatePolicy: policy,
      enabledPlatforms: {
        leetcode: true,
        codeforces: true,
        codechef: true,
        geeksforgeeks: true,
      },
    });

    await storage.set(STORAGE_KEYS.AUTH, {
      method: "github_app",
      status: "authenticated",
      accessToken: "dummy_access_token_123",
      refreshToken: "dummy_refresh_token_123",
      tokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 86400_000,
      refreshGeneration: 1,
      refreshState: "IDLE",
      refreshLeaseEpoch: 0,
      predecessorAttempts: [],
      authorizedRepositories: [repo],
      user: {
        login: repo.split("/")[0] ?? "octocat",
        id: 12345,
        avatarUrl: "https://example.com/avatar.png",
      },
      lastValidatedAt: Date.now(),
      authenticatedAt: Date.now(),
    });
  }

  /**
   * Dispatches a message through the authoritative service-worker pipeline
   * exactly as done in background.ts.
   */
  async function dispatchBackgroundMessage(
    rawMessage: unknown,
    runtimeSender?: RuntimeSenderInfo,
  ): Promise<{
    enqueueResult: {
      success: boolean;
      queueItem?: QueueItemMetadata | undefined;
      candidate?: CanonicalSubmissionCandidate | undefined;
      error?: string | undefined;
    };
    drainSummary: DrainSummary | null;
  }> {
    let enqueueResult: {
      success: boolean;
      queueItem?: QueueItemMetadata | undefined;
      candidate?: CanonicalSubmissionCandidate | undefined;
      error?: string | undefined;
    };

    try {
      enqueueResult = await submissionHandler.handleMessageAndEnqueue(
        rawMessage,
        runtimeSender,
      );
    } catch (err) {
      enqueueResult = {
        success: false,
        error: (err as Error).message,
      };
    }

    let drainSummary: DrainSummary | null = null;
    if (enqueueResult.success && enqueueResult.queueItem) {
      drainSummary = await queueDrainer.drain("submission_event");
    }

    return { enqueueResult, drainSummary };
  }

  async function getDurableQueue(): Promise<QueueItemMetadata[]> {
    return await storage.getQueueMetadata();
  }

  async function getDurablePayloads(): Promise<QueueItemPayload[]> {
    return await payloadStorage.getAllPayloads();
  }

  async function getDurableWalEntries(): Promise<WalEntry[]> {
    return await payloadStorage.getAllWalEntries();
  }

  async function getDurableHistory(): Promise<SyncHistoryEntry[]> {
    return await payloadStorage.getHistory();
  }

  return {
    localDriver,
    storage,
    payloadDriver,
    payloadStorage,
    concurrency,
    queueManager,
    mockGitHubServer,
    gitHubClient,
    gitHubContentsService,
    queueDrainer,
    validator,
    submissionHandler,
    lifecycleManager,
    seedDefaults,
    dispatchBackgroundMessage,
    getDurableQueue,
    getDurablePayloads,
    getDurableWalEntries,
    getDurableHistory,
  };
}

/**
 * Creates a valid ExtensionMessage envelope for testing.
 */
export function createExtensionMessage<T>(
  payload: T,
  overrides: Partial<ExtensionMessage<T>> = {},
): ExtensionMessage<T> {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    type: overrides.type ?? "SUBMISSION_DETECTED",
    payload,
    timestamp: overrides.timestamp ?? Date.now(),
    senderContext: overrides.senderContext ?? "content-script",
    trustBoundary: overrides.trustBoundary ?? TrustBoundary.SEMI_TRUSTED,
  };
}
