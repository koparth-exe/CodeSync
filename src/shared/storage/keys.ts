/**
 * Centralized storage keys for browser.storage.local.
 * Prevents key collision and enables predictable isolation and auditing.
 */

export const STORAGE_KEYS = {
  /** Lightweight queue item metadata list and index */
  QUEUE_METADATA: "codesync:queue:metadata",

  /** Persistent queue worker lease record */
  QUEUE_LEASE: "codesync:queue:lease",

  /** User extension configuration and preferences */
  CONFIG: "codesync:config",

  /** GitHub authentication credentials and installation state */
  AUTH: "codesync:auth",

  /** Quarantined corrupted storage records */
  CORRUPTED: "codesync:corrupted",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
