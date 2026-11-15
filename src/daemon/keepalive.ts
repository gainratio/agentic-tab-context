/**
 * Keep-alive orchestration and background SSO/login redirect detection for open
 * contexts. Keeps state in memory alongside live BrowserSessions so `state.json`
 * never persists stale timers across daemon restarts.
 */
import { AtcError } from "../contracts/errors.js";
import type { OkResponse } from "../contracts/protocol.js";
import { KEEPALIVE_MODES, type KeepAliveMode, type LiveTab } from "../contracts/types.js";
import type { Resolved } from "./page-commands.js";
import { type Params, optionalString } from "./params.js";
import { redactUrl } from "./redaction.js";
import type { ContextRegistry } from "./registry.js";

const AUTH_HOST = /^(login|signin|sso|auth|id|idp)\.|(\.|^)(okta|auth0|onelogin|pingidentity|duosecurity)\.com$|^login\.microsoftonline\.com$|^accounts\.google\.com$/i;
const AUTH_PATH = /\/(login|log-in|signin|sign-in|sso|oauth2?|authorize|authenticate|reauth)(\/|$)/i;

export function isAuthScreenUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return AUTH_HOST.test(parsed.hostname) || AUTH_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isLoginRedirect(boundUrl: string | undefined, currentUrl: string | undefined): boolean {
  if (!boundUrl || !currentUrl) return false;
  return !isAuthScreenUrl(boundUrl) && isAuthScreenUrl(currentUrl);
}

export class KeepAliveTracker {
  private readonly active = new Map<string, string>();
  private readonly expired = new Set<string>();

  isEnabled(contextId: string): boolean {
    return this.active.has(contextId);
  }

  isExpired(contextId: string): boolean {
    return this.expired.has(contextId);
  }

  enable(contextId: string, currentUrl = ""): void {
    this.active.set(contextId, currentUrl);
    this.expired.delete(contextId);
  }

  disable(contextId: string): void {
    this.active.delete(contextId);
    this.expired.delete(contextId);
  }

  recordIntentionalUrl(contextId: string, url: string): void {
    if (!this.active.has(contextId)) return;
    this.active.set(contextId, url);
    this.expired.delete(contextId);
  }

  observeUrl(contextId: string, currentUrl: string | undefined): boolean {
    const baseline = this.active.get(contextId);
    if (baseline === undefined || !currentUrl) return false;
    if (baseline === "") { this.active.set(contextId, currentUrl); return false; }
    if (isLoginRedirect(baseline, currentUrl)) { this.expired.add(contextId); return true; }
    if (!isAuthScreenUrl(currentUrl)) this.expired.delete(contextId);
    return this.expired.has(contextId);
  }
}

export function parseKeepAliveMode(params: Params): KeepAliveMode {
  const mode = optionalString(params, "mode") ?? "status";
  if ((KEEPALIVE_MODES as readonly string[]).includes(mode)) return mode as KeepAliveMode;
  throw new AtcError("INVALID_ARGUMENT", `keepalive mode must be one of: ${KEEPALIVE_MODES.join(", ")}`);
}

export async function applyKeepAlive(
  resolved: Resolved,
  registry: ContextRegistry,
  tracker: KeepAliveTracker,
  enabled: boolean,
): Promise<OkResponse> {
  const { ctx, driver, session } = resolved;
  if (driver.setKeepAlive === undefined) {
    throw new AtcError("UNSUPPORTED_ACTION", `${ctx.source ?? ctx.browser} tabs do not support background keep-alive`);
  }
  const loc = await driver.location(session).catch(() => ({ url: ctx.url ?? "", title: ctx.title ?? "" }));
  if (loc.url !== "") registry.updateLocation(ctx.id, loc);
  await driver.setKeepAlive(session, enabled);
  if (enabled) tracker.enable(ctx.id, loc.url || ctx.url || "");
  else tracker.disable(ctx.id);
  return { ok: true, context: ctx.id, keepAlive: enabled, sessionExpired: false };
}

export async function keepAliveCommand(
  resolve: (params: Params) => Resolved,
  registry: ContextRegistry,
  tracker: KeepAliveTracker,
  params: Params,
): Promise<OkResponse> {
  const mode = parseKeepAliveMode(params);
  const resolved = resolve(params);
  if (mode !== "status") return applyKeepAlive(resolved, registry, tracker, mode === "on");
  const { ctx, driver, session } = resolved;
  const loc = await driver.location(session).catch(() => undefined);
  if (loc !== undefined) { registry.updateLocation(ctx.id, loc); tracker.observeUrl(ctx.id, loc.url); }
  return { ok: true, context: ctx.id, keepAlive: tracker.isEnabled(ctx.id), sessionExpired: tracker.isExpired(ctx.id) };
}

export async function assertSessionAlive(resolved: Resolved, registry: ContextRegistry, tracker: KeepAliveTracker): Promise<void> {
  const { ctx, driver, session } = resolved;
  if (!tracker.isEnabled(ctx.id)) return;
  const loc = await driver.location(session).catch(() => undefined);
  if (loc !== undefined) { registry.updateLocation(ctx.id, loc); tracker.observeUrl(ctx.id, loc.url); }
  if (!tracker.isExpired(ctx.id)) return;
  const currentUrl = loc?.url ?? ctx.url ?? "";
  throw new AtcError(
    "SESSION_EXPIRED",
    "the bound tab redirected to a sign-in page; sign in again in the browser or run `atc goto` to continue",
    { context: ctx.id, ...(currentUrl === "" ? {} : { url: redactUrl(currentUrl) }) },
  );
}

export function syncLiveTabs(registry: ContextRegistry, tracker: KeepAliveTracker, tabs: readonly LiveTab[]): void {
  for (const tab of tabs) {
    const ctx = registry.findOpenByTabId(tab.tabId);
    if (ctx === undefined) continue;
    registry.updateLocation(ctx.id, { url: tab.url, title: tab.title });
    tracker.observeUrl(ctx.id, tab.url);
  }
}
