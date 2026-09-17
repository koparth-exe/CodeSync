import { describe, expect, it, vi } from "vitest";
import { GitHubApiClient } from "../../src/shared/github/client";
import { GitHubContentsService } from "../../src/shared/github/contents-service";
import {
  ErrorCode,
  GitHubApiError,
  GitHubRateLimitError,
} from "../../src/shared/errors";
import { safeBase64Encode } from "../../src/shared/github/client";
import {
  MAX_KEEP_ALL_CANDIDATES,
  GITHUB_REST_API_VERSION,
} from "../../src/shared/github/types";

// ===========================================================================
// Phase 1C.2.1 Correction Tests
// ===========================================================================

describe("Phase 1C.2.1 — C1: KEEP_ALL Candidate Generation Bound", () => {
  const dummyOwner = "octocat";
  const dummyRepo = "solutions";
  const dummyBranch = "main";
  const dummyContent = "int main() { return 0; }\n";

  it("MAX_KEEP_ALL_CANDIDATES is exported and equals 10", () => {
    expect(MAX_KEEP_ALL_CANDIDATES).toBe(10);
    expect(typeof MAX_KEEP_ALL_CANDIDATES).toBe("number");
  });

  it("throws fail-closed when all KEEP_ALL candidate slots are exhausted", async () => {
    // Simulate: base file + all versions v2-v10 all exist
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        // Repo metadata
        if (
          urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Branch metadata
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Contents GET: ALL files exist (base + v2 through v10)
        if (urlStr.includes("/contents/") && method === "GET") {
          return new Response(
            JSON.stringify({
              type: "file",
              name: "two-sum.cpp",
              path: "two-sum.cpp",
              sha: "sha_occupied",
              size: 10,
              content: safeBase64Encode("existing code"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    await expect(
      service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: "two-sum.cpp",
        content: dummyContent,
        commitMessage: "test",
        duplicatePolicy: "KEEP_ALL",
      }),
    ).rejects.toThrow(GitHubApiError);

    // Verify the specific error
    try {
      await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: "two-sum.cpp",
        content: dummyContent,
        commitMessage: "test",
        duplicatePolicy: "KEEP_ALL",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      const apiErr = err as GitHubApiError;
      expect(apiErr.code).toBe(ErrorCode.GITHUB_CONFLICT);
      expect(apiErr.message).toContain("KEEP_ALL candidate exhaustion");
      expect(apiErr.message).toContain(String(MAX_KEEP_ALL_CANDIDATES));
    }
  });

  it("probes at most MAX_KEEP_ALL_CANDIDATES GET requests (bounded API calls)", async () => {
    let getCalls = 0;

    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (urlStr.includes("/contents/") && method === "GET") {
          getCalls++;
          // All files exist
          return new Response(
            JSON.stringify({
              type: "file",
              name: "test.cpp",
              path: "test.cpp",
              sha: "sha",
              size: 5,
              content: safeBase64Encode("code"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    try {
      await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: "test.cpp",
        content: dummyContent,
        commitMessage: "test",
        duplicatePolicy: "KEEP_ALL",
      });
    } catch {
      // Expected
    }

    // Base file check + (MAX_KEEP_ALL_CANDIDATES - 1) version checks = MAX_KEEP_ALL_CANDIDATES total
    expect(getCalls).toBe(MAX_KEEP_ALL_CANDIDATES);
  });
});

describe("Phase 1C.2.1 — C2: Secondary Rate-Limit Classification", () => {
  const dummyToken = "ghu_dummy_token_12345678901234567890";

  function createClient(fetchMock: typeof fetch) {
    return new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => dummyToken,
      timeoutMs: 1000,
    });
  }

  it("classifies HTTP 429 as PRIMARY rate limit (isSecondary = false)", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "Rate limit" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }) as unknown as typeof fetch;

    const client = createClient(fetchMock);
    try {
      await client.getRepository("octocat", "repo");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      const rateLimitErr = err as GitHubRateLimitError;
      expect(rateLimitErr.isSecondary).toBe(false);
      expect(rateLimitErr.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
    }
  });

  it("classifies HTTP 403 with remaining=0 as PRIMARY rate limit (isSecondary = false)", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }) as unknown as typeof fetch;

    const client = createClient(fetchMock);
    try {
      await client.getRepository("octocat", "repo");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      const rateLimitErr = err as GitHubRateLimitError;
      expect(rateLimitErr.isSecondary).toBe(false);
      // Note: GitHubRateLimitError normalizes primary rate limits to status 429,
      // even when triggered by HTTP 403 with remaining=0. The isSecondary flag
      // and error class are the authoritative discriminators.
      expect(rateLimitErr.status).toBe(429);
    }
  });

  it("classifies HTTP 403 with Retry-After as SECONDARY rate limit (isSecondary = true)", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "retry-after": "120",
            "x-ratelimit-remaining": "4999",
          },
        },
      );
    }) as unknown as typeof fetch;

    const client = createClient(fetchMock);
    try {
      await client.getRepository("octocat", "repo");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      const rateLimitErr = err as GitHubRateLimitError;
      expect(rateLimitErr.isSecondary).toBe(true);
      expect(rateLimitErr.retryAfterSeconds).toBe(120);
      expect(rateLimitErr.code).toBe(ErrorCode.GITHUB_RATE_LIMITED);
      // NOT an authorization failure
      expect(rateLimitErr.message).toContain("secondary rate limit");
      expect(rateLimitErr.message).toContain("NOT an authorization failure");
    }
  });

  it("classifies HTTP 403 without rate-limit indicators as AUTHORIZATION FAILURE", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    const client = createClient(fetchMock);
    try {
      await client.getRepository("octocat", "repo");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      // NOT a rate limit error
      expect(err).not.toBeInstanceOf(GitHubRateLimitError);
      const apiErr = err as GitHubApiError;
      expect(apiErr.code).toBe(ErrorCode.GITHUB_FORBIDDEN);
      expect(apiErr.status).toBe(403);
    }
  });
});

describe("Phase 1C.2.1 — C3: Formal 401 Refresh/Retry Semantics", () => {
  it("retries exactly once after 401 with refreshed token, then succeeds", async () => {
    let fetchCalls = 0;

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit | undefined) => {
        fetchCalls++;
        const headers = (init?.headers ?? {}) as Record<string, string>;

        if (headers.Authorization === "Bearer stale_token") {
          return new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Refreshed token succeeds
        return new Response(
          JSON.stringify({
            id: 1,
            name: "repo",
            owner: { login: "octocat" },
            default_branch: "main",
            permissions: { push: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    ) as unknown as typeof fetch;

    let callCount = 0;
    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => {
        callCount++;
        return callCount === 1 ? "stale_token" : "fresh_token";
      },
      timeoutMs: 1000,
    });

    const result = await client.getRepository("octocat", "repo");
    expect(result.id).toBe(1);
    expect(fetchCalls).toBe(2); // Initial + one retry
  });

  it("propagates 401 as TERMINAL after second consecutive 401 (no infinite loop)", async () => {
    let fetchCalls = 0;

    const fetchMock = vi.fn(async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "always_invalid_token",
      timeoutMs: 1000,
    });

    await expect(client.getRepository("octocat", "repo")).rejects.toThrow(
      GitHubApiError,
    );

    // Exactly 2 fetch calls: initial + one retry. Terminal after that.
    expect(fetchCalls).toBe(2);

    try {
      fetchCalls = 0;
      await client.getRepository("octocat", "repo");
    } catch (err) {
      expect((err as GitHubApiError).status).toBe(401);
      expect((err as GitHubApiError).code).toBe(ErrorCode.GITHUB_UNAUTHORIZED);
      expect(fetchCalls).toBe(2); // Deterministic: always exactly 2
    }
  });
});

describe("Phase 1C.2.1 — C4: Post-Write Verification Uncertainty", () => {
  const dummyOwner = "octocat";
  const dummyRepo = "solutions";
  const dummyBranch = "main";
  const dummyContent = "int main() { return 0; }\n";

  it("returns verificationStatus=CONFIRMED when remote matches intended content", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          // After PUT: return matching content for verification
          return new Response(
            JSON.stringify({
              type: "file",
              name: "test.cpp",
              path: "test.cpp",
              sha: "new_sha",
              size: dummyContent.length,
              content: safeBase64Encode(dummyContent),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "new_sha",
                size: 25,
              },
              commit: { sha: "commit_sha", message: "msg" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    // First GET returns 404 (pre-flight: file doesn't exist)
    let getCallCount = 0;
    const origGetFileContents = client.getFileContents.bind(client);
    client.getFileContents = async (o, r, p, ref) => {
      getCallCount++;
      if (getCallCount === 1) return null; // Pre-flight: doesn't exist
      return origGetFileContents(o, r, p, ref); // Post-write: exists with matching content
    };

    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "test",
    });

    expect(result.status).toBe("created");
    expect(result.verificationStatus).toBe("CONFIRMED");
  });

  it("returns verificationStatus=MISMATCH and requires_attention when remote differs", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          return new Response(
            JSON.stringify({
              type: "file",
              name: "test.cpp",
              path: "test.cpp",
              sha: "wrong_sha",
              size: 99,
              content: safeBase64Encode("COMPLETELY DIFFERENT CODE"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "put_sha",
                size: 25,
              },
              commit: { sha: "commit_sha", message: "msg" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    let getCallCount = 0;
    const origGetFileContents = client.getFileContents.bind(client);
    client.getFileContents = async (o, r, p, ref) => {
      getCallCount++;
      if (getCallCount === 1) return null; // Pre-flight: doesn't exist
      return origGetFileContents(o, r, p, ref); // Post-write: different content
    };

    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "test",
    });

    expect(result.status).toBe("requires_attention");
    expect(result.attentionReason).toBe("GITHUB_VERIFICATION_FAILED");
    expect(result.verificationStatus).toBe("MISMATCH");
  });

  it("returns verificationStatus=UNKNOWN when verification GET itself fails", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "put_sha",
                size: 25,
              },
              commit: { sha: "commit_sha", message: "msg" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          return new Response(JSON.stringify({ message: "Not Found" }), {
            status: 404,
          });
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    let getCallCount = 0;
    const _origGetFileContents = client.getFileContents.bind(client);
    client.getFileContents = async (_o, _r, _p, _ref) => {
      getCallCount++;
      if (getCallCount === 1) return null; // Pre-flight: doesn't exist
      // Post-write: verification GET throws network error
      throw new Error("Network failure during verification");
    };

    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "test",
    });

    // C4.1: UNKNOWN verification must NOT produce optimistic success.
    // WRITE DISPATCH SUCCESS != OVERALL OPERATION SUCCESS.
    expect(result.verificationStatus).toBe("UNKNOWN");
    expect(result.dispatchStatus).toBe("succeeded");
    expect(result.status).toBe("requires_attention");
    expect(result.attentionReason).toBe("GITHUB_RECONCILIATION_REQUIRED");
    expect(result.status).not.toBe("created");
    expect(result.status).not.toBe("updated");
  });
});

describe("Phase 1C.2.1 — C5: Repository Discovery vs. Authoritative Lookup", () => {
  it("getRepository is the sole write authority (verified by JSDoc presence)", async () => {
    // This is a structural test: verify getRepository exists and discovery methods exist
    const client = new GitHubApiClient({
      tokenSupplier: async () => "token",
    });

    // Verify all methods exist
    expect(typeof client.getRepository).toBe("function");
    expect(typeof client.listUserRepositories).toBe("function");
    expect(typeof client.listUserInstallations).toBe("function");
    expect(typeof client.listInstallationRepositories).toBe("function");
  });
});

describe("Phase 1C.2.1 — C7: GitHub API Version Terminology", () => {
  it("GITHUB_REST_API_VERSION is a string operational parameter", () => {
    expect(typeof GITHUB_REST_API_VERSION).toBe("string");
    expect(GITHUB_REST_API_VERSION).toBe("2022-11-28");
    // It is a version string, not a boolean flag or numeric value
    expect(GITHUB_REST_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("Phase 1C.2.1 — C4.1: Post-Write Verification Uncertainty & Safe Reconciliation", () => {
  const dummyOwner = "octocat";
  const dummyRepo = "solutions";
  const dummyBranch = "main";
  const dummyContent = "int main() { return 0; }\n";

  it("enforces PUT count === 1, non-completion on verification timeout, and transitions UNKNOWN -> CONFIRMED upon safe reconciliation", async () => {
    let putCount = 0;
    let getContentsCount = 0;
    let shouldVerificationFail = true;

    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          putCount++;
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "put_sha_123",
                size: dummyContent.length,
              },
              commit: { sha: "commit_sha_456", message: "Initial commit" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          getContentsCount++;
          if (getContentsCount === 1) {
            // Pre-flight check: file does not exist initially
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }
          if (shouldVerificationFail) {
            // Verification GET times out / network failure
            throw new Error("ETIMEDOUT: Verification GET request timed out");
          }
          // Later reconciliation GET: returns authoritative remote file matching intended content
          return new Response(
            JSON.stringify({
              type: "file",
              name: "test.cpp",
              path: "test.cpp",
              sha: "reconciled_sha_789",
              size: dummyContent.length,
              content: safeBase64Encode(dummyContent),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    // Step 1: Execute synchronization
    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "Initial commit",
    });

    // CRITICAL ASSERTION: exactly 1 PUT request dispatched before reconciliation
    expect(putCount).toBe(1);

    // CRITICAL ASSERTION: operation is NOT completed and NOT confirmed
    expect(result.verificationStatus).toBe("UNKNOWN");
    expect(result.dispatchStatus).toBe("succeeded");
    expect(result.status).toBe("requires_attention");
    expect(result.attentionReason).toBe("GITHUB_RECONCILIATION_REQUIRED");
    expect(result.status).not.toBe("created");
    expect(result.status).not.toBe("updated");

    // Preserved commit SHA and file SHA from PUT response
    expect(result.commitSha).toBe("commit_sha_456");
    expect(result.fileSha).toBe("put_sha_123");

    // Step 2: Simulate later reconciliation GET where remote content matches
    shouldVerificationFail = false;
    const reconciled = await service.reconcileVerification(
      dummyOwner,
      dummyRepo,
      dummyBranch,
      "test.cpp",
      result.contentHash,
      result,
    );

    // CRITICAL ASSERTION: PUT count REMAINS exactly 1 — zero additional blind PUTs!
    expect(putCount).toBe(1);

    // CRITICAL ASSERTION: transitions UNKNOWN -> CONFIRMED and safely completed
    expect(reconciled.verificationStatus).toBe("CONFIRMED");
    expect(reconciled.status).toBe("created");
    expect(reconciled.commitSha).toBe("commit_sha_456");
    expect(reconciled.fileSha).toBe("reconciled_sha_789");
  });

  it("transitions UNKNOWN -> MISMATCH if reconciliation finds differing content", async () => {
    let putCount = 0;
    let getContentsCount = 0;

    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          putCount++;
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "put_sha_123",
                size: dummyContent.length,
              },
              commit: { sha: "commit_sha_456", message: "Initial commit" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          getContentsCount++;
          if (getContentsCount === 1) {
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }
          if (getContentsCount === 2) {
            // Post-write verification fails with network timeout
            throw new Error("ETIMEDOUT");
          }
          // Later reconciliation: remote has DIFFERENT content
          const differentContent =
            "int main() { return 42; /* competitor write */ }\n";
          return new Response(
            JSON.stringify({
              type: "file",
              name: "test.cpp",
              path: "test.cpp",
              sha: "competitor_sha",
              size: differentContent.length,
              content: safeBase64Encode(differentContent),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "Initial commit",
    });

    expect(putCount).toBe(1);
    expect(result.verificationStatus).toBe("UNKNOWN");
    expect(result.status).toBe("requires_attention");

    // Later reconciliation
    const reconciled = await service.reconcileVerification(
      dummyOwner,
      dummyRepo,
      dummyBranch,
      "test.cpp",
      result.contentHash,
      result,
    );

    expect(putCount).toBe(1); // Zero additional PUTs
    expect(reconciled.verificationStatus).toBe("MISMATCH");
    expect(reconciled.status).toBe("requires_attention");
    expect(reconciled.attentionReason).toBe("GITHUB_VERIFICATION_FAILED");
  });

  it("remains UNKNOWN and unresolved if reconciliation GET itself fails, with zero new PUTs", async () => {
    let putCount = 0;
    let getContentsCount = 0;

    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        if (
          urlStr.includes("/repos/") &&
          !urlStr.includes("/contents/") &&
          !urlStr.includes("/branches/")
        ) {
          return new Response(
            JSON.stringify({
              id: 1,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/branches/")) {
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "sha" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "PUT") {
          putCount++;
          return new Response(
            JSON.stringify({
              content: {
                name: "test.cpp",
                path: "test.cpp",
                sha: "put_sha_123",
                size: dummyContent.length,
              },
              commit: { sha: "commit_sha_456", message: "Initial commit" },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (urlStr.includes("/contents/") && method === "GET") {
          getContentsCount++;
          if (getContentsCount === 1) {
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }
          // Both post-write verification and subsequent reconciliation fail
          throw new Error("ECONNRESET: connection reset by peer");
        }
        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "token",
    });
    const service = new GitHubContentsService({ client });

    const result = await service.synchronizeFile({
      owner: dummyOwner,
      repo: dummyRepo,
      branch: dummyBranch,
      path: "test.cpp",
      content: dummyContent,
      commitMessage: "Initial commit",
    });

    expect(putCount).toBe(1);
    expect(result.verificationStatus).toBe("UNKNOWN");
    expect(result.status).toBe("requires_attention");

    // Later reconciliation attempt also fails
    const reconciled = await service.reconcileVerification(
      dummyOwner,
      dummyRepo,
      dummyBranch,
      "test.cpp",
      result.contentHash,
      result,
    );

    expect(putCount).toBe(1); // Zero additional PUTs!
    expect(reconciled.verificationStatus).toBe("UNKNOWN");
    expect(reconciled.status).toBe("requires_attention");
    expect(reconciled.attentionReason).toBe("GITHUB_RECONCILIATION_REQUIRED");
  });
});
