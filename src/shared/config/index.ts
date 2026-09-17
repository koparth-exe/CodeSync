import { ConfigurationError, ErrorCode } from "../errors";
import { DEFAULT_EXTENSION_CONFIG } from "./defaults";
import type { DuplicatePolicy, ExtensionConfig } from "./schema";
import { VALID_DUPLICATE_POLICIES } from "./schema";

export * from "./schema";
export * from "./defaults";

/**
 * Strict Safe Branch Regex:
 * Allows POSIX portable alphanumeric characters, dots, dashes, underscores, and forward slashes.
 * IMPORTANT ARCHITECTURAL NOTE:
 * This regex permits dots (e.g. 'release/v1.0'). Therefore, directory traversal ('..')
 * is NOT rejected by this regex alone; '..' is rejected by an INDEPENDENT traversal check
 * and segment boundary validation prior to regex evaluation.
 */
const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._/-]+$/;

/**
 * Strict Safe Folder Regex (POSIX portable ASCII segment grammar):
 * Validates individual folder segments between '/' separators.
 */
const SAFE_SEGMENT_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * DOS reserved device names (case-insensitive, with or without extensions).
 */
const DOS_DEVICE_REGEX = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * Validates a GitHub repository owner or repository name segment.
 */
const REPO_SEGMENT_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * Validates a repository identity string ('owner/repo') according to strict GitHub syntax.
 * Rejects whitespace, directory traversal ('..'), null bytes, control characters, or invalid formats.
 */
export function validateRepositoryIdentity(rawRepo: unknown): string {
  if (typeof rawRepo !== "string" || !rawRepo.trim()) {
    throw new ConfigurationError(
      "Target repository must be a non-empty string in 'owner/repo' format.",
      "Invalid target repository.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  const normalized = rawRepo.trim().normalize("NFKC");

  // Step A: Null-byte and control character check
  if (
    normalized.includes("\0") ||
    normalized.includes("%00") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1F\x7F]/.test(normalized) ||
    /\s/.test(normalized)
  ) {
    throw new ConfigurationError(
      "Target repository contains forbidden null bytes, whitespace, or control characters.",
      "Invalid target repository.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step B: Traversal rejection
  if (normalized.includes("..")) {
    throw new ConfigurationError(
      `Invalid target repository: "${normalized}". Directory traversal ('..') is strictly prohibited.`,
      "Invalid target repository.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step C: Separator and boundary checks
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("//") ||
    normalized.includes("\\")
  ) {
    throw new ConfigurationError(
      `Invalid target repository: "${normalized}". Must be in 'owner/repo' format without leading/trailing slashes.`,
      "Invalid target repository.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  const parts = normalized.split("/");
  if (parts.length !== 2) {
    throw new ConfigurationError(
      `Invalid target repository: "${normalized}". Must contain exactly one '/' separator ('owner/repo').`,
      "Invalid target repository.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  const [owner, name] = parts as [string, string];

  if (
    !owner ||
    !REPO_SEGMENT_REGEX.test(owner) ||
    owner.length > 39 ||
    owner === "." ||
    owner.startsWith(".") ||
    owner.endsWith(".")
  ) {
    throw new ConfigurationError(
      `Invalid repository owner segment: "${owner}".`,
      "Invalid target repository.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  if (
    !name ||
    !REPO_SEGMENT_REGEX.test(name) ||
    name.length > 100 ||
    name === "." ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw new ConfigurationError(
      `Invalid repository name segment: "${name}".`,
      "Invalid target repository.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  return `${owner}/${name}`;
}

/**
 * Validates a target branch name against CodeSync Safe Branch Grammar.
 * Rejects traversal, backslashes, null bytes, and non-conforming characters fail-closed.
 */
export function validateTargetBranch(rawBranch: unknown): string {
  const branchStr =
    typeof rawBranch === "string"
      ? rawBranch.trim()
      : DEFAULT_EXTENSION_CONFIG.targetBranch;

  // Step 1A: Canonicalization & Null-Byte Check
  const targetBranch = branchStr.normalize("NFKC");
  if (targetBranch.includes("\0") || targetBranch.includes("%00")) {
    throw new ConfigurationError(
      "Target branch contains forbidden null bytes.",
      "Invalid repository branch name.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 1B: Traversal Rejection (Independent of branch regex)
  if (targetBranch.includes("..")) {
    throw new ConfigurationError(
      `Invalid target branch: "${targetBranch}". Parent directory traversal ('..') is strictly prohibited.`,
      "Invalid repository branch name.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 1C: Boundary & Separator Validation
  if (
    !targetBranch ||
    targetBranch.startsWith("/") ||
    targetBranch.endsWith("/") ||
    targetBranch.includes("//") ||
    targetBranch.includes("\\")
  ) {
    throw new ConfigurationError(
      `Invalid target branch: "${targetBranch}". Cannot start/end with slashes or contain backslashes.`,
      "Invalid repository branch name.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 1D: Strict Safe Grammar Evaluation
  if (!SAFE_BRANCH_REGEX.test(targetBranch)) {
    throw new ConfigurationError(
      `Invalid target branch: "${targetBranch}". Contains characters outside safe git branch format.`,
      "Invalid repository branch name.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  return targetBranch;
}

/**
 * Validates a base folder path according to the 5-Pillar Path Defense.
 * Rejects absolute paths, drive letters, traversal, backslashes, and DOS reserved devices.
 */
export function validateBaseFolder(rawFolder: unknown): string {
  const folderStr =
    typeof rawFolder === "string"
      ? rawFolder.trim()
      : DEFAULT_EXTENSION_CONFIG.baseFolder;

  // Step 2A: Canonicalization & Null-Byte Check
  const baseFolder = folderStr.normalize("NFKC");
  if (baseFolder.includes("\0") || baseFolder.includes("%00")) {
    throw new ConfigurationError(
      "Base folder contains forbidden null bytes.",
      "Invalid base folder path.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 2B: Separator Validation
  if (baseFolder.includes("\\")) {
    throw new ConfigurationError(
      `Invalid base folder: "${baseFolder}". Backslashes are strictly prohibited.`,
      "Invalid base folder path.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 2C: Boundary Validation (No absolute root, no drive letters)
  if (
    baseFolder.startsWith("/") ||
    baseFolder.endsWith("/") ||
    /^[a-zA-Z]:/.test(baseFolder)
  ) {
    throw new ConfigurationError(
      `Invalid base folder: "${baseFolder}". Absolute paths and drive letters are strictly prohibited.`,
      "Invalid base folder path.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 2D: Traversal Rejection (Independent of regex)
  if (baseFolder.includes("..")) {
    throw new ConfigurationError(
      `Invalid base folder: "${baseFolder}". Traversal sequence '..' is strictly prohibited.`,
      "Invalid base folder path.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  // Step 2E: Segment-by-Segment Grammar & DOS Device Validation
  const segments = baseFolder.split("/");
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new ConfigurationError(
      `Invalid base folder: "${baseFolder}". Empty path segments are prohibited.`,
      "Invalid base folder path.",
      ErrorCode.CONFIG_TRAVERSAL_DETECTED,
    );
  }

  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.endsWith(".")
    ) {
      throw new ConfigurationError(
        `Invalid path segment "${segment}" in base folder. Dot segments are prohibited.`,
        "Invalid base folder path.",
        ErrorCode.CONFIG_TRAVERSAL_DETECTED,
      );
    }
    if (!SAFE_SEGMENT_REGEX.test(segment)) {
      throw new ConfigurationError(
        `Invalid characters in base folder segment: "${segment}". Must strictly match POSIX portable ASCII.`,
        "Invalid base folder path.",
        ErrorCode.CONFIG_TRAVERSAL_DETECTED,
      );
    }
    if (DOS_DEVICE_REGEX.test(segment)) {
      throw new ConfigurationError(
        `Base folder segment "${segment}" collides with reserved DOS device name.`,
        "Invalid base folder path.",
        ErrorCode.CONFIG_TRAVERSAL_DETECTED,
      );
    }
  }

  return baseFolder;
}

/**
 * Validates untrusted or retrieved configuration data at runtime.
 * Implements the Phase 0.1.2 Security Model:
 * 1. Canonicalization (Unicode NFKC, null-byte rejection)
 * 2. Traversal Rejection (independent check for '..' and '.' segments)
 * 3. Separator Normalization / Validation (rejection of backslashes and redundant slashes)
 * 4. Strict Safe Grammar (POSIX portable ASCII segment regex, DOS device check)
 * 5. Boundary Validation (rejection of absolute roots and drive letters)
 *
 * Fails closed by throwing ConfigurationError on any violation.
 */
export function validateConfig(input: unknown): ExtensionConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError(
      "Configuration must be a non-null object.",
      "Invalid configuration format.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  const raw = input as Record<string, unknown>;

  // 1. Target Branch Validation
  const targetBranch = validateTargetBranch(raw.targetBranch);

  // 2. Base Folder Validation
  const baseFolder = validateBaseFolder(raw.baseFolder);

  // Optional Target Repository Validation
  let targetRepository: string | undefined;
  if (raw.targetRepository !== undefined && raw.targetRepository !== null) {
    targetRepository = validateRepositoryIdentity(raw.targetRepository);
  }

  // 3. Duplicate Policy Validation
  const duplicatePolicy = raw.duplicatePolicy as DuplicatePolicy;
  if (!duplicatePolicy || !VALID_DUPLICATE_POLICIES.includes(duplicatePolicy)) {
    throw new ConfigurationError(
      `Invalid duplicate policy: "${String(raw.duplicatePolicy)}".`,
      "Invalid duplicate resolution policy.",
      ErrorCode.CONFIGURATION_INVALID,
    );
  }

  // 4. Enabled Platforms Validation
  const enabledPlatforms: Record<string, boolean> = {};
  if (
    raw.enabledPlatforms &&
    typeof raw.enabledPlatforms === "object" &&
    !Array.isArray(raw.enabledPlatforms)
  ) {
    for (const [platform, enabled] of Object.entries(
      raw.enabledPlatforms as Record<string, unknown>,
    )) {
      if (/^[a-z0-9_-]+$/i.test(platform) && typeof enabled === "boolean") {
        enabledPlatforms[platform.toLowerCase()] = enabled;
      }
    }
  } else {
    Object.assign(enabledPlatforms, DEFAULT_EXTENSION_CONFIG.enabledPlatforms);
  }

  // 5. Version Validation
  const version =
    typeof raw.version === "number" && raw.version > 0
      ? raw.version
      : DEFAULT_EXTENSION_CONFIG.version;

  return Object.freeze({
    version,
    ...(targetRepository ? { targetRepository } : {}),
    targetBranch,
    baseFolder,
    duplicatePolicy,
    enabledPlatforms: Object.freeze(enabledPlatforms),
  });
}
