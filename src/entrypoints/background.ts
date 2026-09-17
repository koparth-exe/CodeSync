import { createLogger } from "../shared/logger";
import { TrustBoundary } from "../shared/types/trust";
import { defaultSubmissionHandler } from "../shared/adapters/submission-handler";
import {
  createGitHubQueueItemHandler,
  defaultQueueDrainer,
  QUEUE_DRAIN_ALARM_NAME,
  setupQueueDrainAlarm,
} from "../shared/queue";
import { GitHubApiClient } from "../shared/github/client";
import { GitHubContentsService } from "../shared/github/contents-service";
import { defaultGitHubAuthService } from "../shared/auth/service";
import { defaultStorageService } from "../shared/storage/local";
import type { RuntimeSenderInfo } from "../shared/messaging/types";

const logger = createLogger("BackgroundServiceWorker");

/**
 * CodeSync Background Service Worker (Trusted Execution Context)
 *
 * Invariants (Phase 1C.4.2.2):
 * - Service worker is the sole authoritative context for privileged operations.
 * - Security boundary: UNTRUSTED PAGE / CONTENT SCRIPT -> VALIDATED EXTENSION MESSAGE
 *   -> SERVICE-WORKER AUTHORIZATION -> PERMITTED OPERATION ONLY.
 * - Handles candidate submissions from semi-trusted content scripts via strict envelope validation.
 * - Content scripts and web pages communicate via extension messaging; they cannot bypass message
 *   validation or directly execute queue operations or arbitrary state mutations.
 * - Coordinates queue draining across submission events, periodic alarms, and startup/recovery.
 * - Registers the real GitHubQueueSyncHandler to process queued submissions through GitHubContentsService.
 */
export default defineBackground(() => {
  logger.info(
    "CodeSync Background Service Worker initializing (Phase 1C.4.2.2)",
    {
      trustBoundary: TrustBoundary.TRUSTED,
    },
  );

  // Initialize and register real GitHub queue item synchronization handler
  const gitHubClient = new GitHubApiClient({
    lifecycleManager: defaultGitHubAuthService.getLifecycleManager(),
  });
  const gitHubContentsService = new GitHubContentsService({
    client: gitHubClient,
  });
  const realQueueHandler = createGitHubQueueItemHandler({
    contentsService: gitHubContentsService,
    storage: defaultStorageService,
  });
  defaultQueueDrainer.setHandler(realQueueHandler);

  // Setup periodic alarm and trigger initial startup drain
  setupQueueDrainAlarm().catch((err) => {
    logger.warn("Initial alarm setup failed", {
      error: (err as Error).message,
    });
  });

  defaultQueueDrainer.drain("startup").catch((err) => {
    logger.warn("Initial queue drain failed on startup", {
      error: (err as Error).message,
    });
  });

  browser.runtime.onInstalled.addListener((details) => {
    logger.info(
      `CodeSync extension installed/updated: reason=${details.reason}`,
    );
    setupQueueDrainAlarm().catch(() => {});
    defaultQueueDrainer.drain("startup").catch((err) => {
      logger.warn("Queue drain failed on install/update", {
        error: (err as Error).message,
      });
    });
  });

  if (typeof browser !== "undefined" && browser.runtime?.onStartup) {
    browser.runtime.onStartup.addListener(() => {
      logger.info("Browser startup event received; triggering queue drain");
      setupQueueDrainAlarm().catch(() => {});
      defaultQueueDrainer.drain("startup").catch((err) => {
        logger.warn("Queue drain failed on browser startup", {
          error: (err as Error).message,
        });
      });
    });
  }

  if (typeof browser !== "undefined" && browser.alarms?.onAlarm) {
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === QUEUE_DRAIN_ALARM_NAME) {
        logger.info("Alarm trigger fired; executing queue drain", {
          alarmName: alarm.name,
        });
        defaultQueueDrainer.drain("alarm").catch((err) => {
          logger.warn("Queue drain failed on alarm trigger", {
            error: (err as Error).message,
          });
        });
      }
    });
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "SUBMISSION_DETECTED"
      ) {
        defaultSubmissionHandler
          .handleMessageAndEnqueue(message, sender as RuntimeSenderInfo)
          .then((result) => {
            sendResponse(result);
            // Initiate queue drain ONLY if submission was successfully enqueued
            if (result.success && result.queueItem) {
              defaultQueueDrainer
                .drain("submission_event")
                .catch((drainErr) => {
                  logger.warn("Queue drain failed after submission enqueue", {
                    error: (drainErr as Error).message,
                  });
                });
            }
          })
          .catch((err) => {
            logger.warn(
              "Submission validation/enqueue failed in service worker",
              {
                error: (err as Error).message,
              },
            );
            sendResponse({ success: false, error: (err as Error).message });
          });
        return true; // Keep message channel open for async response
      }
      return undefined;
    },
  );
});
