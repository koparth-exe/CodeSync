import {
  DEFAULT_GITHUB_APP_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_OAUTH_TOKEN_URL,
  type DeviceCodeResponse,
  type DevicePollStatus,
  type OAuthTokenResponse,
} from "./types";
import { ErrorCode, GitHubAuthError } from "../errors";

export interface InitiateDeviceFlowOptions {
  readonly clientId?: string | undefined;
  readonly scope?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

export interface PollDeviceFlowOptions {
  readonly clientId?: string | undefined;
  readonly deviceCode: string;
  readonly interval: number;
  readonly expiresAt: number;
  readonly signal?: AbortSignal | undefined;
  readonly onStatus?: ((status: DevicePollStatus) => void) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly delayFn?: ((ms: number) => Promise<void>) | undefined;
  readonly clock?: (() => number) | undefined;
}

/**
 * Default asynchronous delay function using setTimeout.
 */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initiates the GitHub App Device Authorization Flow (RFC 8628 §3.1).
 * Fails closed without logging or exposing secrets.
 */
export async function initiateDeviceFlow(
  options: InitiateDeviceFlowOptions = {},
): Promise<DeviceCodeResponse> {
  const clientId = options.clientId ?? DEFAULT_GITHUB_APP_CLIENT_ID;
  const fetchFn = options.fetchFn ?? fetch;

  const body: Record<string, string> = {
    client_id: clientId,
  };
  if (options.scope) {
    body.scope = options.scope;
  }

  let res: Response;
  try {
    res = await fetchFn(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new GitHubAuthError(
      `Network failure requesting device code: ${(err as Error).message}`,
      ErrorCode.BROWSER_RUNTIME_UNAVAILABLE,
      "Unable to connect to GitHub. Please check your network connection.",
    );
  }

  if (!res.ok) {
    let errorDetail = `HTTP ${res.status}`;
    try {
      const errJson = (await res.json()) as Record<string, unknown>;
      if (typeof errJson.error_description === "string") {
        errorDetail = errJson.error_description;
      } else if (typeof errJson.error === "string") {
        errorDetail = errJson.error;
      }
    } catch {
      // Ignore JSON parse failure on non-200
    }
    throw new GitHubAuthError(
      `Failed to initiate device flow: ${errorDetail}`,
      ErrorCode.GITHUB_AUTH_REQUIRED,
      "Failed to initiate GitHub authorization. Please try again.",
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new GitHubAuthError(
      `Malformed JSON from GitHub device code endpoint: ${(err as Error).message}`,
      ErrorCode.GITHUB_AUTH_REQUIRED,
    );
  }

  if (
    typeof data.device_code !== "string" ||
    typeof data.user_code !== "string" ||
    typeof data.verification_uri !== "string" ||
    typeof data.expires_in !== "number"
  ) {
    throw new GitHubAuthError(
      "Missing required fields in GitHub device authorization response.",
      ErrorCode.GITHUB_AUTH_REQUIRED,
    );
  }

  const interval =
    typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;

  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval,
  };
}

/**
 * Polls GitHub OAuth token endpoint until user completes authorization,
 * device code expires, or error is received (RFC 8628 §3.4 / §3.5).
 * Never busy-loops; strictly respects server intervals and slow_down signals.
 */
export async function pollDeviceFlow(
  options: PollDeviceFlowOptions,
): Promise<OAuthTokenResponse> {
  const clientId = options.clientId ?? DEFAULT_GITHUB_APP_CLIENT_ID;
  const fetchFn = options.fetchFn ?? fetch;
  const delayFn = options.delayFn ?? defaultDelay;
  const clock = options.clock ?? Date.now;

  let currentIntervalSec = Math.max(options.interval, 1);

  while (clock() < options.expiresAt) {
    if (options.signal?.aborted) {
      throw new GitHubAuthError(
        "Device authorization was aborted by caller.",
        ErrorCode.GITHUB_AUTH_REQUIRED,
        "Authorization was cancelled.",
      );
    }

    // Await server-specified polling interval before each poll
    await delayFn(currentIntervalSec * 1000);

    if (options.signal?.aborted) {
      throw new GitHubAuthError(
        "Device authorization was aborted by caller.",
        ErrorCode.GITHUB_AUTH_REQUIRED,
        "Authorization was cancelled.",
      );
    }

    let res: Response;
    try {
      res = await fetchFn(GITHUB_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: options.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
    } catch {
      // Network glitch during poll: continue with backoff if time permits
      options.onStatus?.("pending");
      continue;
    }

    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON response: continue with backoff
      continue;
    }

    // Case 1: Successful token issuance
    if (typeof data.access_token === "string") {
      if (typeof data.refresh_token !== "string") {
        throw new GitHubAuthError(
          "GitHub issued user access token without required rotating refresh token.",
          ErrorCode.GITHUB_AUTH_REQUIRED,
          "Authorization failed: App requires rotating refresh tokens enabled.",
        );
      }

      options.onStatus?.("complete");

      const expiresIn =
        typeof data.expires_in === "number" ? data.expires_in : 28800; // 8 hours default
      const refreshTokenExpiresIn =
        typeof data.refresh_token_expires_in === "number"
          ? data.refresh_token_expires_in
          : 15552000; // 6 months default

      return {
        access_token: data.access_token,
        token_type:
          typeof data.token_type === "string" ? data.token_type : "bearer",
        scope: typeof data.scope === "string" ? data.scope : undefined,
        expires_in: expiresIn,
        refresh_token: data.refresh_token,
        refresh_token_expires_in: refreshTokenExpiresIn,
      };
    }

    // Case 2: Documented RFC 8628 / GitHub error responses
    const error = typeof data.error === "string" ? data.error : "unknown_error";
    const errorDescription =
      typeof data.error_description === "string"
        ? data.error_description
        : undefined;

    switch (error) {
      case "authorization_pending":
        options.onStatus?.("pending");
        // Continue polling at existing interval
        break;

      case "slow_down":
        options.onStatus?.("slow_down");
        // RFC 8628 §3.5: MUST add 5 seconds to interval
        if (
          typeof data.interval === "number" &&
          data.interval > currentIntervalSec
        ) {
          currentIntervalSec = data.interval;
        } else {
          currentIntervalSec += 5;
        }
        break;

      case "access_denied":
        throw new GitHubAuthError(
          `User denied device authorization: ${errorDescription ?? error}`,
          ErrorCode.GITHUB_AUTHORIZATION_DENIED,
          "GitHub authorization was denied by the user.",
        );

      case "expired_token":
        throw new GitHubAuthError(
          `Device code expired: ${errorDescription ?? error}`,
          ErrorCode.GITHUB_DEVICE_CODE_EXPIRED,
          "The device code expired. Please initiate authorization again.",
        );

      case "device_flow_disabled":
        throw new GitHubAuthError(
          `Device flow is disabled for GitHub App: ${errorDescription ?? error}`,
          ErrorCode.GITHUB_DEVICE_FLOW_DISABLED,
          "Device authorization is disabled for this GitHub App.",
        );

      case "incorrect_device_code":
        throw new GitHubAuthError(
          `Incorrect device code provided: ${errorDescription ?? error}`,
          ErrorCode.GITHUB_INCORRECT_DEVICE_CODE,
          "Invalid device authorization code.",
        );

      default:
        throw new GitHubAuthError(
          `GitHub device authorization failed: ${error} - ${errorDescription ?? ""}`,
          ErrorCode.GITHUB_AUTH_REQUIRED,
          "GitHub authorization failed. Please try again.",
        );
    }
  }

  // Loop terminated due to expiresAt window passing
  throw new GitHubAuthError(
    "Device authorization timed out before user completion.",
    ErrorCode.GITHUB_DEVICE_CODE_EXPIRED,
    "The authorization request timed out. Please try again.",
  );
}
