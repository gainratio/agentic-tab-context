/**
 * The CLI grammar: every flag, its kind, short aliases, and the parse-result types.
 */
import { AtcError } from "../../contracts/errors.js";
import type { Request } from "../../contracts/protocol.js";

export interface HelpRequest {
  help: true;
}

export interface SetupRequest {
  setup: true;
}

export type ParseResult = Request | HelpRequest | SetupRequest;

export const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;

export type FlagKind = "string" | "boolean";

export const FLAG_KINDS = {
  profile: "string",
  headless: "boolean",
  use: "boolean",
  context: "string",
  out: "string",
  "full-page": "boolean",
  since: "string",
  value: "string",
  role: "string",
  name: "string",
  label: "string",
  text: "string",
  placeholder: "string",
  testid: "string",
  selector: "string",
  nth: "string",
  within: "string",
  browser: "string",
  query: "string",
  url: "string",
  title: "string",
  tab: "string",
  active: "boolean",
} as const satisfies Record<string, FlagKind>;

export type FlagName = keyof typeof FLAG_KINDS;

export const SHORT_ALIASES: Readonly<Record<string, FlagName>> = { c: "context", q: "query", b: "browser", a: "active" };

export const LOCATOR_FLAGS = ["role", "label", "text", "placeholder", "testid", "selector"] as const;
export type LocatorFlag = (typeof LOCATOR_FLAGS)[number];
export const TARGET_FLAGS: readonly FlagName[] = [...LOCATOR_FLAGS, "name", "nth", "within"];

export interface Parsed {
  command: string;
  positionals: string[];
  values: Map<FlagName, string>;
  booleans: Set<FlagName>;
}

export interface CommandSpec {
  positionals: readonly string[];
  flags: readonly FlagName[];
  build: (parsed: Parsed) => ParseResult;
}

export function invalid(message: string): never {
  throw new AtcError("INVALID_ARGUMENT", message);
}
