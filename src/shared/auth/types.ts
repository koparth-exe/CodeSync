/**
 * Domain types and contracts for GitHub Authentication and Token Lifecycle.
 * Implements Phase 1C.1 Architecture Specification.
 */

/**
 * Detailed lifecycle state of an individual refresh attempt.
 * Represented on RefreshAttemptRecord.state.
 *
 * Lifecycle:
 * CREATED -> IN_FLIGHT -> SUCCESS_RECEIVED -> COMMITTED
 *                      -> ERROR_RECEIVED   -> REAUTH_REQUIRED
 *                      -> UNKNOWN          -> RECONCILIATION_REQUIRED
 *                      -> SUPERSEDED
 */
export type AttemptState =
  | "CREATED"
  | "IN_FLIGHT"
  | "SUCCESS_RECEIVED"
  | "COMMITTED"
  | "ERROR_RECEIVED"
  | "UNKNOWN"
  | "SUPERSEDED"
  | "RECONCILIATION_REQUIRED"
  | "REAUTH_REQUIRED";

export type AttemptResolutionStatus =
  | "in_flight"
  | "committed"
  | "dropped_stale"
  | "unknown"
  | "reconciliation_required"
  | "reauth_required";

/**
 * Durable record of an individual refresh attempt.
 * Zero secret storage: tokens are NEVER included in attempt history.
 */
export interface RefreshAttemptRecord {
  readonly attemptId: string;
  readonly credentialGeneration: number;
  readonly leaseEpoch: number;
  readonly workerId: string;
  readonly startedAt: number;
  readonly leaseExpiresAt: number;
  readonly state: AttemptState;
  readonly resolutionStatus: AttemptResolutionStatus;
  readonly errorClassification?: string | undefined;
}

export type GitHubAuthStatus =
  | "unauthenticated"
  | "authenticated"
  | "expired"
  | "revoked"
  | "reconciliation_required"
  | "reauth_required";

/**
 * High-level authentication lifecycle state represented on GitHubAuthState.refreshState.
 * Clearly separated from the detailed attempt-level lifecycle (AttemptState).
 *
 * Lifecycle:
 * IDLE -> REFRESHING -> (authoritative success) -> IDLE + generation increment
 *                    -> (authoritative terminal failure) -> REAUTH_REQUIRED
 *                    -> (uncertain outcome) -> RECONCILIATION_REQUIRED
 *                    -> (stale response/error) -> dropped safely (state unchanged)
 */
export type RefreshLifecycleState =
  "IDLE" | "REFRESHING" | "RECONCILIATION_REQUIRED";

export interface GitHubUser {
  readonly login: string;
  readonly id: number;
  readonly avatarUrl: string;
}

/**
 * Single Logical Object representing cohesive durable authentication state.
 * Stored in browser.storage.local under "codesync:auth".
 */
export interface GitHubAuthState {
  readonly method: "github_app";
  readonly status: GitHubAuthStatus;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiresAt: number;
  readonly refreshTokenExpiresAt: number;
  readonly refreshGeneration: number;
  readonly refreshState: RefreshLifecycleState;
  readonly activeAttempt?: RefreshAttemptRecord | undefined;
  readonly predecessorAttempts: ReadonlyArray<RefreshAttemptRecord>;
  readonly refreshLeaseEpoch: number;
  readonly refreshWorkerId?: string | undefined;
  readonly refreshLockAcquiredAt?: number | undefined;
  readonly refreshLeaseExpiresAt?: number | undefined;
  readonly installationId?: number | undefined;
  readonly authorizedRepositories: ReadonlyArray<string>;
  readonly user: GitHubUser;
  readonly lastValidatedAt: number;
  readonly authenticatedAt: number;
}

/**
 * Metadata carried by token refresh responses for authoritative fencing verification.
 */
export interface RefreshResponseMetadata {
  readonly attemptId: string;
  readonly credentialGeneration: number;
  readonly leaseEpoch: number;
  readonly workerId: string;
}

/**
 * Device Authorization Flow Response (RFC 8628 §3.2).
 */
export interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

/**
 * Successful OAuth Token Response from GitHub (RFC 6749 / RFC 8628).
 */
export interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly scope?: string | undefined;
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly refresh_token_expires_in: number;
}

/**
 * Intermediate polling state during device authorization flow.
 */
export type DevicePollStatus =
  "pending" | "slow_down" | "authorizing" | "complete";

/**
 * Public authentication status sanitized for UI consumption.
 * Strictly excludes tokens and sensitive cryptographic secrets.
 */
export interface AuthPublicStatus {
  readonly isAuthenticated: boolean;
  readonly status: GitHubAuthStatus;
  readonly user?: GitHubUser | undefined;
  readonly tokenExpiresAt?: number | undefined;
  readonly refreshGeneration: number;
  readonly refreshState: RefreshLifecycleState;
}

// Lifecycle Constants
export const REFRESH_LEASE_TTL_MS = 30_000; // 30 seconds
export const REFRESH_HEARTBEAT_INTERVAL_MS = 10_000; // 10 seconds
export const REFRESH_MAX_WORKER_LIFETIME_MS = 300_000; // 5 minutes
export const DEFAULT_PRE_FLIGHT_BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer before expiry
export const MAX_PREDECESSOR_ATTEMPTS = 5;
export const PREDECESSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// GitHub Endpoint URLs
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const GITHUB_API_USER_URL = "https://api.github.com/user";

// Default GitHub App Client ID (public identifier, not a secret)
export const DEFAULT_GITHUB_APP_CLIENT_ID = "Iv1.codesync_app";
