import { describe, expect, it } from "vitest";
import {
  LeetCodeAdapter,
  CodeChefAdapter,
  CodeforcesAdapter,
  GeeksforGeeksAdapter,
} from "../../src/shared/adapters";
import { validatePlatformOrigin } from "../../src/shared/adapters/validator";

describe("Phase 1C.3 — Platform Origin Security & Adversarial Matching", () => {
  const leetcode = new LeetCodeAdapter();
  const codechef = new CodeChefAdapter();
  const codeforces = new CodeforcesAdapter();
  const gfg = new GeeksforGeeksAdapter();

  describe("LeetCode Origin Security", () => {
    it("accepts authentic LeetCode origins and paths", () => {
      expect(leetcode.canHandle("https://leetcode.com/problems/two-sum/")).toBe(
        true,
      );
      expect(
        leetcode.canHandle("https://www.leetcode.com/problems/two-sum/"),
      ).toBe(true);
    });

    it("rejects non-problem LeetCode paths", () => {
      expect(leetcode.canHandle("https://leetcode.com/discuss/")).toBe(false);
      expect(leetcode.canHandle("https://leetcode.com/explore/")).toBe(false);
    });

    it("rejects lookalike, suffix, and prefix domains fail-closed", () => {
      const malicious = [
        "https://leetcode.com.evil.test/problems/two-sum",
        "https://evil-leetcode.com/problems/two-sum",
        "https://leetcode.evil.tld/problems/two-sum",
        "https://leetcode.example.com/problems/two-sum",
        "https://sub.leetcode.com.attacker.com/problems/two-sum",
        "https://my-leetcode.com/problems/two-sum",
      ];
      for (const url of malicious) {
        expect(leetcode.canHandle(url)).toBe(false);
      }
    });

    it("rejects insecure HTTP scheme, ports, and credentials", () => {
      expect(leetcode.canHandle("http://leetcode.com/problems/two-sum/")).toBe(
        false,
      );
      expect(
        leetcode.canHandle("https://leetcode.com:8080/problems/two-sum/"),
      ).toBe(false);
      expect(
        leetcode.canHandle(
          "https://attacker:pass@leetcode.com/problems/two-sum/",
        ),
      ).toBe(false);
    });
  });

  describe("CodeChef Origin Security", () => {
    it("accepts authentic CodeChef origins and paths", () => {
      expect(
        codechef.canHandle("https://www.codechef.com/problems/FLOW001"),
      ).toBe(true);
      expect(codechef.canHandle("https://codechef.com/submit/FLOW001")).toBe(
        true,
      );
    });

    it("rejects lookalike and attacker domains", () => {
      const malicious = [
        "https://codechef.com.evil.test/problems/FLOW001",
        "https://evil-codechef.com/problems/FLOW001",
        "https://codechef.evil.io/problems/FLOW001",
        "https://codechef.example.com/problems/FLOW001",
      ];
      for (const url of malicious) {
        expect(codechef.canHandle(url)).toBe(false);
      }
    });

    it("rejects insecure schemes and non-standard ports", () => {
      expect(
        codechef.canHandle("http://www.codechef.com/problems/FLOW001"),
      ).toBe(false);
      expect(
        codechef.canHandle("https://www.codechef.com:8443/problems/FLOW001"),
      ).toBe(false);
    });
  });

  describe("Codeforces Origin Security", () => {
    it("accepts authentic Codeforces origins and mirror domains", () => {
      expect(
        codeforces.canHandle(
          "https://codeforces.com/problemset/problem/1850/A",
        ),
      ).toBe(true);
      expect(
        codeforces.canHandle(
          "https://www.codeforces.com/contest/1850/problem/A",
        ),
      ).toBe(true);
      expect(
        codeforces.canHandle("https://codeforces.net/contest/1850/problem/A"),
      ).toBe(true);
      expect(
        codeforces.canHandle(
          "https://www.codeforces.net/contest/1850/problem/A",
        ),
      ).toBe(true);
    });

    it("rejects unsupported subdomains and mirrors (m1/m2/m3)", () => {
      expect(
        codeforces.canHandle(
          "https://m1.codeforces.com/contest/1850/problem/A",
        ),
      ).toBe(false);
      expect(
        codeforces.canHandle(
          "https://m2.codeforces.com/contest/1850/problem/A",
        ),
      ).toBe(false);
      expect(
        codeforces.canHandle(
          "https://m3.codeforces.com/contest/1850/problem/A",
        ),
      ).toBe(false);
    });

    it("rejects lookalike and unauthorized domains", () => {
      const malicious = [
        "https://codeforces.com.evil.test/contest/1/problem/A",
        "https://evil-codeforces.com/contest/1/problem/A",
        "https://codeforces.org.evil.test/contest/1/problem/A",
        "https://codeforces.example.com/contest/1/problem/A",
      ];
      for (const url of malicious) {
        expect(codeforces.canHandle(url)).toBe(false);
      }
    });

    it("rejects HTTP and credential injection", () => {
      expect(
        codeforces.canHandle("http://codeforces.com/contest/1850/problem/A"),
      ).toBe(false);
      expect(
        codeforces.canHandle(
          "https://user:pass@codeforces.com/contest/1850/problem/A",
        ),
      ).toBe(false);
    });
  });

  describe("GeeksforGeeks Origin Security", () => {
    it("accepts authentic GeeksforGeeks origins and problem paths", () => {
      expect(
        gfg.canHandle("https://practice.geeksforgeeks.org/problems/two-sum/1"),
      ).toBe(true);
      expect(
        gfg.canHandle("https://www.geeksforgeeks.org/problems/two-sum/"),
      ).toBe(true);
    });

    it("rejects lookalike and attacker domains", () => {
      const malicious = [
        "https://practice.geeksforgeeks.org.evil.test/problems/two-sum",
        "https://evil-geeksforgeeks.com/problems/two-sum",
        "https://geeksforgeeks.evil.io/problems/two-sum",
        "https://geeksforgeeks.example.com/problems/two-sum",
      ];
      for (const url of malicious) {
        expect(gfg.canHandle(url)).toBe(false);
      }
    });

    it("rejects HTTP and malformed URLs", () => {
      expect(
        gfg.canHandle("http://practice.geeksforgeeks.org/problems/two-sum"),
      ).toBe(false);
      expect(gfg.canHandle("not-a-valid-url")).toBe(false);
    });
  });

  describe("Direct validatePlatformOrigin unit tests", () => {
    it("handles edge cases and returns false on malformed input", () => {
      expect(validatePlatformOrigin("", ["https://leetcode.com"])).toBe(false);
      expect(
        validatePlatformOrigin("javascript:alert(1)", ["https://leetcode.com"]),
      ).toBe(false);
      expect(
        validatePlatformOrigin("data:text/html,<html></html>", [
          "https://leetcode.com",
        ]),
      ).toBe(false);
    });
  });
});
