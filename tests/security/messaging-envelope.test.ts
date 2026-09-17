import { describe, expect, it, beforeEach } from "vitest";
import {
  MessageEnvelopeValidator,
  MAX_MESSAGE_AGE_MS,
  MAX_FUTURE_SKEW_MS,
} from "../../src/shared/messaging/validator";
import { TrustBoundary } from "../../src/shared/types/trust";
import {
  EnvelopeValidationError,
  ErrorCode,
  SecurityError,
} from "../../src/shared/errors";

describe("Message Envelope Validation & Anti-Replay Suite (S5, S6)", () => {
  let validator: MessageEnvelopeValidator;

  beforeEach(() => {
    validator = new MessageEnvelopeValidator();
  });

  function createValidEnvelope(overrides: Record<string, unknown> = {}) {
    return {
      id: crypto.randomUUID(),
      type: "SUBMISSION_DETECTED",
      payload: { submissionId: "sub_123" },
      timestamp: Date.now(),
      senderContext: "content-script",
      ...overrides,
    };
  }

  it("accepts a well-formed envelope with valid UUID nonce and fresh timestamp", () => {
    const raw = createValidEnvelope();
    const validated = validator.validateEnvelope(raw);

    expect(validated.id).toBe(raw.id);
    expect(validated.type).toBe("SUBMISSION_DETECTED");
    expect(validated.senderContext).toBe("content-script");
    expect(validated.trustBoundary).toBe(TrustBoundary.SEMI_TRUSTED);
  });

  it("assigns TRUSTED boundary to popup and options sender contexts", () => {
    const popupMsg = createValidEnvelope({
      type: "GET_STATUS",
      senderContext: "popup",
    });
    const validated = validator.validateEnvelope(popupMsg);
    expect(validated.trustBoundary).toBe(TrustBoundary.TRUSTED);
  });

  it("rejects non-object or null envelopes", () => {
    expect(() => validator.validateEnvelope(null)).toThrow(
      EnvelopeValidationError,
    );
    expect(() => validator.validateEnvelope(undefined)).toThrow(
      EnvelopeValidationError,
    );
    expect(() => validator.validateEnvelope("string-envelope")).toThrow(
      EnvelopeValidationError,
    );
  });

  it("rejects envelopes with malformed or missing UUID v4 nonce", () => {
    const badNonces = [
      "",
      "12345",
      "not-a-uuid",
      "12345678-1234-1234-1234-123456789abc", // Not v4 (version digit not 4)
      "../../traversal",
    ];

    for (const badNonce of badNonces) {
      const msg = createValidEnvelope({ id: badNonce });
      expect(() => validator.validateEnvelope(msg)).toThrow(
        EnvelopeValidationError,
      );
    }
  });

  it("rejects expired envelopes exceeding the 30-second sliding window", () => {
    const expiredTimestamp = Date.now() - (MAX_MESSAGE_AGE_MS + 1000);
    const msg = createValidEnvelope({ timestamp: expiredTimestamp });

    expect(() => validator.validateEnvelope(msg)).toThrow(
      EnvelopeValidationError,
    );
  });

  it("rejects envelopes with future timestamp skew exceeding 5 seconds", () => {
    const futureTimestamp = Date.now() + (MAX_FUTURE_SKEW_MS + 2000);
    const msg = createValidEnvelope({ timestamp: futureTimestamp });

    expect(() => validator.validateEnvelope(msg)).toThrow(
      EnvelopeValidationError,
    );
  });

  it("rejects replayed messages using previously seen nonce (Anti-Replay)", () => {
    const msg = createValidEnvelope();
    // First delivery must pass
    const firstResult = validator.validateEnvelope(msg);
    expect(firstResult.id).toBe(msg.id);

    // Immediate replay of identical message must fail closed
    expect(() => validator.validateEnvelope(msg)).toThrow(
      EnvelopeValidationError,
    );
    try {
      validator.validateEnvelope(msg);
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeValidationError);
      expect((e as EnvelopeValidationError).code).toBe(
        ErrorCode.REPLAY_ATTACK_DETECTED,
      );
    }
  });

  it("rejects unknown or invalid message action types", () => {
    const msg = createValidEnvelope({ type: "MALICIOUS_ADMIN_INJECT" });
    expect(() => validator.validateEnvelope(msg)).toThrow(
      EnvelopeValidationError,
    );
  });

  it("rejects invalid sender contexts", () => {
    const msg = createValidEnvelope({ senderContext: "external_webpage" });
    expect(() => validator.validateEnvelope(msg)).toThrow(
      EnvelopeValidationError,
    );
  });

  it("enforces expected sender context when specified", () => {
    const msg = createValidEnvelope({ senderContext: "content-script" });
    expect(() => validator.validateEnvelope(msg, "popup")).toThrow(
      SecurityError,
    );
  });

  it("forbids semi-trusted content scripts from invoking privileged administrative actions (S6)", () => {
    const privilegedTypes = [
      "PURGE_COMPLETED",
      "UPDATE_CONFIG",
      "CANCEL_QUEUE_ITEM",
      "RETRY_QUEUE_ITEM",
    ];

    for (const privilegedType of privilegedTypes) {
      const hostileMsg = createValidEnvelope({
        type: privilegedType,
        senderContext: "content-script",
      });

      expect(() => validator.validateEnvelope(hostileMsg)).toThrow(
        SecurityError,
      );
    }
  });

  it("allows trusted contexts (popup, background) to invoke privileged actions", () => {
    const popupMsg = createValidEnvelope({
      type: "UPDATE_CONFIG",
      senderContext: "popup",
      payload: { targetBranch: "main" },
    });

    const validated = validator.validateEnvelope(popupMsg);
    expect(validated.type).toBe("UPDATE_CONFIG");
    expect(validated.trustBoundary).toBe(TrustBoundary.TRUSTED);
  });

  describe("Runtime Sender Verification & Anti-Spoofing (Invariant A, B, C, D)", () => {
    it("detects and rejects spoofing when a content script claims to be background or popup", () => {
      // Content script tab sender claiming to be background
      const hostileMsg = createValidEnvelope({
        type: "UPDATE_CONFIG",
        senderContext: "background",
        payload: { targetBranch: "malicious-branch" },
      });

      const contentScriptRuntimeSender = {
        id: "codesync-ext-id",
        tab: { id: 42, url: "https://leetcode.com/problems/two-sum" },
      };

      expect(() =>
        validator.validateEnvelope(hostileMsg, contentScriptRuntimeSender),
      ).toThrow(SecurityError);

      try {
        validator.validateEnvelope(hostileMsg, contentScriptRuntimeSender);
      } catch (e) {
        expect(e).toBeInstanceOf(SecurityError);
        expect((e as SecurityError).code).toBe(ErrorCode.UNAUTHORIZED_SENDER);
      }
    });

    it("verifies popup and options runtime senders from extension URLs", () => {
      const popupMsg = createValidEnvelope({
        type: "GET_STATUS",
        senderContext: "popup",
      });

      const popupRuntimeSender = {
        id: "codesync-ext-id",
        url: "chrome-extension://codesync-ext-id/popup.html",
      };

      const validated = validator.validateEnvelope(
        popupMsg,
        popupRuntimeSender,
      );
      expect(validated.senderContext).toBe("popup");
      expect(validated.trustBoundary).toBe(TrustBoundary.TRUSTED);
    });

    it("rejects message when claimed context does not match direct runtime assertion", () => {
      const msg = createValidEnvelope({
        type: "SUBMISSION_DETECTED",
        senderContext: "content-script",
      });

      // Runtime verified as popup, but message claims content-script
      expect(() => validator.validateEnvelope(msg, "popup")).toThrow(
        SecurityError,
      );
    });
  });

  describe("Service Worker Restart & Replay Semantics (Section 9.1)", () => {
    it("rejects replayed messages within the same service worker lifecycle", () => {
      const msg = createValidEnvelope();
      validator.validateEnvelope(msg);

      expect(() => validator.validateEnvelope(msg)).toThrow(
        EnvelopeValidationError,
      );
    });

    it("rejects replayed messages after service worker restart if older than 30s sliding window", () => {
      // Message created 31 seconds ago
      const oldTimestamp = Date.now() - (MAX_MESSAGE_AGE_MS + 1000);
      const msg = createValidEnvelope({ timestamp: oldTimestamp });

      // Simulate SW restart by instantiating new validator (empty in-memory cache)
      const freshSwValidator = new MessageEnvelopeValidator();

      expect(() => freshSwValidator.validateEnvelope(msg)).toThrow(
        EnvelopeValidationError,
      );
    });

    it("ensures replayed messages across SW restart cannot bypass sender context authorization", () => {
      // Content script message captured
      const msg = createValidEnvelope({
        type: "UPDATE_CONFIG",
        senderContext: "content-script",
      });

      // Simulate SW restart
      const freshSwValidator = new MessageEnvelopeValidator();

      // Content script still cannot execute privileged action even if nonce was forgotten
      expect(() => freshSwValidator.validateEnvelope(msg)).toThrow(
        SecurityError,
      );
    });
  });
});
