import { describe, expect, it } from "vitest";
import {
  computeContentHash,
  compareContentHashes,
  isContentIdentical,
  normalizeSourceCode,
} from "../../src/shared/deduplication";

describe("Deduplication & Content Identity Primitives Suite (S9)", () => {
  const sampleLF = `class Solution {\npublic:\n    int twoSum() {\n        return 0;\n    }\n};\n`;
  const sampleCRLF = `class Solution {\r\npublic:\r\n    int twoSum() {\r\n        return 0;\r\n    }\r\n};\r\n`;
  const sampleTrailingSpaces = `class Solution {   \npublic:\t \n    int twoSum() {\n        return 0;\n    }\n};\n\n\n`;

  it("normalizes line endings from CRLF and CR to LF", () => {
    const normalized = normalizeSourceCode(sampleCRLF);
    expect(normalized).not.toContain("\r");
    expect(normalized).toBe(normalizeSourceCode(sampleLF));
  });

  it("normalizes CR-only line breaks (legacy Mac) to LF", () => {
    const sampleCR = `class Solution {\rpublic:\r    return 0;\r};\r`;
    const normalized = normalizeSourceCode(sampleCR);
    expect(normalized).not.toContain("\r");
    expect(normalized).toContain("\n");
  });

  it("strips trailing whitespace per line and excess trailing newlines", () => {
    const normalized = normalizeSourceCode(sampleTrailingSpaces);
    expect(normalized).toBe(normalizeSourceCode(sampleLF));
  });

  it("produces identical SHA-256 hashes for CRLF vs LF code", async () => {
    const hashLF = await computeContentHash(sampleLF);
    const hashCRLF = await computeContentHash(sampleCRLF);
    const hashTrailing = await computeContentHash(sampleTrailingSpaces);

    expect(hashLF).toHaveLength(64);
    expect(hashLF).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLF).toBe(hashCRLF);
    expect(hashLF).toBe(hashTrailing);
  });

  it("produces different SHA-256 hashes for differing code content", async () => {
    const codeA = `int a = 1;`;
    const codeB = `int a = 2;`;

    const hashA = await computeContentHash(codeA);
    const hashB = await computeContentHash(codeB);

    expect(hashA).not.toBe(hashB);
    expect(compareContentHashes(hashA, hashB)).toBe(false);
  });

  it("evaluates isContentIdentical accurately across whitespace variations", () => {
    expect(isContentIdentical(sampleLF, sampleCRLF)).toBe(true);
    expect(isContentIdentical(sampleLF, sampleTrailingSpaces)).toBe(true);
    expect(isContentIdentical(sampleLF, `int different = 42;`)).toBe(false);
  });

  it("evaluates compareContentHashes accurately and case-insensitively", async () => {
    const hashA = await computeContentHash(sampleLF);
    const hashB = hashA.toUpperCase();

    expect(compareContentHashes(hashA, hashB)).toBe(true);
    expect(compareContentHashes(hashA, "")).toBe(false);
  });

  it("normalizes Unicode NFKC correctly", async () => {
    // Unicode compatibility decomposition (e.g. ligature 'ﬁ' vs 'fi')
    const codeLigature = `int ﬁndMax = 1;`;
    const codeDecomposed = `int findMax = 1;`;

    const hashLigature = await computeContentHash(codeLigature);
    const hashDecomposed = await computeContentHash(codeDecomposed);

    expect(hashLigature).toBe(hashDecomposed);
  });
});
