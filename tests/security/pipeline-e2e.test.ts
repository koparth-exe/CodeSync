import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createE2EHarness,
  createExtensionMessage,
  type E2EHarness,
} from "../helpers/e2e-harness";
import { computeContentHash } from "../../src/shared/deduplication";
import {
  QueueState,
  type QueueItemMetadata,
} from "../../src/shared/storage/types";
import { ErrorCode, GitHubRateLimitError } from "../../src/shared/errors";
import {
  DurableTokenLifecycleManager,
  type GitHubAuthState,
} from "../../src/shared/auth";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import type { GitHubWriteOptions } from "../../src/shared/github/types";
import type { CanonicalSubmissionCandidate } from "../../src/shared/adapters";
import type { RuntimeSenderInfo } from "../../src/shared/messaging/types";

describe("Phase 1C.4.3.1 — End-to-End Pipeline Verification Suite", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = createE2EHarness();
    await harness.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to build realistic canonical submission candidates
  async function buildCandidate(
    platform:
      "leetcode" | "codeforces" | "codechef" | "geeksforgeeks" = "leetcode",
    overrides: Partial<CanonicalSubmissionCandidate> = {},
  ): Promise<{
    candidate: CanonicalSubmissionCandidate;
    sender: RuntimeSenderInfo;
  }> {
    if (platform === "codeforces") {
      const sourceCode =
        overrides.sourceCode ??
        "#include <bits/stdc++.h>\nusing namespace std;\nint main() { return 0; }\n";
      const hash = await computeContentHash(sourceCode);
      return {
        candidate: {
          platform: "codeforces",
          problemId: overrides.problemId ?? "1850-A",
          problemSlug: overrides.problemSlug ?? "to-my-critics",
          problemTitle: overrides.problemTitle ?? "A. To My Critics",
          status: overrides.status ?? "ACCEPTED",
          language: overrides.language ?? "cpp",
          sourceCode,
          contentHash: overrides.contentHash ?? hash,
          submittedAt: Date.now(),
          sourceUrl: "https://codeforces.com/contest/1850/problem/A",
          problemUrl: "https://codeforces.com/contest/1850/problem/A",
          sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
          extractionConfidence: 0.95,
          extractionLayer: "dom",
          submissionId: overrides.submissionId ?? "215000001",
          platformMetadata: { contestId: "1850", index: "A" },
        },
        sender: {
          tab: {
            id: 101,
            url: "https://codeforces.com/contest/1850/problem/A",
          },
        },
      };
    }

    if (platform === "codechef") {
      const sourceCode =
        overrides.sourceCode ??
        "#include <iostream>\nusing namespace std;\nint main() { return 0; }\n";
      const hash = await computeContentHash(sourceCode);
      return {
        candidate: {
          platform: "codechef",
          problemId: overrides.problemId ?? "FLOW001",
          problemSlug: overrides.problemSlug ?? "add-two-numbers",
          problemTitle: overrides.problemTitle ?? "Add Two Numbers",
          status: overrides.status ?? "ACCEPTED",
          language: overrides.language ?? "cpp",
          sourceCode,
          contentHash: overrides.contentHash ?? hash,
          submittedAt: Date.now(),
          sourceUrl: "https://www.codechef.com/viewsolution/987654321",
          problemUrl: "https://www.codechef.com/problems/FLOW001",
          sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
          extractionConfidence: 0.95,
          extractionLayer: "dom",
          submissionId: overrides.submissionId ?? "987654321",
        },
        sender: {
          tab: { id: 102, url: "https://www.codechef.com/problems/FLOW001" },
        },
      };
    }

    if (platform === "geeksforgeeks") {
      const sourceCode =
        overrides.sourceCode ??
        "class Solution { static ArrayList<Integer> subarraySum(int[] arr, int n, int s) { return new ArrayList<>(); } }\n";
      const hash = await computeContentHash(sourceCode);
      return {
        candidate: {
          platform: "geeksforgeeks",
          problemId: overrides.problemId ?? "subarray-with-given-sum",
          problemSlug: overrides.problemSlug ?? "subarray-with-given-sum",
          problemTitle: overrides.problemTitle ?? "Subarray with given sum",
          status: overrides.status ?? "ACCEPTED",
          language: overrides.language ?? "java",
          sourceCode,
          contentHash: overrides.contentHash ?? hash,
          submittedAt: Date.now(),
          sourceUrl:
            "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
          problemUrl:
            "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
          sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
          extractionConfidence: 0.95,
          extractionLayer: "dom",
          submissionId: overrides.submissionId ?? "555444333",
        },
        sender: {
          tab: {
            id: 103,
            url: "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
          },
        },
      };
    }

    // Default: LeetCode
    const sourceCode =
      overrides.sourceCode ??
      "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {};\n    }\n};\n";
    const hash = await computeContentHash(sourceCode);
    return {
      candidate: {
        platform: "leetcode",
        problemId: overrides.problemId ?? "two-sum",
        problemSlug: overrides.problemSlug ?? "two-sum",
        problemTitle: overrides.problemTitle ?? "Two Sum",
        status: overrides.status ?? "ACCEPTED",
        language: overrides.language ?? "cpp",
        sourceCode,
        contentHash: overrides.contentHash ?? hash,
        submittedAt: Date.now(),
        sourceUrl: "https://leetcode.com/problems/two-sum/",
        problemUrl: "https://leetcode.com/problems/two-sum/",
        sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
        extractionConfidence: 0.95,
        extractionLayer: "dom",
        submissionId: overrides.submissionId ?? "99881122",
      },
      sender: {
        tab: { id: 100, url: "https://leetcode.com/problems/two-sum/" },
      },
    };
  }

  // ==========================================================================
  // E2E-01 — COMPLETE HAPPY PATH
  // ==========================================================================
  it("E2E-01: Full happy path: Message -> Validation -> WAL -> Queue -> Drain -> GitHub Sync -> Verification -> COMPLETED -> History", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const message = createExtensionMessage(candidate);

    // 1. Dispatch message through service worker boundary
    const { enqueueResult, drainSummary } =
      await harness.dispatchBackgroundMessage(message, sender);

    // Assert message reception and validation
    expect(enqueueResult.success).toBe(true);
    expect(enqueueResult.queueItem).toBeDefined();
    const item = enqueueResult.queueItem!;
    expect(item.validatedBy).toBe("SERVICE_WORKER");
    expect(item.platform).toBe("leetcode");
    expect(item.problemSlug).toBe("two-sum");
    expect(item.contentHash).toBe(candidate.contentHash);
    expect(item.targetSnapshot).toBeDefined();
    expect(item.targetSnapshot!.targetRepository).toBe("octocat/dsa-repo");
    expect(item.targetSnapshot!.targetBranch).toBe("main");

    // Assert drain summary
    expect(drainSummary).not.toBeNull();
    expect(drainSummary?.processed).toBe(1);
    expect(drainSummary?.completed).toBe(1);
    expect(drainSummary?.failed).toBe(0);

    // Assert durable queue state
    const queue = await harness.getDurableQueue();
    expect(queue).toHaveLength(1);
    const durableItem = queue[0]!;
    expect(durableItem.state).toBe(QueueState.COMPLETED);
    expect(durableItem.commitSha).toBeDefined();
    expect(durableItem.commitUrl).toContain("octocat/dsa-repo/commit/");

    // Assert durable payload in IndexedDB
    const payloads = await harness.getDurablePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.id).toBe(durableItem.payloadId);
    expect(payloads[0]!.sourceCode).toBe(candidate.sourceCode);

    // Assert WAL entries: committed operations clean up WAL entry on completion
    const walEntries = await harness.getDurableWalEntries();
    expect(walEntries).toHaveLength(0);

    // Assert sync history in IndexedDB
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(1);
    const historyRecord = history[0]!;
    expect(historyRecord.submissionId).toBe(durableItem.id);
    expect(historyRecord.status).toBe("synced");
    expect(historyRecord.commitSha).toBe(durableItem.commitSha);
    expect(historyRecord.platform).toBe("leetcode");
    expect(historyRecord.problemTitle).toBe("Two Sum");
    expect(historyRecord.language).toBe("cpp");

    // Assert remote GitHub mock state
    const remoteFile = harness.mockGitHubServer.getFile(
      "solutions/leetcode/two-sum.cpp",
    );
    expect(remoteFile).toBeDefined();
    expect(remoteFile?.content).toBe(candidate.sourceCode);
    expect(remoteFile?.contentHash).toBe(candidate.contentHash);

    // Assert exact request trace ordering
    const trace = harness.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Pre-flight check (404)
      "PUT_FILE", // Optimistic create (201)
      "GET_FILE_VERIFY", // Authoritative post-write verification GET (200)
    ]);
  });

  // ==========================================================================
  // E2E-02 — MULTI-PLATFORM BATCH
  // ==========================================================================
  it("E2E-02: Multi-platform batch synchronizes LeetCode, Codeforces, CodeChef, and GeeksforGeeks independently", async () => {
    const platforms = [
      "leetcode",
      "codeforces",
      "codechef",
      "geeksforgeeks",
    ] as const;

    // Enqueue all 4 platforms before draining
    for (const p of platforms) {
      const { candidate, sender } = await buildCandidate(p);
      const msg = createExtensionMessage(candidate);
      const enq = await harness.submissionHandler.handleMessageAndEnqueue(
        msg,
        sender,
      );
      expect(enq.success).toBe(true);
      expect(enq.queueItem?.state).toBe(QueueState.PENDING);
    }

    // Verify all 4 are durable and PENDING in queue
    const queueBefore = await harness.getDurableQueue();
    expect(queueBefore).toHaveLength(4);
    expect(queueBefore.every((i) => i.state === QueueState.PENDING)).toBe(true);

    // Execute one controlled batch drain pass
    const summary = await harness.queueDrainer.drain("alarm");
    expect(summary).not.toBeNull();
    expect(summary?.processed).toBe(4);
    expect(summary?.completed).toBe(4);
    expect(summary?.failed).toBe(0);

    // Verify all 4 reach COMPLETED
    const queueAfter = await harness.getDurableQueue();
    expect(queueAfter).toHaveLength(4);
    expect(queueAfter.every((i) => i.state === QueueState.COMPLETED)).toBe(
      true,
    );

    // Verify distinct safe paths in mock remote repository
    expect(
      harness.mockGitHubServer.hasFile("solutions/leetcode/two-sum.cpp"),
    ).toBe(true);
    expect(
      harness.mockGitHubServer.hasFile(
        "solutions/codeforces/to-my-critics.cpp",
      ),
    ).toBe(true);
    expect(
      harness.mockGitHubServer.hasFile(
        "solutions/codechef/add-two-numbers.cpp",
      ),
    ).toBe(true);
    expect(
      harness.mockGitHubServer.hasFile(
        "solutions/geeksforgeeks/subarray-with-given-sum.java",
      ),
    ).toBe(true);

    // Verify history records for all 4
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(4);
    const recordedPlatforms = history.map((h) => h.platform);
    expect(recordedPlatforms).toContain("leetcode");
    expect(recordedPlatforms).toContain("codeforces");
    expect(recordedPlatforms).toContain("codechef");
    expect(recordedPlatforms).toContain("geeksforgeeks");
  });

  // ==========================================================================
  // E2E-03 — REPLACE_IF_DIFFERENT
  // ==========================================================================
  it("E2E-03: REPLACE_IF_DIFFERENT: Remote file with identical content skips PUT and records SKIPPED", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const targetPath = "solutions/leetcode/two-sum.cpp";

    // Pre-populate mock remote file with identical content
    await harness.mockGitHubServer.setFile(targetPath, candidate.sourceCode);

    // Enqueue submission
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Drain
    const summary = await harness.queueDrainer.drain("submission_event");
    expect(summary?.processed).toBe(1);
    expect(summary?.skipped).toBe(1);
    expect(summary?.completed).toBe(0);

    // Durable queue state is SKIPPED
    const queue = await harness.getDurableQueue();
    expect(queue[0]!.state).toBe(QueueState.SKIPPED);

    // History is recorded as "skipped"
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("skipped");

    // Request trace proves pre-flight GET occurred, but PUT did NOT occur!
    const trace = harness.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual(["GET_REPOSITORY", "GET_BRANCH", "GET_FILE"]);
    expect(harness.mockGitHubServer.getPutCount()).toBe(0);
  });

  // ==========================================================================
  // E2E-04 — KEEP_ALL
  // ==========================================================================
  it("E2E-04: KEEP_ALL: Resolves versioned target path and writes without overwriting original", async () => {
    // Re-seed configuration with keep_both (normalizes to KEEP_ALL)
    await harness.seedDefaults({ duplicatePolicy: "keep_both" });

    const originalPath = "solutions/leetcode/two-sum.cpp";
    await harness.mockGitHubServer.setFile(
      originalPath,
      "// Version 1 of solution\n",
    );

    const { candidate, sender } = await buildCandidate("leetcode", {
      sourceCode: "// Version 2 of solution\n",
    });

    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const summary = await harness.queueDrainer.drain("submission_event");
    expect(summary?.completed).toBe(1);

    // Verify both original and versioned files exist on remote mock
    expect(harness.mockGitHubServer.hasFile(originalPath)).toBe(true);
    expect(
      harness.mockGitHubServer.hasFile("solutions/leetcode/two-sum-v2.cpp"),
    ).toBe(true);

    const queue = await harness.getDurableQueue();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  // ==========================================================================
  // E2E-05 — 409 CONFLICT
  // ==========================================================================
  it("E2E-05: 409 Conflict: Resolves conflict via fresh remote SHA and conditional retry; bounds unresolvable conflict", async () => {
    const targetPath = "solutions/leetcode/two-sum.cpp";
    // Seed initial remote file
    await harness.mockGitHubServer.setFile(
      targetPath,
      "// Older remote content\n",
      "sha_initial_111",
    );

    const { candidate, sender } = await buildCandidate("leetcode", {
      sourceCode: "// My new submission content\n",
    });

    // Configure 409 conflict on first PUT with a fresh remote file
    const freshRemoteHash = await computeContentHash(
      "// Concurrently committed content\n",
    );
    harness.mockGitHubServer.configure409Conflict(
      {
        content: "// Concurrently committed content\n",
        contentHash: freshRemoteHash,
        sha: "sha_fresh_222",
        type: "file",
      },
      1, // Confict fires once
    );

    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const summary = await harness.queueDrainer.drain("submission_event");
    expect(summary?.completed).toBe(1);

    const queue = await harness.getDurableQueue();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);

    // Request trace proves 409 occurred, fresh GET retrieved new SHA, and retry PUT succeeded
    const trace = harness.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Pre-flight check returns initial remote (sha_initial_111)
      "PUT_FILE_409", // Dispatched PUT receives 409 conflict
      "GET_FILE", // Step 9: Fresh authoritative GET retrieves sha_fresh_222
      "PUT_FILE", // Retried PUT with sha_fresh_222 succeeds (200)
      "GET_FILE_VERIFY", // Verification GET confirms write
    ]);

    // Sub-case: Unresolvable continuous conflict exceeding MAX_CONFLICT_REVALIDATIONS (2)
    const harness2 = createE2EHarness();
    await harness2.seedDefaults();
    await harness2.mockGitHubServer.setFile(
      targetPath,
      "// Base\n",
      "sha_base",
    );
    harness2.mockGitHubServer.configure409Conflict(
      {
        content: "// Different concurrent write\n",
        contentHash: "a".repeat(64),
        sha: "sha_diff",
        type: "file",
      },
      10, // Always conflicts
    );

    const msg2 = createExtensionMessage(candidate);
    await harness2.submissionHandler.handleMessageAndEnqueue(msg2, sender);
    const summary2 = await harness2.queueDrainer.drain("submission_event");
    expect(summary2?.quarantined).toBe(1);

    const queue2 = await harness2.getDurableQueue();
    expect(queue2[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queue2[0]!.lastError?.code).toBe(ErrorCode.GITHUB_CONFLICT);
  });

  // ==========================================================================
  // E2E-06 — CRASH / RESTART / RECOVERY
  // ==========================================================================
  it("E2E-06: Crash / Recovery: Interrupted PROCESSING item recovers; pre-flight GET prevents duplicate writes; poison-pill quarantines", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);

    // Enqueue candidate
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Simulate worker crash: mutate item state directly to PROCESSING
    const queue = await harness.getDurableQueue();
    const item = queue[0]!;
    item.state = QueueState.PROCESSING;
    item.crashCount = 0;
    await harness.storage.setQueueMetadata([item]);

    // Scenario A: GitHub had NOT received write before crash
    // Simulate startup recovery pass
    const summary1 = await harness.queueDrainer.drain("startup");
    expect(summary1?.completed).toBe(1);

    const queueAfter1 = await harness.getDurableQueue();
    expect(queueAfter1[0]!.state).toBe(QueueState.COMPLETED);
    expect(queueAfter1[0]!.crashCount).toBe(1); // Detected and incremented during reconciliation

    // Scenario B: Item crashed AFTER GitHub accepted the write
    const harnessB = createE2EHarness();
    await harnessB.seedDefaults();
    await harnessB.submissionHandler.handleMessageAndEnqueue(msg, sender);
    // Remote already has the file
    await harnessB.mockGitHubServer.setFile(
      "solutions/leetcode/two-sum.cpp",
      candidate.sourceCode,
    );
    const queueB = await harnessB.getDurableQueue();
    queueB[0]!.state = QueueState.PROCESSING;
    queueB[0]!.crashCount = 0;
    await harnessB.storage.setQueueMetadata(queueB);

    const summaryB = await harnessB.queueDrainer.drain("startup");
    // Pre-flight GET sees matching hash, skips write safely
    expect(summaryB?.skipped).toBe(1);
    expect(harnessB.mockGitHubServer.getPutCount()).toBe(0);

    // Scenario C: Poison pill (crashCount >= 3)
    const harnessC = createE2EHarness();
    await harnessC.seedDefaults();
    await harnessC.submissionHandler.handleMessageAndEnqueue(msg, sender);
    const queueC = await harnessC.getDurableQueue();
    queueC[0]!.state = QueueState.PROCESSING;
    queueC[0]!.crashCount = 2; // Next crash will reach threshold 3
    await harnessC.storage.setQueueMetadata(queueC);

    const summaryC = await harnessC.queueDrainer.drain("startup");
    expect(summaryC?.quarantined).toBe(1);
    const queueAfterC = await harnessC.getDurableQueue();
    expect(queueAfterC[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueAfterC[0]!.lastError?.code).toBe(
      ErrorCode.POISON_PILL_DETECTED,
    );
  });

  // ==========================================================================
  // E2E-07 — 429 RATE LIMIT → RETRY → SUCCESS
  // ==========================================================================
  it("E2E-07: 429 Rate Limit: Backoff delay is respected; early drain skips; retry succeeds upon timer expiry", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const testStartTime = Math.floor(Date.now() / 1000) * 1000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Configure 429 rate limit for 1 attempt with retry-after: 60 seconds
    harness.mockGitHubServer.configure429RateLimit({
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: virtualTime + 60_000,
    });

    // Drain attempt 1: hits HTTP 429
    const summary1 = await harness.queueDrainer.drain("submission_event");
    expect(summary1?.failed).toBe(1);

    const queue1 = await harness.getDurableQueue();
    const failedItem = queue1[0]!;
    expect(failedItem.state).toBe(QueueState.FAILED);
    expect(failedItem.attempts).toBe(1);
    expect(failedItem.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
    expect(failedItem.nextRetryAt).toBeGreaterThanOrEqual(virtualTime + 60_000);

    // Drain attempt 2: Before nextRetryAt (virtualTime + 30s) -> Must NOT process!
    virtualTime += 30_000;
    const summary2 = await harness.queueDrainer.drain("alarm");
    expect(summary2?.processed).toBe(0); // Safely skipped
    expect(summary2?.failed).toBe(0);

    // Drain attempt 3: Advance virtual time past nextRetryAt (virtualTime + 35s = +65s total)
    virtualTime += 35_000;
    const summary3 = await harness.queueDrainer.drain("alarm");
    expect(summary3?.processed).toBe(1);
    expect(summary3?.completed).toBe(1);

    const queueFinal = await harness.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);

    // Exactly 1 write occurred (first attempt stopped at pre-flight GET with 429; retry completed write)
    expect(harness.mockGitHubServer.getPutCount()).toBe(1);
  });

  // ==========================================================================
  // E2E-08 — UNCERTAIN WRITE
  // ==========================================================================
  it("E2E-08: Uncertain Write: Reconciles network drops; confirms if hash matches; halts blind retries on mismatch or error", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const targetPath = "solutions/leetcode/two-sum.cpp";

    // CASE A: PUT experiences network drop, but server committed write so reconciliation GET finds matching hash
    harness.mockGitHubServer.configureNetworkFailure({
      method: "PUT",
      pathSubstring: targetPath,
      maxTimes: 1,
      commitBeforeFailure: true,
    });

    const msgA = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msgA, sender);
    const summaryA = await harness.queueDrainer.drain("submission_event");

    expect(summaryA?.completed).toBe(1);
    const queueA = await harness.getDurableQueue();
    expect(queueA[0]!.state).toBe(QueueState.COMPLETED);

    // CASE B: PUT experiences network drop, reconciliation GET finds file is absent / mismatch
    const harnessB = createE2EHarness();
    await harnessB.seedDefaults();
    harnessB.mockGitHubServer.configureNetworkFailure({
      method: "PUT",
      pathSubstring: targetPath,
      maxTimes: 1,
    });
    // File remains absent on remote
    const msgB = createExtensionMessage(candidate);
    await harnessB.submissionHandler.handleMessageAndEnqueue(msgB, sender);
    const summaryB = await harnessB.queueDrainer.drain("submission_event");

    expect(summaryB?.quarantined).toBe(1);
    const queueB = await harnessB.getDurableQueue();
    expect(queueB[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueB[0]!.lastError?.code).toBe(
      ErrorCode.GITHUB_WRITE_OUTCOME_UNKNOWN,
    );
    // CRITICAL: Exactly 1 PUT attempted, ZERO blind retry PUTs issued!
    expect(harnessB.mockGitHubServer.getPutCount()).toBe(1);

    // CASE C: PUT succeeds, but post-write verification GET encounters network error
    const harnessC = createE2EHarness();
    await harnessC.seedDefaults();
    harnessC.mockGitHubServer.configureVerificationHook({
      pathSubstring: targetPath,
      type: "network_error",
    });
    const msgC = createExtensionMessage(candidate);
    await harnessC.submissionHandler.handleMessageAndEnqueue(msgC, sender);
    const summaryC = await harnessC.queueDrainer.drain("submission_event");

    expect(summaryC?.quarantined).toBe(1);
    const queueC = await harnessC.getDurableQueue();
    expect(queueC[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueC[0]!.lastError?.code).toBe("GITHUB_RECONCILIATION_REQUIRED");
    // Zero blind retries
    expect(harnessC.mockGitHubServer.getPutCount()).toBe(1);
  });

  // ==========================================================================
  // E2E-09 — HOSTILE MESSAGE
  // ==========================================================================
  it("E2E-09: Hostile Message: Rejects unauthorized sender, spoofed origin, replayed nonces, and stale messages fail-closed", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");

    // 1. Spoofed origin (sender URL does not match platform)
    const hostileSender1: RuntimeSenderInfo = {
      tab: { id: 999, url: "https://evil-spoofing-site.com" },
    };
    const msg1 = createExtensionMessage(candidate);
    const res1 = await harness.dispatchBackgroundMessage(msg1, hostileSender1);
    expect(res1.enqueueResult.success).toBe(false);
    expect(res1.enqueueResult.error).toContain("Spoofed submission origin");

    // 2. Mismatched platform in sender
    const hostileSender2: RuntimeSenderInfo = {
      tab: { id: 999, url: "https://leetcode.com/problems/two-sum/" },
    };
    const mismatchedCandidate = {
      ...candidate,
      platform: "codeforces" as const,
    };
    const msg2 = createExtensionMessage(mismatchedCandidate);
    const res2 = await harness.dispatchBackgroundMessage(msg2, hostileSender2);
    expect(res2.enqueueResult.success).toBe(false);

    // 3. Invalid nonce (non-UUID v4)
    const msg3 = createExtensionMessage(candidate, { id: "invalid-nonce" });
    const res3 = await harness.dispatchBackgroundMessage(msg3, sender);
    expect(res3.enqueueResult.success).toBe(false);

    // 4. Replay attack: second message with identical nonce
    const fixedNonce = crypto.randomUUID();
    const msg4a = createExtensionMessage(candidate, { id: fixedNonce });
    const msg4b = createExtensionMessage(candidate, { id: fixedNonce });
    const res4a = await harness.dispatchBackgroundMessage(msg4a, sender);
    expect(res4a.enqueueResult.success).toBe(true);

    const res4b = await harness.dispatchBackgroundMessage(msg4b, sender);
    expect(res4b.enqueueResult.success).toBe(false);
    expect(res4b.enqueueResult.error).toContain("Replay attack");

    // 5. Stale timestamp (> 30s old)
    const msg5 = createExtensionMessage(candidate, {
      timestamp: Date.now() - 40_000,
    });
    const res5 = await harness.dispatchBackgroundMessage(msg5, sender);
    expect(res5.enqueueResult.success).toBe(false);
    expect(res5.enqueueResult.error).toContain("expired");

    // 6. Non-accepted submission status
    const rejectedCandidate = { ...candidate, status: "WRONG_ANSWER" as const };
    const msg6 = createExtensionMessage(rejectedCandidate);
    const res6 = await harness.dispatchBackgroundMessage(msg6, sender);
    expect(res6.enqueueResult.success).toBe(false);
    expect(res6.enqueueResult.error).toContain("WRONG_ANSWER");

    // Assert: Across all hostile messages, zero illegitimate queue items persisted
    const queue = await harness.getDurableQueue();
    // Only the single valid msg4a enqueued
    expect(queue).toHaveLength(1);
  });

  // ==========================================================================
  // E2E-10 — FORGED / TAMPERED QUEUE ITEM
  // ==========================================================================
  it("E2E-10: Forged / Tampered Queue Item: Fails closed on authority spoofing, payload corruption, or traversal", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Case A: Forged validatedBy (missing SERVICE_WORKER authority stamp)
    const queueA = await harness.getDurableQueue();
    queueA[0] = {
      ...queueA[0]!,
      validatedBy:
        "UNTRUSTED_PAGE" as unknown as QueueItemMetadata["validatedBy"],
    };
    await harness.storage.setQueueMetadata(queueA);
    const summaryA = await harness.queueDrainer.drain("alarm");
    expect(summaryA?.quarantined).toBe(1);
    const itemA = (await harness.getDurableQueue())[0]!;
    expect(itemA.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(itemA.lastError?.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(harness.mockGitHubServer.getPutCount()).toBe(0);

    // Case B: Tampered content hash in queue item (metadata hash != actual payload hash)
    const harnessB = createE2EHarness();
    await harnessB.seedDefaults();
    await harnessB.submissionHandler.handleMessageAndEnqueue(msg, sender);
    const queueB = await harnessB.getDurableQueue();
    queueB[0] = { ...queueB[0]!, contentHash: "0".repeat(64) }; // Tampered hash
    await harnessB.storage.setQueueMetadata(queueB);
    const summaryB = await harnessB.queueDrainer.drain("alarm");
    expect(summaryB?.quarantined).toBe(1);
    const itemB = (await harnessB.getDurableQueue())[0]!;
    expect(itemB.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(itemB.lastError?.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(harnessB.mockGitHubServer.getPutCount()).toBe(0);

    // Case C: Oversized payload in IndexedDB store (> 500 KB)
    const harnessC = createE2EHarness();
    await harnessC.seedDefaults();
    await harnessC.submissionHandler.handleMessageAndEnqueue(msg, sender);
    const payload = (await harnessC.getDurablePayloads())[0]!;
    await harnessC.payloadDriver.putPayload({
      ...payload,
      sourceCode: "X".repeat(513 * 1024), // Exceeds MAX_SOURCE_PAYLOAD_BYTES (512 KB)
    });
    const summaryC = await harnessC.queueDrainer.drain("alarm");
    expect(summaryC?.quarantined).toBe(1);
    const itemC = (await harnessC.getDurableQueue())[0]!;
    expect(itemC.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(itemC.lastError?.code).toBe(ErrorCode.GITHUB_PAYLOAD_TOO_LARGE);
    expect(harnessC.mockGitHubServer.getPutCount()).toBe(0);

    // Case D: Path traversal attempt in problemSlug
    const harnessD = createE2EHarness();
    await harnessD.seedDefaults();
    await harnessD.submissionHandler.handleMessageAndEnqueue(msg, sender);
    const queueD = await harnessD.getDurableQueue();
    queueD[0] = { ...queueD[0]!, problemSlug: "../../../etc/passwd" };
    await harnessD.storage.setQueueMetadata(queueD);
    const summaryD = await harnessD.queueDrainer.drain("alarm");
    expect(summaryD?.quarantined).toBe(1);
    const itemD = (await harnessD.getDurableQueue())[0]!;
    expect(itemD.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(harnessD.mockGitHubServer.getPutCount()).toBe(0);
  });

  // ==========================================================================
  // E2E-11 — CONCURRENT DRAIN TRIGGERS
  // ==========================================================================
  it("E2E-11: Concurrent Drain Triggers: Startup, submission event, and alarm triggers safely coalesce under two-tier lock", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    // Fire 3 simultaneous drain triggers concurrently
    const [resStartup, resEvent, resAlarm] = await Promise.all([
      harness.queueDrainer.drain("startup"),
      harness.queueDrainer.drain("submission_event"),
      harness.queueDrainer.drain("alarm"),
    ]);

    // All results resolved safely without throwing
    const completedCount =
      (resStartup?.completed ?? 0) +
      (resEvent?.completed ?? 0) +
      (resAlarm?.completed ?? 0);

    // Item was processed exactly ONCE
    expect(completedCount).toBe(1);
    expect(harness.mockGitHubServer.getPutCount()).toBe(1);

    const queue = await harness.getDurableQueue();
    expect(queue[0]!.state).toBe(QueueState.COMPLETED);
  });

  // ==========================================================================
  // E2E-12 — DIFFERENT SUBMISSION IDS / SAME CONTENT
  // ==========================================================================
  it("E2E-12: Different Submission IDs / Same Content: Submissions remain distinct queue identities and sync safely", async () => {
    const { candidate: c1, sender: s1 } = await buildCandidate("leetcode", {
      submissionId: "sub-101",
    });
    const { candidate: c2, sender: s2 } = await buildCandidate("leetcode", {
      submissionId: "sub-102",
    });

    const msg1 = createExtensionMessage(c1);
    const msg2 = createExtensionMessage(c2);

    const enq1 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg1,
      s1,
    );
    const enq2 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg2,
      s2,
    );

    expect(enq1.success).toBe(true);
    expect(enq2.success).toBe(true);
    expect(enq1.queueItem?.id).not.toBe(enq2.queueItem?.id);

    // Both exist as distinct items in queue
    const queueBefore = await harness.getDurableQueue();
    expect(queueBefore).toHaveLength(2);

    // Drain
    const summary = await harness.queueDrainer.drain("alarm");
    expect(summary?.processed).toBe(2);
    // Under REPLACE_IF_DIFFERENT: First completes write, second detects identical remote content and skips
    expect(summary?.completed).toBe(1);
    expect(summary?.skipped).toBe(1);

    const queueAfter = await harness.getDurableQueue();
    expect(queueAfter.map((i) => i.state)).toEqual([
      QueueState.COMPLETED,
      QueueState.SKIPPED,
    ]);

    // Exactly 1 PUT occurred
    expect(harness.mockGitHubServer.getPutCount()).toBe(1);
  });

  // ==========================================================================
  // E2E-13 — SAME SUBMISSION ID / SAME CONTENT REPLAY
  // ==========================================================================
  it("E2E-13: Same Submission ID / Same Content Replay: Idempotency returns existing queue item without duplicates", async () => {
    const { candidate, sender } = await buildCandidate("leetcode", {
      submissionId: "sub-201",
    });

    const msg1 = createExtensionMessage(candidate);
    const enq1 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg1,
      sender,
    );
    expect(enq1.success).toBe(true);

    // Replay identical submission while first is still active (PENDING)
    const msg2 = createExtensionMessage(candidate);
    const enq2 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg2,
      sender,
    );
    expect(enq2.success).toBe(true);

    // Hierarchy 2 match: returns the identical queue item ID
    expect(enq2.queueItem?.id).toBe(enq1.queueItem?.id);

    const queue = await harness.getDurableQueue();
    expect(queue).toHaveLength(1);
  });

  // ==========================================================================
  // E2E-14 — SAME SUBMISSION ID / CHANGED CONTENT
  // ==========================================================================
  it("E2E-14: Same Submission ID / Changed Content: Active item prevents duplicate; subsequent submission enqueues after completion", async () => {
    const { candidate: c1, sender } = await buildCandidate("leetcode", {
      submissionId: "sub-301",
      sourceCode: "// Original Code\n",
    });

    // 1. Enqueue original
    const msg1 = createExtensionMessage(c1);
    const enq1 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg1,
      sender,
    );
    expect(enq1.success).toBe(true);

    // 2. While item 1 is still active, an incoming submission with same submissionId returns active item (Hierarchy 2)
    const { candidate: cChanged } = await buildCandidate("leetcode", {
      submissionId: "sub-301",
      sourceCode: "// Changed Code while active\n",
    });
    const msgChanged = createExtensionMessage(cChanged);
    const enqConflict = await harness.submissionHandler.handleMessageAndEnqueue(
      msgChanged,
      sender,
    );
    expect(enqConflict.queueItem?.id).toBe(enq1.queueItem?.id);

    // 3. Drain item 1 to COMPLETED
    await harness.queueDrainer.drain("submission_event");
    const queueAfter1 = await harness.getDurableQueue();
    expect(queueAfter1[0]!.state).toBe(QueueState.COMPLETED);

    // 4. Now that item 1 is COMPLETED, submitting new code enqueues a new item
    const { candidate: c2 } = await buildCandidate("leetcode", {
      submissionId: "sub-302",
      sourceCode: "// Updated solution version\n",
    });
    const msg2 = createExtensionMessage(c2);
    const enq2 = await harness.submissionHandler.handleMessageAndEnqueue(
      msg2,
      sender,
    );
    expect(enq2.success).toBe(true);
    expect(enq2.queueItem?.id).not.toBe(enq1.queueItem?.id);

    const queueAfter2 = await harness.getDurableQueue();
    expect(queueAfter2).toHaveLength(2);

    // Drain second submission
    await harness.queueDrainer.drain("submission_event");
    const queueFinal = await harness.getDurableQueue();
    expect(queueFinal.every((i) => i.state === QueueState.COMPLETED)).toBe(
      true,
    );
  });

  // ==========================================================================
  // PHASE 1C.4.3.1 CORRECTION — P2 RATE LIMIT VS UNCERTAIN WRITE HARDENING
  // ==========================================================================

  // --------------------------------------------------------------------------
  // PUT-429-01: Explicit PUT 429 Is NOT Uncertain
  // --------------------------------------------------------------------------
  it("PUT-429-01: Explicit PUT 429 is recognized as known rate limit; does not invoke uncertain-write reconciliation", async () => {
    const targetPath = "solutions/leetcode/two-sum.cpp";
    const writeOptions: GitHubWriteOptions = {
      owner: "octocat",
      repo: "dsa-repo",
      branch: "main",
      path: targetPath,
      content: "// Valid Solution\n",
      commitMessage: "Sync leetcode - two-sum",
      duplicatePolicy: "REPLACE_IF_DIFFERENT",
    };

    // Configure PUT to receive explicit HTTP 429
    harness.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: Date.now() + 60_000,
    });

    // Invoke synchronizeFile directly on contentsService
    await expect(
      harness.gitHubContentsService.synchronizeFile(writeOptions),
    ).rejects.toThrow(GitHubRateLimitError);

    // Request trace MUST NOT include any post-PUT reconciliation GET
    const trace = harness.mockGitHubServer.getRequestTrace();
    expect(trace).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE", // Pre-flight check (404)
      "PUT_FILE_429", // Explicit 429 response
    ]);
  });

  // --------------------------------------------------------------------------
  // PUT-429-02: Queue Schedules Correct Retry
  // --------------------------------------------------------------------------
  it("PUT-429-02: Queue schedules retry on PUT 429 without entering uncertain-write quarantine", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const testStartTime = Math.floor(Date.now() / 1000) * 1000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Configure PUT 429 with Retry-After: 60
    harness.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: virtualTime + 60_000,
    });

    const summary = await harness.queueDrainer.drain("submission_event");
    expect(summary?.failed).toBe(1);
    expect(summary?.quarantined).toBe(0);

    const queue = await harness.getDurableQueue();
    const item = queue[0]!;
    expect(item.state).toBe(QueueState.FAILED);
    expect(item.attempts).toBe(1);
    expect(item.lastError?.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
    expect(item.nextRetryAt).toBeGreaterThanOrEqual(virtualTime + 60_000);

    // Early drain before nextRetryAt must safely skip processing
    virtualTime += 30_000;
    const earlySummary = await harness.queueDrainer.drain("alarm");
    expect(earlySummary?.processed).toBe(0);
    expect(earlySummary?.failed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // PUT-429-03: Retry After Rate Limit Succeeds
  // --------------------------------------------------------------------------
  it("PUT-429-03: Retry succeeds cleanly after rate-limit expiry with zero redundant reconciliation calls", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const testStartTime = Math.floor(Date.now() / 1000) * 1000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Attempt 1: PUT returns 429
    harness.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 60,
      resetTimestamp: virtualTime + 60_000,
    });

    await harness.queueDrainer.drain("submission_event");
    const traceAfterAttempt1 = harness.mockGitHubServer.getRequestTrace();
    expect(traceAfterAttempt1).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE",
      "PUT_FILE_429",
    ]);

    // Advance virtual time past nextRetryAt (+65s)
    virtualTime += 65_000;

    // Attempt 2: Re-drain succeeds cleanly
    const summary2 = await harness.queueDrainer.drain("alarm");
    expect(summary2?.processed).toBe(1);
    expect(summary2?.completed).toBe(1);

    const queueFinal = await harness.getDurableQueue();
    expect(queueFinal[0]!.state).toBe(QueueState.COMPLETED);

    // Verify exactly 1 failed PUT (429) + exactly 1 successful retry PUT (200)
    expect(harness.mockGitHubServer.getPutCount()).toBe(2);

    const traceFinal = harness.mockGitHubServer.getRequestTrace();
    expect(traceFinal).toEqual([
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE",
      "PUT_FILE_429",
      "GET_REPOSITORY",
      "GET_BRANCH",
      "GET_FILE",
      "PUT_FILE",
      "GET_FILE_VERIFY",
    ]);

    // Verify history entry created
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("synced");
    expect(history[0]!.commitSha).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // PUT-429-04: Rate-Limit Delay Dominates Backoff
  // --------------------------------------------------------------------------
  it("PUT-429-04: Rate-limit Retry-After delay dominates shorter exponential backoff delay", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const msg = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const testStartTime = Math.floor(Date.now() / 1000) * 1000;
    const virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // Configure 120-second rate limit (normal attempt 1 backoff is ~1s, far less than 120s)
    harness.mockGitHubServer.configure429RateLimit({
      method: "PUT",
      maxTimes: 1,
      retryAfterSeconds: 120,
      resetTimestamp: virtualTime + 120_000,
    });

    await harness.queueDrainer.drain("submission_event");
    const queue = await harness.getDurableQueue();
    const item = queue[0]!;

    expect(item.state).toBe(QueueState.FAILED);
    expect(item.attempts).toBe(1);
    // Invariant: effectiveDelay = max(backoffDelay, rateLimitDelay) -> 120s dominates
    expect(item.nextRetryAt).toBe(virtualTime + 120_000);
  });

  // --------------------------------------------------------------------------
  // UNCERTAIN-PUT-REGRESSION-01: Genuine Uncertainty
  // --------------------------------------------------------------------------
  it("UNCERTAIN-PUT-REGRESSION-01: Genuine transport uncertainty during PUT still enters reconciliation path", async () => {
    const { candidate, sender } = await buildCandidate("leetcode");
    const targetPath = "solutions/leetcode/two-sum.cpp";

    // Case A: Transport disconnect after server committed write -> reconciles to COMPLETED
    harness.mockGitHubServer.configureNetworkFailure({
      method: "PUT",
      pathSubstring: targetPath,
      maxTimes: 1,
      commitBeforeFailure: true,
    });

    const msgA = createExtensionMessage(candidate);
    await harness.submissionHandler.handleMessageAndEnqueue(msgA, sender);
    const summaryA = await harness.queueDrainer.drain("submission_event");
    expect(summaryA?.completed).toBe(1);

    const queueA = await harness.getDurableQueue();
    expect(queueA[0]!.state).toBe(QueueState.COMPLETED);

    // Trace confirms reconciliation GET occurred
    const traceA = harness.mockGitHubServer.getRequestTrace();
    expect(traceA).toContain("GET_FILE");

    // Case B: Transport disconnect before server committed write -> reconciles to failure, quarantined
    const harnessB = createE2EHarness();
    await harnessB.seedDefaults();
    harnessB.mockGitHubServer.configureNetworkFailure({
      method: "PUT",
      pathSubstring: targetPath,
      maxTimes: 1,
      commitBeforeFailure: false,
    });

    const msgB = createExtensionMessage(candidate);
    await harnessB.submissionHandler.handleMessageAndEnqueue(msgB, sender);
    const summaryB = await harnessB.queueDrainer.drain("submission_event");
    expect(summaryB?.quarantined).toBe(1);

    const queueB = await harnessB.getDurableQueue();
    expect(queueB[0]!.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(queueB[0]!.lastError?.code).toBe(
      ErrorCode.GITHUB_WRITE_OUTCOME_UNKNOWN,
    );
  });

  // ==========================================================================
  // Phase 1C.4.3.3.1 — Failure Matrix Integration Suite
  // ==========================================================================
  describe("Phase 1C.4.3.3.1 — Failure Matrix Integration Suite", () => {
    // ------------------------------------------------------------------------
    // FAIL-MAT-01: 401 → coordinated token refresh → retry success
    // ------------------------------------------------------------------------
    it("FAIL-MAT-01: 401 triggers coordinated token refresh and succeeds on single retry", async () => {
      const refreshedToken = "ghu_refreshed_access_token_123";
      const oauthFetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/login/oauth/access_token")) {
          return new Response(
            JSON.stringify({
              access_token: refreshedToken,
              token_type: "bearer",
              expires_in: 28800,
              refresh_token: "ghr_new_refresh_token_456",
              refresh_token_expires_in: 15552000,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
        });
      });

      const testHarness = createE2EHarness({
        lifecycleManagerFactory: (storage) =>
          new DurableTokenLifecycleManager({
            storage,
            fetchFn: oauthFetchMock as unknown as typeof fetch,
          }),
      });
      await testHarness.seedDefaults();

      // Configure initial 401 on GitHub API until refreshed token is supplied
      testHarness.mockGitHubServer.configureAuthFailure({
        status: 401,
        maxTimes: 1,
        validToken: refreshedToken,
      });

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      const enqueueRes =
        await testHarness.submissionHandler.handleMessageAndEnqueue(
          msg,
          sender,
        );
      expect(enqueueRes.success).toBe(true);

      const drainSummary =
        await testHarness.queueDrainer.drain("submission_event");

      // 1. Queue drain outcome assertions
      expect(drainSummary).not.toBeNull();
      expect(drainSummary?.completed).toBe(1);
      expect(drainSummary?.failed).toBe(0);
      expect(drainSummary?.quarantined).toBe(0);

      // 2. Queue state assertions
      const queue = await testHarness.getDurableQueue();
      expect(queue).toHaveLength(1);
      const item = queue[0]!;
      expect(item.state).toBe(QueueState.COMPLETED);
      expect(item.attempts).toBe(0); // Retry was internal to GitHub client request
      expect(item.nextRetryAt).toBeUndefined();
      expect(item.lastError).toBeUndefined();

      // 3. Auth lifecycle & storage assertions
      expect(oauthFetchMock).toHaveBeenCalledTimes(1);
      const authState = await testHarness.storage.get<GitHubAuthState>(
        STORAGE_KEYS.AUTH,
      );
      expect(authState).toBeDefined();
      expect(authState!.status).toBe("authenticated");
      expect(authState!.accessToken).toBe(refreshedToken);
      expect(authState!.refreshGeneration).toBe(2);
      expect(authState!.refreshState).toBe("IDLE");

      // 4. Request sequence & trace assertions
      const trace = testHarness.mockGitHubServer.getRequestTrace();
      expect(trace[0]).toBe("GET_AUTH_401");
      expect(trace).toContain("GET_REPOSITORY");
      expect(trace).toContain("GET_BRANCH");
      expect(trace).toContain("GET_FILE");
      expect(trace).toContain("PUT_FILE");
      expect(trace).toContain("GET_FILE_VERIFY");
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(1);

      // 5. History assertion
      const history = await testHarness.getDurableHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("synced");
      expect(history[0]!.commitSha).toBeDefined();
    });

    // ------------------------------------------------------------------------
    // FAIL-MAT-02: 401 → refresh token revoked/fails → quarantine
    // ------------------------------------------------------------------------
    it("FAIL-MAT-02: 401 with revoked/failing refresh token fails closed into quarantine", async () => {
      const oauthFetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/login/oauth/access_token")) {
          return new Response(
            JSON.stringify({
              error: "bad_refresh_token",
              error_description: "The refresh token is invalid or revoked.",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
        });
      });

      const testHarness = createE2EHarness({
        lifecycleManagerFactory: (storage) =>
          new DurableTokenLifecycleManager({
            storage,
            fetchFn: oauthFetchMock as unknown as typeof fetch,
          }),
      });
      await testHarness.seedDefaults();

      // 401 on GitHub API
      testHarness.mockGitHubServer.configureAuthFailure({
        status: 401,
        maxTimes: 10,
      });

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      await testHarness.submissionHandler.handleMessageAndEnqueue(msg, sender);

      const drainSummary =
        await testHarness.queueDrainer.drain("submission_event");

      // 1. Drain summary assertions
      expect(drainSummary?.quarantined).toBe(1);
      expect(drainSummary?.completed).toBe(0);
      expect(drainSummary?.failed).toBe(0);

      // 2. Queue state assertions
      const queue = await testHarness.getDurableQueue();
      expect(queue).toHaveLength(1);
      const item = queue[0]!;
      expect(item.state).toBe(QueueState.REQUIRES_ATTENTION);
      expect(item.lastError?.code).toBe(ErrorCode.GITHUB_UNAUTHORIZED);
      expect(item.attempts).toBe(0); // Quarantined immediately, attempts not incremented
      expect(item.nextRetryAt).toBeUndefined();

      // 3. Zero PUT dispatched
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);

      // 4. Durable auth state reflects reauth required
      const authState = await testHarness.storage.get<GitHubAuthState>(
        STORAGE_KEYS.AUTH,
      );
      expect(authState!.status).toBe("reauth_required");

      // 5. Exactly 1 refresh attempted
      expect(oauthFetchMock).toHaveBeenCalledTimes(1);

      // 6. No infinite retry or refresh storm on subsequent drain
      const drainSummary2 =
        await testHarness.queueDrainer.drain("submission_event");
      expect(drainSummary2?.processed).toBe(0);
      expect(drainSummary2?.quarantined).toBe(0);
      expect(oauthFetchMock).toHaveBeenCalledTimes(1);
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);
    });

    // ------------------------------------------------------------------------
    // FAIL-MAT-03: 403 authorization denial → immediate quarantine
    // ------------------------------------------------------------------------
    it("FAIL-MAT-03: 403 authorization denial (no rate limit headers) immediately quarantines without retry", async () => {
      const testHarness = createE2EHarness();
      await testHarness.seedDefaults();

      // Configure 403 forbidden without rate limit headers
      testHarness.mockGitHubServer.configureAuthFailure({
        status: 403,
        maxTimes: 10,
      });

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      await testHarness.submissionHandler.handleMessageAndEnqueue(msg, sender);

      const drainSummary =
        await testHarness.queueDrainer.drain("submission_event");

      // 1. Drain summary assertions
      expect(drainSummary?.quarantined).toBe(1);
      expect(drainSummary?.completed).toBe(0);
      expect(drainSummary?.failed).toBe(0);

      // 2. Queue state assertions
      const queue = await testHarness.getDurableQueue();
      expect(queue).toHaveLength(1);
      const item = queue[0]!;
      expect(item.state).toBe(QueueState.REQUIRES_ATTENTION);
      expect(item.lastError?.code).toBe(ErrorCode.GITHUB_FORBIDDEN);
      expect(item.attempts).toBe(0);
      expect(item.nextRetryAt).toBeUndefined();

      // 3. No PUT dispatched, pre-write authorization denial
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);
      const trace = testHarness.mockGitHubServer.getRequestTrace();
      expect(trace[0]).toBe("GET_AUTH_403");
      expect(trace).not.toContain("PUT_FILE");

      // 4. No history entries
      const history = await testHarness.getDurableHistory();
      expect(history).toHaveLength(0);

      // 5. Subsequent drain skips quarantined item
      const drainSummary2 = await testHarness.queueDrainer.drain("alarm");
      expect(drainSummary2?.processed).toBe(0);
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);
    });

    // ------------------------------------------------------------------------
    // FAIL-MAT-04: Pre-flight GET transport disconnect → clean backoff
    // ------------------------------------------------------------------------
    it("FAIL-MAT-04: Pre-flight GET transport failure schedules clean backoff without uncertain write reconciliation", async () => {
      const testHarness = createE2EHarness();
      await testHarness.seedDefaults();

      const targetPath = "solutions/leetcode/two-sum.cpp";
      testHarness.mockGitHubServer.configureNetworkFailure({
        method: "GET",
        pathSubstring: targetPath,
        maxTimes: 1,
      });

      const startTime = 1_700_000_000_000;
      let virtualTime = startTime;
      vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      await testHarness.submissionHandler.handleMessageAndEnqueue(msg, sender);

      // First attempt: Pre-flight GET encounters transport disconnect
      const drainSummary1 =
        await testHarness.queueDrainer.drain("submission_event");
      expect(drainSummary1?.failed).toBe(1);
      expect(drainSummary1?.completed).toBe(0);
      expect(drainSummary1?.quarantined).toBe(0);

      // Assertions for attempt 1: retryable failure, backoff scheduled, 0 PUTs
      const queue1 = await testHarness.getDurableQueue();
      expect(queue1).toHaveLength(1);
      const item1 = queue1[0]!;
      expect(item1.state).toBe(QueueState.FAILED);
      expect(item1.attempts).toBe(1);
      expect(item1.lastError?.code).toBe(ErrorCode.GITHUB_API_ERROR);
      expect(item1.nextRetryAt).toBeDefined();
      expect(item1.nextRetryAt!).toBeGreaterThan(startTime);

      // CRITICAL INVARIANT: No PUT dispatched -> NOT an uncertain write reconciliation
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);
      const trace1 = testHarness.mockGitHubServer.getRequestTrace();
      expect(trace1).toContain("GET_FILE_NETWORK_FAILURE");
      expect(trace1).not.toContain("PUT_FILE");

      // Second drain before nextRetryAt: MUST be skipped
      virtualTime = startTime + 100;
      const drainSummary2 = await testHarness.queueDrainer.drain("alarm");
      expect(drainSummary2?.processed).toBe(0);

      // Third drain after nextRetryAt: Retries and completes cleanly
      virtualTime = item1.nextRetryAt! + 100;
      const drainSummary3 = await testHarness.queueDrainer.drain("alarm");
      expect(drainSummary3?.completed).toBe(1);

      const queue3 = await testHarness.getDurableQueue();
      expect(queue3[0]!.state).toBe(QueueState.COMPLETED);
      expect(queue3[0]!.attempts).toBe(1);
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(1);

      const history = await testHarness.getDurableHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("synced");
    });

    // ------------------------------------------------------------------------
    // FAIL-MAT-05: Post-write verification content mismatch → quarantine
    // ------------------------------------------------------------------------
    it("FAIL-MAT-05: Post-write verification content mismatch transitions to attention/quarantine", async () => {
      const testHarness = createE2EHarness();
      await testHarness.seedDefaults();

      const targetPath = "solutions/leetcode/two-sum.cpp";
      testHarness.mockGitHubServer.configureVerificationHook({
        pathSubstring: targetPath,
        type: "mismatch",
      });

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      await testHarness.submissionHandler.handleMessageAndEnqueue(msg, sender);

      const drainSummary =
        await testHarness.queueDrainer.drain("submission_event");

      // 1. Drain summary assertions
      expect(drainSummary?.quarantined).toBe(1);
      expect(drainSummary?.completed).toBe(0);
      expect(drainSummary?.failed).toBe(0);

      // 2. Queue state assertions: quarantined with GITHUB_VERIFICATION_FAILED
      const queue = await testHarness.getDurableQueue();
      expect(queue).toHaveLength(1);
      const item = queue[0]!;
      expect(item.state).toBe(QueueState.REQUIRES_ATTENTION);
      expect(item.lastError?.code).toBe("GITHUB_VERIFICATION_FAILED");
      expect(item.nextRetryAt).toBeUndefined();

      // 3. PUT occurred exactly once, no blind duplicate PUT
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(1);

      const trace = testHarness.mockGitHubServer.getRequestTrace();
      expect(trace).toContain("PUT_FILE");
      expect(trace).toContain("GET_FILE_VERIFY");

      // 4. Result must not be falsely reported as successful in history
      const history = await testHarness.getDurableHistory();
      expect(history).toHaveLength(0);

      // 5. Subsequent drain skips quarantined item, no duplicate write
      const drainSummary2 =
        await testHarness.queueDrainer.drain("submission_event");
      expect(drainSummary2?.processed).toBe(0);
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(1);
    });

    // ------------------------------------------------------------------------
    // FAIL-MAT-06: Pre-flight GET 5xx → retryable failure
    // ------------------------------------------------------------------------
    it("FAIL-MAT-06: Pre-flight GET 5xx classifies as retryable failure without uncertain-write reconciliation", async () => {
      const testHarness = createE2EHarness();
      await testHarness.seedDefaults();

      testHarness.mockGitHubServer.configureServerError({
        status: 500,
        maxTimes: 1,
        method: "GET",
      });

      const startTime = 1_700_000_000_000;
      let virtualTime = startTime;
      vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

      const { candidate, sender } = await buildCandidate("leetcode");
      const msg = createExtensionMessage(candidate);
      await testHarness.submissionHandler.handleMessageAndEnqueue(msg, sender);

      // Attempt 1: Pre-flight GET receives 500
      const drainSummary1 =
        await testHarness.queueDrainer.drain("submission_event");
      expect(drainSummary1?.failed).toBe(1);
      expect(drainSummary1?.completed).toBe(0);
      expect(drainSummary1?.quarantined).toBe(0);

      const queue1 = await testHarness.getDurableQueue();
      expect(queue1).toHaveLength(1);
      const item1 = queue1[0]!;
      expect(item1.state).toBe(QueueState.FAILED);
      expect(item1.attempts).toBe(1);
      expect(item1.lastError?.code).toBe(ErrorCode.GITHUB_API_ERROR);
      expect(item1.nextRetryAt).toBeDefined();
      expect(item1.nextRetryAt!).toBeGreaterThan(startTime);

      // Zero PUTs dispatched
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(0);
      const trace1 = testHarness.mockGitHubServer.getRequestTrace();
      expect(trace1[0]).toBe("GET_SERVER_ERROR_500");
      expect(trace1).not.toContain("PUT_FILE");

      // Second drain before nextRetryAt: skipped
      virtualTime = startTime + 100;
      const drainSummary2 = await testHarness.queueDrainer.drain("alarm");
      expect(drainSummary2?.processed).toBe(0);

      // Third drain after nextRetryAt: succeeds cleanly
      virtualTime = item1.nextRetryAt! + 100;
      const drainSummary3 = await testHarness.queueDrainer.drain("alarm");
      expect(drainSummary3?.completed).toBe(1);

      const queue3 = await testHarness.getDurableQueue();
      expect(queue3[0]!.state).toBe(QueueState.COMPLETED);
      expect(queue3[0]!.attempts).toBe(1);
      expect(testHarness.mockGitHubServer.getPutCount()).toBe(1);

      const history = await testHarness.getDurableHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("synced");
      expect(history[0]!.commitSha).toBeDefined();
    });
  });
});
