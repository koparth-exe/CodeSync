import { describe, expect, it, vi } from "vitest";
import { GitHubApiClient } from "../../src/shared/github/client";
import {
  ErrorCode,
  GitHubApiError,
  GitHubConflictError,
  GitHubRateLimitError,
} from "../../src/shared/errors";
import {
  GITHUB_ACCEPT_HEADER,
  GITHUB_API_BASE_URL,
  GITHUB_REST_API_VERSION,
} from "../../src/shared/github/types";
import type { DurableTokenLifecycleManager } from "../../src/shared/auth/token-lifecycle";

describe("Centralized GitHub REST API Client (Phase 1C.2-A)", () => {
  const dummyToken = "ghu_dummy_access_token_12345678901234567890";

  // Helper to create client with mocked fetch
  function createClient(fetchMock: typeof fetch, options = {}) {
    return new GitHubApiClient({
      baseUrl: GITHUB_API_BASE_URL,
      fetchFn: fetchMock,
      tokenSupplier: async () => dummyToken,
      timeoutMs: 1000,
      ...options,
    });
  }

  // ==========================================================================
  // 1. HTTPS & URL Security
  // ==========================================================================
  describe("HTTPS Enforcement & Safe URL Construction", () => {
    it("rejects non-HTTPS base URLs fail-closed", () => {
      expect(
        () =>
          new GitHubApiClient({
            baseUrl: "http://api.github.com",
          }),
      ).toThrow(GitHubApiError);

      try {
        new GitHubApiClient({ baseUrl: "http://api.github.com" });
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(ErrorCode.SECURITY_VIOLATION);
      }
    });

    it("rejects file:// and other non-HTTPS schemes", () => {
      expect(
        () =>
          new GitHubApiClient({
            baseUrl: "file:///etc/api.github.com",
          }),
      ).toThrow(GitHubApiError);
    });

    it("NEVER includes tokens in URL or query parameters", async () => {
      let requestedUrl = "";
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        requestedUrl = url.toString();
        return new Response(JSON.stringify({ id: 12345, name: "repo" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await client.getRepository("octocat", "hello-world");

      expect(requestedUrl).not.toContain(dummyToken);
      expect(requestedUrl).not.toContain("access_token");
      expect(requestedUrl).not.toContain("token=");
    });

    it("rejects CRLF and null-byte injection in path segments", async () => {
      const client = createClient(vi.fn());
      await expect(client.getRepository("octo\r\ncat", "repo")).rejects.toThrow(
        GitHubApiError,
      );

      await expect(
        client.getRepository("octocat", "repo\0name"),
      ).rejects.toThrow(GitHubApiError);
    });
  });

  // ==========================================================================
  // 2. Request Headers Audit
  // ==========================================================================
  describe("Request Headers Audit", () => {
    it("attaches required Accept, Version, no-store, and Authorization headers", async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedCache: string | undefined = undefined;

      const fetchMock = vi.fn(
        async (
          _url: string | URL | Request,
          init?: RequestInit | undefined,
        ) => {
          capturedHeaders = (init?.headers as Record<string, string>) ?? {};
          capturedCache = init?.cache;
          return new Response(
            JSON.stringify({
              id: 1,
              name: "test-repo",
              owner: { login: "user" },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      ) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await client.getRepository("user", "test-repo");

      expect(capturedHeaders["Accept"]).toBe(GITHUB_ACCEPT_HEADER);
      expect(capturedHeaders["X-GitHub-Api-Version"]).toBe(
        GITHUB_REST_API_VERSION,
      );
      expect(capturedHeaders["Authorization"]).toBe(`Bearer ${dummyToken}`);
      expect(capturedCache).toBe("no-store");
    });
  });

  // ==========================================================================
  // 3. Rate Limit Tracking
  // ==========================================================================
  describe("Rate Limit Tracking & Handling", () => {
    it("throws GitHubRateLimitError on HTTP 429 with retry-after parsing", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({ message: "API rate limit exceeded" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1789305000",
              "retry-after": "60",
            },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);

      await expect(client.getRepository("owner", "repo")).rejects.toThrow(
        GitHubRateLimitError,
      );

      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubRateLimitError);
        const rateLimitErr = err as GitHubRateLimitError;
        expect(rateLimitErr.retryAfterSeconds).toBe(60);
        expect(rateLimitErr.resetTimestamp).toBe(1789305000 * 1000);
      }
    });

    it("throws GitHubRateLimitError on HTTP 403 when remaining is 0", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({ message: "Secondary rate limit reached" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1789306000",
            },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(client.getRepository("owner", "repo")).rejects.toThrow(
        GitHubRateLimitError,
      );
    });
  });

  // ==========================================================================
  // 4. HTTP Error Taxonomy & Redaction
  // ==========================================================================
  describe("HTTP Error Taxonomy & Secret Redaction", () => {
    it("classifies HTTP 401 as GITHUB_UNAUTHORIZED", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(client.getRepository("owner", "repo")).rejects.toThrow(
        GitHubApiError,
      );

      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_UNAUTHORIZED,
        );
      }
    });

    it("classifies HTTP 403 as GITHUB_FORBIDDEN when quota remains", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "4950",
            },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(ErrorCode.GITHUB_FORBIDDEN);
      }
    });

    it("classifies HTTP 404 as GITHUB_NOT_FOUND", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_REPOSITORY_NOT_FOUND,
        );
      }
    });

    it("classifies HTTP 409 as GITHUB_CONFLICT", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({ message: "Conflict: sha does not match" }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(
        client.createOrUpdateFile("owner", "repo", "test.cpp", {
          message: "test",
          content: "Y29udGVudA==",
          branch: "main",
          sha: "stale_sha",
        }),
      ).rejects.toThrow(GitHubConflictError);
    });

    it("classifies 5xx errors as retryable GITHUB_API_ERROR", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response("Internal Server Error", { status: 500 });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        const apiErr = err as GitHubApiError;
        expect(apiErr.isRetryable).toBe(true);
        expect(apiErr.code).toBe(ErrorCode.GITHUB_API_ERROR);
      }
    });

    it("redacts tokens if inadvertently returned in remote error message", async () => {
      const hostileMessage = `Failed with token: ghu_secret_token_12345678901234567890 for user`;
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ message: hostileMessage }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      try {
        await client.getRepository("owner", "repo");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("ghu_secret_token_12345678901234567890");
        expect(msg).toContain("[REDACTED_GHU_TOKEN]");
      }
    });
  });

  // ==========================================================================
  // 5. Coordinated 401 Token Refresh Handling
  // ==========================================================================
  describe("Coordinated 401 Refresh Handling", () => {
    it("refreshes token once and retries request upon receiving 401", async () => {
      let callCount = 0;
      const freshToken = "ghu_refreshed_token_09876543210987654321";

      const mockLifecycleManager = {
        getValidAccessToken: vi.fn(
          async ({ forceRefresh }: { forceRefresh?: boolean }) => {
            return forceRefresh ? freshToken : dummyToken;
          },
        ),
      } as unknown as DurableTokenLifecycleManager;

      const fetchMock = vi.fn(
        async (
          _url: string | URL | Request,
          init?: RequestInit | undefined,
        ) => {
          callCount++;
          const auth = (init?.headers as Record<string, string>)[
            "Authorization"
          ];

          if (callCount === 1) {
            expect(auth).toBe(`Bearer ${dummyToken}`);
            // First call fails with 401
            return new Response(
              JSON.stringify({ message: "Bad credentials" }),
              {
                status: 401,
                headers: { "Content-Type": "application/json" },
              },
            );
          }

          // Second call should have fresh token and succeed
          expect(auth).toBe(`Bearer ${freshToken}`);
          return new Response(
            JSON.stringify({
              id: 999,
              name: "my-repo",
              owner: { login: "owner" },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      ) as unknown as typeof fetch;

      const client = new GitHubApiClient({
        fetchFn: fetchMock,
        lifecycleManager: mockLifecycleManager,
      });

      const repo = await client.getRepository("owner", "my-repo");
      expect(callCount).toBe(2);
      expect(repo.id).toBe(999);
      expect(mockLifecycleManager.getValidAccessToken).toHaveBeenCalledWith({
        forceRefresh: true,
      });
    });

    it("stops after one retry if refreshed token also receives 401", async () => {
      let callCount = 0;
      const mockLifecycleManager = {
        getValidAccessToken: vi.fn(
          async () => "ghu_new_token_12345678901234567890",
        ),
      } as unknown as DurableTokenLifecycleManager;

      const fetchMock = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = new GitHubApiClient({
        fetchFn: fetchMock,
        lifecycleManager: mockLifecycleManager,
      });

      await expect(client.getRepository("owner", "repo")).rejects.toThrow(
        GitHubApiError,
      );
      // Must not create an infinite retry loop
      expect(callCount).toBe(2);
    });
  });

  // ==========================================================================
  // 6. Branch Validation
  // ==========================================================================
  describe("Authoritative Branch Validation", () => {
    it("returns branch metadata when branch exists", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            name: "main",
            commit: { sha: "commit_sha_123" },
            protected: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      const branch = await client.getBranch("owner", "repo", "main");

      expect(branch.name).toBe("main");
      expect(branch.sha).toBe("commit_sha_123");
      expect(branch.protected).toBe(false);
    });

    it("fails closed with GITHUB_BRANCH_NOT_FOUND when branch does not exist", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Branch not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(
        client.getBranch("owner", "repo", "nonexistent"),
      ).rejects.toThrow(GitHubApiError);

      try {
        await client.getBranch("owner", "repo", "nonexistent");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_BRANCH_NOT_FOUND,
        );
      }
    });

    it("rejects invalid branch grammar with traversal before making network request", async () => {
      const fetchMock = vi.fn();
      const client = createClient(fetchMock);

      await expect(
        client.getBranch("owner", "repo", "../evil-branch"),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 7. Contents API — Read & Write
  // ==========================================================================
  describe("Contents API Read & Write", () => {
    it("reads normal file, decodes Base64, and computes content hash", async () => {
      const rawCode = "int main() { return 0; }\n";
      const b64 = Buffer.from(rawCode, "utf-8").toString("base64");

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            type: "file",
            name: "main.cpp",
            path: "solutions/main.cpp",
            sha: "blob_sha_abc",
            size: rawCode.length,
            content: b64,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      const file = await client.getFileContents(
        "owner",
        "repo",
        "solutions/main.cpp",
        "main",
      );

      expect(file).not.toBeNull();
      expect(file?.type).toBe("file");
      expect(file?.decodedContent).toBe(rawCode);
      expect(file?.sha).toBe("blob_sha_abc");
      expect(file?.contentHash).toBeDefined();
      expect(file?.contentHash?.length).toBe(64); // 64 hex characters for SHA-256
    });

    it("returns null when file does not exist (HTTP 404)", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      const file = await client.getFileContents(
        "owner",
        "repo",
        "solutions/new-file.cpp",
      );
      expect(file).toBeNull();
    });

    it("fails closed when target path is a directory", async () => {
      const fetchMock = vi.fn(async () => {
        // GitHub returns an array when target path is a folder
        return new Response(
          JSON.stringify([
            { name: "file1.cpp", type: "file" },
            { name: "file2.cpp", type: "file" },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(
        client.getFileContents("owner", "repo", "solutions"),
      ).rejects.toThrow(GitHubApiError);

      try {
        await client.getFileContents("owner", "repo", "solutions");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_TARGET_IS_DIRECTORY,
        );
      }
    });

    it("rejects files exceeding 500 KB limit fail-closed", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            type: "file",
            name: "huge.cpp",
            path: "solutions/huge.cpp",
            sha: "blob_sha_huge",
            size: 600 * 1024, // 600 KB > 500 KB limit
            content: "",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      await expect(
        client.getFileContents("owner", "repo", "solutions/huge.cpp"),
      ).rejects.toThrow(GitHubApiError);

      try {
        await client.getFileContents("owner", "repo", "solutions/huge.cpp");
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_PAYLOAD_TOO_LARGE,
        );
      }
    });

    it("creates or updates a file via PUT with correct payload structure", async () => {
      let sentBody: Record<string, unknown> = {};

      const fetchMock = vi.fn(
        async (
          _url: string | URL | Request,
          init?: RequestInit | undefined,
        ) => {
          sentBody = JSON.parse(init?.body as string) as Record<
            string,
            unknown
          >;
          return new Response(
            JSON.stringify({
              content: {
                name: "two-sum.cpp",
                path: "solutions/two-sum.cpp",
                sha: "new_blob_sha",
                size: 25,
              },
              commit: {
                sha: "commit_sha_xyz",
                message: "Solved two-sum",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        },
      ) as unknown as typeof fetch;

      const client = createClient(fetchMock);
      const res = await client.createOrUpdateFile(
        "owner",
        "repo",
        "solutions/two-sum.cpp",
        {
          message: "Solved two-sum",
          content: "Y29udGVudA==",
          branch: "main",
          sha: "existing_blob_sha",
        },
      );

      expect(res.commit.sha).toBe("commit_sha_xyz");
      expect(res.content.sha).toBe("new_blob_sha");
      expect(sentBody.message).toBe("Solved two-sum");
      expect(sentBody.sha).toBe("existing_blob_sha");
      expect(sentBody.branch).toBe("main");
    });
  });
});
