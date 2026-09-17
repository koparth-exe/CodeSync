/**
 * Platform Adapters Subsystem Barrel Export (Phase 1C.3)
 */

export * from "./types";
export * from "./validator";
export * from "./deduplicator";
export * from "./base-adapter";
export * from "./registry";
export * from "./leetcode/leetcode-adapter";
export * from "./codechef/codechef-adapter";
export * from "./codeforces/codeforces-adapter";
export * from "./geeksforgeeks/geeksforgeeks-adapter";
export * from "./submission-handler";

import { defaultAdapterRegistry, PlatformAdapterRegistry } from "./registry";
import { LeetCodeAdapter } from "./leetcode/leetcode-adapter";
import { CodeChefAdapter } from "./codechef/codechef-adapter";
import { CodeforcesAdapter } from "./codeforces/codeforces-adapter";
import { GeeksforGeeksAdapter } from "./geeksforgeeks/geeksforgeeks-adapter";

/**
 * Creates and initializes an adapter registry populated with all approved platform adapters.
 */
export function createDefaultRegistry(): PlatformAdapterRegistry {
  const registry = new PlatformAdapterRegistry();
  registry.register(new LeetCodeAdapter());
  registry.register(new CodeChefAdapter());
  registry.register(new CodeforcesAdapter());
  registry.register(new GeeksforGeeksAdapter());
  return registry;
}

// Auto-populate the default singleton registry
try {
  defaultAdapterRegistry.register(new LeetCodeAdapter());
  defaultAdapterRegistry.register(new CodeChefAdapter());
  defaultAdapterRegistry.register(new CodeforcesAdapter());
  defaultAdapterRegistry.register(new GeeksforGeeksAdapter());
} catch {
  // Ignore if already registered during reload/tests
}
