export const REDACTED = "[REDACTED]";

/** Exact key names, compared case-insensitively. Nearby names such as `idTag` are left alone. */
const SECRET_KEYS = new Set(["password", "secret", "authorizationkey", "apikey", "token"]);

const SECRET_LITERAL =
  /("(?:password|secret|authorizationkey|apikey|token)")\s*:\s*(?:"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?)/gi;

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/** Deep copy. The input is not modified. */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    copy[key] = isSecretKey(key) ? REDACTED : redactValue(inner);
  }
  return copy;
}

/**
 * Redacts a raw frame for storage.
 * Valid JSON is re-serialized, so whitespace and formatting may differ from the wire bytes.
 * Text that is not JSON only has obvious `"key": value` pairs for the known key names replaced.
 */
export function redactRaw(raw: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(raw) as unknown));
  } catch {
    return raw.replace(SECRET_LITERAL, `$1:${JSON.stringify(REDACTED)}`);
  }
}
