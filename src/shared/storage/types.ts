import type { NormalizedSubmission } from "../queue/types";
import type { DuplicatePolicy } from "../config/schema";
import type { GitHubDuplicatePolicy } from "../github/types";
import type { SourceProvenance } from "../adapters/types";

/**
 * Hybrid Storage & Queue Data Contracts
 * Defines models for browser.storage.local (metadata) and IndexedDB (payloads/history/wal_logs).
 */

export enum QueueState {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  REQUIRES_ATTENTION = "requires_attention",
  SKIPPED = "skipped",
}

/**
 * Immutable execution-relevant target snapshot captured at enqueue time.
 * The queue item MUST NOT dynamically reference mutable current settings for execution.
 */
export interface TargetSnapshot {
  readonly targetRepository: string;
  readonly targetBranch: string;
  readonly basePath: string;
  readonly duplicatePolicy: GitHubDuplicatePolicy | DuplicatePolicy;
  readonly pathTemplate?: string | undefined;
  /**
   * Explicit target authorization state (Phase 1C.4.1 Correction).
   * Distinguishes local syntactically validated configuration from
   * remote GitHub-verified authorization (which must be verified during drain/Phase 1C.4.2).
   */
  readonly authorizationStatus?:
    "CONFIGURED_UNVERIFIED" | "AUTHORIZED" | undefined;
}

/**
 * Lightweight queue item stored in browser.storage.local.
 * Excludes heavy source code payloads to protect 10MB quota and optimize MV3 deserialization.
 */
export interface QueueItemMetadata {
  readonly id: string;
  readonly payloadId: string;
  readonly platform: string;
  readonly problemSlug: string;
  readonly problemTitle: string;
  readonly targetRepository: string;
  readonly targetBranch: string;
  readonly language: string;
  readonly status: string;
  readonly contentHash: string;

  // Immutability & Provenance (Phase 1C.4.1)
  readonly targetSnapshot?: TargetSnapshot | undefined;
  readonly submissionId?: string | undefined;
  readonly sourceProvenance?: SourceProvenance | undefined;
  readonly validatedBy?: "SERVICE_WORKER" | undefined;

  // State Management
  state: QueueState;
  attempts: number;
  crashCount: number;
  fencingToken?: number | undefined;
  lastError?:
    | {
        readonly code: string;
        readonly message: string;
        readonly timestamp: number;
      }
    | undefined;
  nextRetryAt?: number | undefined;

  // Results
  commitSha?: string | undefined;
  commitUrl?: string | undefined;

  // Timestamps
  readonly createdAt: number;
  updatedAt: number;
  completedAt?: number | undefined;
}

/**
 * Heavy source code payload stored strictly in IndexedDB (codesync_db: payloads).
 */
export interface QueueItemPayload {
  /** References "payload:<uuid>" */
  readonly id: string;
  readonly sourceCode: string;
  readonly platformMetadata?: Record<string, unknown> | undefined;
  readonly createdAt: number;
}

/**
 * Persistent lease record stored in browser.storage.local for durable cross-worker coordination.
 * Includes monotonic fencingToken to prevent stale workers from mutating queue state.
 */
export interface QueueLeaseRecord {
  readonly workerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  expiresAt: number;
  readonly maxLifetimeExpiresAt: number;
  readonly triggerSource:
    "alarm" | "submission_event" | "manual_retry" | "startup";
}

/**
 * Historical record of completed/skipped synchronizations stored in IndexedDB.
 */
export interface SyncHistoryEntry {
  readonly id: string;
  readonly submissionId: string;
  readonly platform: string;
  readonly problemTitle: string;
  readonly problemSlug: string;
  readonly targetRepository: string;
  readonly targetBranch: string;
  readonly language: string;
  readonly contentHash: string;
  readonly commitSha?: string | undefined;
  readonly commitUrl?: string | undefined;
  readonly completedAt: number;
  readonly status: "synced" | "skipped";
}

/**
 * Quarantined corrupted storage record.
 */
export interface CorruptedStorageRecord {
  readonly id: string;
  readonly originalKey: string;
  readonly isolatedAt: number;
  readonly reason: string;
  readonly rawContent: unknown;
}

/**
 * Write-Ahead Log (WAL) Lifecycle Phases.
 */
export enum WalPhase {
  INTENT = "intent",
  MUTATING = "mutating",
  COMMITTED = "committed",
  ROLLED_BACK = "rolled_back",
}

export type WalOperationType =
  "ENQUEUE_SUBMISSION" | "PURGE_QUEUE" | "STATE_TRANSITION";

/**
 * Persistent Write-Ahead Log (WAL) record stored in IndexedDB (codesync_db: wal_logs).
 * Represents operation intent BEFORE mutations to guarantee deterministic recovery.
 */
export interface WalEntry {
  readonly id: string;
  readonly operationType: WalOperationType;
  readonly entityId: string;
  readonly payloadId: string;
  readonly intendedState: QueueState;
  phase: WalPhase;
  readonly createdAt: number;
  updatedAt: number;
  readonly fencingToken?: number | undefined;
  readonly workerId?: string | undefined;
  readonly snapshot?:
    | {
        readonly submission?: NormalizedSubmission | undefined;
        readonly previousState?: QueueState | undefined;
      }
    | undefined;
}
