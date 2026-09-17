import {
  CONTEXT_ALLOWED_ACTIONS,
  EXTENSION_MESSAGE_TYPES,
  TrustBoundary,
  type ExtensionMessage,
  type ExtensionMessageType,
  type RuntimeSenderInfo,
  type SenderContext,
} from "./types";
import { EnvelopeValidationError, ErrorCode, SecurityError } from "../errors";

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_MESSAGE_AGE_MS = 30_000; // 30 seconds
export const MAX_FUTURE_SKEW_MS = 5_000; // 5 seconds

/**
 * Derives trusted sender context from browser runtime sender metadata.
 * Invariant: Message payload fields NEVER establish authority.
 */
export function deriveTrustedSenderContext(
  runtimeSender?: RuntimeSenderInfo,
): SenderContext | null {
  if (!runtimeSender) return null;

  // A message from a browser tab is definitively from a content-script
  if (runtimeSender.tab) {
    return "content-script";
  }

  // Extension internal frames (popup / options / background)
  if (runtimeSender.url) {
    if (runtimeSender.url.includes("popup.html")) {
      return "popup";
    }
    if (runtimeSender.url.includes("options.html")) {
      return "options";
    }
  }

  // Without a tab, within the extension ID origin
  if (runtimeSender.id) {
    return "background";
  }

  return null;
}

/**
 * Validates cross-context extension message envelopes and enforces anti-replay protection.
 *
 * Strict Processing Order:
 * 1. Structural / schema validation
 * 2. Message freshness validation (sliding window)
 * 3. Nonce validation & in-memory anti-replay
 * 4. Trusted sender-context validation (verified against runtime, not claimed body)
 * 5. Context-to-action allowlist authorization
 * 6. Action-specific authorization
 * 7. Output envelope with authoritative trust boundary
 */
export class MessageEnvelopeValidator {
  private seenNonces = new Map<string, number>();

  /**
   * Cleans up expired nonces from memory cache.
   */
  private pruneNonces(now: number): void {
    for (const [nonce, expiry] of this.seenNonces.entries()) {
      if (now > expiry) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /**
   * Validates and unpacks an incoming message envelope.
   * Fails closed if message is malformed, expired, replayed, or unauthorized.
   *
   * @param raw Unvalidated message object from chrome.runtime.onMessage
   * @param runtimeSender Browser runtime MessageSender object providing verified context
   * @param expectedContext Expected caller context (optional constraint)
   */
  validateEnvelope<T = unknown>(
    raw: unknown,
    runtimeSender?: RuntimeSenderInfo | SenderContext,
    expectedContext?: SenderContext,
  ): ExtensionMessage<T> {
    // Step 1: Structural / Schema Validation
    if (!raw || typeof raw !== "object") {
      throw new EnvelopeValidationError(
        "Envelope must be a non-null object.",
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    const msg = raw as Record<string, unknown>;

    if (typeof msg.id !== "string" || !UUID_V4_REGEX.test(msg.id)) {
      throw new EnvelopeValidationError(
        "Message envelope missing valid UUID v4 nonce identifier.",
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    if (typeof msg.timestamp !== "number" || !Number.isFinite(msg.timestamp)) {
      throw new EnvelopeValidationError(
        "Message envelope missing valid numeric timestamp.",
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    if (
      typeof msg.type !== "string" ||
      !EXTENSION_MESSAGE_TYPES.includes(msg.type as ExtensionMessageType)
    ) {
      throw new EnvelopeValidationError(
        `Unknown or unsupported message type: ${String(msg.type)}`,
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    const validContexts: SenderContext[] = [
      "content-script",
      "popup",
      "options",
      "background",
    ];
    if (
      typeof msg.senderContext !== "string" ||
      !validContexts.includes(msg.senderContext as SenderContext)
    ) {
      throw new EnvelopeValidationError(
        `Invalid senderContext: ${String(msg.senderContext)}`,
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    const claimedSenderContext = msg.senderContext as SenderContext;
    const msgType = msg.type as ExtensionMessageType;

    // Step 2: Message Freshness Validation (Sliding Window)
    const now = Date.now();
    this.pruneNonces(now);

    if (now - msg.timestamp > MAX_MESSAGE_AGE_MS) {
      throw new EnvelopeValidationError(
        `Message expired: timestamp is older than ${MAX_MESSAGE_AGE_MS / 1000}s.`,
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    if (msg.timestamp - now > MAX_FUTURE_SKEW_MS) {
      throw new EnvelopeValidationError(
        `Message timestamp is in the future (> ${MAX_FUTURE_SKEW_MS / 1000}s skew).`,
        ErrorCode.ENVELOPE_VALIDATION_FAILED,
      );
    }

    // Step 3: Nonce Validation & Anti-Replay Verification
    if (this.seenNonces.has(msg.id)) {
      throw new EnvelopeValidationError(
        `Replay attack detected: nonce ${msg.id} was previously processed.`,
        ErrorCode.REPLAY_ATTACK_DETECTED,
      );
    }

    // Step 4: Trusted Sender-Context Validation
    // Never trust the message body alone to establish origin
    let authoritativeContext: SenderContext = claimedSenderContext;

    if (typeof runtimeSender === "string") {
      // Direct context assertion (e.g. from internal test or trusted wrapper)
      authoritativeContext = runtimeSender;
      if (claimedSenderContext !== authoritativeContext) {
        throw new SecurityError(
          `Spoofed senderContext: claimed '${claimedSenderContext}', verified as '${authoritativeContext}'.`,
          ErrorCode.UNAUTHORIZED_SENDER,
        );
      }
    } else if (runtimeSender && typeof runtimeSender === "object") {
      const derived = deriveTrustedSenderContext(runtimeSender);
      if (derived) {
        authoritativeContext = derived;
        if (claimedSenderContext !== authoritativeContext) {
          throw new SecurityError(
            `Spoofed senderContext: claimed '${claimedSenderContext}', verified from runtime as '${authoritativeContext}'.`,
            ErrorCode.UNAUTHORIZED_SENDER,
          );
        }
      }
    }

    if (expectedContext && authoritativeContext !== expectedContext) {
      throw new SecurityError(
        `Sender context mismatch: expected ${expectedContext}, received ${authoritativeContext}.`,
        ErrorCode.UNAUTHORIZED_SENDER,
      );
    }

    // Step 5: Context-to-Action Allowlist Authorization
    const allowedActions = CONTEXT_ALLOWED_ACTIONS[authoritativeContext];
    if (!allowedActions || !allowedActions.has(msgType)) {
      throw new SecurityError(
        `Unauthorized action: '${authoritativeContext}' is not permitted to execute action '${msgType}'.`,
        ErrorCode.UNAUTHORIZED_SENDER,
      );
    }

    // Step 6: Nonce Registration (valid until timestamp + max age)
    this.seenNonces.set(msg.id, msg.timestamp + MAX_MESSAGE_AGE_MS);

    // Step 7: Assign Authoritative Trust Boundary
    const trustBoundary =
      authoritativeContext === "content-script"
        ? TrustBoundary.SEMI_TRUSTED
        : TrustBoundary.TRUSTED;

    return {
      id: msg.id,
      type: msgType,
      payload: msg.payload as T,
      timestamp: msg.timestamp,
      senderContext: authoritativeContext,
      trustBoundary,
    };
  }

  /**
   * Resets replay cache (primarily for isolated test fixtures).
   */
  resetCache(): void {
    this.seenNonces.clear();
  }
}

export const defaultMessageValidator = new MessageEnvelopeValidator();
