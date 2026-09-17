import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  LeetCodeAdapter,
  CodeChefAdapter,
  CodeforcesAdapter,
  GeeksforGeeksAdapter,
} from "../../src/shared/adapters";

describe("Phase 1C.3 — Cross-Platform Isolation", () => {
  const leetcode = new LeetCodeAdapter();
  const codechef = new CodeChefAdapter();
  const codeforces = new CodeforcesAdapter();
  const gfg = new GeeksforGeeksAdapter();

  const registry = createDefaultRegistry();

  const testUrls = {
    leetcode: "https://leetcode.com/problems/two-sum/",
    codechef: "https://www.codechef.com/problems/FLOW001",
    codeforces: "https://codeforces.com/contest/1850/problem/A",
    geeksforgeeks: "https://practice.geeksforgeeks.org/problems/two-sum/1",
  };

  it("LeetCode adapter activates exclusively on LeetCode URLs", () => {
    expect(leetcode.canHandle(testUrls.leetcode)).toBe(true);
    expect(leetcode.canHandle(testUrls.codechef)).toBe(false);
    expect(leetcode.canHandle(testUrls.codeforces)).toBe(false);
    expect(leetcode.canHandle(testUrls.geeksforgeeks)).toBe(false);
  });

  it("CodeChef adapter activates exclusively on CodeChef URLs", () => {
    expect(codechef.canHandle(testUrls.codechef)).toBe(true);
    expect(codechef.canHandle(testUrls.leetcode)).toBe(false);
    expect(codechef.canHandle(testUrls.codeforces)).toBe(false);
    expect(codechef.canHandle(testUrls.geeksforgeeks)).toBe(false);
  });

  it("Codeforces adapter activates exclusively on Codeforces URLs", () => {
    expect(codeforces.canHandle(testUrls.codeforces)).toBe(true);
    expect(codeforces.canHandle(testUrls.leetcode)).toBe(false);
    expect(codeforces.canHandle(testUrls.codechef)).toBe(false);
    expect(codeforces.canHandle(testUrls.geeksforgeeks)).toBe(false);
  });

  it("GeeksforGeeks adapter activates exclusively on GeeksforGeeks URLs", () => {
    expect(gfg.canHandle(testUrls.geeksforgeeks)).toBe(true);
    expect(gfg.canHandle(testUrls.leetcode)).toBe(false);
    expect(gfg.canHandle(testUrls.codechef)).toBe(false);
    expect(gfg.canHandle(testUrls.codeforces)).toBe(false);
  });

  it("Registry strictly resolves the correct adapter for each platform URL", () => {
    expect(registry.resolve(testUrls.leetcode)?.id).toBe("leetcode");
    expect(registry.resolve(testUrls.codechef)?.id).toBe("codechef");
    expect(registry.resolve(testUrls.codeforces)?.id).toBe("codeforces");
    expect(registry.resolve(testUrls.geeksforgeeks)?.id).toBe("geeksforgeeks");
  });
});
