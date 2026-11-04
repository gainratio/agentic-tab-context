/**
 * Strict validation for the side-panel ↔ daemon messages. Pure functions so the
 * service worker and unit tests share one definition of a valid request/reply.
 *
 * Wire contract: docs/ATC-EXTENSION-CONTRACT.md.
 */

const REQUEST_REPLY_TYPES = Object.freeze({
  bindings: "bindings",
  share: "shared",
  unshare: "unshared",
  activate: "activated",
});

const REPLY_TYPES = new Set(Object.values(REQUEST_REPLY_TYPES));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isContext(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= 1024;
}

function optionalString(value) {
  return value === undefined || typeof value === "string";
}

function nullableString(value) {
  return value === null || typeof value === "string";
}

export function responseTypeFor(type) {
  return Object.hasOwn(REQUEST_REPLY_TYPES, type) ? REQUEST_REPLY_TYPES[type] : undefined;
}

/**
 * Normalize a message received from a side-panel/popup page. Unknown or
 * malformed messages return undefined and are ignored by the worker.
 */
export function parseSidepanelMessage(message) {
  if (!isRecord(message) || typeof message.type !== "string") return undefined;
  return parseKnownMessage(message);
}

function parseKnownMessage(message) {
  if (message.type === "atc:bindings") return { type: "atc:bindings" };
  if (message.type === "atc:share") return parseShareMessage(message);
  if (message.type === "atc:unshare") return parseContextMessage("atc:unshare", message);
  if (message.type === "atc:activate") return parseContextMessage("atc:activate", message);
  if (message.type === "atc:open-sidepanel") return parseOpenSidepanelMessage(message);
  return undefined;
}

function parseShareMessage(message) {
  return isPositiveId(message.tabId) ? { type: "atc:share", tabId: message.tabId } : undefined;
}

function parseContextMessage(type, message) {
  return isContext(message.context) ? { type, context: message.context } : undefined;
}

function parseOpenSidepanelMessage(message) {
  if (message.windowId === undefined) return { type: "atc:open-sidepanel", windowId: undefined };
  return isPositiveId(message.windowId) ? { type: "atc:open-sidepanel", windowId: message.windowId } : undefined;
}

function normalizeBinding(raw) {
  if (!isRecord(raw)) return undefined;
  if (!isContext(raw.context) || !nullableString(raw.tabId) || !nullableString(raw.source)) return undefined;
  if (typeof raw.browser !== "string" || typeof raw.current !== "boolean") return undefined;
  if (raw.tabId === undefined || raw.source === undefined) return undefined;
  if (raw.url !== undefined && raw.url !== null && typeof raw.url !== "string") return undefined;
  if (raw.title !== undefined && raw.title !== null && typeof raw.title !== "string") return undefined;
  return {
    context: raw.context,
    tabId: raw.tabId === null ? null : raw.tabId,
    browser: raw.browser,
    source: raw.source === null ? null : raw.source,
    url: typeof raw.url === "string" ? raw.url : null,
    title: typeof raw.title === "string" ? raw.title : null,
    current: raw.current,
  };
}

/**
 * Validate one daemon reply against the request type that is waiting for it.
 * Returns undefined for malformed replies so the caller can settle that request
 * with a clear error (never trust a partial response).
 */
export function normalizeDaemonReply(responseType, message) {
  if (!REPLY_TYPES.has(responseType)) return undefined;
  if (!isRecord(message) || message.type !== responseType) return undefined;
  const base = replyBase(responseType, message);
  if (base === undefined) return undefined;
  if (responseType === "bindings") return normalizeBindingsReply(base, message);
  return normalizeOutcomeReply(base, message);
}

function replyBase(responseType, message) {
  if (!isPositiveId(message.id) || typeof message.ok !== "boolean") return undefined;
  if (!optionalString(message.message) || !optionalString(message.error)) return undefined;
  return {
    type: responseType,
    id: message.id,
    ok: message.ok,
    ...(typeof message.message === "string" ? { message: message.message } : {}),
    ...(typeof message.error === "string" ? { error: message.error } : {}),
  };
}

function normalizeBindingsReply(base, message) {
  if (!Array.isArray(message.bindings)) return undefined;
  if (message.current !== null && typeof message.current !== "string") return undefined;
  const bindings = normalizeBindingList(message.bindings);
  if (bindings === undefined) return undefined;
  return { ...base, current: message.current, bindings };
}

function normalizeBindingList(rawBindings) {
  const bindings = [];
  for (const raw of rawBindings) {
    const binding = normalizeBinding(raw);
    if (binding === undefined) return undefined;
    bindings.push(binding);
  }
  return bindings;
}

function normalizeOutcomeReply(base, message) {
  if (!optionalString(message.context)) return undefined;
  return {
    ...base,
    ...(typeof message.context === "string" ? { context: message.context } : {}),
  };
}
