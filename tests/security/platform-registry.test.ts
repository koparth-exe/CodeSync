import { describe, expect, it, beforeEach } from "vitest";
import {
  PlatformAdapterRegistry,
  createDefaultRegistry,
  LeetCodeAdapter,
  CodeChefAdapter,
} from "../../src/shared/adapters";
import { ErrorCode, PlatformAdapterError } from "../../src/shared/errors";
import type { PlatformAdapter } from "../../src/shared/adapters/types";

describe("Phase 1C.3 — Platform Adapter Registry", () => {
  let registry: PlatformAdapterRegistry;

  beforeEach(() => {
    registry = new PlatformAdapterRegistry();
  });

  it("registers valid platform adapters and resolves them by URL", () => {
    const leetcode = new LeetCodeAdapter();
    registry.register(leetcode);

    expect(registry.get("leetcode")).toBe(leetcode);
    expect(registry.getAll().length).toBe(1);

    const resolved = registry.resolve("https://leetcode.com/problems/two-sum/");
    expect(resolved).toBe(leetcode);
  });

  it("createDefaultRegistry registers all 4 approved platforms", () => {
    const defaultReg = createDefaultRegistry();
    const all = defaultReg.getAll();
    expect(all.length).toBe(4);

    const ids = all.map((a) => a.id);
    expect(ids).toContain("leetcode");
    expect(ids).toContain("codechef");
    expect(ids).toContain("codeforces");
    expect(ids).toContain("geeksforgeeks");
  });

  it("rejects duplicate adapter registrations fail-closed", () => {
    const leetcode1 = new LeetCodeAdapter();
    const leetcode2 = new LeetCodeAdapter();

    registry.register(leetcode1);

    expect(() => registry.register(leetcode2)).toThrow(PlatformAdapterError);
    try {
      registry.register(leetcode2);
    } catch (err) {
      const e = err as PlatformAdapterError;
      expect(e.code).toBe(ErrorCode.ADAPTER_ALREADY_REGISTERED);
    }
  });

  it("rejects malformed adapter with invalid or missing platform id", () => {
    const malformed = {
      id: "unsupported_platform",
      name: "Bad",
      supportedOrigins: ["https://bad.com"],
      canHandle: () => true,
      detectSubmission: async () => null,
      extractSubmission: async () => null,
    } as unknown as PlatformAdapter;

    expect(() => registry.register(malformed)).toThrow(PlatformAdapterError);
  });

  it("rejects malformed adapter with missing name or empty supportedOrigins", () => {
    const malformedOrigins = {
      id: "leetcode",
      name: "LeetCode",
      supportedOrigins: [],
      canHandle: () => true,
      detectSubmission: async () => null,
      extractSubmission: async () => null,
    } as unknown as PlatformAdapter;

    expect(() => registry.register(malformedOrigins)).toThrow(
      PlatformAdapterError,
    );

    const malformedName = {
      id: "leetcode",
      name: "",
      supportedOrigins: ["https://leetcode.com"],
      canHandle: () => true,
      detectSubmission: async () => null,
      extractSubmission: async () => null,
    } as unknown as PlatformAdapter;

    expect(() => registry.register(malformedName)).toThrow(
      PlatformAdapterError,
    );
  });

  it("rejects malformed adapter missing required interface methods", () => {
    const missingMethods = {
      id: "leetcode",
      name: "LeetCode",
      supportedOrigins: ["https://leetcode.com"],
      canHandle: () => true,
      // detectSubmission missing
      extractSubmission: async () => null,
    } as unknown as PlatformAdapter;

    expect(() => registry.register(missingMethods)).toThrow(
      PlatformAdapterError,
    );
  });

  it("returns null when resolving unsupported or unknown origin", () => {
    registry.register(new LeetCodeAdapter());
    registry.register(new CodeChefAdapter());

    expect(
      registry.resolve("https://hackerrank.com/challenges/simple"),
    ).toBeNull();
    expect(registry.resolve("https://example.com")).toBeNull();
    expect(registry.resolve("invalid-url")).toBeNull();
  });
});
