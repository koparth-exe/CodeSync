/**
 * Codeforces Platform Adapter (Phase 1C.3)
 *
 * Implements detection, extraction, and normalization for Codeforces (codeforces.com / codeforces.net).
 * Handles contest problems, problemset archives, and gym problems safely.
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

export class CodeforcesAdapter extends BasePlatformAdapter {
  readonly id: PlatformId = "codeforces";
  readonly name = "Codeforces";
  readonly supportedOrigins: readonly string[] = [
    "https://codeforces.com",
    "https://www.codeforces.com",
    "https://codeforces.net",
    "https://www.codeforces.net",
  ];

  /**
   * Validates if this adapter can handle the given Codeforces URL.
   */
  override canHandle(url: URL | string): boolean {
    if (!super.canHandle(url)) return false;
    try {
      const parsed = typeof url === "string" ? new URL(url) : url;
      return (
        parsed.pathname.includes("/contest/") ||
        parsed.pathname.includes("/problemset/") ||
        parsed.pathname.includes("/gym/") ||
        parsed.pathname.includes("/submission/")
      );
    } catch {
      return false;
    }
  }

  /**
   * Detects submission events on Codeforces pages.
   */
  async detectSubmission(
    context: DetectorContext,
  ): Promise<DetectionResult | null> {
    const doc = context.document;
    if (!doc) return null;

    // Check for verdict span changes
    const verdictElem = doc.querySelector(
      "span.verdict-accepted, span.verdict-rejected, span[class*='verdict-'], [class*='verdict_waiting']",
    );
    if (verdictElem) {
      const text = verdictElem.textContent?.trim() ?? "";
      const status = this.mapStatus(text);
      return {
        detected: true,
        eventType: "result_mutation",
        status,
        timestamp: Date.now(),
      };
    }

    // Check for submit button click
    if (context.event?.type === "click") {
      const target = context.event.target as Element | null;
      const submitBtn = target?.closest(
        'input[type="submit"].submit, input[type="submit"], button[type="submit"], input.submit',
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
   * Extracts canonical submission candidate from Codeforces DOM / page state.
   */
  async extractSubmission(
    context: ExtractionContext,
  ): Promise<CanonicalSubmissionCandidate | null> {
    const doc = context.document;
    const loc = context.location;
    const urlStr = loc.toString();

    const problemInfo = this.extractProblemInfo(urlStr, doc);
    if (!problemInfo) return null;

    const { problemId, title, contestId } = problemInfo;
    const problemSlug = sanitizeSlug(problemId);

    const verdictElem = doc?.querySelector(
      "span.verdict-accepted, span.verdict-rejected, span[class*='verdict-']",
    );
    const statusText = verdictElem?.textContent?.trim() ?? "";
    const status = context.detection?.status ?? this.mapStatus(statusText);

    const language = this.extractLanguage(doc) || "cpp";

    const extracted = this.extractSource(context);
    if (!extracted || !extracted.source.trim()) {
      return null;
    }

    const normalizedCode = this.normalizeSource(extracted.source);
    const contentHash = await this.computeHash(normalizedCode);
    const sourceProvenance = extracted.provenance;

    const submissionId = this.extractSubmissionId(doc);

    const candidate: CanonicalSubmissionCandidate = {
      platform: "codeforces",
      problemId,
      problemSlug,
      problemTitle: title,
      status,
      language,
      sourceCode: normalizedCode,
      contentHash,
      submittedAt: context.detection?.timestamp ?? Date.now(),
      sourceUrl: urlStr,
      problemUrl: problemInfo.canonicalUrl || urlStr,
      sourceProvenance,
      submissionId,
      contestId,
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

  private extractProblemInfo(
    urlStr: string,
    doc?: Document,
  ): {
    problemId: string;
    title: string;
    contestId?: string;
    canonicalUrl?: string;
  } | null {
    try {
      const parsed = new URL(urlStr);
      // /contest/:contestId/problem/:index or /problemset/problem/:contestId/:index
      const contestMatch = parsed.pathname.match(
        /\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)/,
      );
      if (contestMatch && contestMatch[1] && contestMatch[2]) {
        const contestId = contestMatch[1];
        const index = contestMatch[2].toUpperCase();
        const problemId = `${contestId}${index}`;
        const title = this.extractTitle(doc) || `Problem ${problemId}`;
        return {
          problemId,
          title,
          contestId,
          canonicalUrl: `https://codeforces.com/contest/${contestId}/problem/${index}`,
        };
      }

      const problemsetMatch = parsed.pathname.match(
        /\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/,
      );
      if (problemsetMatch && problemsetMatch[1] && problemsetMatch[2]) {
        const contestId = problemsetMatch[1];
        const index = problemsetMatch[2].toUpperCase();
        const problemId = `${contestId}${index}`;
        const title = this.extractTitle(doc) || `Problem ${problemId}`;
        return {
          problemId,
          title,
          contestId,
          canonicalUrl: `https://codeforces.com/problemset/problem/${contestId}/${index}`,
        };
      }
    } catch {
      // Ignore
    }

    const titleElem = doc?.querySelector(".problem-statement .title");
    if (titleElem && titleElem.textContent?.trim()) {
      const text = titleElem.textContent.trim();
      const match = text.match(/^([A-Za-z0-9]+)\.\s*(.+)/);
      if (match && match[1] && match[2]) {
        return {
          problemId: match[1],
          title: match[2].trim(),
        };
      }
    }

    return null;
  }

  private extractTitle(doc?: Document): string | null {
    if (!doc) return null;
    const titleElem = doc.querySelector(".problem-statement .title, h3.title");
    if (titleElem && titleElem.textContent?.trim()) {
      return titleElem.textContent.trim().replace(/^[A-Za-z0-9]+\.\s*/, "");
    }
    return null;
  }

  private extractLanguage(doc?: Document): string {
    if (!doc) return "cpp";
    const select = doc.querySelector('select[name="programTypeId"]');
    if (select && "selectedOptions" in select) {
      const selected = (select as HTMLSelectElement).selectedOptions[0];
      const text = (selected?.textContent ?? "").toLowerCase();
      if (text.includes("c++") || text.includes("gnu g++")) return "cpp";
      if (text.includes("java")) return "java";
      if (text.includes("python") || text.includes("pypy")) return "python";
      if (text.includes("rust")) return "rust";
      if (text.includes("go")) return "go";
      if (text.includes("kotlin")) return "kotlin";
      return text.split(" ")[0] || "cpp";
    }
    return "cpp";
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

    // 2. Submission source view popup / page
    const submissionElem = doc.querySelector(
      '#program-source-text, pre.prettyprint.program-source, [class*="submission-program"]',
    );
    if (submissionElem && submissionElem.textContent?.trim()) {
      return {
        source: submissionElem.textContent.trim(),
        provenance: "SUBMISSION_PAGE_SOURCE",
      };
    }

    // 3. Editor / submit form source
    const textarea = doc.querySelector(
      'textarea#sourceCodeText, textarea[name="source"]',
    );
    if (textarea) {
      const val = (
        (textarea as HTMLTextAreaElement).value ||
        textarea.textContent ||
        ""
      ).trim();
      if (val) return { source: val, provenance: "EDITOR_SOURCE" };
    }

    const aceLines = doc.querySelectorAll(".ace_line");
    if (aceLines.length > 0) {
      const code = Array.from(aceLines)
        .map((l) => l.textContent ?? "")
        .join("\n")
        .trim();
      if (code) return { source: code, provenance: "EDITOR_SOURCE" };
    }

    // 4. Fallback pre / code block
    const fallback = doc.querySelector("pre.prettyprint, pre code, pre");
    if (fallback && fallback.textContent?.trim()) {
      return {
        source: fallback.textContent.trim(),
        provenance: "DOM_FALLBACK_SOURCE",
      };
    }

    return null;
  }

  private extractSubmissionId(doc?: Document): string | undefined {
    if (!doc) return undefined;
    const row = doc.querySelector("tr[data-submission-id]");
    if (row) {
      const id = row.getAttribute("data-submission-id");
      if (id && id.trim()) return id.trim();
    }

    const subLink = doc.querySelector('a[href*="/submission/"]');
    if (subLink) {
      const href = subLink.getAttribute("href") ?? "";
      const match = href.match(/\/submission\/(\d+)/);
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
      lower.includes("memory limit exceeded") ||
      lower.includes("compilation error") ||
      lower.includes("denied") ||
      lower.includes("failed")
    ) {
      return "REJECTED";
    }
    if (
      lower.includes("in queue") ||
      lower.includes("running") ||
      lower.includes("judging") ||
      lower.includes("compiling")
    ) {
      return "PENDING";
    }
    return "UNKNOWN";
  }
}
