import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e-browser",
  testMatch: "**/*.spec.ts",
  timeout: 35000,
  retries: 0,
  workers: 1, // Single worker avoids port and profile contention
  use: {
    trace: "off",
  },
});
