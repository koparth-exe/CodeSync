import { createLogger } from "../shared/logger";
import { TrustBoundary } from "../shared/types/trust";
import { defaultAdapterRegistry } from "../shared/adapters/registry";
import { SubmissionEventDeduplicator } from "../shared/adapters/deduplicator";
import { type CanonicalSubmissionCandidate } from "../shared/adapters/types";
import { type ExtensionMessage } from "../shared/messaging/types";

const logger = createLogger("ContentScript");

/**
 * CodeSync Content Script (Semi-Trusted Context)
 *
 * Invariants (Phase 1C.3):
 * - Runs in an isolated world separate from page JavaScript execution.
 * - Does NOT trust webpage DOM or window messages.
 * - Adapter extraction produces CANDIDATE data, never authorization.
 * - All messages to background use typed ExtensionMessage with UUID v4 nonces.
 */
export default defineContentScript({
  matches: [
    "https://leetcode.com/*",
    "https://www.leetcode.com/*",
    "https://www.codechef.com/*",
    "https://codechef.com/*",
    "https://codeforces.com/*",
    "https://www.codeforces.com/*",
    "https://codeforces.net/*",
    "https://www.codeforces.net/*",
    "https://practice.geeksforgeeks.org/*",
    "https://www.geeksforgeeks.org/*",
  ],
  runAt: "document_idle",
  main() {
    const adapter = defaultAdapterRegistry.resolve(window.location.href);
    if (!adapter) {
      logger.debug("No matching platform adapter for current URL", {
        url: window.location.href,
        trustBoundary: TrustBoundary.SEMI_TRUSTED,
      });
      return;
    }

    logger.info(`Platform adapter activated: ${adapter.name}`, {
      platform: adapter.id,
      trustBoundary: TrustBoundary.SEMI_TRUSTED,
    });

    const deduplicator = new SubmissionEventDeduplicator();
    let isExtracting = false;

    async function handleSubmissionCheck(event?: Event) {
      if (isExtracting || !adapter) return;
      try {
        const detection = await adapter.detectSubmission({
          document,
          window,
          location: window.location,
          event,
        });

        if (!detection || !detection.detected) return;

        isExtracting = true;
        const candidate = await adapter.extractSubmission({
          document,
          window,
          location: window.location,
          detection,
        });

        if (!candidate) return;

        // In-memory deduplication check before sending message
        const eventKey = deduplicator.generateKey(
          candidate.platform,
          candidate.problemId,
          candidate.contentHash,
          candidate.status,
          candidate.submissionId,
        );

        if (deduplicator.checkAndRecord(eventKey)) {
          logger.debug("Duplicate submission event suppressed", { eventKey });
          return;
        }

        // Construct typed extension message
        const message: ExtensionMessage<CanonicalSubmissionCandidate> = {
          id: crypto.randomUUID(),
          type: "SUBMISSION_DETECTED",
          payload: candidate,
          timestamp: Date.now(),
          senderContext: "content-script",
          trustBoundary: TrustBoundary.SEMI_TRUSTED,
        };

        await browser.runtime.sendMessage(message);
        logger.info(
          "Submission candidate dispatched to background service worker",
          {
            platform: candidate.platform,
            problemId: candidate.problemId,
            status: candidate.status,
          },
        );
      } catch (err) {
        logger.warn("Submission detection/extraction error in content script", {
          error: (err as Error).message,
        });
      } finally {
        isExtracting = false;
      }
    }

    // Attach passive click listener for submit buttons
    document.addEventListener("click", (e) => void handleSubmissionCheck(e), {
      passive: true,
    });

    // Attach SPA popstate navigation listener
    window.addEventListener("popstate", () => void handleSubmissionCheck(), {
      passive: true,
    });

    // Bounded debounced MutationObserver for dynamic page updates
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void handleSubmissionCheck(), 300);
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    // Initial check on load
    void handleSubmissionCheck();
  },
});
