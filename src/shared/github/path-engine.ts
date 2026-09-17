/* eslint-disable no-control-regex */
import { ErrorCode, PathSecurityError, PathTemplateError } from "../errors";
import type { PathTemplateVariables } from "./types";

/**
 * Strict Safe Segment Grammar (POSIX portable ASCII character set):
 * Alphanumeric, underscores, dashes, and periods.
 *
 * **Intentional Design Decision (Phase 1C.2.1 C6):**
 * Non-ASCII characters (including Unicode, Cyrillic homoglyphs, CJK, accented
 * characters, bidirectional overrides, and zero-width codepoints) are REJECTED
 * outright. This is NOT an oversight — it is a deliberate conservative security
 * posture. Enumerating all dangerous Unicode codepoints is computationally infeasible
 * and fragile against future Unicode versions. The ASCII whitelist provides a
 * provably safe, stable, and cross-platform boundary that eliminates entire classes
 * of homoglyph, normalization, and rendering attacks.
 *
 * Platforms that produce non-ASCII problem titles (e.g., CJK characters) will have
 * their path segments sanitized by the platform adapter layer (Phase 1C.3+) before
 * reaching this engine. The path engine itself never relaxes this boundary.
 */
const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * DOS reserved device names (case-insensitive, with or without any extension).
 * e.g., CON, PRN, AUX, NUL, COM1-9, LPT1-9, NUL.txt, com1.cpp
 */
const DOS_DEVICE_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * Git internal / protected directory names.
 */
const GIT_PROTECTED_REGEX = /^\.(?:git|github)(?:\/|$)/i;

/**
 * Structural path limits per Phase 1C.2 and docs/PATH-TEMPLATE-SPEC.md.
 */
export const MAX_DECODE_CYCLES = 3;
export const MAX_SEGMENT_LENGTH = 100;
export const MAX_TOTAL_PATH_LENGTH = 255;
export const MAX_PATH_DEPTH = 10;
export const MAX_COMMIT_MESSAGE_LENGTH = 200;

/**
 * Allowlisted template variable names.
 */
const ALLOWLISTED_TEMPLATE_VARIABLES = new Set([
  "platform",
  "platform_lower",
  "slug",
  "title",
  "problem_id",
  "language",
  "language_lower",
  "extension",
  "difficulty",
  "rating",
  "contest_id",
  "problem_code",
  "division",
  "status",
  "date",
  "timestamp",
]);

/**
 * Resolves a path template by substituting allowlisted variables.
 *
 * Invariants:
 * - Deterministic, non-executable evaluation (no eval, no Function, no arbitrary properties).
 * - Unknown variables: REJECT fail-closed.
 * - Malformed syntax (unclosed braces, nested braces, empty braces): REJECT fail-closed.
 * - Missing required variable values: REJECT fail-closed.
 * - Variable values must conform to safe segment characters: REJECT if hostile.
 */
export function resolvePathTemplate(
  template: string,
  variables: PathTemplateVariables,
): string {
  if (!template || typeof template !== "string") {
    throw new PathTemplateError(
      "Path template must be a non-empty string.",
      ErrorCode.TEMPLATE_MALFORMED,
      String(template),
    );
  }

  // Canonicalize template with NFKC before parsing
  const normalizedTemplate = template.normalize("NFKC");

  // Check for malformed braces (nested, unclosed, or misplaced)
  let openCount = 0;
  for (let i = 0; i < normalizedTemplate.length; i++) {
    const char = normalizedTemplate[i];
    if (char === "{") {
      openCount++;
      if (openCount > 1) {
        throw new PathTemplateError(
          `Malformed template: nested '{' detected at index ${i}.`,
          ErrorCode.TEMPLATE_MALFORMED,
          template,
        );
      }
    } else if (char === "}") {
      openCount--;
      if (openCount < 0) {
        throw new PathTemplateError(
          `Malformed template: unmatched '}' detected at index ${i}.`,
          ErrorCode.TEMPLATE_MALFORMED,
          template,
        );
      }
    }
  }

  if (openCount !== 0) {
    throw new PathTemplateError(
      "Malformed template: unclosed '{' detected.",
      ErrorCode.TEMPLATE_MALFORMED,
      template,
    );
  }

  // Parse and replace all {var} occurrences
  const placeholderRegex = /\{([^}]*)\}/g;
  const resolved = normalizedTemplate.replace(
    placeholderRegex,
    (_, varName) => {
      const trimmedVar = varName.trim();

      if (!trimmedVar) {
        throw new PathTemplateError(
          "Malformed template: empty '{}' variable placeholder.",
          ErrorCode.TEMPLATE_MALFORMED,
          template,
        );
      }

      if (!ALLOWLISTED_TEMPLATE_VARIABLES.has(trimmedVar)) {
        throw new PathTemplateError(
          `Unknown template variable '{${trimmedVar}}'. Only allowlisted variables are permitted.`,
          ErrorCode.TEMPLATE_UNKNOWN_VARIABLE,
          template,
          trimmedVar,
        );
      }

      const value = (
        variables as unknown as Record<string, string | undefined>
      )[trimmedVar];
      if (value === undefined || value === null || value === "") {
        throw new PathTemplateError(
          `Missing required value for template variable '{${trimmedVar}}'.`,
          ErrorCode.TEMPLATE_MISSING_VALUE,
          template,
          trimmedVar,
        );
      }

      const strValue = String(value).trim();
      if (!strValue) {
        throw new PathTemplateError(
          `Empty value for template variable '{${trimmedVar}}'.`,
          ErrorCode.TEMPLATE_MISSING_VALUE,
          template,
          trimmedVar,
        );
      }

      return strValue;
    },
  );

  return resolved;
}

/**
 * Three-Pillar Path Security Engine (8-Step Canonicalization & Validation Pipeline).
 *
 * Pillars:
 * 1. Canonicalization: Reduces input ambiguity (URL decoding, Unicode NFKC, separator normalization).
 * 2. Strict Safe Path Grammar: Enforces conservative POSIX portable ASCII character set and structural limits.
 * 3. Repository Boundary Containment: Enforces containment within configured baseFolder.
 *
 * Invariant:
 * "Canonicalization reduces ambiguity; validation determines acceptability."
 * NEVER strips dangerous characters and continues. Rejects invalid input immediately (FAIL CLOSED).
 *
 * @param rawPath The raw repository path to canonicalize and validate.
 * @param baseFolder Optional user-configured repository base folder (e.g. "solutions").
 * @returns Normalized, repository-relative POSIX path string with forward slashes.
 */
export function validateAndCanonicalizePath(
  rawPath: string,
  baseFolder?: string,
): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new PathSecurityError(
      "Path must be a non-empty string.",
      ErrorCode.PATH_EMPTY_SEGMENT,
      String(rawPath),
    );
  }

  // --------------------------------------------------------------------------
  // STEP 1: Bounded Recursive URL Decoding (Canonicalization)
  // --------------------------------------------------------------------------
  let decoded = rawPath;
  try {
    for (let i = 0; i < MAX_DECODE_CYCLES; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new PathSecurityError(
      `Path contains malformed URL percent-encoding: "${rawPath}".`,
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  // Check if un-decoded percent sequences remain (e.g. double-encoded traversal like %252e%252e)
  if (/%[0-9a-fA-F]{2}/.test(decoded)) {
    throw new PathSecurityError(
      `Path contains lingering or nested percent-encoded sequences: "${rawPath}".`,
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  // --------------------------------------------------------------------------
  // STEP 2: Unicode NFKC Normalization & Byte Inspection (Canonicalization)
  // --------------------------------------------------------------------------
  // Intentional rejection of ALL non-ASCII Unicode characters and homoglyphs.
  // This is a DELIBERATE conservative ASCII-only policy (Phase 1C.2.1 C6):
  // The ASCII whitelist provides a provably safe boundary. Non-ASCII problem
  // titles from platforms are sanitized by platform adapters (Phase 1C.3+)
  // BEFORE they reach the path engine. See SAFE_SEGMENT_REGEX documentation.
  if (/[^\x00-\x7F]/.test(decoded)) {
    throw new PathSecurityError(
      "Path contains forbidden non-ASCII characters or Unicode homoglyphs.",
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  const normalized = decoded.normalize("NFKC");

  // Rejection of null bytes (literal, escaped, or encoded forms)
  if (/[\x00\u0000]/.test(normalized) || normalized.includes("%00")) {
    throw new PathSecurityError(
      "Path contains forbidden null bytes.",
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  // Rejection of control characters (\x01-\x1F, \x7F-\x9F) - FAIL CLOSED, NEVER STRIP
  if (/[\x01-\x1F\x7F-\x9F]/.test(normalized)) {
    throw new PathSecurityError(
      "Path contains forbidden control characters.",
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  // Rejection of whitespace characters (spaces, tabs, newlines)
  if (/[\s]/.test(normalized)) {
    throw new PathSecurityError(
      "Path contains forbidden whitespace characters.",
      ErrorCode.PATH_INVALID_CHARACTER,
      rawPath,
    );
  }

  // --------------------------------------------------------------------------
  // STEP 3: Separator Normalization & Absolute / Drive Path Rejection
  // --------------------------------------------------------------------------
  // Normalize backslashes to forward slashes
  const forwardSlashed = normalized.replace(/\\/g, "/");

  // Reject absolute paths starting with '/'
  if (forwardSlashed.startsWith("/")) {
    throw new PathSecurityError(
      `Invalid path: "${rawPath}". Absolute paths beginning with '/' are prohibited.`,
      ErrorCode.PATH_ABSOLUTE_REJECTED,
      rawPath,
    );
  }

  // Reject Windows drive prefixes (e.g. C:, D:)
  if (/^[a-zA-Z]:/.test(forwardSlashed)) {
    throw new PathSecurityError(
      `Invalid path: "${rawPath}". Windows drive paths are prohibited.`,
      ErrorCode.PATH_ABSOLUTE_REJECTED,
      rawPath,
    );
  }

  // Reject UNC paths (e.g. //server/share or \\server\share)
  if (forwardSlashed.startsWith("//") || normalized.startsWith("\\\\")) {
    throw new PathSecurityError(
      `Invalid path: "${rawPath}". UNC paths are prohibited.`,
      ErrorCode.PATH_ABSOLUTE_REJECTED,
      rawPath,
    );
  }

  // Reject paths ending with a trailing slash (must be a file target)
  if (forwardSlashed.endsWith("/")) {
    throw new PathSecurityError(
      `Invalid path: "${rawPath}". File path cannot terminate with a directory separator.`,
      ErrorCode.PATH_EMPTY_SEGMENT,
      rawPath,
    );
  }

  // --------------------------------------------------------------------------
  // STEP 4: Segment Extraction & Empty Segment Elimination
  // --------------------------------------------------------------------------
  const segments = forwardSlashed.split("/");

  // Check for empty segments (caused by '//')
  if (segments.some((s) => s.length === 0)) {
    throw new PathSecurityError(
      `Invalid path: "${rawPath}". Empty segments and consecutive separators ('//') are prohibited.`,
      ErrorCode.PATH_EMPTY_SEGMENT,
      rawPath,
    );
  }

  // Enforce max path depth (max segment count)
  if (segments.length > MAX_PATH_DEPTH) {
    throw new PathSecurityError(
      `Path exceeds maximum directory depth of ${MAX_PATH_DEPTH} levels.`,
      ErrorCode.PATH_SEGMENT_TOO_LONG,
      rawPath,
    );
  }

  // --------------------------------------------------------------------------
  // STEP 5: Segment Grammar Validation & Traversal Checks
  // --------------------------------------------------------------------------
  for (const segment of segments) {
    // 5A: Independent relative traversal check
    if (segment === "." || segment === "..") {
      throw new PathSecurityError(
        `Path traversal sequence "${segment}" is strictly prohibited.`,
        ErrorCode.PATH_TRAVERSAL_DETECTED,
        rawPath,
      );
    }

    // 5B: Filename policy check: '..' anywhere inside a segment
    if (segment.includes("..")) {
      throw new PathSecurityError(
        `Segment "${segment}" contains forbidden traversal sequence '..'.`,
        ErrorCode.PATH_TRAVERSAL_DETECTED,
        rawPath,
      );
    }

    // 5C: Leading or trailing dots or spaces
    if (segment.startsWith(".") || segment.endsWith(".")) {
      throw new PathSecurityError(
        `Segment "${segment}" cannot start or end with a period.`,
        ErrorCode.PATH_INVALID_CHARACTER,
        rawPath,
      );
    }

    // 5D: Segment length enforcement
    if (segment.length < 1 || segment.length > MAX_SEGMENT_LENGTH) {
      throw new PathSecurityError(
        `Segment "${segment}" length (${segment.length}) violates limit (1-${MAX_SEGMENT_LENGTH} chars).`,
        ErrorCode.PATH_SEGMENT_TOO_LONG,
        rawPath,
      );
    }

    // 5E: DOS reserved device names
    if (DOS_DEVICE_REGEX.test(segment)) {
      throw new PathSecurityError(
        `Segment "${segment}" collides with reserved DOS device name.`,
        ErrorCode.PATH_RESERVED_NAME,
        rawPath,
      );
    }

    // 5F: Git internal directory protection
    if (GIT_PROTECTED_REGEX.test(segment)) {
      throw new PathSecurityError(
        `Segment "${segment}" targets reserved Git directory.`,
        ErrorCode.PATH_RESERVED_NAME,
        rawPath,
      );
    }

    // 5G: Strict POSIX portable ASCII character set
    if (!SAFE_SEGMENT_REGEX.test(segment)) {
      throw new PathSecurityError(
        `Segment "${segment}" contains characters outside safe POSIX portable ASCII grammar.`,
        ErrorCode.PATH_INVALID_CHARACTER,
        rawPath,
      );
    }
  }

  // --------------------------------------------------------------------------
  // STEP 6: Total Length Enforcement
  // --------------------------------------------------------------------------
  const assembledPath = segments.join("/");
  if (assembledPath.length > MAX_TOTAL_PATH_LENGTH) {
    throw new PathSecurityError(
      `Total path length (${assembledPath.length}) exceeds maximum limit of ${MAX_TOTAL_PATH_LENGTH} characters.`,
      ErrorCode.PATH_TOTAL_TOO_LONG,
      rawPath,
    );
  }

  // --------------------------------------------------------------------------
  // STEP 7: Base-Folder Boundary Containment Verification
  // --------------------------------------------------------------------------
  if (baseFolder && baseFolder.trim()) {
    const normalizedBase = validateBaseFolder(baseFolder);
    const expectedPrefix = `${normalizedBase}/`;

    if (!assembledPath.startsWith(expectedPrefix)) {
      // Prepend the base folder to enforce containment
      const fullPath = `${normalizedBase}/${assembledPath}`;
      if (fullPath.length > MAX_TOTAL_PATH_LENGTH) {
        throw new PathSecurityError(
          `Total path length with base folder (${fullPath.length}) exceeds limit of ${MAX_TOTAL_PATH_LENGTH}.`,
          ErrorCode.PATH_TOTAL_TOO_LONG,
          rawPath,
        );
      }
      return fullPath;
    }
  }

  // --------------------------------------------------------------------------
  // STEP 8: Final Repository-Relative Output
  // --------------------------------------------------------------------------
  return assembledPath;
}

/**
 * Validates a repository base folder according to safe path rules.
 */
export function validateBaseFolder(baseFolder: string): string {
  if (!baseFolder || typeof baseFolder !== "string") return "";
  const trimmed = baseFolder.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";

  const segments = trimmed.split("/").filter(Boolean);
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("..") ||
      segment.startsWith(".") ||
      segment.endsWith(".") ||
      !SAFE_SEGMENT_REGEX.test(segment) ||
      DOS_DEVICE_REGEX.test(segment) ||
      GIT_PROTECTED_REGEX.test(segment)
    ) {
      throw new PathSecurityError(
        `Invalid base folder segment: "${segment}".`,
        ErrorCode.PATH_BOUNDARY_VIOLATION,
        baseFolder,
      );
    }
  }

  return segments.join("/");
}

/**
 * Sanitizes and bounds a commit message to prevent Git header injection,
 * CRLF injection, and secret leakage.
 */
export function formatSafeCommitMessage(
  summary: string,
  body?: string,
): string {
  if (!summary || typeof summary !== "string") {
    return "Synchronized solution via CodeSync";
  }

  // Strip carriage returns and line feeds from the summary line
  const cleanSummary = summary
    .normalize("NFKC")
    .replace(/[\r\n]/g, " ")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    .trim()
    .slice(0, MAX_COMMIT_MESSAGE_LENGTH);

  if (!cleanSummary) {
    return "Synchronized solution via CodeSync";
  }

  if (!body || typeof body !== "string") {
    return cleanSummary;
  }

  // Sanitize body: allow clean LFs, strip non-printable control chars, cap at 1000 chars
  const cleanBody = body
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, "")
    .trim()
    .slice(0, 1000);

  return cleanBody ? `${cleanSummary}\n\n${cleanBody}` : cleanSummary;
}
