/**
 * Best-effort redaction for values that leave the daemon toward a model.
 * This is defense in depth, not a guarantee: callers must still treat page
 * content as untrusted and never display raw secrets by default.
 */

const SENSITIVE_QUERY_KEY =
  /(?:^|[_.-])(token|key|secret|session|auth|authorization|bearer|cookie|code|password|passwd|otp|pin|cvv|cvc|card|cc|sig|signature|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret)(?:$|[_.-])/i;

const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Authorization\s*:\s*)Bearer\s+[^\s,;]+/gi, "$1Bearer [redacted]"],
  [/\b(Authorization\s*:\s*(?:Basic|Token|Digest)\s+)[^\s,;]+/gi, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, "$1: [redacted]"],
  [/\b(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr|glpat|npm|xox[baprs]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "[redacted-token]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  [/\b(otp|one[-_\s]?time[-_\s]?code|verification[-_\s]?code|security[-_\s]?code|cvv|cvc|cvv2)\s*(?:[:=]|is\s+)\s*\d{3,8}\b/gi, "$1: [redacted]"],
  [/\b(?:\d{4}[ -]){3}\d{1,4}\b/g, "[redacted-card]"],
  [/\b[3-6]\d{12,18}\b/g, "[redacted-card]"],
];

/** Redact userinfo and token-like query values while preserving readable routing. */
export function redactUrl(raw: string): string {
  const url = parseUrl(raw);
  if (url === undefined) return redactText(raw);
  redactUserinfo(url);
  redactQuery(url);
  return url.toString();
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function redactUserinfo(url: URL): void {
  if (url.username !== "") url.username = "[redacted]";
  if (url.password !== "") url.password = "[redacted]";
}

function redactQuery(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[redacted]");
    else redactQueryValue(url, key);
  }
}

function redactQueryValue(url: URL, key: string): void {
  const value = url.searchParams.get(key);
  if (value !== null && value !== redactText(value)) url.searchParams.set(key, redactText(value));
}

/** Redact common token shapes in free text. */
export function redactText(raw: string): string {
  let value = raw;
  for (const [pattern, replacement] of TOKEN_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

/** Recursively redact URLs and strings in a JSON-like value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /^(url|href|src|location)$/i.test(key) && typeof item === "string" ? redactUrl(item) : redactValue(item),
      ]),
    ) as T;
  }
  return value;
}
