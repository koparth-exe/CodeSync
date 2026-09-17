import type { DuplicatePolicy } from "../config/schema";
import type { GitHubRateLimitInfo } from "../errors";

/**
 * Operational Constants for GitHub REST API Integration.
 *
 * These are **operational parameters** that pin current API behavior, NOT
 * guarantees of permanent stability. GitHub may deprecate older API versions;
 * CodeSync should update these values when the pinned version approaches EOL.
 *
 * GITHUB_REST_API_VERSION: Sent as `X-GitHub-Api-Version` header to lock the
 * REST API response shape to a known, tested version. This is an operational
 * choice, not a claim that "2022-11-28" will be supported by GitHub indefinitely.
 */
export const GITHUB_REST_API_VERSION = "2022-11-28";
export const GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
export const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Maximum supported source payload size: 500 KB (512,000 bytes).
 * Content exceeding this boundary is rejected fail-closed to preserve extension memory.
 */
export const MAX_SOURCE_PAYLOAD_BYTES = 512_000;

/**
 * Default network request timeout (15 seconds) using AbortController.
 */
export const DEFAULT_CLIENT_TIMEOUT_MS = 15_000;

/**
 * Maximum permitted revalidation passes for HTTP 409 Conflict protocol before escalation.
 */
export const MAX_CONFLICT_REVALIDATIONS = 2;

/**
 * Maximum number of KEEP_ALL versioned filename candidates to probe.
 *
 * KEEP_ALL generates deterministic `-v2`, `-v3`, ... suffixes. This constant bounds
 * the number of GitHub Contents API GET probes to prevent unbounded API call amplification.
 *
 * If all candidate slots are exhausted, the service FAILS CLOSED (throws) rather than
 * silently overwriting the last candidate or probing indefinitely.
 *
 * Design: 10 candidates means checking the base file + versions v2–v10 (10 GET calls max).
 */
export const MAX_KEEP_ALL_CANDIDATES = 10;

/**
 * Authoritative GitHub Repository Identity.
 * The immutable numeric repository ID is the strongest identity anchor.
 */
export interface GitHubRepository {
  readonly id: number; // Immutable GitHub numeric repo ID
  readonly owner: string; // Account login (e.g. "octocat")
  readonly name: string; // Repository name (e.g. "leetcode-solutions")
  readonly fullName: string; // "owner/name"
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly permissions?:
    | {
        readonly push?: boolean | undefined;
        readonly pull?: boolean | undefined;
        readonly admin?: boolean | undefined;
      }
    | undefined;
  readonly installationId?: number | undefined;
}

/**
 * Authoritative GitHub Branch State.
 */
export interface GitHubBranch {
  readonly name: string;
  readonly sha: string;
  readonly protected: boolean;
}

/**
 * GitHub Contents API item representation.
 */
export type GitHubObjectType = "file" | "dir" | "symlink" | "submodule";

export interface GitHubContentFile {
  readonly type: GitHubObjectType;
  readonly size: number;
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly content?: string | undefined; // Base64 payload from GitHub
  readonly decodedContent?: string | undefined; // Decoded UTF-8 source string
  readonly contentHash?: string | undefined; // CodeSync SHA-256 normalized content hash
}

/**
 * Payload sent to PUT /repos/{owner}/{repo}/contents/{path}
 */
export interface GitHubContentsWritePayload {
  readonly message: string;
  readonly content: string; // Base64 encoded
  readonly branch: string;
  readonly sha?: string | undefined; // Required for updates under OCC
}

/**
 * Successful response from PUT /repos/{owner}/{repo}/contents/{path}
 */
export interface GitHubContentsWriteResponse {
  readonly content: {
    readonly name: string;
    readonly path: string;
    readonly sha: string;
    readonly size: number;
  };
  readonly commit: {
    readonly sha: string;
    readonly message: string;
    readonly htmlUrl?: string | undefined;
  };
}

/**
 * GitHub App Installation reference.
 */
export interface GitHubInstallation {
  readonly id: number;
  readonly account: {
    readonly login: string;
    readonly id: number;
    readonly type: string;
  };
  readonly repositorySelection: "all" | "selected";
}

/**
 * Allowlisted path template variables.
 * Unsupported variables are strictly rejected fail-closed.
 */
export interface PathTemplateVariables {
  readonly platform: string;
  readonly platform_lower?: string | undefined;
  readonly slug: string;
  readonly title?: string | undefined;
  readonly problem_id?: string | undefined;
  readonly language: string;
  readonly language_lower?: string | undefined;
  readonly extension: string;
  readonly difficulty?: string | undefined;
  readonly rating?: string | undefined;
  readonly contest_id?: string | undefined;
  readonly problem_code?: string | undefined;
  readonly division?: string | undefined;
  readonly status?: string | undefined;
  readonly date?: string | undefined;
  readonly timestamp?: string | undefined;
}

/**
 * Approved Phase 1C duplicate/repository policies.
 */
export type GitHubDuplicatePolicy =
  "REPLACE_IF_DIFFERENT" | "ALWAYS_REPLACE" | "KEEP_ALL" | "CREATE_ONLY";

export function normalizeDuplicatePolicy(
  policy?: GitHubDuplicatePolicy | DuplicatePolicy | undefined,
): GitHubDuplicatePolicy {
  if (!policy || policy === "REPLACE_IF_DIFFERENT" || policy === "skip") {
    return "REPLACE_IF_DIFFERENT";
  }
  if (policy === "ALWAYS_REPLACE" || policy === "overwrite") {
    return "ALWAYS_REPLACE";
  }
  if (policy === "KEEP_ALL" || policy === "keep_both") {
    return "KEEP_ALL";
  }
  if (policy === "CREATE_ONLY") {
    return "CREATE_ONLY";
  }
  return "REPLACE_IF_DIFFERENT";
}

/**
 * Options for executing the validated transactional write protocol.
 */
export interface GitHubWriteOptions {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly content: string; // Raw source code
  readonly commitMessage: string;
  readonly duplicatePolicy?:
    GitHubDuplicatePolicy | DuplicatePolicy | undefined;
  readonly baseFolder?: string | undefined;
  readonly expectedSha?: string | undefined;
}

/**
 * Write dispatch outcome (PUT request result).
 *
 * Phase 1C.2.1 C4.1: Decouples write dispatch from authoritative verification.
 * - `succeeded`: PUT /contents/... request returned HTTP 200 or 201.
 * - `failed`: PUT /contents/... was explicitly rejected by GitHub (HTTP 4xx/5xx).
 * - `uncertain`: Network failed, dropped, or timed out during PUT dispatch.
 */
export type WriteDispatchStatus = "succeeded" | "failed" | "uncertain";

/**
 * Post-write verification outcome.
 *
 * - `CONFIRMED`: Fresh authoritative GET confirmed remote content matches intended local content hash.
 * - `MISMATCH`: Fresh authoritative GET succeeded, but remote content hash differs from intended.
 * - `UNKNOWN`: Verification GET itself failed (network error, timeout, or unexpected response).
 *   The write may or may not have committed correctly. The distinction matters for recovery.
 */
export type VerificationStatus = "CONFIRMED" | "MISMATCH" | "UNKNOWN";

/**
 * Result of a validated transactional write protocol execution.
 */
export type GitHubWriteStatus =
  | "created"
  | "updated"
  | "skipped_identical"
  | "skipped_exists"
  | "requires_attention"
  | "reconciliation_required";

export interface GitHubWriteResult {
  readonly status: GitHubWriteStatus;
  readonly commitSha?: string | undefined;
  readonly fileSha?: string | undefined;
  readonly path: string;
  readonly contentHash: string;
  readonly revalidationCount: number;
  readonly attentionReason?: string | undefined;
  /**
   * Post-write verification outcome. Present when a write (PUT) was dispatched.
   * Absent when the write was skipped (skipped_identical, skipped_exists).
   */
  readonly verificationStatus?: VerificationStatus | undefined;
  /**
   * Write dispatch outcome. Present when a write (PUT) was dispatched or attempted.
   */
  readonly dispatchStatus?: WriteDispatchStatus | undefined;
  /**
   * Whether the write was an update to an existing file under OCC (true) or a new file creation (false).
   */
  readonly isUpdate?: boolean | undefined;
}

export type { GitHubRateLimitInfo };
