import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableTokenLifecycleManager,
  GitHubAuthService,
  createDefaultAuthState,
  isResponseAuthoritative,
  validateAuthStateIntegrity,
  type GitHubAuthState,
  type RefreshAttemptRecord,
  type RefreshResponseMetadata,
} from "../../src/shared/auth";
import { STORAGE_KEYS } from "../../src/shared/storage/keys";
import { StorageService } from "../../src/shared/storage/local";
import type { LocalStorageDriver } from "../../src/shared/storage/local";
import { ErrorCode } from "../../src/shared/errors";
import { redactSensitiveData } from "../../src/shared/logger/redactor";
import { MessageEnvelopeValidator } from "../../src/shared/messaging/validator";
import { GitHubApiClient } from "../../src/shared/github/client";

class MemoryStorageDriver implements LocalStorageDriver {
  public map = new Map<string, unknown>();
  public onBeforeSet?: (() => Promise<void>) | undefined;
  public failNextSet: boolean = false;

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    if (keys === null) {
      for (const [k, v] of this.map.entries()) result[k] = v;
      return result;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      if (this.map.has(k)) {
        result[k] = this.map.get(k);
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("Simulated storage write failure");
    }
    if (this.onBeforeSet) {
      await this.onBeforeSet();
    }
    for (const [k, v] of Object.entries(items)) {
      this.map.set(k, v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const k of keyList) {
      this.map.delete(k);
    }
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

describe("GitHub Authentication & Token Lifecycle Test Suite (Phase 1C.1)", () => {
  let driver: MemoryStorageDriver;
  let storage: StorageService;
  let currentTime: number;

  const mockUser = {
    login: "testuser",
    id: 123456,
    avatarUrl: "https://avatars.githubusercontent.com/u/123456",
  };

  function createAuthenticatedState(
    overrides: Partial<GitHubAuthState> = {},
  ): GitHubAuthState {
    const base = createDefaultAuthState();
    return {
      ...base,
      status: "authenticated",
      accessToken: "ghu_validAccessTokenInitial123",
      refreshToken: "ghr_validRefreshTokenInitial123",
      tokenExpiresAt: currentTime + 28800 * 1000, // 8h in future
      refreshTokenExpiresAt: currentTime + 15552000 * 1000, // 6 months
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshState: "IDLE",
      user: mockUser,
      authenticatedAt: currentTime,
      lastValidatedAt: currentTime,
      ...overrides,
    };
  }

  beforeEach(() => {
    driver = new MemoryStorageDriver();
    storage = new StorageService(driver);
    currentTime = 1_000_000_000;
  });

  // ==========================================================================
  // AUTH-08 to AUTH-12: Core Lifecycle & Rotation
  // ==========================================================================

  it("AUTH-08: Successful token persistence (Single-Object Fenced Persistence)", async () => {
    const initial = createAuthenticatedState();
    await storage.set(STORAGE_KEYS.AUTH, initial);

    const retrievedRaw = await storage.get<unknown>(STORAGE_KEYS.AUTH);
    const verified = validateAuthStateIntegrity(retrievedRaw);

    expect(verified.status).toBe("authenticated");
    expect(verified.accessToken).toBe(initial.accessToken);
    expect(verified.refreshToken).toBe(initial.refreshToken);
    expect(verified.refreshGeneration).toBe(10);
    expect(verified.refreshLeaseEpoch).toBe(42);
  });

  it("AUTH-09: Access-token expiration handling (fast-path vs slow-path)", async () => {
    const initial = createAuthenticatedState({
      tokenExpiresAt: currentTime + 10 * 60 * 1000, // 10 minutes left (> 5m buffer)
    });
    await storage.set(STORAGE_KEYS.AUTH, initial);

    const mockFetch = vi.fn();
    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Fast-path: Token still valid beyond 5-minute buffer; no network call dispatched
    const token = await manager.getValidAccessToken();
    expect(token).toBe(initial.accessToken);
    expect(mockFetch).not.toHaveBeenCalled();

    // Advance time so only 4 minutes left (< 5m buffer) -> triggers refresh
    currentTime += 6 * 60 * 1000;

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "ghu_refreshedTokenNew12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_refreshedRefreshTokenNew12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const refreshedToken = await manager.getValidAccessToken();
    expect(refreshedToken).toBe("ghu_refreshedTokenNew12345");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("AUTH-10, AUTH-11, AUTH-12: Successful refresh, token rotation, and generation increment", async () => {
    const initial = createAuthenticatedState({
      tokenExpiresAt: currentTime - 1000, // Expired
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
    });
    await storage.set(STORAGE_KEYS.AUTH, initial);

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "ghu_rotatedAccessTokenG11_12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_rotatedRefreshTokenG11_12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const resultToken = await manager.getValidAccessToken({
      workerId: "Worker_A",
    });
    expect(resultToken).toBe("ghu_rotatedAccessTokenG11_12345");

    const updatedRaw = await storage.get<unknown>(STORAGE_KEYS.AUTH);
    const updated = validateAuthStateIntegrity(updatedRaw);

    // AUTH-11: Refresh token rotated
    expect(updated.refreshToken).toBe("ghr_rotatedRefreshTokenG11_12345");
    expect(updated.accessToken).toBe("ghu_rotatedAccessTokenG11_12345");

    // AUTH-12: Generation incremented G10 -> G11
    expect(updated.refreshGeneration).toBe(11);

    // Lease epoch incremented 42 -> 43 during attempt
    expect(updated.refreshLeaseEpoch).toBe(43);

    // Reset to IDLE after commit
    expect(updated.refreshState).toBe("IDLE");
    expect(updated.activeAttempt).toBeUndefined();
    expect(updated.refreshWorkerId).toBeUndefined();

    // Predecessor attempt recorded as committed
    expect(updated.predecessorAttempts.length).toBe(1);
    expect(updated.predecessorAttempts[0]?.resolutionStatus).toBe("committed");
    expect(updated.predecessorAttempts[0]?.credentialGeneration).toBe(10);
  });

  // ==========================================================================
  // AUTH-13 to AUTH-17: Fencing Predicate Independent Verifications
  // ==========================================================================

  it("AUTH-13: Refresh attempt ID validation in isResponseAuthoritative", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_A",
      refreshState: "REFRESHING",
      refreshLeaseExpiresAt: currentTime + 20_000,
      activeAttempt: {
        attemptId: "attempt-uuid-correct",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 20_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });

    const response: RefreshResponseMetadata = {
      attemptId: "attempt-uuid-WRONG",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    expect(isResponseAuthoritative(response, auth, currentTime)).toBe(false);
  });

  it("AUTH-14: Lease epoch validation in isResponseAuthoritative", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 43, // Superseded to 43
      refreshWorkerId: "Worker_B",
      refreshState: "REFRESHING",
      refreshLeaseExpiresAt: currentTime + 20_000,
      activeAttempt: {
        attemptId: "attempt-uuid-1",
        credentialGeneration: 10,
        leaseEpoch: 43,
        workerId: "Worker_B",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 20_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });

    const staleResponse: RefreshResponseMetadata = {
      attemptId: "attempt-uuid-1",
      credentialGeneration: 10,
      leaseEpoch: 42, // Stale epoch 42
      workerId: "Worker_B",
    };

    expect(isResponseAuthoritative(staleResponse, auth, currentTime)).toBe(
      false,
    );
  });

  it("AUTH-15: Worker ID validation in isResponseAuthoritative", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_B", // Owned by B
      refreshState: "REFRESHING",
      refreshLeaseExpiresAt: currentTime + 20_000,
      activeAttempt: {
        attemptId: "attempt-uuid-1",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_B",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 20_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });

    const responseFromA: RefreshResponseMetadata = {
      attemptId: "attempt-uuid-1",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A", // Sent by A
    };

    expect(isResponseAuthoritative(responseFromA, auth, currentTime)).toBe(
      false,
    );
  });

  it("AUTH-16: Refresh state validation in isResponseAuthoritative", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_A",
      refreshState: "IDLE", // Not REFRESHING
      refreshLeaseExpiresAt: currentTime + 20_000,
      activeAttempt: {
        attemptId: "attempt-uuid-1",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 20_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });

    const response: RefreshResponseMetadata = {
      attemptId: "attempt-uuid-1",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    expect(isResponseAuthoritative(response, auth, currentTime)).toBe(false);
  });

  it("AUTH-17: Lease expiration rejection (NETWORK COMPLETION != LOCAL MUTATION AUTHORITY)", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_A",
      refreshState: "REFRESHING",
      refreshLeaseExpiresAt: currentTime, // Lease expires right now
      activeAttempt: {
        attemptId: "attempt-uuid-1",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
        startedAt: currentTime - 30_000,
        leaseExpiresAt: currentTime,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });

    const response: RefreshResponseMetadata = {
      attemptId: "attempt-uuid-1",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    // 1 millisecond after lease expiry: authority is permanently revoked
    expect(isResponseAuthoritative(response, auth, currentTime + 1)).toBe(
      false,
    );
  });

  // ==========================================================================
  // AUTH-18 to AUTH-20: Stale Responses & Stale Errors
  // ==========================================================================

  it("AUTH-18: Stale success response dropped fail-safe (STALE_RESPONSE_DROPPED)", async () => {
    // Current storage has already advanced to G11 / E43
    const advanced = createAuthenticatedState({
      accessToken: "ghu_alreadyCommittedG11_12345",
      refreshToken: "ghr_alreadyCommittedG11_12345",
      refreshGeneration: 11,
      refreshLeaseEpoch: 43,
      refreshState: "IDLE",
    });
    await storage.set(STORAGE_KEYS.AUTH, advanced);

    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
    });

    // Stale response from G10 / E42 arrives late
    const staleResponse: RefreshResponseMetadata = {
      attemptId: "stale-attempt-id",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    const tokenData = {
      access_token: "ghu_staleAccessToken12345",
      refresh_token: "ghr_staleRefreshToken12345",
      expires_in: 28800,
      refresh_token_expires_in: 15552000,
    };

    // Should return existing G11 token and drop stale response
    const token = await manager.handleRefreshSuccess(staleResponse, tokenData);
    expect(token).toBe("ghu_alreadyCommittedG11_12345");

    // Storage must NOT have been mutated with stale tokens
    const rechecked = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(rechecked.accessToken).toBe("ghu_alreadyCommittedG11_12345");
    expect(rechecked.refreshGeneration).toBe(11);
  });

  it("AUTH-19 & AUTH-20: Stale error (bad_refresh_token) MUST NOT purge current credentials", async () => {
    // Worker B committed G11
    const currentAuth = createAuthenticatedState({
      accessToken: "ghu_activeValidAccessTokenG11",
      refreshToken: "ghr_activeValidRefreshTokenG11",
      refreshGeneration: 11,
      refreshLeaseEpoch: 43,
      refreshState: "IDLE",
      status: "authenticated",
    });
    await storage.set(STORAGE_KEYS.AUTH, currentAuth);

    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
    });

    // Worker A's stale attempt for G10 returns bad_refresh_token
    const staleResponse: RefreshResponseMetadata = {
      attemptId: "worker-a-attempt",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    const returnedToken = await manager.handleRefreshError(staleResponse, {
      error: "bad_refresh_token",
      error_description: "The refresh token is invalid.",
    });

    // Worker A's stale error is dropped; returns the current valid token
    expect(returnedToken).toBe("ghu_activeValidAccessTokenG11");

    // Storage is untouched; NOT purged, NOT set to reauth_required
    const durable = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(durable.status).toBe("authenticated");
    expect(durable.accessToken).toBe("ghu_activeValidAccessTokenG11");
    expect(durable.refreshGeneration).toBe(11);
  });

  // ==========================================================================
  // AUTH-21 to AUTH-25: Multi-Worker Coordination & Adversarial Races
  // ==========================================================================

  it("AUTH-21: Duplicate in-flight refresh yields to active lease", async () => {
    const refreshingState = createAuthenticatedState({
      refreshState: "REFRESHING",
      refreshWorkerId: "Worker_A",
      refreshLeaseExpiresAt: currentTime + 25_000,
      activeAttempt: {
        attemptId: "attempt-a",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 25_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });
    await storage.set(STORAGE_KEYS.AUTH, refreshingState);

    const managerB = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
    });

    // Worker B attempts to refresh while Worker A has 25s remaining on active lease
    await expect(
      managerB.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_B",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.LEASE_SUPERSEDED,
      }),
    );
  });

  it("AUTH-22, AUTH-23, AUTH-24: Worker A expires, Worker B takes over; late A success/error discarded", async () => {
    // Step 1: Worker A claimed refresh at E42, but lease expires
    const stateWithExpiredLease = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_A",
      refreshState: "REFRESHING",
      refreshLeaseExpiresAt: currentTime - 1000, // Expired!
      activeAttempt: {
        attemptId: "attempt-A-uuid",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
        startedAt: currentTime - 31_000,
        leaseExpiresAt: currentTime - 1000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });
    await storage.set(STORAGE_KEYS.AUTH, stateWithExpiredLease);

    // Step 2: Worker B takes over, acquires E43, and commits G11
    const mockFetchB = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "ghu_workerBCommittedG11_12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_workerBCommittedG11_12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const managerB = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
      fetchFn: mockFetchB as unknown as typeof fetch,
    });

    const tokenB = await managerB.getValidAccessToken({
      forceRefresh: true,
      workerId: "Worker_B",
    });
    expect(tokenB).toBe("ghu_workerBCommittedG11_12345");

    const stateAfterB = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(stateAfterB.refreshGeneration).toBe(11);
    expect(stateAfterB.refreshLeaseEpoch).toBe(43);

    // AUTH-23: Late Worker A success arrives for G10/E42
    const lateResponseA: RefreshResponseMetadata = {
      attemptId: "attempt-A-uuid",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_A",
    };

    const tokenAdopted = await managerB.handleRefreshSuccess(lateResponseA, {
      access_token: "ghu_lateWorkerAToken12345",
      refresh_token: "ghr_lateWorkerARefresh12345",
      expires_in: 28800,
      refresh_token_expires_in: 15552000,
    });

    // Does NOT overwrite G11; adopts B's committed token
    expect(tokenAdopted).toBe("ghu_workerBCommittedG11_12345");

    // AUTH-24: Late Worker A failure arrives for G10/E42
    const tokenAdoptedAfterFail = await managerB.handleRefreshError(
      lateResponseA,
      {
        error: "bad_refresh_token",
      },
    );
    expect(tokenAdoptedAfterFail).toBe("ghu_workerBCommittedG11_12345");

    const finalState = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(finalState.accessToken).toBe("ghu_workerBCommittedG11_12345");
    expect(finalState.refreshGeneration).toBe(11);
  });

  it("AUTH-25: Browser/Service-worker restart recovery during IDLE and REFRESHING", async () => {
    // Restart during IDLE
    const idleState = createAuthenticatedState();
    await storage.set(STORAGE_KEYS.AUTH, idleState);

    const restartedManager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
    });

    const token = await restartedManager.getValidAccessToken();
    expect(token).toBe(idleState.accessToken);

    // Restart after crashed worker left state in REFRESHING with expired lease
    const crashedState = createAuthenticatedState({
      refreshState: "REFRESHING",
      refreshWorkerId: "DeadWorker",
      refreshLeaseExpiresAt: currentTime - 5000, // Expired during restart
      activeAttempt: {
        attemptId: "dead-attempt",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "DeadWorker",
        startedAt: currentTime - 35_000,
        leaseExpiresAt: currentTime - 5000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });
    await storage.set(STORAGE_KEYS.AUTH, crashedState);

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "ghu_recoveredTokenG11_12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_recoveredRefreshTokenG11_12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const recoveryManager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Successor safely takes over, archives dead worker attempt to predecessor history as "unknown"
    const recoveredToken = await recoveryManager.getValidAccessToken({
      forceRefresh: true,
      workerId: "SuccessorWorker",
    });

    expect(recoveredToken).toBe("ghu_recoveredTokenG11_12345");

    const recoveredDurable = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(recoveredDurable.refreshGeneration).toBe(11);
    expect(recoveredDurable.refreshLeaseEpoch).toBe(43);

    // Dead worker attempt archived as unknown
    const archived = recoveredDurable.predecessorAttempts.find(
      (a) => a.attemptId === "dead-attempt",
    );
    expect(archived).toBeDefined();
    expect(archived?.resolutionStatus).toBe("unknown");
  });

  // ==========================================================================
  // AUTH-26 to AUTH-29: Predecessors, Unknown Outcome & Reauth
  // ==========================================================================

  it("AUTH-26: Predecessor history bounded capacity (max 5 records, pruned > 7 days)", async () => {
    const predecessors: RefreshAttemptRecord[] = [];
    for (let i = 0; i < 7; i++) {
      predecessors.push({
        attemptId: `att-${i}`,
        credentialGeneration: 10,
        leaseEpoch: 40 + i,
        workerId: `w-${i}`,
        startedAt: currentTime - i * 1000,
        leaseExpiresAt: currentTime - i * 1000 + 30_000,
        state: "COMMITTED",
        resolutionStatus: "committed",
      });
    }

    const state = createAuthenticatedState({
      predecessorAttempts: predecessors,
    });
    await storage.set(STORAGE_KEYS.AUTH, state);

    // Validation prunes to max 5
    const validated = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(validated.predecessorAttempts.length).toBe(5);
  });

  it("AUTH-27 & AUTH-28: Same-generation error race transitions to RECONCILIATION_REQUIRED, preserving user config", async () => {
    // An earlier attempt for G10 was orphaned in flight
    const inFlightPredecessor: RefreshAttemptRecord = {
      attemptId: "earlier-attempt-uuid",
      credentialGeneration: 10,
      leaseEpoch: 41,
      workerId: "Worker_Prior",
      startedAt: currentTime - 20_000,
      leaseExpiresAt: currentTime + 10_000,
      state: "UNKNOWN",
      resolutionStatus: "in_flight",
    };

    const state = createAuthenticatedState({
      refreshGeneration: 10,
      refreshLeaseEpoch: 42,
      refreshWorkerId: "Worker_Current",
      refreshState: "REFRESHING",
      predecessorAttempts: [inFlightPredecessor],
      authorizedRepositories: ["user/repo1"],
    });
    await storage.set(STORAGE_KEYS.AUTH, state);

    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
    });

    const response: RefreshResponseMetadata = {
      attemptId: "current-attempt-uuid",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_Current",
    };

    // Receives bad_refresh_token, but because earlier attempt was in flight for same G10, outcome is ambiguous!
    await expect(
      manager.handleRefreshError(response, { error: "bad_refresh_token" }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_RECONCILIATION_REQUIRED,
      }),
    );

    const updated = validateAuthStateIntegrity(
      await storage.get<unknown>(STORAGE_KEYS.AUTH),
    );
    expect(updated.status).toBe("reconciliation_required");
    expect(updated.refreshState).toBe("RECONCILIATION_REQUIRED");
    // Non-auth config & repository selection preserved
    expect(updated.authorizedRepositories).toEqual(["user/repo1"]);
  });

  it("AUTH-29: Partial persistence failure fails closed safely", async () => {
    const initial = createAuthenticatedState({
      tokenExpiresAt: currentTime - 1000,
    });
    await storage.set(STORAGE_KEYS.AUTH, initial);

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "ghu_tokenValid1234567890",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_tokenValid1234567890",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const manager = new DurableTokenLifecycleManager({
      storage,
      nowFn: () => currentTime,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Simulate storage write failure during commit
    driver.failNextSet = true;

    await expect(
      manager.getValidAccessToken({ forceRefresh: true }),
    ).rejects.toThrow();
  });

  // ==========================================================================
  // AUTH-30 to AUTH-34: Fencing Mismatches
  // ==========================================================================

  it("AUTH-30: Generation mismatch rejection", () => {
    const auth = createAuthenticatedState({ refreshGeneration: 11 });
    const res: RefreshResponseMetadata = {
      attemptId: "att",
      credentialGeneration: 10, // Mismatch: 10 != 11
      leaseEpoch: 42,
      workerId: "W",
    };
    expect(isResponseAuthoritative(res, auth, currentTime)).toBe(false);
  });

  it("AUTH-31: Attempt ID mismatch rejection", () => {
    const auth = createAuthenticatedState({
      refreshGeneration: 10,
      activeAttempt: {
        attemptId: "expected-uuid",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "W",
        startedAt: currentTime,
        leaseExpiresAt: currentTime + 30_000,
        state: "IN_FLIGHT",
        resolutionStatus: "in_flight",
      },
    });
    const res: RefreshResponseMetadata = {
      attemptId: "different-uuid",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "W",
    };
    expect(isResponseAuthoritative(res, auth, currentTime)).toBe(false);
  });

  it("AUTH-32: Lease epoch mismatch rejection", () => {
    const auth = createAuthenticatedState({ refreshLeaseEpoch: 45 });
    const res: RefreshResponseMetadata = {
      attemptId: "att",
      credentialGeneration: 10,
      leaseEpoch: 44, // Mismatch: 44 != 45
      workerId: "W",
    };
    expect(isResponseAuthoritative(res, auth, currentTime)).toBe(false);
  });

  it("AUTH-33: Worker ID mismatch rejection", () => {
    const auth = createAuthenticatedState({ refreshWorkerId: "Worker_Owner" });
    const res: RefreshResponseMetadata = {
      attemptId: "att",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "Worker_Impostor",
    };
    expect(isResponseAuthoritative(res, auth, currentTime)).toBe(false);
  });

  it("AUTH-34: Refresh state mismatch rejection", () => {
    const auth = createAuthenticatedState({
      refreshState: "RECONCILIATION_REQUIRED",
    });
    const res: RefreshResponseMetadata = {
      attemptId: "att",
      credentialGeneration: 10,
      leaseEpoch: 42,
      workerId: "W",
    };
    expect(isResponseAuthoritative(res, auth, currentTime)).toBe(false);
  });

  // ==========================================================================
  // AUTH-35 to AUTH-36: Message Security & Secret Redaction
  // ==========================================================================

  it("AUTH-35: Message sender/context authorization blocks untrusted content scripts from auth actions", () => {
    const validator = new MessageEnvelopeValidator();
    const now = Date.now();

    const envelope = {
      id: crypto.randomUUID(),
      type: "INITIATE_GITHUB_AUTH",
      payload: {},
      timestamp: now,
      senderContext: "content-script",
    };

    // Untrusted content script attempting to initiate auth must be rejected fail-closed
    expect(() =>
      validator.validateEnvelope(envelope, {
        tab: { id: 101, url: "https://leetcode.com" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: ErrorCode.UNAUTHORIZED_SENDER,
      }),
    );

    // Popup is authorized to initiate auth
    const popupEnvelope = {
      id: crypto.randomUUID(),
      type: "INITIATE_GITHUB_AUTH",
      payload: {},
      timestamp: now,
      senderContext: "popup",
    };

    const validated = validator.validateEnvelope(popupEnvelope, {
      url: "chrome-extension://mock-id/popup.html",
    });
    expect(validated.type).toBe("INITIATE_GITHUB_AUTH");
    expect(validated.senderContext).toBe("popup");
  });

  it("AUTH-36: Secret redaction in logger and errors", () => {
    const rawPayload = {
      access_token: "ghu_secretAccessTokenValue12345",
      refresh_token: "ghr_secretRefreshTokenValue12345",
      device_code: "secret_device_code_12345",
      nested: {
        authorization: "Bearer ghu_nestedBearerToken12345",
      },
    };

    const redacted = redactSensitiveData(rawPayload) as Record<string, unknown>;
    expect(redacted.access_token).toBe("[REDACTED_SENSITIVE_FIELD]");
    expect(redacted.refresh_token).toBe("[REDACTED_SENSITIVE_FIELD]");
    expect(redacted.device_code).toBe("[REDACTED_SENSITIVE_FIELD]");
    expect(redacted.nested).toEqual({
      authorization: "[REDACTED_SENSITIVE_FIELD]",
    });
  });

  // ==========================================================================
  // ADVERSARIAL SCENARIOS (Section 29)
  // ==========================================================================

  describe("Section 29: Adversarial Concurrency Scenarios A–L", () => {
    it("Scenarios A–F: Worker A starts G10/E42, expires, B commits G11/E43; late A success/error rejected", async () => {
      // Scenario A: A starts refresh at G10/E42
      const stateA = createAuthenticatedState({
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshWorkerId: "Worker_A",
        refreshState: "REFRESHING",
        refreshLeaseExpiresAt: currentTime + 30_000,
        activeAttempt: {
          attemptId: "attempt-A-UUID",
          credentialGeneration: 10,
          leaseEpoch: 42,
          workerId: "Worker_A",
          startedAt: currentTime,
          leaseExpiresAt: currentTime + 30_000,
          state: "IN_FLIGHT",
          resolutionStatus: "in_flight",
        },
      });
      await storage.set(STORAGE_KEYS.AUTH, stateA);

      // Scenario B: A lease expires (advance time by 31 seconds)
      currentTime += 31_000;

      // Scenario C & D: B acquires E43 and commits G11
      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_committedTokenByB_G11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_committedRefreshTokenByB_G11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerB = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchB as unknown as typeof fetch,
      });

      const tokenB = await managerB.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_B",
      });
      expect(tokenB).toBe("ghu_committedTokenByB_G11");

      const currentAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(currentAuth.refreshGeneration).toBe(11);
      expect(currentAuth.refreshLeaseEpoch).toBe(43);

      // Scenario E: A returns success for G10/E42
      const responseA: RefreshResponseMetadata = {
        attemptId: "attempt-A-UUID",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
      };

      const resultE = await managerB.handleRefreshSuccess(responseA, {
        access_token: "ghu_staleWorkerAToken",
        refresh_token: "ghr_staleWorkerARefresh",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      });
      // Response is rejected; adopts newer G11 token
      expect(resultE).toBe("ghu_committedTokenByB_G11");

      // Scenario F: A returns bad_refresh_token for G10/E42
      const resultF = await managerB.handleRefreshError(responseA, {
        error: "bad_refresh_token",
      });
      // Response is rejected; MUST NOT purge G11
      expect(resultF).toBe("ghu_committedTokenByB_G11");

      const authAfterF = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(authAfterF.status).toBe("authenticated");
      expect(authAfterF.accessToken).toBe("ghu_committedTokenByB_G11");
      expect(authAfterF.refreshGeneration).toBe(11);
    });

    it("Scenarios G–K: Worker A suspended before persistence, B refreshes, A resumes and attempts stale mutation", async () => {
      // Scenario G: A receives success before B but is suspended before persistence
      const stateA = createAuthenticatedState({
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshWorkerId: "Worker_A",
        refreshState: "REFRESHING",
        refreshLeaseExpiresAt: currentTime + 30_000,
        activeAttempt: {
          attemptId: "attempt-A-UUID",
          credentialGeneration: 10,
          leaseEpoch: 42,
          workerId: "Worker_A",
          startedAt: currentTime,
          leaseExpiresAt: currentTime + 30_000,
          state: "IN_FLIGHT",
          resolutionStatus: "in_flight",
        },
      });
      await storage.set(STORAGE_KEYS.AUTH, stateA);

      // Scenario H: A is suspended; lease expires (+35s); B takes over
      currentTime += 35_000;

      // Scenario I: B refreshes using authoritative credential state and commits G11
      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_tokenCommittedByWorkerB_G11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_refreshTokenCommittedByWorkerB_G11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerB = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchB as unknown as typeof fetch,
      });

      await managerB.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_B",
      });

      // Scenario J: Worker A resumes execution in memory
      // Scenario K: A attempts stale mutation using its cached success data
      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
      });

      const staleMetadataA: RefreshResponseMetadata = {
        attemptId: "attempt-A-UUID",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
      };

      const resultK = await managerA.handleRefreshSuccess(staleMetadataA, {
        access_token: "ghu_staleWorkerATokenShouldBeRejected",
        refresh_token: "ghr_staleWorkerARefreshShouldBeRejected",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      });

      // Expected: Stale mutation rejected, G11 token preserved
      expect(resultK).toBe("ghu_tokenCommittedByWorkerB_G11");

      const finalState = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(finalState.accessToken).toBe("ghu_tokenCommittedByWorkerB_G11");
      expect(finalState.refreshGeneration).toBe(11);
    });

    it("Scenario L: Worker A's network request completes after A's lease has expired (zero grace-period authority)", async () => {
      const stateA = createAuthenticatedState({
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshWorkerId: "Worker_A",
        refreshState: "REFRESHING",
        refreshLeaseExpiresAt: currentTime + 30_000,
        activeAttempt: {
          attemptId: "attempt-A-UUID",
          credentialGeneration: 10,
          leaseEpoch: 42,
          workerId: "Worker_A",
          startedAt: currentTime,
          leaseExpiresAt: currentTime + 30_000,
          state: "IN_FLIGHT",
          resolutionStatus: "in_flight",
        },
      });
      await storage.set(STORAGE_KEYS.AUTH, stateA);

      // Network latency causes request to complete at +31s (> 30s lease)
      currentTime += 31_000;

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
      });

      const responseA: RefreshResponseMetadata = {
        attemptId: "attempt-A-UUID",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
      };

      // Network completion does NOT restore local mutation authority
      await expect(
        managerA.handleRefreshSuccess(responseA, {
          access_token: "ghu_tooLateToken12345",
          refresh_token: "ghr_tooLateRefresh12345",
          expires_in: 28800,
          refresh_token_expires_in: 15552000,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_STALE_RESPONSE,
        }),
      );

      // Credential state was NOT mutated
      const unmutated = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(unmutated.refreshGeneration).toBe(10);
    });
  });

  // ==========================================================================
  // TOCTOU Persistence Boundary & Authority Revocation Tests (Phase 1C.1.1)
  // ==========================================================================

  describe("TOCTOU Persistence Boundary & Mutation Authority (Objective 4)", () => {
    it("AUTH-37 (TOCTOU Real Mutation Race): Worker A pauses at persistence boundary, Worker B commits G11, Worker A resumes: stale mutation rejected fail-closed", async () => {
      // 1. Initial State: G10, E42, IDLE, expired token
      const initial = createAuthenticatedState({
        tokenExpiresAt: currentTime - 1000,
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      // Worker A mock network response
      const mockFetchA = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_staleWorkerAToken_G10",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_staleWorkerARefresh_G10",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Worker B mock network response
      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_newerWorkerBToken_G11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_newerWorkerBRefresh_G11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      let workerBCommitted = false;

      // Synchronization hook: fires at the exact credential persistence boundary
      // immediately after Worker A passed initial authority validation
      managerA.onBeforePersistence = async () => {
        // Step 4: Worker A loses authority / lease expires
        currentTime += 35_000;

        // Step 5: Worker B acquires successor lease (epoch 43 -> 44)
        const managerB = new DurableTokenLifecycleManager({
          storage,
          nowFn: () => currentTime,
          fetchFn: mockFetchB as unknown as typeof fetch,
        });

        // Step 6 & 7: Worker B becomes authoritative and commits G10 -> G11
        const tokenB = await managerB.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_B",
        });
        expect(tokenB).toBe("ghu_newerWorkerBToken_G11");
        workerBCommitted = true;
      };

      // Step 1: Worker A initiates refresh, acquires lease, passes initial authority check
      // Step 8 & 9: Worker A resumes and attempts stale mutation
      const resultA = await managerA.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_A",
      });

      expect(workerBCommitted).toBe(true);

      // Step 10: Stale mutation is rejected; Worker A adopts Worker B's newer G11 token
      expect(resultA).toBe("ghu_newerWorkerBToken_G11");

      // Verify persistent storage guarantees:
      const finalAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      // G11 remains intact
      expect(finalAuth.refreshGeneration).toBe(11);
      // Worker B's tokens remain current
      expect(finalAuth.accessToken).toBe("ghu_newerWorkerBToken_G11");
      expect(finalAuth.refreshToken).toBe("ghr_newerWorkerBRefresh_G11");
      // Worker A's stale credentials were NOT written
      expect(finalAuth.accessToken).not.toBe("ghu_staleWorkerAToken_G10");
      expect(finalAuth.refreshToken).not.toBe("ghr_staleWorkerARefresh_G10");
      expect(finalAuth.refreshLeaseEpoch).toBe(44);
      expect(finalAuth.status).toBe("authenticated");
    });

    it("AUTH-38 (TOCTOU Stale Error Path): Worker A pauses at error persistence boundary, Worker B commits G11, Worker A resumes: stale error dropped, no reauth_required", async () => {
      // 1. Initial State: G10, E42, IDLE, expired token
      const initial = createAuthenticatedState({
        tokenExpiresAt: currentTime - 1000,
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      // Worker A receives bad_refresh_token
      const mockFetchA = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: "bad_refresh_token",
            error_description: "The refresh token is invalid.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Worker B receives success
      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_newerWorkerBToken_G11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_newerWorkerBRefresh_G11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      // Worker A pauses at the error persistence boundary
      managerA.onBeforeErrorPersistence = async () => {
        currentTime += 35_000; // Worker A's lease expires

        const managerB = new DurableTokenLifecycleManager({
          storage,
          nowFn: () => currentTime,
          fetchFn: mockFetchB as unknown as typeof fetch,
        });

        // Worker B commits G11
        await managerB.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_B",
        });
      };

      // Worker A resumes and executes error persistence check
      const resultA = await managerA.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_A",
      });

      // Stale error dropped, newer token adopted
      expect(resultA).toBe("ghu_newerWorkerBToken_G11");

      const finalAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      // Status MUST NOT be reauth_required
      expect(finalAuth.status).toBe("authenticated");
      expect(finalAuth.refreshGeneration).toBe(11);
      expect(finalAuth.accessToken).toBe("ghu_newerWorkerBToken_G11");
      expect(finalAuth.refreshToken).toBe("ghr_newerWorkerBRefresh_G11");
    });

    it("AUTH-39 (TOCTOU Lease Expiry at Persistence Boundary Without Successor): Lease expires before write, mutation rejected fail-closed", async () => {
      const initial = createAuthenticatedState({
        tokenExpiresAt: currentTime - 1000,
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetchA = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_workerAToken",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_workerARefresh",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Pause at persistence boundary and let lease expire without any successor running
      managerA.onBeforePersistence = async () => {
        currentTime += 35_000; // Lease expires (+35s > 30s TTL)
      };

      // Mutation must be rejected fail-closed due to expired lease
      await expect(
        managerA.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_A",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_STALE_RESPONSE,
        }),
      );

      // Storage was not mutated
      const finalAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(finalAuth.refreshGeneration).toBe(10);
      expect(finalAuth.accessToken).toBe(initial.accessToken);
    });

    it("AUTH-40 (TOCTOU Stale Error Arriving After Lease Expiry Without Successor): Stale error cannot cause reauth_required", async () => {
      const initial = createAuthenticatedState({
        tokenExpiresAt: currentTime - 1000,
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetchA = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: "bad_refresh_token",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Lease expires before error persistence
      managerA.onBeforeErrorPersistence = async () => {
        currentTime += 35_000;
      };

      await expect(
        managerA.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_A",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_STALE_RESPONSE,
        }),
      );

      // Credentials remain preserved; NOT purged to reauth_required
      const finalAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(finalAuth.status).toBe("authenticated");
      expect(finalAuth.refreshGeneration).toBe(10);
      expect(finalAuth.accessToken).toBe(initial.accessToken);
    });
  });

  // ==========================================================================
  // GitHubAuthService Facade & Disconnect Tests
  // ==========================================================================

  describe("GitHubAuthService Facade", () => {
    it("getAuthStatus sanitizes secrets and exposes public status", async () => {
      const auth = createAuthenticatedState();
      await storage.set(STORAGE_KEYS.AUTH, auth);

      const service = new GitHubAuthService({
        storage,
        nowFn: () => currentTime,
      });

      const status = await service.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.status).toBe("authenticated");
      expect(status.user?.login).toBe("testuser");
      expect(status.refreshGeneration).toBe(10);
      // Secrets must NOT be present
      expect(
        (status as unknown as Record<string, unknown>).accessToken,
      ).toBeUndefined();
      expect(
        (status as unknown as Record<string, unknown>).refreshToken,
      ).toBeUndefined();
    });

    it("disconnect clears credentials locally and resets to unauthenticated", async () => {
      const auth = createAuthenticatedState();
      await storage.set(STORAGE_KEYS.AUTH, auth);

      const service = new GitHubAuthService({
        storage,
        nowFn: () => currentTime,
      });

      await service.disconnect();

      const durable = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(durable.status).toBe("unauthenticated");
      expect(durable.accessToken).toBe("");
      expect(durable.refreshToken).toBe("");
      expect(durable.refreshGeneration).toBe(0);
    });
  });

  // ==========================================================================
  // Phase 1C.4.3.3.2: AUTH-FORCE-01 to AUTH-FORCE-08 (DEFECT-1C.4.3.3.1-01)
  // ==========================================================================
  describe("Phase 1C.4.3.3.2 — Token Lifecycle Coordinated Force-Refresh Regression Suite", () => {
    it("AUTH-FORCE-01: A locally unexpired access token must still be force-refreshed when forceRefresh=true", async () => {
      const initial = createAuthenticatedState({
        accessToken: "ghu_unexpired_but_rejected_token",
        tokenExpiresAt: currentTime + 8 * 3600 * 1000,
        refreshGeneration: 10,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_newly_forced_refreshed_token",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_newly_rotated_refresh_token",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const manager = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const resultToken = await manager.getValidAccessToken({
        forceRefresh: true,
      });

      expect(resultToken).toBe("ghu_newly_forced_refreshed_token");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const updated = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(updated.refreshGeneration).toBe(11);
      expect(updated.accessToken).toBe("ghu_newly_forced_refreshed_token");
      expect(updated.refreshToken).toBe("ghr_newly_rotated_refresh_token");
      expect(updated.refreshState).toBe("IDLE");
    });

    it("AUTH-FORCE-02: A genuine newer refreshGeneration committed by another worker may satisfy a force-refresh caller without an unnecessary second refresh", async () => {
      // Worker A observes generation 10
      const initial = createAuthenticatedState({
        accessToken: "ghu_token_g10",
        refreshGeneration: 10,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetchA = vi.fn();
      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Worker B commits generation 11 before Worker A's coordinated refresh runs
      const updatedByWorkerB = createAuthenticatedState({
        accessToken: "ghu_workerB_token_g11",
        refreshToken: "ghr_workerB_refresh_g11",
        refreshGeneration: 11,
        refreshState: "IDLE",
        tokenExpiresAt: currentTime + 8 * 3600 * 1000,
      });
      await storage.set(STORAGE_KEYS.AUTH, updatedByWorkerB);

      // Worker A requests force-refresh, specifying knownGeneration 10 (or having observed G10)
      const resultA = await managerA.getValidAccessToken({
        forceRefresh: true,
        knownGeneration: 10,
        workerId: "Worker_A",
      });

      // Worker A safely adopts Worker B's newly committed G11 token without refreshing again
      expect(resultA).toBe("ghu_workerB_token_g11");
      expect(mockFetchA).toHaveBeenCalledTimes(0);

      const current = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(current.refreshGeneration).toBe(11);
      expect(current.accessToken).toBe("ghu_workerB_token_g11");
    });

    it("AUTH-FORCE-03: Concurrent forced refresh requests do not create an uncontrolled refresh storm", async () => {
      // 1. Initial authenticated state with active lease held by Worker A
      const refreshingState = createAuthenticatedState({
        accessToken: "ghu_rejected_old_token",
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshWorkerId: "Worker_A",
        refreshState: "REFRESHING",
        refreshLeaseExpiresAt: currentTime + 25_000,
        activeAttempt: {
          attemptId: "attempt-worker-a",
          credentialGeneration: 10,
          leaseEpoch: 42,
          workerId: "Worker_A",
          startedAt: currentTime,
          leaseExpiresAt: currentTime + 25_000,
          state: "IN_FLIGHT",
          resolutionStatus: "in_flight",
        },
      });
      await storage.set(STORAGE_KEYS.AUTH, refreshingState);

      const mockFetchB = vi.fn();
      const managerB = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchB as unknown as typeof fetch,
      });

      // 2. While Worker A holds an active lease, Worker B's forced refresh request is rejected
      await expect(
        managerB.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_B",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.LEASE_SUPERSEDED,
        }),
      );

      // Invariant: Worker B did NOT make an outbound OAuth request (no refresh storm)
      expect(mockFetchB).toHaveBeenCalledTimes(0);

      // 3. Worker A commits the refresh response to Generation 11
      const responseA: RefreshResponseMetadata = {
        attemptId: "attempt-worker-a",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
      };

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
      });

      const tokenCommittedByA = await managerA.handleRefreshSuccess(responseA, {
        access_token: "ghu_workerA_committed_token_g11",
        token_type: "bearer",
        expires_in: 28800,
        refresh_token: "ghr_workerA_committed_refresh_g11",
        refresh_token_expires_in: 15552000,
      });
      expect(tokenCommittedByA).toBe("ghu_workerA_committed_token_g11");

      // 4. Worker B now calls getValidAccessToken with knownGeneration 10
      // Worker B must consume Worker A's generation 11 token without a second refresh
      const tokenConsumedByB = await managerB.getValidAccessToken({
        forceRefresh: true,
        knownGeneration: 10,
        workerId: "Worker_B",
      });

      expect(tokenConsumedByB).toBe("ghu_workerA_committed_token_g11");
      expect(mockFetchB).toHaveBeenCalledTimes(0);

      const finalState = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(finalState.refreshGeneration).toBe(11);
      expect(finalState.accessToken).toBe("ghu_workerA_committed_token_g11");
      expect(finalState.refreshState).toBe("IDLE");
    });

    it("AUTH-FORCE-04: A stale worker cannot overwrite a newer credential generation", async () => {
      const initial = createAuthenticatedState({
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetchA = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_stale_workerA_g10",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_stale_workerA_g10",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_newer_workerB_g11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_newer_workerB_g11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerA = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchA as unknown as typeof fetch,
      });

      // Worker A pauses at persistence boundary
      managerA.onBeforePersistence = async () => {
        currentTime += 35_000; // Worker A's lease expires

        const managerB = new DurableTokenLifecycleManager({
          storage,
          nowFn: () => currentTime,
          fetchFn: mockFetchB as unknown as typeof fetch,
        });

        // Worker B takes over and commits G10 -> G11
        const tokenB = await managerB.getValidAccessToken({
          forceRefresh: true,
          workerId: "Worker_B",
        });
        expect(tokenB).toBe("ghu_newer_workerB_g11");
      };

      const resultA = await managerA.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_A",
      });

      // Stale Worker A cannot overwrite G11, adopts Worker B's token
      expect(resultA).toBe("ghu_newer_workerB_g11");

      const finalAuth = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(finalAuth.refreshGeneration).toBe(11);
      expect(finalAuth.accessToken).toBe("ghu_newer_workerB_g11");
    });

    it("AUTH-FORCE-05: Refresh-token rotation remains durable and stale workers cannot regress it", async () => {
      const initial = createAuthenticatedState({
        refreshToken: "ghr_initial_g10",
        refreshGeneration: 10,
        refreshLeaseEpoch: 42,
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetchB = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            access_token: "ghu_token_g11",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_rotated_refresh_g11",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const managerB = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetchB as unknown as typeof fetch,
      });

      await managerB.getValidAccessToken({
        forceRefresh: true,
        workerId: "Worker_B",
      });

      const stateAfterB = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(stateAfterB.refreshToken).toBe("ghr_rotated_refresh_g11");
      expect(stateAfterB.refreshGeneration).toBe(11);

      // Now a stale response from Worker A for generation 10 arrives
      const staleResponseA: RefreshResponseMetadata = {
        attemptId: "stale-attempt-id",
        credentialGeneration: 10,
        leaseEpoch: 42,
        workerId: "Worker_A",
      };

      const adoptedToken = await managerB.handleRefreshSuccess(staleResponseA, {
        access_token: "ghu_stale_token_g10",
        refresh_token: "ghr_stale_refresh_g10",
        expires_in: 28800,
        refresh_token_expires_in: 15552000,
      });

      expect(adoptedToken).toBe("ghu_token_g11");

      const finalState = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      // Rotation remains durable: stale refresh token was NOT written
      expect(finalState.refreshToken).toBe("ghr_rotated_refresh_g11");
      expect(finalState.refreshGeneration).toBe(11);
    });

    it("AUTH-FORCE-06: A failed forced refresh transitions to the existing reauth-required state and remains durable", async () => {
      const initial = createAuthenticatedState({
        tokenExpiresAt: currentTime + 8 * 3600 * 1000,
        refreshGeneration: 10,
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: "bad_refresh_token",
            error_description: "The refresh token is invalid or revoked.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      });

      const manager = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      await expect(
        manager.getValidAccessToken({ forceRefresh: true }),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_AUTH_REQUIRED,
        }),
      );

      const durable = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(durable.status).toBe("reauth_required");
      expect(durable.refreshState).toBe("IDLE");

      // Subsequent access attempts fail closed immediately without network request
      await expect(manager.getValidAccessToken()).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_AUTH_REQUIRED,
        }),
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("AUTH-FORCE-07: Normal non-force token acquisition still uses the existing valid-token fast path", async () => {
      const initial = createAuthenticatedState({
        accessToken: "ghu_fast_path_valid_token",
        tokenExpiresAt: currentTime + 8 * 3600 * 1000,
        refreshGeneration: 10,
        refreshState: "IDLE",
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      const mockFetch = vi.fn();
      const manager = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const token = await manager.getValidAccessToken();
      expect(token).toBe("ghu_fast_path_valid_token");
      expect(mockFetch).toHaveBeenCalledTimes(0);

      // Storage untouched
      const durable = validateAuthStateIntegrity(
        await storage.get<unknown>(STORAGE_KEYS.AUTH),
      );
      expect(durable.refreshGeneration).toBe(10);
      expect(durable.accessToken).toBe("ghu_fast_path_valid_token");
    });

    it("AUTH-FORCE-08: 401 → forced refresh → retry remains bounded to the existing single API retry", async () => {
      const initial = createAuthenticatedState({
        accessToken: "ghu_initial_invalid_token",
        tokenExpiresAt: currentTime + 8 * 3600 * 1000,
        refreshGeneration: 10,
      });
      await storage.set(STORAGE_KEYS.AUTH, initial);

      let oauthRefreshCount = 0;
      const oauthFetch = vi.fn(async () => {
        oauthRefreshCount++;
        return new Response(
          JSON.stringify({
            access_token: "ghu_refreshed_but_still_unauthorized_token",
            token_type: "bearer",
            expires_in: 28800,
            refresh_token: "ghr_new_refresh_token",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const manager = new DurableTokenLifecycleManager({
        storage,
        nowFn: () => currentTime,
        fetchFn: oauthFetch as unknown as typeof fetch,
      });

      let apiCallCount = 0;
      const apiFetch = vi.fn(async () => {
        apiCallCount++;
        // Both attempts return 401
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      });

      const client = new GitHubApiClient({
        baseUrl: "https://api.github.com",
        fetchFn: apiFetch as unknown as typeof fetch,
        lifecycleManager: manager,
      });

      // Must reject terminally with GITHUB_UNAUTHORIZED
      await expect(
        client.getRepository("test-owner", "test-repo"),
      ).rejects.toThrowError(
        expect.objectContaining({
          code: ErrorCode.GITHUB_UNAUTHORIZED,
        }),
      );

      // Invariant: Exactly 1 forced refresh occurred
      expect(oauthRefreshCount).toBe(1);
      // Invariant: Exactly 2 API calls occurred (initial + single retry)
      expect(apiCallCount).toBe(2);
    });
  });
});
