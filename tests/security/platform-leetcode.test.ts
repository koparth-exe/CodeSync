import { describe, expect, it } from "vitest";
import { LeetCodeAdapter } from "../../src/shared/adapters/leetcode/leetcode-adapter";
import { parseHTML } from "../helpers/mock-dom";

describe("Phase 1C.3 — LeetCode Adapter", () => {
  const adapter = new LeetCodeAdapter();

  it("detects submission event on click of submit button", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><button data-e2e-locator="console-submit-button">Submit</button></body></html>`,
    );
    const submitBtn = doc.querySelector("button")!;

    const event = {
      type: "click",
      target: submitBtn,
    } as unknown as Event;

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
      event,
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.eventType).toBe("submit_click");
    expect(detection?.status).toBe("PENDING");
  });

  it("detects submission result banner mutation with Accepted status", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><div data-e2e-locator="submission-result">Accepted</div></body></html>`,
    );

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.status).toBe("ACCEPTED");
  });

  it("detects submission result banner mutation with Wrong Answer status", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><div data-e2e-locator="submission-result">Wrong Answer</div></body></html>`,
    );

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(detection).not.toBeNull();
    expect(detection?.status).toBe("REJECTED");
  });

  it("extracts full canonical submission candidate successfully", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">1. Two Sum</div>
          <div class="text-difficulty-easy">Easy</div>
          <button id="headlessui-listbox-button-1">C++</button>
          <div data-e2e-locator="submission-result">Accepted</div>
          <div class="monaco-editor">
            <div class="view-line"><span>class Solution {</span></div>
            <div class="view-line"><span>public:</span></div>
            <div class="view-line"><span>    vector&lt;int&gt; twoSum() {}</span></div>
            <div class="view-line"><span>};</span></div>
          </div>
          <a href="/submissions/detail/123456789/">View Details</a>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platform).toBe("leetcode");
    expect(candidate?.problemId).toBe("two-sum");
    expect(candidate?.problemSlug).toBe("two-sum");
    expect(candidate?.problemTitle).toBe("Two Sum");
    expect(candidate?.status).toBe("ACCEPTED");
    expect(candidate?.language).toBe("cpp");
    expect(candidate?.difficulty).toBe("Easy");
    expect(candidate?.submissionId).toBe("123456789");
    expect(candidate?.sourceCode).toContain("class Solution {");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate?.problemUrl).toBe(
      "https://leetcode.com/problems/two-sum/",
    );
  });

  it("extracts source code from textarea fallback when monaco view-lines are absent", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div data-e2e-locator="submission-result">Accepted</div>
          <textarea data-cy="code-editor">print("Hello World")</textarea>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.sourceCode).toBe('print("Hello World")\n');
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
  });

  it("fails safely and returns null when source code cannot be found", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div data-cy="question-title">Two Sum</div>
          <div data-e2e-locator="submission-result">Accepted</div>
          <!-- No code editor found -->
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://leetcode.com/problems/two-sum/"),
    });

    expect(candidate).toBeNull();
  });
});
