import { describe, expect, it } from "vitest";
import { LeetCodeAdapter } from "../../src/shared/adapters/leetcode/leetcode-adapter";
import { CodeChefAdapter } from "../../src/shared/adapters/codechef/codechef-adapter";
import { CodeforcesAdapter } from "../../src/shared/adapters/codeforces/codeforces-adapter";
import { GeeksforGeeksAdapter } from "../../src/shared/adapters/geeksforgeeks/geeksforgeeks-adapter";
import {
  EXTENSION_AUTHORITY_TOKEN,
  validateCanonicalSubmission,
} from "../../src/shared/adapters/validator";
import { parseHTML } from "../helpers/mock-dom";
import { PlatformAdapterError } from "../../src/shared/errors";
import { MAX_SOURCE_PAYLOAD_BYTES } from "../../src/shared/github/types";

describe("Phase 1C.3 C3.2 / C3.4 — Submitted Source Provenance Boundary", () => {
  const leetcode = new LeetCodeAdapter();
  const codechef = new CodeChefAdapter();
  const codeforces = new CodeforcesAdapter();
  const gfg = new GeeksforGeeksAdapter();

  it("1. Marks provenance as AUTHORITATIVE_SUBMISSION_SOURCE when approved extension-controlled payload is provided", async () => {
    const candidate = await leetcode.extractSubmission({
      document: parseHTML(
        `<!DOCTYPE html><html><body><div data-cy="question-title">Two Sum</div></body></html>`,
      ) as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
      authoritativeSource: {
        code: "int main() { return 42; }",
        authority: "EXTENSION_INTERNAL",
        token: EXTENSION_AUTHORITY_TOKEN,
      },
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("AUTHORITATIVE_SUBMISSION_SOURCE");
    expect(candidate?.sourceCode).toBe("int main() { return 42; }\n");
  });

  it("2. Marks provenance as SUBMISSION_PAGE_SOURCE when extracted from submission detail view", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div data-e2e-locator="submission-result">Accepted</div>
          <div class="submission-detail-code">class SubmittedSolution {}</div>
          <div class="monaco-editor"><div class="view-line">class MutableEditorCode {}</div></div>
        </body>
      </html>
    `;
    const candidate = await leetcode.extractSubmission({
      document: parseHTML(html) as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
    expect(candidate?.sourceCode).toContain("class SubmittedSolution");
    expect(candidate?.sourceCode).not.toContain("MutableEditorCode");
  });

  it("3. Marks provenance as EDITOR_SOURCE when falling back to editor contents", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div class="monaco-editor"><div class="view-line">class InEditorOnly {}</div></div>
        </body>
      </html>
    `;
    const candidate = await leetcode.extractSubmission({
      document: parseHTML(html) as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.sourceCode).toContain("class InEditorOnly");
  });

  it("3b. CodeChef: extracts SUBMISSION_PAGE_SOURCE from viewsolution page", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h1>FLOW001</h1>
          <div class="solution-code">print("solution")</div>
        </body>
      </html>
    `;
    const candidate = await codechef.extractSubmission({
      document: parseHTML(html) as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/viewsolution/123"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
    expect(candidate?.sourceCode).toBe('print("solution")\n');
  });

  it("3c. GeeksforGeeks: marks AUTHORITATIVE_SUBMISSION_SOURCE when provided via approved payload", async () => {
    const candidate = await gfg.extractSubmission({
      document: parseHTML(
        `<!DOCTYPE html><html><body><h3>Problem</h3></body></html>`,
      ) as unknown as Document,
      window: {} as Window,
      location: new URL("https://practice.geeksforgeeks.org/problems/test/1"),
      authoritativeSource: {
        code: "class GFGSolution {}",
        authority: "EXTENSION_INTERNAL",
        token: EXTENSION_AUTHORITY_TOKEN,
      },
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("AUTHORITATIVE_SUBMISSION_SOURCE");
    expect(candidate?.sourceCode).toBe("class GFGSolution {}\n");
  });

  it("4. Invariant: Editor contents are NEVER reported as AUTHORITATIVE_SUBMISSION_SOURCE", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement"><div class="title">A. Problem</div></div>
          <textarea id="sourceCodeText">code in editor</textarea>
        </body>
      </html>
    `;
    const candidate = await codeforces.extractSubmission({
      document: parseHTML(html) as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1000/problem/A"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );
    expect(candidate?.sourceProvenance).not.toBe("SUBMISSION_PAGE_SOURCE");
  });

  it("5. Source provenance survives canonical validation intact", () => {
    const candidate = {
      platform: "leetcode" as const,
      problemId: "two-sum",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      status: "ACCEPTED" as const,
      language: "cpp",
      sourceCode: "int main() {}\n",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "EDITOR_SOURCE" as const,
      extractionConfidence: 0.85,
      extractionLayer: "dom" as const,
    };

    const validated = validateCanonicalSubmission(candidate, "leetcode");
    expect(validated.sourceProvenance).toBe("EDITOR_SOURCE");
  });

  it("6. Missing or invalid source provenance fails closed during canonical validation", () => {
    const invalidCandidate = {
      platform: "leetcode" as const,
      problemId: "two-sum",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      status: "ACCEPTED" as const,
      language: "cpp",
      sourceCode: "int main() {}\n",
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "FABRICATED_CERTAINTY", // Invalid provenance!
      extractionConfidence: 0.85,
      extractionLayer: "dom" as const,
    };

    expect(() =>
      validateCanonicalSubmission(invalidCandidate, "leetcode"),
    ).toThrow(PlatformAdapterError);
  });

  it("7. Source-size and hygiene limits remain enforced regardless of provenance", () => {
    const oversized = {
      platform: "leetcode" as const,
      problemId: "two-sum",
      problemSlug: "two-sum",
      problemTitle: "Two Sum",
      status: "ACCEPTED" as const,
      language: "cpp",
      sourceCode: "a".repeat(MAX_SOURCE_PAYLOAD_BYTES + 5),
      contentHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      submittedAt: Date.now(),
      sourceUrl: "https://leetcode.com/problems/two-sum/",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      sourceProvenance: "AUTHORITATIVE_SUBMISSION_SOURCE" as const,
      extractionConfidence: 1.0,
      extractionLayer: "api" as const,
    };

    expect(() => validateCanonicalSubmission(oversized, "leetcode")).toThrow(
      PlatformAdapterError,
    );
  });

  it("8. Explicit simulation: submitted source = A vs current editor source = B", async () => {
    // Scenario 1: Both A (submitted in page/payload) and B (current editor) exist.
    // CodeSync must prefer A and tag it as authoritative/submission-page.
    const htmlWithBoth = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement"><div class="title">A. Problem</div></div>
          <pre id="program-source-text">Solution_A_Submitted</pre>
          <textarea id="sourceCodeText">Solution_B_Editor_Modified</textarea>
        </body>
      </html>
    `;
    const candidateBoth = await codeforces.extractSubmission({
      document: parseHTML(htmlWithBoth) as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1000/problem/A"),
    });

    expect(candidateBoth).not.toBeNull();
    expect(candidateBoth?.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
    expect(candidateBoth?.sourceCode).toContain("Solution_A_Submitted");
    expect(candidateBoth?.sourceCode).not.toContain(
      "Solution_B_Editor_Modified",
    );

    // Scenario 2: Only B (current editor) exists.
    // CodeSync reports B with EDITOR_SOURCE and NEVER claims it is authoritative.
    const htmlEditorOnly = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement"><div class="title">A. Problem</div></div>
          <textarea id="sourceCodeText">Solution_B_Editor_Modified</textarea>
        </body>
      </html>
    `;
    const candidateEditorOnly = await codeforces.extractSubmission({
      document: parseHTML(htmlEditorOnly) as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1000/problem/A"),
    });

    expect(candidateEditorOnly).not.toBeNull();
    expect(candidateEditorOnly?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidateEditorOnly?.sourceCode).toContain(
      "Solution_B_Editor_Modified",
    );
    expect(candidateEditorOnly?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );
    expect(candidateEditorOnly?.sourceProvenance).not.toBe(
      "SUBMISSION_PAGE_SOURCE",
    );
  });

  it("9. C3.4: Marks provenance as DOM_FALLBACK_SOURCE when extracted from generic fallback container", async () => {
    const htmlFallback = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <pre class="general-code-block">int main() { return fallback; }</pre>
        </body>
      </html>
    `;
    const candidate = await leetcode.extractSubmission({
      document: parseHTML(htmlFallback) as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("DOM_FALLBACK_SOURCE");
    expect(candidate?.sourceCode).toContain("fallback");
  });

  it("10. C3.4: Bare string cannot manufacture AUTHORITATIVE_SUBMISSION_SOURCE (fails closed / falls back safely)", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div class="monaco-editor"><div class="view-line">editor code</div></div>
        </body>
      </html>
    `;
    // Untrusted page attempt: pass bare string as authoritativeSource
    const candidate = await leetcode.extractSubmission({
      document: parseHTML(html) as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
      authoritativeSource: "untrusted_page_string" as unknown as {
        code: string;
        authority: "EXTENSION_INTERNAL";
        token: string;
      },
    });

    expect(candidate).not.toBeNull();
    // Must NOT be AUTHORITATIVE_SUBMISSION_SOURCE
    expect(candidate?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.sourceCode).toContain("editor code");
    expect(candidate?.sourceCode).not.toContain("untrusted_page_string");
  });

  it("11. C3.4: Untrusted page-controlled objects or invalid tokens cannot manufacture AUTHORITATIVE_SUBMISSION_SOURCE", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div class="monaco-editor"><div class="view-line">editor code</div></div>
        </body>
      </html>
    `;
    const pageControlledAttempts = [
      {
        code: "evil_code",
        authority: "PAGE_SCRIPT" as const,
        token: EXTENSION_AUTHORITY_TOKEN,
      },
      {
        code: "evil_code",
        authority: "EXTENSION_INTERNAL" as const,
        token: "FORGED_TOKEN",
      },
      { code: "evil_code", isAuthoritative: true },
      null,
      undefined,
    ];

    for (const attempt of pageControlledAttempts) {
      const candidate = await leetcode.extractSubmission({
        document: parseHTML(html) as unknown as Document,
        window: {} as Window,
        location: new URL("https://leetcode.com/problems/two-sum/"),
        authoritativeSource: attempt as unknown as {
          code: string;
          authority: "EXTENSION_INTERNAL";
          token: string;
        },
      });

      expect(candidate).not.toBeNull();
      expect(candidate?.sourceProvenance).not.toBe(
        "AUTHORITATIVE_SUBMISSION_SOURCE",
      );
      expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
      expect(candidate?.sourceCode).not.toContain("evil_code");
    }
  });

  it("12. C3.4: Cross-platform verification that all adapters reject untrusted page authoritative markers", async () => {
    const cfHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement"><div class="title">A. Problem</div></div>
          <textarea id="sourceCodeText">cf editor code</textarea>
        </body>
      </html>
    `;
    const cfCandidate = await codeforces.extractSubmission({
      document: parseHTML(cfHtml) as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1000/problem/A"),
      authoritativeSource: "tampered_page_string" as unknown as {
        code: string;
        authority: "EXTENSION_INTERNAL";
        token: string;
      },
    });
    expect(cfCandidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(cfCandidate?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );

    const ccHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <h1>FLOW001</h1>
          <textarea name="program">cc editor code</textarea>
        </body>
      </html>
    `;
    const ccCandidate = await codechef.extractSubmission({
      document: parseHTML(ccHtml) as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/submit/FLOW001"),
      authoritativeSource: {
        code: "tampered",
        authority: "UNTRUSTED_PAGE" as unknown as "EXTENSION_INTERNAL",
        token: "bad_token",
      },
    });
    expect(ccCandidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(ccCandidate?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );

    const gfgHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <h3>Problem</h3>
          <div class="ace_line">gfg editor code</div>
        </body>
      </html>
    `;
    const gfgCandidate = await gfg.extractSubmission({
      document: parseHTML(gfgHtml) as unknown as Document,
      window: {} as Window,
      location: new URL("https://practice.geeksforgeeks.org/problems/test/1"),
      authoritativeSource: "tampered" as unknown as {
        code: string;
        authority: "EXTENSION_INTERNAL";
        token: string;
      },
    });
    expect(gfgCandidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(gfgCandidate?.sourceProvenance).not.toBe(
      "AUTHORITATIVE_SUBMISSION_SOURCE",
    );
  });
});
