/**
 * Platform Adapter Contracts & Canonical Submission Models (Phase 1C.3)
 *
 * Enforces strict decoupling between untrusted platform pages and core CodeSync services.
 * All extracted data represents candidate data and must be verified by the trusted service worker.
 */

export type PlatformId =
  "leetcode" | "codechef" | "codeforces" | "geeksforgeeks";

export const SUPPORTED_PLATFORMS: readonly PlatformId[] = [
  "leetcode",
  "codechef",
  "codeforces",
  "geeksforgeeks",
] as const;

/**
 * Authoritative canonical submission status.
 * Only `ACCEPTED` submissions qualify for automatic synchronization in downstream pipelines.
 */
export type CanonicalSubmissionStatus =
  "ACCEPTED" | "REJECTED" | "PENDING" | "UNKNOWN";

/**
 * Extraction hierarchy layer utilized by the adapter.
 */
export type ExtractionLayer = "api" | "page_context" | "dom" | "hybrid";

export const VALID_EXTRACTION_LAYERS: readonly ExtractionLayer[] = [
  "api",
  "page_context",
  "dom",
  "hybrid",
] as const;

/**
 * Provenance category of the extracted source code (Phase 1C.3 C3.2).
 * Strictly distinguishes authoritative submitted source from mutable editor contents.
 */
export type SourceProvenance =
  | "AUTHORITATIVE_SUBMISSION_SOURCE"
  | "SUBMISSION_PAGE_SOURCE"
  | "EDITOR_SOURCE"
  | "DOM_FALLBACK_SOURCE";

export const SOURCE_PROVENANCE_VALUES: readonly SourceProvenance[] = [
  "AUTHORITATIVE_SUBMISSION_SOURCE",
  "SUBMISSION_PAGE_SOURCE",
  "EDITOR_SOURCE",
  "DOM_FALLBACK_SOURCE",
] as const;

/**
 * Platform-independent canonical representation of a detected submission candidate.
 */
export interface CanonicalSubmissionCandidate {
  // Required core fields
  readonly platform: PlatformId;
  readonly problemId: string;
  readonly problemSlug: string;
  readonly problemTitle: string;
  readonly status: CanonicalSubmissionStatus;
  readonly language: string;
  readonly sourceCode: string;
  readonly contentHash: string; // 64-char lowercase hex SHA-256
  readonly submittedAt: number;
  readonly sourceUrl: string;
  readonly problemUrl: string;
  readonly sourceProvenance: SourceProvenance; // C3.2: Provenance tracking

  // Optional metadata
  readonly submissionId?: string | undefined;
  readonly difficulty?: string | undefined;
  readonly rating?: string | undefined;
  readonly contestId?: string | undefined;
  readonly platformMetadata?: Record<string, unknown> | undefined;

  // Diagnostic metadata (diagnostic only, NEVER establishes trust or write authority)
  readonly extractionConfidence: number; // 0.0 to 1.0
  readonly extractionLayer: ExtractionLayer;
  readonly diagnostics?: Record<string, unknown> | undefined;
}

/**
 * Detection event types recognized by platform detectors.
 */
export type DetectionEventType =
  "submit_click" | "result_mutation" | "spa_navigation" | "dom_poll";

/**
 * Signal returned when a submission event is detected on the page.
 */
export interface DetectionResult {
  readonly detected: boolean;
  readonly eventType: DetectionEventType;
  readonly problemId?: string | undefined;
  readonly submissionId?: string | undefined;
  readonly status?: CanonicalSubmissionStatus | undefined;
  readonly timestamp: number;
}

/**
 * Context provided to detector functions.
 */
export interface DetectorContext {
  readonly document?: Document | undefined;
  readonly window?: Window | undefined;
  readonly location: Location | URL;
  readonly event?: Event | undefined;
}

/**
 * Approved extension-controlled authoritative source payload.
 *
 * Security Invariant (C3.4):
 * Webpage DOM elements, attributes, page scripts, or bare strings CANNOT
 * assert authoritative provenance.
 * Only valid AuthoritativeSourcePayload instances verified by the extension
 * can produce AUTHORITATIVE_SUBMISSION_SOURCE.
 */
export interface AuthoritativeSourcePayload {
  readonly code: string;
  readonly authority: "EXTENSION_INTERNAL";
  readonly token: string;
}

/**
 * Context provided to extraction functions.
 */
export interface ExtractionContext {
  readonly document?: Document | undefined;
  readonly window?: Window | undefined;
  readonly location: Location | URL;
  readonly detection?: DetectionResult | undefined;
  /**
   * Verified authoritative submission source provided strictly by an
   * approved extension-controlled channel.
   *
   * Webpage DOM elements, attributes, page scripts, or bare strings CANNOT
   * assert authoritative provenance.
   */
  readonly authoritativeSource?: AuthoritativeSourcePayload | undefined;
}

/**
 * Strongly typed interface that all platform adapters must implement.
 */
export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly name: string;
  readonly supportedOrigins: readonly string[];

  /**
   * Evaluates whether the adapter is eligible to handle the given URL.
   * Must use strict host/origin validation (no loose substring matching).
   */
  canHandle(url: URL | string): boolean;

  /**
   * Evaluates the page context to recognize submission events.
   */
  detectSubmission(context: DetectorContext): Promise<DetectionResult | null>;

  /**
   * Extracts the canonical submission candidate from the page.
   */
  extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null>;
}
