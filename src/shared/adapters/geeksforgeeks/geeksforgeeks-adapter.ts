/**
 * GeeksforGeeks Platform Adapter (Phase 1C.3)
 *
 * Implements detection, extraction, and normalization for GeeksforGeeks Practice (geeksforgeeks.org).
 * Safely parses practice problem pages and output consoles.
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

export class GeeksforGeeksAdapter extends BasePlatformAdapter {
  readonly id: PlatformId = "geeksforgeeks";
  readonly name = "GeeksforGeeks";
  readonly supportedOrigins: readonly string[] = [
    "https://practice.geeksforgeeks.org",
    "https://www.geeksforgeeks.org",
  ];

  override canHandle(url: URL | string): boolean {
    if (!super.canHandle(url)) return false;
    try {
      const parsed = typeof url === "string" ? new URL(url) : url;
      return parsed.pathname.includes("/problems/");
    } catch {
      return false;
    }
  }

  async detectSubmission(
    context: DetectorContext,
  ): Promise<DetectionResult | null> {
    const doc = context.document;
    if (!doc) return null;

    // Check for verdict text in output/result container
    const resultElem = doc.querySelector(
      '.problems_content__, div[class*="problem-feedback"], div[class*="status-container"], [class*="verdict_text"]',
    );
    if (resultElem) {
      const text = resultElem.textContent?.trim() ?? "";
      const status = this.mapStatus(text);
      return {
        detected: true,
        eventType: "result_mutation",
        status,
        timestamp: Date.now(),
      };
    }

    if (context.event?.type === "click") {
      const target = context.event.target as Element | null;
      const btn = target?.closest(
        'button, [role="button"], input[type="submit"], input[type="button"]',
      );
      if (btn) {
        const cls = btn.getAttribute("class") || "";
        const id = btn.getAttribute("id") || "";
        const label = (btn.textContent || (btn as HTMLInputElement).value || "")
          .trim()
          .toLowerCase();

        const isSubmitAttr =
          cls.toLowerCase().includes("submit") ||
          id.toLowerCase().includes("submit") ||
          cls.includes("problems_submit_button__");

        const isSubmitText =
          label === "submit" ||
          label.startsWith("submit ") ||
          label.endsWith(" submit");

        if (isSubmitAttr || isSubmitText) {
          return {
            detected: true,
            eventType: "submit_click",
            status: "PENDING",
            timestamp: Date.now(),
          };
        }
      }
    }

    return null;
  }

  async extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null> {
    const doc = context.document;
    const loc = context.location;
    const urlStr = loc.toString();

    const problemSlug = this.extractProblemSlug(urlStr);
    if (!problemSlug) return null;

    const problemTitle =
      this.extractProblemTitle(doc) ||
      problemSlug
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

    const resultElem = doc?.querySelector(
      '.problems_content__, div[class*="problem-feedback"], [class*="verdict_text"], div[class*="status-text"]',
    );
    const statusText = resultElem?.textContent?.trim() ?? "";
    const status = context.detection?.status ?? this.mapStatus(statusText);

    const language = this.extractLanguage(doc) || "cpp";

    const extracted = this.extractSource(context);
    if (!extracted || !extracted.source.trim()) {
      return null;
    }

    const normalizedCode = this.normalizeSource(extracted.source);
    const contentHash = await this.computeHash(normalizedCode);
    const sourceProvenance = extracted.provenance;

    const difficulty = this.extractDifficulty(doc);
    const submissionId = this.extractSubmissionId(urlStr, doc);

    const candidate: CanonicalSubmissionCandidate = {
      platform: "geeksforgeeks",
      problemId: problemSlug,
      problemSlug,
      problemTitle,
      status,
      language,
      sourceCode: normalizedCode,
      contentHash,
      submittedAt: context.detection?.timestamp ?? Date.now(),
      sourceUrl: urlStr,
      problemUrl: `https://www.geeksforgeeks.org/problems/${problemSlug}/1`,
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
      },
    };

    return this.validateCandidate(candidate);
  }

  private extractProblemSlug(urlStr: string): string | null {
    try {
      const parsed = new URL(urlStr);
      // /problems/:slug/ or /problems/:slug/1
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
      "h3, div[class*='problem-title'], div[class*='problemName'], .problems_header_content__ h1",
    );
    if (titleElem && titleElem.textContent?.trim()) {
      return titleElem.textContent.trim();
    }
    return null;
  }

  private extractLanguage(doc?: Document): string {
    if (!doc) return "cpp";
    const langBtn = doc.querySelector(
      'div[class*="select-language"], button[class*="language-btn"], select[class*="language-select"], div[class*="current-language"]',
    );
    const text =
      (langBtn &&
      langBtn.tagName.toLowerCase() === "select" &&
      (langBtn as HTMLSelectElement).value
        ? (langBtn as HTMLSelectElement).value
        : langBtn?.textContent) ?? "";
    const lower = text.toLowerCase();
    if (lower.includes("c++") || lower.includes("cpp")) return "cpp";
    if (lower.includes("java")) return "java";
    if (lower.includes("python")) return "python";
    if (lower.includes("javascript")) return "javascript";
    if (lower.includes("c#")) return "csharp";
    return text.trim() || "cpp";
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

    // 2. Submission detail modal / submitted code element
    const subElem = doc.querySelector(
      'pre.submission_code, .submitted-code, [data-submitted-code], pre[class*="submission"]',
    );
    if (subElem && subElem.textContent?.trim()) {
      return {
        source: subElem.textContent.trim(),
        provenance: "SUBMISSION_PAGE_SOURCE",
      };
    }

    // 3. Editor source (ACE or Monaco lines, or editor textarea)
    const lines = doc.querySelectorAll(".ace_line, .monaco-editor .view-line");
    if (lines.length > 0) {
      const code = Array.from(lines)
        .map((l) => l.textContent ?? "")
        .join("\n")
        .trim();
      if (code) {
        return {
          source: code,
          provenance: "EDITOR_SOURCE",
        };
      }
    }

    const textarea = doc.querySelector("textarea");
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

    // 4. Fallback: Generic pre / code block
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
      'span[class*="difficulty"], div[class*="problem-difficulty"], [class*="difficulty-text"]',
    );
    const text = diffElem?.textContent?.trim();
    if (text && /^(School|Basic|Easy|Medium|Hard)$/i.test(text)) {
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    }
    return undefined;
  }

  private extractSubmissionId(
    urlStr: string,
    doc?: Document,
  ): string | undefined {
    try {
      const parsed = new URL(urlStr);
      const subParam = parsed.searchParams.get("sub_id");
      if (subParam && subParam.trim()) return subParam.trim();
    } catch {
      // Ignore
    }

    const subElem = doc?.querySelector(
      '[data-submission-id], [class*="submissionId"]',
    );
    if (subElem) {
      const attr = subElem.getAttribute("data-submission-id");
      if (attr && attr.trim()) return attr.trim();
    }

    return undefined;
  }

  private mapStatus(rawText: string): CanonicalSubmissionStatus {
    const lower = rawText.toLowerCase();
    if (
      lower.includes("problem solved successfully") ||
      lower.includes("correct answer") ||
      lower.includes("accepted")
    ) {
      return "ACCEPTED";
    }
    if (
      lower.includes("compilation error") ||
      lower.includes("wrong answer") ||
      lower.includes("time limit exceeded") ||
      lower.includes("runtime error") ||
      lower.includes("memory limit exceeded")
    ) {
      return "REJECTED";
    }
    if (
      lower.includes("evaluating") ||
      lower.includes("running") ||
      lower.includes("compiling") ||
      lower.includes("queued")
    ) {
      return "PENDING";
    }
    return "UNKNOWN";
  }
}
