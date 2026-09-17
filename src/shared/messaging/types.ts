import { TrustBoundary } from "../types/trust";
import type { SenderContext } from "../types/envelope";

export { TrustBoundary };
export type { SenderContext };

export const EXTENSION_MESSAGE_TYPES = [
  // Content Script -> Background
  "SUBMISSION_DETECTED",
  "EXTRACTION_COMPLETED",
  "EXTRACTION_FAILED",

  // Background -> Content Script
  "REQUEST_RECOVERY_SELECTION",

  // UI -> Background
  "GET_STATUS",
  "GET_QUEUE_METADATA",
  "GET_HISTORY",
  "RETRY_QUEUE_ITEM",
  "CANCEL_QUEUE_ITEM",
  "PURGE_COMPLETED",
  "UPDATE_CONFIG",
  "INITIATE_GITHUB_AUTH",
  "POLL_GITHUB_AUTH",
  "CANCEL_GITHUB_AUTH",
  "GET_AUTH_STATUS",
  "DISCONNECT_GITHUB",

  // Background -> UI
  "STATUS_CHANGED",
  "QUEUE_UPDATED",
  "AUTH_STATE_CHANGED",
] as const;

export type ExtensionMessageType = (typeof EXTENSION_MESSAGE_TYPES)[number];

/**
 * Strict Least-Privilege Allowlists per Sender Context.
 * Message contents or blacklists ALONE never establish authority.
 */
export const CONTEXT_ALLOWED_ACTIONS: Record<
  SenderContext,
  ReadonlySet<ExtensionMessageType>
> = {
  "content-script": new Set([
    "SUBMISSION_DETECTED",
    "EXTRACTION_COMPLETED",
    "EXTRACTION_FAILED",
  ]),
  popup: new Set([
    "GET_STATUS",
    "GET_QUEUE_METADATA",
    "GET_HISTORY",
    "RETRY_QUEUE_ITEM",
    "CANCEL_QUEUE_ITEM",
    "PURGE_COMPLETED",
    "UPDATE_CONFIG",
    "INITIATE_GITHUB_AUTH",
    "POLL_GITHUB_AUTH",
    "CANCEL_GITHUB_AUTH",
    "GET_AUTH_STATUS",
    "DISCONNECT_GITHUB",
  ]),
  options: new Set([
    "GET_STATUS",
    "GET_QUEUE_METADATA",
    "GET_HISTORY",
    "UPDATE_CONFIG",
    "RETRY_QUEUE_ITEM",
    "INITIATE_GITHUB_AUTH",
    "POLL_GITHUB_AUTH",
    "CANCEL_GITHUB_AUTH",
    "GET_AUTH_STATUS",
    "DISCONNECT_GITHUB",
  ]),
  background: new Set([
    "SUBMISSION_DETECTED",
    "EXTRACTION_COMPLETED",
    "EXTRACTION_FAILED",
    "REQUEST_RECOVERY_SELECTION",
    "GET_STATUS",
    "GET_QUEUE_METADATA",
    "GET_HISTORY",
    "RETRY_QUEUE_ITEM",
    "CANCEL_QUEUE_ITEM",
    "PURGE_COMPLETED",
    "UPDATE_CONFIG",
    "STATUS_CHANGED",
    "QUEUE_UPDATED",
    "AUTH_STATE_CHANGED",
    "INITIATE_GITHUB_AUTH",
    "POLL_GITHUB_AUTH",
    "CANCEL_GITHUB_AUTH",
    "GET_AUTH_STATUS",
    "DISCONNECT_GITHUB",
  ]),
};

/**
 * Browser runtime MessageSender representation for verified origin analysis.
 */
export interface RuntimeSenderInfo {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?:
    | {
        readonly id?: number | undefined;
        readonly url?: string | undefined;
      }
    | undefined;
  readonly origin?: string | undefined;
}

export interface ExtensionMessage<T = unknown> {
  readonly id: string;
  readonly type: ExtensionMessageType;
  readonly payload: T;
  readonly timestamp: number;
  readonly senderContext: SenderContext;
  readonly trustBoundary: TrustBoundary;
}
