/** The closed set of error codes atc can return. Never add free-form codes. */
export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNSUPPORTED_BROWSER",
  "UNSUPPORTED_ACTION",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_CLOSED",
  "NO_CURRENT_CONTEXT",
  "TARGET_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "TAB_MOVED",
  "NAVIGATION_FAILED",
  "ACTION_FAILED",
  "TIMEOUT",
  "DAEMON_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A typed failure. `details` must be JSON-serializable and must never hold secrets or typed values. */
export class AtcError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AtcError";
    this.code = code;
    this.details = details;
  }
}

export function isAtcError(value: unknown): value is AtcError {
  return value instanceof AtcError;
}

/** Narrow untrusted input (e.g. from the browser extension) to a known code, else ACTION_FAILED. */
export function toErrorCode(raw: unknown): ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(raw) ? (raw as ErrorCode) : "ACTION_FAILED";
}
