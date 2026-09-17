/**
 * CodeChef Platform Adapter (Phase 1C.3)
 *
 * Implements detection, extraction, and normalization for CodeChef (codechef.com).
 * Safely parses dynamic problem and submission pages.
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

export class CodeChefAdapter extends BasePlatformAdapter {
  readonly id: PlatformId = "codechef";
  readonly name = "CodeChef";
  readonly supportedOrigins: readonly string[] = [
    "https://www.codechef.com",
    "https://codechef.com",
  ];

  /**
   * Validates if this adapter can handle the specified CodeChef URL.
   */
  override canHandle(url: URL | string): boolean {
    if (!super.canHandle(url)) return false;
    try {
      const parsed = typeof url === "string" ? new URL(url) : url;
      return (
        parsed.pathname.includes("/problems/") ||
        parsed.pathname.includes("/submit/") ||
        parsed.pathname.includes("/viewsolution/")
      );
    } catch {
      return false;
    }
  }

  /**
   * Detects submission events on CodeChef pages.
   */
  async detectSubmission(
    context: DetectorContext,
  ): Promise<DetectionResult | null> {
    const doc = context.document;
    if (!doc) return null;

    // Check for submission status banner mutations
    const statusElem = doc.querySelector(
      '.status-container, [class*="verdict-"], div[class*="submission-status"], [class*="status-text"]',
    );
    if (statusElem) {
      const text = statusElem.textContent?.trim() ?? "";
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
        'button[id*="submit"], #edit-submit, button[class*="submit"], input[type="submit"]',
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
   * Extracts canonical submission candidate from CodeChef DOM / page state.
   */
  async extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null> {
    const doc = context.document;
    const loc = context.location;
    const urlStr = loc.toString();

    const problemCode = this.extractProblemCode(urlStr, doc);
    if (!problemCode) return null;

    const problemSlug = sanitizeSlug(problemCode);
    const problemTitle = this.extractProblemTitle(doc) || problemCode;

    const statusText =
      doc
        ?.querySelector(
          '.status-container, [class*="verdict-"], div[class*="submission-status"], [class*="status-text"]',
        )
        ?.textContent?.trim() ?? "";
    const status = context.detection?.status ?? this.mapStatus(statusText);

    const language = this.extractLanguage(doc) || "cpp";

    const extracted = this.extractSource(context);
    if (!extracted || !extracted.source.trim()) {
      return null;
    }

    const normalizedCode = this.normalizeSource(extracted.source);
    const contentHash = await this.computeHash(normalizedCode);
    const sourceProvenance = extracted.provenance;

    const submissionId = this.extractSubmissionId(urlStr, doc);

    const candidate: CanonicalSubmissionCandidate = {
      platform: "codechef",
      problemId: problemCode,
      problemSlug,
      problemTitle,
      status,
      language,
      sourceCode: normalizedCode,
      contentHash,
      submittedAt: context.detection?.timestamp ?? Date.now(),
      sourceUrl: urlStr,
      problemUrl: `https://www.codechef.com/problems/${problemCode}`,
      sourceProvenance,
      submissionId,
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

  private extractProblemCode(urlStr: string, doc?: Document): string | null {
    try {
      const parsed = new URL(urlStr);
      // Matches /problems/:code or /submit/:code
      const match = parsed.pathname.match(/\/(?:problems|submit)\/([^/]+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {
      // Ignore
    }

    const headingElem = doc?.querySelector(
      "h1, .breadcrumbs a:last-child, [class*='problem-code']",
    );
    if (headingElem && headingElem.textContent?.trim()) {
      const text = headingElem.textContent.trim();
      const codeMatch = text.match(/\b([A-Z0-9_]{3,15})\b/);
      if (codeMatch && codeMatch[1]) {
        return codeMatch[1];
      }
    }

    return null;
  }

  private extractProblemTitle(doc?: Document): string | null {
    if (!doc) return null;
    const titleElem = doc.querySelector(
      "h1, .problem-title, div[class*='problem-description'] h2",
    );
    if (titleElem && titleElem.textContent?.trim()) {
      return titleElem.textContent.trim();
    }
    return null;
  }

  private extractLanguage(doc?: Document): string {
    if (!doc) return "cpp";
    const langSelect = doc.querySelector(
      'select[id*="language"], select[class*="language"], [data-cy="language-selector"], div[class*="select-language"]',
    );
    const text =
      (langSelect && "value" in langSelect
        ? (langSelect as HTMLSelectElement).value
        : langSelect?.textContent) ?? "";
    const lower = text.toLowerCase();
    if (lower.includes("c++") || lower.includes("cpp")) return "cpp";
    if (lower.includes("java")) return "java";
    if (lower.includes("python") || lower.includes("pyth")) return "python";
    if (lower.includes("c#")) return "csharp";
    if (lower.includes("javascript") || lower.includes("node"))
      return "javascript";
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

    // 2. Submission solution page / modal code
    const solutionElem = doc.querySelector(
      '.solution-code, #program-code, pre#solution, [class*="solution-content"], pre.prettyprint',
    );
    if (solutionElem && solutionElem.textContent?.trim()) {
      return {
        source: solutionElem.textContent.trim(),
        provenance: "SUBMISSION_PAGE_SOURCE",
      };
    }

    // 3. Editor source (Monaco / Ace lines or program textarea)
    const lines = doc.querySelectorAll(
      ".monaco-editor .view-line, .ace_line, textarea[name='program'], #edit-program",
    );
    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine && firstLine.tagName.toLowerCase() === "textarea") {
        const val = (firstLine as HTMLTextAreaElement).value.trim();
        if (val) return { source: val, provenance: "EDITOR_SOURCE" };
      }
      const code = Array.from(lines)
        .map((l) => l.textContent ?? "")
        .join("\n")
        .trim();
      if (code) return { source: code, provenance: "EDITOR_SOURCE" };
    }

    // 4. Fallback editor/pre element
    const editorElem = doc.querySelector("textarea, pre code");
    if (editorElem) {
      const val = (
        (editorElem as HTMLTextAreaElement).value ||
        editorElem.textContent ||
        ""
      ).trim();
      if (val) return { source: val, provenance: "DOM_FALLBACK_SOURCE" };
    }

    return null;
  }

  private extractSubmissionId(
    urlStr: string,
    doc?: Document,
  ): string | undefined {
    try {
      const match = urlStr.match(/\/viewsolution\/(\d+)/);
      if (match && match[1]) return match[1];
    } catch {
      // Ignore
    }

    const solLink = doc?.querySelector('a[href*="/viewsolution/"]');
    if (solLink) {
      const href = solLink.getAttribute("href") ?? "";
      const match = href.match(/\/viewsolution\/(\d+)/);
      if (match && match[1]) return match[1];
    }
    return undefined;
  }

  private mapStatus(rawText: string): CanonicalSubmissionStatus {
    const lower = rawText.toLowerCase();
    if (
      lower.includes("correct answer") ||
      lower.includes("100 pts") ||
      lower.includes("100/100") ||
      lower.includes("accepted")
    ) {
      return "ACCEPTED";
    }
    if (
      lower.includes("wrong answer") ||
      lower.includes("time limit exceeded") ||
      lower.includes("compilation error") ||
      lower.includes("runtime error") ||
      lower.includes("partially correct")
    ) {
      return "REJECTED";
    }
    if (
      lower.includes("running") ||
      lower.includes("judging") ||
      lower.includes("in queue")
    ) {
      return "PENDING";
    }
    return "UNKNOWN";
  }
}
