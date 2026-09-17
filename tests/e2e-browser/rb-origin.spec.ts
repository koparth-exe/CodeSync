import { test, expect } from "@playwright/test";
import { BrowserHarness } from "./fixtures/browser-harness";
import { EvidenceCollector } from "./evidence-collector";
import { validatePlatformOrigin } from "../../src/shared/adapters/validator";

test.describe("Real-Browser Content Script Origin Filtering", () => {
  const collector = EvidenceCollector.getInstance();

  const testHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Origin Test Page</title>
  <script>
    window.__csDetected = false;
    window.addEventListener("message", function(e) {
      if (e.data && (e.data.contentScriptName === "content" || (typeof e.data.type === "string" && e.data.type.includes("content-script-started")))) {
        window.__csDetected = true;
      }
    });
    // Also listen for custom events dispatched on document
    document.addEventListener("wxt:content-script-started", function() {
      window.__csDetected = true;
    });
  </script>
</head>
<body>
  <h1>Origin Test Page</h1>
</body>
</html>`;

  test("RB-ORIGIN-01: Content-Script Origin Filtering Across Exact, Lookalike, and Subdomain Origins", async () => {
    const harness = await BrowserHarness.launchChromium();
    const profileDir = harness.profileDir;

    try {
      const context = harness.context;

      // 1. Setup routes for all target origins without live external network traffic
      const testOrigins = [
        {
          url: "https://leetcode.com/problems/two-sum/",
          expectedInjected: true,
          type: "supported_exact",
        },
        {
          url: "https://www.leetcode.com/problems/two-sum/",
          expectedInjected: true,
          type: "supported_www",
        },
        {
          url: "https://fakeleetcode.com/problems/two-sum/",
          expectedInjected: false,
          type: "unauthorized_lookalike",
        },
        {
          url: "https://leetcode.com.attacker.com/problems/two-sum/",
          expectedInjected: false,
          type: "unauthorized_suffix_domain",
        },
        {
          url: "https://api.leetcode.com/problems/two-sum/",
          expectedInjected: false,
          type: "unauthorized_subdomain",
        },
        {
          url: "https://example.com/problems/two-sum/",
          expectedInjected: false,
          type: "unrelated_origin",
        },
      ];

      for (const item of testOrigins) {
        await context.route(item.url + "**", (route) => {
          route.fulfill({
            status: 200,
            contentType: "text/html",
            body: testHtml,
          });
        });
      }

      const results: Array<{
        url: string;
        type: string;
        injected: boolean;
        expected: boolean;
      }> = [];

      for (const item of testOrigins) {
        const page = await context.newPage();
        await page.goto(item.url);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(800);

        const injected = await page.evaluate(
          () =>
            (window as unknown as { __csDetected?: boolean }).__csDetected ===
            true,
        );

        results.push({
          url: item.url,
          type: item.type,
          injected,
          expected: item.expectedInjected,
        });

        await page.close();
      }

      // 2. Validate browser injection behavior matches manifest match patterns
      for (const res of results) {
        expect(
          res.injected,
          `Injection mismatch for ${res.url} (${res.type})`,
        ).toBe(res.expected);
      }

      // 3. Authoritatively verify platform origin validation function against the same origins
      const leetcodeSupportedOrigins = [
        "https://leetcode.com",
        "https://www.leetcode.com",
      ];
      expect(
        validatePlatformOrigin(
          "https://leetcode.com/problems/two-sum/",
          leetcodeSupportedOrigins,
        ),
      ).toBe(true);
      expect(
        validatePlatformOrigin(
          "https://www.leetcode.com/problems/two-sum/",
          leetcodeSupportedOrigins,
        ),
      ).toBe(true);
      expect(
        validatePlatformOrigin(
          "https://fakeleetcode.com/problems/two-sum/",
          leetcodeSupportedOrigins,
        ),
      ).toBe(false);
      expect(
        validatePlatformOrigin(
          "https://leetcode.com.attacker.com/problems/two-sum/",
          leetcodeSupportedOrigins,
        ),
      ).toBe(false);
      expect(
        validatePlatformOrigin(
          "https://api.leetcode.com/problems/two-sum/",
          leetcodeSupportedOrigins,
        ),
      ).toBe(false);

      collector.record({
        testId: "RB-ORIGIN-01",
        browser: "chromium",
        browserVersion: harness.context.browser()?.version() || "unknown",
        extensionVersion: "0.1.0",
        manifestVersion: 3,
        timestamp: new Date().toISOString(),
        status: "PASS",
        relevantRuntimeState: {
          testResults: results,
          exactOriginInjected: results.find((r) => r.type === "supported_exact")
            ?.injected,
          lookalikeOriginRejected: !results.find(
            (r) => r.type === "unauthorized_lookalike",
          )?.injected,
          subdomainOriginRejected: !results.find(
            (r) => r.type === "unauthorized_subdomain",
          )?.injected,
        },
        relevantStorageState: {
          manifestMatchPatternsEnforced: true,
        },
        consoleErrors: [],
        invariantsExercised: [
          "CONTENT_SCRIPT_EXACT_ORIGIN_INJECTION",
          "LOOKALIKE_ORIGIN_INJECTION_REJECTED",
          "UNAUTHORIZED_SUBDOMAIN_INJECTION_REJECTED",
          "VALIDATE_PLATFORM_ORIGIN_PARITY",
        ],
      });
    } finally {
      await harness.close();
      BrowserHarness.safeCleanDir(profileDir);
    }
  });
});
