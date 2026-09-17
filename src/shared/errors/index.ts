import { ErrorCode } from "./codes";

export { ErrorCode };

/**
 * Base error class for all CodeSync domain and operational errors.
 * Guarantees that internal stack details and secrets are not leaked to UI,
 * while preserving structured error codes for deterministic recovery.
 */
export class CodeSyncError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly failClosed: boolean;
  readonly timestamp: number;

  constructor(
    code: ErrorCode,
    message: string,
    userMessage?: string,
    failClosed: boolean = true,
  ) {
    super(message);
    this.name = "CodeSyncError";
    this.code = code;
    this.userMessage =
      userMessage ?? "An unexpected error occurred. Operation aborted safely.";
    this.failClosed = failClosed;
    this.timestamp = Date.now();

    // Maintain standard prototype chain in transpiled ES
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when runtime data validation fails.
 */
export class ValidationError extends CodeSyncError {
  constructor(message: string, userMessage?: string) {
    super(
      ErrorCode.VALIDATION_FAILED,
      message,
      userMessage ?? "Validation failed for input data.",
      true,
    );
    this.name = "ValidationError";
  }
}

/**
 * Thrown when extension configuration is missing, malformed, or hostile.
 */
export class ConfigurationError extends CodeSyncError {
  constructor(
    message: string,
    userMessage?: string,
    code: ErrorCode = ErrorCode.CONFIGURATION_INVALID,
  ) {
    super(
      code,
      message,
      userMessage ??
        "Invalid extension configuration. Reverting to safe defaults.",
      true,
    );
    this.name = "ConfigurationError";
  }
}

/**
 * Thrown when browser extension APIs (runtime, storage) fail or are unavailable.
 */
export class BrowserRuntimeError extends CodeSyncError {
  constructor(
    message: string,
    userMessage?: string,
    code: ErrorCode = ErrorCode.BROWSER_RUNTIME_UNAVAILABLE,
  ) {
    super(
      code,
      message,
      userMessage ?? "Browser extension service unavailable.",
      true,
    );
    this.name = "BrowserRuntimeError";
  }
}

/**
 * Thrown when a fundamental system invariant is violated (e.g. state inconsistency).
 */
export class InvariantViolationError extends CodeSyncError {
  constructor(message: string) {
    super(
      ErrorCode.INVARIANT_VIOLATION,
      `Invariant violation: ${message}`,
      "A system invariant was violated. Processing halted to protect data integrity.",
      true,
    );
    this.name = "InvariantViolationError";
  }
}

/**
 * Thrown when a potential security boundary violation or unauthorized action occurs.
 */
export class SecurityError extends CodeSyncError {
  constructor(
    message: string,
    codeOrUserMessage?: ErrorCode | string,
    userMessage?: string,
  ) {
    let code = ErrorCode.SECURITY_VIOLATION;
    let finalUserMessage = userMessage;

    if (typeof codeOrUserMessage === "string") {
      if (Object.values(ErrorCode).includes(codeOrUserMessage as ErrorCode)) {
        code = codeOrUserMessage as ErrorCode;
      } else {
        finalUserMessage = codeOrUserMessage;
      }
    }

    super(
      code,
      `Security violation: ${message}`,
      finalUserMessage ?? "Action blocked by security policy.",
      true,
    );
    this.name = "SecurityError";
  }
}

/**
 * Thrown when storage operations (Local Storage or IndexedDB) fail.
 */
export class StorageError extends CodeSyncError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.STORAGE_ERROR,
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "Storage operation failed safely.",
      true,
    );
    this.name = "StorageError";
  }
}

/**
 * Thrown when queue management, leasing, or state transitions encounter errors.
 */
export class QueueError extends CodeSyncError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.INVARIANT_VIOLATION,
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "Queue processing error encountered.",
      true,
    );
    this.name = "QueueError";
  }
}

/**
 * Thrown when message envelope fails validation, is replayed, or untrusted.
 */
export class EnvelopeValidationError extends CodeSyncError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.ENVELOPE_VALIDATION_FAILED,
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "Message envelope validation failed.",
      true,
    );
    this.name = "EnvelopeValidationError";
  }
}

/**
 * Thrown when an item repeatedly crashes the worker and is quarantined.
 */
export class PoisonPillError extends CodeSyncError {
  constructor(message: string) {
    super(
      ErrorCode.POISON_PILL_DETECTED,
      `Poison pill detected: ${message}`,
      "Item repeatedly caused crashes and has been quarantined.",
      true,
    );
    this.name = "PoisonPillError";
  }
}

/**
 * Thrown when a stale worker attempts a mutation after its lease was superseded.
 */
export class StaleLeaseError extends CodeSyncError {
  constructor(message: string) {
    super(
      ErrorCode.STALE_WORKER_MUTATION,
      `Stale worker mutation rejected: ${message}`,
      "Operation rejected because worker lease has expired or been superseded.",
      true,
    );
    this.name = "StaleLeaseError";
  }
}

/**
 * Thrown when GitHub authentication, token refresh, or device authorization fails.
 */
export class GitHubAuthError extends CodeSyncError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.GITHUB_AUTH_REQUIRED,
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "GitHub authentication failed. Please re-authenticate.",
      true,
    );
    this.name = "GitHubAuthError";
  }
}

export interface GitHubRateLimitInfo {
  readonly limit: number;
  readonly remaining: number;
  readonly resetTimestamp: number;
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Thrown when GitHub REST API requests fail or return non-2xx responses.
 * Guarantees zero secret leakage in error messages and representations.
 */
export class GitHubApiError extends CodeSyncError {
  readonly status?: number | undefined;
  readonly endpoint?: string | undefined;
  readonly rateLimit?: GitHubRateLimitInfo | undefined;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number | undefined;
      endpoint?: string | undefined;
      rateLimit?: GitHubRateLimitInfo | undefined;
      isRetryable?: boolean | undefined;
      code?: ErrorCode | undefined;
      userMessage?: string | undefined;
    } = {},
  ) {
    const code = options.code ?? ErrorCode.GITHUB_API_ERROR;
    super(
      code,
      message,
      options.userMessage ?? "GitHub API communication failed safely.",
      true,
    );
    this.name = "GitHubApiError";
    this.status = options.status;
    this.endpoint = options.endpoint;
    this.rateLimit = options.rateLimit;
    this.isRetryable = options.isRetryable ?? false;
  }
}

/**
 * Thrown when GitHub API rate limits (primary or secondary) are exceeded.
 *
 * Primary rate limits (HTTP 429, or 403 with x-ratelimit-remaining === 0) indicate
 * token-scoped quota exhaustion.
 *
 * Secondary rate limits (HTTP 403 with Retry-After header, remaining > 0) indicate
 * GitHub's abuse detection / anti-spam throttle. These are NOT authorization failures.
 *
 * The `isSecondary` flag distinguishes these two cases for appropriate backoff strategies.
 */
export class GitHubRateLimitError extends GitHubApiError {
  readonly resetTimestamp: number;
  readonly retryAfterSeconds?: number | undefined;
  readonly isSecondary: boolean;

  constructor(
    message: string,
    options: {
      resetTimestamp: number;
      retryAfterSeconds?: number | undefined;
      endpoint?: string | undefined;
      rateLimit?: GitHubRateLimitInfo | undefined;
      isSecondary?: boolean | undefined;
    },
  ) {
    super(message, {
      status: options.isSecondary ? 403 : 429,
      endpoint: options.endpoint,
      rateLimit: options.rateLimit,
      isRetryable: true,
      code: ErrorCode.GITHUB_RATE_LIMITED,
      userMessage:
        "GitHub API rate limit reached. Synchronization paused safely.",
    });
    this.name = "GitHubRateLimitError";
    this.resetTimestamp = options.resetTimestamp;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.isSecondary = options.isSecondary ?? false;
  }
}

/**
 * Thrown when GitHub Contents API returns HTTP 409 Conflict.
 * Indicates a TOCTOU race condition requiring execution of the 8-Step Conflict Protocol.
 */
export class GitHubConflictError extends GitHubApiError {
  readonly path: string;
  readonly remoteSha?: string | undefined;
  readonly conflictCount: number;

  constructor(
    message: string,
    options: {
      path: string;
      remoteSha?: string | undefined;
      conflictCount?: number | undefined;
      endpoint?: string | undefined;
    },
  ) {
    super(message, {
      status: 409,
      endpoint: options.endpoint,
      isRetryable: false,
      code: ErrorCode.GITHUB_CONFLICT,
      userMessage:
        "Concurrent edit detected on GitHub. Safe conflict protocol initiated.",
    });
    this.name = "GitHubConflictError";
    this.path = options.path;
    this.remoteSha = options.remoteSha;
    this.conflictCount = options.conflictCount ?? 1;
  }
}

/**
 * Thrown when a write (PUT) was dispatched but the network connection dropped
 * or timed out before response confirmation. The outcome is unknown and must be reconciled.
 */
export class GitHubWriteOutcomeUnknownError extends GitHubApiError {
  readonly path: string;
  readonly intendedContentHash: string;
  readonly dispatchedAt: number;

  constructor(
    message: string,
    options: {
      path: string;
      intendedContentHash: string;
      dispatchedAt: number;
      endpoint?: string | undefined;
    },
  ) {
    super(message, {
      status: undefined,
      endpoint: options.endpoint,
      isRetryable: false,
      code: ErrorCode.GITHUB_WRITE_OUTCOME_UNKNOWN,
      userMessage:
        "Write outcome uncertain due to network disruption. Reconciling remote state.",
    });
    this.name = "GitHubWriteOutcomeUnknownError";
    this.path = options.path;
    this.intendedContentHash = options.intendedContentHash;
    this.dispatchedAt = options.dispatchedAt;
  }
}

/**
 * Thrown when post-write authoritative verification reveals discrepancy with intended state.
 */
export class GitHubVerificationError extends GitHubApiError {
  readonly path: string;
  readonly expectedHash: string;
  readonly actualHash?: string | undefined;

  constructor(
    message: string,
    options: {
      path: string;
      expectedHash: string;
      actualHash?: string | undefined;
      endpoint?: string | undefined;
    },
  ) {
    super(message, {
      status: undefined,
      endpoint: options.endpoint,
      isRetryable: false,
      code: ErrorCode.GITHUB_VERIFICATION_FAILED,
      userMessage:
        "Post-write verification failed. Remote content does not match intended submission.",
    });
    this.name = "GitHubVerificationError";
    this.path = options.path;
    this.expectedHash = options.expectedHash;
    this.actualHash = options.actualHash;
  }
}

/**
 * Thrown when path canonicalization, grammar check, or repository boundary validation fails.
 * Strict fail-closed policy.
 */
export class PathSecurityError extends CodeSyncError {
  readonly rawPath: string;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.PATH_TRAVERSAL_DETECTED,
    rawPath: string = "",
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "File path rejected by security policy.",
      true,
    );
    this.name = "PathSecurityError";
    this.rawPath = rawPath;
  }
}

/**
 * Thrown when path template syntax is malformed or an unapproved variable is used.
 */
export class PathTemplateError extends CodeSyncError {
  readonly template: string;
  readonly variable?: string | undefined;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.TEMPLATE_MALFORMED,
    template: string = "",
    variable?: string,
    userMessage?: string,
  ) {
    super(code, message, userMessage ?? "Path template is invalid.", true);
    this.name = "PathTemplateError";
    this.template = template;
    this.variable = variable;
  }
}

/**
 * Thrown when platform adapter detection, extraction, or validation fails.
 */
export class PlatformAdapterError extends CodeSyncError {
  readonly platform?: string | undefined;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.EXTRACTION_FAILED,
    platform?: string,
    userMessage?: string,
  ) {
    super(
      code,
      message,
      userMessage ?? "Failed to detect or extract platform submission safely.",
      true,
    );
    this.name = "PlatformAdapterError";
    this.platform = platform;
  }
}
