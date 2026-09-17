import { describe, expect, it } from "vitest";
import {
  normalizeSourceCode,
  computeContentHash,
} from "../../src/shared/deduplication";
import { validateSourceCode } from "../../src/shared/adapters/validator";
import { MAX_SOURCE_PAYLOAD_BYTES } from "../../src/shared/github/types";

describe("Phase 1C.3 — Platform Normalization & Source Hygiene", () => {
  it("normalizes CRLF and CR line endings to standard LF", () => {
    const crlf = "int main() {\r\n    return 0;\r\n}\r\n";
    const normalized = normalizeSourceCode(crlf);
    expect(normalized).toBe("int main() {\n    return 0;\n}\n");
    expect(normalized).not.toContain("\r");

    const crOnly = "line1\rline2\r";
    expect(normalizeSourceCode(crOnly)).toBe("line1\nline2\n");
  });

  it("strips trailing whitespace per line and preserves clean EOF", () => {
    const code = "int a = 1;   \nint b = 2;\t\t\n\n\n";
    const normalized = normalizeSourceCode(code);
    expect(normalized).toBe("int a = 1;\nint b = 2;\n");
  });

  it("performs Unicode NFKC canonicalization", () => {
    // \uFB01 is 'fi' ligature
    const withLigature = "def \uFB01nd(): pass\n";
    const normalized = normalizeSourceCode(withLigature);
    expect(normalized).toBe("def find(): pass\n");
  });

  it("produces deterministic SHA-256 content hashes", async () => {
    const raw1 = "int main() {\r\n  return 0;   \r\n}\r\n\r\n";
    const raw2 = "int main() {\n  return 0;\n}\n";

    const hash1 = await computeContentHash(raw1);
    const hash2 = await computeContentHash(raw2);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects empty source code or source code exceeding payload limits", () => {
    expect(validateSourceCode("").valid).toBe(false);
    expect(validateSourceCode("   \n\t  ").valid).toBe(false);

    const oversized = "a".repeat(MAX_SOURCE_PAYLOAD_BYTES + 1);
    const result = validateSourceCode(oversized);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds");
  });

  it("rejects source code containing binary or forbidden control bytes", () => {
    const withNullByte = "int main() { return 0; }\0";
    expect(validateSourceCode(withNullByte).valid).toBe(false);

    const withBellChar = "int main() { \x07 return 0; }";
    expect(validateSourceCode(withBellChar).valid).toBe(false);

    // Tab, newline, and carriage return are allowed
    const validChars = "int\tmain() {\r\n  return 0;\n}\n";
    expect(validateSourceCode(validChars).valid).toBe(true);
  });
});
