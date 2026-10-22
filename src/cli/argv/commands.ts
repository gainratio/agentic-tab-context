/**
 * One builder per CLI command: validated positionals and flags -> one daemon Request.
 */
import { resolve } from "node:path";
import { PROFILE_PATTERN } from "../../contracts/patterns.js";
import type { Request } from "../../contracts/protocol.js";
import type { BindOptions, BrowserName } from "../../contracts/types.js";
import { definedOnly } from "../../daemon/params.js";
import { type CommandSpec, type FlagName, type Parsed, TARGET_FLAGS, invalid } from "./grammar.js";
import { checkBrowser, checkContextId, contextFlag, intFlag, nonEmpty, parseTarget, positional, requiredPositional, requiredValue } from "./values.js";

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

/** Shared by `tabs` and `bind`: an optional positional query plus the tab filters. */
function tabFilter(parsed: Parsed): BindOptions {
  const rawBrowser = nonEmpty(parsed, "browser");
  const query = nonEmpty(parsed, "query") ?? positional(parsed, 0);
  return definedOnly<BindOptions>({
    tab: nonEmpty(parsed, "tab"),
    query: query === "" ? undefined : query,
    url: nonEmpty(parsed, "url"),
    title: nonEmpty(parsed, "title"),
    browser: rawBrowser === undefined ? undefined : checkBrowser(parsed.command, rawBrowser),
    active: parsed.booleans.has("active") ? true : undefined,
    use: parsed.booleans.has("use") ? true : undefined,
  });
}

function buildTabs(parsed: Parsed): Request {
  return { method: "tabs", params: tabFilter(parsed) };
}

function buildBind(parsed: Parsed): Request {
  return { method: "bind", params: tabFilter(parsed) };
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

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
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
