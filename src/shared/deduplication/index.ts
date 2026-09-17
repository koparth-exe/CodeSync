/**
 * Content Identity & Deduplication Primitives
 *
 * Implements deterministic content normalization and cryptographic identity.
 * Strictly decoupled from future GitHub/repository write policies
 * (e.g. REPLACE_IF_DIFFERENT, KEEP_ALL, etc., which belong to Phase 1C sync logic).
 */

/**
 * Normalizes source code for deterministic hashing across platforms:
 * 1. Unicode NFKC canonicalization.
 * 2. Normalizes all line endings (CRLF and CR -> POSIX LF).
 * 3. Strips trailing whitespace per line.
 * 4. Ensures clean trailing newline at EOF without empty trailing blank lines.
 */
export function normalizeSourceCode(raw: string): string {
  if (!raw) return "";

  // Unicode canonicalization
  const canonical = raw.normalize("NFKC");

  // Line ending normalization to LF
  const lines = canonical
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  // Strip trailing whitespace from each line
  const trimmedLines = lines.map((line) => line.replace(/[ \t]+$/, ""));

  // Strip trailing empty lines from the end of the file
  while (
    trimmedLines.length > 0 &&
    trimmedLines[trimmedLines.length - 1] === ""
  ) {
    trimmedLines.pop();
  }

  // Always end with exactly one newline if non-empty
  return trimmedLines.length > 0 ? trimmedLines.join("\n") + "\n" : "";
}

/**
 * Computes SHA-256 hash of normalized source code using native Web Crypto.
 * Returns 64-character lowercase hexadecimal string.
 */
export async function computeContentHash(sourceCode: string): Promise<string> {
  const normalized = normalizeSourceCode(sourceCode);
  const data = new TextEncoder().encode(normalized);

  const subtleCrypto =
    typeof crypto !== "undefined" && crypto.subtle
      ? crypto.subtle
      : globalThis.crypto?.subtle;

  if (!subtleCrypto) {
    throw new Error("Web Crypto subtle is not available for hashing.");
  }

  const hashBuffer = await subtleCrypto.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two raw source code strings for semantic identity after normalization.
 */
export function isContentIdentical(sourceA: string, sourceB: string): boolean {
  return normalizeSourceCode(sourceA) === normalizeSourceCode(sourceB);
}

/**
 * Compares two 64-character SHA-256 content hashes case-insensitively.
 */
export function compareContentHashes(hashA: string, hashB: string): boolean {
  if (!hashA || !hashB) return false;
  return hashA.trim().toLowerCase() === hashB.trim().toLowerCase();
}
