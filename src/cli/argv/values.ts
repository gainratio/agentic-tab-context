/**
 * Typed readers for parsed flags and positionals: context ids, browsers, integers, targets.
 */
import { CONTEXT_ID_PATTERN } from "../../contracts/patterns.js";
import { BROWSERS, type BrowserName, type Target, simpleTarget } from "../../contracts/types.js";
import { type FlagName, LOCATOR_FLAGS, type LocatorFlag, NON_NEGATIVE_INT, type Parsed, invalid } from "./grammar.js";

export function nonEmpty(parsed: Parsed, flag: FlagName): string | undefined {
  const value = parsed.values.get(flag);
  if (value === "") invalid(`${parsed.command}: --${flag} must not be empty`);
  return value;
}

export function parseNonNegativeInt(command: string, flag: string, raw: string): number {
  const value = Number(raw);
  if (!NON_NEGATIVE_INT.test(raw) || !Number.isSafeInteger(value)) {
    invalid(`${command}: --${flag} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

export function intFlag(parsed: Parsed, flag: FlagName): number | undefined {
  const raw = parsed.values.get(flag);
  return raw === undefined ? undefined : parseNonNegativeInt(parsed.command, flag, raw);
}

export function checkContextId(command: string, what: string, id: string): string {
  if (!CONTEXT_ID_PATTERN.test(id)) {
    invalid(`${command}: ${what} must look like ctx_<hex> (e.g. ctx_7f21), got "${id}"`);
  }
  return id;
}

export function contextFlag(parsed: Parsed): { context?: string } {
  const id = parsed.values.get("context");
  return id === undefined ? {} : { context: checkContextId(parsed.command, "--context", id) };
}

export function checkBrowser(command: string, raw: string): BrowserName {
  if (!(BROWSERS as readonly string[]).includes(raw)) {
    invalid(`${command}: unknown browser "${raw}"; expected one of ${BROWSERS.join(", ")}`);
  }
  return raw as BrowserName;
}

export function positional(parsed: Parsed, index: number): string | undefined {
  return parsed.positionals[index];
}

export function requiredPositional(parsed: Parsed, index: number, name: string): string {
  const value = positional(parsed, index);
  if (value === undefined || value === "") invalid(`${parsed.command}: missing required <${name}>`);
  return value;
}

export function pickLocator(parsed: Parsed): LocatorFlag {
  const present = LOCATOR_FLAGS.filter((flag) => parsed.values.has(flag));
  const options = LOCATOR_FLAGS.map((flag) => `--${flag}`).join(", ");
  if (present.length === 0) invalid(`${parsed.command}: a target is required; pass exactly one of ${options}`);
  const [only, ...rest] = present;
  if (only === undefined || rest.length > 0) {
    invalid(`${parsed.command}: pass exactly one locator flag, got ${present.map((f) => `--${f}`).join(", ")}`);
  }
  return only;
}

export function baseTarget(parsed: Parsed, locator: LocatorFlag): Target {
  const value = nonEmpty(parsed, locator) ?? "";
  if (locator !== "role") return simpleTarget(locator, value);
  const name = nonEmpty(parsed, "name");
  return name === undefined ? { kind: "role", role: value } : { kind: "role", role: value, name };
}

export function parseTarget(parsed: Parsed): Target {
  const locator = pickLocator(parsed);
  if (locator !== "role" && parsed.values.has("name")) {
    invalid(`${parsed.command}: --name is only valid together with --role`);
  }
  const target = baseTarget(parsed, locator);
  const within = nonEmpty(parsed, "within");
  const scoped = within === undefined ? target : { ...target, within };
  const nth = intFlag(parsed, "nth");
  return nth === undefined ? scoped : { ...scoped, nth };
}

export function requiredValue(parsed: Parsed): string {
  const value = parsed.values.get("value");
  if (value === undefined) invalid(`${parsed.command}: missing required --value`);
  return value;
}
