/**
 * Base Platform Adapter Abstract Class (Phase 1C.3)
 *
 * Implements common normalization, origin validation, content hashing,
 * and candidate validation across all platform adapters.
 */

import {
  type CanonicalSubmissionCandidate,
  type DetectionResult,
  type DetectorContext,
  type ExtractionContext,
  type PlatformAdapter,
  type PlatformId,
} from "./types";
import {
  validateCanonicalSubmission,
  validatePlatformOrigin,
} from "./validator";
import { computeContentHash, normalizeSourceCode } from "../deduplication";

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly id: PlatformId;
  abstract readonly name: string;
  abstract readonly supportedOrigins: readonly string[];

  /**
   * Validates if this adapter can handle the specified URL based on allowed origins.
   * Strictly rejects lookalike or unauthorized domains fail-closed.
   */
  canHandle(url: URL | string): boolean {
    return validatePlatformOrigin(url, this.supportedOrigins);
  }

  /**
   * Normalizes source code using the canonical deduplication rules
   * (NFKC, POSIX LF, per-line trailing space removal, single trailing EOF newline).
   */
  protected normalizeSource(source: string): string {
    return normalizeSourceCode(source);
  }

  /**
   * Computes the authoritative SHA-256 hash of the normalized source code.
   */
  protected async computeHash(source: string): Promise<string> {
    return computeContentHash(source);
  }

  /**
   * Validates an extracted candidate against canonical schema and bounds.
   */
  protected validateCandidate(
    candidate: CanonicalSubmissionCandidate,
  ): CanonicalSubmissionCandidate {
    return validateCanonicalSubmission(candidate, this.id);
  }

  /**
   * Abstract submission detection to be implemented per platform.
   */
  abstract detectSubmission(
    context: DetectorContext,
  ): Promise<DetectionResult | null>;

  /**
   * Abstract submission extraction to be implemented per platform.
   */
  abstract extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null>;
}
