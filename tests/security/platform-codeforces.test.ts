import { describe, expect, it } from "vitest";
import { CodeforcesAdapter } from "../../src/shared/adapters/codeforces/codeforces-adapter";
import { parseHTML } from "../helpers/mock-dom";

describe("Phase 1C.3 — Codeforces Adapter", () => {
  const adapter = new CodeforcesAdapter();

  it("detects submission on submit button click", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><input type="submit" class="submit" value="Submit"></body></html>`,
    );
    const btn = doc.querySelector("input")!;

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1850/problem/A"),
      event: { type: "click", target: btn } as unknown as Event,
    });

    expect(detection).not.toBeNull();
    expect(detection?.detected).toBe(true);
    expect(detection?.eventType).toBe("submit_click");
  });

  it("detects result mutation with Accepted verdict", async () => {
    const doc = parseHTML(
      `<!DOCTYPE html><html><body><span class="verdict-accepted">Accepted</span></body></html>`,
    );

    const detection = await adapter.detectSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1850/problem/A"),
    });

    expect(detection).not.toBeNull();
    expect(detection?.status).toBe("ACCEPTED");
  });

  it("extracts full canonical submission candidate for contest problem", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement">
            <div class="title">A. To My Critics</div>
          </div>
          <span class="verdict-accepted">Accepted</span>
          <select name="programTypeId">
            <option value="54" selected>GNU G++20 11.2.0 (64 bit, winlibs)</option>
          </select>
          <textarea id="sourceCodeText">#include &lt;bits/stdc++.h&gt;
using namespace std;
int main() { return 0; }</textarea>
          <table>
            <tr data-submission-id="215000001">
              <td>215000001</td>
            </tr>
          </table>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/contest/1850/problem/A"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.platform).toBe("codeforces");
    expect(candidate?.problemId).toBe("1850A");
    expect(candidate?.problemSlug).toBe("1850a");
    expect(candidate?.problemTitle).toBe("To My Critics");
    expect(candidate?.status).toBe("ACCEPTED");
    expect(candidate?.language).toBe("cpp");
    expect(candidate?.submissionId).toBe("215000001");
    expect(candidate?.contestId).toBe("1850");
    expect(candidate?.sourceCode).toContain("#include <bits/stdc++.h>");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate?.problemUrl).toBe(
      "https://codeforces.com/contest/1850/problem/A",
    );
  });

  it("extracts canonical submission for problemset archive URL", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div class="problem-statement"><div class="title">B. Ten Words of Wisdom</div></div>
          <span class="verdict-rejected">Wrong answer on test 3</span>
          <textarea id="sourceCodeText">print("fail")</textarea>
        </body>
      </html>
    `;
    const doc = parseHTML(html);

    const candidate = await adapter.extractSubmission({
      document: doc as unknown as Document,
      window: {} as Window,
      location: new URL("https://codeforces.com/problemset/problem/1850/B"),
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.problemId).toBe("1850B");
    expect(candidate?.status).toBe("REJECTED");
    expect(candidate?.sourceProvenance).toBe("EDITOR_SOURCE");
    expect(candidate?.problemUrl).toBe(
      "https://codeforces.com/problemset/problem/1850/B",
    );
  });
});
