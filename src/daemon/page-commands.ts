/**
 * Page-level commands on a resolved context: navigation, inspect, actions,
 * screenshots, and console/network reads.
 */
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { AtcError } from "../contracts/errors.js";
import type { Method, OkResponse, Paths } from "../contracts/protocol.js";
import type { BrowserDriver, BrowserSession, TabContext } from "../contracts/types.js";
import { type Params, optionalBoolean, optionalNonNegativeInteger, optionalString, requireString, requireTarget } from "./params.js";
import type { ContextRegistry } from "./registry.js";
import { fileTimestamp } from "./responses.js";
import { isRelativeUrl, resolveGotoUrl } from "./url.js";

export interface Resolved {
  ctx: TabContext;
  session: BrowserSession;
  driver: BrowserDriver;
}

export type Handler = (params: Params) => Promise<OkResponse>;
export type PageMethod = "goto" | "back" | "forward" | "reload" | "inspect" | "screenshot" | "console" | "network" | "click" | "type" | "select";
type DriverOp<T> = (driver: BrowserDriver, session: BrowserSession, params: Params) => Promise<T>;
type EntriesOp = (driver: BrowserDriver, session: BrowserSession, since: number) => Promise<Array<{ seq: number }>>;

export interface PageDeps {
  registry: ContextRegistry;
  paths: Paths;
  now: () => Date;
  resolve: (params: Params) => Resolved;
}

/** Record the tab's latest URL/title; a stale value in `atc list` is harmless, so failures are ignored. */
export async function refreshLocation(registry: ContextRegistry, id: string, driver: BrowserDriver, session: BrowserSession): Promise<void> {
  try {
    registry.updateLocation(id, await driver.location(session));
  } catch {
    // Location is informational only.
  }
}

export class PageCommands {
  constructor(private readonly deps: PageDeps) {}

  handlers(): Record<PageMethod, Handler> & Partial<Record<Method, Handler>> {
    return {
      goto: (p) => this.goto(p),
      back: (p) => this.navigate(p, (d, s) => d.back(s)),
      forward: (p) => this.navigate(p, (d, s) => d.forward(s)),
      reload: (p) => this.navigate(p, (d, s) => d.reload(s)),
      inspect: (p) => this.inspect(p),
      screenshot: (p) => this.screenshot(p),
      console: (p) => this.logEntries(p, (d, s, since) => d.console(s, since)),
      network: (p) => this.logEntries(p, (d, s, since) => d.network(s, since)),
      click: (p) => this.act(p, (d, s, r) => d.click(s, requireTarget(r))),
      type: (p) => this.act(p, (d, s, r) => d.type(s, requireTarget(r), requireString(r, "value"))),
      select: (p) => this.act(p, (d, s, r) => d.select(s, requireTarget(r), requireString(r, "value"))),
    };
  }

  private async goto(params: Params): Promise<OkResponse> {
    const url = requireString(params, "url");
    const resolved = this.deps.resolve(params);
    const base = isRelativeUrl(url) ? await currentUrl(resolved) : undefined;
    const target = resolveGotoUrl(url, base);
    return this.navigate(params, (d, s) => d.navigate(s, target), resolved);
  }

  private async navigate(params: Params, op: DriverOp<void>, pre?: Resolved): Promise<OkResponse> {
    const { ctx, driver, session } = pre ?? this.deps.resolve(params);
    await op(driver, session, params);
    const loc = await driver.location(session);
    this.deps.registry.updateLocation(ctx.id, loc);
    return { ok: true, context: ctx.id, url: loc.url, title: loc.title };
  }

  private async inspect(params: Params): Promise<OkResponse> {
    const { ctx, driver, session } = this.deps.resolve(params);
    const state = await driver.inspect(session);
    this.deps.registry.updateLocation(ctx.id, { url: state.url, title: state.title });
    return { ok: true, context: ctx.id, url: state.url, title: state.title, aria: state.aria };
  }

  private async screenshot(params: Params): Promise<OkResponse> {
    const out = optionalString(params, "out");
    const { ctx, driver, session } = this.deps.resolve(params);
    if (out !== undefined && !isAbsolute(out)) throw new AtcError("INVALID_ARGUMENT", "out must be an absolute path");
    const path = out ?? join(this.deps.paths.screenshots, `${ctx.id}-${fileTimestamp(this.deps.now())}.png`);
    await mkdir(dirname(path), { recursive: true });
    const result = await driver.screenshot(session, path, optionalBoolean(params, "fullPage") ?? false);
    return { ok: true, context: ctx.id, path: result.path, bytes: result.bytes };
  }

  private async logEntries(params: Params, fetch: EntriesOp): Promise<OkResponse> {
    const since = optionalNonNegativeInteger(params, "since") ?? 0;
    const { ctx, driver, session } = this.deps.resolve(params);
    const entries = await fetch(driver, session, since);
    return { ok: true, context: ctx.id, entries, next: entries.at(-1)?.seq ?? since };
  }

  private async act(params: Params, op: DriverOp<{ matched: number }>): Promise<OkResponse> {
    const { ctx, driver, session } = this.deps.resolve(params);
    const result = await op(driver, session, params);
    await refreshLocation(this.deps.registry, ctx.id, driver, session);
    return { ok: true, context: ctx.id, matched: result.matched };
  }
}

async function currentUrl({ ctx, driver, session }: Resolved): Promise<string | undefined> {
  const loc = await driver.location(session);
  return loc.url === "" ? ctx.url : loc.url;
}
