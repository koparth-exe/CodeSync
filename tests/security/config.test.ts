import { describe, expect, it } from "vitest";
import { ConfigurationError, ErrorCode } from "../../src/shared/errors";
import {
  DEFAULT_EXTENSION_CONFIG,
  validateConfig,
} from "../../src/shared/config";

describe("Secure Configuration Foundation (S13)", () => {
  it("accepts valid default configuration", () => {
    const config = validateConfig(DEFAULT_EXTENSION_CONFIG);
    expect(config.targetBranch).toBe("main");
    expect(config.baseFolder).toBe("solutions");
    expect(config.duplicatePolicy).toBe("skip");
    expect(config.version).toBe(1);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("accepts valid dotted branch names without false-positive traversal rejection", () => {
    const config = validateConfig({
      ...DEFAULT_EXTENSION_CONFIG,
      targetBranch: "release/v1.0.4",
    });
    expect(config.targetBranch).toBe("release/v1.0.4");
  });

  it("rejects null or non-object input and fails closed", () => {
    expect(() => validateConfig(null)).toThrow(ConfigurationError);
    expect(() => validateConfig(undefined)).toThrow(ConfigurationError);
    expect(() => validateConfig("string")).toThrow(ConfigurationError);
    expect(() => validateConfig(123)).toThrow(ConfigurationError);
    expect(() => validateConfig([])).toThrow(ConfigurationError);
  });

  describe("Path Traversal & Injection Defense in Configuration", () => {
    it("rejects target branch containing parent directory traversal (..) independently of regex", () => {
      // Note: All characters in 'main/../v1' match the SAFE_BRANCH_REGEX character class [a-zA-Z0-9._/-],
      // proving that rejection occurs independently via explicit traversal checks.
      const malicious = {
        ...DEFAULT_EXTENSION_CONFIG,
        targetBranch: "main/../v1",
      };

      expect(() => validateConfig(malicious)).toThrow(ConfigurationError);
      try {
        validateConfig(malicious);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigurationError);
        expect((e as ConfigurationError).code).toBe(
          ErrorCode.CONFIG_TRAVERSAL_DETECTED,
        );
      }
    });

    it("rejects target branch with null bytes", () => {
      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          targetBranch: "main\0evil",
        }),
      ).toThrow(ConfigurationError);

      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          targetBranch: "main%00evil",
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects target branch starting with / or containing shell metacharacters", () => {
      expect(() =>
        validateConfig({ ...DEFAULT_EXTENSION_CONFIG, targetBranch: "/main" }),
      ).toThrow(ConfigurationError);

      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          targetBranch: "main; rm -rf",
        }),
      ).toThrow(ConfigurationError);

      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          targetBranch: "main`whoami`",
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects base folder containing directory traversal (..)", () => {
      const traversalInputs = [
        "../solutions",
        "solutions/../../etc",
        "..",
        "/solutions",
        "solutions/",
        "solutions/..",
      ];

      for (const input of traversalInputs) {
        expect(
          () =>
            validateConfig({ ...DEFAULT_EXTENSION_CONFIG, baseFolder: input }),
          `Base folder "${input}" must be rejected`,
        ).toThrow(ConfigurationError);
      }
    });

    it("rejects base folder containing backslashes or null bytes", () => {
      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          baseFolder: "solutions\\nested",
        }),
      ).toThrow(ConfigurationError);

      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          baseFolder: "solutions\0nested",
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects Windows drive letters and root paths in base folder", () => {
      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          baseFolder: "C:/solutions",
        }),
      ).toThrow(ConfigurationError);
      expect(() =>
        validateConfig({
          ...DEFAULT_EXTENSION_CONFIG,
          baseFolder: "/var/solutions",
        }),
      ).toThrow(ConfigurationError);
    });

    it("rejects reserved DOS device names in base folder segments", () => {
      const dosDevices = [
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "COM1",
        "LPT1",
        "con.txt",
        "aux.cpp",
      ];

      for (const dev of dosDevices) {
        expect(
          () =>
            validateConfig({
              ...DEFAULT_EXTENSION_CONFIG,
              baseFolder: `solutions/${dev}`,
            }),
          `DOS device "${dev}" must be rejected`,
        ).toThrow(ConfigurationError);
      }
    });
  });

  describe("Policy & Value Validation", () => {
    it("rejects invalid duplicate policy", () => {
      const invalid = {
        ...DEFAULT_EXTENSION_CONFIG,
        duplicatePolicy: "force_push_everything",
      };

      expect(() => validateConfig(invalid)).toThrow(ConfigurationError);
    });

    it("sanitizes enabled platforms to valid alphanumeric keys only", () => {
      const custom = {
        ...DEFAULT_EXTENSION_CONFIG,
        enabledPlatforms: {
          leetcode: false,
          codeforces: true,
          "../../malicious": true, // Should be rejected/dropped
        },
      };

      const result = validateConfig(custom);
      expect(result.enabledPlatforms.leetcode).toBe(false);
      expect(result.enabledPlatforms.codeforces).toBe(true);
      expect(
        (result.enabledPlatforms as Record<string, boolean>)["../../malicious"],
      ).toBeUndefined();
    });
  });
});
