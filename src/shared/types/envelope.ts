import { TrustBoundary } from "./trust";

/**
 * Valid sender contexts for messages inside the extension.
 */
export type SenderContext =
  "content-script" | "popup" | "options" | "background";

/**
 * Standard typed envelope for cross-context extension communication.
 * Enforces anti-replay verification (id + timestamp) and sender origin tagging.
 *
 * In Phase 1A, this contract is introduced as an inert foundation for future
 * message bus validation.
 */
export interface ExtensionEnvelope<T = unknown> {
  /** UUID v4 message identifier (unique nonce for replay prevention) */
  readonly id: string;

  /** Strongly-typed message action identifier */
  readonly type: string;

  /** Payload data */
  readonly payload: T;

  /** Epoch timestamp in milliseconds (validated within sliding window) */
  readonly timestamp: number;

  /** Declared execution context of the sender */
  readonly senderContext: SenderContext;

  /** Declared trust level of the message payload */
  readonly trustBoundary: TrustBoundary;
}
