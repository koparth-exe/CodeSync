import { createLogger } from "../logger";
import {
  ErrorCode,
  GitHubApiError,
  GitHubAuthError,
  GitHubConflictError,
  GitHubRateLimitError,
  GitHubWriteOutcomeUnknownError,
  PathSecurityError,
  PathTemplateError,
} from "../errors";
import { computeContentHash, normalizeSourceCode } from "../deduplication";
import {
  formatSafeCommitMessage,
  resolvePathTemplate,
  validateAndCanonicalizePath,
  validateBaseFolder,
} from "../github/path-engine";
import {
  MAX_SOURCE_PAYLOAD_BYTES,
  type GitHubWriteOptions,
  type PathTemplateVariables,
} from "../github/types";
import { GitHubContentsService } from "../github/contents-service";
import { GitHubApiClient } from "../github/client";
import { defaultGitHubAuthService } from "../auth/service";
import { validateRepositoryIdentity, validateTargetBranch } from "../config";
import type {
  QueueItemMetadata,
  QueueItemPayload,
  TargetSnapshot,
} from "../storage/types";
import type { QueueItemHandler } from "./drainer";
import type { SyncResult } from "./types";
import { defaultStorageService, StorageService } from "../storage/local";

const logger = createLogger("GitHubQueueSyncHandler");

/**
 * Standard deterministic mapping from common platform language names to safe file extensions.
 * Follows POSIX portable ASCII filename grammar without leading periods.
 */
export const LANGUAGE_EXTENSION_MAP: Readonly<Record<string, string>> =
  Object.freeze({
    cpp: "cpp",
    "c++": "cpp",
    cxx: "cpp",
    cc: "cpp",
    c: "c",
    python: "py",
    python3: "py",
    py: "py",
    pypy: "py",
    pypy3: "py",
    java: "java",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    csharp: "cs",
    "c#": "cs",
    cs: "cs",
    rust: "rs",
    rs: "rs",
    go: "go",
    golang: "go",
    kotlin: "kt",
    kt: "kt",
    ruby: "rb",
    rb: "rb",
    swift: "swift",
    scala: "scala",
    php: "php",
    dart: "dart",
    r: "r",
    haskell: "hs",
    hs: "hs",
    elixir: "ex",
    ex: "ex",
    sql: "sql",
    bash: "sh",
    shell: "sh",
    sh: "sh",
  });

/**
 * Resolves a normalized programming language name into a safe file extension.
 */
export function resolveLanguageExtension(language: string): string {
  if (!language || typeof language !== "string") {
    return "txt";
  }
  const clean = language.trim().toLowerCase();
  if (LANGUAGE_EXTENSION_MAP[clean]) {
    return LANGUAGE_EXTENSION_MAP[clean];
  }
  // Sanitize: allow lowercase alphanumeric 1-10 chars
  const sanitized = clean.replace(/[^a-z0-9]/g, "").slice(0, 10);
  return sanitized.length > 0 ? sanitized : "txt";
}

export interface GitHubQueueHandlerOptions {
  readonly contentsService?: GitHubContentsService | undefined;
  readonly storage?: StorageService | undefined;
  readonly pathResolver?:
    ((item: QueueItemMetadata, snapshot: TargetSnapshot) => string) | undefined;
}

/**
 * Real Queue Item -> GitHub Synchronization Handler.
 *
 * Implements the contract for processing claimed durable queue items:
 * 1. Validates persisted queue item metadata, provenance, and payload integrity.
 * 2. Enforces content hash consistency against normalized source payload.
 * 3. Preserves immutable TargetSnapshot without falling back to dynamic user settings.
 * 4. Resolves safe target repository paths through the approved three-pillar path engine.
 * 5. Delegates the transactional commit and verification protocol to GitHubContentsService.
 * 6. Maps GitHub results and structured errors into QueueManager's lifecycle SyncResult.
 *
 * Security Invariants:
 * - Fail-closed: Never issues a GitHub write if payload, snapshot, or path validation fails.
 * - Uncertain write preservation: Never treats an uncertain outcome as confirmed success.
 * - Zero secret leakage: Never outputs tokens, credentials, or raw source dumps in logs.
 * - Non-destructive: Never mutates QueueItemMetadata directly; returns SyncResult to QueueManager.
 */
export class GitHubQueueSyncHandler {
  private readonly contentsService: GitHubContentsService;
  private readonly storage: StorageService;
  private readonly pathResolver?:
    ((item: QueueItemMetadata, snapshot: TargetSnapshot) => string) | undefined;

  constructor(options: GitHubQueueHandlerOptions = {}) {
    this.storage = options.storage ?? defaultStorageService;
    this.pathResolver = options.pathResolver;

    if (options.contentsService) {
      this.contentsService = options.contentsService;
    } else {
      const client = new GitHubApiClient({
        lifecycleManager: defaultGitHubAuthService.getLifecycleManager(),
      });
      this.contentsService = new GitHubContentsService({ client });
    }
  }

  /**
   * Processes a single claimed queue item and returns the execution SyncResult.
   */
  async handle(
    item: QueueItemMetadata,
    payload: QueueItemPayload,
  ): Promise<SyncResult> {
    // ------------------------------------------------------------------------
    // STEP 1: Metadata Integrity & Invariant Validation
    // ------------------------------------------------------------------------
    if (!item || typeof item !== "object") {
      logger.warn("Rejecting malformed queue item metadata");
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: "Queue item metadata is null or malformed.",
          retryable: false,
        },
      };
    }

    if (item.validatedBy !== "SERVICE_WORKER") {
      logger.warn(
        "Rejecting unvalidated queue item (missing SERVICE_WORKER authority)",
        {
          itemId: item.id,
          validatedBy: item.validatedBy,
        },
      );
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.INVARIANT_VIOLATION,
          message:
            "Queue item violates trust boundary: missing authoritative SERVICE_WORKER validation stamp.",
          retryable: false,
        },
      };
    }

    if (!item.id || typeof item.id !== "string") {
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: "Queue item missing valid UUID identifier.",
          retryable: false,
        },
      };
    }

    if (
      !item.platform ||
      !["leetcode", "codeforces", "codechef", "geeksforgeeks"].includes(
        item.platform.toLowerCase(),
      )
    ) {
      logger.warn("Rejecting item with unsupported platform", {
        platform: item.platform,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: `Platform "${item.platform}" is unsupported or invalid.`,
          retryable: false,
        },
      };
    }

    if (!item.contentHash || !/^[a-f0-9]{64}$/i.test(item.contentHash)) {
      logger.warn("Rejecting item with invalid content hash format", {
        contentHash: item.contentHash,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message:
            "Queue item contains malformed or absent SHA-256 content hash.",
          retryable: false,
        },
      };
    }

    // ------------------------------------------------------------------------
    // STEP 2: Payload Existence, Bounds, & Content Integrity Check
    // ------------------------------------------------------------------------
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.sourceCode !== "string" ||
      !payload.sourceCode.trim()
    ) {
      logger.warn("Payload missing or empty in IndexedDB store", {
        itemId: item.id,
        payloadId: item.payloadId,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.PAYLOAD_NOT_FOUND,
          message: "Source code payload is missing or empty in IndexedDB.",
          retryable: false,
        },
      };
    }

    const payloadBytes = new TextEncoder().encode(payload.sourceCode).length;
    if (payloadBytes > MAX_SOURCE_PAYLOAD_BYTES) {
      logger.warn("Payload exceeds max byte limit", {
        bytes: payloadBytes,
        limit: MAX_SOURCE_PAYLOAD_BYTES,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.GITHUB_PAYLOAD_TOO_LARGE,
          message: `Source code size (${payloadBytes} bytes) exceeds maximum allowable limit of ${MAX_SOURCE_PAYLOAD_BYTES} bytes.`,
          retryable: false,
        },
      };
    }

    // Verify content hash integrity: Recalculated hash must strictly equal persisted metadata hash
    const normalizedSource = normalizeSourceCode(payload.sourceCode);
    const recalculatedHash = await computeContentHash(normalizedSource);
    if (recalculatedHash.toLowerCase() !== item.contentHash.toLowerCase()) {
      logger.warn("Source code content hash mismatch detected", {
        metadataHash: item.contentHash,
        recalculatedHash,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.INVARIANT_VIOLATION,
          message:
            "Integrity failure: Recalculated source payload hash does not match persisted queue metadata hash.",
          retryable: false,
        },
      };
    }

    // ------------------------------------------------------------------------
    // STEP 3: Immutable TargetSnapshot Validation
    // ------------------------------------------------------------------------
    const snapshot = item.targetSnapshot;
    if (!snapshot || typeof snapshot !== "object") {
      logger.warn("Rejecting item missing immutable TargetSnapshot", {
        itemId: item.id,
      });
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message:
            "Queue item is missing its immutable TargetSnapshot captured at enqueue time.",
          retryable: false,
        },
      };
    }

    let repoIdentity: string;
    try {
      repoIdentity = validateRepositoryIdentity(snapshot.targetRepository);
    } catch (err) {
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.CONFIGURATION_INVALID,
          message: (err as Error).message,
          retryable: false,
        },
      };
    }

    try {
      validateTargetBranch(snapshot.targetBranch);
    } catch (err) {
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.CONFIGURATION_INVALID,
          message: (err as Error).message,
          retryable: false,
        },
      };
    }

    try {
      validateBaseFolder(snapshot.basePath);
    } catch (err) {
      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.CONFIGURATION_INVALID,
          message: (err as Error).message,
          retryable: false,
        },
      };
    }

    // ------------------------------------------------------------------------
    // STEP 4: Path Resolution via Three-Pillar Path Engine
    // ------------------------------------------------------------------------
    let resolvedPath: string;
    if (this.pathResolver) {
      try {
        resolvedPath = this.pathResolver(item, snapshot);
      } catch (err) {
        return {
          status: "requires_attention",
          error: {
            code: ErrorCode.PATH_BOUNDARY_VIOLATION,
            message: `Custom path resolution failed: ${(err as Error).message}`,
            retryable: false,
          },
        };
      }
    } else {
      const extension = resolveLanguageExtension(item.language);
      if (snapshot.pathTemplate && snapshot.pathTemplate.trim()) {
        try {
          const variables: PathTemplateVariables = {
            platform: item.platform,
            platform_lower: item.platform.toLowerCase(),
            slug: item.problemSlug,
            title: item.problemTitle || item.problemSlug,
            problem_id: item.problemSlug,
            language: item.language,
            language_lower: item.language.toLowerCase(),
            extension,
            status: item.status,
            date: new Date(item.createdAt).toISOString().split("T")[0],
            timestamp: Math.floor(item.createdAt / 1000).toString(),
          };
          resolvedPath = resolvePathTemplate(snapshot.pathTemplate, variables);
        } catch (err) {
          logger.warn("Path template resolution failed", {
            error: (err as Error).message,
            template: snapshot.pathTemplate,
          });
          return {
            status: "requires_attention",
            error: {
              code:
                (err as { code?: string }).code ??
                ErrorCode.PATH_TRAVERSAL_DETECTED,
              message: (err as Error).message,
              retryable: false,
            },
          };
        }
      } else {
        resolvedPath = `${item.platform.toLowerCase()}/${item.problemSlug}.${extension}`;
      }
    }

    // Crucial: Validate resolved path against safe path grammar and base folder boundary
    // BEFORE invoking GitHubContentsService to guarantee invalid paths never reach GitHub.
    try {
      validateAndCanonicalizePath(resolvedPath, snapshot.basePath);
    } catch (err) {
      logger.warn("Resolved path validation failed", {
        error: (err as Error).message,
        path: resolvedPath,
      });
      return {
        status: "requires_attention",
        error: {
          code:
            (err as { code?: string }).code ??
            ErrorCode.PATH_TRAVERSAL_DETECTED,
          message: (err as Error).message,
          retryable: false,
        },
      };
    }

    // ------------------------------------------------------------------------
    // STEP 5: Safe Commit Message Formatting
    // ------------------------------------------------------------------------
    const summaryLine = `Sync ${item.platform} - ${item.problemTitle || item.problemSlug}`;
    const commitMessage = formatSafeCommitMessage(summaryLine);

    // ------------------------------------------------------------------------
    // STEP 6: Execute SynchronizeFile via Existing GitHubContentsService
    // ------------------------------------------------------------------------
    const [owner, repo] = repoIdentity.split("/") as [string, string];
    const writeOptions: GitHubWriteOptions = {
      owner,
      repo,
      branch: snapshot.targetBranch,
      path: resolvedPath,
      content: payload.sourceCode,
      commitMessage,
      duplicatePolicy: snapshot.duplicatePolicy,
      baseFolder: snapshot.basePath,
    };

    logger.info("Dispatching queue item to GitHubContentsService", {
      itemId: item.id,
      targetRepository: repoIdentity,
      branch: snapshot.targetBranch,
      path: resolvedPath,
      duplicatePolicy: snapshot.duplicatePolicy,
    });

    try {
      const result = await this.contentsService.synchronizeFile(writeOptions);

      if (result.status === "created" || result.status === "updated") {
        logger.info("GitHub synchronization confirmed successfully", {
          itemId: item.id,
          status: result.status,
          commitSha: result.commitSha,
        });
        return {
          status: "completed",
          commitSha: result.commitSha,
          commitUrl: result.commitSha
            ? `https://github.com/${owner}/${repo}/commit/${result.commitSha}`
            : undefined,
        };
      }

      if (
        result.status === "skipped_identical" ||
        result.status === "skipped_exists"
      ) {
        logger.info(
          "GitHub synchronization skipped cleanly per duplicate policy",
          {
            itemId: item.id,
            status: result.status,
          },
        );
        return {
          status: "skipped",
        };
      }

      if (result.status === "requires_attention") {
        logger.warn("GitHub synchronization requires attention", {
          itemId: item.id,
          attentionReason: result.attentionReason,
          verificationStatus: result.verificationStatus,
        });
        return {
          status: "requires_attention",
          commitSha: result.commitSha,
          commitUrl: result.commitSha
            ? `https://github.com/${owner}/${repo}/commit/${result.commitSha}`
            : undefined,
          error: {
            code: result.attentionReason ?? ErrorCode.UNSUPPORTED_OPERATION,
            message: `GitHub write requires attention: ${result.attentionReason ?? "Unknown outcome"}`,
            retryable: false,
          },
        };
      }

      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.UNSUPPORTED_OPERATION,
          message: `Unhandled GitHub write status: "${String(result.status)}"`,
          retryable: false,
        },
      };
    } catch (err: unknown) {
      logger.warn(
        "GitHub write exception encountered during queue item synchronization",
        {
          itemId: item.id,
          error: (err as Error).message,
        },
      );

      if (err instanceof GitHubRateLimitError) {
        return {
          status: "failed",
          error: {
            code: ErrorCode.GITHUB_RATE_LIMITED,
            message: err.message,
            retryable: true,
            resetTimestamp: err.resetTimestamp ?? err.rateLimit?.resetTimestamp,
            retryAfterSeconds:
              err.retryAfterSeconds ?? err.rateLimit?.retryAfterSeconds,
          },
        };
      }

      if (err instanceof GitHubWriteOutcomeUnknownError) {
        // Uncertain write: Never issue blind retry; escalate to requires_attention
        return {
          status: "requires_attention",
          error: {
            code: ErrorCode.GITHUB_WRITE_OUTCOME_UNKNOWN,
            message: err.message,
            retryable: false,
          },
        };
      }

      if (err instanceof GitHubConflictError) {
        return {
          status: "requires_attention",
          error: {
            code: ErrorCode.GITHUB_CONFLICT,
            message: err.message,
            retryable: false,
          },
        };
      }

      if (err instanceof GitHubAuthError) {
        return {
          status: "requires_attention",
          error: {
            code: ErrorCode.GITHUB_AUTH_REQUIRED,
            message: err.message,
            retryable: false,
          },
        };
      }

      if (err instanceof GitHubApiError) {
        if (err.status === 401) {
          // Terminal 401: Coordinated token refresh was already attempted and rejected
          return {
            status: "requires_attention",
            error: {
              code: ErrorCode.GITHUB_UNAUTHORIZED,
              message: err.message,
              retryable: false,
            },
          };
        }

        if (err.status === 403) {
          // Authorization failure (not a rate limit)
          return {
            status: "requires_attention",
            error: {
              code: ErrorCode.GITHUB_FORBIDDEN,
              message: err.message,
              retryable: false,
            },
          };
        }

        if (err.status === 404) {
          return {
            status: "requires_attention",
            error: {
              code: err.code ?? ErrorCode.GITHUB_REPOSITORY_NOT_FOUND,
              message: err.message,
              retryable: false,
            },
          };
        }

        if (err.isRetryable) {
          return {
            status: "failed",
            error: {
              code: err.code ?? ErrorCode.GITHUB_API_ERROR,
              message: err.message,
              retryable: true,
            },
          };
        }

        return {
          status: "requires_attention",
          error: {
            code: err.code ?? ErrorCode.GITHUB_API_ERROR,
            message: err.message,
            retryable: false,
          },
        };
      }

      if (
        err instanceof PathSecurityError ||
        err instanceof PathTemplateError
      ) {
        return {
          status: "requires_attention",
          error: {
            code:
              (err as { code?: string }).code ??
              ErrorCode.PATH_BOUNDARY_VIOLATION,
            message: (err as Error).message,
            retryable: false,
          },
        };
      }

      return {
        status: "requires_attention",
        error: {
          code: ErrorCode.INVARIANT_VIOLATION,
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };
    }
  }
}

/**
 * Factory helper to construct a standard QueueItemHandler function
 * backed by GitHubQueueSyncHandler.
 */
export function createGitHubQueueItemHandler(
  options: GitHubQueueHandlerOptions = {},
): QueueItemHandler {
  const syncHandler = new GitHubQueueSyncHandler(options);
  return async (
    item: QueueItemMetadata,
    payload: QueueItemPayload,
  ): Promise<SyncResult> => {
    return await syncHandler.handle(item, payload);
  };
}
