import { describe, expect, it, vi } from "vitest";
import {
  initiateDeviceFlow,
  pollDeviceFlow,
} from "../../src/shared/auth/device-flow";
import { ErrorCode, GitHubAuthError } from "../../src/shared/errors";
import { redactSensitiveData } from "../../src/shared/logger/redactor";

describe("GitHub Device Authorization Flow Test Suite (AUTH-01 - AUTH-07)", () => {
  it("AUTH-01: Device flow successful authorization", async () => {
    let pollCount = 0;
    const mockFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("/login/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "mock_device_code_12345",
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/login/oauth/access_token")) {
        pollCount++;
        return new Response(
          JSON.stringify({
            access_token: "ghu_mockAccessToken1234567890",
            token_type: "bearer",
            scope: "repo",
            expires_in: 28800,
            refresh_token: "ghr_mockRefreshToken1234567890",
            refresh_token_expires_in: 15552000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("Not Found", { status: 404 });
    });

    // Step 1: Initiate
    const initRes = await initiateDeviceFlow({
      clientId: "test_client_id",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(initRes.device_code).toBe("mock_device_code_12345");
    expect(initRes.user_code).toBe("WDJB-MJHT");
    expect(initRes.verification_uri).toBe("https://github.com/login/device");
    expect(initRes.interval).toBe(5);

    // Step 2: Poll
    let currentTime = 1000;
    const tokenRes = await pollDeviceFlow({
      clientId: "test_client_id",
      deviceCode: initRes.device_code,
      interval: initRes.interval,
      expiresAt: currentTime + initRes.expires_in * 1000,
      fetchFn: mockFetch as unknown as typeof fetch,
      delayFn: async (ms: number) => {
        currentTime += ms;
      },
      clock: () => currentTime,
    });

    expect(tokenRes.access_token).toBe("ghu_mockAccessToken1234567890");
    expect(tokenRes.refresh_token).toBe("ghr_mockRefreshToken1234567890");
    expect(tokenRes.expires_in).toBe(28800);
    expect(pollCount).toBe(1);
  });

  it("AUTH-02: authorization_pending handling", async () => {
    let pollCount = 0;
    const statuses: string[] = [];

    const mockFetch = vi.fn(async () => {
      pollCount++;
      if (pollCount < 3) {
        return new Response(
          JSON.stringify({
            error: "authorization_pending",
            error_description: "The authorization request is still pending.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "ghu_successAfterPending12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_successAfterPending12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    const res = await pollDeviceFlow({
      clientId: "test_client_id",
      deviceCode: "dev_code",
      interval: 5,
      expiresAt: currentTime + 900_000,
      fetchFn: mockFetch as unknown as typeof fetch,
      delayFn: async (ms) => {
        currentTime += ms;
      },
      clock: () => currentTime,
      onStatus: (st) => statuses.push(st),
    });

    expect(pollCount).toBe(3);
    expect(res.access_token).toBe("ghu_successAfterPending12345");
    expect(statuses).toContain("pending");
    expect(statuses).toContain("complete");
  });

  it("AUTH-03: slow_down handling adds 5 seconds to interval", async () => {
    let pollCount = 0;
    const delayCalls: number[] = [];

    const mockFetch = vi.fn(async () => {
      pollCount++;
      if (pollCount === 1) {
        return new Response(
          JSON.stringify({
            error: "slow_down",
            error_description: "Too many requests. Slow down.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "ghu_successAfterSlowDown12345",
          token_type: "bearer",
          expires_in: 28800,
          refresh_token: "ghr_successAfterSlowDown12345",
          refresh_token_expires_in: 15552000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    const res = await pollDeviceFlow({
      clientId: "test_client_id",
      deviceCode: "dev_code",
      interval: 5,
      expiresAt: currentTime + 900_000,
      fetchFn: mockFetch as unknown as typeof fetch,
      delayFn: async (ms) => {
        delayCalls.push(ms);
        currentTime += ms;
      },
      clock: () => currentTime,
    });

    expect(pollCount).toBe(2);
    expect(res.access_token).toBe("ghu_successAfterSlowDown12345");
    // First delay is initial interval (5s = 5000ms)
    // Second delay after slow_down must be initial + 5s = 10s (10000ms)
    expect(delayCalls[0]).toBe(5000);
    expect(delayCalls[1]).toBe(10000);
  });

  it("AUTH-04: access_denied terminates with GITHUB_AUTHORIZATION_DENIED", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "access_denied",
          error_description: "The user has denied the authorization request.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    await expect(
      pollDeviceFlow({
        clientId: "test_client_id",
        deviceCode: "dev_code",
        interval: 5,
        expiresAt: currentTime + 900_000,
        fetchFn: mockFetch as unknown as typeof fetch,
        delayFn: async (ms) => {
          currentTime += ms;
        },
        clock: () => currentTime,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_AUTHORIZATION_DENIED,
      }),
    );
  });

  it("AUTH-05: expired device code handling", async () => {
    // Subcase 5A: Server returns expired_token
    const mockFetchServerExpired = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "expired_token",
          error_description: "The device code has expired.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    await expect(
      pollDeviceFlow({
        clientId: "test_client_id",
        deviceCode: "dev_code",
        interval: 5,
        expiresAt: currentTime + 900_000,
        fetchFn: mockFetchServerExpired as unknown as typeof fetch,
        delayFn: async (ms) => {
          currentTime += ms;
        },
        clock: () => currentTime,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_DEVICE_CODE_EXPIRED,
      }),
    );

    // Subcase 5B: Local clock passes expiresAt window
    const mockFetchPending = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "authorization_pending",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    currentTime = 1000;
    const expiresAt = currentTime + 10_000; // 10s lifetime
    await expect(
      pollDeviceFlow({
        clientId: "test_client_id",
        deviceCode: "dev_code",
        interval: 5,
        expiresAt,
        fetchFn: mockFetchPending as unknown as typeof fetch,
        delayFn: async (ms) => {
          currentTime += ms; // First tick: 1000 + 5000 = 6000. Second tick: 6000 + 5000 = 11000 (> 10000)
        },
        clock: () => currentTime,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_DEVICE_CODE_EXPIRED,
      }),
    );
  });

  it("AUTH-06: device_flow_disabled handling", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "device_flow_disabled",
          error_description: "Device flow is not enabled for this application.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    await expect(
      pollDeviceFlow({
        clientId: "test_client_id",
        deviceCode: "dev_code",
        interval: 5,
        expiresAt: currentTime + 900_000,
        fetchFn: mockFetch as unknown as typeof fetch,
        delayFn: async (ms) => {
          currentTime += ms;
        },
        clock: () => currentTime,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_DEVICE_FLOW_DISABLED,
      }),
    );
  });

  it("AUTH-07: incorrect device code handling", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "incorrect_device_code",
          error_description: "The device code provided is invalid.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    let currentTime = 1000;
    await expect(
      pollDeviceFlow({
        clientId: "test_client_id",
        deviceCode: "bad_dev_code",
        interval: 5,
        expiresAt: currentTime + 900_000,
        fetchFn: mockFetch as unknown as typeof fetch,
        delayFn: async (ms) => {
          currentTime += ms;
        },
        clock: () => currentTime,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_INCORRECT_DEVICE_CODE,
      }),
    );
  });

  it("Device Flow: AbortSignal cancels polling immediately", async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    let currentTime = 1000;
    const pollPromise = pollDeviceFlow({
      clientId: "test_client_id",
      deviceCode: "dev_code",
      interval: 5,
      expiresAt: currentTime + 900_000,
      signal: controller.signal,
      fetchFn: mockFetch as unknown as typeof fetch,
      delayFn: async (ms) => {
        currentTime += ms;
        controller.abort(); // Cancel during delay
      },
      clock: () => currentTime,
    });

    await expect(pollPromise).rejects.toThrowError(
      expect.objectContaining({
        code: ErrorCode.GITHUB_AUTH_REQUIRED,
      }),
    );
  });

  it("Secret Redaction: Device Flow errors never leak secrets", async () => {
    const errorWithSecret = new GitHubAuthError(
      "Failed with token ghu_sensitiveTokenValue1234567890 and device_code dev_secret_99999",
      ErrorCode.GITHUB_AUTH_REQUIRED,
    );

    const sanitized = redactSensitiveData(errorWithSecret) as {
      message: string;
    };
    expect(sanitized.message).not.toContain(
      "ghu_sensitiveTokenValue1234567890",
    );
    expect(sanitized.message).toContain("[REDACTED_GHU_TOKEN]");
  });
});
