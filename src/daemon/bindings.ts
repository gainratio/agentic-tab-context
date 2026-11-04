/**
 * `atc bindings`: a read-only view of every open context in the registry.
 * Listing is always safe: it never discovers, binds, or acts on a tab.
 */
import type { OkResponse } from "../contracts/protocol.js";
import type { BindingFilter, BindingView, TabContext } from "../contracts/types.js";
import { type Params, definedOnly, optionalBrowser, optionalString } from "./params.js";
import { redactText, redactUrl } from "./redaction.js";
import type { ContextRegistry } from "./registry.js";

export interface BindingList {
  current: string | null;
  bindings: BindingView[];
}

/** Handler for `atc bindings`: validate the filters, then list the registry snapshot. */
export function bindingsResponse(registry: ContextRegistry, params: Params): OkResponse {
  const filter = definedOnly<BindingFilter>({
    query: optionalString(params, "query"),
    browser: optionalBrowser(params),
  });
  return { ok: true, ...listBindings(registry, filter) };
}

/** Open contexts in registry (createdAt, id) order, optionally filtered, with no guessed fields. */
export function listBindings(registry: ContextRegistry, filter: BindingFilter = {}): BindingList {
  const current = registry.current;
  const bindings = registry
    .list()
    .filter((ctx) => ctx.status === "open")
    .filter((ctx) => matchesFilter(ctx, filter))
    .map((ctx) => toBinding(ctx, current));
  return { current, bindings };
}

function toBinding(ctx: TabContext, current: string | null): BindingView {
  return {
    context: ctx.id,
    tabId: ctx.tabId ?? null,
    browser: ctx.browser,
    source: ctx.source ?? null,
    url: ctx.url === undefined ? null : redactUrl(ctx.url),
    title: ctx.title === undefined ? null : redactText(ctx.title),
    current: ctx.id === current,
  };
}

function matchesFilter(ctx: TabContext, filter: BindingFilter): boolean {
  if (filter.browser !== undefined && ctx.browser !== filter.browser) return false;
  if (filter.query === undefined) return true;
  const needle = filter.query.toLowerCase();
  return (
    includesIgnoreCase(ctx.title, needle) ||
    includesIgnoreCase(ctx.url, needle) ||
    includesIgnoreCase(hostnameOf(ctx.url), needle)
  );
}

function includesIgnoreCase(value: string | undefined, needle: string): boolean {
  return value !== undefined && value.toLowerCase().includes(needle);
}

function hostnameOf(url: string | undefined): string {
  if (url === undefined) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
