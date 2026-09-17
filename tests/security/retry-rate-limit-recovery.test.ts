import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createCrashTestEnvironment,
  buildCandidateSubmission,
  createExtensionMessage,
  type CrashTestEnvironment,
} from "../helpers/crash-harness";
import { QueueState } from "../../src/shared/storage/types";
import { ErrorCode } from "../../src/shared/errors";
import { MAX_ATTEMPTS } from "../../src/shared/queue/manager";

describe("Phase 1C.4.3.2.2.3.1 — Restart, Retry & Rate-Limit Persistence Integration Suite", () => {
  let env: CrashTestEnvironment;
  let originalLocks: LockManager | undefined;

  beforeEach(async () => {
    originalLocks = globalThis.navigator?.locks;
    env = createCrashTestEnvironment();
    await env.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLocks !== undefined) {
      Object.defineProperty(globalThis.navigator, "locks", {
        value: originalLocks,
        configurable: true,
      });
    }
  });

  // ==========================================================================
  // RETRY-REC-03 — Multi-Restart Persistence
  // ==========================================================================
  it("RETRY-REC-03: preserves retry state across multiple fresh-worker restarts before nextRetryAt", async () => {
    // Disable Web Locks to verify pure durable storage lease and metadata persistence
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // ------------------------------------------------------------------------
    // Generation 1: Worker A boots, enqueues item, encounters rate limit
    // ------------------------------------------------------------------------
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 1; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Configure GitHub to return HTTP 429 on PUT (retry after 60s)
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: testStartTime + 60_000,
    });

    // Worker A runs drain pass — encounters 429 and commits FAILED state
    const summaryA = await workerA.queueDrainer.drain("submission_event");
    expect(summaryA?.failed).toBe(1);
    expect(summaryA?.completed).toBe(0);

    // Assert initial durable state in storage.local before restart
    const queueA = await env.getDurableQueue();
    expect(queueA).toHaveLength(1);
    expect(queueA[0]!.state).toBe(QueueState.FAILED);
    expect(queueA[0]!.attempts).toBe(1);
    expect(queueA[0]!.crashCount).toBe(0);
    expect(queueA[0]!.nextRetryAt).toBe(testStartTime + 60_000);
    expect(queueA[0]!.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);

    // Worker A terminates cleanly (no in-flight mutation)
    env.discardWorker(workerA);

    // Advance virtual time by 10s (50s before nextRetryAt)
    virtualTime += 10_000;

    // ------------------------------------------------------------------------
    // Generation 2: Worker B boots fresh from shared durable storage
    // ------------------------------------------------------------------------
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.concurrency).not.toBe(workerA.concurrency);
    expect(workerB.storage).not.toBe(workerA.storage);

    // Assert durable state upon Worker B start: strictly unchanged, zero drift
    const queueAtBStart = await env.getDurableQueue();
    expect(queueAtBStart[0]!.state).toBe(QueueState.FAILED);
    expect(queueAtBStart[0]!.attempts).toBe(1);
    expect(queueAtBStart[0]!.crashCount).toBe(0);
    expect(queueAtBStart[0]!.nextRetryAt).toBe(testStartTime + 60_000);

    // Worker B triggers startup drain pass while now < nextRetryAt
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.processed).toBe(0);
    expect(summaryB?.failed).toBe(0);

    // Assert ZERO additional network calls were made during early drain
    expect(env.mockGitHubServer.getPutCount()).toBe(1); // Only Worker A's initial PUT

    // Assert durable queue state after Worker B drain: zero drift
    const queueAfterB = await env.getDurableQueue();
    expect(queueAfterB[0]!.state).toBe(QueueState.FAILED);
    expect(queueAfterB[0]!.attempts).toBe(1);
    expect(queueAfterB[0]!.crashCount).toBe(0);
    expect(queueAfterB[0]!.nextRetryAt).toBe(testStartTime + 60_000);

    // Worker B terminates cleanly
    env.discardWorker(workerB);

    // Advance virtual time by another 15s (35s before nextRetryAt)
    virtualTime += 15_000;

    // ------------------------------------------------------------------------
    // Generation 3: Worker C boots fresh from shared durable storage
    // ------------------------------------------------------------------------
    const workerC = env.createWorker("Worker-C");
    expect(workerC.queueManager).not.toBe(workerB.queueManager);

    // Assert durable state upon Worker C start: strictly unchanged, zero drift
    const queueAtCStart = await env.getDurableQueue();
    expect(queueAtCStart[0]!.state).toBe(QueueState.FAILED);
    expect(queueAtCStart[0]!.attempts).toBe(1);
    expect(queueAtCStart[0]!.crashCount).toBe(0);
    expect(queueAtCStart[0]!.nextRetryAt).toBe(testStartTime + 60_000);

    // Worker C triggers alarm drain pass while now < nextRetryAt
    const summaryC = await workerC.queueDrainer.drain("alarm");
    expect(summaryC?.processed).toBe(0);
    expect(summaryC?.failed).toBe(0);

    // Assert network calls remain at 1
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Assert durable queue state after Worker C drain: zero drift
    const queueAfterC = await env.getDurableQueue();
    expect(queueAfterC[0]!.state).toBe(QueueState.FAILED);
    expect(queueAfterC[0]!.attempts).toBe(1);
    expect(queueAfterC[0]!.crashCount).toBe(0);
    expect(queueAfterC[0]!.nextRetryAt).toBe(testStartTime + 60_000);

    // Worker C terminates cleanly
    env.discardWorker(workerC);

    // Advance virtual time past the persisted deadline (65s elapsed total)
    virtualTime = testStartTime + 65_000;

    // ------------------------------------------------------------------------
    // Generation 4: Worker D boots fresh and processes now-eligible item
    // ------------------------------------------------------------------------
    const workerD = env.createWorker("Worker-D");
    expect(workerD.queueManager).not.toBe(workerC.queueManager);

    // Worker D runs alarm drain — item is now eligible and synchronizes successfully
    const summaryD = await workerD.queueDrainer.drain("alarm");
    expect(summaryD?.processed).toBe(1);
    expect(summaryD?.completed).toBe(1);

    // Assert final durable queue state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueFinal[0]!.attempts).toBe(1); // Attempts preserved, not reset
    expect(queueFinal[0]!.crashCount).toBe(0); // Crashes / restarts did not increment crashCount
    expect(queueFinal[0]!.commitSha).toBeDefined();

    // Assert total PUT requests: exactly 1 failed (429) + 1 successful retry = 2
    expect(env.mockGitHubServer.getPutCount()).toBe(2);

    env.discardWorker(workerD);
  });

  // ==========================================================================
  // RETRY-REC-04 — Retry Attempt Persistence Across Worker Reconstruction
  // ==========================================================================
  it("RETRY-REC-04: preserves and monotonically increments retry attempts across fresh workers until retry ceiling", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Configure mock GitHub server to fail PUT requests with a retryable 429
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 10, // Fail repeatedly
      retryAfterSeconds: 5,
      resetTimestamp: virtualTime + 5_000,
    });

    // Worker 1 boots, enqueues candidate submission
    const worker1 = env.createWorker("Worker-1");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 2; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await worker1.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // ------------------------------------------------------------------------
    // Attempt 1: Worker 1
    // ------------------------------------------------------------------------
    const summary1 = await worker1.queueDrainer.drain("submission_event");
    expect(summary1?.failed).toBe(1);

    let queue = await env.getDurableQueue();
    expect(queue[0]!.attempts).toBe(1);
    expect(queue[0]!.crashCount).toBe(0);
    expect(queue[0]!.state).toBe(QueueState.FAILED);
    let nextRetry = queue[0]!.nextRetryAt!;
    expect(nextRetry).toBeGreaterThanOrEqual(virtualTime + 5_000);
    env.discardWorker(worker1);

    // ------------------------------------------------------------------------
    // Attempt 2: Worker 2 (fresh worker after time advance)
    // ------------------------------------------------------------------------
    virtualTime = nextRetry + 1_000;
    const worker2 = env.createWorker("Worker-2");
    expect(worker2.queueManager).not.toBe(worker1.queueManager);

    const summary2 = await worker2.queueDrainer.drain("alarm");
    expect(summary2?.failed).toBe(1);

    queue = await env.getDurableQueue();
    expect(queue[0]!.attempts).toBe(2);
    expect(queue[0]!.crashCount).toBe(0);
    expect(queue[0]!.state).toBe(QueueState.FAILED);
    nextRetry = queue[0]!.nextRetryAt!;
    env.discardWorker(worker2);

    // ------------------------------------------------------------------------
    // Attempt 3: Worker 3 (fresh worker after time advance)
    // ------------------------------------------------------------------------
    virtualTime = nextRetry + 1_000;
    const worker3 = env.createWorker("Worker-3");

    const summary3 = await worker3.queueDrainer.drain("alarm");
    expect(summary3?.failed).toBe(1);

    queue = await env.getDurableQueue();
    expect(queue[0]!.attempts).toBe(3);
    expect(queue[0]!.crashCount).toBe(0);
    expect(queue[0]!.state).toBe(QueueState.FAILED);
    nextRetry = queue[0]!.nextRetryAt!;
    env.discardWorker(worker3);

    // ------------------------------------------------------------------------
    // Attempt 4: Worker 4 (fresh worker after time advance)
    // ------------------------------------------------------------------------
    virtualTime = nextRetry + 1_000;
    const worker4 = env.createWorker("Worker-4");

    const summary4 = await worker4.queueDrainer.drain("alarm");
    expect(summary4?.failed).toBe(1);

    queue = await env.getDurableQueue();
    expect(queue[0]!.attempts).toBe(4);
    expect(queue[0]!.crashCount).toBe(0);
    expect(queue[0]!.state).toBe(QueueState.FAILED);
    nextRetry = queue[0]!.nextRetryAt!;
    env.discardWorker(worker4);

    // ------------------------------------------------------------------------
    // Attempt 5: Worker 5 reaches MAX_ATTEMPTS (5) -> REQUIRES_ATTENTION
    // ------------------------------------------------------------------------
    virtualTime = nextRetry + 1_000;
    const worker5 = env.createWorker("Worker-5");

    const summary5 = await worker5.queueDrainer.drain("alarm");
    expect(summary5?.quarantined).toBe(1);
    expect(summary5?.failed).toBe(0);

    queue = await env.getDurableQueue();
    expect(queue[0]!.attempts).toBe(MAX_ATTEMPTS); // Exactly 5
    expect(queue[0]!.crashCount).toBe(0); // Separated from crash count
    expect(queue[0]!.state).toBe(QueueState.REQUIRES_ATTENTION); // Terminal quarantine
    env.discardWorker(worker5);

    // ------------------------------------------------------------------------
    // Verification: Worker 6 starts, item is never retried
    // ------------------------------------------------------------------------
    virtualTime += 100_000;
    const worker6 = env.createWorker("Worker-6");
    const summary6 = await worker6.queueDrainer.drain("startup");
    expect(summary6?.processed).toBe(0);
    expect(summary6?.failed).toBe(0);

    const queueAfter6 = await env.getDurableQueue();
    expect(queueAfter6[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueAfter6[0]!.attempts).toBe(MAX_ATTEMPTS);
    expect(queueAfter6[0]!.crashCount).toBe(0);
    env.discardWorker(worker6);
  });

  // ==========================================================================
  // RATE-REC-01 — Primary Rate Limit: 403 Remaining Zero Across Restart
  // ==========================================================================
  it("RATE-REC-01: primary rate-limit (403 remaining=0) with reset timestamp survives worker restart", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 4030; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Configure GitHub to return HTTP 403 with x-ratelimit-remaining: 0 (Primary rate limit)
    // Resets in 90 seconds (testStartTime + 90_000)
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      status: 403,
      remaining: 0,
      resetTimestamp: testStartTime + 90_000,
      omitRetryAfter: true, // Primary rate limit uses x-ratelimit-reset, NOT Retry-After
    });

    // Worker A runs drain pass — classifies 403 remaining=0 as primary rate limit
    const summaryA = await workerA.queueDrainer.drain("submission_event");
    expect(summaryA?.failed).toBe(1);
    expect(summaryA?.quarantined).toBe(0); // MUST NOT be treated as authorization failure!

    // Assert durable queue state in storage.local
    const queueA = await env.getDurableQueue();
    expect(queueA[0]!.state).toBe(QueueState.FAILED);
    expect(queueA[0]!.attempts).toBe(1);
    expect(queueA[0]!.crashCount).toBe(0);
    expect(queueA[0]!.nextRetryAt).toBe(testStartTime + 90_000);
    expect(queueA[0]!.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);

    // Worker A terminates cleanly
    env.discardWorker(workerA);

    // Advance virtual time by 30s (60s before reset timestamp)
    virtualTime = testStartTime + 30_000;

    // 2. Worker B boots fresh from durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Worker B verifies durable state upon restart
    const queueAtB = await env.getDurableQueue();
    expect(queueAtB[0]!.state).toBe(QueueState.FAILED);
    expect(queueAtB[0]!.attempts).toBe(1);
    expect(queueAtB[0]!.nextRetryAt).toBe(testStartTime + 90_000);

    // Worker B early drain pass before reset: must safely skip processing
    const earlySummary = await workerB.queueDrainer.drain("startup");
    expect(earlySummary?.processed).toBe(0);
    expect(earlySummary?.failed).toBe(0);

    // Assert zero premature network writes
    expect(env.mockGitHubServer.getPutCount()).toBe(1); // Only Worker A's initial PUT

    // Advance virtual time past reset timestamp (+95s)
    virtualTime = testStartTime + 95_000;

    // Worker B runs drain pass — item is now eligible and synchronizes successfully
    const retrySummary = await workerB.queueDrainer.drain("alarm");
    expect(retrySummary?.processed).toBe(1);
    expect(retrySummary?.completed).toBe(1);

    // Assert final durable queue state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueFinal[0]!.attempts).toBe(1);
    expect(queueFinal[0]!.commitSha).toBeDefined();

    // Exactly 1 failed 403 PUT + 1 successful 200 PUT = 2
    expect(env.mockGitHubServer.getPutCount()).toBe(2);

    env.discardWorker(workerB);
  });

  // ==========================================================================
  // RATE-REC-02 — Secondary Rate Limit: 403 + Retry-After Across Restart
  // ==========================================================================
  it("RATE-REC-02: secondary rate-limit (403 + Retry-After) survives worker restart without authorization failure", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues candidate
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 4031; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Configure GitHub to return HTTP 403 with Retry-After: 75 and remaining > 0 (Secondary abuse throttle)
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      status: 403,
      remaining: 4999, // Non-zero remaining strictly differentiates secondary throttle from primary exhaustion
      retryAfterSeconds: 75,
    });

    // Worker A runs drain pass — classifies 403 + Retry-After as secondary rate limit
    const summaryA = await workerA.queueDrainer.drain("submission_event");
    expect(summaryA?.failed).toBe(1);
    expect(summaryA?.quarantined).toBe(0); // MUST NOT be treated as authorization failure!

    // Assert durable queue state in storage.local
    const queueA = await env.getDurableQueue();
    expect(queueA[0]!.state).toBe(QueueState.FAILED);
    expect(queueA[0]!.attempts).toBe(1);
    expect(queueA[0]!.crashCount).toBe(0);
    expect(queueA[0]!.nextRetryAt).toBe(testStartTime + 75_000);
    expect(queueA[0]!.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
    expect(queueA[0]!.lastError?.code).not.toBe(ErrorCode.GITHUB_FORBIDDEN);

    // Worker A terminates cleanly
    env.discardWorker(workerA);

    // Advance virtual time by 40s (35s before retry deadline)
    virtualTime = testStartTime + 40_000;

    // 2. Worker B boots fresh from durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Worker B verifies durable state upon restart
    const queueAtB = await env.getDurableQueue();
    expect(queueAtB[0]!.state).toBe(QueueState.FAILED);
    expect(queueAtB[0]!.attempts).toBe(1);
    expect(queueAtB[0]!.nextRetryAt).toBe(testStartTime + 75_000);

    // Early drain by Worker B before deadline: must safely skip processing
    const earlySummary = await workerB.queueDrainer.drain("alarm");
    expect(earlySummary?.processed).toBe(0);
    expect(earlySummary?.failed).toBe(0);

    // Assert zero premature network writes
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Advance virtual time past deadline (+80s total)
    virtualTime = testStartTime + 80_000;

    // Worker B runs drain pass — item is now eligible and synchronizes successfully
    const retrySummary = await workerB.queueDrainer.drain("alarm");
    expect(retrySummary?.processed).toBe(1);
    expect(retrySummary?.completed).toBe(1);

    // Assert final durable queue state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueFinal[0]!.attempts).toBe(1);
    expect(queueFinal[0]!.commitSha).toBeDefined();

    // Exactly 1 failed secondary 403 PUT + 1 successful 200 PUT = 2
    expect(env.mockGitHubServer.getPutCount()).toBe(2);

    env.discardWorker(workerB);
  });

  // ==========================================================================
  // RATE-REC-03 — Effective Delay Dominance Across Worker Reconstruction
  // ==========================================================================
  it("RATE-REC-03: effective delay dominance (max of backoff vs rate limit) survives fresh-worker reconstruction", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // ------------------------------------------------------------------------
    // Case 1: Rate-limit delay dominates shorter exponential backoff delay
    // ------------------------------------------------------------------------
    const workerA = env.createWorker("Worker-A");
    const { candidate: cand1, sender: send1 } = await buildCandidateSubmission({
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 100; }\n",
    });
    await workerA.submissionHandler.handleMessageAndEnqueue(
      createExtensionMessage(cand1),
      send1,
    );

    // Normal attempt 1 backoff is ~2000ms ± 400ms (max 2400ms).
    // Configure rate limit with 100 seconds (100,000ms), far dominating backoff.
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 100,
      resetTimestamp: testStartTime + 100_000,
    });

    const summaryA = await workerA.queueDrainer.drain("submission_event");
    expect(summaryA?.failed).toBe(1);

    // Assert durable nextRetryAt is governed by the 100s rate limit
    const queueA = await env.getDurableQueue();
    expect(queueA[0]!.nextRetryAt).toBe(testStartTime + 100_000);
    env.discardWorker(workerA);

    // Advance virtual time by 10s (past the ~2s backoff, but 90s before the 100s rate limit)
    virtualTime = testStartTime + 10_000;

    // Worker B boots fresh
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Worker B verifies that elapsed backoff does NOT cause premature retry; rate-limit dominates
    const earlySummaryB = await workerB.queueDrainer.drain("startup");
    expect(earlySummaryB?.processed).toBe(0);
    expect(earlySummaryB?.failed).toBe(0);
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Advance virtual time past the dominant 100s rate limit (+105s total)
    virtualTime = testStartTime + 105_000;

    const retrySummaryB = await workerB.queueDrainer.drain("alarm");
    expect(retrySummaryB?.processed).toBe(1);
    expect(retrySummaryB?.completed).toBe(1);

    const queueFinal1 = await env.getDurableQueue();
    expect(queueFinal1[0]!.state).toBe(QueueState.COMPLETED);
    env.discardWorker(workerB);

    // ------------------------------------------------------------------------
    // Case 2: Exponential backoff dominates shorter rate-limit delay
    // ------------------------------------------------------------------------
    virtualTime = 1700001000000;
    const case2StartTime = virtualTime;

    const workerC = env.createWorker("Worker-C");
    const { candidate: cand2, sender: send2 } = await buildCandidateSubmission({
      problemSlug: "three-sum",
      sourceCode: "int threeSum() { return 300; }\n",
    });
    await workerC.submissionHandler.handleMessageAndEnqueue(
      createExtensionMessage(cand2),
      send2,
    );

    // Configure a very short rate limit of 1 second (1000ms).
    // Attempt 1 backoff base is 2000ms with jitter ±20% -> range is [1600ms, 2400ms].
    // Backoff delay (> 1600ms) strictly dominates the 1000ms rate limit!
    env.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 1,
      resetTimestamp: case2StartTime + 1_000,
    });

    const summaryC = await workerC.queueDrainer.drain("submission_event");
    expect(summaryC?.failed).toBe(1);

    const queueC = await env.getDurableQueue();
    const item2 = queueC.find((i) => i.problemSlug === "three-sum")!;
    // Invariant: effectiveDelay = max(backoffDelay, rateLimitDelay) -> backoff (> 1600ms) dominates
    expect(item2.nextRetryAt).toBeGreaterThanOrEqual(case2StartTime + 1_600);
    const scheduledRetry = item2.nextRetryAt!;
    env.discardWorker(workerC);

    // Advance virtual time by 1050ms (past the 1000ms rate limit, but before backoff delay >= 1600ms)
    virtualTime = case2StartTime + 1_050;

    // Worker D boots fresh
    const workerD = env.createWorker("Worker-D");
    expect(workerD.queueManager).not.toBe(workerC.queueManager);

    // Worker D verifies that elapsed 1s rate limit does NOT cause premature retry; backoff dominates
    const earlySummaryD = await workerD.queueDrainer.drain("alarm");
    expect(earlySummaryD?.processed).toBe(0);
    expect(earlySummaryD?.failed).toBe(0);

    // Advance virtual time past the dominant backoff delay
    virtualTime = scheduledRetry + 500;

    const retrySummaryD = await workerD.queueDrainer.drain("alarm");
    expect(retrySummaryD?.processed).toBe(1);
    expect(retrySummaryD?.completed).toBe(1);

    const queueFinal2 = await env.getDurableQueue();
    const finalItem2 = queueFinal2.find((i) => i.problemSlug === "three-sum")!;
    expect(finalItem2.state).toBe(QueueState.COMPLETED);
    env.discardWorker(workerD);
  });
});
