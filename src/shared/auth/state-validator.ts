import type {
  GitHubAuthState,
  GitHubAuthStatus,
  GitHubUser,
  RefreshAttemptRecord,
  RefreshLifecycleState,
  RefreshResponseMetadata,
} from "./types";
import { MAX_PREDECESSOR_ATTEMPTS } from "./types";
import { ErrorCode, GitHubAuthError, ValidationError } from "../errors";

const VALID_AUTH_STATUSES = new Set<GitHubAuthStatus>([
  "unauthenticated",
  "authenticated",
  "expired",
  "revoked",
  "reconciliation_required",
  "reauth_required",
]);

const VALID_REFRESH_STATES = new Set<RefreshLifecycleState>([
  "IDLE",
  "REFRESHING",
  "RECONCILIATION_REQUIRED",
]);

/**
 * Creates a clean default unauthenticated GitHubAuthState.
 */
export function createDefaultAuthState(): GitHubAuthState {
  return {
    method: "github_app",
    status: "unauthenticated",
    accessToken: "",
    refreshToken: "",
    tokenExpiresAt: 0,
    refreshTokenExpiresAt: 0,
    refreshGeneration: 0,
    refreshState: "IDLE",
    activeAttempt: undefined,
    predecessorAttempts: [],
    refreshLeaseEpoch: 0,
    authorizedRepositories: [],
    user: {
      login: "",
      id: 0,
      avatarUrl: "",
    },
    lastValidatedAt: 0,
    authenticatedAt: 0,
  };
}

/**
 * Validates the schema and structural integrity of an individual refresh attempt record.
 */
export function validateAttemptRecord(raw: unknown): RefreshAttemptRecord {
  if (!raw || typeof raw !== "object") {
    throw new ValidationError(
      "RefreshAttemptRecord must be a non-null object.",
    );
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.attemptId !== "string" || !record.attemptId) {
    throw new ValidationError("RefreshAttemptRecord missing valid attemptId.");
  }

  if (
    typeof record.credentialGeneration !== "number" ||
    !Number.isInteger(record.credentialGeneration) ||
    record.credentialGeneration < 0
  ) {
    throw new ValidationError(
      "RefreshAttemptRecord missing valid integer credentialGeneration.",
    );
  }

  if (
    typeof record.leaseEpoch !== "number" ||
    !Number.isInteger(record.leaseEpoch) ||
    record.leaseEpoch < 0
  ) {
    throw new ValidationError(
      "RefreshAttemptRecord missing valid integer leaseEpoch.",
    );
  }

  if (typeof record.workerId !== "string" || !record.workerId) {
    throw new ValidationError("RefreshAttemptRecord missing valid workerId.");
  }

  if (
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt)
  ) {
    throw new ValidationError("RefreshAttemptRecord missing valid startedAt.");
  }

  if (
    typeof record.leaseExpiresAt !== "number" ||
    !Number.isFinite(record.leaseExpiresAt)
  ) {
    throw new ValidationError(
      "RefreshAttemptRecord missing valid leaseExpiresAt.",
    );
  }

  if (typeof record.state !== "string" || !record.state) {
    throw new ValidationError("RefreshAttemptRecord missing valid state.");
  }

  if (typeof record.resolutionStatus !== "string" || !record.resolutionStatus) {
    throw new ValidationError(
      "RefreshAttemptRecord missing valid resolutionStatus.",
    );
  }

  return {
    attemptId: record.attemptId,
    credentialGeneration: record.credentialGeneration,
    leaseEpoch: record.leaseEpoch,
    workerId: record.workerId,
    startedAt: record.startedAt,
    leaseExpiresAt: record.leaseExpiresAt,
    state: record.state as RefreshAttemptRecord["state"],
    resolutionStatus:
      record.resolutionStatus as RefreshAttemptRecord["resolutionStatus"],
    errorClassification:
      typeof record.errorClassification === "string"
        ? record.errorClassification
        : undefined,
  };
}

/**
 * Validates the schema and structural integrity of durable GitHubAuthState.
 * If raw is null or undefined, returns a clean default unauthenticated state.
 * Fails closed by throwing ValidationError if structural anomalies are detected.
 */
export function validateAuthStateIntegrity(raw: unknown): GitHubAuthState {
  if (raw === null || raw === undefined) {
    return createDefaultAuthState();
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("GitHubAuthState must be a non-null object.");
  }

  const obj = raw as Record<string, unknown>;

  if (obj.method !== "github_app") {
    throw new ValidationError(
      `Unsupported or invalid auth method: ${String(obj.method)}. Only 'github_app' is supported.`,
    );
  }

  if (
    typeof obj.status !== "string" ||
    !VALID_AUTH_STATUSES.has(obj.status as GitHubAuthStatus)
  ) {
    throw new ValidationError(`Invalid auth status: ${String(obj.status)}`);
  }

  const status = obj.status as GitHubAuthStatus;

  if (
    typeof obj.refreshGeneration !== "number" ||
    !Number.isInteger(obj.refreshGeneration) ||
    obj.refreshGeneration < 0
  ) {
    throw new ValidationError(
      "GitHubAuthState missing valid non-negative integer refreshGeneration.",
    );
  }

  if (
    typeof obj.refreshLeaseEpoch !== "number" ||
    !Number.isInteger(obj.refreshLeaseEpoch) ||
    obj.refreshLeaseEpoch < 0
  ) {
    throw new ValidationError(
      "GitHubAuthState missing valid non-negative integer refreshLeaseEpoch.",
    );
  }

  if (
    typeof obj.refreshState !== "string" ||
    !VALID_REFRESH_STATES.has(obj.refreshState as RefreshLifecycleState)
  ) {
    throw new ValidationError(
      `Invalid refreshState: ${String(obj.refreshState)}`,
    );
  }

  const refreshState = obj.refreshState as RefreshLifecycleState;

  // Active attempt validation if present
  let activeAttempt: RefreshAttemptRecord | undefined;
  if (obj.activeAttempt !== undefined && obj.activeAttempt !== null) {
    activeAttempt = validateAttemptRecord(obj.activeAttempt);
  }

  // Predecessor attempts history validation
  const predecessorAttempts: RefreshAttemptRecord[] = [];
  if (Array.isArray(obj.predecessorAttempts)) {
    for (const item of obj.predecessorAttempts.slice(
      0,
      MAX_PREDECESSOR_ATTEMPTS,
    )) {
      predecessorAttempts.push(validateAttemptRecord(item));
    }
  }

  // User metadata validation
  const rawUser = (obj.user as Record<string, unknown>) ?? {};
  const user: GitHubUser = {
    login: typeof rawUser.login === "string" ? rawUser.login : "",
    id:
      typeof rawUser.id === "number" && Number.isFinite(rawUser.id)
        ? rawUser.id
        : 0,
    avatarUrl: typeof rawUser.avatarUrl === "string" ? rawUser.avatarUrl : "",
  };

  // Authorized repositories validation
  const authorizedRepositories: string[] = [];
  if (Array.isArray(obj.authorizedRepositories)) {
    for (const repo of obj.authorizedRepositories) {
      if (typeof repo === "string" && repo) {
        authorizedRepositories.push(repo);
      }
    }
  }

  const accessToken =
    typeof obj.accessToken === "string" ? obj.accessToken : "";
  const refreshToken =
    typeof obj.refreshToken === "string" ? obj.refreshToken : "";
  const tokenExpiresAt =
    typeof obj.tokenExpiresAt === "number" &&
    Number.isFinite(obj.tokenExpiresAt)
      ? obj.tokenExpiresAt
      : 0;
  const refreshTokenExpiresAt =
    typeof obj.refreshTokenExpiresAt === "number" &&
    Number.isFinite(obj.refreshTokenExpiresAt)
      ? obj.refreshTokenExpiresAt
      : 0;

  // Authenticated state must possess non-empty tokens
  if (status === "authenticated") {
    if (!accessToken || !refreshToken) {
      throw new ValidationError(
        "GitHubAuthState in 'authenticated' status must possess non-empty tokens.",
      );
    }
  }

  return {
    method: "github_app",
    status,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    refreshTokenExpiresAt,
    refreshGeneration: obj.refreshGeneration,
    refreshState,
    activeAttempt,
    predecessorAttempts,
    refreshLeaseEpoch: obj.refreshLeaseEpoch,
    refreshWorkerId:
      typeof obj.refreshWorkerId === "string" ? obj.refreshWorkerId : undefined,
    refreshLockAcquiredAt:
      typeof obj.refreshLockAcquiredAt === "number"
        ? obj.refreshLockAcquiredAt
        : undefined,
    refreshLeaseExpiresAt:
      typeof obj.refreshLeaseExpiresAt === "number"
        ? obj.refreshLeaseExpiresAt
        : undefined,
    installationId:
      typeof obj.installationId === "number" ? obj.installationId : undefined,
    authorizedRepositories,
    user,
    lastValidatedAt:
      typeof obj.lastValidatedAt === "number" ? obj.lastValidatedAt : 0,
    authenticatedAt:
      typeof obj.authenticatedAt === "number" ? obj.authenticatedAt : 0,
  };
}

/**
 * 6-Point Authoritative Response Fencing Predicate.
 * Evaluates whether an incoming HTTP response retains authoritative ownership
 * to mutate credential or lifecycle state.
 *
 * Checks:
 * 1. Generation Lineage: currentAuth.refreshGeneration === response.credentialGeneration
 * 2. Attempt Identity: currentAuth.activeAttempt?.attemptId === response.attemptId
 * 3. Lease Epoch: currentAuth.refreshLeaseEpoch === response.leaseEpoch
 * 4. Worker Ownership: currentAuth.refreshWorkerId === response.workerId
 * 5. Lifecycle State: currentAuth.refreshState === "REFRESHING"
 * 6. Durable Lease Boundary: now <= currentAuth.refreshLeaseExpiresAt
 */
export function isResponseAuthoritative(
  response: RefreshResponseMetadata,
  currentAuth: GitHubAuthState,
  now: number = Date.now(),
): boolean {
  // 1. Generation Fencing: Response must match starting credential version exactly
  if (currentAuth.refreshGeneration !== response.credentialGeneration) {
    return false;
  }

  // 2. Attempt Identity Fencing: Must match the active attempt UUID
  if (
    !currentAuth.activeAttempt ||
    currentAuth.activeAttempt.attemptId !== response.attemptId
  ) {
    return false;
  }

  // 3. Lease Epoch Fencing: Must match current authoritative epoch
  if (currentAuth.refreshLeaseEpoch !== response.leaseEpoch) {
    return false;
  }

  // 4. Worker Ownership Fencing: Must match current lease holder
  if (currentAuth.refreshWorkerId !== response.workerId) {
    return false;
  }

  // 5. Lifecycle State Fencing: System must still be in active REFRESHING state
  if (currentAuth.refreshState !== "REFRESHING") {
    return false;
  }

  // 6. Durable Lease Boundary: Local lease TTL must not have expired
  if (now > (currentAuth.refreshLeaseExpiresAt ?? 0)) {
    return false;
  }

  return true;
}

/**
 * Validates in-memory response data from GitHub OAuth token endpoint.
 */
export function validateRefreshResponseTokens(data: unknown): {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
} {
  if (!data || typeof data !== "object") {
    throw new GitHubAuthError(
      "Malformed token response: expected JSON object.",
      ErrorCode.GITHUB_REFRESH_FAILED,
    );
  }

  const raw = data as Record<string, unknown>;

  if (
    typeof raw.access_token !== "string" ||
    !raw.access_token.startsWith("ghu_")
  ) {
    throw new GitHubAuthError(
      "Malformed token response: invalid or missing user access token (ghu_).",
      ErrorCode.GITHUB_REFRESH_FAILED,
    );
  }

  if (
    typeof raw.refresh_token !== "string" ||
    !raw.refresh_token.startsWith("ghr_")
  ) {
    throw new GitHubAuthError(
      "Malformed token response: invalid or missing refresh token (ghr_).",
      ErrorCode.GITHUB_REFRESH_FAILED,
    );
  }

  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : 28800; // 8h default
  const refreshTokenExpiresIn =
    typeof raw.refresh_token_expires_in === "number"
      ? raw.refresh_token_expires_in
      : 15552000; // 6 months default

  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_in: expiresIn,
    refresh_token_expires_in: refreshTokenExpiresIn,
  };
}
