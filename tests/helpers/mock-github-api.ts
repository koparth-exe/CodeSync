import { computeContentHash } from "../../src/shared/deduplication";
import {
  safeBase64Decode,
  safeBase64Encode,
} from "../../src/shared/github/client";

export interface MockRemoteFile {
  content: string;
  contentHash: string;
  sha: string;
  type?: "file" | "dir";
}

export interface MockRecordedRequest {
  readonly traceType: string;
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly branch?: string | undefined;
  readonly sha?: string | undefined;
  readonly commitMessage?: string | undefined;
  readonly contentHash?: string | undefined;
  readonly status: number;
  readonly timestamp: number;
}

export interface ConflictHookConfig {
  readonly maxTimes: number;
  readonly freshFile: MockRemoteFile;
}

export interface RateLimitHookConfig {
  readonly maxTimes: number;
  readonly method?: string | undefined;
  readonly pathSubstring?: string | undefined;
  readonly resetTimestamp?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly status?: number | undefined;
  readonly remaining?: number | undefined;
  readonly omitRetryAfter?: boolean | undefined;
}

export interface NetworkFailureHookConfig {
  readonly method: string;
  readonly pathSubstring?: string | undefined;
  readonly maxTimes?: number | undefined;
  readonly commitBeforeFailure?: boolean | undefined;
}

export interface AuthHookConfig {
  readonly status: number;
  readonly maxTimes?: number | undefined;
  readonly validToken?: string | undefined;
}

export interface ServerErrorHookConfig {
  readonly status?: number | undefined;
  readonly method?: string | undefined;
  readonly pathSubstring?: string | undefined;
  readonly maxTimes?: number | undefined;
}

export interface VerificationHookConfig {
  readonly pathSubstring?: string | undefined;
  readonly type: "mismatch" | "network_error";
  readonly mismatchHash?: string | undefined;
}

/**
 * Stateful, Deterministic, Fully-Offline Mock GitHub REST API Server.
 *
 * Implements:
 * - Real in-memory file state with authoritative blob SHA derivation and content hashing.
 * - Request tracing with sanitized metadata (zero credential logging).
 * - Exact GitHub REST API endpoints:
 *   - GET /repos/{owner}/{repo}
 *   - GET /repos/{owner}/{repo}/branches/{branch}
 *   - GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 *   - PUT /repos/{owner}/{repo}/contents/{path}
 * - Conflict (409) simulation with fresh remote SHA state updates.
 * - Rate limiting (429) simulation with retry headers.
 * - Network failure / timeout simulation for PUT.
 * - Verification GET failures (mismatch, network error).
 * - OCC checking: PUT with mismatched `sha` returns 409.
 */
export class MockGitHubApiServer {
  private readonly defaultOwner: string;
  private readonly defaultRepo: string;
  private readonly defaultBranch: string;

  private files = new Map<string, MockRemoteFile>();
  private requestTrace: string[] = [];
  private recordedRequests: MockRecordedRequest[] = [];

  // Configurable hooks for simulation
  private conflictHook?: ConflictHookConfig | undefined;
  private conflictCounter = 0;

  private rateLimitHook?: RateLimitHookConfig | undefined;
  private rateLimitCounter = 0;

  private networkFailureHook?: NetworkFailureHookConfig | undefined;
  private networkFailureCounter = 0;

  private verificationHook?: VerificationHookConfig | undefined;

  private authHook?: AuthHookConfig | undefined;
  private authCounter = 0;

  private serverErrorHook?: ServerErrorHookConfig | undefined;
  private serverErrorCounter = 0;

  private authStatus: number | null = null;
  private repoExists = true;
  private branchExists = true;

  constructor(
    options: {
      owner?: string;
      repo?: string;
      branch?: string;
    } = {},
  ) {
    this.defaultOwner = options.owner ?? "octocat";
    this.defaultRepo = options.repo ?? "dsa-repo";
    this.defaultBranch = options.branch ?? "main";
  }

  /**
   * Resets all file states, traces, and fault injection hooks.
   */
  reset(): void {
    this.files.clear();
    this.requestTrace = [];
    this.recordedRequests = [];
    this.conflictHook = undefined;
    this.conflictCounter = 0;
    this.rateLimitHook = undefined;
    this.rateLimitCounter = 0;
    this.networkFailureHook = undefined;
    this.networkFailureCounter = 0;
    this.verificationHook = undefined;
    this.authHook = undefined;
    this.authCounter = 0;
    this.serverErrorHook = undefined;
    this.serverErrorCounter = 0;
    this.authStatus = null;
    this.repoExists = true;
    this.branchExists = true;
  }

  /**
   * Seeds an existing remote file state.
   */
  async setFile(
    path: string,
    content: string,
    customSha?: string,
  ): Promise<MockRemoteFile> {
    const contentHash = await computeContentHash(content);
    const sha = customSha ?? `blob_sha_${contentHash.slice(0, 16)}`;
    const record: MockRemoteFile = {
      content,
      contentHash,
      sha,
      type: "file",
    };
    this.files.set(path, record);
    return record;
  }

  getFile(path: string): MockRemoteFile | undefined {
    return this.files.get(path);
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  getAllFiles(): ReadonlyMap<string, MockRemoteFile> {
    return this.files;
  }

  getRequestTrace(): readonly string[] {
    return [...this.requestTrace];
  }

  getRecordedRequests(): readonly MockRecordedRequest[] {
    return [...this.recordedRequests];
  }

  getPutCount(): number {
    return this.recordedRequests.filter((r) => r.method === "PUT").length;
  }

  setAuthStatus(status: number | null): void {
    this.authStatus = status;
  }

  setRepoExists(exists: boolean): void {
    this.repoExists = exists;
  }

  setBranchExists(exists: boolean): void {
    this.branchExists = exists;
  }

  configure409Conflict(freshFile: MockRemoteFile, maxTimes: number = 1): void {
    this.conflictHook = { freshFile, maxTimes };
    this.conflictCounter = 0;
  }

  configure429RateLimit(options: {
    maxTimes?: number;
    method?: string;
    pathSubstring?: string;
    resetTimestamp?: number;
    retryAfterSeconds?: number;
    status?: number;
    remaining?: number;
    omitRetryAfter?: boolean;
  }): void {
    this.rateLimitHook = {
      maxTimes: options.maxTimes ?? 1,
      method: options.method ? options.method.toUpperCase() : undefined,
      pathSubstring: options.pathSubstring,
      resetTimestamp: options.resetTimestamp,
      retryAfterSeconds: options.retryAfterSeconds,
      status: options.status,
      remaining: options.remaining,
      omitRetryAfter: options.omitRetryAfter,
    };
    this.rateLimitCounter = 0;
  }

  configureNetworkFailure(options: {
    method: string;
    pathSubstring?: string;
    maxTimes?: number;
    commitBeforeFailure?: boolean;
  }): void {
    this.networkFailureHook = {
      method: options.method.toUpperCase(),
      pathSubstring: options.pathSubstring,
      maxTimes: options.maxTimes ?? 1,
      commitBeforeFailure: options.commitBeforeFailure,
    };
    this.networkFailureCounter = 0;
  }

  configureVerificationHook(options: VerificationHookConfig): void {
    this.verificationHook = options;
  }

  configureAuthFailure(options: AuthHookConfig): void {
    this.authHook = {
      status: options.status,
      maxTimes: options.maxTimes ?? 1,
      validToken: options.validToken,
    };
    this.authCounter = 0;
  }

  configureServerError(options: ServerErrorHookConfig = {}): void {
    this.serverErrorHook = {
      status: options.status ?? 500,
      maxTimes: options.maxTimes ?? 1,
      method: options.method ? options.method.toUpperCase() : undefined,
      pathSubstring: options.pathSubstring,
    };
    this.serverErrorCounter = 0;
  }

  /**
   * Generates a deterministic fetch function implementation matching GitHub REST API v3.
   */
  createFetchHandler(): typeof fetch {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);

      // Verify no leaked real credentials
      const authHeader = headers.get("authorization") ?? "";
      if (authHeader.includes("ghp_") || authHeader.includes("gho_")) {
        throw new Error(
          "Security Violation: Real GitHub token detected in test request!",
        );
      }

      // Check simulated global auth failure
      if (this.authStatus) {
        return new Response(
          JSON.stringify({ message: "Simulated auth error" }),
          {
            status: this.authStatus,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Check simulated auth hook (e.g. 401 until valid refreshed token, or 403 forbidden)
      if (this.authHook && this.authCounter < (this.authHook.maxTimes ?? 1)) {
        const isAuthorized = Boolean(
          this.authHook.validToken &&
          authHeader === `Bearer ${this.authHook.validToken}`,
        );
        if (!isAuthorized) {
          this.authCounter++;
          const status = this.authHook.status;
          const traceTag = `${method}_AUTH_${status}`;
          this.requestTrace.push(traceTag);
          this.recordRequest(
            traceTag,
            method,
            urlStr,
            "",
            undefined,
            undefined,
            undefined,
            status,
          );
          return new Response(
            JSON.stringify({
              message:
                status === 401
                  ? "Bad credentials"
                  : status === 403
                    ? "Must have admin rights to Repository."
                    : "Auth failure",
            }),
            {
              status,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // Server error hook (e.g. 500 on pre-flight GET)
      if (
        this.serverErrorHook &&
        (!this.serverErrorHook.method ||
          this.serverErrorHook.method === method) &&
        (!this.serverErrorHook.pathSubstring ||
          urlStr.includes(this.serverErrorHook.pathSubstring)) &&
        this.serverErrorCounter < (this.serverErrorHook.maxTimes ?? 1)
      ) {
        this.serverErrorCounter++;
        const status = this.serverErrorHook.status ?? 500;
        const traceTag = `${method}_SERVER_ERROR_${status}`;
        this.requestTrace.push(traceTag);
        this.recordRequest(
          traceTag,
          method,
          urlStr,
          "",
          undefined,
          undefined,
          undefined,
          status,
        );
        return new Response(
          JSON.stringify({ message: "Internal Server Error" }),
          {
            status,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Simulated rate limit hook (supports GET or PUT)
      if (
        this.rateLimitHook &&
        (!this.rateLimitHook.method || this.rateLimitHook.method === method) &&
        (!this.rateLimitHook.pathSubstring ||
          urlStr.includes(this.rateLimitHook.pathSubstring)) &&
        this.rateLimitCounter < this.rateLimitHook.maxTimes
      ) {
        this.rateLimitCounter++;
        const status = this.rateLimitHook.status ?? 429;
        const resetSec = this.rateLimitHook.resetTimestamp
          ? Math.floor(this.rateLimitHook.resetTimestamp / 1000)
          : Math.floor(Date.now() / 1000) + 60;
        const retryAfter = this.rateLimitHook.retryAfterSeconds ?? 60;
        const remaining =
          this.rateLimitHook.remaining !== undefined
            ? String(this.rateLimitHook.remaining)
            : "0";

        const traceTag = `${method}_FILE_${status}`;
        this.requestTrace.push(traceTag);
        this.recordRequest(
          traceTag,
          method,
          urlStr,
          "",
          undefined,
          undefined,
          undefined,
          status,
        );

        const responseHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": remaining,
          "x-ratelimit-reset": String(resetSec),
        };
        if (!this.rateLimitHook.omitRetryAfter) {
          responseHeaders["retry-after"] = String(retryAfter);
        }

        return new Response(
          JSON.stringify({
            message: "API rate limit exceeded for user ID.",
            documentation_url:
              "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",
          }),
          {
            status,
            headers: responseHeaders,
          },
        );
      }

      // Network failure hook
      if (
        this.networkFailureHook &&
        this.networkFailureHook.method === method &&
        (!this.networkFailureHook.pathSubstring ||
          urlStr.includes(this.networkFailureHook.pathSubstring)) &&
        this.networkFailureCounter < (this.networkFailureHook.maxTimes ?? 1)
      ) {
        this.networkFailureCounter++;
        const urlObj = new URL(urlStr);
        const match = urlObj.pathname.match(
          /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
        );
        const filePath = match && match[1] ? decodeURIComponent(match[1]) : "";

        if (
          this.networkFailureHook.commitBeforeFailure &&
          filePath &&
          init?.body
        ) {
          try {
            const bodyObj = JSON.parse(init.body as string);
            const decodedContent = bodyObj.content
              ? safeBase64Decode(bodyObj.content)
              : "";
            const contentHash = await computeContentHash(decodedContent);
            const newBlobSha = `blob_sha_${contentHash.slice(0, 16)}`;
            this.files.set(filePath, {
              content: decodedContent,
              contentHash,
              sha: newBlobSha,
              type: "file",
            });
          } catch {
            // ignore parse failure
          }
        }

        this.requestTrace.push(`${method}_FILE_NETWORK_FAILURE`);
        this.recordRequest(
          `${method}_FILE_NETWORK_FAILURE`,
          method,
          urlStr,
          filePath,
          undefined,
          undefined,
          undefined,
          0,
        );
        throw new TypeError(
          "Network failure: socket connection terminated abruptly",
        );
      }

      // 1. GET /repos/{owner}/{repo}
      if (method === "GET" && urlStr.match(/\/repos\/[^/]+\/[^/?]+$/)) {
        this.requestTrace.push("GET_REPOSITORY");
        this.recordRequest(
          "GET_REPOSITORY",
          method,
          urlStr,
          "",
          undefined,
          undefined,
          undefined,
          200,
        );

        if (!this.repoExists) {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            id: 99887766,
            name: this.defaultRepo,
            owner: { login: this.defaultOwner },
            default_branch: this.defaultBranch,
            permissions: { push: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // 2. GET /repos/{owner}/{repo}/branches/{branch}
      if (method === "GET" && urlStr.includes("/branches/")) {
        this.requestTrace.push("GET_BRANCH");
        this.recordRequest(
          "GET_BRANCH",
          method,
          urlStr,
          "",
          undefined,
          undefined,
          undefined,
          200,
        );

        if (!this.branchExists) {
          return new Response(JSON.stringify({ message: "Branch Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            name: this.defaultBranch,
            commit: { sha: "head_commit_sha_9999" },
            protected: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // 3. GET /repos/{owner}/{repo}/contents/{path}
      if (method === "GET" && urlStr.includes("/contents/")) {
        const urlObj = new URL(urlStr);
        const match = urlObj.pathname.match(
          /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
        );
        const filePath = match && match[1] ? decodeURIComponent(match[1]) : "";
        const branch = urlObj.searchParams.get("ref") ?? this.defaultBranch;

        // Determine if this is a post-write verification GET (follows a successful PUT)
        const lastRequest =
          this.recordedRequests[this.recordedRequests.length - 1];
        const isPostWriteVerification =
          lastRequest !== undefined &&
          lastRequest.method === "PUT" &&
          lastRequest.path === filePath &&
          (lastRequest.status === 200 || lastRequest.status === 201);
        const traceTag = isPostWriteVerification
          ? "GET_FILE_VERIFY"
          : "GET_FILE";
        this.requestTrace.push(traceTag);

        // Verification hook check
        if (isPostWriteVerification && this.verificationHook) {
          if (
            !this.verificationHook.pathSubstring ||
            filePath.includes(this.verificationHook.pathSubstring)
          ) {
            if (this.verificationHook.type === "network_error") {
              throw new TypeError(
                "Network failure during post-write verification GET",
              );
            }
            if (this.verificationHook.type === "mismatch") {
              const mismatchHash =
                this.verificationHook.mismatchHash ?? "f".repeat(64);
              this.recordRequest(
                traceTag,
                method,
                urlStr,
                filePath,
                branch,
                undefined,
                undefined,
                200,
              );
              return new Response(
                JSON.stringify({
                  type: "file",
                  name: filePath.split("/").pop(),
                  path: filePath,
                  sha: "sha_mismatched_blob",
                  size: 20,
                  content: safeBase64Encode("// Mismatched remote overwrite"),
                  encoding: "base64",
                  contentHash: mismatchHash,
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          }
        }

        const file = this.files.get(filePath);
        if (!file) {
          this.recordRequest(
            traceTag,
            method,
            urlStr,
            filePath,
            branch,
            undefined,
            undefined,
            404,
          );
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        this.recordRequest(
          traceTag,
          method,
          urlStr,
          filePath,
          branch,
          file.sha,
          undefined,
          200,
        );
        return new Response(
          JSON.stringify({
            type: file.type ?? "file",
            name: filePath.split("/").pop(),
            path: filePath,
            sha: file.sha,
            size: Buffer.from(file.content).length,
            content: safeBase64Encode(file.content),
            encoding: "base64",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // 4. PUT /repos/{owner}/{repo}/contents/{path}
      if (method === "PUT" && urlStr.includes("/contents/")) {
        const urlObj = new URL(urlStr);
        const match = urlObj.pathname.match(
          /\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
        );
        const filePath = match && match[1] ? decodeURIComponent(match[1]) : "";

        let bodyObj: {
          message?: string;
          content?: string;
          branch?: string;
          sha?: string;
        } = {};
        if (typeof init?.body === "string") {
          try {
            bodyObj = JSON.parse(init.body);
          } catch {
            bodyObj = {};
          }
        }

        const decodedContent = bodyObj.content
          ? safeBase64Decode(bodyObj.content)
          : "";
        const contentHash = await computeContentHash(decodedContent);

        // Check simulated 409 conflict hook
        if (
          this.conflictHook &&
          this.conflictCounter < this.conflictHook.maxTimes
        ) {
          this.conflictCounter++;
          // Update remote file to the fresh file state simulate external commit
          this.files.set(filePath, this.conflictHook.freshFile);

          this.requestTrace.push("PUT_FILE_409");
          this.recordRequest(
            "PUT_FILE_409",
            method,
            urlStr,
            filePath,
            bodyObj.branch,
            bodyObj.sha,
            bodyObj.message,
            409,
          );

          return new Response(
            JSON.stringify({
              message: `${filePath} does not match ${bodyObj.sha ?? "empty"}.`,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        // Real OCC check: if file already exists in mock, expected `sha` must match
        const existing = this.files.get(filePath);
        if (existing) {
          if (!bodyObj.sha || bodyObj.sha !== existing.sha) {
            this.requestTrace.push("PUT_FILE_409_OCC");
            this.recordRequest(
              "PUT_FILE_409_OCC",
              method,
              urlStr,
              filePath,
              bodyObj.branch,
              bodyObj.sha,
              bodyObj.message,
              409,
            );
            return new Response(
              JSON.stringify({
                message: `OCC Conflict: Expected SHA ${existing.sha} but received ${bodyObj.sha ?? "none"}.`,
              }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // Write successful
        const newBlobSha = `blob_sha_${contentHash.slice(0, 16)}`;
        const commitSha = `commit_sha_${crypto.randomUUID().slice(0, 12)}`;

        const updatedRecord: MockRemoteFile = {
          content: decodedContent,
          contentHash,
          sha: newBlobSha,
          type: "file",
        };
        this.files.set(filePath, updatedRecord);

        this.requestTrace.push("PUT_FILE");
        this.recordRequest(
          "PUT_FILE",
          method,
          urlStr,
          filePath,
          bodyObj.branch,
          bodyObj.sha,
          bodyObj.message,
          existing ? 200 : 201,
        );

        return new Response(
          JSON.stringify({
            content: {
              name: filePath.split("/").pop(),
              path: filePath,
              sha: newBlobSha,
              size: Buffer.from(decodedContent).length,
              type: "file",
            },
            commit: {
              sha: commitSha,
              message: bodyObj.message ?? "Add solution via CodeSync",
              html_url: `https://github.com/${this.defaultOwner}/${this.defaultRepo}/commit/${commitSha}`,
            },
          }),
          {
            status: existing ? 200 : 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Unhandled route fallback
      return new Response(
        JSON.stringify({ message: `Not Found: ${method} ${urlStr}` }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  }

  private recordRequest(
    traceType: string,
    method: string,
    url: string,
    path: string,
    branch: string | undefined,
    sha: string | undefined,
    commitMessage: string | undefined,
    status: number,
  ): void {
    this.recordedRequests.push({
      traceType,
      method,
      url,
      path,
      branch,
      sha,
      commitMessage,
      status,
      timestamp: Date.now(),
    });
  }
}
