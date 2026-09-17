/**
 * Sensitive Data Redactor for CodeSync Logging Foundation
 *
 * Invariants:
 * - Secrets, tokens, credentials, authorization headers, and cookies must NEVER
 *   appear in plaintext in console output or diagnostic logs.
 * - Inadvertently passed source code or sensitive strings are sanitized.
 */

// Ordered credential and token replacement patterns
const SENSITIVE_PATTERNS: ReadonlyArray<{
  readonly regex: RegExp;
  readonly replacement: string;
}> = [
  // HTTP Authorization & Bearer headers (matched first to capture bearer credentials)
  {
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [REDACTED_BEARER_TOKEN]",
  },
  {
    regex: /Basic\s+[A-Za-z0-9+/=]+/gi,
    replacement: "Basic [REDACTED_CREDENTIAL]",
  },

  // GitHub token prefixes
  { regex: /ghu_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED_GHU_TOKEN]" },
  {
    regex: /ghr_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED_GHR_REFRESH_TOKEN]",
  },
  { regex: /ghp_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED_GHP_PAT]" },
  {
    regex: /gho_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED_GHO_OAUTH_TOKEN]",
  },
  {
    regex: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED_FINE_GRAINED_PAT]",
  },

  // Generic key-value secret fields in JSON or headers
  {
    regex:
      /(["']?(?:client_secret|clientsecret|password|secret)["']?\s*[:=]\s*["']?)([^"'\s,;]+)(["']?)/gi,
    replacement: "$1[REDACTED_SECRET]$3",
  },
];

// Sensitive property keys to automatically redact in objects
const SENSITIVE_KEYS = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "clientsecret",
  "client_secret",
  "secret",
  "password",
  "authorization",
  "cookie",
  "sourcecode",
  "source_code",
  "payload",
  "device_code",
  "devicecode",
  "user_code",
  "usercode",
]);

/**
 * Redacts sensitive patterns from a string.
 */
export function redactString(input: string): string {
  if (!input) return input;
  let sanitized = input;
  for (const { regex, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(regex, replacement);
  }
  return sanitized;
}

/**
 * Recursively redacts sensitive keys and values from arbitrary data structures.
 */
export function redactSensitiveData(data: unknown, depth: number = 0): unknown {
  // Prevent stack overflow on circular references or deep objects
  if (depth > 6) return "[MAX_DEPTH_EXCEEDED]";

  if (typeof data === "string") {
    return redactString(data);
  }

  if (data === null || data === undefined || typeof data !== "object") {
    return data;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: redactString(data.message),
      // Only include stack if non-empty, and redact it
      stack: data.stack ? redactString(data.stack) : undefined,
    };
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1));
  }

  const sanitizedObj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitizedObj[key] = "[REDACTED_SENSITIVE_FIELD]";
    } else {
      sanitizedObj[key] = redactSensitiveData(val, depth + 1);
    }
  }

  return sanitizedObj;
}
