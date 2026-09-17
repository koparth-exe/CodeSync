/**
 * Platform Adapter Input & Origin Validators (Phase 1C.3)
 *
 * Enforces strict defense-in-depth boundary validation on candidate submissions:
 * - Structural origin validation (zero loose substring matching, reject lookalikes)
 * - Safe URL schema & length validation (HTTPS only, reject javascript/data/blob)
 * - Source code bounds and control byte safety checks
 * - Canonical submission candidate schema verification
 */

import {
  type CanonicalSubmissionCandidate,
  type CanonicalSubmissionStatus,
  type ExtractionLayer,
  type PlatformId,
  type SourceProvenance,
  SOURCE_PROVENANCE_VALUES,
  SUPPORTED_PLATFORMS,
} from "./types";
import { ErrorCode, PlatformAdapterError, SecurityError } from "../errors";
import { MAX_SOURCE_PAYLOAD_BYTES } from "../github/types";

// Maximum allowable limits for defensive validation
export const MAX_PROBLEM_TITLE_CHARS = 500;
export const MAX_PROBLEM_ID_CHARS = 200;
export const MAX_PROBLEM_SLUG_CHARS = 200;
export const MAX_LANGUAGE_CHARS = 100;
export const MAX_URL_CHARS = 2000;
export const MAX_METADATA_CHARS = 100;

// Safe slug grammar for template and path injection safety: alphanumeric, hyphens, underscores, dots
export const SAFE_SLUG_REGEX = /^[a-zA-Z0-9_.-]+$/;

// Forbidden control characters (allow \t (0x09), \n (0x0A), \r (0x0D))
export const FORBIDDEN_CONTROL_BYTES_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

const VALID_STATUSES: readonly CanonicalSubmissionStatus[] = [
  "ACCEPTED",
  "REJECTED",
  "PENDING",
  "UNKNOWN",
] as const;

const VALID_EXTRACTION_LAYERS: readonly ExtractionLayer[] = [
  "api",
  "page_context",
  "dom",
  "hybrid",
] as const;

/**
 * Normalizes host from origin or URL string.
 */
function extractHostname(candidate: string): string {
  try {
    if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
      return new URL(candidate).hostname.toLowerCase();
    }
    // Hostname without scheme
    const url = new URL(`https://${candidate}`);
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Validates that a URL's origin matches one of the explicitly allowed platform origins.
 *
 * Strict security rules:
 * - Protocol MUST be https (fail-closed on http, javascript:, data:, etc.)
 * - Hostname MUST exactly match an allowed host or explicitly authorized subdomain.
 * - Rejects loose substring matches (e.g. leetcode.com.evil.test, evil-leetcode.com).
 * - Rejects port injection, userinfo injection, and lookalike confusion.
 */
export function validatePlatformOrigin(
  url: URL | string,
  allowedOriginsOrHosts: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }

  // Strictly HTTPS
  if (parsed.protocol !== "https:") {
    return false;
  }

  // Reject credentials in URL (e.g. https://leetcode.com@evil.com)
  if (parsed.username || parsed.password) {
    return false;
  }

  // Reject non-standard ports
  if (parsed.port && parsed.port !== "443") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return false;
  }

  for (const allowed of allowedOriginsOrHosts) {
    const allowedHost = extractHostname(allowed);
    if (!allowedHost) continue;

    // Exact hostname match
    if (hostname === allowedHost) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a web URL string for safety and acceptable scheme.
 */
export function validateSafeUrl(rawUrl: unknown, fieldName: string): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new PlatformAdapterError(
      `${fieldName} must be a non-empty string.`,
      ErrorCode.METADATA_INVALID,
    );
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_CHARS) {
    throw new PlatformAdapterError(
      `${fieldName} exceeds maximum length of ${MAX_URL_CHARS} characters.`,
      ErrorCode.METADATA_INVALID,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PlatformAdapterError(
      `${fieldName} is not a valid URL.`,
      ErrorCode.METADATA_INVALID,
    );
  }

  // Strictly reject dangerous schemes
  const lowerProtocol = parsed.protocol.toLowerCase();
  if (
    lowerProtocol === "javascript:" ||
    lowerProtocol === "data:" ||
    lowerProtocol === "blob:" ||
    lowerProtocol === "vbscript:" ||
    lowerProtocol === "file:"
  ) {
    throw new SecurityError(
      `Dangerous URL scheme rejected: ${lowerProtocol}`,
      ErrorCode.SECURITY_VIOLATION,
    );
  }

  if (lowerProtocol !== "https:") {
    throw new PlatformAdapterError(
      `${fieldName} must use HTTPS scheme.`,
      ErrorCode.METADATA_INVALID,
    );
  }

  return parsed.toString();
}

/**
 * Validates source code candidate against payload limits and character hygiene.
 */
export function validateSourceCode(raw: unknown): {
  valid: boolean;
  error?: string;
} {
  if (typeof raw !== "string") {
    return { valid: false, error: "Source code must be a string." };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: "Source code cannot be empty." };
  }

  const byteLength = new TextEncoder().encode(raw).length;
  if (byteLength > MAX_SOURCE_PAYLOAD_BYTES) {
    return {
      valid: false,
      error: `Source code exceeds ${MAX_SOURCE_PAYLOAD_BYTES} bytes limit (${byteLength} bytes).`,
    };
  }

  if (FORBIDDEN_CONTROL_BYTES_REGEX.test(raw)) {
    return {
      valid: false,
      error: "Source code contains forbidden binary or control characters.",
    };
  }

  return { valid: true };
}

/**
 * Sanitizes a string into a safe path slug:
 * Converts spaces and special characters to hyphens, collapses duplicates, trims.
 */
export function sanitizeSlug(raw: string): string {
  if (!raw) return "unknown-problem";
  const normalized = raw
    .trim()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown-problem";
}

/**
 * Authoritatively validates a CanonicalSubmissionCandidate against schema and security limits.
 * Throws PlatformAdapterError or SecurityError on invalid candidate.
 */
export function validateCanonicalSubmission(
  raw: unknown,
  expectedPlatform?: PlatformId,
): CanonicalSubmissionCandidate {
  if (!raw || typeof raw !== "object") {
    throw new PlatformAdapterError(
      "Submission candidate must be a non-null object.",
      ErrorCode.METADATA_INVALID,
    );
  }

  const cand = raw as Record<string, unknown>;

  // 1. Platform validation
  if (
    typeof cand.platform !== "string" ||
    !SUPPORTED_PLATFORMS.includes(cand.platform as PlatformId)
  ) {
    throw new PlatformAdapterError(
      `Unsupported platform identity: ${String(cand.platform)}`,
      ErrorCode.ADAPTER_NOT_APPLICABLE,
    );
  }
  const platform = cand.platform as PlatformId;

  if (expectedPlatform && platform !== expectedPlatform) {
    throw new PlatformAdapterError(
      `Mismatched platform: expected '${expectedPlatform}', got '${platform}'.`,
      ErrorCode.ADAPTER_NOT_APPLICABLE,
    );
  }

  // 2. Problem ID validation
  if (typeof cand.problemId !== "string" || !cand.problemId.trim()) {
    throw new PlatformAdapterError(
      "problemId is required and must be a non-empty string.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const problemId = cand.problemId.trim();
  if (problemId.length > MAX_PROBLEM_ID_CHARS) {
    throw new PlatformAdapterError(
      `problemId exceeds ${MAX_PROBLEM_ID_CHARS} characters.`,
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }

  // 3. Problem Slug validation
  if (typeof cand.problemSlug !== "string" || !cand.problemSlug.trim()) {
    throw new PlatformAdapterError(
      "problemSlug is required and must be a non-empty string.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const problemSlug = cand.problemSlug.trim();
  if (
    problemSlug.length > MAX_PROBLEM_SLUG_CHARS ||
    !SAFE_SLUG_REGEX.test(problemSlug)
  ) {
    throw new PlatformAdapterError(
      `problemSlug must match safe slug grammar and be <= ${MAX_PROBLEM_SLUG_CHARS} chars: "${problemSlug}"`,
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }

  // 4. Problem Title validation
  if (typeof cand.problemTitle !== "string" || !cand.problemTitle.trim()) {
    throw new PlatformAdapterError(
      "problemTitle is required and must be a non-empty string.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const problemTitle = cand.problemTitle.trim();
  if (problemTitle.length > MAX_PROBLEM_TITLE_CHARS) {
    throw new PlatformAdapterError(
      `problemTitle exceeds ${MAX_PROBLEM_TITLE_CHARS} characters.`,
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }

  // 5. Status validation
  if (
    typeof cand.status !== "string" ||
    !VALID_STATUSES.includes(cand.status as CanonicalSubmissionStatus)
  ) {
    throw new PlatformAdapterError(
      `Invalid submission status: ${String(cand.status)}`,
      ErrorCode.STATUS_UNKNOWN,
      platform,
    );
  }
  const status = cand.status as CanonicalSubmissionStatus;

  // 6. Language validation
  if (typeof cand.language !== "string" || !cand.language.trim()) {
    throw new PlatformAdapterError(
      "language is required and must be a non-empty string.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const language = cand.language.trim().toLowerCase();
  if (language.length > MAX_LANGUAGE_CHARS) {
    throw new PlatformAdapterError(
      `language exceeds ${MAX_LANGUAGE_CHARS} characters.`,
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }

  // 7. Source code validation
  const sourceValidation = validateSourceCode(cand.sourceCode);
  if (!sourceValidation.valid) {
    throw new PlatformAdapterError(
      sourceValidation.error ?? "Invalid source code.",
      ErrorCode.SOURCE_INVALID,
      platform,
    );
  }
  const sourceCode = cand.sourceCode as string;

  // 7b. Source provenance validation (Phase 1C.3 C3.2)
  if (
    typeof cand.sourceProvenance !== "string" ||
    !SOURCE_PROVENANCE_VALUES.includes(
      cand.sourceProvenance as SourceProvenance,
    )
  ) {
    throw new PlatformAdapterError(
      `Invalid or missing sourceProvenance: "${String(cand.sourceProvenance)}".`,
      ErrorCode.SOURCE_INVALID,
      platform,
    );
  }
  const sourceProvenance = cand.sourceProvenance as SourceProvenance;

  // 8. Content hash validation (64-character lowercase hex)
  if (
    typeof cand.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(cand.contentHash)
  ) {
    throw new PlatformAdapterError(
      "contentHash must be a valid 64-character lowercase hex SHA-256 string.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const contentHash = cand.contentHash;

  // 9. Timestamps
  if (
    typeof cand.submittedAt !== "number" ||
    !Number.isFinite(cand.submittedAt) ||
    cand.submittedAt <= 0
  ) {
    throw new PlatformAdapterError(
      "submittedAt must be a positive finite numeric timestamp.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const submittedAt = cand.submittedAt;

  // 10. URLs
  const sourceUrl = validateSafeUrl(cand.sourceUrl, "sourceUrl");
  const problemUrl = validateSafeUrl(cand.problemUrl, "problemUrl");

  // 11. Optional fields
  let submissionId: string | undefined;
  if (cand.submissionId !== undefined && cand.submissionId !== null) {
    if (typeof cand.submissionId !== "string" || !cand.submissionId.trim()) {
      throw new PlatformAdapterError(
        "submissionId if provided must be a non-empty string.",
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
    submissionId = cand.submissionId.trim();
    if (submissionId.length > MAX_METADATA_CHARS) {
      throw new PlatformAdapterError(
        `submissionId exceeds ${MAX_METADATA_CHARS} characters.`,
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
  }

  let difficulty: string | undefined;
  if (cand.difficulty !== undefined && cand.difficulty !== null) {
    if (typeof cand.difficulty !== "string" || !cand.difficulty.trim()) {
      throw new PlatformAdapterError(
        "difficulty if provided must be a non-empty string.",
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
    difficulty = cand.difficulty.trim();
    if (difficulty.length > MAX_METADATA_CHARS) {
      throw new PlatformAdapterError(
        `difficulty exceeds ${MAX_METADATA_CHARS} characters.`,
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
  }

  let rating: string | undefined;
  if (cand.rating !== undefined && cand.rating !== null) {
    if (typeof cand.rating !== "string" || !cand.rating.trim()) {
      throw new PlatformAdapterError(
        "rating if provided must be a non-empty string.",
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
    rating = cand.rating.trim();
    if (rating.length > MAX_METADATA_CHARS) {
      throw new PlatformAdapterError(
        `rating exceeds ${MAX_METADATA_CHARS} characters.`,
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
  }

  let contestId: string | undefined;
  if (cand.contestId !== undefined && cand.contestId !== null) {
    if (typeof cand.contestId !== "string" || !cand.contestId.trim()) {
      throw new PlatformAdapterError(
        "contestId if provided must be a non-empty string.",
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
    contestId = cand.contestId.trim();
    if (contestId.length > MAX_METADATA_CHARS) {
      throw new PlatformAdapterError(
        `contestId exceeds ${MAX_METADATA_CHARS} characters.`,
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
  }

  let platformMetadata: Record<string, unknown> | undefined;
  if (cand.platformMetadata !== undefined && cand.platformMetadata !== null) {
    if (typeof cand.platformMetadata !== "object") {
      throw new PlatformAdapterError(
        "platformMetadata if provided must be an object.",
        ErrorCode.METADATA_INVALID,
        platform,
      );
    }
    platformMetadata = cand.platformMetadata as Record<string, unknown>;
  }

  // 12. Diagnostics & Confidence
  if (
    typeof cand.extractionConfidence !== "number" ||
    !Number.isFinite(cand.extractionConfidence) ||
    cand.extractionConfidence < 0.0 ||
    cand.extractionConfidence > 1.0
  ) {
    throw new PlatformAdapterError(
      "extractionConfidence must be a number between 0.0 and 1.0.",
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const extractionConfidence = cand.extractionConfidence;

  if (
    typeof cand.extractionLayer !== "string" ||
    !VALID_EXTRACTION_LAYERS.includes(cand.extractionLayer as ExtractionLayer)
  ) {
    throw new PlatformAdapterError(
      `Invalid extractionLayer: ${String(cand.extractionLayer)}`,
      ErrorCode.METADATA_INVALID,
      platform,
    );
  }
  const extractionLayer = cand.extractionLayer as ExtractionLayer;

  const diagnostics =
    cand.diagnostics && typeof cand.diagnostics === "object"
      ? (cand.diagnostics as Record<string, unknown>)
      : undefined;

  return {
    platform,
    problemId,
    problemSlug,
    problemTitle,
    status,
    language,
    sourceCode,
    contentHash,
    submittedAt,
    sourceUrl,
    problemUrl,
    sourceProvenance,
    submissionId,
    difficulty,
    rating,
    contestId,
    platformMetadata,
    extractionConfidence,
    extractionLayer,
    diagnostics,
  };
}

/**
 * Canonical authority token for extension-controlled authoritative source extraction.
 *
 * Security Invariant (C3.4):
 * This token is known only to extension-internal trusted channels.
 * Webpages, DOM elements, attributes, or page scripts cannot access or forge this token.
 */
export const EXTENSION_AUTHORITY_TOKEN =
  "CODESYNC_EXTENSION_INTERNAL_AUTHORITY_v1";

/**
 * Validates whether an extraction context input represents a genuine
 * extension-controlled authoritative source payload.
 *
 * Fails closed if the input:
 * - is null, undefined, or not an object
 * - is a plain string (prevents `authoritativeSource = "someString"`)
 * - lacks the required 'EXTENSION_INTERNAL' authority marker
 * - lacks or has an incorrect extension authority token
 * - contains an empty code payload
 */
export function validateAuthoritativeSource(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  if (
    candidate.authority === "EXTENSION_INTERNAL" &&
    candidate.token === EXTENSION_AUTHORITY_TOKEN &&
    typeof candidate.code === "string" &&
    candidate.code.trim().length > 0
  ) {
    return candidate.code.trim();
  }
  return null;
}
