/**
 * Submission Handler (Phase 1C.3 & 1C.4.1 - Trusted Service Worker Context)
 *
 * Enforces authoritative validation on candidate submissions received from content scripts
 * and bridges verified candidates into the durable WAL-backed persistent queue:
 * 1. Validates message envelope (UUID v4 nonce, sliding window freshness, anti-replay).
 * 2. Enforces sender-context authorization (must be verified runtime "content-script").
 * 3. Cross-references sender tab URL against adapter's approved origins (rejects spoofing).
 * 4. Authoritatively validates canonical submission schema, bounds, and character hygiene.
 * 5. Requires status === "ACCEPTED" for queue eligibility.
 * 6. Deterministically normalizes source code (Unicode NFKC, LF line endings, stripped trailing spaces).
 * 7. Computes cryptographic content identity (SHA-256 lowercase hex).
 * 8. Captures immutable TargetSnapshot (repository, branch, base path, duplicate policy).
 * 9. Enqueues through intent-first Write-Ahead Log (WAL) into hybrid storage (IndexedDB + storage.local).
 * 10. Zero automatic GitHub sync in Phase 1C.4.1.
 */

import { MessageEnvelopeValidator } from "../messaging/validator";
import { type RuntimeSenderInfo } from "../messaging/types";
import { type CanonicalSubmissionCandidate } from "./types";
import {
  validateCanonicalSubmission,
  validatePlatformOrigin,
} from "./validator";
import {
  defaultAdapterRegistry,
  type PlatformAdapterRegistry,
} from "./registry";
import { createLogger } from "../logger";
import { TrustBoundary } from "../types/trust";
import {
  ConfigurationError,
  ErrorCode,
  PlatformAdapterError,
  SecurityError,
} from "../errors";
import {
  DEFAULT_EXTENSION_CONFIG,
  validateBaseFolder,
  validateConfig,
  validateRepositoryIdentity,
  validateTargetBranch,
} from "../config";
import {
  MAX_SOURCE_PAYLOAD_BYTES,
  normalizeDuplicatePolicy,
} from "../github/types";
import { computeContentHash, normalizeSourceCode } from "../deduplication";
import { defaultQueueManager, QueueManager } from "../queue/manager";
import { defaultStorageService, StorageService } from "../storage/local";
import { STORAGE_KEYS } from "../storage/keys";
import type { QueueItemMetadata, TargetSnapshot } from "../storage/types";
import type { NormalizedSubmission } from "../queue/types";

const logger = createLogger("SubmissionHandler");

export interface IngestionResult {
  readonly success: boolean;
  readonly candidate?: CanonicalSubmissionCandidate | undefined;
  readonly error?: string | undefined;
}

export interface SubmissionEnqueueResult {
  readonly success: boolean;
  readonly queueItem?: QueueItemMetadata | undefined;
  readonly candidate?: CanonicalSubmissionCandidate | undefined;
  readonly error?: string | undefined;
}

export interface SubmissionHandlerOptions {
  readonly queueManager?: QueueManager | undefined;
  readonly storage?: StorageService | undefined;
  readonly targetSnapshotSupplier?:
    | ((candidate: CanonicalSubmissionCandidate) => Promise<TargetSnapshot>)
    | undefined;
}

export class SubmissionHandler {
  private readonly validator: MessageEnvelopeValidator;
  private readonly registry: PlatformAdapterRegistry;
  private readonly queueManager: QueueManager;
  private readonly storage: StorageService;
  private readonly targetSnapshotSupplier?:
    | ((candidate: CanonicalSubmissionCandidate) => Promise<TargetSnapshot>)
    | undefined;

  constructor(
    validator?: MessageEnvelopeValidator,
    registry?: PlatformAdapterRegistry,
    options?: SubmissionHandlerOptions,
  ) {
    this.validator = validator ?? new MessageEnvelopeValidator();
    this.registry = registry ?? defaultAdapterRegistry;
    this.queueManager = options?.queueManager ?? defaultQueueManager;
    this.storage = options?.storage ?? defaultStorageService;
    this.targetSnapshotSupplier = options?.targetSnapshotSupplier;
  }

  /**
   * Processes and validates an incoming submission message from the semi-trusted content script.
   * Synchronous validation method preserved for Phase 1C.3 backwards compatibility.
   * Throws SecurityError or PlatformAdapterError fail-closed on unauthorized or malformed submission.
   */
  handleMessage(
    rawMessage: unknown,
    runtimeSender?: RuntimeSenderInfo,
  ): IngestionResult {
    // 1. Envelope validation: schema, nonce, freshness, sender context allowlist, anti-replay
    const envelope =
      this.validator.validateEnvelope<CanonicalSubmissionCandidate>(
        rawMessage,
        runtimeSender,
        "content-script",
      );

    if (envelope.type !== "SUBMISSION_DETECTED") {
      return {
        success: false,
        error: `Unhandled message type: ${envelope.type}`,
      };
    }

    const candidate = envelope.payload;

    // 2. Sender tab URL origin cross-check (detects spoofed platform claims)
    const senderUrl = runtimeSender?.tab?.url ?? runtimeSender?.url;
    if (senderUrl) {
      const adapter = this.registry.get(candidate.platform);
      if (
        !adapter ||
        !validatePlatformOrigin(senderUrl, adapter.supportedOrigins)
      ) {
        throw new SecurityError(
          `Spoofed submission origin: platform '${candidate.platform}' does not match sender tab URL '${senderUrl}'.`,
          ErrorCode.SECURITY_VIOLATION,
        );
      }
    }

    // 3. Authoritative candidate schema, bounds, and character hygiene validation
    const validated = validateCanonicalSubmission(
      candidate,
      candidate.platform,
    );

    logger.info("Canonical submission candidate validated in service worker", {
      platform: validated.platform,
      problemId: validated.problemId,
      status: validated.status,
      language: validated.language,
      contentHash: validated.contentHash,
      trustBoundary: TrustBoundary.TRUSTED,
    });

    return { success: true, candidate: validated };
  }

  /**
   * Resolves and authoritatively validates an immutable TargetSnapshot at enqueue time.
   * The snapshot locks repository identity, branch, base path, and duplicate policy.
   */
  async resolveTargetSnapshot(
    candidate: CanonicalSubmissionCandidate,
  ): Promise<TargetSnapshot> {
    if (this.targetSnapshotSupplier) {
      const supplied = await this.targetSnapshotSupplier(candidate);
      return Object.freeze({
        targetRepository: validateRepositoryIdentity(supplied.targetRepository),
        targetBranch: validateTargetBranch(supplied.targetBranch),
        basePath: validateBaseFolder(supplied.basePath),
        duplicatePolicy: normalizeDuplicatePolicy(supplied.duplicatePolicy),
        ...(supplied.pathTemplate
          ? { pathTemplate: supplied.pathTemplate }
          : {}),
      });
    }

    // 1. Read extension configuration
    const rawConfig = await this.storage.get<Record<string, unknown>>(
      STORAGE_KEYS.CONFIG,
    );
    const config = validateConfig(rawConfig ?? DEFAULT_EXTENSION_CONFIG);

    // 2. Read authenticated repository authorizations
    const rawAuth = await this.storage.get<{
      authorizedRepositories?: readonly string[];
    }>(STORAGE_KEYS.AUTH);

    // 3. Resolve target repository
    let targetRepo: string | undefined = config.targetRepository;
    let isAuthorized = false;
    if (!targetRepo && rawAuth?.authorizedRepositories?.length) {
      targetRepo = rawAuth.authorizedRepositories[0];
      isAuthorized = true;
    } else if (
      targetRepo &&
      rawAuth?.authorizedRepositories?.includes(targetRepo)
    ) {
      isAuthorized = true;
    }

    if (!targetRepo) {
      throw new ConfigurationError(
        "No target repository configured or authorized. Please configure a repository in extension settings.",
        "Missing target repository.",
        ErrorCode.CONFIGURATION_INVALID,
      );
    }

    const validatedRepo = validateRepositoryIdentity(targetRepo);
    const validatedBranch = validateTargetBranch(config.targetBranch);
    const validatedFolder = validateBaseFolder(config.baseFolder);
    const duplicatePolicy = normalizeDuplicatePolicy(config.duplicatePolicy);

    return Object.freeze({
      targetRepository: validatedRepo,
      targetBranch: validatedBranch,
      basePath: validatedFolder,
      duplicatePolicy,
      authorizationStatus: isAuthorized
        ? "AUTHORIZED"
        : "CONFIGURED_UNVERIFIED",
    });
  }

  /**
   * End-to-end Phase 1C.4.1 pipeline:
   * Message Authorization -> Deterministic Validation -> Normalization ->
   * Content Hash -> Target Snapshot -> Durable WAL Enqueue.
   */
  async handleMessageAndEnqueue(
    rawMessage: unknown,
    runtimeSender?: RuntimeSenderInfo,
  ): Promise<SubmissionEnqueueResult> {
    // 1. Authoritative envelope, sender context, and candidate schema validation
    const validationResult = this.handleMessage(rawMessage, runtimeSender);
    if (!validationResult.success || !validationResult.candidate) {
      return {
        success: false,
        error: validationResult.error ?? "Submission validation failed.",
      };
    }

    const candidate = validationResult.candidate;

    // 2. Enforce submission acceptance requirement
    if (candidate.status !== "ACCEPTED") {
      return {
        success: false,
        candidate,
        error: `Submission status '${candidate.status}' is not eligible for queueing. Only ACCEPTED submissions qualify.`,
      };
    }

    // 3. Deterministic source code normalization
    const normalizedSource = normalizeSourceCode(candidate.sourceCode);
    const payloadByteLength = new TextEncoder().encode(normalizedSource).length;
    if (payloadByteLength > MAX_SOURCE_PAYLOAD_BYTES) {
      throw new PlatformAdapterError(
        `Normalized source code exceeds maximum payload size of ${MAX_SOURCE_PAYLOAD_BYTES} bytes (${payloadByteLength} bytes).`,
        ErrorCode.SOURCE_INVALID,
        candidate.platform,
      );
    }

    // 4. Deterministic content identity (SHA-256 lowercase hex)
    const contentHash = await computeContentHash(normalizedSource);

    // 5. Immutable Target Snapshot capture
    const targetSnapshot = await this.resolveTargetSnapshot(candidate);

    // 6. Construct normalized submission model for queue ingestion
    const normalizedSubmission: NormalizedSubmission = {
      id: crypto.randomUUID(),
      platform: candidate.platform,
      submissionId: candidate.submissionId,
      submissionUrl: candidate.sourceUrl,
      targetRepository: targetSnapshot.targetRepository,
      targetBranch: targetSnapshot.targetBranch,
      problemTitle: candidate.problemTitle,
      problemSlug: candidate.problemSlug,
      problemId: candidate.problemId,
      status: candidate.status,
      language: candidate.language,
      sourceCode: normalizedSource,
      contentHash,
      extractionConfidence: candidate.extractionConfidence,
      submittedAt: candidate.submittedAt,
      detectedAt: Date.now(),
      platformMetadata: candidate.platformMetadata,
      targetSnapshot,
      sourceProvenance: candidate.sourceProvenance,
      validatedBy: "SERVICE_WORKER",
    };

    // 7. Enqueue via durable Write-Ahead Log (WAL)
    const queueItem =
      await this.queueManager.enqueueSubmission(normalizedSubmission);

    logger.info("Submission enqueued to durable queue in PENDING state", {
      id: queueItem.id,
      platform: queueItem.platform,
      problemSlug: queueItem.problemSlug,
      contentHash: queueItem.contentHash,
      state: queueItem.state,
      targetRepository: targetSnapshot.targetRepository,
      targetBranch: targetSnapshot.targetBranch,
      trustBoundary: TrustBoundary.TRUSTED,
    });

    return {
      success: true,
      queueItem,
      candidate,
    };
  }
}

export const defaultSubmissionHandler = new SubmissionHandler();
