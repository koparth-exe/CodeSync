import { describe, expect, it, vi } from "vitest";
import { GitHubApiClient } from "../../src/shared/github/client";
import { GitHubContentsService } from "../../src/shared/github/contents-service";
import {
  ErrorCode,
  GitHubApiError,
  GitHubWriteOutcomeUnknownError,
} from "../../src/shared/errors";
import {
  safeBase64Decode,
  safeBase64Encode,
} from "../../src/shared/github/client";
import type { GitHubWriteOptions } from "../../src/shared/github/types";

describe("GitHub Contents Write Protocol & Concurrency (Phase 1C.2)", () => {
  const dummyOwner = "octocat";
  const dummyRepo = "leetcode-solutions";
  const dummyBranch = "main";
  const dummyPath = "solutions/two-sum.cpp";
  const dummyContent = "int main() { return 0; }\n";

  // Creates a mock GitHub API client configured with mock responses
  function createMockSetup(options: {
    repoExists?: boolean;
    branchExists?: boolean;
    remoteFile?: { sha: string; content: string; type?: string } | null;
    putStatus?: number;
    putResponse?: Record<string, unknown>;
    verificationFile?: { sha: string; content: string; type?: string } | null;
  }) {
    const {
      repoExists = true,
      branchExists = true,
      remoteFile = null,
      putStatus = 201,
      putResponse,
      verificationFile,
    } = options;

    let currentRemoteFile = remoteFile;
    const putCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const getCalls: Array<string> = [];

    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit | undefined) => {
        const urlStr = url.toString();
        const method = init?.method ?? "GET";

        // GET /repos/{owner}/{repo}
        if (
          urlStr.endsWith(`/repos/${dummyOwner}/${dummyRepo}`) &&
          method === "GET"
        ) {
          if (!repoExists) {
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }
          return new Response(
            JSON.stringify({
              id: 1234567,
              name: dummyRepo,
              owner: { login: dummyOwner },
              default_branch: "main",
              permissions: { push: true },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // GET /repos/{owner}/{repo}/branches/{branch}
        if (
          urlStr.includes(
            `/repos/${dummyOwner}/${dummyRepo}/branches/${dummyBranch}`,
          ) &&
          method === "GET"
        ) {
          if (!branchExists) {
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }
          return new Response(
            JSON.stringify({
              name: dummyBranch,
              commit: { sha: "branch_commit_sha_123" },
              protected: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // GET /repos/{owner}/{repo}/contents/{path}
        if (
          urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}/contents/`) &&
          method === "GET"
        ) {
          getCalls.push(urlStr);

          // If verification file specified and this is a post-write GET
          const fileToReturn =
            putCalls.length > 0 && verificationFile !== undefined
              ? verificationFile
              : currentRemoteFile;

          if (!fileToReturn) {
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }

          if (fileToReturn.type === "dir") {
            return new Response(
              JSON.stringify([{ name: "child.cpp", type: "file" }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          const rawB64 = safeBase64Encode(fileToReturn.content);
          return new Response(
            JSON.stringify({
              type: fileToReturn.type ?? "file",
              name: "two-sum.cpp",
              path: dummyPath,
              sha: fileToReturn.sha,
              size: fileToReturn.content.length,
              content: rawB64,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // PUT /repos/{owner}/{repo}/contents/{path}
        if (
          urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}/contents/`) &&
          method === "PUT"
        ) {
          const body = JSON.parse(init?.body as string) as Record<
            string,
            unknown
          >;
          putCalls.push({ url: urlStr, body });

          if (putStatus === 409) {
            return new Response(
              JSON.stringify({ message: "Conflict: blob sha does not match" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }

          if (putStatus >= 400) {
            return new Response(JSON.stringify({ message: "Error" }), {
              status: putStatus,
              headers: { "Content-Type": "application/json" },
            });
          }

          const resPayload = putResponse ?? {
            content: {
              name: "two-sum.cpp",
              path: dummyPath,
              sha: "new_created_blob_sha",
              size: 25,
            },
            commit: {
              sha: "new_commit_sha_abc",
              message: body.message,
            },
          };

          // Update currentRemoteFile to newly written content for verification GET
          const decoded = safeBase64Decode(body.content as string);
          currentRemoteFile = {
            sha: (resPayload.content as { sha: string }).sha,
            content: decoded,
          };

          return new Response(JSON.stringify(resPayload), {
            status: putStatus,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("Not Handled", { status: 500 });
      },
    ) as unknown as typeof fetch;

    const client = new GitHubApiClient({
      fetchFn: fetchMock,
      tokenSupplier: async () => "ghu_dummy_token_12345678901234567890",
    });

    const service = new GitHubContentsService({ client });

    return {
      service,
      client,
      fetchMock,
      getPutCalls: () => putCalls,
      getGetCalls: () => getCalls,
      setRemoteFile: (file: { sha: string; content: string } | null) => {
        currentRemoteFile = file;
      },
    };
  }

  // ==========================================================================
  // 1. Transactional Write Protocol — Create & Update
  // ==========================================================================
  describe("Validated Transactional Write Protocol (Create & Update)", () => {
    it("creates a new file when target does not exist (PUT without SHA)", async () => {
      const { service, getPutCalls } = createMockSetup({
        remoteFile: null,
      });

      const writeOpts: GitHubWriteOptions = {
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      };

      const result = await service.synchronizeFile(writeOpts);

      expect(result.status).toBe("created");
      expect(result.commitSha).toBe("new_commit_sha_abc");
      expect(result.fileSha).toBe("new_created_blob_sha");
      expect(result.revalidationCount).toBe(0);

      // Verify PUT call was dispatched without SHA
      const putCalls = getPutCalls();
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]?.body.sha).toBeUndefined();
      expect(putCalls[0]?.body.branch).toBe(dummyBranch);
    });

    it("updates existing file using authoritative blob SHA (Optimistic Concurrency Control)", async () => {
      const existingSha = "existing_blob_sha_123";
      const existingContent = "int main() { return 1; }\n"; // Different content

      const { service, getPutCalls } = createMockSetup({
        remoteFile: { sha: existingSha, content: existingContent },
      });

      const writeOpts: GitHubWriteOptions = {
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Updated two-sum",
      };

      const result = await service.synchronizeFile(writeOpts);

      expect(result.status).toBe("updated");
      expect(result.commitSha).toBe("new_commit_sha_abc");
      expect(result.revalidationCount).toBe(0);

      // Verify PUT call included the authoritative existing blob SHA
      const putCalls = getPutCalls();
      expect(putCalls.length).toBe(1);
      expect(putCalls[0]?.body.sha).toBe(existingSha);
    });

    it("fails closed when target path exists as a directory", async () => {
      const { service } = createMockSetup({
        remoteFile: { sha: "dir_sha", content: "", type: "dir" },
      });

      await expect(
        service.synchronizeFile({
          owner: dummyOwner,
          repo: dummyRepo,
          branch: dummyBranch,
          path: dummyPath,
          content: dummyContent,
          commitMessage: "test",
        }),
      ).rejects.toThrow(GitHubApiError);

      try {
        await service.synchronizeFile({
          owner: dummyOwner,
          repo: dummyRepo,
          branch: dummyBranch,
          path: dummyPath,
          content: dummyContent,
          commitMessage: "test",
        });
      } catch (err) {
        expect((err as GitHubApiError).code).toBe(
          ErrorCode.GITHUB_TARGET_IS_DIRECTORY,
        );
      }
    });

    it("rejects oversized content (>500 KB) before network request", async () => {
      const { service, getPutCalls } = createMockSetup({});
      const hugeContent = "A".repeat(520_000); // 520 KB > 500 KB limit

      await expect(
        service.synchronizeFile({
          owner: dummyOwner,
          repo: dummyRepo,
          branch: dummyBranch,
          path: dummyPath,
          content: hugeContent,
          commitMessage: "test",
        }),
      ).rejects.toThrow(GitHubApiError);

      expect(getPutCalls().length).toBe(0);
    });
  });

  // ==========================================================================
  // 2. Duplicate Policies & Normalization Equivalence
  // ==========================================================================
  describe("Duplicate Policies & Normalization", () => {
    it("REPLACE_IF_DIFFERENT: skips write if remote content is identical (zero commits)", async () => {
      const identicalCode = "int main() { return 0; }\n";
      const { service, getPutCalls } = createMockSetup({
        remoteFile: { sha: "blob_sha_identical", content: identicalCode },
      });

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: identicalCode,
        commitMessage: "Duplicate submission",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
      });

      expect(result.status).toBe("skipped_identical");
      expect(result.fileSha).toBe("blob_sha_identical");
      expect(result.revalidationCount).toBe(0);
      expect(getPutCalls().length).toBe(0); // Zero PUT requests made!
    });

    it("REPLACE_IF_DIFFERENT: recognizes CRLF vs LF and trailing whitespace as identical", async () => {
      const remoteLinuxCode = "int main() {\n    return 0;\n}\n";
      // Local has Windows CRLF and trailing spaces per line
      const localWindowsCode = "int main() {  \r\n    return 0;  \r\n}\r\n\r\n";

      const { service, getPutCalls } = createMockSetup({
        remoteFile: { sha: "blob_sha_norm", content: remoteLinuxCode },
      });

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: localWindowsCode,
        commitMessage: "Duplicate with Windows line endings",
        duplicatePolicy: "REPLACE_IF_DIFFERENT",
      });

      expect(result.status).toBe("skipped_identical");
      expect(getPutCalls().length).toBe(0); // Identical normalized content -> zero writes!
    });

    it("CREATE_ONLY: skips write if target file exists", async () => {
      const { service, getPutCalls } = createMockSetup({
        remoteFile: { sha: "blob_sha_exists", content: "different code" },
      });

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "test",
        duplicatePolicy: "CREATE_ONLY",
      });

      expect(result.status).toBe("skipped_exists");
      expect(result.fileSha).toBe("blob_sha_exists");
      expect(getPutCalls().length).toBe(0);
    });

    it("ALWAYS_REPLACE: updates file even if content is identical", async () => {
      const { service, getPutCalls } = createMockSetup({
        remoteFile: { sha: "blob_sha_same", content: dummyContent },
      });

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Force update",
        duplicatePolicy: "ALWAYS_REPLACE",
      });

      expect(result.status).toBe("updated");
      expect(getPutCalls().length).toBe(1);
    });

    it("KEEP_ALL: generates versioned filename when base file exists", async () => {
      let putTargetUrl = "";

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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

          if (method === "GET") {
            // Check two-sum-v2.cpp first before two-sum.cpp
            if (urlStr.includes("two-sum-v2.cpp")) {
              if (putTargetUrl) {
                // Post-write verification GET: return written content
                return new Response(
                  JSON.stringify({
                    type: "file",
                    name: "two-sum-v2.cpp",
                    path: "solutions/two-sum-v2.cpp",
                    sha: "sha_v2",
                    size: dummyContent.length,
                    content: safeBase64Encode(dummyContent),
                  }),
                  {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  },
                );
              }
              // Before PUT: solutions/two-sum-v2.cpp DOES NOT EXIST (404)
              return new Response(JSON.stringify({ message: "Not Found" }), {
                status: 404,
              });
            }

            // Base file solutions/two-sum.cpp EXISTS
            if (urlStr.includes("two-sum.cpp")) {
              return new Response(
                JSON.stringify({
                  type: "file",
                  name: "two-sum.cpp",
                  path: "solutions/two-sum.cpp",
                  sha: "sha_base",
                  size: 10,
                  content: safeBase64Encode("existing code"),
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
          }

          if (method === "PUT") {
            putTargetUrl = urlStr;
            return new Response(
              JSON.stringify({
                content: {
                  name: "two-sum-v2.cpp",
                  path: "solutions/two-sum-v2.cpp",
                  sha: "sha_v2",
                  size: 20,
                },
                commit: { sha: "commit_sha_v2", message: "msg" },
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

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: "solutions/two-sum.cpp",
        content: dummyContent,
        commitMessage: "Version 2 submission",
        duplicatePolicy: "KEEP_ALL",
      });

      expect(result.status).toBe("created");
      expect(result.path).toBe("solutions/two-sum-v2.cpp");
      expect(putTargetUrl).toContain("two-sum-v2.cpp");
    });
  });

  // ==========================================================================
  // 3. 8-Step 409 Conflict Protocol
  // ==========================================================================
  describe("8-Step 409 Conflict Protocol", () => {
    it("handles first 409 by re-fetching remote state and retrying with fresh SHA", async () => {
      let putAttempts = 0;
      const initialStaleSha = "stale_sha_1";
      const freshSha2 = "fresh_remote_sha_2";
      const concurrentOtherCode = "int main() { return 42; }\n"; // Different code committed concurrently

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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
            // First pre-flight GET returns initialStaleSha
            // Second revalidation GET after 409 returns freshSha2
            const shaToReturn = putAttempts === 0 ? initialStaleSha : freshSha2;
            const contentToReturn =
              putAttempts === 0 ? "initial code" : concurrentOtherCode;

            return new Response(
              JSON.stringify({
                type: "file",
                name: "two-sum.cpp",
                path: dummyPath,
                sha: shaToReturn,
                size: contentToReturn.length,
                content: safeBase64Encode(
                  putAttempts >= 2 ? dummyContent : contentToReturn,
                ),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (urlStr.includes("/contents/") && method === "PUT") {
            putAttempts++;
            const body = JSON.parse(init?.body as string) as Record<
              string,
              unknown
            >;

            if (putAttempts === 1) {
              expect(body.sha).toBe(initialStaleSha);
              // First PUT fails with 409 Conflict
              return new Response(
                JSON.stringify({ message: "Conflict: sha does not match" }),
                {
                  status: 409,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            // Second PUT should have the fresh SHA
            expect(body.sha).toBe(freshSha2);
            return new Response(
              JSON.stringify({
                content: {
                  name: "two-sum.cpp",
                  path: dummyPath,
                  sha: "committed_sha_final",
                  size: 25,
                },
                commit: { sha: "commit_sha_final", message: "Solved" },
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
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      });

      expect(result.status).toBe("updated");
      expect(result.revalidationCount).toBe(1);
      expect(putAttempts).toBe(2);
    });

    it("skips write if remote state updated concurrently to identical content during 409", async () => {
      let putAttempts = 0;

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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
            // After 409, fresh GET reveals remote file already has the identical code!
            const content = putAttempts === 0 ? "old code" : dummyContent;

            return new Response(
              JSON.stringify({
                type: "file",
                name: "two-sum.cpp",
                path: dummyPath,
                sha: "blob_sha_concurrent_match",
                size: content.length,
                content: safeBase64Encode(content),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (urlStr.includes("/contents/") && method === "PUT") {
            putAttempts++;
            return new Response(
              JSON.stringify({ message: "Conflict: sha does not match" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
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
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      });

      // Policy re-evaluation detected remote content is now identical -> idempotent skip
      expect(result.status).toBe("skipped_identical");
      expect(result.revalidationCount).toBe(1);
      expect(putAttempts).toBe(1); // Zero further PUT attempts made
    });

    it("transitions to requires_attention after maximum 2 conflict revalidation passes", async () => {
      let putAttempts = 0;

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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
                name: "two-sum.cpp",
                path: dummyPath,
                sha: `sha_pass_${putAttempts}`,
                size: 20,
                content: safeBase64Encode(`different code ${putAttempts}`),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (urlStr.includes("/contents/") && method === "PUT") {
            putAttempts++;
            // Persistent 409 conflict on every attempt
            return new Response(JSON.stringify({ message: "Conflict" }), {
              status: 409,
              headers: { "Content-Type": "application/json" },
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

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      });

      expect(result.status).toBe("requires_attention");
      expect(result.attentionReason).toBe("GITHUB_CONFLICT");
      // Exactly 3 PUT attempts (initial + 2 revalidations), then STOP
      expect(putAttempts).toBe(3);
    });
  });

  // ==========================================================================
  // 4. Uncertain Write Outcome Handling (Reconciliation)
  // ==========================================================================
  describe("Uncertain Write Outcome Handling", () => {
    it("reconciles write as successful when remote file committed despite network drop", async () => {
      let putDispatched = false;

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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
            if (!putDispatched) {
              // Pre-flight check: file not yet present
              return new Response(JSON.stringify({ message: "Not Found" }), {
                status: 404,
              });
            }
            // Reconciliation check: file was committed upstream before network drop!
            return new Response(
              JSON.stringify({
                type: "file",
                name: "two-sum.cpp",
                path: dummyPath,
                sha: "committed_upstream_sha",
                size: dummyContent.length,
                content: safeBase64Encode(dummyContent),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          if (urlStr.includes("/contents/") && method === "PUT") {
            putDispatched = true;
            // Simulate network drop / timeout right after dispatch
            throw new TypeError("Failed to fetch: Connection reset by peer");
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
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      });

      // Successfully reconciled upstream commit without duplicating write
      expect(result.status).toBe("created");
      expect(result.fileSha).toBe("committed_upstream_sha");
    });

    it("throws GitHubWriteOutcomeUnknownError when network drops and remote commit absent", async () => {
      let putDispatched = false;

      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit | undefined) => {
          const urlStr = url.toString();
          const method = init?.method ?? "GET";

          if (
            urlStr.includes(`/repos/${dummyOwner}/${dummyRepo}`) &&
            !urlStr.includes("/contents/")
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
            // File still absent during reconciliation
            return new Response(JSON.stringify({ message: "Not Found" }), {
              status: 404,
            });
          }

          if (urlStr.includes("/contents/") && method === "PUT") {
            putDispatched = true;
            throw new TypeError("Network failure");
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
          path: dummyPath,
          content: dummyContent,
          commitMessage: "Solved two-sum",
        }),
      ).rejects.toThrow(GitHubWriteOutcomeUnknownError);

      expect(putDispatched).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Post-Write Authoritative Verification
  // ==========================================================================
  describe("Post-Write Authoritative Verification GET", () => {
    it("transitions to requires_attention if verification reveals discrepancy", async () => {
      const { service } = createMockSetup({
        remoteFile: null,
        // Post-write verification returns differing content
        verificationFile: {
          sha: "unexpected_blob_sha",
          content: "different content committed by third party",
        },
      });

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Solved two-sum",
      });

      expect(result.status).toBe("requires_attention");
      expect(result.attentionReason).toBe("GITHUB_VERIFICATION_FAILED");
    });
  });

  // ==========================================================================
  // 6. Deterministic Concurrency & Races
  // ==========================================================================
  describe("Deterministic Concurrency & Race Conditions", () => {
    it("safely handles deterministic A/B state modification using interleaving hooks", async () => {
      const { service, setRemoteFile } = createMockSetup({
        remoteFile: { sha: "worker_a_initial_sha", content: "initial code" },
      });

      // Hook: right before Worker A PUTs, simulate Worker B updating remote file
      service.onBeforePut = async () => {
        setRemoteFile({
          sha: "worker_b_updated_sha",
          content: "worker b code",
        });
      };

      const result = await service.synchronizeFile({
        owner: dummyOwner,
        repo: dummyRepo,
        branch: dummyBranch,
        path: dummyPath,
        content: dummyContent,
        commitMessage: "Worker A write",
      });

      // Successfully resolved through OCC and conflict revalidation
      expect(result.status).toBe("updated");
      expect(result.revalidationCount).toBe(0);
    });
  });
});
