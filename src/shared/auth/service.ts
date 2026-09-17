import {
  DEFAULT_GITHUB_APP_CLIENT_ID,
  GITHUB_API_USER_URL,
  type AuthPublicStatus,
  type DeviceCodeResponse,
  type DevicePollStatus,
  type GitHubAuthState,
  type GitHubUser,
} from "./types";
import {
  createDefaultAuthState,
  validateAuthStateIntegrity,
} from "./state-validator";
import { initiateDeviceFlow, pollDeviceFlow } from "./device-flow";
import {
  DurableTokenLifecycleManager,
  type TokenLifecycleManagerOptions,
} from "./token-lifecycle";
import { StorageService, defaultStorageService } from "../storage/local";
import { STORAGE_KEYS } from "../storage/keys";
import { ErrorCode, GitHubAuthError } from "../errors";

export interface GitHubAuthServiceOptions {
  readonly storage?: StorageService | undefined;
  readonly clientId?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly nowFn?: (() => number) | undefined;
  readonly lifecycleManager?: DurableTokenLifecycleManager | undefined;
}

/**
 * Top-Level GitHub Authentication Service Facade.
 * Orchestrates Device Flow authorization, profile synchronization, token lifecycle,
 * and disconnect behavior under strict security policies.
 */
export class GitHubAuthService {
  private storage: StorageService;
  private clientId: string;
  private fetchFn: typeof fetch;
  private nowFn: () => number;
  private lifecycleManager: DurableTokenLifecycleManager;

  constructor(options: GitHubAuthServiceOptions = {}) {
    this.storage = options.storage ?? defaultStorageService;
    this.clientId = options.clientId ?? DEFAULT_GITHUB_APP_CLIENT_ID;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowFn = options.nowFn ?? Date.now;

    const lifecycleOpts: TokenLifecycleManagerOptions = {
      storage: this.storage,
      clientId: this.clientId,
      fetchFn: this.fetchFn,
      nowFn: this.nowFn,
    };
    this.lifecycleManager =
      options.lifecycleManager ??
      new DurableTokenLifecycleManager(lifecycleOpts);
  }

  /**
   * Retrieves sanitized public authentication status for UI display.
   * Invariant: Never leaks access tokens, refresh tokens, or cryptographic secrets.
   */
  async getAuthStatus(): Promise<AuthPublicStatus> {
    const raw = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
    const auth = validateAuthStateIntegrity(raw);

    const isAuthenticated =
      auth.status === "authenticated" &&
      Boolean(auth.accessToken) &&
      this.nowFn() < auth.tokenExpiresAt;

    return {
      isAuthenticated,
      status: auth.status,
      user: auth.status === "authenticated" ? auth.user : undefined,
      tokenExpiresAt:
        auth.status === "authenticated" ? auth.tokenExpiresAt : undefined,
      refreshGeneration: auth.refreshGeneration,
      refreshState: auth.refreshState,
    };
  }

  /**
   * Initiates GitHub App Device Flow.
   */
  async startLogin(scope: string = "repo"): Promise<DeviceCodeResponse> {
    return await initiateDeviceFlow({
      clientId: this.clientId,
      scope,
      fetchFn: this.fetchFn,
    });
  }

  /**
   * Polls GitHub token endpoint during Device Flow until completion or timeout.
   * Upon successful authorization, fetches user profile and persists initial credential state.
   */
  async pollLogin(
    deviceCode: string,
    interval: number,
    expiresAt: number,
    options?: {
      signal?: AbortSignal;
      onStatus?: (status: DevicePollStatus) => void;
      delayFn?: (ms: number) => Promise<void>;
    },
  ): Promise<AuthPublicStatus> {
    const tokens = await pollDeviceFlow({
      clientId: this.clientId,
      deviceCode,
      interval,
      expiresAt,
      signal: options?.signal,
      onStatus: options?.onStatus,
      fetchFn: this.fetchFn,
      delayFn: options?.delayFn,
      clock: this.nowFn,
    });

    const now = this.nowFn();

    // Fetch user profile from GitHub API
    let user: GitHubUser = { login: "github_user", id: 0, avatarUrl: "" };
    try {
      user = await this.fetchUserProfile(tokens.access_token);
    } catch {
      // Non-fatal profile fetch failure: preserve account tokens with fallback user
    }

    // Persist cohesive authenticated state to browser.storage.local
    const initialAuth: GitHubAuthState = {
      method: "github_app",
      status: "authenticated",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: now + tokens.expires_in * 1000,
      refreshTokenExpiresAt: now + tokens.refresh_token_expires_in * 1000,
      refreshGeneration: 1, // Initial generation G1
      refreshState: "IDLE",
      activeAttempt: undefined,
      predecessorAttempts: [],
      refreshLeaseEpoch: 1, // Initial epoch E1
      authorizedRepositories: [],
      user,
      authenticatedAt: now,
      lastValidatedAt: now,
    };

    await this.storage.set(STORAGE_KEYS.AUTH, initialAuth);

    return {
      isAuthenticated: true,
      status: "authenticated",
      user,
      tokenExpiresAt: initialAuth.tokenExpiresAt,
      refreshGeneration: initialAuth.refreshGeneration,
      refreshState: initialAuth.refreshState,
    };
  }

  /**
   * Returns a valid, fresh access token, rotating credentials if necessary.
   */
  async getValidAccessToken(options?: {
    forceRefresh?: boolean;
    workerId?: string;
  }): Promise<string> {
    return await this.lifecycleManager.getValidAccessToken(options);
  }

  /**
   * Disconnects current GitHub account locally.
   * Public clients cannot call client_secret-authenticated remote revocation endpoints.
   * Wipes local credential state while preserving user configuration and queued submissions.
   */
  async disconnect(): Promise<void> {
    const defaultState = createDefaultAuthState();
    await this.storage.set(STORAGE_KEYS.AUTH, defaultState);
  }

  /**
   * Fetches GitHub user profile using an active user access token.
   */
  async fetchUserProfile(accessToken: string): Promise<GitHubUser> {
    const res = await this.fetchFn(GITHUB_API_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      throw new GitHubAuthError(
        `Failed to fetch user profile: HTTP ${res.status}`,
        ErrorCode.GITHUB_AUTH_REQUIRED,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      login: typeof data.login === "string" ? data.login : "unknown",
      id: typeof data.id === "number" ? data.id : 0,
      avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : "",
    };
  }

  /**
   * Safely reconciles uncertain credential state without blind refresh-token reuse.
   */
  async reconcileState(): Promise<void> {
    const raw = await this.storage.get<unknown>(STORAGE_KEYS.AUTH);
    const auth = validateAuthStateIntegrity(raw);

    if (auth.status !== "reconciliation_required") {
      return;
    }

    // Probe existing access token against GET /user
    if (auth.accessToken) {
      try {
        const user = await this.fetchUserProfile(auth.accessToken);
        // Access token is still valid: restore authenticated state
        const restored: GitHubAuthState = {
          ...auth,
          status: "authenticated",
          refreshState: "IDLE",
          user,
          lastValidatedAt: this.nowFn(),
        };
        await this.storage.set(STORAGE_KEYS.AUTH, restored);
        return;
      } catch {
        // Access token invalid or rejected: fail closed to re-authentication
      }
    }

    // If access token cannot be validated, transition to reauth_required
    const failClosed: GitHubAuthState = {
      ...auth,
      status: "reauth_required",
      refreshState: "IDLE",
      activeAttempt: undefined,
      refreshWorkerId: undefined,
      refreshLeaseExpiresAt: undefined,
    };
    await this.storage.set(STORAGE_KEYS.AUTH, failClosed);
  }

  /**
   * Exposes internal lifecycle manager (for testing and advanced orchestration).
   */
  getLifecycleManager(): DurableTokenLifecycleManager {
    return this.lifecycleManager;
  }
}

export const defaultGitHubAuthService = new GitHubAuthService();
