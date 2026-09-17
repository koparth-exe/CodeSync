import { describe, expect, it } from "vitest";
import {
  BrowserRuntimeError,
  CodeSyncError,
  ConfigurationError,
  ErrorCode,
  InvariantViolationError,
  SecurityError,
  ValidationError,
} from "../../src/shared/errors";

describe("Error Handling & Fail-Closed Invariants (S14)", () => {
  it("guarantees that all CodeSync errors enforce failClosed = true", () => {
    const errors: CodeSyncError[] = [
      new CodeSyncError(ErrorCode.INVARIANT_VIOLATION, "test internal"),
      new ValidationError("Invalid payload"),
      new ConfigurationError("Invalid configuration"),
      new BrowserRuntimeError("Service dead"),
      new InvariantViolationError("State corruption"),
      new SecurityError("Origin spoof detected"),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(CodeSyncError);
      expect(err).toBeInstanceOf(Error);
      expect(err.failClosed).toBe(true);
      expect(typeof err.code).toBe("string");
      expect(typeof err.userMessage).toBe("string");
      expect(err.timestamp).toBeGreaterThan(0);
    }
  });

  it("separates sensitive internal debug message from safe userMessage", () => {
    const internalDetails =
      "Token ghu_secret1234567890 failed at line 42 with code 0x88";
    const error = new SecurityError(
      internalDetails,
      "Operation blocked by security policy.",
    );

    expect(error.message).toContain(internalDetails);
    expect(error.userMessage).toBe("Operation blocked by security policy.");
    expect(error.userMessage).not.toContain("ghu_");
    expect(error.userMessage).not.toContain("line 42");
  });

  it("provides safe fallback userMessage if none specified", () => {
    const error = new CodeSyncError(
      ErrorCode.INVARIANT_VIOLATION,
      "internal details",
    );
    expect(error.userMessage).toBe(
      "An unexpected error occurred. Operation aborted safely.",
    );
  });
});
