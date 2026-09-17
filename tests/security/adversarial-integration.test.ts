import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createE2EHarness,
  createExtensionMessage,
  type E2EHarness,
} from "../helpers/e2e-harness";
import {
  buildCandidateSubmission,
  createCrashTestEnvironment,
} from "../helpers/crash-harness";
import {
  SubmissionHandler,
  createDefaultRegistry,
  type CanonicalSubmissionCandidate,
} from "../../src/shared/adapters";
import { QueueState } from "../../src/shared/storage/types";
import { ErrorCode, StaleLeaseError } from "../../src/shared/errors";
import {
  computeContentHash,
  normalizeSourceCode,
} from "../../src/shared/deduplication";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import type { RuntimeSenderInfo } from "../../src/shared/messaging/types";

describe("Phase 1C.4.3.5.1 — Targeted Adversarial Integration Tests", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = createE2EHarness();
    await harness.seedDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // SEC-INT-01: End-to-End Adversarial Message Spoofing Rejection
  // ==========================================================================
  it("SEC-INT-01: End-to-End Adversarial Message Spoofing Rejection rejects spoofed origins and contexts fail-closed", async () => {
    // 0. Seed an unrelated legitimate queue item to prove isolation & non-interference
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
    const unrelatedRes = await harness.dispatchBackgroundMessage(
      unrelatedMsg,
      unrelatedSender,
    );
    expect(unrelatedRes.enqueueResult.success).toBe(true);
    const unrelatedQueueItem = unrelatedRes.enqueueResult.queueItem;
    expect(unrelatedQueueItem).toBeDefined();
    const initialQueue = await harness.getDurableQueue();
    expect(initialQueue).toHaveLength(1);
    const initialWalCount = (await harness.getDurableWalEntries()).length;
    const initialPayloadCount = (await harness.getDurablePayloads()).length;
    const initialRequests = harness.mockGitHubServer.getRequestTrace().length;

    // Snapshot configuration state before attacks
    const configBefore = await harness.storage.get(STORAGE_KEYS.CONFIG);

    // ------------------------------------------------------------------------
    // ATTACK SCENARIO A: Spoofed Origin
    // Candidate claims platform "leetcode", but runtime sender tab URL is hostile
    // ------------------------------------------------------------------------
    const { candidate: candA } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      submissionId: "hostile-origin-sub-001",
      sourceCode: "int main() { return 0; }\n",
    });
    const msgA = createExtensionMessage(candA);
    const maliciousSenderA: RuntimeSenderInfo = {
      tab: {
        id: 999,
        url: "https://evil-attacker.com/problems/two-sum",
      },
    };

    const resA = await harness.dispatchBackgroundMessage(
      msgA,
      maliciousSenderA,
    );

    // 1. Message rejected fail-closed
    expect(resA.enqueueResult.success).toBe(false);
    expect(resA.enqueueResult.error).toContain("Spoofed submission origin");
    // 6. No drain operation triggered
    expect(resA.drainSummary).toBeNull();

    // ------------------------------------------------------------------------
    // ATTACK SCENARIO B: Forged Sender Context
    // Body claims senderContext: "popup", but actual runtime sender has a tab
    // ------------------------------------------------------------------------
    const { candidate: candB } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      submissionId: "hostile-context-sub-002",
      sourceCode: "int main() { return 0; }\n",
    });
    const msgB = {
      ...createExtensionMessage(candB),
      senderContext: "popup" as const,
    };
    const senderB: RuntimeSenderInfo = {
      tab: {
        id: 100,
        url: "https://leetcode.com/problems/two-sum/",
      },
    };

    const resB = await harness.dispatchBackgroundMessage(msgB, senderB);

    // 1. Message rejected fail-closed
    expect(resB.enqueueResult.success).toBe(false);
    expect(resB.enqueueResult.error).toContain("Spoofed senderContext");
    // 6. No drain operation triggered
    expect(resB.drainSummary).toBeNull();

    // ------------------------------------------------------------------------
    // VERIFY SYSTEM INVARIANTS AFTER BOTH ATTACKS
    // ------------------------------------------------------------------------
    // 3. No queue item created (queue length remains strictly 1 from unrelated item)
    const queueAfter = await harness.getDurableQueue();
    expect(queueAfter).toHaveLength(1);

    // 9. Unrelated existing queue item is completely unmodified
    expect(queueAfter[0]!.id).toBe(unrelatedQueueItem!.id);
    expect(queueAfter[0]!.platform).toBe("leetcode");
    expect(queueAfter[0]!.problemSlug).toBe("reverse-string");
    expect(queueAfter[0]!.submissionId).toBe("unrelated-sub-001");

    // 4. No residual WAL INTENT records created
    const walAfter = await harness.getDurableWalEntries();
    expect(walAfter).toHaveLength(initialWalCount);

    // 5. No payload created for hostile messages
    const payloadsAfter = await harness.getDurablePayloads();
    expect(payloadsAfter).toHaveLength(initialPayloadCount);

    // 7. No GitHub requests occurred from hostile attempts
    expect(harness.mockGitHubServer.getRequestTrace().length).toBe(
      initialRequests,
    );

    // 8. No configuration mutation occurred
    const configAfter = await harness.storage.get(STORAGE_KEYS.CONFIG);
    expect(configAfter).toEqual(configBefore);

    // 10. No sync-history record created for hostile messages
    const historyAfter = await harness.getDurableHistory();
    // Only at most the unrelated item if drained, but no entries for hostile-origin or hostile-context
    expect(
      historyAfter.find((h) => h.problemSlug === "two-sum"),
    ).toBeUndefined();
  });

  // ==========================================================================
  // SEC-INT-02: Post-Enqueue Payload Tampering Interception
  // ==========================================================================
  it("SEC-INT-02: Post-Enqueue Payload Tampering Interception isolates tampered payload before GitHub boundary", async () => {
    // 1. Create a valid canonical submission
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      sourceCode: "int twoSum() { return 42; }\n",
    });
    const msg = createExtensionMessage(candidate);

    // 2. Enqueue through real submission -> queue path
    const enqueueRes = await harness.submissionHandler.handleMessageAndEnqueue(
      msg,
      sender,
    );
    expect(enqueueRes.success).toBe(true);
    const item = enqueueRes.queueItem;
    expect(item).toBeDefined();

    // 3. Confirm it is PENDING
    expect(item!.state).toBe(QueueState.PENDING);

    // 4. Record original authoritative contentHash X
    const originalHashX = item!.contentHash;
    expect(originalHashX).toBeDefined();

    // 5. Identify durable payload record
    const payloadId = item!.payloadId;
    const initialPayload = await harness.payloadStorage.getPayload(payloadId);
    expect(initialPayload).toBeDefined();

    // 6. Mutate persisted payload in IndexedDB with hostile content
    const hostileSourceCode =
      "/* INJECTED HOSTILE CONTENT */\nprocess.exit(1);\n";
    const normalizedHostile = normalizeSourceCode(hostileSourceCode);
    const hostileHashY = await computeContentHash(normalizedHostile);

    // 7. Confirm mutated source produces Y !== X
    expect(hostileHashY).not.toBe(originalHashX);

    await harness.payloadStorage.putPayload({
      id: payloadId,
      sourceCode: hostileSourceCode,
      createdAt: Date.now(),
    });

    // Verify metadata still holds original hash X (metadata not altered)
    const queueBeforeDrain = await harness.getDurableQueue();
    expect(queueBeforeDrain[0]!.contentHash).toBe(originalHashX);

    // Clear any previous mock requests before drain
    harness.mockGitHubServer.reset();

    // 8. Execute real QueueDrainer drain pass
    const drainSummary = await harness.queueDrainer.drain("submission_event");

    // 9. Assertions:
    // Quarantined immediately, zero completed, zero failed retries
    expect(drainSummary).not.toBeNull();
    expect(drainSummary?.quarantined).toBe(1);
    expect(drainSummary?.completed).toBe(0);
    expect(drainSummary?.failed).toBe(0);

    const queueAfterDrain = await harness.getDurableQueue();
    expect(queueAfterDrain).toHaveLength(1);
    const updatedItem = queueAfterDrain[0]!;

    // Expected queue state: REQUIRES_ATTENTION
    expect(updatedItem.state).toBe(QueueState.REQUIRES_ATTENTION);

    // Expected error: INVARIANT_VIOLATION
    expect(updatedItem.lastError?.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(updatedItem.lastError?.message).toContain(
      "Integrity failure: Recalculated source payload hash does not match persisted queue metadata hash.",
    );

    // Expected attempts: 0 (integrity failure is terminal, not retried)
    expect(updatedItem.attempts).toBe(0);

    // Zero GitHub requests (integrity check happens strictly before GitHub boundary)
    expect(harness.mockGitHubServer.getRequestTrace()).toHaveLength(0);
    expect(harness.mockGitHubServer.getPutCount()).toBe(0);

    // Zero sync-history records created
    const history = await harness.getDurableHistory();
    expect(history).toHaveLength(0);
  });

  // ==========================================================================
  // SEC-INT-03: Target Authorization Revocation at Drain Execution
  // ==========================================================================
  it("SEC-INT-03: Target Authorization Revocation at Drain Execution halts fail-closed with GITHUB_FORBIDDEN", async () => {
    // 1. Re-initialize harness configured specifically for target octocat/private-repo
    const privateTargetRepo = "octocat/private-repo";
    const targetBranch = "main";

    const customHarness = createE2EHarness({
      targetRepository: privateTargetRepo,
      targetBranch,
    });
    await customHarness.seedDefaults({
      targetRepository: privateTargetRepo,
      targetBranch,
    });

    // 2. Enqueue a valid submission targeting octocat/private-repo
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "median-two-sorted-arrays",
      problemSlug: "median-two-sorted-arrays",
      sourceCode: "double findMedianSortedArrays() { return 2.0; }\n",
    });
    const msg = createExtensionMessage(candidate);
    const enqueueRes =
      await customHarness.submissionHandler.handleMessageAndEnqueue(
        msg,
        sender,
      );
    expect(enqueueRes.success).toBe(true);
    const item = enqueueRes.queueItem!;
    expect(item.state).toBe(QueueState.PENDING);

    // Verify immutable TargetSnapshot captured at enqueue time
    expect(item.targetSnapshot?.targetRepository).toBe(privateTargetRepo);
    expect(item.targetSnapshot?.targetBranch).toBe(targetBranch);

    // 3. Configure mock GitHub server to return HTTP 403 Forbidden
    // simulating push permissions being revoked on GitHub between enqueue and drain
    customHarness.mockGitHubServer.reset();
    customHarness.mockGitHubServer.configureAuthFailure({
      status: 403,
      maxTimes: 1,
    });

    // Snapshot extension config before drain
    const configBefore = await customHarness.storage.get(STORAGE_KEYS.CONFIG);

    // 4. Execute real QueueDrainer drain pass through full pipeline
    const drainSummary =
      await customHarness.queueDrainer.drain("submission_event");

    // 5. Assertions:
    expect(drainSummary).not.toBeNull();
    expect(drainSummary?.quarantined).toBe(1);
    expect(drainSummary?.completed).toBe(0);
    expect(drainSummary?.failed).toBe(0);

    const queueAfter = await customHarness.getDurableQueue();
    expect(queueAfter).toHaveLength(1);
    const updatedItem = queueAfter[0]!;

    // 1 & 2 & 3. Exactly one repository GET occurred, returned 403, classified as GITHUB_FORBIDDEN
    const recordedRequests =
      customHarness.mockGitHubServer.getRecordedRequests();
    const getRequests = recordedRequests.filter((r) => r.method === "GET");
    expect(getRequests).toHaveLength(1);
    expect(getRequests[0]!.url).toContain(`/repos/${privateTargetRepo}`);
    expect(getRequests[0]!.status).toBe(403);

    // 4. Item became REQUIRES_ATTENTION
    expect(updatedItem.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(updatedItem.lastError?.code).toBe(ErrorCode.GITHUB_FORBIDDEN);

    // 5. attempts remains 0 (authorization denial is terminal, not retried)
    expect(updatedItem.attempts).toBe(0);

    // 6. No retry is scheduled
    expect(updatedItem.nextRetryAt).toBeUndefined();

    // 7 & 8 & 9. No fallback repository, branch, or credentials selected
    // 10. TargetSnapshot remains unchanged
    expect(updatedItem.targetSnapshot?.targetRepository).toBe(
      privateTargetRepo,
    );
    expect(updatedItem.targetSnapshot?.targetBranch).toBe(targetBranch);

    // 11. Exactly zero PUT requests occurred
    expect(customHarness.mockGitHubServer.getPutCount()).toBe(0);

    // 12. No remote file created
    expect(customHarness.mockGitHubServer.getAllFiles().size).toBe(0);

    // 13. No successful sync-history entry recorded
    const history = await customHarness.getDurableHistory();
    expect(history).toHaveLength(0);

    // 14. No configuration mutation occurred in storage (no fallback)
    const configAfter = await customHarness.storage.get(STORAGE_KEYS.CONFIG);
    expect(configAfter).toEqual(configBefore);
  });

  // ==========================================================================
  // SEC-INT-04: End-to-End Path Traversal & DOS Device Rejection
  // ==========================================================================
  it("SEC-INT-04: End-to-End Path Traversal & DOS Device Rejection stops traversal and reserved names fail-closed", async () => {
    // ------------------------------------------------------------------------
    // ATTACK A — Directory Traversal in Ingestion Slug
    // ------------------------------------------------------------------------
    const maliciousSlug = "../../etc/passwd";
    const candidateA: CanonicalSubmissionCandidate = {
      platform: "leetcode",
      problemId: "traversal-attack",
      problemSlug: maliciousSlug,
      problemTitle: "Path Traversal Attack",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: "int main() { return 0; }\n",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/traversal-attack/",
      problemUrl: "https://leetcode.com/problems/traversal-attack/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 1.0,
      extractionLayer: "dom",
    };
    const msgA = createExtensionMessage(candidateA);
    const senderA: RuntimeSenderInfo = {
      tab: {
        id: 1,
        url: "https://leetcode.com/problems/traversal-attack/",
      },
    };

    let enqueueErrorA = "";
    try {
      const resA = await harness.submissionHandler.handleMessageAndEnqueue(
        msgA,
        senderA,
      );
      if (!resA.success) enqueueErrorA = resA.error ?? "";
    } catch (err) {
      enqueueErrorA = (err as Error).message;
    }

    // Expected: Rejection before enqueue due to safe slug grammar validation
    expect(enqueueErrorA).toMatch(/safe slug grammar/i);

    // Required: No queue item, no WAL, no payload, no GitHub requests
    expect(await harness.getDurableQueue()).toHaveLength(0);
    expect(await harness.getDurableWalEntries()).toHaveLength(0);
    expect(await harness.getDurablePayloads()).toHaveLength(0);
    expect(harness.mockGitHubServer.getRequestTrace()).toHaveLength(0);

    // ------------------------------------------------------------------------
    // ATTACK B — Reserved DOS Device Name via Path Template during Drain
    // ------------------------------------------------------------------------
    // Create submission handler whose TargetSnapshot supplier resolves to a DOS device name CON.cpp
    const customSnapshotHandler = new SubmissionHandler(
      harness.validator,
      createDefaultRegistry(),
      {
        queueManager: harness.queueManager,
        storage: harness.storage,
        targetSnapshotSupplier: async () => ({
          targetRepository: "octocat/dsa-repo",
          targetBranch: "main",
          basePath: "solutions",
          duplicatePolicy: "skip",
          pathTemplate: "{platform}/CON.{extension}",
          authorizationStatus: "AUTHORIZED",
        }),
      },
    );

    const { candidate: candB, sender: senderB } =
      await buildCandidateSubmission({
        platform: "leetcode",
        problemId: "safe-problem",
        problemSlug: "safe-problem",
        sourceCode: "int main() { return 1; }\n",
      });
    const msgB = createExtensionMessage(candB);

    const resB = await customSnapshotHandler.handleMessageAndEnqueue(
      msgB,
      senderB,
    );
    expect(resB.success).toBe(true);
    expect(resB.queueItem?.state).toBe(QueueState.PENDING);

    // Execute real QueueDrainer path through GitHubQueueSyncHandler
    const drainSummary = await harness.queueDrainer.drain("submission_event");

    // Expected: Item quarantined into REQUIRES_ATTENTION with PATH_RESERVED_NAME
    expect(drainSummary).not.toBeNull();
    expect(drainSummary?.quarantined).toBe(1);
    expect(drainSummary?.completed).toBe(0);
    expect(drainSummary?.failed).toBe(0);

    const queueAfter = await harness.getDurableQueue();
    expect(queueAfter).toHaveLength(1);
    const itemB = queueAfter[0]!;

    expect(itemB.state).toBe(QueueState.REQUIRES_ATTENTION);
    expect(itemB.lastError?.code).toBe(ErrorCode.PATH_RESERVED_NAME);
    expect(itemB.lastError?.message).toContain(
      "collides with reserved DOS device name",
    );

    // Required: Zero GitHub requests, zero PUT requests, zero unauthorized files
    expect(harness.mockGitHubServer.getRequestTrace()).toHaveLength(0);
    expect(harness.mockGitHubServer.getPutCount()).toBe(0);
    expect(harness.mockGitHubServer.getAllFiles().size).toBe(0);
    expect(await harness.getDurableHistory()).toHaveLength(0);
  });

  // ==========================================================================
  // SEC-INT-05: Stale Worker Fencing Race During Drain Execution
  // ==========================================================================
  it("SEC-INT-05: Stale Worker Fencing Race During Drain Execution rejects stale worker commit fail-closed", async () => {
    // Disable Web Locks so persistent lease fencing is the primary concurrency coordinator
    Object.defineProperty(globalThis.navigator, "locks", {
      value: undefined,
      configurable: true,
    });

    const env = createCrashTestEnvironment();
    await env.seedDefaults();

    const testStartTime = 1700000000000;
    let virtualTime = testStartTime;
    vi.spyOn(Date, "now").mockImplementation(() => virtualTime);

    // 1. Worker A boots and enqueues a valid submission in PENDING state
    const workerA = env.createWorker("Worker-A");
    const { candidate, sender } = await buildCandidateSubmission({
      platform: "leetcode",
      problemId: "fencing-race-problem",
      problemSlug: "fencing-race-slug",
      sourceCode: "int solveRace() { return 100; }\n",
    });
    const msg = createExtensionMessage(candidate);
    await workerA.submissionHandler.handleMessageAndEnqueue(msg, sender);

    const queueInitial = await env.getDurableQueue();
    expect(queueInitial).toHaveLength(1);
    expect(queueInitial[0]!.state).toBe(QueueState.PENDING);

    // 2. Controlled barrier: Pause Worker A inside the handler execution
    // Worker A will have dispatched its PUT, and will pause right before post-write verification GET
    let unpauseWorkerA!: () => void;
    const workerAPausePromise = new Promise<void>((resolve) => {
      unpauseWorkerA = resolve;
    });

    workerA.gitHubContentsService.onBeforeVerificationGet = async () => {
      await workerAPausePromise;
    };

    // 3. Launch Worker A drain pass asynchronously
    let workerAError: unknown = null;
    const workerAPromise = workerA.queueDrainer
      .drain("submission_event")
      .catch((err) => {
        workerAError = err;
        return null;
      });

    // Allow Worker A to claim item into PROCESSING under fence 1 and reach barrier
    await new Promise((r) => setTimeout(r, 20));

    // Confirm Worker A claimed the item into PROCESSING with fencingToken 1
    const queueDuringA = await env.getDurableQueue();
    expect(queueDuringA[0]!.state).toBe(QueueState.PROCESSING);
    expect(queueDuringA[0]!.fencingToken).toBe(1);

    // 4. Advance virtual time past lease TTL (30s) so Worker A's lease expires
    virtualTime += 35_000;

    // 5. Worker B boots while Worker A is suspended
    const workerB = env.createWorker("Worker-B");
    expect(workerB.queueManager).not.toBe(workerA.queueManager);

    // Worker B executes startup drain:
    // Acquires expired lease -> receives fencingToken 2 -> reconciles item -> syncs it
    const summaryB = await workerB.queueDrainer.drain("startup");
    expect(summaryB).not.toBeNull();
    // Worker B sees remote file already committed by Worker A's PUT, reconciles idempotently via skipped_identical
    expect(summaryB?.skipped).toBe(1);

    // Confirm Worker B committed the item as SKIPPED under fencingToken 2
    const queueAfterB = await env.getDurableQueue();
    expect(queueAfterB[0]!.state).toBe(QueueState.SKIPPED);
    expect(queueAfterB[0]!.fencingToken).toBe(2);

    const historyAfterB = await env.getDurableHistory();
    expect(historyAfterB).toHaveLength(1);
    expect(historyAfterB[0]!.status).toBe("skipped");

    // 6. Unpause Worker A: Worker A resumes and attempts post-handler completion mutation
    unpauseWorkerA();
    await workerAPromise;

    // 7. Assertions:
    // Worker A MUST have received StaleLeaseError
    expect(workerAError).toBeInstanceOf(StaleLeaseError);
    expect((workerAError as StaleLeaseError).message).toContain("is stale");

    // Worker A MUST NOT have overwritten Worker B's queue state
    const finalQueue = await env.getDurableQueue();
    expect(finalQueue[0]!.state).toBe(QueueState.SKIPPED);
    expect(finalQueue[0]!.fencingToken).toBe(2);

    // Worker A MUST NOT have appended duplicate history
    const finalHistory = await env.getDurableHistory();
    expect(finalHistory).toHaveLength(1);
    expect(finalHistory[0]!.status).toBe("skipped");

    // Worker A MUST NOT have performed an unauthorized duplicate write
    expect(env.mockGitHubServer.getPutCount()).toBe(1);
  });
});
