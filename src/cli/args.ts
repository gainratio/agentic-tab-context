/**
 * Strict, dependency-free argv parser for the abt / tabctx CLI.
 */
import { resolve } from "node:path";
import { TabCtxError } from "../contracts/errors.js";
import { CONTEXT_ID_PATTERN, PROFILE_PATTERN } from "../contracts/patterns.js";
import type { Request } from "../contracts/protocol.js";
import { BROWSERS, type BindOptions, type BrowserName, type Target } from "../contracts/types.js";

export interface HelpRequest {
  help: true;
}

export interface SetupRequest {
  setup: true;
}

export type ParseResult = Request | HelpRequest | SetupRequest;

const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;

type FlagKind = "string" | "boolean";

const FLAG_KINDS = {
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
  browser: "string",
  query: "string",
  url: "string",
  title: "string",
  tab: "string",
  active: "boolean",
} as const satisfies Record<string, FlagKind>;

type FlagName = keyof typeof FLAG_KINDS;

const SHORT_ALIASES: Readonly<Record<string, FlagName>> = { c: "context", q: "query", b: "browser", a: "active" };

const LOCATOR_FLAGS = ["role", "label", "text", "placeholder", "testid", "selector"] as const;
type LocatorFlag = (typeof LOCATOR_FLAGS)[number];
const TARGET_FLAGS: readonly FlagName[] = [...LOCATOR_FLAGS, "name", "nth"];

interface Parsed {
  command: string;
  positionals: string[];
  values: Map<FlagName, string>;
  booleans: Set<FlagName>;
}

interface CommandSpec {
  positionals: readonly string[];
  flags: readonly FlagName[];
  build: (parsed: Parsed) => ParseResult;
}

function invalid(message: string): never {
  throw new TabCtxError("INVALID_ARGUMENT", message);
}

function nonEmpty(parsed: Parsed, flag: FlagName): string | undefined {
  const value = parsed.values.get(flag);
  if (value === "") invalid(`${parsed.command}: --${flag} must not be empty`);
  return value;
}

function parseNonNegativeInt(command: string, flag: string, raw: string): number {
  const value = Number(raw);
  if (!NON_NEGATIVE_INT.test(raw) || !Number.isSafeInteger(value)) {
    invalid(`${command}: --${flag} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function intFlag(parsed: Parsed, flag: FlagName): number | undefined {
  const raw = parsed.values.get(flag);
  return raw === undefined ? undefined : parseNonNegativeInt(parsed.command, flag, raw);
}

function checkContextId(command: string, what: string, id: string): string {
  if (!CONTEXT_ID_PATTERN.test(id)) {
    invalid(`${command}: ${what} must look like ctx_<hex> (e.g. ctx_7f21), got "${id}"`);
  }
  return id;
}

function contextFlag(parsed: Parsed): { context?: string } {
  const id = parsed.values.get("context");
  return id === undefined ? {} : { context: checkContextId(parsed.command, "--context", id) };
}

function checkBrowser(command: string, raw: string): BrowserName {
  if (!(BROWSERS as readonly string[]).includes(raw)) {
    invalid(`${command}: unknown browser "${raw}"; expected one of ${BROWSERS.join(", ")}`);
  }
  return raw as BrowserName;
}

function positional(parsed: Parsed, index: number): string | undefined {
  return parsed.positionals[index];
}

function requiredPositional(parsed: Parsed, index: number, name: string): string {
  const value = positional(parsed, index);
  if (value === undefined || value === "") invalid(`${parsed.command}: missing required <${name}>`);
  return value;
}

function pickLocator(parsed: Parsed): LocatorFlag {
  const present = LOCATOR_FLAGS.filter((flag) => parsed.values.has(flag));
  const options = LOCATOR_FLAGS.map((flag) => `--${flag}`).join(", ");
  if (present.length === 0) invalid(`${parsed.command}: a target is required; pass exactly one of ${options}`);
  const [only, ...rest] = present;
  if (only === undefined || rest.length > 0) {
    invalid(`${parsed.command}: pass exactly one locator flag, got ${present.map((f) => `--${f}`).join(", ")}`);
  }
  return only;
}

function baseTarget(parsed: Parsed, locator: LocatorFlag): Target {
  const value = nonEmpty(parsed, locator) ?? "";
  switch (locator) {
    case "role": {
      const name = nonEmpty(parsed, "name");
      return name === undefined ? { kind: "role", role: value } : { kind: "role", role: value, name };
    }
    case "label":
      return { kind: "label", label: value };
    case "text":
      return { kind: "text", text: value };
    case "placeholder":
      return { kind: "placeholder", placeholder: value };
    case "testid":
      return { kind: "testid", testid: value };
    case "selector":
      return { kind: "selector", selector: value };
  }
}

function parseTarget(parsed: Parsed): Target {
  const locator = pickLocator(parsed);
  if (locator !== "role" && parsed.values.has("name")) {
    invalid(`${parsed.command}: --name is only valid together with --role`);
  }
  const target = baseTarget(parsed, locator);
  const nth = intFlag(parsed, "nth");
  return nth === undefined ? target : { ...target, nth };
}

function requiredValue(parsed: Parsed): string {
  const value = parsed.values.get("value");
  if (value === undefined) invalid(`${parsed.command}: missing required --value`);
  return value;
}

function buildOpen(parsed: Parsed): Request {
  const browser = checkBrowser("open", requiredPositional(parsed, 0, "browser"));
  const params: { browser: BrowserName; profile?: string; headless?: boolean; use?: boolean } = { browser };
  const profile = nonEmpty(parsed, "profile");
  if (profile !== undefined) {
    if (!PROFILE_PATTERN.test(profile)) {
      invalid(`open: --profile must match ${PROFILE_PATTERN.source}, got "${profile}"`);
    }
    params.profile = profile;
  }
  if (parsed.booleans.has("headless")) params.headless = true;
  if (parsed.booleans.has("use")) params.use = true;
  return { method: "open", params };
}

function buildTabs(parsed: Parsed): Request {
  const rawBrowser = nonEmpty(parsed, "browser");
  const browser = rawBrowser === undefined ? undefined : checkBrowser("tabs", rawBrowser);
  const query = nonEmpty(parsed, "query") ?? positional(parsed, 0);
  return {
    method: "tabs",
    params: {
      ...(browser === undefined ? {} : { browser }),
      ...(query === undefined || query === "" ? {} : { query }),
      ...(parsed.booleans.has("active") ? { active: true } : {}),
    },
  };
}

function buildBind(parsed: Parsed): Request {
  const rawBrowser = nonEmpty(parsed, "browser");
  const browser = rawBrowser === undefined ? undefined : checkBrowser("bind", rawBrowser);
  const tab = nonEmpty(parsed, "tab");
  const query = nonEmpty(parsed, "query") ?? positional(parsed, 0);
  const url = nonEmpty(parsed, "url");
  const title = nonEmpty(parsed, "title");
  const params: BindOptions = {
    ...(tab === undefined ? {} : { tab }),
    ...(query === undefined || query === "" ? {} : { query }),
    ...(url === undefined ? {} : { url }),
    ...(title === undefined ? {} : { title }),
    ...(browser === undefined ? {} : { browser }),
    ...(parsed.booleans.has("active") ? { active: true } : {}),
    ...(parsed.booleans.has("use") ? { use: true } : {}),
  };
  return { method: "bind", params };
}

function buildClose(parsed: Parsed): Request {
  const id = positional(parsed, 0);
  if (id !== undefined && parsed.values.has("context")) {
    invalid("close: pass the context either positionally or with --context, not both");
  }
  if (id === undefined) return { method: "close", params: contextFlag(parsed) };
  return { method: "close", params: { context: checkContextId("close", "<ctx>", id) } };
}

function buildGoto(parsed: Parsed): Request {
  const url = requiredPositional(parsed, 0, "url");
  return { method: "goto", params: { ...contextFlag(parsed), url } };
}

function buildScreenshot(parsed: Parsed): Request {
  const params: { context?: string; out?: string; fullPage?: boolean } = contextFlag(parsed);
  const out = nonEmpty(parsed, "out");
  if (out !== undefined) params.out = resolve(out);
  if (parsed.booleans.has("full-page")) params.fullPage = true;
  return { method: "screenshot", params };
}

function buildLog(method: "console" | "network"): (parsed: Parsed) => Request {
  return (parsed) => {
    const since = intFlag(parsed, "since");
    const params = contextFlag(parsed);
    return { method, params: since === undefined ? params : { ...params, since } };
  };
}

function buildHistory(method: "back" | "forward" | "reload"): (parsed: Parsed) => Request {
  return (parsed) => ({ method, params: contextFlag(parsed) });
}

function buildFill(method: "type" | "select"): (parsed: Parsed) => Request {
  return (parsed) => {
    const target = parseTarget(parsed);
    return { method, params: { ...contextFlag(parsed), target, value: requiredValue(parsed) } };
  };
}

const PAGE: readonly FlagName[] = ["context"];

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  open: { positionals: ["browser"], flags: ["profile", "headless", "use"], build: buildOpen },
  tabs: { positionals: ["query?"], flags: ["browser", "query", "active"], build: buildTabs },
  bind: {
    positionals: ["query?"],
    flags: ["query", "url", "title", "browser", "tab", "active", "use"],
    build: buildBind,
  },
  list: { positionals: [], flags: [], build: () => ({ method: "list", params: {} }) },
  use: {
    positionals: ["ctx"],
    flags: [],
    build: (p) => ({ method: "use", params: { context: checkContextId("use", "<ctx>", requiredPositional(p, 0, "ctx")) } }),
  },
  current: { positionals: [], flags: [], build: () => ({ method: "current", params: {} }) },
  close: { positionals: ["ctx?"], flags: PAGE, build: buildClose },
  goto: { positionals: ["url"], flags: PAGE, build: buildGoto },
  back: { positionals: [], flags: PAGE, build: buildHistory("back") },
  forward: { positionals: [], flags: PAGE, build: buildHistory("forward") },
  reload: { positionals: [], flags: PAGE, build: buildHistory("reload") },
  inspect: { positionals: [], flags: PAGE, build: (p) => ({ method: "inspect", params: contextFlag(p) }) },
  screenshot: { positionals: [], flags: [...PAGE, "out", "full-page"], build: buildScreenshot },
  console: { positionals: [], flags: [...PAGE, "since"], build: buildLog("console") },
  network: { positionals: [], flags: [...PAGE, "since"], build: buildLog("network") },
  click: {
    positionals: [],
    flags: [...PAGE, ...TARGET_FLAGS],
    build: (p) => ({ method: "click", params: { ...contextFlag(p), target: parseTarget(p) } }),
  },
  type: { positionals: [], flags: [...PAGE, ...TARGET_FLAGS, "value"], build: buildFill("type") },
  select: { positionals: [], flags: [...PAGE, ...TARGET_FLAGS, "value"], build: buildFill("select") },
  doctor: { positionals: [], flags: [], build: () => ({ method: "doctor", params: {} }) },
  setup: { positionals: [], flags: [], build: () => ({ setup: true }) },
  shutdown: { positionals: [], flags: [], build: () => ({ method: "shutdown", params: {} }) },
};

export const COMMAND_NAMES: readonly string[] = [...Object.keys(COMMANDS), "help"];

const HELP_TOKENS = new Set(["--help", "-h"]);
class HelpSignal {}

interface FlagToken {
  flag: FlagName;
  inline: string | undefined;
  spelling: string;
}

function isFlagLike(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

function splitFlag(command: string, token: string, allowed: readonly FlagName[]): FlagToken {
  const eq = token.indexOf("=");
  const spelling = eq === -1 ? token : token.slice(0, eq);
  const inline = eq === -1 ? undefined : token.slice(eq + 1);
  const short = spelling.slice(1);
  const name = spelling.startsWith("--")
    ? spelling.slice(2)
    : Object.hasOwn(SHORT_ALIASES, short)
      ? SHORT_ALIASES[short]
      : undefined;
  if (name === undefined || !Object.hasOwn(FLAG_KINDS, name) || !allowed.includes(name as FlagName)) {
    invalid(`${command}: unknown flag ${spelling}`);
  }
  return { flag: name as FlagName, inline, spelling };
}

function takeValue(command: string, token: FlagToken, next: string | undefined): string {
  if (token.inline !== undefined) return token.inline;
  if (
    next === undefined ||
    next.startsWith("--") ||
    next === "-c" ||
    next === "-q" ||
    next === "-b" ||
    next === "-a" ||
    HELP_TOKENS.has(next)
  ) {
    invalid(`${command}: ${token.spelling} requires a value (use ${token.spelling}=VALUE for values starting with "--")`);
  }
  return next;
}

function recordFlag(parsed: Parsed, token: FlagToken, next: string | undefined): number {
  if (parsed.values.has(token.flag) || parsed.booleans.has(token.flag)) {
    invalid(`${parsed.command}: duplicate flag --${token.flag}`);
  }
  if (FLAG_KINDS[token.flag] === "boolean") {
    if (token.inline !== undefined) invalid(`${parsed.command}: ${token.spelling} does not take a value`);
    parsed.booleans.add(token.flag);
    return 0;
  }
  parsed.values.set(token.flag, takeValue(parsed.command, token, next));
  return token.inline === undefined ? 1 : 0;
}

function tokenize(command: string, args: readonly string[], spec: CommandSpec): Parsed {
  const parsed: Parsed = { command, positionals: [], values: new Map(), booleans: new Set() };
  let onlyPositionals = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (onlyPositionals || !isFlagLike(token)) {
      parsed.positionals.push(token);
    } else if (token === "--") {
      onlyPositionals = true;
    } else if (HELP_TOKENS.has(token)) {
      throw new HelpSignal();
    } else {
      i += recordFlag(parsed, splitFlag(command, token, spec.flags), args[i + 1]);
    }
  }
  return parsed;
}

function checkPositionalCount(parsed: Parsed, spec: CommandSpec): void {
  const max = spec.positionals.length;
  if (parsed.positionals.length > max) {
    const extra = parsed.positionals[max] ?? "";
    invalid(`${parsed.command}: unexpected argument "${extra}"`);
  }
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || HELP_TOKENS.has(command)) {
    if (rest.length > 0) invalid(`help: unexpected argument "${rest[0] ?? ""}"`);
    return { help: true };
  }
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (spec === undefined) invalid(`unknown command "${command}"; run "abt help" for usage`);
  try {
    const parsed = tokenize(command, rest, spec);
    checkPositionalCount(parsed, spec);
    return spec.build(parsed);
  } catch (error) {
    if (error instanceof HelpSignal) return { help: true };
    throw error;
  }
}

export const USAGE: readonly string[] = [
  "abt bind [query] [--query Q] [--url U] [--title T] [--browser B] [--tab ID] [--active] [--use]   bind to an already-open tab",
  "abt tabs [--browser B] [--query Q]   list all open tabs across Chrome, Safari, Firefox, Brave, Edge, and Extension",
  "tabctx open <browser> [--profile P] [--headless] [--use]   browser: chromium | chrome | brave | edge | firefox | safari | webkit | extension",
  "tabctx list",
  "tabctx use <ctx>",
  "tabctx current",
  "tabctx close [ctx] [--context C]",
  "tabctx goto <url> [--context C]   relative URLs resolve against the current page",
  "tabctx back | forward | reload [--context C]",
  "tabctx inspect [--context C]",
  "tabctx screenshot [--out F] [--full-page] [--context C]",
  "tabctx console [--since N] [--context C]",
  "tabctx network [--since N] [--context C]",
  "tabctx click <target> [--context C]",
  "tabctx type <target> --value V [--context C]",
  "tabctx select <target> --value V [--context C]",
  "abt setup   install the agentic-browser-tab skill for Claude Code, Codex, and Antigravity",
  "abt doctor   check browser executables, live tabs, extension bridge, and daemon status",
  "tabctx shutdown   stop the background daemon",
  "tabctx help",
  "target: exactly one of --role R [--name N] | --label L | --text T | --placeholder P | --testid ID | --selector CSS, plus optional --nth N (0-based)",
  "matching is exact and visible-only; ambiguity fails with AMBIGUOUS_TARGET, absence with TARGET_NOT_FOUND",
  "flags accept --flag value or --flag=value; -c is short for --context; -- ends flag parsing",
  "output: exactly one JSON object on stdout; exit code 0 iff ok is true",
];
