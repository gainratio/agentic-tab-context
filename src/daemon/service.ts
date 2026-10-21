/**
 * DaemonService: maps protocol requests onto the registry and browser drivers.
 * Every outcome is a `Response`; nothing throws out of `handle`.
 */
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { TabCtxError, isTabCtxError } from "../contracts/errors.js";
import type { ErrorResponse, Method, OkResponse, Paths, Request, Response } from "../contracts/protocol.js";
import type { BrowserDriver, BrowserName, BrowserSession, DriverFactory, LiveTab, TabContext } from "../contracts/types.js";
import type { ExtensionBridge } from "../drivers/extension/bridge.js";
import { detectInstalledBrowsers } from "../drivers/playwright/executables.js";
import {
  type Params,
  isRecord,
  optionalBoolean,
  optionalBrowser,
  optionalNonNegativeInteger,
  optionalString,
  parseBindOptions,
  profileParam,
  requireBrowser,
  requireString,
  requireTarget,
} from "./params.js";
import type { ContextRegistry } from "./registry.js";
import { collectAllTabs, filterTabs, selectTabToBind } from "./tabs.js";
import { isRelativeUrl, resolveGotoUrl } from "./url.js";

export interface DaemonServiceDeps {
  registry: ContextRegistry;
  driverFactory: DriverFactory;
  paths: Paths;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  extensionBridge?: ExtensionBridge;
  extensionDriver?: BrowserDriver;
  macosDriver?: BrowserDriver;
}

export interface RoutedRequest {
  key: string | null;
  request: Request;
}

interface Resolved {
  ctx: TabContext;
  session: BrowserSession;
  driver: BrowserDriver;
}

type Handler = (params: Params) => Promise<OkResponse>;

const CONTEXT_METHODS: ReadonlySet<string> = new Set<Method>([
  "close", "goto", "back", "forward", "reload", "inspect", "screenshot",
  "console", "network", "click", "type", "select",
]);

const REDACTED = "[redacted]";

export class DaemonService {
  private readonly registry: ContextRegistry;
  private readonly driverFactory: DriverFactory;
  private readonly paths: Paths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly extensionBridge: ExtensionBridge | undefined;
  private readonly extensionDriver: BrowserDriver | undefined;
  private readonly macosDriver: BrowserDriver | undefined;
  private readonly drivers = new Map<BrowserName, BrowserDriver>();
  private readonly contextDrivers = new Map<string, BrowserDriver>();
  private readonly shutdownListeners: Array<() => void> = [];
  private readonly handlers: Record<Method, Handler>;

  constructor(deps: DaemonServiceDeps) {
    this.registry = deps.registry;
    this.driverFactory = deps.driverFactory;
    this.paths = deps.paths;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.extensionBridge = deps.extensionBridge;
    this.extensionDriver = deps.extensionDriver;
    this.macosDriver = deps.macosDriver;
    this.handlers = this.buildHandlers();
  }

  async handle(req: Request): Promise<Response> {
    const raw: unknown = req;
    const secret = typedValueOf(raw);
    try {
      const { method, params } = parseRequest(raw, this.handlers);
      return await this.handlers[method](params);
    } catch (err) {
      return redact(toErrorResponse(err), secret);
    }
  }

  route(req: Request): RoutedRequest {
    const raw: unknown = req;
    if (!isRecord(raw) || typeof raw.method !== "string" || !CONTEXT_METHODS.has(raw.method)) {
      return { key: null, request: req };
    }
    const params = isRecord(raw.params) ? raw.params : {};
    const explicit = params.context;
    if (typeof explicit === "string") return { key: explicit, request: req };
    const current = this.registry.current;
    if (current === null || explicit !== undefined) return { key: null, request: req };
    const pinned: unknown = { ...raw, params: { ...params, context: current } };
    return { key: current, request: pinned as Request };
  }

  onShutdown(listener: () => void): void {
    this.shutdownListeners.push(listener);
  }

  async closeAll(): Promise<void> {
    const open = this.registry.openSessions();
    await Promise.allSettled(open.map(({ id }) => this.closeContext(id)));
  }

  private buildHandlers(): Record<Method, Handler> {
    const nav = (op: NavOp): Handler => (p) => this.navigate(p, op);
    return {
      open: (p) => this.open(p),
      tabs: (p) => this.tabs(p),
      bind: (p) => this.bind(p),
      list: () => this.list(),
      use: (p) => this.use(p),
      current: () => this.currentContext(),
      close: (p) => this.close(p),
      goto: (p) => this.goto(p),
      back: nav((d, s) => d.back(s)),
      forward: nav((d, s) => d.forward(s)),
      reload: nav((d, s) => d.reload(s)),
      inspect: (p) => this.inspect(p),
      screenshot: (p) => this.screenshot(p),
      console: (p) => this.logEntries(p, (d, s, since) => d.console(s, since)),
      network: (p) => this.logEntries(p, (d, s, since) => d.network(s, since)),
      click: (p) => this.act(p, (d, s, r) => d.click(s, requireTarget(r))),
      type: (p) => this.act(p, (d, s, r) => d.type(s, requireTarget(r), requireString(r, "value"))),
      select: (p) => this.act(p, (d, s, r) => d.select(s, requireTarget(r), requireString(r, "value"))),
      doctor: () => this.doctor(),
      ping: () => Promise.resolve({ ok: true, pid: process.pid }),
      shutdown: () => this.shutdown(),
    };
  }

  private async open(params: Params): Promise<OkResponse> {
    const browser = requireBrowser(params);
    const profile = profileParam(params);
    const headless = optionalBoolean(params, "headless") ?? (this.env.ABT_HEADLESS === "1" || this.env.TABCTX_HEADLESS === "1");
    const use = optionalBoolean(params, "use") ?? false;
    const driver = this.driverFor(browser);
    const session = await driver.open({ profile, headless });
    const ctx = this.registry.create({ browser, profile, createdAt: this.now().toISOString() }, session);
    this.contextDrivers.set(ctx.id, driver);
    driver.onDisconnect(session, () => this.handleDisconnect(ctx.id, session));
    await this.refreshQuietly(ctx.id, driver, session);
    const stillOpen = this.registry.session(ctx.id) === session;
    if (stillOpen && (use || this.registry.current === null)) this.registry.setCurrent(ctx.id);
    return { ok: true, context: ctx.id, browser, profile, current: this.registry.current === ctx.id };
  }

  private async tabs(params: Params): Promise<OkResponse> {
    const browser = optionalBrowser(params);
    const query = optionalString(params, "query");
    const active = optionalBoolean(params, "active");
    const all = await this.discoverTabs();
    const filtered = filterTabs(all, {
      ...(browser === undefined ? {} : { browser }),
      ...(query === undefined ? {} : { query }),
      ...(active === undefined ? {} : { active }),
    });
    return { ok: true, tabs: filtered };
  }

  private async bind(params: Params): Promise<OkResponse> {
    const options = parseBindOptions(params);
    const all = await this.discoverTabs();
    const chosen = selectTabToBind(all, options);
    const makeCurrent = options.use ?? true;
    const existing = chosen.context !== undefined ? this.registry.get(chosen.context) : this.registry.findOpenByTabId(chosen.tabId);
    if (existing !== undefined && existing.status === "open") {
      if (makeCurrent) this.registry.setCurrent(existing.id);
      return {
        ok: true,
        context: existing.id,
        tabId: chosen.tabId,
        browser: chosen.browser,
        source: chosen.source,
        url: chosen.url,
        title: chosen.title,
        current: this.registry.current === existing.id,
        reused: true,
      };
    }
    return this.bindNewTab(chosen, makeCurrent);
  }

  private async bindNewTab(chosen: LiveTab, makeCurrent: boolean): Promise<OkResponse> {
    const driver = this.driverForTab(chosen);
    if (driver.bindTab === undefined) {
      throw new TabCtxError("ACTION_FAILED", `Driver for ${chosen.source} does not support binding live tabs`);
    }
    const session = await driver.bindTab(chosen.tabId);
    const ctx = this.registry.create(
      { browser: chosen.browser, profile: "live", source: chosen.source, tabId: chosen.tabId, createdAt: this.now().toISOString() },
      session,
    );
    this.contextDrivers.set(ctx.id, driver);
    this.registry.updateLocation(ctx.id, { url: chosen.url, title: chosen.title });
    driver.onDisconnect(session, () => this.handleDisconnect(ctx.id, session));
    if (makeCurrent || this.registry.current === null) this.registry.setCurrent(ctx.id);
    return {
      ok: true,
      context: ctx.id,
      tabId: chosen.tabId,
      browser: chosen.browser,
      source: chosen.source,
      url: chosen.url,
      title: chosen.title,
      current: this.registry.current === ctx.id,
      reused: false,
    };
  }

  private async doctor(): Promise<OkResponse> {
    const tabs = await this.discoverTabs();
    return {
      ok: true,
      pid: process.pid,
      home: this.paths.home,
      current: this.registry.current,
      openContexts: this.registry.openSessions().length,
      liveTabs: tabs.length,
      extensionBridge: {
        port: this.extensionBridge?.port ?? 0,
        connected: this.extensionBridge?.isConnected() ?? false,
      },
      browsers: detectInstalledBrowsers(this.env.ABT_BROWSER_PATH ?? this.env.TABCTX_CHROMIUM_PATH),
    };
  }

  private list(): Promise<OkResponse> {
    const { contexts, current } = this.registry.snapshot();
    return Promise.resolve({ ok: true, contexts, current });
  }

  private use(params: Params): Promise<OkResponse> {
    const { ctx } = this.resolve({ context: requireString(params, "context") });
    this.registry.setCurrent(ctx.id);
    return Promise.resolve({ ok: true, context: ctx.id });
  }

  private currentContext(): Promise<OkResponse> {
    const current = this.registry.current;
    if (current === null) throw noCurrent();
    return Promise.resolve({ ok: true, context: current });
  }

  private async close(params: Params): Promise<OkResponse> {
    const { ctx, session, driver } = this.resolve(params);
    this.registry.markClosed(ctx.id);
    this.contextDrivers.delete(ctx.id);
    await driver.close(session);
    return { ok: true, context: ctx.id };
  }

  private async shutdown(): Promise<OkResponse> {
    await this.closeAll();
    const listeners = this.shutdownListeners.splice(0);
    setImmediate(() => {
      for (const listener of listeners) listener();
    });
    return { ok: true };
  }

  private async closeContext(id: string): Promise<void> {
    const ctx = this.registry.get(id);
    const session = this.registry.markClosed(id);
    const driver = this.contextDrivers.get(id) ?? (ctx === undefined ? undefined : this.drivers.get(ctx.browser));
    this.contextDrivers.delete(id);
    if (session !== undefined && driver !== undefined) await driver.close(session);
  }

  private handleDisconnect(id: string, session: BrowserSession): void {
    if (this.registry.session(id) === session) {
      this.registry.markClosed(id);
      this.contextDrivers.delete(id);
    }
  }

  private async goto(params: Params): Promise<OkResponse> {
    const url = requireString(params, "url");
    const resolved = this.resolve(params);
    const base = await this.baseUrl(url, resolved);
    const target = resolveGotoUrl(url, base);
    return this.navigate(params, (d, s) => d.navigate(s, target), resolved);
  }

  private async baseUrl(url: string, { ctx, driver, session }: Resolved): Promise<string | undefined> {
    if (!isRelativeUrl(url)) return undefined;
    const loc = await driver.location(session);
    return loc.url === "" ? ctx.url : loc.url;
  }

  private async navigate(params: Params, op: NavOp, pre?: Resolved): Promise<OkResponse> {
    const { ctx, driver, session } = pre ?? this.resolve(params);
    await op(driver, session);
    const loc = await driver.location(session);
    this.registry.updateLocation(ctx.id, loc);
    return { ok: true, context: ctx.id, url: loc.url, title: loc.title };
  }

  private async inspect(params: Params): Promise<OkResponse> {
    const { ctx, driver, session } = this.resolve(params);
    const state = await driver.inspect(session);
    this.registry.updateLocation(ctx.id, { url: state.url, title: state.title });
    return { ok: true, context: ctx.id, url: state.url, title: state.title, aria: state.aria };
  }

  private async screenshot(params: Params): Promise<OkResponse> {
    const out = optionalString(params, "out");
    const fullPage = optionalBoolean(params, "fullPage") ?? false;
    const { ctx, driver, session } = this.resolve(params);
    if (out !== undefined && !isAbsolute(out)) {
      throw new TabCtxError("INVALID_ARGUMENT", "out must be an absolute path");
    }
    const path = out ?? join(this.paths.screenshots, `${ctx.id}-${fileTimestamp(this.now())}.png`);
    await mkdir(dirname(path), { recursive: true });
    const result = await driver.screenshot(session, path, fullPage);
    return { ok: true, context: ctx.id, path: result.path, bytes: result.bytes };
  }

  private async logEntries(params: Params, fetch: EntriesOp): Promise<OkResponse> {
    const since = optionalNonNegativeInteger(params, "since") ?? 0;
    const { ctx, driver, session } = this.resolve(params);
    const entries = await fetch(driver, session, since);
    const last = entries[entries.length - 1];
    return { ok: true, context: ctx.id, entries, next: last === undefined ? since : last.seq };
  }

  private async act(params: Params, op: ActOp): Promise<OkResponse> {
    const { ctx, driver, session } = this.resolve(params);
    const result = await op(driver, session, params);
    await this.refreshQuietly(ctx.id, driver, session);
    return { ok: true, context: ctx.id, matched: result.matched };
  }

  private resolve(params: Params): Resolved {
    const id = optionalString(params, "context") ?? this.registry.current;
    if (id === null) throw noCurrent();
    const ctx = this.registry.get(id);
    if (ctx === undefined) throw new TabCtxError("CONTEXT_NOT_FOUND", `no context ${id}`, { context: id });
    const session = this.registry.session(id);
    const driver = this.contextDrivers.get(id) ?? this.drivers.get(ctx.browser);
    if (ctx.status === "closed" || session === undefined || driver === undefined) {
      throw new TabCtxError("CONTEXT_CLOSED", `context ${id} is closed`, { context: id });
    }
    return { ctx, session, driver };
  }

  private driverFor(browser: BrowserName): BrowserDriver {
    const cached = this.drivers.get(browser);
    if (cached !== undefined) return cached;
    const driver = this.driverFactory(browser);
    this.drivers.set(browser, driver);
    return driver;
  }

  private driverForTab(tab: LiveTab): BrowserDriver {
    if (tab.source === "extension" && this.extensionDriver !== undefined) return this.extensionDriver;
    if (tab.source === "macos" && this.macosDriver !== undefined) return this.macosDriver;
    return this.driverFor(tab.browser);
  }

  private discoverTabs(): Promise<LiveTab[]> {
    return collectAllTabs({
      registry: this.registry,
      drivers: this.drivers,
      ...(this.extensionDriver === undefined ? {} : { extensionDriver: this.extensionDriver }),
      ...(this.macosDriver === undefined ? {} : { macosDriver: this.macosDriver }),
    });
  }

  private async refreshQuietly(id: string, driver: BrowserDriver, session: BrowserSession): Promise<void> {
    try {
      this.registry.updateLocation(id, await driver.location(session));
    } catch {
      // Stale location in list is harmless.
    }
  }
}

type NavOp = (driver: BrowserDriver, session: BrowserSession) => Promise<void>;
type EntriesOp = (driver: BrowserDriver, session: BrowserSession, since: number) => Promise<Array<{ seq: number }>>;
type ActOp = (driver: BrowserDriver, session: BrowserSession, params: Params) => Promise<{ matched: number }>;

function parseRequest(raw: unknown, handlers: Record<Method, Handler>): { method: Method; params: Params } {
  if (!isRecord(raw) || typeof raw.method !== "string") {
    throw new TabCtxError("INVALID_ARGUMENT", "request must be an object with a string method");
  }
  if (!Object.hasOwn(handlers, raw.method)) {
    throw new TabCtxError("INVALID_ARGUMENT", `unknown method: ${raw.method.slice(0, 64)}`);
  }
  const params = raw.params ?? {};
  if (!isRecord(params)) throw new TabCtxError("INVALID_ARGUMENT", "params must be an object");
  return { method: raw.method as Method, params };
}

function noCurrent(): TabCtxError {
  return new TabCtxError("NO_CURRENT_CONTEXT", "no current context; run `abt bind` or `tabctx use <ctx>` or pass --context");
}

function typedValueOf(raw: unknown): string | undefined {
  if (!isRecord(raw) || (raw.method !== "type" && raw.method !== "select")) return undefined;
  const value = isRecord(raw.params) ? raw.params.value : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (isTabCtxError(err)) {
    return { ...err.details, ok: false, error: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: "INTERNAL", message };
}

export function redact(response: ErrorResponse, secret: string | undefined): ErrorResponse {
  if (secret === undefined) return response;
  const scrubbed: ErrorResponse = { ok: false, error: response.error, message: scrub(response.message, secret) };
  for (const [key, value] of Object.entries(response)) {
    if (key !== "ok" && key !== "error" && key !== "message") scrubbed[key] = scrubValue(value, secret);
  }
  return scrubbed;
}

function scrubValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return scrub(value, secret);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secret));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, secret)]));
  }
  return value;
}

function scrub(text: string, secret: string): string {
  return text.split(secret).join(REDACTED);
}

export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
