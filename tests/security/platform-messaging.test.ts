import { describe, expect, it } from "vitest";
import {
  SubmissionHandler,
  createDefaultRegistry,
  type CanonicalSubmissionCandidate,
} from "../../src/shared/adapters";
import {
  type ExtensionMessage,
  type RuntimeSenderInfo,
} from "../../src/shared/messaging/types";
import { MessageEnvelopeValidator } from "../../src/shared/messaging/validator";
import { TrustBoundary } from "../../src/shared/types/trust";
import {
  ErrorCode,
  SecurityError,
  EnvelopeValidationError,
  PlatformAdapterError,
} from "../../src/shared/errors";
import { MAX_SOURCE_PAYLOAD_BYTES } from "../../src/shared/github/types";

describe("Phase 1C.3 — Platform Messaging & Security Validation", () => {
  function createValidCandidate(): CanonicalSubmissionCandidate {
    return {
      platform: "leetcode",
      problemId: "two-sum",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      status: "ACCEPTED",
      language: "cpp",
      sourceCode: "int main() { return 0; }\n",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      extractionConfidence: 0.9,
      extractionLayer: "dom",
    };
  }

  function createValidMessage(
    payload: CanonicalSubmissionCandidate = createValidCandidate(),
    id: string = crypto.randomUUID(),
  ): ExtensionMessage<CanonicalSubmissionCandidate> {
    return {
      id,
      type: "SUBMISSION_DETECTED",
      payload,
      timestamp: Date.now(),
      senderContext: "content-script",
      trustBoundary: TrustBoundary.SEMI_TRUSTED,
    };
  }

  function createHandler(): SubmissionHandler {
    return new SubmissionHandler(
      new MessageEnvelopeValidator(),
      createDefaultRegistry(),
    );
  }

  const validSender: RuntimeSenderInfo = {
    tab: {
      id: 1,
      url: "https://leetcode.com/problems/two-sum/",
    },
  };

  it("authoritatively validates and accepts a valid submission message from content script", () => {
    const handler = createHandler();
    const message = createValidMessage();

    const result = handler.handleMessage(message, validSender);
    expect(result.success).toBe(true);
    expect(result.candidate?.platform).toBe("leetcode");
    expect(result.candidate?.problemId).toBe("two-sum");
    expect(result.candidate?.status).toBe("ACCEPTED");
  });

  it("rejects replayed messages with identical UUID v4 nonce fail-closed", () => {
    const handler = createHandler();
    const fixedNonce = crypto.randomUUID();
    const message = createValidMessage(createValidCandidate(), fixedNonce);

    // First attempt succeeds
    const first = handler.handleMessage(message, validSender);
    expect(first.success).toBe(true);

    // Replay attack attempt with identical nonce
    expect(() => handler.handleMessage(message, validSender)).toThrow(
      EnvelopeValidationError,
    );
    try {
      handler.handleMessage(message, validSender);
    } catch (err) {
      const e = err as EnvelopeValidationError;
      expect(e.code).toBe(ErrorCode.REPLAY_ATTACK_DETECTED);
    }
  });

  it("rejects spoofed sender context claiming privileged contexts", () => {
    const handler = createHandler();
    const message: ExtensionMessage = {
      ...createValidMessage(),
      senderContext: "popup", // Content script cannot claim popup context
    };

    expect(() => handler.handleMessage(message, validSender)).toThrow();
  });

  it("rejects cross-origin platform spoofing (tab origin does not match claimed platform)", () => {
    const handler = createHandler();
    const candidate = createValidCandidate(); // Platform is leetcode
    const message = createValidMessage(candidate);

    const maliciousSender: RuntimeSenderInfo = {
      tab: {
        id: 2,
        url: "https://evil-attacker.com/problems/two-sum", // Attacker tab
      },
    };

    try {
      handler.handleMessage(message, maliciousSender);
      expect.unreachable("Should have thrown SecurityError");
    } catch (err) {
      const e = err as SecurityError;
      expect(e).toBeInstanceOf(SecurityError);
      expect(e.code).toBe(ErrorCode.SECURITY_VIOLATION);
      expect(e.message).toContain("Spoofed submission origin");
    }
  });

  it("rejects oversized source code exceeding MAX_SOURCE_PAYLOAD_BYTES (500KB)", () => {
    const handler = createHandler();
    const oversizedCode = "a".repeat(MAX_SOURCE_PAYLOAD_BYTES + 10);
    const candidate: CanonicalSubmissionCandidate = {
      ...createValidCandidate(),
      sourceCode: oversizedCode,
    };
    const message = createValidMessage(candidate);

    expect(() => handler.handleMessage(message, validSender)).toThrow(
      PlatformAdapterError,
    );
  });

  it("rejects forbidden binary or control characters in source code", () => {
    const handler = createHandler();
    const candidate: CanonicalSubmissionCandidate = {
      ...createValidCandidate(),
      sourceCode: "int main() { return 0; }\0", // Null byte injection
    };
    const message = createValidMessage(candidate);

    expect(() => handler.handleMessage(message, validSender)).toThrow(
      PlatformAdapterError,
    );
  });

  it("rejects dangerous URL schemes in problemUrl or sourceUrl", () => {
    const handler = createHandler();
    const candidate: CanonicalSubmissionCandidate = {
      ...createValidCandidate(),
      problemUrl: "javascript:alert(document.domain)",
    };
    const message = createValidMessage(candidate);

    expect(() => handler.handleMessage(message, validSender)).toThrow(
      SecurityError,
    );
  });

  it("rejects invalid or unrecognized submission status", () => {
    const handler = createHandler();
    const candidate = {
      ...createValidCandidate(),
      status: "INVALID_STATUS",
    } as unknown as CanonicalSubmissionCandidate;
    const message = createValidMessage(candidate);

    expect(() => handler.handleMessage(message, validSender)).toThrow(
      PlatformAdapterError,
    );
  });
});
