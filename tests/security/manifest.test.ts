import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Define forbidden permissions according to docs/SECURITY.md Section 4.2
const FORBIDDEN_PERMISSIONS = [
  "webRequest",
  "webRequestBlocking",
  "tabs",
  "cookies",
  "history",
  "bookmarks",
  "clipboardRead",
  "clipboardWrite",
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "scripting",
  "<all_urls>",
];

interface ExtensionManifest {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  content_security_policy?: {
    extension_pages?: string;
  };
  content_scripts?: Array<{
    matches: string[];
    js?: string[];
  }>;
}

function loadManifest(targetDir: string): ExtensionManifest {
  const manifestPath = path.resolve(process.cwd(), targetDir, "manifest.json");
  expect(
    fs.existsSync(manifestPath),
    `Manifest must exist at ${manifestPath}`,
  ).toBe(true);
  const raw = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as ExtensionManifest;
}

describe("Manifest Security & Least-Privilege Verification (S1, S2, S3, S4, S7)", () => {
  const buildTargets = [
    { name: "Chrome MV3", dir: ".output/chrome-mv3" },
    { name: "Firefox MV3", dir: ".output/firefox-mv3" },
  ];

  for (const { name, dir } of buildTargets) {
    describe(`${name} Manifest Audit`, () => {
      it("S1: must NOT contain any forbidden unnecessary permissions", () => {
        const manifest = loadManifest(dir);
        const permissions = manifest.permissions ?? [];

        for (const forbidden of FORBIDDEN_PERMISSIONS) {
          expect(
            permissions.includes(forbidden),
            `Manifest ${name} must not request forbidden permission "${forbidden}"`,
          ).toBe(false);
        }
      });

      it("S2: must NOT contain <all_urls> in permissions or host_permissions", () => {
        const manifest = loadManifest(dir);
        const allPermissions = [
          ...(manifest.permissions ?? []),
          ...(manifest.host_permissions ?? []),
        ];

        expect(allPermissions.includes("<all_urls>")).toBe(false);

        if (manifest.content_scripts) {
          for (const cs of manifest.content_scripts) {
            expect(cs.matches.includes("<all_urls>")).toBe(false);
          }
        }
      });

      it("S3: must NOT contain unsafe-eval or wasm-unsafe-eval in Content Security Policy", () => {
        const manifest = loadManifest(dir);
        const csp = manifest.content_security_policy?.extension_pages ?? "";

        expect(csp).not.toContain("unsafe-eval");
        expect(csp).not.toContain("wasm-unsafe-eval");
      });

      it("S4: must NOT permit unsafe-inline executable code pathways in CSP", () => {
        const manifest = loadManifest(dir);
        const csp = manifest.content_security_policy?.extension_pages ?? "";

        // Extract script-src directive
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrcMatch).not.toBeNull();
        const scriptSrc = scriptSrcMatch ? scriptSrcMatch[1] : "";

        // script-src must never have 'unsafe-inline'
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect(scriptSrc).toContain("'self'");
      });

      it("S7: must NOT allow remote executable script loading in CSP", () => {
        const manifest = loadManifest(dir);
        const csp = manifest.content_security_policy?.extension_pages ?? "";

        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        const scriptSrc = scriptSrcMatch ? scriptSrcMatch[1] : "";

        // No http: or https: in script-src
        expect(scriptSrc).not.toMatch(/https?:/);
        expect(scriptSrc).not.toContain("*");
      });

      it("must be Manifest Version 3", () => {
        const manifest = loadManifest(dir);
        expect(manifest.manifest_version).toBe(3);
      });
    });
  }
});
