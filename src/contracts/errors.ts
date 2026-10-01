/** The closed set of error codes tabctx can return. Never add free-form codes. */
export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "UNSUPPORTED_BROWSER",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_CLOSED",
  "NO_CURRENT_CONTEXT",
  "TARGET_NOT_FOUND",
  "AMBIGUOUS_TARGET",
  "NAVIGATION_FAILED",
  "ACTION_FAILED",
  "TIMEOUT",
  "DAEMON_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A typed failure. `details` must be JSON-serializable and must never hold secrets or typed values. */
export class TabCtxError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TabCtxError";
    this.code = code;
    this.details = details;
  }
}

export function isTabCtxError(value: unknown): value is TabCtxError {
  return value instanceof TabCtxError;
}
