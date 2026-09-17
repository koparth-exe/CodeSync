import {
  QueueState,
  type QueueItemMetadata,
  type QueueItemPayload,
  type TargetSnapshot,
} from "../storage/types";
import type { SourceProvenance } from "../adapters/types";

export { QueueState };
export type { QueueItemMetadata, QueueItemPayload, TargetSnapshot };

export interface NormalizedSubmission {
  readonly id: string;
  readonly platform: string;
  readonly submissionId?: string | undefined;
  readonly submissionUrl: string;
  readonly targetRepository: string;
  readonly targetBranch: string;
  readonly problemTitle: string;
  readonly problemSlug: string;
  readonly problemId: string;
  readonly status: string;
  readonly language: string;
  readonly sourceCode: string;
  readonly contentHash?: string | undefined;
  readonly extractionConfidence?: number | undefined;
  readonly submittedAt: number;
  readonly detectedAt: number;
  readonly platformMetadata?: Record<string, unknown> | undefined;
  readonly targetSnapshot?: TargetSnapshot | undefined;
  readonly sourceProvenance?: SourceProvenance | undefined;
  readonly validatedBy?: "SERVICE_WORKER" | undefined;
}

export interface SyncResult {
  readonly status: "completed" | "skipped" | "failed" | "requires_attention";
  readonly commitSha?: string | undefined;
  readonly commitUrl?: string | undefined;
  readonly error?:
    | {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
        readonly resetTimestamp?: number | undefined;
        readonly retryAfterSeconds?: number | undefined;
      }
    | undefined;
}

export interface DrainSummary {
  processed: number;
  completed: number;
  failed: number;
  skipped: number;
  quarantined: number;
}

export interface ReconciliationResult {
  readonly reconciledCount: number;
  readonly quarantinedCount: number;
}
