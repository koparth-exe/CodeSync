import {
  ErrorCode,
  GitHubApiError,
  GitHubConflictError,
  GitHubRateLimitError,
  GitHubWriteOutcomeUnknownError,
} from "../errors";

import { computeContentHash, normalizeSourceCode } from "../deduplication";
import {
  formatSafeCommitMessage,
  validateAndCanonicalizePath,
} from "./path-engine";
import {
  MAX_CONFLICT_REVALIDATIONS,
  MAX_KEEP_ALL_CANDIDATES,
  MAX_SOURCE_PAYLOAD_BYTES,
  normalizeDuplicatePolicy,
  type GitHubContentFile,
  type GitHubWriteOptions,
  type GitHubWriteResult,
  type VerificationStatus,
  type WriteDispatchStatus,
} from "./types";
import { GitHubApiClient, safeBase64Encode } from "./client";

export interface ContentsServiceOptions {
  readonly client: GitHubApiClient;
}

/**
 * Service orchestrating CodeSync's Validated Transactional Write Protocol with OCC.
 *
 * Enforces:
 * - Authoritative pre-flight repository and branch validation.
 * - Three-pillar path canonicalization and base-folder containment.
 * - 500 KB payload constraint and deterministic source normalization (LF line endings).
 * - Duplicate policies (REPLACE_IF_DIFFERENT, ALWAYS_REPLACE, CREATE_ONLY, KEEP_ALL).
 * - Optimistic Concurrency Control (OCC) requiring authoritative remote blob SHAs.
 * - Mandatory 8-Step 409 Conflict Protocol with max 2 revalidation passes.
 * - Uncertain write outcome reconciliation (WRITE_OUTCOME_UNKNOWN) on network disruptions.
 * - Post-write authoritative verification GET.
 * - Deterministic interleaving hooks for race condition verification.
 */
export class GitHubContentsService {
  private client: GitHubApiClient;

  // Interleaving hooks for deterministic race testing
  public onBeforePreFlightGet?: (() => Promise<void>) | undefined;
  public onBeforePut?: (() => Promise<void>) | undefined;
  public onBeforeConflictRevalidation?: (() => Promise<void>) | undefined;
  public onBeforeVerificationGet?: (() => Promise<void>) | undefined;

  constructor(options: ContentsServiceOptions) {
    this.client = options.client;
  }

  /**
   * Executes the full 12-step validated transactional write protocol.
   */
  async synchronizeFile(
    options: GitHubWriteOptions,
  ): Promise<GitHubWriteResult> {
    const {
      owner,
      repo,
      branch,
      path: rawPath,
      content: rawContent,
      commitMessage: rawCommitMessage,
      duplicatePolicy: rawPolicy,
      baseFolder,
    } = options;

    const policy = normalizeDuplicatePolicy(rawPolicy);

    // ------------------------------------------------------------------------
    // STEP 1 & 2: Authoritative Repository & Branch Validation
    // ------------------------------------------------------------------------
    const repository = await this.client.getRepository(owner, repo);
    if (!repository.id) {
      throw new GitHubApiError(
        `Authoritative repository validation failed for "${owner}/${repo}".`,
        { code: ErrorCode.GITHUB_REPOSITORY_NOT_FOUND },
      );
    }

    const branchState = await this.client.getBranch(owner, repo, branch);
    if (!branchState.name) {
      throw new GitHubApiError(
        `Authoritative branch validation failed for "${branch}" in "${owner}/${repo}".`,
        { code: ErrorCode.GITHUB_BRANCH_NOT_FOUND },
      );
    }

    // ------------------------------------------------------------------------
    // STEP 3: Path Canonicalization & Repository Boundary Verification
    // ------------------------------------------------------------------------
    let targetPath = validateAndCanonicalizePath(rawPath, baseFolder);

    // ------------------------------------------------------------------------
    // STEP 4: Content Size & Deterministic Normalization
    // ------------------------------------------------------------------------
    const normalizedCode = normalizeSourceCode(rawContent);
    const codeBytes = new TextEncoder().encode(normalizedCode).length;

    if (codeBytes > MAX_SOURCE_PAYLOAD_BYTES) {
      throw new GitHubApiError(
        `Source code payload size (${codeBytes} bytes) exceeds maximum allowed limit of ${MAX_SOURCE_PAYLOAD_BYTES} bytes.`,
        { code: ErrorCode.GITHUB_PAYLOAD_TOO_LARGE },
      );
    }

    const localContentHash = await computeContentHash(normalizedCode);

    // ------------------------------------------------------------------------
    // STEP 5: Safe Commit Message Formatting
    // ------------------------------------------------------------------------
    const commitMessage = formatSafeCommitMessage(rawCommitMessage);

    // ------------------------------------------------------------------------
    // STEP 6: Pre-flight Remote State Check (Authoritative GET)
    // ------------------------------------------------------------------------
    if (this.onBeforePreFlightGet) {
      await this.onBeforePreFlightGet();
    }

    let remoteFile: GitHubContentFile | null = null;

    // Handle KEEP_ALL policy: find the next available versioned filename
    if (policy === "KEEP_ALL") {
      targetPath = await this.resolveKeepAllPath(
        owner,
        repo,
        branch,
        targetPath,
      );
      remoteFile = await this.client.getFileContents(
        owner,
        repo,
        targetPath,
        branch,
      );
    } else {
      remoteFile = await this.client.getFileContents(
        owner,
        repo,
        targetPath,
        branch,
      );
    }

    // ------------------------------------------------------------------------
    // STEP 7: Duplicate Policy Evaluation
    // ------------------------------------------------------------------------
    if (remoteFile) {
      // If remote content hash equals local content hash
      if (
        policy === "REPLACE_IF_DIFFERENT" &&
        remoteFile.contentHash &&
        remoteFile.contentHash.toLowerCase() === localContentHash.toLowerCase()
      ) {
        return {
          status: "skipped_identical",
          path: targetPath,
          contentHash: localContentHash,
          fileSha: remoteFile.sha,
          revalidationCount: 0,
        };
      }

      // If CREATE_ONLY and file already exists
      if (policy === "CREATE_ONLY") {
        return {
          status: "skipped_exists",
          path: targetPath,
          contentHash: localContentHash,
          fileSha: remoteFile.sha,
          revalidationCount: 0,
        };
      }
    }

    // ------------------------------------------------------------------------
    // STEP 8: Execute Optimistic File Write (PUT Contents)
    // ------------------------------------------------------------------------
    const base64Content = safeBase64Encode(normalizedCode);
    let currentSha = remoteFile?.sha;
    let revalidationCount = 0;

    while (revalidationCount <= MAX_CONFLICT_REVALIDATIONS) {
      if (this.onBeforePut) {
        await this.onBeforePut();
      }

      const dispatchedAt = Date.now();
      try {
        const writeResponse = await this.client.createOrUpdateFile(
          owner,
          repo,
          targetPath,
          {
            message: commitMessage,
            content: base64Content,
            branch,
            sha: currentSha,
          },
        );

        const dispatchStatus: WriteDispatchStatus = "succeeded";

        // --------------------------------------------------------------------
        // STEP 10: Post-Write Authoritative Verification GET
        //
        // Phase 1C.2.1 C4.1: Three-way verification outcome
        // - CONFIRMED: remote matches intended content hash
        // - MISMATCH: remote exists but hash differs (third-party overwrite)
        // - UNKNOWN: verification GET itself failed (network error/timeout)
        //
        // WRITE DISPATCH SUCCESS != OVERALL OPERATION SUCCESS
        // When verificationStatus is UNKNOWN, the overall operation must NOT be
        // considered successful. It transitions to requires_attention with
        // attentionReason: GITHUB_RECONCILIATION_REQUIRED, preserving PUT commit
        // and file SHAs for safe later reconciliation. ZERO blind PUTs are issued.
        // --------------------------------------------------------------------
        if (this.onBeforeVerificationGet) {
          await this.onBeforeVerificationGet();
        }

        let verificationStatus: VerificationStatus;
        try {
          const verified = await this.client.getFileContents(
            owner,
            repo,
            targetPath,
            branch,
          );

          if (
            verified &&
            verified.contentHash &&
            verified.contentHash.toLowerCase() ===
              localContentHash.toLowerCase()
          ) {
            verificationStatus = "CONFIRMED";
          } else {
            verificationStatus = "MISMATCH";
          }
        } catch {
          // Verification GET itself failed — outcome is uncertain
          verificationStatus = "UNKNOWN";
        }

        if (verificationStatus === "MISMATCH") {
          return {
            status: "requires_attention",
            path: targetPath,
            contentHash: localContentHash,
            revalidationCount,
            attentionReason: "GITHUB_VERIFICATION_FAILED",
            verificationStatus,
            dispatchStatus,
            commitSha: writeResponse.commit.sha,
            fileSha: writeResponse.content.sha,
            isUpdate: Boolean(currentSha),
          };
        }

        if (verificationStatus === "UNKNOWN") {
          return {
            status: "requires_attention",
            path: targetPath,
            contentHash: localContentHash,
            revalidationCount,
            attentionReason: "GITHUB_RECONCILIATION_REQUIRED",
            verificationStatus,
            dispatchStatus,
            commitSha: writeResponse.commit.sha,
            fileSha: writeResponse.content.sha,
            isUpdate: Boolean(currentSha),
          };
        }

        return {
          status: currentSha ? "updated" : "created",
          commitSha: writeResponse.commit.sha,
          fileSha: writeResponse.content.sha,
          path: targetPath,
          contentHash: localContentHash,
          revalidationCount,
          verificationStatus,
          dispatchStatus,
          isUpdate: Boolean(currentSha),
        };
      } catch (err) {
        // --------------------------------------------------------------------
        // STEP 9: 409 Conflict Protocol
        // --------------------------------------------------------------------
        if (err instanceof GitHubConflictError) {
          revalidationCount++;

          if (revalidationCount > MAX_CONFLICT_REVALIDATIONS) {
            // Max conflict revalidations exceeded -> escalate safely to attention required
            return {
              status: "requires_attention",
              path: targetPath,
              contentHash: localContentHash,
              revalidationCount,
              attentionReason: "GITHUB_CONFLICT",
            };
          }

          if (this.onBeforeConflictRevalidation) {
            await this.onBeforeConflictRevalidation();
          }

          // Fresh authoritative GET bypassing local cache
          const freshRemote = await this.client.getFileContents(
            owner,
            repo,
            targetPath,
            branch,
          );

          if (!freshRemote) {
            // Unexpected: 409 conflict but file is now absent -> retry create with undefined SHA
            currentSha = undefined;
            continue;
          }

          // Re-evaluate duplicate policy with fresh remote content
          if (
            policy === "REPLACE_IF_DIFFERENT" &&
            freshRemote.contentHash &&
            freshRemote.contentHash.toLowerCase() ===
              localContentHash.toLowerCase()
          ) {
            return {
              status: "skipped_identical",
              path: targetPath,
              contentHash: localContentHash,
              fileSha: freshRemote.sha,
              revalidationCount,
            };
          }

          if (policy === "CREATE_ONLY") {
            return {
              status: "skipped_exists",
              path: targetPath,
              contentHash: localContentHash,
              fileSha: freshRemote.sha,
              revalidationCount,
            };
          }

          // Update currentSha to newly obtained authoritative remote blob SHA and loop
          currentSha = freshRemote.sha;
          continue;
        }

        // --------------------------------------------------------------------
        // Explicit Rate-Limit Handling (HTTP 429 / 403 secondary)
        // --------------------------------------------------------------------
        // If the error is an explicit HTTP rate limit, the outcome is authoritatively
        // known: the write was rejected and did NOT commit. Bubble immediately so
        // QueueManager can schedule a retry with the server-dictated Retry-After delay.
        // MUST NOT be treated as an uncertain write outcome or trigger reconciliation.
        if (err instanceof GitHubRateLimitError) {
          throw err;
        }

        // --------------------------------------------------------------------
        // STEP 11: Uncertain Write Outcome Handling (Network Drop / Timeout)
        // --------------------------------------------------------------------
        if (
          err instanceof GitHubApiError &&
          (err.isRetryable ||
            err.message.includes("timed out") ||
            err.message.includes("Network failure"))
        ) {
          // Reconcile before assuming write failed
          const reconciled = await this.reconcileUncertainWrite(
            owner,
            repo,
            branch,
            targetPath,
            localContentHash,
          );

          if (reconciled) {
            return {
              status: currentSha ? "updated" : "created",
              path: targetPath,
              contentHash: localContentHash,
              fileSha: reconciled.sha,
              revalidationCount,
              verificationStatus: "CONFIRMED",
              dispatchStatus: "uncertain",
            };
          }

          // If reconciliation shows write did not occur, throw uncertain write outcome error
          throw new GitHubWriteOutcomeUnknownError(
            `Write outcome uncertain for "${targetPath}". Network disrupted during dispatch. Reconciliation established write did not commit.`,
            {
              path: targetPath,
              intendedContentHash: localContentHash,
              dispatchedAt,
              endpoint: `${owner}/${repo}/contents/${targetPath}`,
            },
          );
        }

        // Any other non-conflict fatal error: fail closed
        throw err;
      }
    }

    return {
      status: "requires_attention",
      path: targetPath,
      contentHash: localContentHash,
      revalidationCount,
      attentionReason: "GITHUB_CONFLICT",
    };
  }

  /**
   * Reconciles uncertain write outcomes by performing a fresh authoritative GET
   * and comparing the remote content hash with the intended local content hash.
   */
  async reconcileUncertainWrite(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    expectedHash: string,
  ): Promise<GitHubContentFile | null> {
    try {
      const remote = await this.client.getFileContents(
        owner,
        repo,
        path,
        branch,
      );

      if (
        remote &&
        remote.contentHash &&
        remote.contentHash.toLowerCase() === expectedHash.toLowerCase()
      ) {
        // Intended write committed successfully despite network failure
        return remote;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Authoritatively reconciles a prior write whose post-write verification was UNKNOWN.
   *
   * Performs an authoritative GET (bypassing cache). Performs ZERO additional PUTs.
   *
   * - If remote content matches expectedHash:
   *     verification = CONFIRMED, overall operation = safely complete ("created" or "updated")
   * - If remote content differs:
   *     verification = MISMATCH, overall operation = requires attention ("GITHUB_VERIFICATION_FAILED")
   * - If reconciliation GET itself fails / times out:
   *     verification = UNKNOWN, overall operation = requires attention / unresolved ("GITHUB_RECONCILIATION_REQUIRED")
   */
  async reconcileVerification(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    expectedHash: string,
    previousResult?: Partial<GitHubWriteResult> | undefined,
  ): Promise<GitHubWriteResult> {
    try {
      const remote = await this.client.getFileContents(
        owner,
        repo,
        path,
        branch,
      );

      if (
        remote &&
        remote.contentHash &&
        remote.contentHash.toLowerCase() === expectedHash.toLowerCase()
      ) {
        return {
          status: previousResult?.isUpdate ? "updated" : "created",
          commitSha: previousResult?.commitSha,
          fileSha: remote.sha,
          path,
          contentHash: expectedHash,
          revalidationCount: previousResult?.revalidationCount ?? 0,
          verificationStatus: "CONFIRMED",
          dispatchStatus: "succeeded",
          isUpdate: previousResult?.isUpdate ?? false,
        };
      }

      return {
        status: "requires_attention",
        path,
        contentHash: expectedHash,
        fileSha: remote?.sha,
        revalidationCount: previousResult?.revalidationCount ?? 0,
        attentionReason: "GITHUB_VERIFICATION_FAILED",
        verificationStatus: "MISMATCH",
        dispatchStatus: previousResult?.dispatchStatus ?? "succeeded",
        commitSha: previousResult?.commitSha,
        isUpdate: previousResult?.isUpdate,
      };
    } catch {
      return {
        status: "requires_attention",
        path,
        contentHash: expectedHash,
        fileSha: previousResult?.fileSha,
        revalidationCount: previousResult?.revalidationCount ?? 0,
        attentionReason: "GITHUB_RECONCILIATION_REQUIRED",
        verificationStatus: "UNKNOWN",
        dispatchStatus: previousResult?.dispatchStatus ?? "succeeded",
        commitSha: previousResult?.commitSha,
        isUpdate: previousResult?.isUpdate,
      };
    }
  }

  /**
   * Resolves the next available versioned filename for KEEP_ALL policy.
   *
   * Generates deterministic `-v2`, `-v3`, ... `-v{MAX_KEEP_ALL_CANDIDATES}` suffixes.
   *
   * **Bounded**: Probes at most `MAX_KEEP_ALL_CANDIDATES` candidates (base file + versions).
   * **Fail-Closed**: If all candidate slots are exhausted, THROWS rather than silently
   * overwriting the last candidate or probing indefinitely.
   *
   * e.g. path/to/two-sum.cpp -> path/to/two-sum-v2.cpp, path/to/two-sum-v3.cpp
   */
  private async resolveKeepAllPath(
    owner: string,
    repo: string,
    branch: string,
    initialPath: string,
  ): Promise<string> {
    // Check 1: Does the base file exist?
    let checkPath = initialPath;
    const baseExists = await this.client.getFileContents(
      owner,
      repo,
      checkPath,
      branch,
    );
    if (!baseExists) return checkPath;

    // Extract base and extension for versioned suffix generation
    const lastDot = initialPath.lastIndexOf(".");
    const lastSlash = initialPath.lastIndexOf("/");
    let base = initialPath;
    let ext = "";

    if (lastDot > lastSlash && lastDot !== -1) {
      base = initialPath.slice(0, lastDot);
      ext = initialPath.slice(lastDot);
    }

    // Probe versions v2 through v{MAX_KEEP_ALL_CANDIDATES} (bounded)
    for (let version = 2; version <= MAX_KEEP_ALL_CANDIDATES; version++) {
      checkPath = `${base}-v${version}${ext}`;
      const exists = await this.client.getFileContents(
        owner,
        repo,
        checkPath,
        branch,
      );
      if (!exists) {
        return checkPath;
      }
    }

    // All candidate slots exhausted — FAIL CLOSED.
    // Never silently overwrite the last candidate or probe indefinitely.
    throw new GitHubApiError(
      `KEEP_ALL candidate exhaustion: all ${MAX_KEEP_ALL_CANDIDATES} versioned slots ` +
        `for "${initialPath}" are occupied. Cannot safely generate a unique filename.`,
      { code: ErrorCode.GITHUB_CONFLICT },
    );
  }
}
