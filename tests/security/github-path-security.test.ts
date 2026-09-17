import { describe, expect, it } from "vitest";
import {
  formatSafeCommitMessage,
  resolvePathTemplate,
  validateAndCanonicalizePath,
  validateBaseFolder,
  MAX_TOTAL_PATH_LENGTH,
} from "../../src/shared/github/path-engine";
import {
  ErrorCode,
  PathSecurityError,
  PathTemplateError,
} from "../../src/shared/errors";
import type { PathTemplateVariables } from "../../src/shared/github/types";

describe("GitHub Path Security & Template Engine (Phase 1C.2)", () => {
  // Sample valid variables
  const validVariables: PathTemplateVariables = {
    platform: "LeetCode",
    platform_lower: "leetcode",
    slug: "two-sum",
    title: "Two-Sum",
    problem_id: "1",
    language: "CPP",
    language_lower: "cpp",
    extension: "cpp",
    difficulty: "Easy",
    rating: "800",
    contest_id: "weekly-1",
    problem_code: "1",
    division: "div1",
    status: "Accepted",
    date: "2026-09-13",
    timestamp: "1789300000",
  };

  // ==========================================================================
  // 1. Path Template Resolver Tests
  // ==========================================================================
  describe("Path Template Engine", () => {
    it("correctly resolves allowlisted template placeholders", () => {
      const template = "{platform}/{difficulty}/{slug}.{extension}";
      const resolved = resolvePathTemplate(template, validVariables);
      expect(resolved).toBe("LeetCode/Easy/two-sum.cpp");
    });

    it("resolves lowercase variable variants", () => {
      const template = "{platform_lower}/{language_lower}/{slug}.{extension}";
      const resolved = resolvePathTemplate(template, validVariables);
      expect(resolved).toBe("leetcode/cpp/two-sum.cpp");
    });

    it("resolves date, timestamp, and rating placeholders", () => {
      const template =
        "solutions/{date}/{rating}/{slug}-{timestamp}.{extension}";
      const resolved = resolvePathTemplate(template, validVariables);
      expect(resolved).toBe("solutions/2026-09-13/800/two-sum-1789300000.cpp");
    });

    it("rejects unknown variable placeholders fail-closed", () => {
      const hostileTemplates = [
        "{eval}/{slug}.cpp",
        "{platform}/{__proto__}/{slug}.cpp",
        "{constructor}/{slug}.cpp",
        "{process.env.SECRET}/{slug}.cpp",
        "{custom_unapproved_var}/{slug}.cpp",
      ];

      for (const t of hostileTemplates) {
        expect(() => resolvePathTemplate(t, validVariables)).toThrow(
          PathTemplateError,
        );
        try {
          resolvePathTemplate(t, validVariables);
        } catch (err) {
          expect(err).toBeInstanceOf(PathTemplateError);
          expect((err as PathTemplateError).code).toBe(
            ErrorCode.TEMPLATE_UNKNOWN_VARIABLE,
          );
        }
      }
    });

    it("rejects malformed template syntax (unclosed, nested, empty braces)", () => {
      const malformedTemplates = [
        "{platform/{slug}.cpp",
        "platform}/{slug}.cpp",
        "{platform}/{{slug}}.cpp",
        "{platform}/{slug/{lang}}.cpp",
        "{platform}/{}/two-sum.cpp",
        "{platform}/{   }/two-sum.cpp",
      ];

      for (const t of malformedTemplates) {
        expect(() => resolvePathTemplate(t, validVariables)).toThrow(
          PathTemplateError,
        );
        try {
          resolvePathTemplate(t, validVariables);
        } catch (err) {
          expect(err).toBeInstanceOf(PathTemplateError);
          expect((err as PathTemplateError).code).toBe(
            ErrorCode.TEMPLATE_MALFORMED,
          );
        }
      }
    });

    it("rejects missing required variable values", () => {
      const incompleteVars: PathTemplateVariables = {
        platform: "LeetCode",
        slug: "", // empty slug
        language: "CPP",
        extension: "cpp",
      };

      expect(() =>
        resolvePathTemplate("{platform}/{slug}.{extension}", incompleteVars),
      ).toThrow(PathTemplateError);

      try {
        resolvePathTemplate("{platform}/{slug}.{extension}", incompleteVars);
      } catch (err) {
        expect((err as PathTemplateError).code).toBe(
          ErrorCode.TEMPLATE_MISSING_VALUE,
        );
      }
    });
  });

  // ==========================================================================
  // 2. Three-Pillar Path Security & Canonicalization
  // ==========================================================================
  describe("Three-Pillar Path Security Engine", () => {
    it("accepts valid POSIX portable paths and returns normalized string", () => {
      const validPaths = [
        "solutions/two-sum.cpp",
        "leetcode/easy/1-two-sum.py",
        "codeforces/1900/4A-watermelon.java",
        "a/b/c/d/e/file.txt",
        "README.md",
        "solution_v2-final.cc",
      ];

      for (const p of validPaths) {
        const canonical = validateAndCanonicalizePath(p);
        expect(canonical).toBe(p);
      }
    });

    it("normalizes backslashes to forward slashes", () => {
      const raw = "solutions\\easy\\two-sum.cpp";
      const canonical = validateAndCanonicalizePath(raw);
      expect(canonical).toBe("solutions/easy/two-sum.cpp");
    });

    it("rejects directory traversal sequences (literal and nested)", () => {
      const traversalPaths = [
        "../two-sum.cpp",
        "..\\two-sum.cpp",
        "solutions/../secret.txt",
        "solutions/..\\secret.txt",
        "a/b/../../../etc/passwd",
        "solutions/..../evil.cpp",
        "solutions/foo..bar/evil.cpp", // '..' anywhere in segment
        "solutions/..",
        "solutions/.",
        "./two-sum.cpp",
      ];

      for (const p of traversalPaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_TRAVERSAL_DETECTED,
          );
        }
      }
    });

    it("rejects URL-encoded and double-encoded traversal sequences", () => {
      const encodedTraversals = [
        "%2e%2e/evil.cpp",
        "%2e%2e%2fevil.cpp",
        "solutions/%2e%2e/secret.txt",
        "%252e%252e/evil.cpp", // double-encoded %2e%2e
        "%252e%252e%252fevil.cpp",
        "solutions/%2e/file.cpp",
        "solutions/%2fsecret.txt",
      ];

      for (const p of encodedTraversals) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
      }
    });

    it("rejects null bytes fail-closed and NEVER strips them", () => {
      const nullBytePaths = [
        "solutions/\0evil.cpp",
        "solutions/\u0000evil.cpp",
        "solutions/%00evil.cpp",
        "solutions/two-sum.cpp\0.exe",
      ];

      for (const p of nullBytePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_INVALID_CHARACTER,
          );
        }
      }
    });

    it("rejects unprintable control characters fail-closed and NEVER strips them", () => {
      const controlBytePaths = [
        "solutions/\x01evil.cpp",
        "solutions/\x1Fevil.cpp",
        "solutions/\x7Fevil.cpp",
        "solutions/\x80evil.cpp",
      ];

      for (const p of controlBytePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_INVALID_CHARACTER,
          );
        }
      }
    });

    it("rejects whitespace in paths (spaces, tabs, newlines)", () => {
      const whitespacePaths = [
        "solutions/two sum.cpp",
        "solutions/\ttwo-sum.cpp",
        "solutions/\ntwo-sum.cpp",
        "solutions/two-sum.cpp ",
      ];

      for (const p of whitespacePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
      }
    });

    it("rejects absolute paths, drive letters, and UNC paths", () => {
      const absolutePaths = [
        "/etc/passwd",
        "/solutions/two-sum.cpp",
        "C:/solutions/two-sum.cpp",
        "D:\\solutions\\two-sum.cpp",
        "c:two-sum.cpp",
        "//server/share/two-sum.cpp",
        "\\\\server\\share\\two-sum.cpp",
      ];

      for (const p of absolutePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_ABSOLUTE_REJECTED,
          );
        }
      }
    });

    it("rejects empty segments and trailing slashes for files", () => {
      const emptySegmentPaths = [
        "solutions//two-sum.cpp",
        "solutions///two-sum.cpp",
        "solutions/two-sum.cpp/", // trailing slash is invalid for file target
        "",
      ];

      for (const p of emptySegmentPaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_EMPTY_SEGMENT,
          );
        }
      }
    });

    it("rejects reserved DOS device names with or without file extensions", () => {
      const dosDevicePaths = [
        "con",
        "PRN",
        "aux",
        "NUL",
        "com1",
        "com9",
        "lpt1",
        "lpt9",
        "solutions/con.cpp",
        "solutions/prn.java",
        "solutions/aux.txt",
        "solutions/nul.py",
        "solutions/com1.js",
        "solutions/lpt1.c",
        "solutions/NUL.EXT.CPP",
      ];

      for (const p of dosDevicePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
        try {
          validateAndCanonicalizePath(p);
        } catch (err) {
          expect((err as PathSecurityError).code).toBe(
            ErrorCode.PATH_RESERVED_NAME,
          );
        }
      }
    });

    it("rejects reserved Git internal directories (.git, .github)", () => {
      const gitPaths = [
        ".git/config",
        ".github/workflows/deploy.yml",
        "solutions/.git/HEAD",
        "solutions/.github/actions.yml",
      ];

      for (const p of gitPaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
      }
    });

    it("rejects segments with leading or trailing dots", () => {
      const dotSegmentPaths = [
        ".hidden/two-sum.cpp",
        "solutions/.config.cpp",
        "solutions/two-sum./cpp",
        "solutions/two-sum.",
      ];

      for (const p of dotSegmentPaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
      }
    });

    it("rejects segment lengths exceeding 100 characters", () => {
      const longSegment = "a".repeat(101);
      const path = `solutions/${longSegment}.cpp`;
      expect(() => validateAndCanonicalizePath(path)).toThrow(
        PathSecurityError,
      );
      try {
        validateAndCanonicalizePath(path);
      } catch (err) {
        expect((err as PathSecurityError).code).toBe(
          ErrorCode.PATH_SEGMENT_TOO_LONG,
        );
      }
    });

    it("rejects total path length exceeding 255 characters", () => {
      // Create 5 segments of 60 chars = 300 chars > 255 limit
      const longPath = Array(5).fill("a".repeat(60)).join("/");
      expect(() => validateAndCanonicalizePath(longPath)).toThrow(
        PathSecurityError,
      );
      try {
        validateAndCanonicalizePath(longPath);
      } catch (err) {
        expect((err as PathSecurityError).code).toBe(
          ErrorCode.PATH_TOTAL_TOO_LONG,
        );
      }
    });

    it("rejects directory depth exceeding 10 levels", () => {
      const deepPath = Array(11).fill("dir").join("/") + "/file.cpp";
      expect(() => validateAndCanonicalizePath(deepPath)).toThrow(
        PathSecurityError,
      );
    });

    it("rejects non-ASCII Unicode characters and homoglyphs", () => {
      const unicodePaths = [
        "solutions/два-сумма.cpp", // Cyrillic
        "solutions/two－sum.cpp", // Fullwidth hyphen
        "solutions/two․sum.cpp", // One-dot leader (U+2024)
        "solutions/two‥sum.cpp", // Two-dot leader (U+2025)
        "solutions/\u202Etwo-sum.cpp", // BIDI override
      ];

      for (const p of unicodePaths) {
        expect(() => validateAndCanonicalizePath(p)).toThrow(PathSecurityError);
      }
    });
  });

  // ==========================================================================
  // 3. Base Folder Boundary Containment Tests
  // ==========================================================================
  describe("Base Folder Boundary Containment", () => {
    it("prepends base folder if not already present", () => {
      const path = "easy/two-sum.cpp";
      const canonical = validateAndCanonicalizePath(path, "solutions");
      expect(canonical).toBe("solutions/easy/two-sum.cpp");
    });

    it("preserves path if base folder is already prefixed", () => {
      const path = "solutions/easy/two-sum.cpp";
      const canonical = validateAndCanonicalizePath(path, "solutions");
      expect(canonical).toBe("solutions/easy/two-sum.cpp");
    });

    it("rejects base folder with invalid segment characters or traversal", () => {
      expect(() => validateBaseFolder("../solutions")).toThrow(
        PathSecurityError,
      );
      expect(() => validateBaseFolder("solutions/..")).toThrow(
        PathSecurityError,
      );
      expect(() => validateBaseFolder("solutions/con")).toThrow(
        PathSecurityError,
      );
      expect(() => validateBaseFolder("solutions/.git")).toThrow(
        PathSecurityError,
      );
      expect(() => validateBaseFolder("solutions/invalid*char")).toThrow(
        PathSecurityError,
      );
    });

    it("handles nested valid base folders", () => {
      const path = "two-sum.cpp";
      const canonical = validateAndCanonicalizePath(
        path,
        "competitive-programming/leetcode",
      );
      expect(canonical).toBe("competitive-programming/leetcode/two-sum.cpp");
    });
  });

  // ==========================================================================
  // 4. Safe Commit Message Formatter Tests
  // ==========================================================================
  describe("Commit Message Security", () => {
    it("formats a safe single-line commit summary", () => {
      const summary = "Solved Two-Sum on LeetCode [CPP]";
      const formatted = formatSafeCommitMessage(summary);
      expect(formatted).toBe("Solved Two-Sum on LeetCode [CPP]");
    });

    it("strips CRLF and control characters from summary line", () => {
      const hostileSummary =
        "Solved Two-Sum\r\nHostile-Header: injected\n\x00malicious";
      const formatted = formatSafeCommitMessage(hostileSummary);
      expect(formatted).not.toContain("\r");
      expect(formatted).not.toContain("\n");
      expect(formatted).not.toContain("\x00");
      expect(formatted).toBe(
        "Solved Two-Sum  Hostile-Header: injected malicious",
      );
    });

    it("truncates commit summary at 200 characters", () => {
      const longSummary = "A".repeat(300);
      const formatted = formatSafeCommitMessage(longSummary);
      expect(formatted.length).toBe(200);
    });

    it("supports optional multi-line body while stripping control characters", () => {
      const summary = "Solved Two-Sum";
      const body = "Runtime: 0ms\nMemory: 10MB\x00";
      const formatted = formatSafeCommitMessage(summary, body);
      expect(formatted).toBe("Solved Two-Sum\n\nRuntime: 0ms\nMemory: 10MB");
      expect(formatted).not.toContain("\x00");
    });
  });

  // ==========================================================================
  // 5. Property-Style / Generated Adversarial Fuzz Tests
  // ==========================================================================
  describe("Property-Style Adversarial Fuzz Tests", () => {
    it("consistently rejects 50+ procedurally generated adversarial path variants", () => {
      const hostilePrefixes = [
        "../",
        "..\\",
        "/",
        "//",
        "\\",
        "\\\\",
        "%2e%2e/",
        "%252e%252e/",
        ".git/",
        ".github/",
        "con/",
        "nul/",
        "aux/",
      ];

      const hostileSegments = [
        "..",
        ".",
        "foo..bar",
        "nul.cpp",
        "con.txt",
        "evil\0.cpp",
        "evil\x01.cpp",
        "два-сумма",
        "space in name",
        "tab\tin\tname",
      ];

      for (const prefix of hostilePrefixes) {
        for (const seg of hostileSegments.slice(0, 5)) {
          const testPath = `${prefix}${seg}`;
          expect(
            () => validateAndCanonicalizePath(testPath),
            `Hostile path "${testPath}" must be rejected fail-closed`,
          ).toThrow();
        }
      }
    });

    it("preserves repository-relative invariant across all valid canonical paths", () => {
      const validSamples = [
        "two-sum.cpp",
        "leetcode/two-sum.py",
        "a/b/c/d/e.txt",
        "problem-123_final.cpp",
      ];

      for (const sample of validSamples) {
        const result = validateAndCanonicalizePath(sample);
        expect(result.startsWith("/")).toBe(false);
        expect(result.startsWith("\\")).toBe(false);
        expect(result.includes("..")).toBe(false);
        expect(result.includes("\\")).toBe(false);
        expect(result.length).toBeLessThanOrEqual(MAX_TOTAL_PATH_LENGTH);
      }
    });
  });
});
