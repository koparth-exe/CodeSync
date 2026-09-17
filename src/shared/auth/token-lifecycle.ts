import {
  DEFAULT_GITHUB_APP_CLIENT_ID,
  DEFAULT_PRE_FLIGHT_BUFFER_MS,
  GITHUB_OAUTH_TOKEN_URL,
  MAX_PREDECESSOR_ATTEMPTS,
  PREDECESSOR_MAX_AGE_MS,
  REFRESH_LEASE_TTL_MS,
  type GitHubAuthState,
  type RefreshAttemptRecord,
  type RefreshResponseMetadata,
} from "./types";
import {
  isResponseAuthoritative,
  validateAuthStateIntegrity,
  validateRefreshResponseTokens,
} from "./state-validator";
import { StorageService, defaultStorageService } from "../storage/local";
import { STORAGE_KEYS } from "../storage/keys";
import { ErrorCode, GitHubAuthError } from "../errors";
import { getBrowserCapabilities } from "../browser";

export interface TokenLifecycleManagerOptions {
  readonly storage?: StorageService | undefined;
  readonly clientId?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly nowFn?: (() => number) | undefined;
  readonly preFlightBufferMs?: number | undefined;
}

/**
 * Durable Token Lifecycle Manager.
 * Orchestrates multi-worker access-token evaluation, durable refresh coordination,
 * lease-epoch fencing, authoritative response verification, and safe error handling.
 */
export class DurableTokenLifecycleManager {
  private storage: StorageService;
  private clientId: string;
  private fetchFn: typeof fetch;
  private nowFn: () => number;
  private preFlightBufferMs: number;
  private isLockHeld: boolean = false;

  // Interleaving hooks for deterministic race testing
  public onBeforeCommit?: (() => Promise<void>) | undefined;
  public onBeforeDispatch?: (() => Promise<void>) | undefined;
  public onBeforePersistence?: (() => Promise<void>) | undefined;
  public onBeforeErrorPersistence?: (() => Promise<void>) | undefined;

  constructor(options: TokenLifecycleManagerOptions = {}) {
    this.storage = options.storage ?? defaultStorageService;
    this.clientId = options.clientId ?? DEFAULT_GITHUB_APP_CLIENT_ID;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowFn = options.nowFn ?? Date.now;
    this.preFlightBufferMs =
      options.preFlightBufferMs ?? DEFAULT_PRE_FLIGHT_BUFFER_MS;
  }

  /**
   * Helper to execute an action within Tier 1 Web Locks if available.
   * Re-entrancy safe: if the lock is already held in the current execution flow,
   * runs action immediately without deadlocking.
   */
  private async withWebLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.isLockHeld) {
      return await action();
    }

    const caps = getBrowserCapabilities();
    let callbackInvoked = false;

    if (
      caps.supportsWebLocks &&
      typeof navigator !== "undefined" &&
      navigator.locks &&
      typeof navigator.locks.request === "function"
    ) {
      try {
        this.isLockHeld = true;
        return await navigator.locks.request(
          "codesync:auth:refresh",
          { mode: "exclusive" },
          async () => {
            callbackInvoked = true;
            return await action();
          },
        );
      } catch (err) {
        if (callbackInvoked) {
          // Re-throw errors thrown by action() itself; never retry action on business logic error
          throw err;
        }
        // Fallback to Tier 2 persistent lease coordination only if Web Lock request itself failed
        return await action();
      } finally {
        this.isLockHeld = false;
      }
    }

    this.isLockHeld = true;
    try {
      return await action();
    } finally {
      this.isLockHeld = false;
    }
  }

  /**
   * Evaluates current access token and performs durable fenced refresh if expired or near expiry.
   *
   * Fast Path: Token valid beyond pre-flight buffer (5m) -> returns token immediately.
   * Slow Path: Coordinated fenced refresh with Tier 1 Web Locks + Tier 2 persistent lease.
   */
  async getValidAccessToken(options?: {
    forceRefresh?: boolean | undefined;
    workerId?: string | undefined;
    knownGeneration?: number | undefined;
  }): Promise<string> {
    const now = this.nowFn();
    const rawAuth = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
    const currentAuth = validateAuthStateIntegrity(rawAuth);

    // Terminal or unauthenticated state checks
    if (currentAuth.status === "unauthenticated") {
      throw new GitHubAuthError(
        "No GitHub account connected. Please authenticate.",
        ErrorCode.GITHUB_AUTH_REQUIRED,
        "Please connect your GitHub account.",
      );
    }

    if (currentAuth.status === "reauth_required") {
      throw new GitHubAuthError(
        "GitHub credentials require re-authentication.",
        ErrorCode.GITHUB_AUTH_REQUIRED,
        "Re-authentication required. Please connect GitHub again.",
      );
    }

    if (currentAuth.status === "reconciliation_required") {
      throw new GitHubAuthError(
        "Authentication state requires reconciliation before refresh.",
        ErrorCode.GITHUB_RECONCILIATION_REQUIRED,
        "Authentication state is uncertain. Reconciliation required.",
      );
    }

    // Fast-path evaluation: Token valid beyond buffer
    const timeRemaining = currentAuth.tokenExpiresAt - now;
    if (
      !options?.forceRefresh &&
      currentAuth.status === "authenticated" &&
      timeRemaining > this.preFlightBufferMs &&
      currentAuth.refreshState === "IDLE"
    ) {
      return currentAuth.accessToken;
    }

    const knownGeneration =
      options?.knownGeneration ?? currentAuth.refreshGeneration;

    // Slow path: Initiate durable fenced refresh
    return await this.executeCoordinatedRefresh({
      workerId: options?.workerId,
      forceRefresh: options?.forceRefresh,
      knownGeneration,
    });
  }

  /**
   * Coordinates durable persistent lease acquisition and executes fenced refresh request.
   */
  private async executeCoordinatedRefresh(
    options: {
      workerId?: string | undefined;
      forceRefresh?: boolean | undefined;
      knownGeneration?: number | undefined;
    } = {},
  ): Promise<string> {
    const workerId = options.workerId ?? crypto.randomUUID();
    const forceRefresh = options.forceRefresh ?? false;
    const knownGeneration = options.knownGeneration;

    // Step 1 to 3: Persistent Lease Evaluation & Claim under Web Lock
    const claimResult = await this.withWebLock(async () => {
      const now = this.nowFn();

      // Step 1: Read durable state under coordination lock
      const rawAuth = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
      const currentAuth = validateAuthStateIntegrity(rawAuth);

      // Terminal or unauthenticated state checks under lock
      if (currentAuth.status === "unauthenticated") {
        throw new GitHubAuthError(
          "No GitHub account connected. Please authenticate.",
          ErrorCode.GITHUB_AUTH_REQUIRED,
          "Please connect your GitHub account.",
        );
      }

      if (currentAuth.status === "reauth_required") {
        throw new GitHubAuthError(
          "GitHub credentials require re-authentication.",
          ErrorCode.GITHUB_AUTH_REQUIRED,
          "Re-authentication required. Please connect GitHub again.",
        );
      }

      if (currentAuth.status === "reconciliation_required") {
        throw new GitHubAuthError(
          "Authentication state requires reconciliation before refresh.",
          ErrorCode.GITHUB_RECONCILIATION_REQUIRED,
          "Authentication state is uncertain. Reconciliation required.",
        );
      }

      // Check if another concurrent worker already refreshed the token
      const timeRemaining = currentAuth.tokenExpiresAt - now;
      const isAlreadyRefreshed =
        currentAuth.status === "authenticated" &&
        timeRemaining > this.preFlightBufferMs &&
        currentAuth.refreshState === "IDLE" &&
        (!forceRefresh ||
          (knownGeneration !== undefined &&
            currentAuth.refreshGeneration > knownGeneration));

      if (isAlreadyRefreshed) {
        return {
          alreadyRefreshed: true as const,
          token: currentAuth.accessToken,
        };
      }

      // Step 2: Persistent Lease Evaluation
      if (currentAuth.refreshState === "REFRESHING") {
        const leaseExpiry = currentAuth.refreshLeaseExpiresAt ?? 0;
        if (now < leaseExpiry && currentAuth.refreshWorkerId !== workerId) {
          // Active lease held by another worker; yield without mutating
          throw new GitHubAuthError(
            `Active refresh lease held by worker ${currentAuth.refreshWorkerId} until ${leaseExpiry}.`,
            ErrorCode.LEASE_SUPERSEDED,
            "Authentication token is currently being refreshed by another worker.",
          );
        }
        // If now >= leaseExpiry: Previous worker's lease expired. We take over!
      }

      // Step 3: Advance lease epoch and create new attempt
      const nextLeaseEpoch = currentAuth.refreshLeaseEpoch + 1;
      const attemptId = crypto.randomUUID();

      // If an existing attempt was in flight when lease expired, archive as "unknown"
      let updatedPredecessors = [...currentAuth.predecessorAttempts];
      if (currentAuth.activeAttempt) {
        const orphanedAttempt: RefreshAttemptRecord = {
          ...currentAuth.activeAttempt,
          state: "UNKNOWN",
          resolutionStatus: "unknown",
        };
        updatedPredecessors = [orphanedAttempt, ...updatedPredecessors];
      }

      // Prune predecessor history (max 5 records, remove > 7 days old)
      updatedPredecessors = updatedPredecessors
        .filter((att) => now - att.startedAt < PREDECESSOR_MAX_AGE_MS)
        .slice(0, MAX_PREDECESSOR_ATTEMPTS);

      const activeAttempt: RefreshAttemptRecord = {
        attemptId,
        credentialGeneration: currentAuth.refreshGeneration,
        leaseEpoch: nextLeaseEpoch,
        workerId,
        startedAt: now,
        leaseExpiresAt: now + REFRESH_LEASE_TTL_MS,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      };

      const dispatchingState: GitHubAuthState = {
        ...currentAuth,
        refreshState: "REFRESHING",
        refreshLeaseEpoch: nextLeaseEpoch,
        refreshWorkerId: workerId,
        refreshLockAcquiredAt: now,
        refreshLeaseExpiresAt: now + REFRESH_LEASE_TTL_MS,
        activeAttempt,
        predecessorAttempts: updatedPredecessors,
      };

      // Optional test hook before dispatch
      if (this.onBeforeDispatch) {
        await this.onBeforeDispatch();
      }

      // Persist dispatching state to browser.storage.local
      await this.storage.set(STORAGE_KEYS.AUTH, dispatchingState);

      const responseMetadata: RefreshResponseMetadata = {
        attemptId,
        credentialGeneration: currentAuth.refreshGeneration,
        leaseEpoch: nextLeaseEpoch,
        workerId,
      };

      return {
        alreadyRefreshed: false as const,
        responseMetadata,
        refreshToken: currentAuth.refreshToken,
      };
    });

    if (claimResult.alreadyRefreshed) {
      return claimResult.token;
    }

    const { responseMetadata, refreshToken } = claimResult;

    // Step 4: Dispatch outbound HTTP POST to GitHub token refresh endpoint
    let res: Response;
    try {
      res = await this.fetchFn(GITHUB_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
    } catch (netErr) {
      // Network failure during dispatch: evaluate as transient error
      return await this.handleRefreshError(responseMetadata, {
        error: "network_error",
        error_description: (netErr as Error).message,
      });
    }

    let responseJson: Record<string, unknown>;
    try {
      responseJson = (await res.json()) as Record<string, unknown>;
    } catch (parseErr) {
      return await this.handleRefreshError(responseMetadata, {
        error: "malformed_response",
        error_description: (parseErr as Error).message,
      });
    }

    if (res.ok && typeof responseJson.access_token === "string") {
      return await this.handleRefreshSuccess(responseMetadata, responseJson);
    } else {
      const error =
        typeof responseJson.error === "string"
          ? responseJson.error
          : `http_status_${res.status}`;
      const errorDescription =
        typeof responseJson.error_description === "string"
          ? responseJson.error_description
          : undefined;

      return await this.handleRefreshError(responseMetadata, {
        error,
        error_description: errorDescription,
      });
    }
  }

  /**
   * 13-Step Success Response Algorithm (Fenced Credential-State Commit).
   */
  async handleRefreshSuccess(
    response: RefreshResponseMetadata,
    tokenDataRaw: unknown,
  ): Promise<string> {
    // 1. In-memory schema validation of response tokens
    const tokenData = validateRefreshResponseTokens(tokenDataRaw);

    // 2. Initial authority verification under Web Lock
    const initialCheck = await this.withWebLock(async () => {
      const now = this.nowFn();

      // 3. Load current durable auth state from browser.storage.local
      const rawAuth = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);

      // 4. Validate durable storage integrity
      const currentAuth = validateAuthStateIntegrity(rawAuth);

      // Optional test hook before commit
      if (this.onBeforeCommit) {
        await this.onBeforeCommit();
      }

      // 5. Evaluate 6-point Authoritative Response Fencing Predicate
      if (!isResponseAuthoritative(response, currentAuth, now)) {
        // 6. Fencing Failed: Stale response dropped fail-safe
        // 7. If storage generation already advanced, adopt newer tokens
        if (currentAuth.refreshGeneration > response.credentialGeneration) {
          return { proceed: false as const, token: currentAuth.accessToken };
        }

        throw new GitHubAuthError(
          "Refresh response lost authority (stale worker, expired lease, or mismatched epoch).",
          ErrorCode.GITHUB_STALE_RESPONSE,
        );
      }

      return { proceed: true as const, token: "" };
    });

    if (!initialCheck.proceed) {
      return initialCheck.token;
    }

    // Optional test hook immediately at persistence boundary (simulates worker suspension/yield)
    if (this.onBeforePersistence) {
      await this.onBeforePersistence();
    }

    // Pre-persistence final durable reread & authority re-validation under Web Lock (TOCTOU defense)
    return await this.withWebLock(async () => {
      const preCommitRaw = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
      const preCommitAuth = validateAuthStateIntegrity(preCommitRaw);
      const preCommitNow = this.nowFn();

      if (!isResponseAuthoritative(response, preCommitAuth, preCommitNow)) {
        if (preCommitAuth.refreshGeneration > response.credentialGeneration) {
          return preCommitAuth.accessToken;
        }

        throw new GitHubAuthError(
          "Refresh response lost authority at persistence boundary (stale worker, expired lease, or mismatched epoch).",
          ErrorCode.GITHUB_STALE_RESPONSE,
        );
      }

      // 8. Construct updated attempt record
      const resolvedAttempt: RefreshAttemptRecord = {
        ...preCommitAuth.activeAttempt!,
        state: "COMMITTED",
        resolutionStatus: "committed",
      };

      // 9. Prune predecessor history (max 5, prune > 7 days)
      const updatedPredecessors = [
        resolvedAttempt,
        ...preCommitAuth.predecessorAttempts,
      ]
        .filter((att) => preCommitNow - att.startedAt < PREDECESSOR_MAX_AGE_MS)
        .slice(0, MAX_PREDECESSOR_ATTEMPTS);

      // 10. Construct new cohesive credential state (Single Logical Object)
      const nextAuth: GitHubAuthState = {
        ...preCommitAuth,
        status: "authenticated",
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        tokenExpiresAt: preCommitNow + tokenData.expires_in * 1000,
        refreshTokenExpiresAt:
          preCommitNow + tokenData.refresh_token_expires_in * 1000,
        refreshGeneration: preCommitAuth.refreshGeneration + 1, // Monotonic increment G -> G + 1
        refreshState: "IDLE",
        activeAttempt: undefined,
        predecessorAttempts: updatedPredecessors,
        refreshWorkerId: undefined,
        refreshLockAcquiredAt: undefined,
        refreshLeaseExpiresAt: undefined,
        lastValidatedAt: preCommitNow,
      };

      // 11. Single-object fenced credential-state persistence to browser.storage.local
      await this.storage.set(STORAGE_KEYS.AUTH, nextAuth);

      // 12. Return verified access token
      return nextAuth.accessToken;
    });
  }

  /**
   * 12-Step Error Response Algorithm (Fenced Error Evaluation).
   */
  async handleRefreshError(
    response: RefreshResponseMetadata,
    errorData: { error: string; error_description?: string | undefined },
  ): Promise<string> {
    const initialCheck = await this.withWebLock(async () => {
      const now = this.nowFn();

      // 1. Load current durable auth state
      const rawAuth = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
      const currentAuth = validateAuthStateIntegrity(rawAuth);

      // 2. Check Generation Advancement: Newer credentials already committed!
      if (currentAuth.refreshGeneration > response.credentialGeneration) {
        // Discard error, adopt newer tokens
        return {
          action: "return_token" as const,
          token: currentAuth.accessToken,
        };
      }

      // 3. Check Lease Epoch & Worker Authority: If superseded, worker has ZERO authority
      if (
        currentAuth.refreshLeaseEpoch !== response.leaseEpoch ||
        currentAuth.refreshWorkerId !== response.workerId
      ) {
        // Discard stale error without mutating current state
        throw new GitHubAuthError(
          `Obsolete refresh error discarded: ${errorData.error}`,
          ErrorCode.GITHUB_STALE_RESPONSE,
        );
      }

      // 4. Inspect Predecessor History: Did an earlier attempt run for this same generation?
      const hasInFlightPredecessor = currentAuth.predecessorAttempts.some(
        (att) =>
          att.credentialGeneration === response.credentialGeneration &&
          (att.resolutionStatus === "in_flight" ||
            att.resolutionStatus === "unknown"),
      );

      // 5. Same-Generation Error Race Detection
      if (hasInFlightPredecessor) {
        // MUST NOT conclude failure! Transition to RECONCILIATION_REQUIRED
        const updatedAttempt: RefreshAttemptRecord = {
          ...(currentAuth.activeAttempt ?? {
            attemptId: response.attemptId,
            credentialGeneration: response.credentialGeneration,
            leaseEpoch: response.leaseEpoch,
            workerId: response.workerId,
            startedAt: now,
            leaseExpiresAt: now,
            state: "ERROR_RECEIVED",
            resolutionStatus: "unknown",
          }),
          state: "RECONCILIATION_REQUIRED",
          resolutionStatus: "reconciliation_required",
          errorClassification: errorData.error,
        };

        await this.storage.set(STORAGE_KEYS.AUTH, {
          ...currentAuth,
          status: "reconciliation_required",
          refreshState: "RECONCILIATION_REQUIRED",
          activeAttempt: undefined,
          predecessorAttempts: [
            updatedAttempt,
            ...currentAuth.predecessorAttempts,
          ].slice(0, MAX_PREDECESSOR_ATTEMPTS),
          refreshWorkerId: undefined,
          refreshLeaseExpiresAt: undefined,
        });

        throw new GitHubAuthError(
          "Refresh outcome uncertain due to competing predecessor attempt. Reconciliation required.",
          ErrorCode.GITHUB_RECONCILIATION_REQUIRED,
          "Authentication outcome is ambiguous. Reconciliation required.",
        );
      }

      // 6. Determine whether error is authoritative terminal failure
      if (
        errorData.error === "bad_refresh_token" ||
        errorData.error === "invalid_grant"
      ) {
        return { action: "terminal_failure" as const, token: "" };
      }

      // 9. Transient Error (Network glitch, 502/503/504, rate limit): Revert refreshState to IDLE
      if (currentAuth.refreshLeaseEpoch === response.leaseEpoch) {
        await this.storage.set(STORAGE_KEYS.AUTH, {
          ...currentAuth,
          refreshState: "IDLE",
          activeAttempt: undefined,
          refreshWorkerId: undefined,
          refreshLeaseExpiresAt: undefined,
        });
      }

      throw new GitHubAuthError(
        `Transient refresh failure: ${errorData.error}`,
        ErrorCode.GITHUB_REFRESH_FAILED,
        "Temporary connection issue refreshing GitHub token. Will retry automatically.",
      );
    });

    if (initialCheck.action === "return_token") {
      return initialCheck.token;
    }

    // Optional test hook immediately before error persistence boundary (simulates worker suspension/yield)
    if (this.onBeforeErrorPersistence) {
      await this.onBeforeErrorPersistence();
    }

    // Pre-persistence error authority re-validation under Web Lock
    return await this.withWebLock(async () => {
      const recheckNow = this.nowFn();
      const recheckAuth = validateAuthStateIntegrity(
        await this.storage.get<unknown>(STORAGE_KEYS.AUTH),
      );

      if (recheckAuth.refreshGeneration > response.credentialGeneration) {
        return recheckAuth.accessToken;
      }

      if (
        recheckAuth.refreshLeaseEpoch !== response.leaseEpoch ||
        recheckAuth.refreshWorkerId !== response.workerId
      ) {
        throw new GitHubAuthError(
          `Obsolete refresh error discarded at persistence boundary: ${errorData.error}`,
          ErrorCode.GITHUB_STALE_RESPONSE,
        );
      }

      if (recheckNow > (recheckAuth.refreshLeaseExpiresAt ?? 0)) {
        throw new GitHubAuthError(
          `Refresh error arrived after lease expiry: ${errorData.error}`,
          ErrorCode.GITHUB_STALE_RESPONSE,
        );
      }

      // 8. Transition to REAUTH_REQUIRED (Never silently destroy tokens or user preferences)
      const failedAttempt: RefreshAttemptRecord = {
        ...(recheckAuth.activeAttempt ?? {
          attemptId: response.attemptId,
          credentialGeneration: response.credentialGeneration,
          leaseEpoch: response.leaseEpoch,
          workerId: response.workerId,
          startedAt: recheckNow,
          leaseExpiresAt: recheckNow,
          state: "ERROR_RECEIVED",
          resolutionStatus: "unknown",
        }),
        state: "REAUTH_REQUIRED",
        resolutionStatus: "reauth_required",
        errorClassification: errorData.error,
      };

      await this.storage.set(STORAGE_KEYS.AUTH, {
        ...recheckAuth,
        status: "reauth_required",
        refreshState: "IDLE",
        activeAttempt: undefined,
        predecessorAttempts: [
          failedAttempt,
          ...recheckAuth.predecessorAttempts,
        ].slice(0, MAX_PREDECESSOR_ATTEMPTS),
        refreshWorkerId: undefined,
        refreshLeaseExpiresAt: undefined,
      });

      throw new GitHubAuthError(
        `GitHub refresh token is invalid or revoked: ${errorData.error_description || errorData.error}. Re-authentication required.`,
        ErrorCode.GITHUB_AUTH_REQUIRED,
        "GitHub session expired or was revoked. Please log in again.",
      );
    });
  }
}
