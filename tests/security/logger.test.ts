import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  redactSensitiveData,
  redactString,
} from "../../src/shared/logger";

describe("Logging Foundation & Sensitive Data Redactor (S11)", () => {
  describe("redactString", () => {
    it("redacts GitHub App user-to-server tokens (ghu_)", () => {
      const input =
        "Request authenticated with token ghu_16C7e42F292c6912E7710c838347Ae178B4a";
      const output = redactString(input);
      expect(output).not.toContain("ghu_16C7e42F292c6912E7710c838347Ae178B4a");
      expect(output).toContain("[REDACTED_GHU_TOKEN]");
    });

    it("redacts GitHub refresh tokens (ghr_)", () => {
      const input =
        "Rotated refresh token: ghr_1B4a16C7e42F292c6912E7710c838347Ae178B4a";
      const output = redactString(input);
      expect(output).not.toContain(
        "ghr_1B4a16C7e42F292c6912E7710c838347Ae178B4a",
      );
      expect(output).toContain("[REDACTED_GHR_REFRESH_TOKEN]");
    });

    it("redacts GitHub personal access tokens (ghp_)", () => {
      const input = "Using PAT: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const output = redactString(input);
      expect(output).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
      expect(output).toContain("[REDACTED_GHP_PAT]");
    });

    it("redacts Bearer Authorization headers", () => {
      const input =
        'Headers: { Authorization: "Bearer ghu_abc123secrettokenhere456789" }';
      const output = redactString(input);
      expect(output).not.toContain("ghu_abc123secrettokenhere456789");
      expect(output).toContain("Bearer [REDACTED_BEARER_TOKEN]");
    });
  });

  describe("redactSensitiveData", () => {
    it("redacts sensitive keys in nested objects", () => {
      const payload = {
        user: "developer",
        auth: {
          token: "ghu_secret_access_token_1234567890",
          client_secret: "super_secret_oauth_secret_value",
        },
        metadata: {
          submissionId: 12345,
        },
      };

      const sanitized = redactSensitiveData(payload) as Record<string, unknown>;
      const auth = sanitized.auth as Record<string, unknown>;

      expect(auth.token).toBe("[REDACTED_SENSITIVE_FIELD]");
      expect(auth.client_secret).toBe("[REDACTED_SENSITIVE_FIELD]");
      expect((sanitized.metadata as Record<string, unknown>).submissionId).toBe(
        12345,
      );
    });

    it("redacts sensitive values in arrays", () => {
      const list = [
        "normal string",
        "Authorization: Bearer ghu_token123456789012345678",
        { password: "my-password-123" },
      ];

      const sanitized = redactSensitiveData(list) as unknown[];
      expect(sanitized[0]).toBe("normal string");
      expect(sanitized[1]).toContain("[REDACTED_BEARER_TOKEN]");
      expect((sanitized[2] as Record<string, unknown>).password).toBe(
        "[REDACTED_SENSITIVE_FIELD]",
      );
    });

    it("redacts Error objects without losing error name", () => {
      const error = new Error(
        "Failed to connect with token ghu_sensitive123456789012345678",
      );
      const sanitized = redactSensitiveData(error) as {
        name: string;
        message: string;
      };

      expect(sanitized.name).toBe("Error");
      expect(sanitized.message).not.toContain(
        "ghu_sensitive123456789012345678",
      );
      expect(sanitized.message).toContain("[REDACTED_GHU_TOKEN]");
    });
  });

  describe("Logger instance behavior", () => {
    it("outputs structured log with context tag and sanitized arguments", () => {
      const logger = createLogger("TestContext");
      const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      logger.info("System event", { token: "ghu_secret_value_123456789012" });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [prefix, msg, data] = consoleSpy.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];

      expect(prefix).toContain("[CodeSync]");
      expect(prefix).toContain("[INFO]");
      expect(prefix).toContain("[TestContext]");
      expect(msg).toBe("System event");
      expect(data.token).toBe("[REDACTED_SENSITIVE_FIELD]");

      consoleSpy.mockRestore();
    });

    it("redacts error messages in logger.error", () => {
      const logger = createLogger("ErrorTest");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const err = new Error("HTTP 401 with Bearer ghu_abc123456789012345678");
      logger.error("Write failed", err);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const call = consoleSpy.mock.calls[0];
      const errorArg = call
        ? (call[2] as { message: string })
        : { message: "" };

      expect(errorArg.message).not.toContain("ghu_abc123456789012345678");
      expect(errorArg.message).toContain("[REDACTED_BEARER_TOKEN]");

      consoleSpy.mockRestore();
    });
  });
});
