/**
 * Validation for untrusted messages arriving from the browser extension.
 * Anything malformed is dropped (returns undefined) rather than trusted.
 */
import {
  EXTENSION_BROWSERS,
  type ExtensionBrowser,
  type ExtensionTab,
  type ExtensionToDaemon,
} from "../../contracts/extension.js";

const INSTANCE_PATTERN = /^[0-9a-f]{8}$/;

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Side-panel requests and browser tab ids are positive integers, never 0. */
function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isContext(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseTab(raw: unknown): ExtensionTab | undefined {
  if (!isRaw(raw) || !isId(raw.id)) return undefined;
  return {
    id: raw.id,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : "",
    active: raw.active === true,
  };
}

function parseHello(raw: Raw): ExtensionToDaemon | undefined {
  const browser = raw.browser;
  const known = (EXTENSION_BROWSERS as readonly unknown[]).includes(browser);
  if (!known || typeof raw.instance !== "string" || !INSTANCE_PATTERN.test(raw.instance)) return undefined;
  const protocol = typeof raw.protocol === "number" && Number.isSafeInteger(raw.protocol) && raw.protocol > 0 ? raw.protocol : undefined;
  const version = typeof raw.version === "string" && raw.version.length <= 64 ? raw.version : undefined;
  return {
    type: "hello",
    browser: browser as ExtensionBrowser,
    instance: raw.instance,
    ...(protocol === undefined ? {} : { protocol }),
    ...(version === undefined ? {} : { version }),
  };
}

function parseTabs(raw: Raw): ExtensionToDaemon | undefined {
  if (!Array.isArray(raw.tabs)) return undefined;
  const tabs = raw.tabs.map(parseTab).filter((tab): tab is ExtensionTab => tab !== undefined);
  return { type: "tabs", tabs };
}

function parseResult(raw: Raw): ExtensionToDaemon | undefined {
  if (!isId(raw.id) || typeof raw.ok !== "boolean") return undefined;
  return {
    type: "result",
    id: raw.id,
    ok: raw.ok,
    result: raw.result,
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(typeof raw.message === "string" ? { message: raw.message } : {}),
  };
}

function parsePin(raw: Raw): ExtensionToDaemon | undefined {
  return isPositiveId(raw.id) && isPositiveId(raw.tabId) ? { type: "pin", id: raw.id, tabId: raw.tabId } : undefined;
}

function parseBindings(raw: Raw): ExtensionToDaemon | undefined {
  return isPositiveId(raw.id) ? { type: "bindings", id: raw.id } : undefined;
}

function parseShare(raw: Raw): ExtensionToDaemon | undefined {
  return isPositiveId(raw.id) && isPositiveId(raw.tabId) ? { type: "share", id: raw.id, tabId: raw.tabId } : undefined;
}

function parseUnshare(raw: Raw): ExtensionToDaemon | undefined {
  return isPositiveId(raw.id) && isContext(raw.context) ? { type: "unshare", id: raw.id, context: raw.context } : undefined;
}

function parseActivate(raw: Raw): ExtensionToDaemon | undefined {
  return isPositiveId(raw.id) && isContext(raw.context) ? { type: "activate", id: raw.id, context: raw.context } : undefined;
}

const PARSERS: Readonly<Record<string, (raw: Raw) => ExtensionToDaemon | undefined>> = {
  hello: parseHello,
  tabs: parseTabs,
  result: parseResult,
  pin: parsePin,
  bindings: parseBindings,
  share: parseShare,
  unshare: parseUnshare,
  activate: parseActivate,
};

export function parseExtensionMessage(line: string): ExtensionToDaemon | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRaw(raw) || typeof raw.type !== "string" || !Object.hasOwn(PARSERS, raw.type)) return undefined;
  return PARSERS[raw.type]?.(raw);
}
