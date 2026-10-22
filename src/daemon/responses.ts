/**
 * Request parsing and error-response shaping for DaemonService. Typed values
 * (`type`/`select` --value) are scrubbed from every error before it leaves.
 */
import { AtcError, isAtcError } from "../contracts/errors.js";
import type { ErrorResponse, Method } from "../contracts/protocol.js";
import { type Params, isRecord } from "./params.js";

const REDACTED = "[redacted]";

export function parseRequest(raw: unknown, methods: Readonly<Record<Method, unknown>>): { method: Method; params: Params } {
  if (!isRecord(raw) || typeof raw.method !== "string") {
    throw new AtcError("INVALID_ARGUMENT", "request must be an object with a string method");
  }
  if (!Object.hasOwn(methods, raw.method)) {
    throw new AtcError("INVALID_ARGUMENT", `unknown method: ${raw.method.slice(0, 64)}`);
  }
  const params = raw.params === undefined ? {} : raw.params;
  if (!isRecord(params)) throw new AtcError("INVALID_ARGUMENT", "params must be an object");
  return { method: raw.method as Method, params };
}

export function noCurrent(): AtcError {
  return new AtcError("NO_CURRENT_CONTEXT", "no current context; run `atc bind` (or `atc use <ctx>`) or pass --context");
}

export function typedValueOf(raw: unknown): string | undefined {
  if (!isRecord(raw) || (raw.method !== "type" && raw.method !== "select")) return undefined;
  const value = isRecord(raw.params) ? raw.params.value : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (isAtcError(err)) return { ...err.details, ok: false, error: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: "INTERNAL", message };
}

export function redact(response: ErrorResponse, secret: string | undefined): ErrorResponse {
  if (secret === undefined) return response;
  const scrubbed: ErrorResponse = { ok: false, error: response.error, message: scrub(response.message, secret) };
  for (const [key, value] of Object.entries(response)) {
    if (key !== "ok" && key !== "error" && key !== "message") scrubbed[key] = scrubValue(value, secret);
  }
  return scrubbed;
}

function scrubValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return scrub(value, secret);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secret));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, secret)]));
  return value;
}

function scrub(text: string, secret: string): string {
  return text.split(secret).join(REDACTED);
}

export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
