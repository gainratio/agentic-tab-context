/**
 * Runtime validation of request params. Requests arrive as untrusted JSON, so
 * the static `Request` type is only a promise; these helpers enforce it and
 * fail with INVALID_ARGUMENT. Messages never echo typed values.
 */
import { AtcError } from "../contracts/errors.js";
import { PROFILE_PATTERN } from "../contracts/patterns.js";
import { BROWSERS, type BindOptions, type BrowserName, SIMPLE_LOCATOR_KINDS, type Target, simpleTarget } from "../contracts/types.js";

export type Params = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): AtcError {
  return new AtcError("INVALID_ARGUMENT", message);
}

export function optionalString(params: Params, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  return value;
}

export function requireString(params: Params, key: string): string {
  const value = optionalString(params, key);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

export function optionalBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${key} must be a boolean`);
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function optionalNonNegativeInteger(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!isNonNegativeInteger(value)) throw invalid(`${key} must be a non-negative integer`);
  return value;
}

export function optionalBrowser(params: Params): BrowserName | undefined {
  const value = params.browser;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(BROWSERS as readonly string[]).includes(value)) {
    throw invalid(`browser must be one of: ${BROWSERS.join(", ")}`);
  }
  return value as BrowserName;
}

export function requireBrowser(params: Params): BrowserName {
  const browser = optionalBrowser(params);
  if (browser === undefined) throw invalid(`browser must be one of: ${BROWSERS.join(", ")}`);
  return browser;
}

export function parseBindOptions(params: Params): BindOptions {
  return definedOnly({
    tab: optionalString(params, "tab"),
    query: optionalString(params, "query"),
    url: optionalString(params, "url"),
    title: optionalString(params, "title"),
    browser: optionalBrowser(params),
    active: optionalBoolean(params, "active"),
    use: optionalBoolean(params, "use"),
  });
}

/** Drop undefined fields so optional properties are absent rather than present-but-undefined. */
export function definedOnly<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function profileParam(params: Params): string {
  const profile = optionalString(params, "profile") ?? "default";
  if (!PROFILE_PATTERN.test(profile)) {
    throw invalid(`profile must match ${PROFILE_PATTERN.source}`);
  }
  return profile;
}

export function requireTarget(params: Params): Target {
  const raw = params.target;
  if (!isRecord(raw)) throw invalid("target is required");
  const nth = optionalNonNegativeInteger(raw, "nth");
  const target = targetByKind(raw);
  return nth === undefined ? target : { ...target, nth };
}

function targetByKind(raw: Params): Target {
  if (raw.kind === "role") return roleTarget(raw);
  const kind = SIMPLE_LOCATOR_KINDS.find((candidate) => candidate === raw.kind);
  if (kind === undefined) throw invalid("target.kind must be one of: role, label, text, placeholder, testid, selector");
  return simpleTarget(kind, nonEmpty(raw, kind));
}

function roleTarget(raw: Params): Target {
  const role = nonEmpty(raw, "role");
  const name = optionalString(raw, "name");
  return name === undefined ? { kind: "role", role } : { kind: "role", role, name };
}

function nonEmpty(raw: Params, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value === "") throw invalid(`target.${key} must be a non-empty string`);
  return value;
}
