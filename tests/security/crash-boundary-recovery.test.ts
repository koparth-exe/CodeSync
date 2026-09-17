import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createCrashTestEnvironment,
  buildCandidateSubmission,
  createExtensionMessage,
  ProcessTerminatedError,
  type CrashTestEnvironment,
} from "../helpers/crash-harness";
import { QueueState } from "../../src/shared/storage/types";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { ErrorCode, StaleLeaseError } from "../../src/shared/errors";

describe("Phase 1C.4.3.2.1 — Crash Boundary Integration Testing Suite", () => {
  let env: CrashTestEnvironment;

  beforeEach(async () => {
    env = createCrashTestEnvironment();
    await env.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // CRASH-INT-01 — Worker Termination During PUT, Remote Write NOT Committed
  // ==========================================================================
  it("CRASH-INT-01: Worker termination mid-PUT where remote write did NOT commit recovers cleanly on fresh restart", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate submission
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 0; }\n",
    });
    const msg = createExtensionMessage(candidate);
    const enqueueResult =
      await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);
    expect(enqueueResult.success).toBe(true);
    expect(enqueueResult.queueItem?.state).toBe(QueueState.PENDING);
    const itemId = enqueueResult.queueItem!.id;

    // Verify durable storage before drain
    const queueBefore = await env.getDurableQueue();
    expect(queueBefore).toHaveLength(1);
    expect(queueBefore[0]!.id).toBe(itemId);
    expect(queueBefore[0]!.state).toBe(QueueState.PENDING);
    expect(queueBefore[0]!.crashCount).toBe(0);

    // Simulate Worker A process termination mid-PUT before write reaches GitHub
    workerA.gitHubContentsService.onBeforePut = async () => {
      workerA.terminate();
      throw new ProcessTerminatedError(
        "Worker A process terminated abruptly mid-PUT before socket transmission",
      );
    };

    // Worker A runs drain — aborts fail-closed due to process termination
    await expect(
      workerA.queueDrainer.drain("submission_event"),
    ).rejects.toThrow();

    // Verify Worker A is terminated and discarded
    expect(workerA.isTerminated()).toBe(true);
    env.discardWorker(workerA);

    // Assert durable state at crash point:
    // Item was claimed into PROCESSING by Worker A before termination
    const queueAtCrash = await env.getDurableQueue();
    expect(queueAtCrash[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueAtCrash[0]!.crashCount).toBe(0); // Not yet incremented

    // Assert remote GitHub server state:
    // Remote write did NOT commit; exactly 0 PUTs occurred
    expect(env.mockGitHubServer.hasFile("solutions/leetcode/two-sum.cpp")).toBe(
      false,
    );
    expect(env.mockGitHubServer.getPutCount()).toBe(0);

    // Advance virtual time past lease TTL (30s) so Worker B can acquire lease
    virtualTime += 35_000;

    // 2. Fresh Worker B starts up from the same durable storage
    const workerB = env.createWorker("Worker-B");

    // Fresh-Context Assertions: Worker B must NOT share in-memory state with Worker A
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.queueDrainer).not.toBe(workerA.queueDrainer);
    expect(workerB.syncHandler).not.toBe(workerA.syncHandler);
    expect(workerB.gitHubContentsService).not.toBe(
      workerA.gitHubContentsService,
    );
    expect(workerB.gitHubClient).not.toBe(workerA.gitHubClient);
    expect(workerB.concurrency).not.toBe(workerA.concurrency);
    expect(workerB.storage).not.toBe(workerA.storage);
    expect(workerB.payloadStorage).not.toBe(workerA.payloadStorage);

    // Worker B executes recovery via startup drain
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.completed).toBe(1);
    expect(summaryB?.failed).toBe(0);
    expect(summaryB?.quarantined).toBe(0);

    // Assert durable queue state after Worker B recovery and drain
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueFinal[0]!.crashCount).toBe(1); // Exactly 1 crash counted during reconciliation
    expect(queueFinal[0]!.attempts).toBe(0); // Zero attempts consumed for worker crash
    expect(queueFinal[0]!.commitSha).toBeDefined();

    // Assert remote GitHub state: exactly ONE successful PUT across entire test
    expect(env.mockGitHubServer.hasFile("solutions/leetcode/two-sum.cpp")).toBe(
      true,
    );
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Request trace proves Worker B executed pre-flight GET, detected 404, and issued PUT
    const trace = env.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker A pre-flight GET (404) before crash
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker B pre-flight GET (404) confirms write did not commit
      "PUT_FILE", // Worker B optimistic PUT
      "GET_FILE_VERIFY", // Worker B post-write verification GET (CONFIRMED)
    ]);

    // Assert durable history entry created by Worker B
    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("synced");
    expect(history[0]!.contentHash).toBe(candidate.contentHash);
  });

  // ==========================================================================
  // CRASH-INT-02 — Worker Termination During PUT, Remote Write DID Commit
  // ==========================================================================
  it("CRASH-INT-02: Worker termination mid-PUT where remote write DID commit skips duplicate PUT on restart", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 1; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Configure Worker A to terminate immediately after remote PUT commits on GitHub
    // but before local completion is persisted to storage.local
    workerA.gitHubContentsService.onBeforeVerificationGet = async () => {
      workerA.terminate();
      throw new ProcessTerminatedError(
        "Worker A terminated immediately after remote PUT write committed",
      );
    };

    // Worker A runs drain — aborts after remote write committed
    await expect(
      workerA.queueDrainer.drain("submission_event"),
    ).rejects.toThrow();

    // Verify Worker A is terminated and discarded
    expect(workerA.isTerminated()).toBe(true);
    env.discardWorker(workerA);

    // Assert durable state at crash point:
    // Remote GitHub DOES have the file committed
    expect(env.mockGitHubServer.hasFile("solutions/leetcode/two-sum.cpp")).toBe(
      true,
    );
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // In storage.local, item is STILL in PROCESSING (local finalization never persisted)
    const queueAtCrash = await env.getDurableQueue();
    expect(queueAtCrash[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueAtCrash[0]!.completedAt).toBeUndefined();

    // Advance virtual time past lease TTL
    virtualTime += 35_000;

    // 2. Fresh Worker B starts up from the same durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.queueDrainer).not.toBe(workerA.queueDrainer);

    // Worker B executes recovery via startup drain
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.skipped).toBe(1);
    expect(summaryB?.completed).toBe(0);

    // CRITICAL ASSERTION: Total successful PUT count across Worker A + Worker B == 1!
    // Worker B must NOT issue a duplicate PUT
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Assert durable queue state: reached terminal SKIPPED state cleanly
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.SKIPPED);
    expect(queueFinal[0]!.crashCount).toBe(1);

    // Request trace proves Worker B executed Step 6 pre-flight GET,
    // saw matching content hash, and skipped PUT cleanly
    const trace = env.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker A pre-flight GET (404)
      "PUT_FILE", // Worker A PUT (committed!)
      // Worker A crashed at onBeforeVerificationGet
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker B pre-flight GET (sees matching content -> skipped_identical!)
    ]);

    // Assert sync history entry recorded with skipped status
    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("skipped");
  });

  // ==========================================================================
  // CRASH-INT-03 — Worker Termination After Verification Before Local Finalization
  // ==========================================================================
  it("CRASH-INT-03: Worker termination after verification GET before local finalization skips duplicate PUT on restart", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 2; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Wrap Worker A syncHandler to crash AFTER verification GET succeeds
    // but BEFORE QueueManager commits COMPLETED to storage.local
    const realHandler = workerA.syncHandler;
    workerA.syncHandler = async (item, payload) => {
      const result = await realHandler(item, payload);
      // Verify real handler confirmed the write
      expect(result.status).toBe("completed");
      expect(result.commitSha).toBeDefined();

      // Terminate Worker A before QueueManager can persist outcome
      workerA.terminate();
      throw new ProcessTerminatedError(
        "Worker A terminated after verification confirmed before queue finalization",
      );
    };
    workerA.queueDrainer.setHandler(workerA.syncHandler);

    // Worker A runs drain — aborts right after verification
    await expect(
      workerA.queueDrainer.drain("submission_event"),
    ).rejects.toThrow();

    expect(workerA.isTerminated()).toBe(true);
    env.discardWorker(workerA);

    // Assert durable state at crash:
    // Remote write and verification succeeded on GitHub
    expect(env.mockGitHubServer.hasFile("solutions/leetcode/two-sum.cpp")).toBe(
      true,
    );
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // In storage.local, item is still in PROCESSING (local finalization failed)
    const queueAtCrash = await env.getDurableQueue();
    expect(queueAtCrash[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueAtCrash[0]!.completedAt).toBeUndefined();

    // Advance virtual time past lease TTL
    virtualTime += 35_000;

    // 2. Fresh Worker B starts up from the same durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.queueDrainer).not.toBe(workerA.queueDrainer);

    // Worker B executes startup drain
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.skipped).toBe(1);
    expect(summaryB?.completed).toBe(0);

    // CRITICAL ASSERTION: Total PUT count remains strictly 1!
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Assert final queue state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.SKIPPED);
    expect(queueFinal[0]!.crashCount).toBe(1);

    // Request trace proves Worker B skipped PUT via pre-flight GET
    const trace = env.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker A pre-flight GET
      "PUT_FILE", // Worker A PUT
      "GET_FILE_VERIFY", // Worker A verification GET (CONFIRMED)
      // Worker A crashed before queue finalization write
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Worker B pre-flight GET (detects matching content -> skips!)
    ]);

    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("skipped");
  });

  // ==========================================================================
  // CRASH-INT-04 — Rate-Limited Queue Item Survives Full Worker Restart
  // ==========================================================================
  it("CRASH-INT-04: Rate-limited (429) item survives worker restart; early drain skips; retry succeeds upon timer expiry", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 429; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Configure GitHub to return HTTP 429 on PUT (retry after 60s)
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: virtualTime + 60_000,
    });

    // Worker A runs drain — encounters rate limit and persists FAILED state
    const summaryA = await workerA.queueDrainer.drain("submission_event");
    expect(summaryA?.failed).toBe(1);
    expect(summaryA?.completed).toBe(0);

    // Worker A terminates cleanly
    env.discardWorker(workerA);

    // Advance virtual time by 10s (50s before rate limit expires)
    virtualTime += 10_000;

    // 2. Fresh Worker B starts up from durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Assert durable state immediately upon Worker B restart:
    // FAILED state, attempts, nextRetryAt, and lastError are preserved
    const queueAtRestart = await env.getDurableQueue();
    expect(queueAtRestart[0]!.state).toBe(QueueState.FAILED);
    expect(queueAtRestart[0]!.attempts).toBe(1);
    expect(queueAtRestart[0]!.nextRetryAt).toBe(testStartTime + 60_000);
    expect(queueAtRestart[0]!.lastError?.code).toBe(
      ErrorCode.GITHUB_RATE_LIMITED,
    );

    // Early drain by Worker B at virtualTime = testStartTime + 10_000:
    // Item is not yet eligible — must safely skip processing
    const earlySummary = await workerB.queueDrainer.drain("startup");
    expect(earlySummary?.processed).toBe(0);
    expect(earlySummary?.failed).toBe(0);

    // Assert ZERO additional network calls were made during early drain
    expect(env.mockGitHubServer.getPutCount()).toBe(1); // Only the initial 429 PUT

    // Advance virtual time past rate-limit deadline (65s elapsed total)
    virtualTime = testStartTime + 65_000;

    // Worker B runs drain — item is now eligible and synchronizes successfully
    const retrySummary = await workerB.queueDrainer.drain("alarm");
    expect(retrySummary?.processed).toBe(1);
    expect(retrySummary?.completed).toBe(1);

    // Assert final durable queue state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueFinal[0]!.attempts).toBe(1); // Attempts preserved
    expect(queueFinal[0]!.commitSha).toBeDefined();

    // Assert total PUT count: exactly 1 failed (429) + 1 successful retry = 2
    expect(env.mockGitHubServer.getPutCount()).toBe(2);

    // Request trace proves clean retry flow with zero blind writes
    const trace = env.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE",
      "PUT_FILE_429", // Worker A rate-limited attempt
      // Early drain made zero network calls!
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE",
      "PUT_FILE", // Worker B successful retry PUT
      "GET_FILE_VERIFY", // Worker B post-write verification GET
    ]);

    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("synced");
  });

  // ==========================================================================
  // CRASH-INT-05 — Stale Worker Cannot Mutate After Worker B Supersedes Fence
  // ==========================================================================
  it("CRASH-INT-05: Suspended Worker A cannot commit mutations after Worker B supersedes fence with token N+1", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Coordinate through durable Tier 2 persistent lease and fencing tokens
    // (simulates real browser process boundary where Web Lock was released on worker crash)
    const originalLocks = globalThis.navigator?.locks;
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    let unpauseWorkerA!: () => void;
    try {
      // 1. Worker A boots and enqueues candidate
      const workerA = env.createWorker("Worker-A");
      const { candidate, sender } = await buildCandidateSubmission({
        problemSlug: "two-sum",
        sourceCode: "int twoSum() { return 5; }\n",
      });
      const msg = createExtensionMessage(candidate);
      await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

      // Pause Worker A inside handler before pre-flight GET
      const pausePromise = new Promise<void>((resolve) => {
        unpauseWorkerA = resolve;
      });
      workerA.gitHubContentsService.onBeforePreFlightGet = async () => {
        await pausePromise;
      };

      // Launch Worker A drain pass asynchronously
      const drainPromiseA = workerA.queueDrainer.drain("submission_event");

      // Allow Worker A to acquire persistent lease (fencing token 1) and enter handler
      await new Promise((r) => setTimeout(r, 10));

      // Verify Worker A claimed item with fencing token 1
      const queueDuringA = await env.getDurableQueue();
      expect(queueDuringA[0]!.state).toBe(QueueState.PROCESSING);
      expect(queueDuringA[0]!.fencingToken).toBe(1);

      // Advance virtual time past lease TTL (30s) so Worker A's lease expires
      virtualTime += 35_000;

      // 2. Fresh Worker B starts up while Worker A is suspended
      const workerB = env.createWorker("Worker-B");
      expect(workerB.queueManager).not.toBe(workerA.queueManager);

      // Worker B executes startup drain:
      // Reclaims expired lease -> acquires fencing token 2 -> recovers item -> completes it
      const summaryB = await workerB.queueDrainer.drain("startup");
      expect(summaryB?.completed).toBe(1);

      // Verify Worker B completed the item and committed to storage
      const queueAfterB = await env.getDurableQueue();
      expect(queueAfterB[0]!.state).toBe(QueueState.COMPLETED);
      expect(queueAfterB[0]!.fencingToken).toBe(2); // Superseded to fence 2
      const workerBCommitSha = queueAfterB[0]!.commitSha;
      expect(workerBCommitSha).toBeDefined();

      // 3. Unpause Worker A: Worker A resumes and attempts to proceed
      unpauseWorkerA();

      // Worker A must encounter StaleLeaseError fail-closed when validating fencing token!
      await expect(drainPromiseA).rejects.toThrow(StaleLeaseError);

      // Assert that stale Worker A did NOT overwrite Worker B's durable state:
      const queueFinal = await env.getDurableQueue();
      expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
      expect(queueFinal[0]!.fencingToken).toBe(2); // Remained fence 2!
      expect(queueFinal[0]!.commitSha).toBe(workerBCommitSha);

      // Assert that Worker A did NOT write a duplicate history entry
      const history = await env.getDurableHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("synced");

      // Clean up Worker A
      env.discardWorker(workerA);
    } finally {
      if (unpauseWorkerA) {
        unpauseWorkerA();
      }
      if (originalLocks) {
        Object.defineProperty(globalThis.navigator, "locks", {
          value: originalLocks,
          configurable: true,
        });
      }
    }
  });

  // ==========================================================================
  // CRASH-INT-06-SEC — Tampered Durable State Fails Closed Upon Restart
  // ==========================================================================
  it("CRASH-INT-06-SEC: Tampered durable queue state upon restart fails closed without unauthorized GitHub dispatch", async () => {
    const testStartTime = 1700000000000;
    vi.spyOn(Date, "now").mockImplementation(() => testStartTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 6; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);
    env.discardWorker(workerA);

    // Tamper with durable storage: strip validatedBy stamp to simulate storage tampering
    const queue = await env.getDurableQueue();
    const tampered = { ...queue[0]!, validatedBy: undefined };
    await env.sharedStorageDriver.set({
      [STORAGE_KEYS.QUEUE_METADATA]: [tampered],
    });

    // 2. Fresh Worker B boots and attempts drain
    const workerB = env.createWorker("Worker-B");
    const summaryB = await workerB.queueDrainer.drain("startup");

    // Must be quarantined to requires_attention
    expect(summaryB?.quarantined).toBe(1);
    expect(summaryB?.completed).toBe(0);

    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueFinal[0]!.lastError?.code).toBe(ErrorCode.INVARIANT_VIOLATION);

    // ZERO GitHub calls must have occurred for tampered item
    expect(env.mockGitHubServer.getPutCount()).toBe(0);
  });
});
