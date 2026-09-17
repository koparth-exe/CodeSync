/**
 * LeetCode Platform Adapter (Phase 1C.3)
 *
 * Implements detection, extraction, and normalization for LeetCode (leetcode.com).
 * Adheres strictly to least-privilege DOM inspection and defense-in-depth candidate validation.
 */

import { BasePlatformAdapter } from "../base-adapter";
import {
  type CanonicalSubmissionCandidate,
  type CanonicalSubmissionStatus,
  type DetectionResult,
  type DetectorContext,
  type ExtractionContext,
  type PlatformId,
  type SourceProvenance,
} from "../types";
import { sanitizeSlug, validateAuthoritativeSource } from "../validator";

export class LeetCodeAdapter extends BasePlatformAdapter {
  readonly id: PlatformId = "leetcode";
  readonly name = "LeetCode";
  readonly supportedOrigins: readonly string[] = [
    "https://leetcode.com",
    "https://www.leetcode.com",
  ];

  /**
   * Evaluates whether the URL corresponds to a LeetCode problem or submission page.
   */
  override canHandle(url: URL | string): boolean {
    if (!super.canHandle(url)) return false;
    try {
      const parsed = typeof url === "string" ? new URL(url) : url;
      return parsed.pathname.includes("/problems/");
    } catch {
      return false;
    }
  }

  /**
   * Detects submission events on LeetCode pages.
   */
  async detectSubmission(
    context: DetectorContext,
  ): Promise<DetectionResult | null> {
    const doc = context.document;
    if (!doc) return null;

    // Check for submission result banners
    const resultElement = doc.querySelector(
      '[data-e2e-locator="submission-result"], [class*="result-state-"], [class*="status-column__"]',
    );
    if (resultElement) {
      const text = resultElement.textContent?.trim() ?? "";
      const status = this.mapStatus(text);
      return {
        detected: true,
        eventType: "result_mutation",
        status,
        timestamp: Date.now(),
      };
    }

    // Check for submit button click event
    if (context.event?.type === "click") {
      const target = context.event.target as Element | null;
      const submitBtn = target?.closest(
        'button[data-e2e-locator="console-submit-button"], button[data-cy="submit-code-btn"], button[class*="submit-btn"]',
      );
      if (submitBtn) {
        return {
          detected: true,
          eventType: "submit_click",
          status: "PENDING",
          timestamp: Date.now(),
        };
      }
    }

    return null;
  }

  /**
   * Extracts canonical submission candidate from LeetCode DOM / page state.
   */
  async extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null> {
    const doc = context.document;
    const loc = context.location;
    const urlStr = loc.toString();

    // 1. Extract problem slug from URL
    const problemSlug = this.extractProblemSlug(urlStr);
    if (!problemSlug) return null;

    // 2. Extract problem title
    const problemTitle =
      this.extractProblemTitle(doc) ||
      problemSlug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

    // 3. Extract submission status
    const statusText =
      doc
        ?.querySelector(
          '[data-e2e-locator="submission-result"], [class*="result-state-"], div[class*="status-accepted"], div[class*="status-wrong"]',
        )
        ?.textContent?.trim() ?? "";
    const status = context.detection?.status ?? this.mapStatus(statusText);

    // 4. Extract programming language
    const language = this.extractLanguage(doc) || "cpp";

    // 5. Extract source code and provenance (Phase 1C.3 C3.2)
    const extracted = this.extractSource(context);
    if (!extracted || !extracted.source.trim()) {
      return null;
    }

    const normalizedCode = this.normalizeSource(extracted.source);
    const contentHash = await this.computeHash(normalizedCode);
    const sourceProvenance = extracted.provenance;

    // 6. Optional metadata
    const difficulty = this.extractDifficulty(doc);
    const submissionId = this.extractSubmissionId(urlStr, doc);

    const candidate: CanonicalSubmissionCandidate = {
      platform: "leetcode",
      problemId: problemSlug,
      problemSlug,
      problemTitle,
      status,
      language,
      sourceCode: normalizedCode,
      contentHash,
      submittedAt: context.detection?.timestamp ?? Date.now(),
      sourceUrl: urlStr,
      problemUrl: `https://leetcode.com/problems/${problemSlug}/`,
      sourceProvenance,
      submissionId,
      difficulty,
      extractionConfidence:
        sourceProvenance === "AUTHORITATIVE_SUBMISSION_SOURCE" ||
        sourceProvenance === "SUBMISSION_PAGE_SOURCE"
          ? 0.95
          : 0.85,
      extractionLayer:
        sourceProvenance === "AUTHORITATIVE_SUBMISSION_SOURCE" ? "api" : "dom",
      diagnostics: {
        rawStatusText: statusText,
        hasMonaco: Boolean(doc?.querySelector(".monaco-editor")),
      },
    };

    return this.validateCandidate(candidate);
  }

  private extractProblemSlug(urlStr: string): string | null {
    try {
      const parsed = new URL(urlStr);
      const match = parsed.pathname.match(/\/problems\/([^/]+)/);
      if (match && match[1]) {
        return sanitizeSlug(match[1]);
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractProblemTitle(doc?: Document): string | null {
    if (!doc) return null;
    const titleElem = doc.querySelector(
      'div[data-cy="question-title"], [class*="text-title-large"], a[href*="/problems/"][class*="font-medium"]',
    );
    if (titleElem && titleElem.textContent?.trim()) {
      return titleElem.textContent.trim().replace(/^\d+\.\s*/, "");
    }
    return null;
  }

  private extractLanguage(doc?: Document): string {
    if (!doc) return "cpp";
    const langBtn = doc.querySelector(
      'button[id*="headlessui-listbox-button"], div[class*="select-language"], [data-cy="lang-select"]',
    );
    const text = langBtn?.textContent?.trim().toLowerCase() ?? "";
    if (text.includes("c++")) return "cpp";
    if (text.includes("java")) return "java";
    if (text.includes("python3") || text.includes("python")) return "python";
    if (text.includes("javascript")) return "javascript";
    if (text.includes("typescript")) return "typescript";
    if (text.includes("rust")) return "rust";
    if (text.includes("go")) return "go";
    return text || "cpp";
  }

  private extractSource(
    context: ExtractionContext,
  ): { source: string; provenance: SourceProvenance } | null {
    // 1. Approved extension-controlled authoritative extraction path
    const verifiedAuthoritative = validateAuthoritativeSource(
      context.authoritativeSource,
    );
    if (verifiedAuthoritative) {
      return {
        source: verifiedAuthoritative,
        provenance: "AUTHORITATIVE_SUBMISSION_SOURCE",
      };
    }

    const doc = context.document;
    if (!doc) return null;

    // 2. Submission detail code element on submission view page
    const subDetailCode = doc.querySelector(
      '.submission-detail-code, [data-e2e-locator="submission-code"], pre code.submission-code',
    );
    if (subDetailCode && subDetailCode.textContent?.trim()) {
      return {
        source: subDetailCode.textContent.trim(),
        provenance: "SUBMISSION_PAGE_SOURCE",
      };
    }

    // 3. Editor text content from Monaco lines or textarea
    const codeLines = doc.querySelectorAll(
      ".monaco-editor .view-line, .editor-scrollable .view-line",
    );
    if (codeLines.length > 0) {
      const lines = Array.from(codeLines).map((line) => line.textContent ?? "");
      const code = lines.join("\n").trim();
      if (code) {
        return {
          source: code,
          provenance: "EDITOR_SOURCE",
        };
      }
    }

    const textarea = doc.querySelector(
      'textarea[class*="monaco"], textarea[data-cy="code-editor"]',
    );
    if (textarea) {
      const val = (
        (textarea as HTMLTextAreaElement).value ||
        textarea.textContent ||
        ""
      ).trim();
      if (val) {
        return {
          source: val,
          provenance: "EDITOR_SOURCE",
        };
      }
    }

    // 4. Fallback pre / code block
    const fallback = doc.querySelector("pre code, pre");
    if (fallback && fallback.textContent?.trim()) {
      return {
        source: fallback.textContent.trim(),
        provenance: "DOM_FALLBACK_SOURCE",
      };
    }

    return null;
  }

  private extractDifficulty(doc?: Document): string | undefined {
    if (!doc) return undefined;
    const diffElem = doc.querySelector(
      '[class*="text-difficulty-easy"], [class*="text-difficulty-medium"], [class*="text-difficulty-hard"], [data-degree]',
    );
    const text = diffElem?.textContent?.trim();
    if (text && /^(Easy|Medium|Hard)$/i.test(text)) {
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    }
    return undefined;
  }

  private extractSubmissionId(
    urlStr: string,
    doc?: Document,
  ): string | undefined {
    try {
      const match = urlStr.match(/\/submissions\/detail\/(\d+)/);
      if (match && match[1]) return match[1];
    } catch {
      // Ignore
    }
    const subLink = doc?.querySelector('a[href*="/submissions/detail/"]');
    if (subLink) {
      const href = subLink.getAttribute("href") ?? "";
      const match = href.match(/\/submissions\/detail\/(\d+)/);
      if (match && match[1]) return match[1];
    }
    return undefined;
  }

  private mapStatus(rawText: string): CanonicalSubmissionStatus {
    const lower = rawText.toLowerCase();
    if (lower.includes("accepted")) return "ACCEPTED";
    if (
      lower.includes("wrong answer") ||
      lower.includes("time limit exceeded") ||
      lower.includes("runtime error") ||
      lower.includes("compile error") ||
      lower.includes("memory limit exceeded") ||
      lower.includes("output limit exceeded")
    ) {
      return "REJECTED";
    }
    if (
      lower.includes("pending") ||
      lower.includes("judging") ||
      lower.includes("running") ||
      lower.includes("queued")
    ) {
      return "PENDING";
    }
    return "UNKNOWN";
  }
}
