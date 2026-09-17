import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function getAllSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function stripComments(content: string): string {
  // Strip block comments and line comments to avoid false positives on security documentation comments
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Code Hygiene & Static Security Audit (S5, S6, S10)", () => {
  const srcDir = path.resolve(process.cwd(), "src");
  const sourceFiles = getAllSourceFiles(srcDir);

  it("verifies that source files exist to audit", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it("S5: must NOT contain eval() in executable code of any source file", () => {
    const evalRegex = /\beval\s*\(/;

    for (const file of sourceFiles) {
      const content = stripComments(fs.readFileSync(file, "utf-8"));
      const match = evalRegex.test(content);
      const relativePath = path.relative(process.cwd(), file);
      expect(match, `Forbidden eval() detected in ${relativePath}`).toBe(false);
    }
  });

  it("S6: must NOT contain new Function() or dynamic Function() constructor in any source file", () => {
    const funcRegex = /\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/;

    for (const file of sourceFiles) {
      const content = stripComments(fs.readFileSync(file, "utf-8"));
      const match = funcRegex.test(content);
      const relativePath = path.relative(process.cwd(), file);
      expect(
        match,
        `Forbidden dynamic Function() constructor detected in ${relativePath}`,
      ).toBe(false);
    }
  });

  it("S10: must NOT contain hardcoded secrets, tokens, or private keys", () => {
    // Secret pattern detectors
    const secretPatterns = [
      /ghu_[A-Za-z0-9_]{20,}/,
      /ghr_[A-Za-z0-9_]{20,}/,
      /ghp_[A-Za-z0-9_]{20,}/,
      /gho_[A-Za-z0-9_]{20,}/,
      /github_pat_[A-Za-z0-9_]{20,}/,
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
      /(?:client_secret|clientSecret)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/,
    ];

    for (const file of sourceFiles) {
      // Exclude test files or redactor pattern definitions which contain regex definitions, not actual secrets
      if (file.includes("redactor.ts")) continue;

      const content = fs.readFileSync(file, "utf-8");
      const relativePath = path.relative(process.cwd(), file);

      for (const pattern of secretPatterns) {
        expect(
          pattern.test(content),
          `Potential hardcoded secret matching ${pattern} found in ${relativePath}`,
        ).toBe(false);
      }
    }
  });

  it("must NOT contain dangerouslySetInnerHTML, innerHTML, or outerHTML in UI/scripts", () => {
    const dangerousDomRegex =
      /\b(dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)\b/;

    for (const file of sourceFiles) {
      const content = stripComments(fs.readFileSync(file, "utf-8"));
      const relativePath = path.relative(process.cwd(), file);
      expect(
        dangerousDomRegex.test(content),
        `Dangerous DOM mutation API detected in ${relativePath}`,
      ).toBe(false);
    }
  });
});
