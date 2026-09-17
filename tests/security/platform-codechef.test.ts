import { describe, expect, it } from "vitest";
import { CodeChefAdapter } from "../../src/shared/adapters/codechef/codechef-adapter";
import { parseHTML } from "../helpers/mock-dom";

describe("Phase 1C.3 — CodeChef Adapter", () => {
  const adapter = new CodeChefAdapter();

  it("detects submission event on click of submit button", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><button id="edit-submit">Submit</button></body></html>`,
    );
    const btn = doc.querySelector("button")!;

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/problems/FLOW001"),
      event: { type: "click", target: btn } as unknown as Event,
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.eventType).toBe("submit_click");
  });

  it("detects result mutation with Correct Answer status", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><div class="status-container">Correct Answer</div></body></html>`,
    );

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/problems/FLOW001"),
    });

    expect(detection).not.toBeNull();
    expect(detection?.status).toBe("ACCEPTED");
  });

  it("extracts full canonical submission candidate successfully", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <h1 class="problem-title">Add Two Numbers (FLOW001)</h1>
          <div class="status-container">Correct Answer</div>
          <select id="edit-language">
            <option value="C++17" selected>C++17</option>
          </select>
          <textarea name="program">#include &lt;iostream&gt;
int main() { return 0; }</textarea>
          <a href="/viewsolution/987654321">Solution</a>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/problems/FLOW001"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platform).toBe("codechef");
    expect(candidate?.problemId).toBe("FLOW001");
    expect(candidate?.problemSlug).toBe("flow001");
    expect(candidate?.status).toBe("ACCEPTED");
    expect(candidate?.language).toBe("cpp");
    expect(candidate?.submissionId).toBe("987654321");
    expect(candidate?.sourceCode).toContain("#include <iostream>");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate?.problemUrl).toBe(
      "https://www.codechef.com/problems/FLOW001",
    );
  });

  it("handles Wrong Answer status properly", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="status-container">Wrong Answer</div>
          <textarea name="program">code</textarea>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://www.codechef.com/problems/TEST"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.status).toBe("REJECTED");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
  });
});
