import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createE2EHarness,
  createExtensionMessage,
  type E2EHarness,
} from "../helpers/e2e-harness";
import {
  buildCandidateSubmission,
  createCrashTestEnvironment,
  ProcessTerminatedError,
} from "../helpers/crash-harness";
import {
  SubmissionHandler,
  createDefaultRegistry,
  type CanonicalSubmissionCandidate,
} from "../../src/shared/adapters";
import {
  QueueState,
  WalPhase,
  type TargetSnapshot,
} from "../../src/shared/storage/types";
import { computeContentHash } from "../../src/shared/deduplication";
import type { DrainSummary } from "../../src/shared/queue/types";

describe("Phase 1C.4.3.4.1 — Idempotency / Duplicate / Conflict Targeted Integration Tests", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = createE2EHarness();
    await harness.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // IDEM-INT-01 — Concurrent Duplicate Enqueue Interleaving
  // ==========================================================================
  it("IDEM-INT-01: Concurrent Duplicate Enqueue Interleaving creates exactly one active item and resolves to same item ID", async () => {
    // Seed an unrelated active queue item first to verify non-interference
    const { candidate: unrelatedCandidate, sender: unrelatedSender } =
      await buildCandidateSubmission({
        platform: "leetcode",
        problemId: "reverse-string",
        problemSlug: "reverse-string",
        submissionId: "unrelated-sub-001",
        sourceCode:
          "class Solution { public: void reverseString(vector<char>& s) {} };\n",
      });
    const unrelatedMsg = createExtensionMessage(unrelatedCandidate);
    const unrelatedRes =
      await harness.submissionHandler.handleMessageAndEnqueue(
        unrelatedMsg,
        unrelatedSender,
      );
    expect(unrelatedRes.success).toBe(true);
    const unrelatedId = unrelatedRes.queueItem?.id;
    expect(unrelatedId).toBeDefined();

    // Construct two concurrent message-handling flows representing the same logical submission
    const { candidate: sharedCandidate, sender: sharedSender } =
      await buildCandidateSubmission({
        platform: "leetcode",
        problemId: "two-sum",
        problemSlug: "two-sum",
        submissionId: "shared-sub-777",
        sourceCode:
          "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {};\n    }\n};\n",
      });

    // Two distinct message envelopes (different envelope IDs / nonces) with identical submission payload
    const msg1 = createExtensionMessage(sharedCandidate);
    const msg2 = createExtensionMessage(sharedCandidate);

    const [res1, res2] = await Promise.all([
      harness.submissionHandler.handleMessageAndEnqueue(msg1, sharedSender),
      harness.submissionHandler.handleMessageAndEnqueue(msg2, sharedSender),
    ]);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(res1.queueItem).toBeDefined();
    expect(res2.queueItem).toBeDefined();

    // 1. Exactly ONE active queue item exists for this submission
    // 2. Both concurrent operations resolve to the SAME queue item ID
    expect(res1.queueItem?.id).toBe(res2.queueItem?.id);

    // 3. Durable queue length for that logical submission is exactly 1 (plus 1 unrelated = 2 total)
    const durableQueue = await harness.getDurableQueue();
    const matchingItems = durableQueue.filter(
      (item) =>
        item.platform === "leetcode" && item.submissionId === "shared-sub-777",
    );
    expect(matchingItems).toHaveLength(1);
    expect(matchingItems[0]!.id).toBe(res1.queueItem?.id);
    expect(matchingItems[0]!.state).toBe(QueueState.PENDING);

    // Total active items in queue
    expect(durableQueue).toHaveLength(2);

    // 4. No duplicate active WAL/queue entry remains
    const walEntries = await harness.getDurableWalEntries();
    const activeWalForSubmission = walEntries.filter(
      (w) =>
        (w.snapshot as { submission?: { submissionId?: string } })?.submission
          ?.submissionId === "shared-sub-777" && w.phase === WalPhase.INTENT,
    );
    expect(activeWalForSubmission).toHaveLength(0);

    // 5. No unrelated queue item is removed or modified
    const persistedUnrelated = durableQueue.find((i) => i.id === unrelatedId);
    expect(persistedUnrelated).toBeDefined();
    expect(persistedUnrelated?.submissionId).toBe("unrelated-sub-001");
    expect(persistedUnrelated?.problemSlug).toBe("reverse-string");
    expect(persistedUnrelated?.state).toBe(QueueState.PENDING);
  });

  // ==========================================================================
  // IDEM-INT-02 — KEEP_ALL Candidate Exhaustion End-to-End Quarantine
  // ==========================================================================
  it("IDEM-INT-02: KEEP_ALL candidate exhaustion fails closed into REQUIRES_ATTENTION with zero writes", async () => {
    // 1. Configure duplicate policy = KEEP_ALL ("keep_both" normalizes to KEEP_ALL)
    await harness.seedDefaults({ duplicatePolicy: "keep_both" });

    // Seed mock GitHub with base and all 9 versioned variants (-v2 through -v10)
    const basePath = "solutions/leetcode/two-sum.cpp";
    const seededContents: Record<string, string> = {
      [basePath]: "// Existing base version\n",
    };
    await harness.mockGitHubServer.setFile(basePath, seededContents[basePath]!);

    for (let v = 2; v <= 10; v++) {
      const vPath = `solutions/leetcode/two-sum-v${v}.cpp`;
      seededContents[vPath] = `// Existing v${v} version\n`;
      await harness.mockGitHubServer.setFile(vPath, seededContents[vPath]!);
    }

    // Verify all 10 files are seeded
    expect(harness.mockGitHubServer.getAllFiles().size).toBe(10);

    // 2. Enqueue a valid submission for this problem
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      submissionId: "exhaustion-sub-001",
      sourceCode: "class Solution { /* new submission candidate */ };\n",
    });

    const msg = createExtensionMessage(candidate);
    const enqRes = await harness.submissionHandler.handleMessageAndEnqueue(
      msg,
      sender,
    );
    expect(enqRes.success).toBe(true);
    expect(enqRes.queueItem).toBeDefined();
    const itemId = enqRes.queueItem!.id;

    // 3. Drain the queue through the REAL production queue -> GitHub path
    const summary = await harness.queueDrainer.drain("submission_event");

    // Required Assertions:
    // 1. Final result is GITHUB_CONFLICT / equivalent terminal conflict outcome
    expect(summary?.quarantined).toBe(1);
    expect(summary?.completed).toBe(0);
    expect(summary?.failed).toBe(0);

    // 2. Queue item enters REQUIRES_ATTENTION according to existing lifecycle
    const queue = await harness.getDurableQueue();
    expect(queue).toHaveLength(1);
    const item = queue[0]!;
    expect(item.id).toBe(itemId);
    expect(item.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(item.lastError?.code).toBe("GITHUB_CONFLICT");

    // 3. ZERO PUT/write operations occur
    expect(harness.mockGitHubServer.getPutCount()).toBe(0);

    // 4. No existing remote file is overwritten
    for (const [path, content] of Object.entries(seededContents)) {
      const file = harness.mockGitHubServer.getFile(path);
      expect(file).toBeDefined();
      expect(file?.content).toBe(content);
    }

    // 5. No candidate beyond -v10 is attempted
    const recordedRequests = harness.mockGitHubServer.getRecordedRequests();
    const v11Requests = recordedRequests.filter((r) =>
      r.path.includes("two-sum-v11"),
    );
    expect(v11Requests).toHaveLength(0);

    // 6. No infinite loop / bounded probing (base + v2..v10 = 10 probing GETs)
    const getFileRequests = recordedRequests.filter(
      (r) => r.traceType === "GET_FILE",
    );
    expect(getFileRequests).toHaveLength(10);

    // 7. No unbounded candidate generation: exactly 10 candidate files exist on server
    expect(harness.mockGitHubServer.getAllFiles().size).toBe(10);

    // 8. No queue corruption: payload remains intact
    const payloads = await harness.getDurablePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.id).toBe(`payload:${itemId}`);

    // 9. No silent fallback: item was not marked COMPLETED or SKIPPED
    expect(item.state).not.toBe(QueueState.COMPLETED);
    expect(item.state).not.toBe(QueueState.SKIPPED);
  });

  // ==========================================================================
  // IDEM-INT-03 — Multi-Worker Drain Contention During OCC 409 Revalidation
  // ==========================================================================
  it("IDEM-INT-03: Multi-Worker drain contention is fenced during OCC 409 revalidation; Worker B rejected with zero mutations", async () => {
    const env = createCrashTestEnvironment();
    await env.seedDefaults();

    const workerA = env.createWorker("Worker-A");
    const workerB = env.createWorker("Worker-B");

    // Seed initial remote file
    const targetPath = "solutions/leetcode/two-sum.cpp";
    await env.mockGitHubServer.setFile(
      targetPath,
      "// Initial remote content\n",
      "sha_initial_111",
    );

    // Configure 409 conflict for the first PUT
    const freshContent =
      "// Concurrently committed content by an external actor\n";
    const freshHash = await computeContentHash(freshContent);
    const freshSha = "sha_concurrent_222";
    env.mockGitHubServer.configure409Conflict(
      {
        content: freshContent,
        contentHash: freshHash,
        sha: freshSha,
        type: "file",
      },
      1,
    );

    // Enqueue valid submission through Worker A
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      submissionId: "occ-contention-001",
      sourceCode: "class Solution { /* worker A submission code */ };\n",
    });

    const msg = createExtensionMessage(candidate);
    const enqRes = await workerA.submissionHandler.handleMessageAndEnqueue(
      msg,
      sender,
    );
    expect(enqRes.success).toBe(true);
    const itemId = enqRes.queueItem!.id;

    let workerBDrainSummary: DrainSummary | null =
      "unreached" as unknown as null;
    let workerBExecuted = false;
    let queueStateDuringPause: QueueState | undefined;
    let putsDuringWorkerAConflict = 0;

    // Hook Worker A immediately before conflict revalidation
    workerA.gitHubContentsService.onBeforeConflictRevalidation = async () => {
      // Worker A is handling 409 and holds active lease and fencing token
      putsDuringWorkerAConflict = env.mockGitHubServer.getPutCount();

      // Inspect queue state during contention
      const queueDuring = await env.getDurableQueue();
      queueStateDuringPause = queueDuring.find((i) => i.id === itemId)?.state;

      // Worker B attempts to drain the same queue while Worker A is paused in 409 handling
      workerBDrainSummary =
        await workerB.queueDrainer.drain("submission_event");
      workerBExecuted = true;
    };

    // Worker A drains queue
    const summaryA = await workerA.queueDrainer.drain("submission_event");

    // Required assertions:
    // 1. Worker B execution was attempted and rejected/deferred because Worker A owns valid lease/fence
    expect(workerBExecuted).toBe(true);
    expect(workerBDrainSummary).toBeNull();

    // 2. Worker B cannot mutate the queue item (it remained in PROCESSING under Worker A's fence)
    expect(queueStateDuringPause).toBe(QueueState.PROCESSING);

    // 3. Worker B cannot perform a competing PUT
    expect(putsDuringWorkerAConflict).toBe(1); // Only Worker A's first PUT occurred

    // 4. Worker A successfully completes drain pass
    expect(summaryA?.completed).toBe(1);
    expect(summaryA?.failed).toBe(0);

    // 5. Worker A used the fresh remote SHA according to existing OCC logic
    const recordedRequests = env.mockGitHubServer.getRecordedRequests();
    const putRequests = recordedRequests.filter((r) => r.method === "PUT");
    expect(putRequests).toHaveLength(2); // 1st rejected with 409, 2nd succeeded
    expect(putRequests[0]!.status).toBe(409);
    expect(putRequests[0]!.sha).toBe("sha_initial_111");
    expect(putRequests[1]!.status).toBe(200);
    expect(putRequests[1]!.sha).toBe(freshSha);

    // 6. The item reaches the expected final result (COMPLETED)
    const finalQueue = await env.getDurableQueue();
    expect(finalQueue).toHaveLength(1);
    const finalItem = finalQueue[0]!;
    expect(finalItem.id).toBe(itemId);
    expect(finalItem.state).toBe(QueueState.COMPLETED);
    expect(finalItem.commitSha).toBeDefined();

    // 7. No stale-worker mutation occurs: final history contains exactly 1 entry
    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.submissionId).toBe(itemId);
    expect(history[0]!.status).toBe("synced");

    // 8. No duplicate PUT caused by Worker B (total PUTs on server = 2 from Worker A only)
    expect(env.mockGitHubServer.getPutCount()).toBe(2);

    // 9. Lease/fencing invariants remain intact (lease cleaned up gracefully on completion)
    const activeLease = await env.sharedStorageDriver.get(["queue_lease"]);
    expect(activeLease["queue_lease"]).toBeUndefined();
  });

  // ==========================================================================
  // IDEM-INT-04 — Crash Recovery With Remote Write Success (Zero Duplicate PUT)
  // ==========================================================================
  it("IDEM-INT-04: Crash Recovery With Remote Write Success: preflight GET detects identical content with zero duplicate PUT", async () => {
    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    const env = createCrashTestEnvironment();
    await env.seedDefaults();

    // 1. Worker A boots and receives valid queue item
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      submissionId: "crash-recovery-sub-001",
      sourceCode:
        "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        return {0, 1};\n    }\n};\n",
    });

    const msg = createExtensionMessage(candidate);
    const enqRes = await workerA.submissionHandler.handleMessageAndEnqueue(
      msg,
      sender,
    );
    expect(enqRes.success).toBe(true);
    const itemId = enqRes.queueItem!.id;

    // Simulate Worker A crashing immediately AFTER remote PUT success on GitHub
    // but BEFORE local completion/finalization is persisted
    workerA.gitHubContentsService.onBeforeVerificationGet = async () => {
      workerA.terminate();
      throw new ProcessTerminatedError(
        "Worker A crashed immediately after remote PUT succeeded before local finalization",
      );
    };

    // Worker A runs drain — fails because of simulated crash
    await expect(
      workerA.queueDrainer.drain("submission_event"),
    ).rejects.toThrow(ProcessTerminatedError);

    expect(workerA.isTerminated()).toBe(true);
    env.discardWorker(workerA);

    // State verification at crash point:
    // Remote GitHub DOES have the file successfully committed
    const targetFilePath = "solutions/leetcode/two-sum.cpp";
    expect(env.mockGitHubServer.hasFile(targetFilePath)).toBe(true);
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // Local durable queue still shows PROCESSING (local completion lost)
    const queueAtCrash = await env.getDurableQueue();
    expect(queueAtCrash).toHaveLength(1);
    expect(queueAtCrash[0]!.id).toBe(itemId);
    expect(queueAtCrash[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueAtCrash[0]!.completedAt).toBeUndefined();

    // Advance virtual time past lease TTL (30s) so Worker B can acquire lease
    virtualTime += 35_000;

    // 2. Fresh Worker B starts with independent object graph from durable storage
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);
    expect(workerB.storage).not.toBe(workerA.storage);
    expect(workerB.payloadStorage).not.toBe(workerA.payloadStorage);
    expect(workerB.gitHubContentsService).not.toBe(
      workerA.gitHubContentsService,
    );

    // Worker B recovers interrupted item and drains via startup pass
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB?.skipped).toBe(1);
    expect(summaryB?.completed).toBe(0);
    expect(summaryB?.failed).toBe(0);

    // Required assertions:
    // 1. Total PUT count = EXACTLY 1 across entire test (Zero duplicate PUT!)
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // 2. Worker B performs expected reconciliation/preflight GET
    const requestsAfterCrash = env.mockGitHubServer.getRecordedRequests();
    const workerBRequests = requestsAfterCrash.slice(2); // After Worker A's preflight GET + PUT
    const workerBPreflight = workerBRequests.find(
      (r) => r.traceType === "GET_FILE" && r.path === targetFilePath,
    );
    expect(workerBPreflight).toBeDefined();

    // 3. Remote content matches intended normalized content
    const remoteFile = env.mockGitHubServer.getFile(targetFilePath);
    expect(remoteFile).toBeDefined();
    expect(remoteFile?.contentHash).toBe(candidate.contentHash);

    // 4. No duplicate remote write occurs
    expect(env.mockGitHubServer.getPutCount()).toBe(1);

    // 5. Queue reaches correct terminal skipped/completed state
    const queueFinal = await env.getDurableQueue();
    expect(queueFinal).toHaveLength(1);
    expect(queueFinal[0]!.id).toBe(itemId);
    expect(queueFinal[0]!.state).toBe(QueueState.SKIPPED);
    expect(queueFinal[0]!.crashCount).toBe(1); // Reconciled from crash

    // 6. Exactly 1 history entry created (from Worker B's skip)
    const history = await env.getDurableHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.submissionId).toBe(itemId);
    expect(history[0]!.status).toBe("skipped");

    // 7. Durable WAL/recovery state cleaned up correctly
    const walEntries = await env.getDurableWalEntries();
    expect(walEntries).toHaveLength(0);

    // 8. Stale Worker A mutation cannot alter Worker B's result
    await expect(
      workerA.storage.setQueueMetadata([
        {
          ...queueFinal[0]!,
          state: QueueState.FAILED,
        },
      ]),
    ).rejects.toThrow(ProcessTerminatedError);

    // Verify queue remains SKIPPED despite stale worker attempt
    const finalCheck = await env.getDurableQueue();
    expect(finalCheck[0]!.state).toBe(QueueState.SKIPPED);
  });

  // ==========================================================================
  // IDEM-INT-05 — Multi-Submission Batch With Identical Source Code
  // Different Targets Must Remain Independent
  // ==========================================================================
  it("IDEM-INT-05: Multi-Submission batch with identical source code to different targets remain distinct and drain safely", async () => {
    // 1. Define identical source code across all three submissions
    const sharedSource =
      "#include <iostream>\nusing namespace std;\nint main() {\n    int a, b;\n    if (cin >> a >> b) {\n        cout << (a + b) << endl;\n    }\n    return 0;\n}\n";
    const sharedHash = await computeContentHash(sharedSource);

    // Configure distinct target snapshots per platform
    const targetSnapshotSupplier = async (
      candidate: CanonicalSubmissionCandidate,
    ): Promise<TargetSnapshot> => {
      if (candidate.platform === "leetcode") {
        return Object.freeze({
          targetRepository: "octocat/leetcode-repo",
          targetBranch: "main",
          basePath: "solutions-lc",
          duplicatePolicy: "skip",
          authorizationStatus: "AUTHORIZED",
        });
      }
      if (candidate.platform === "codechef") {
        return Object.freeze({
          targetRepository: "octocat/codechef-repo",
          targetBranch: "main",
          basePath: "solutions-cc",
          duplicatePolicy: "skip",
          authorizationStatus: "AUTHORIZED",
        });
      }
      return Object.freeze({
        targetRepository: "octocat/codeforces-repo",
        targetBranch: "main",
        basePath: "solutions-cf",
        duplicatePolicy: "skip",
        authorizationStatus: "AUTHORIZED",
      });
    };

    // Instantiate submission handler with the target snapshot supplier
    const customSubmissionHandler = new SubmissionHandler(
      harness.validator,
      createDefaultRegistry(),
      {
        queueManager: harness.queueManager,
        storage: harness.storage,
        targetSnapshotSupplier,
      },
    );

    // 2. Build 3 submissions from LeetCode, CodeChef, Codeforces with identical source code
    const subLC: CanonicalSubmissionCandidate = {
      platform: "leetcode",
      problemId: "add-two-integers",
      problemSlug: "add-two-integers",
      problemTitle: "Add Two Integers",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: sharedSource,
      contentHash: sharedHash,
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/add-two-integers/",
      problemUrl: "https://leetcode.com/problems/add-two-integers/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.95,
      extractionLayer: "dom",
      submissionId: "lc-sub-101",
    };
    const senderLC = {
      tab: { id: 101, url: "https://leetcode.com/problems/add-two-integers/" },
    };

    const subCC: CanonicalSubmissionCandidate = {
      platform: "codechef",
      problemId: "FLOW001",
      problemSlug: "add-two-numbers",
      problemTitle: "Add Two Numbers",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: sharedSource,
      contentHash: sharedHash,
      submittedAt: Date.now(),
      sourceUrl: "https://www.codechef.com/viewsolution/88202",
      problemUrl: "https://www.codechef.com/problems/FLOW001",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.95,
      extractionLayer: "dom",
      submissionId: "cc-sub-202",
    };
    const senderCC = {
      tab: { id: 102, url: "https://www.codechef.com/problems/FLOW001" },
    };

    const subCF: CanonicalSubmissionCandidate = {
      platform: "codeforces",
      problemId: "1-A",
      problemSlug: "theatre-square",
      problemTitle: "Theatre Square",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: sharedSource,
      contentHash: sharedHash,
      submittedAt: Date.now(),
      sourceUrl: "https://codeforces.com/contest/1/problem/A",
      problemUrl: "https://codeforces.com/contest/1/problem/A",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.95,
      extractionLayer: "dom",
      submissionId: "cf-sub-303",
      platformMetadata: { contestId: "1", index: "A" },
    };
    const senderCF = {
      tab: { id: 103, url: "https://codeforces.com/contest/1/problem/A" },
    };

    // 3. Enqueue all 3 submissions
    const resLC = await customSubmissionHandler.handleMessageAndEnqueue(
      createExtensionMessage(subLC),
      senderLC,
    );
    const resCC = await customSubmissionHandler.handleMessageAndEnqueue(
      createExtensionMessage(subCC),
      senderCC,
    );
    const resCF = await customSubmissionHandler.handleMessageAndEnqueue(
      createExtensionMessage(subCF),
      senderCF,
    );

    expect(resLC.success).toBe(true);
    expect(resCC.success).toBe(true);
    expect(resCF.success).toBe(true);

    const idLC = resLC.queueItem!.id;
    const idCC = resCC.queueItem!.id;
    const idCF = resCF.queueItem!.id;

    // Required Assertions:
    // 1. Three distinct queue items exist
    const distinctIds = new Set([idLC, idCC, idCF]);
    expect(distinctIds.size).toBe(3);

    const queueBefore = await harness.getDurableQueue();
    expect(queueBefore).toHaveLength(3);

    // 2. The submissions are NOT deduplicated solely because contentHash is equal
    for (const item of queueBefore) {
      expect(item.contentHash).toBe(sharedHash);
      expect(item.state).toBe(QueueState.PENDING);
    }
    expect(queueBefore.map((i) => i.platform)).toEqual([
      "leetcode",
      "codechef",
      "codeforces",
    ]);

    // 3. All three drain successfully
    const summary = await harness.queueDrainer.drain("submission_event");
    expect(summary?.processed).toBe(3);
    expect(summary?.completed).toBe(3);
    expect(summary?.failed).toBe(0);
    expect(summary?.skipped).toBe(0);
    expect(summary?.quarantined).toBe(0);

    // 4. Exactly three intended remote writes occur
    expect(harness.mockGitHubServer.getPutCount()).toBe(3);

    // 5. Each write goes to the correct target repository/path
    const pathLC = "solutions-lc/leetcode/add-two-integers.cpp";
    const pathCC = "solutions-cc/codechef/add-two-numbers.cpp";
    const pathCF = "solutions-cf/codeforces/theatre-square.cpp";

    expect(harness.mockGitHubServer.hasFile(pathLC)).toBe(true);
    expect(harness.mockGitHubServer.hasFile(pathCC)).toBe(true);
    expect(harness.mockGitHubServer.hasFile(pathCF)).toBe(true);

    const recordedPuts = harness.mockGitHubServer
      .getRecordedRequests()
      .filter((r) => r.method === "PUT");
    expect(recordedPuts).toHaveLength(3);

    const putUrls = recordedPuts.map((r) => r.url);
    expect(
      putUrls.some(
        (url) =>
          url.includes("octocat/leetcode-repo") &&
          url.includes("add-two-integers.cpp"),
      ),
    ).toBe(true);
    expect(
      putUrls.some(
        (url) =>
          url.includes("octocat/codechef-repo") &&
          url.includes("add-two-numbers.cpp"),
      ),
    ).toBe(true);
    expect(
      putUrls.some(
        (url) =>
          url.includes("octocat/codeforces-repo") &&
          url.includes("theatre-square.cpp"),
      ),
    ).toBe(true);

    // 6. No submission overwrites another submission's target (all 3 files present with intended content)
    expect(harness.mockGitHubServer.getFile(pathLC)?.contentHash).toBe(
      sharedHash,
    );
    expect(harness.mockGitHubServer.getFile(pathCC)?.contentHash).toBe(
      sharedHash,
    );
    expect(harness.mockGitHubServer.getFile(pathCF)?.contentHash).toBe(
      sharedHash,
    );

    // 7. Submission identity remains distinct from content identity
    const queueAfter = await harness.getDurableQueue();
    expect(queueAfter).toHaveLength(3);
    for (const item of queueAfter) {
      expect(item.state).toBe(QueueState.COMPLETED);
      expect(item.commitSha).toBeDefined();
    }
    expect(queueAfter.map((i) => i.submissionId)).toEqual([
      "lc-sub-101",
      "cc-sub-202",
      "cf-sub-303",
    ]);

    // 8. Queue history records remain correctly associated with their submissions
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(3);

    const histLC = history.find((h) => h.submissionId === idLC);
    expect(histLC).toBeDefined();
    expect(histLC?.platform).toBe("leetcode");
    expect(histLC?.problemSlug).toBe("add-two-integers");
    expect(histLC?.targetRepository).toBe("octocat/leetcode-repo");
    expect(histLC?.status).toBe("synced");

    const histCC = history.find((h) => h.submissionId === idCC);
    expect(histCC).toBeDefined();
    expect(histCC?.platform).toBe("codechef");
    expect(histCC?.problemSlug).toBe("add-two-numbers");
    expect(histCC?.targetRepository).toBe("octocat/codechef-repo");
    expect(histCC?.status).toBe("synced");

    const histCF = history.find((h) => h.submissionId === idCF);
    expect(histCF).toBeDefined();
    expect(histCF?.platform).toBe("codeforces");
    expect(histCF?.problemSlug).toBe("theatre-square");
    expect(histCF?.targetRepository).toBe("octocat/codeforces-repo");
    expect(histCF?.status).toBe("synced");
  });
});
