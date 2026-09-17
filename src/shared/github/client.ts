import {
  ErrorCode,
  GitHubApiError,
  GitHubConflictError,
  GitHubRateLimitError,
  type GitHubRateLimitInfo,
} from "../errors";
import { redactString } from "../logger/redactor";
import { computeContentHash, normalizeSourceCode } from "../deduplication";
import { validateAndCanonicalizePath } from "./path-engine";
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  GITHUB_ACCEPT_HEADER,
  GITHUB_API_BASE_URL,
  GITHUB_REST_API_VERSION,
  MAX_SOURCE_PAYLOAD_BYTES,
  type GitHubBranch,
  type GitHubContentFile,
  type GitHubContentsWritePayload,
  type GitHubContentsWriteResponse,
  type GitHubInstallation,
  type GitHubObjectType,
  type GitHubRepository,
} from "./types";
import type { DurableTokenLifecycleManager } from "../auth/token-lifecycle";

/**
 * Validates a GitHub repository owner or repository name segment.
 * Rejects whitespace, traversal, slashes, or hostile control characters.
 */
const REPO_SEGMENT_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * Validates a Git branch ref name according to CodeSync's conservative local grammar.
 */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._/-]+$/;

export interface GitHubApiClientOptions {
  readonly baseUrl?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly tokenSupplier?: (() => Promise<string>) | undefined;
  readonly lifecycleManager?: DurableTokenLifecycleManager | undefined;
}

/**
 * Cross-environment safe Base64 encoder for UTF-8 strings.
 */
export function safeBase64Encode(input: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(input, "utf-8").toString("base64");
  }
  // Browser fallback using TextEncoder/Uint8Array or encodeURIComponent/btoa
  return btoa(unescape(encodeURIComponent(input)));
}

/**
 * Cross-environment safe Base64 decoder for UTF-8 strings.
 * Rejects malformed or corrupted Base64 payloads fail-closed.
 */
export function safeBase64Decode(input: string): string {
  const clean = input.replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(clean, "base64");
    return buf.toString("utf-8");
  }
  try {
    return decodeURIComponent(escape(atob(clean)));
  } catch {
    throw new GitHubApiError(
      "Failed to decode Base64 payload from GitHub Contents API.",
      { code: ErrorCode.VALIDATION_FAILED },
    );
  }
}

/**
 * Centralized GitHub REST API Client.
 *
 * Enforces:
 * - HTTPS-only communication directly with api.github.com.
 * - Explicit version header (2022-11-28) and JSON accept header.
 * - cache: "no-store" for all authorization and conflict-sensitive queries.
 * - AbortController-based request timeouts.
 * - Centralized token injection (never exposed to callers or logged).
 * - Safe URL construction preventing scheme, host, query, or path injection.
 * - Coordinated 401 handling with DurableTokenLifecycleManager.
 * - Structured error taxonomy and secret redaction.
 */
export class GitHubApiClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private tokenSupplier?: (() => Promise<string>) | undefined;
  private lifecycleManager?: DurableTokenLifecycleManager | undefined;

  constructor(options: GitHubApiClientOptions = {}) {
    const rawUrl = options.baseUrl ?? GITHUB_API_BASE_URL;

    // Invariant: Enforce HTTPS-only for all GitHub API communication
    if (!rawUrl.startsWith("https://")) {
      throw new GitHubApiError(
        `Insecure GitHub API base URL rejected: "${rawUrl}". HTTPS is strictly mandatory.`,
        { code: ErrorCode.SECURITY_VIOLATION },
      );
    }

    this.baseUrl = rawUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.tokenSupplier = options.tokenSupplier;
    this.lifecycleManager = options.lifecycleManager;
  }

  /**
   * Retrieves an active, valid user access token via lifecycle manager or token supplier.
   */
  private async getAccessToken(forceRefresh: boolean = false): Promise<string> {
    if (this.lifecycleManager) {
      return await this.lifecycleManager.getValidAccessToken({ forceRefresh });
    }
    if (this.tokenSupplier) {
      return await this.tokenSupplier();
    }
    throw new GitHubApiError(
      "No GitHub authentication token or supplier configured.",
      { code: ErrorCode.GITHUB_AUTH_REQUIRED },
    );
  }

  /**
   * Constructs a secure, injection-proof GitHub API URL.
   * Path components are validated before URL construction and encoded safely.
   */
  private buildSafeUrl(
    pathSegments: readonly string[],
    queryParams?: Record<string, string | undefined>,
  ): string {
    // Validate that no segment contains CRLF, null bytes, or protocol injection
    for (const segment of pathSegments) {
      if (/[\r\n\0]/.test(segment)) {
        throw new GitHubApiError(
          "Hostile characters detected in API URL path segment.",
          { code: ErrorCode.SECURITY_VIOLATION },
        );
      }
    }

    const encodedPath = pathSegments
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const url = new URL(`${this.baseUrl}/${encodedPath}`);

    if (queryParams) {
      for (const [key, val] of Object.entries(queryParams)) {
        if (val !== undefined && val !== null && val !== "") {
          url.searchParams.set(key, val);
        }
      }
    }

    return url.toString();
  }

  /**
   * Parses rate limit information from GitHub response headers.
   */
  private extractRateLimit(headers: Headers): GitHubRateLimitInfo | undefined {
    const limitStr = headers.get("x-ratelimit-limit");
    const remainingStr = headers.get("x-ratelimit-remaining");
    const resetStr = headers.get("x-ratelimit-reset");
    const retryAfterStr = headers.get("retry-after");

    if (!limitStr && !remainingStr && !resetStr) {
      return undefined;
    }

    const limit = limitStr ? parseInt(limitStr, 10) : 5000;
    const remaining = remainingStr ? parseInt(remainingStr, 10) : 5000;
    const resetTimestamp = resetStr ? parseInt(resetStr, 10) * 1000 : 0;
    const retryAfterSeconds = retryAfterStr
      ? parseInt(retryAfterStr, 10)
      : undefined;

    return {
      limit: isNaN(limit) ? 5000 : limit,
      remaining: isNaN(remaining) ? 5000 : remaining,
      resetTimestamp: isNaN(resetTimestamp) ? 0 : resetTimestamp,
      retryAfterSeconds:
        retryAfterSeconds && !isNaN(retryAfterSeconds)
          ? retryAfterSeconds
          : undefined,
    };
  }

  /**
   * Centralized HTTP request execution engine.
   * Handles authentication, timeouts, rate limits, 401 refreshes, and structured errors.
   */
  public async request<T>(
    endpointUrl: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      allow404?: boolean;
    } = {},
  ): Promise<{ data: T | null; status: number; headers: Headers }> {
    const method = options.method ?? "GET";
    const token = await this.getAccessToken(false);

    const executeAttempt = async (
      authToken: string,
    ): Promise<{ data: T | null; status: number; headers: Headers }> => {
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);

      const headers: Record<string, string> = {
        Accept: GITHUB_ACCEPT_HEADER,
        "X-GitHub-Api-Version": GITHUB_REST_API_VERSION,
        Authorization: `Bearer ${authToken}`,
      };

      const fetchInit: RequestInit = {
        method,
        headers,
        cache: "no-store", // Invariant: no-store for authorization/conflict-sensitive requests
        signal: controller.signal,
      };

      if (options.body) {
        headers["Content-Type"] = "application/json";
        fetchInit.body = JSON.stringify(options.body);
      }

      try {
        const res = await this.fetchFn(endpointUrl, fetchInit);

        clearTimeout(timeoutTimer);
        const rateLimit = this.extractRateLimit(res.headers);

        // 404 handling: if allowed, return null data
        if (res.status === 404 && options.allow404) {
          return { data: null, status: 404, headers: res.headers };
        }

        // Rate Limit Classification (Primary & Secondary)
        //
        // Primary rate limit: 429, or 403 with x-ratelimit-remaining === 0
        // Secondary rate limit: 403 with Retry-After header present but remaining > 0
        //   (GitHub abuse detection / anti-spam throttle — NOT an authorization failure)
        // Authorization failure: 403 without rate-limit indicators
        if (res.status === 429) {
          throw new GitHubRateLimitError(
            `GitHub API primary rate limit exhausted (HTTP 429). Resets at ${rateLimit?.resetTimestamp ?? 0}`,
            {
              resetTimestamp: rateLimit?.resetTimestamp ?? Date.now() + 60_000,
              retryAfterSeconds: rateLimit?.retryAfterSeconds,
              endpoint: endpointUrl,
              rateLimit,
              isSecondary: false,
            },
          );
        }

        if (res.status === 403) {
          // Case 1: Primary rate limit exhaustion (x-ratelimit-remaining === 0)
          if (rateLimit && rateLimit.remaining === 0) {
            throw new GitHubRateLimitError(
              `GitHub API primary rate limit exhausted (HTTP 403, remaining: 0). Resets at ${rateLimit.resetTimestamp}`,
              {
                resetTimestamp: rateLimit.resetTimestamp,
                retryAfterSeconds: rateLimit.retryAfterSeconds,
                endpoint: endpointUrl,
                rateLimit,
                isSecondary: false,
              },
            );
          }

          // Case 2: Secondary rate limit (Retry-After present, remaining > 0)
          // GitHub sends 403 + Retry-After for abuse detection without zeroing remaining.
          const retryAfterHeader = res.headers.get("retry-after");
          if (retryAfterHeader) {
            const retryAfterSec = parseInt(retryAfterHeader, 10);
            const validRetryAfter = !isNaN(retryAfterSec) ? retryAfterSec : 60;
            throw new GitHubRateLimitError(
              `GitHub API secondary rate limit triggered (HTTP 403, Retry-After: ${validRetryAfter}s). ` +
                `This is abuse detection, NOT an authorization failure.`,
              {
                resetTimestamp: Date.now() + validRetryAfter * 1000,
                retryAfterSeconds: validRetryAfter,
                endpoint: endpointUrl,
                rateLimit,
                isSecondary: true,
              },
            );
          }

          // Case 3: Genuine authorization/permission failure (no rate-limit indicators)
          // Fall through to generic non-2xx handler below with GITHUB_FORBIDDEN code
        }

        // 409 Conflict handling (optimistic concurrency conflict)
        if (res.status === 409) {
          throw new GitHubConflictError(
            `GitHub Contents write conflict (HTTP 409) on ${endpointUrl}. TOCTOU race detected.`,
            {
              path: endpointUrl,
              endpoint: endpointUrl,
            },
          );
        }

        // Other non-2xx errors
        if (!res.ok) {
          let errorDetail = "";
          try {
            const errJson = (await res.json()) as { message?: string };
            if (errJson && typeof errJson.message === "string") {
              errorDetail = redactString(errJson.message);
            }
          } catch {
            // Ignore response parsing error on non-ok status
          }

          let code = ErrorCode.GITHUB_API_ERROR;
          if (res.status === 401) code = ErrorCode.GITHUB_UNAUTHORIZED;
          else if (res.status === 403) code = ErrorCode.GITHUB_FORBIDDEN;
          else if (res.status === 404) code = ErrorCode.GITHUB_NOT_FOUND;

          throw new GitHubApiError(
            `GitHub API error: HTTP ${res.status}${errorDetail ? ` - ${errorDetail}` : ""}`,
            {
              status: res.status,
              endpoint: endpointUrl,
              rateLimit,
              isRetryable: res.status >= 500,
              code,
            },
          );
        }

        // Successful 2xx response parsing
        const contentType = res.headers.get("content-type") ?? "";
        let data: T;
        if (contentType.includes("application/json")) {
          data = (await res.json()) as T;
        } else {
          data = (await res.text()) as unknown as T;
        }

        return { data, status: res.status, headers: res.headers };
      } catch (err) {
        clearTimeout(timeoutTimer);

        if (err instanceof GitHubApiError) {
          throw err;
        }

        // Abort / timeout handling
        if (err instanceof Error && err.name === "AbortError") {
          throw new GitHubApiError(
            `GitHub API request timed out after ${this.timeoutMs}ms: ${endpointUrl}`,
            {
              endpoint: endpointUrl,
              isRetryable: true,
              code: ErrorCode.GITHUB_API_ERROR,
            },
          );
        }

        // Generic network / fetch failures
        const sanitizedMsg = redactString(
          err instanceof Error ? err.message : String(err),
        );
        throw new GitHubApiError(
          `Network failure connecting to GitHub API: ${sanitizedMsg}`,
          {
            endpoint: endpointUrl,
            isRetryable: true,
            code: ErrorCode.GITHUB_API_ERROR,
          },
        );
      }
    };

    // -----------------------------------------------------------------------
    // Coordinated 401 Refresh/Retry Semantics (Phase 1C.2.1 C3 Hardened)
    //
    // Contract:
    // 1. First attempt uses the current token.
    // 2. On HTTP 401, exactly ONE coordinated forced refresh is attempted.
    // 3. The request is retried exactly ONCE with the refreshed token.
    // 4. If the SECOND attempt also returns 401, that is TERMINAL — the error
    //    propagates immediately. No further refresh/retry cycles occur.
    // 5. Stale 401 errors NEVER purge valid credentials held by the
    //    DurableTokenLifecycleManager's tripartite fencing (G, A, E).
    // -----------------------------------------------------------------------
    try {
      return await executeAttempt(token);
    } catch (err) {
      if (
        err instanceof GitHubApiError &&
        err.status === 401 &&
        (this.lifecycleManager || this.tokenSupplier)
      ) {
        // Exactly one coordinated forced refresh attempt
        let refreshedToken: string;
        try {
          refreshedToken = await this.getAccessToken(true);
        } catch (refreshErr) {
          // Token refresh itself failed — propagate the refresh error
          if (refreshErr instanceof GitHubApiError) throw refreshErr;
          throw err; // Original 401 is the meaningful error
        }

        // Retry exactly once with the refreshed token.
        // If this second attempt also fails (including another 401),
        // the error is TERMINAL and propagates directly.
        return await executeAttempt(refreshedToken);
      }
      throw err;
    }
  }

  // ==========================================================================
  // REPOSITORY INTELLIGENCE & BRANCH VALIDATION
  // ==========================================================================

  /**
   * Retrieves AUTHORITATIVE repository metadata including immutable numeric ID.
   *
   * **This is the sole authority for repository identity and write-permission validation.**
   * Discovery methods (listUserRepositories, listInstallationRepositories) are
   * convenience-only for UI population; they NEVER supersede this authoritative lookup.
   * All write operations MUST validate via getRepository() before dispatch.
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    this.validateRepoParams(owner, repo);
    const url = this.buildSafeUrl(["repos", owner, repo]);

    const res = await this.request<Record<string, unknown>>(url, {
      allow404: true,
    });
    if (!res.data || res.status === 404) {
      throw new GitHubApiError(`Repository "${owner}/${repo}" not found.`, {
        status: 404,
        code: ErrorCode.GITHUB_REPOSITORY_NOT_FOUND,
      });
    }

    const data = res.data;
    const repoId = typeof data.id === "number" ? data.id : 0;
    if (!repoId) {
      throw new GitHubApiError(
        `Authoritative repository ID missing for "${owner}/${repo}".`,
        { code: ErrorCode.VALIDATION_FAILED },
      );
    }

    const ownerObj = data.owner as Record<string, unknown> | undefined;
    const permissions = data.permissions as
      { push?: boolean; pull?: boolean; admin?: boolean } | undefined;

    return {
      id: repoId,
      owner: typeof ownerObj?.login === "string" ? ownerObj.login : owner,
      name: typeof data.name === "string" ? data.name : repo,
      fullName:
        typeof data.full_name === "string"
          ? data.full_name
          : `${owner}/${repo}`,
      private: Boolean(data.private),
      defaultBranch:
        typeof data.default_branch === "string" ? data.default_branch : "main",
      permissions: permissions
        ? {
            push: Boolean(permissions.push),
            pull: Boolean(permissions.pull),
            admin: Boolean(permissions.admin),
          }
        : undefined,
    };
  }

  /**
   * Retrieves authoritative branch metadata.
   * Fails closed if branch does not exist (never silently falls back).
   */
  async getBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GitHubBranch> {
    this.validateRepoParams(owner, repo);
    this.validateBranchParam(branch);

    const url = this.buildSafeUrl(["repos", owner, repo, "branches", branch]);
    const res = await this.request<Record<string, unknown>>(url, {
      allow404: true,
    });

    if (!res.data || res.status === 404) {
      throw new GitHubApiError(
        `Target branch "${branch}" does not exist in repository "${owner}/${repo}".`,
        {
          status: 404,
          code: ErrorCode.GITHUB_BRANCH_NOT_FOUND,
        },
      );
    }

    const commitObj = res.data.commit as Record<string, unknown> | undefined;
    const sha = typeof commitObj?.sha === "string" ? commitObj.sha : "";

    return {
      name: typeof res.data.name === "string" ? res.data.name : branch,
      sha,
      protected: Boolean(res.data.protected),
    };
  }

  /**
   * Lists GitHub App installations accessible to the authorized user context.
   *
   * **Convenience-only**: This discovery method populates UI selection lists.
   * It is NOT the authority for write-permission validation.
   * Use `getRepository()` for authoritative repository identity confirmation.
   */
  async listUserInstallations(): Promise<GitHubInstallation[]> {
    const url = this.buildSafeUrl(["user", "installations"]);
    try {
      const res = await this.request<{
        installations?: Array<Record<string, unknown>>;
      }>(url);
      if (!res.data?.installations) return [];

      return res.data.installations.map((inst) => ({
        id: typeof inst.id === "number" ? inst.id : 0,
        account: {
          login:
            typeof (inst.account as Record<string, unknown>)?.login === "string"
              ? ((inst.account as Record<string, unknown>).login as string)
              : "",
          id:
            typeof (inst.account as Record<string, unknown>)?.id === "number"
              ? ((inst.account as Record<string, unknown>).id as number)
              : 0,
          type:
            typeof (inst.account as Record<string, unknown>)?.type === "string"
              ? ((inst.account as Record<string, unknown>).type as string)
              : "User",
        },
        repositorySelection:
          inst.repository_selection === "all" ? "all" : "selected",
      }));
    } catch {
      // Fallback for scopes that do not permit /user/installations
      return [];
    }
  }

  /**
   * Lists repositories accessible to the user under a specific GitHub App installation.
   *
   * **Convenience-only**: Populates UI repository selection. Does NOT validate
   * write permissions authoritatively. Use `getRepository()` for that.
   */
  async listInstallationRepositories(
    installationId: number,
  ): Promise<GitHubRepository[]> {
    const url = this.buildSafeUrl([
      "user",
      "installations",
      String(installationId),
      "repositories",
    ]);
    const res = await this.request<{
      repositories?: Array<Record<string, unknown>>;
    }>(url);
    if (!res.data?.repositories) return [];

    return res.data.repositories.map((repo) => {
      const ownerObj = repo.owner as Record<string, unknown> | undefined;
      const permissions = repo.permissions as
        { push?: boolean; pull?: boolean; admin?: boolean } | undefined;

      return {
        id: typeof repo.id === "number" ? repo.id : 0,
        owner: typeof ownerObj?.login === "string" ? ownerObj.login : "",
        name: typeof repo.name === "string" ? repo.name : "",
        fullName: typeof repo.full_name === "string" ? repo.full_name : "",
        private: Boolean(repo.private),
        defaultBranch:
          typeof repo.default_branch === "string"
            ? repo.default_branch
            : "main",
        permissions: permissions
          ? {
              push: Boolean(permissions.push),
              pull: Boolean(permissions.pull),
              admin: Boolean(permissions.admin),
            }
          : undefined,
        installationId,
      };
    });
  }

  /**
   * Discovers and lists user-accessible repositories.
   *
   * **CONVENIENCE-ONLY discovery method** for populating UI repository pickers.
   *
   * This method is NOT the authority for repository identity, write permissions,
   * or installation scope validation. The sole authority for those properties
   * is `getRepository()`, which performs authoritative `GET /repos/{owner}/{repo}`
   * against GitHub's REST API and validates the immutable numeric repository ID.
   *
   * Discovery results MUST be re-validated via `getRepository()` before any
   * write operation is dispatched.
   */
  async listUserRepositories(): Promise<GitHubRepository[]> {
    // 1. Try installation-scoped discovery
    const installations = await this.listUserInstallations();
    if (installations.length > 0) {
      const results: GitHubRepository[] = [];
      for (const inst of installations) {
        const repos = await this.listInstallationRepositories(inst.id);
        results.push(...repos);
      }
      if (results.length > 0) return results;
    }

    // 2. Fallback to /user/repos
    const url = this.buildSafeUrl(["user", "repos"], {
      per_page: "100",
      sort: "updated",
    });
    const res = await this.request<Array<Record<string, unknown>>>(url);
    if (!res.data || !Array.isArray(res.data)) return [];

    return res.data.map((repo) => {
      const ownerObj = repo.owner as Record<string, unknown> | undefined;
      const permissions = repo.permissions as
        { push?: boolean; pull?: boolean; admin?: boolean } | undefined;

      return {
        id: typeof repo.id === "number" ? repo.id : 0,
        owner: typeof ownerObj?.login === "string" ? ownerObj.login : "",
        name: typeof repo.name === "string" ? repo.name : "",
        fullName: typeof repo.full_name === "string" ? repo.full_name : "",
        private: Boolean(repo.private),
        defaultBranch:
          typeof repo.default_branch === "string"
            ? repo.default_branch
            : "main",
        permissions: permissions
          ? {
              push: Boolean(permissions.push),
              pull: Boolean(permissions.pull),
              admin: Boolean(permissions.admin),
            }
          : undefined,
      };
    });
  }

  // ==========================================================================
  // CONTENTS API — READ & WRITE
  // ==========================================================================

  /**
   * Retrieves existing file contents from GitHub Contents API.
   * Returns null if file does not exist (HTTP 404).
   * Distinguishes file vs directory/symlink/submodule.
   * Enforces 500 KB maximum payload size cap.
   */
  async getFileContents(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubContentFile | null> {
    this.validateRepoParams(owner, repo);
    const canonicalPath = validateAndCanonicalizePath(path);

    // Build contents URL: /repos/{owner}/{repo}/contents/{path}
    const pathParts = canonicalPath.split("/");
    const url = this.buildSafeUrl(
      ["repos", owner, repo, "contents", ...pathParts],
      ref ? { ref } : undefined,
    );

    const res = await this.request<unknown>(url, { allow404: true });

    if (!res.data || res.status === 404) {
      return null;
    }

    // Target is a directory if GitHub returns an array of items
    if (Array.isArray(res.data)) {
      throw new GitHubApiError(
        `Target path "${canonicalPath}" in "${owner}/${repo}" is a directory, not a file.`,
        {
          status: 200,
          code: ErrorCode.GITHUB_TARGET_IS_DIRECTORY,
        },
      );
    }

    const data = res.data as Record<string, unknown>;
    const type = (
      typeof data.type === "string" ? data.type : "file"
    ) as GitHubObjectType;

    if (type !== "file") {
      throw new GitHubApiError(
        `Target path "${canonicalPath}" is an unsupported Git object type: "${type}".`,
        {
          status: 200,
          code: ErrorCode.GITHUB_UNSUPPORTED_OBJECT_TYPE,
        },
      );
    }

    const size = typeof data.size === "number" ? data.size : 0;
    if (size > MAX_SOURCE_PAYLOAD_BYTES) {
      throw new GitHubApiError(
        `Remote file "${canonicalPath}" size (${size} bytes) exceeds maximum supported limit of ${MAX_SOURCE_PAYLOAD_BYTES} bytes.`,
        {
          status: 200,
          code: ErrorCode.GITHUB_PAYLOAD_TOO_LARGE,
        },
      );
    }

    const rawBase64 = typeof data.content === "string" ? data.content : "";
    let decodedContent: string | undefined = undefined;
    let contentHash: string | undefined = undefined;

    if (rawBase64) {
      decodedContent = safeBase64Decode(rawBase64);
      const normalized = normalizeSourceCode(decodedContent);
      contentHash = await computeContentHash(normalized);
    }

    return {
      type,
      size,
      name:
        typeof data.name === "string"
          ? data.name
          : (pathParts[pathParts.length - 1] ?? "unnamed"),
      path: typeof data.path === "string" ? data.path : canonicalPath,
      sha: typeof data.sha === "string" ? data.sha : "",
      content: rawBase64,
      decodedContent,
      contentHash,
    };
  }

  /**
   * Safely creates or updates a file using the GitHub Contents PUT API.
   * Requires authoritative blob SHA when updating an existing file.
   */
  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    body: GitHubContentsWritePayload,
  ): Promise<GitHubContentsWriteResponse> {
    this.validateRepoParams(owner, repo);
    const canonicalPath = validateAndCanonicalizePath(path);

    const pathParts = canonicalPath.split("/");
    const url = this.buildSafeUrl([
      "repos",
      owner,
      repo,
      "contents",
      ...pathParts,
    ]);

    const res = await this.request<Record<string, unknown>>(url, {
      method: "PUT",
      body: {
        message: body.message,
        content: body.content,
        branch: body.branch,
        sha: body.sha, // Required for updates under OCC; omitted for creates
      },
    });

    if (!res.data) {
      throw new GitHubApiError(
        "Empty response received from Contents PUT API.",
        {
          code: ErrorCode.GITHUB_API_ERROR,
        },
      );
    }

    const contentObj = res.data.content as Record<string, unknown> | undefined;
    const commitObj = res.data.commit as Record<string, unknown> | undefined;

    return {
      content: {
        name:
          typeof contentObj?.name === "string"
            ? contentObj.name
            : (pathParts[pathParts.length - 1] ?? "unnamed"),
        path:
          typeof contentObj?.path === "string"
            ? contentObj.path
            : canonicalPath,
        sha: typeof contentObj?.sha === "string" ? contentObj.sha : "",
        size: typeof contentObj?.size === "number" ? contentObj.size : 0,
      },
      commit: {
        sha: typeof commitObj?.sha === "string" ? commitObj.sha : "",
        message:
          typeof commitObj?.message === "string"
            ? commitObj.message
            : body.message,
        htmlUrl:
          typeof commitObj?.html_url === "string"
            ? commitObj.html_url
            : undefined,
      },
    };
  }

  // ==========================================================================
  // INPUT VALIDATION HELPERS
  // ==========================================================================

  private validateRepoParams(owner: string, repo: string): void {
    if (!owner || !REPO_SEGMENT_REGEX.test(owner)) {
      throw new GitHubApiError(
        `Invalid repository owner: "${owner}". Must match alphanumeric characters, hyphens, or underscores.`,
        { code: ErrorCode.VALIDATION_FAILED },
      );
    }
    if (!repo || !REPO_SEGMENT_REGEX.test(repo)) {
      throw new GitHubApiError(
        `Invalid repository name: "${repo}". Must match alphanumeric characters, hyphens, or underscores.`,
        { code: ErrorCode.VALIDATION_FAILED },
      );
    }
  }

  private validateBranchParam(branch: string): void {
    if (
      !branch ||
      branch.includes("..") ||
      branch.startsWith("/") ||
      branch.endsWith("/") ||
      !SAFE_BRANCH_REGEX.test(branch)
    ) {
      throw new GitHubApiError(
        `Invalid branch name: "${branch}". Must conform to safe Git branch grammar without traversal.`,
        { code: ErrorCode.VALIDATION_FAILED },
      );
    }
  }
}
