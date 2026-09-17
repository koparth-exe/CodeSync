import type { ExtensionConfig } from "./schema";

/**
 * Deterministic default extension configuration.
 * Contains ZERO secrets, tokens, or credentials.
 */
export const DEFAULT_EXTENSION_CONFIG: Readonly<ExtensionConfig> =
  Object.freeze({
    version: 1,
    targetBranch: "main",
    baseFolder: "solutions",
    duplicatePolicy: "skip",
    enabledPlatforms: Object.freeze({
      leetcode: true,
      codeforces: true,
      codechef: true,
      geeksforgeeks: true,
    }),
  });
