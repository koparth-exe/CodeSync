import { describe, expect, it } from "vitest";
import { GeeksforGeeksAdapter } from "../../src/shared/adapters/geeksforgeeks/geeksforgeeks-adapter";
import { parseHTML } from "../helpers/mock-dom";

describe("Phase 1C.3 — GeeksforGeeks Adapter", () => {
  const adapter = new GeeksforGeeksAdapter();

  it("detects submission on submit button click", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><button class="problems_submit_button__">Submit</button></body></html>`,
    );
    const btn = doc.querySelector("button")!;

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL(
        "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
      ),
      event: { type: "click", target: btn } as unknown as Event,
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.eventType).toBe("submit_click");
  });

  it("detects result mutation with Problem Solved Successfully", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><div class="problems_content__">Problem Solved Successfully</div></body></html>`,
    );

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL(
        "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
      ),
    });

    expect(detection).not.toBeNull();
    expect(detection?.status).toBe("ACCEPTED");
  });

  it("extracts full canonical submission candidate successfully", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h3 class="problem-title">Subarray with given sum</h3>
          <span class="difficulty">Medium</span>
          <div class="problems_content__">Problem Solved Successfully</div>
          <button class="language-btn">Java</button>
          <div class="ace_line">class Solution {</div>
          <div class="ace_line">    static ArrayList&lt;Integer&gt; subarraySum() {}</div>
          <div class="ace_line">}</div>
          <div data-submission-id="555444333"></div>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL(
        "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
      ),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platform).toBe("geeksforgeeks");
    expect(candidate?.problemId).toBe("subarray-with-given-sum");
    expect(candidate?.problemSlug).toBe("subarray-with-given-sum");
    expect(candidate?.problemTitle).toBe("Subarray with given sum");
    expect(candidate?.status).toBe("ACCEPTED");
    expect(candidate?.language).toBe("java");
    expect(candidate?.difficulty).toBe("Medium");
    expect(candidate?.submissionId).toBe("555444333");
    expect(candidate?.sourceCode).toContain("class Solution {");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate?.problemUrl).toBe(
      "https://www.geeksforgeeks.org/problems/subarray-with-given-sum/1",
    );
  });

  it("C3.1: detects submit button click via textContent using standards-compliant DOM logic", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><button class="ui-button-primary">Submit</button></body></html>`,
    );
    const btn = doc.querySelector("button")!;

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL(
        "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
      ),
      event: { type: "click", target: btn } as unknown as Event,
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.eventType).toBe("submit_click");
  });

  it("C3.2: extracts submission page source with SUBMISSION_PAGE_SOURCE provenance", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h3 class="problem-title">Subarray with given sum</h3>
          <div class="problems_content__">Problem Solved Successfully</div>
          <pre class="submission_code">class AuthoritativeSolution {}</pre>
          <div class="ace_line">class StaleEditorSolution {}</div>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL(
        "https://practice.geeksforgeeks.org/problems/subarray-with-given-sum/1",
      ),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceProvenance).toBe("SUBMISSION_PAGE_SOURCE");
    expect(candidate?.sourceCode).toContain("class AuthoritativeSolution");
    expect(candidate?.sourceCode).not.toContain("StaleEditorSolution");
  });

  it("handles Wrong Answer status properly", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problems_content__">Wrong Answer</div>
          <textarea>code</textarea>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://practice.geeksforgeeks.org/problems/test/1"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.status).toBe("REJECTED");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
  });
});
