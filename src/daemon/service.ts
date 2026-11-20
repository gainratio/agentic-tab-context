/**
 * DaemonService: maps protocol requests onto the registry and browser drivers.
 * Every outcome is a `Response`; nothing throws out of `handle`.
 */
import { AtcError } from "../contracts/errors.js";
import type { Method, OkResponse, Paths, Request, Response } from "../contracts/protocol.js";
import type { BrowserDriver, BrowserName, BrowserSession, DriverFactory } from "../contracts/types.js";
import { DAEMON_PROTOCOL_VERSION } from "../contracts/version.js";
import type { ExtensionBridge } from "../drivers/extension/bridge.js";
import { TabBinder } from "./binding.js";
import { bindingsResponse, listBindings } from "./bindings.js";
import { doctorReport } from "./doctor.js";
import { eachResponse, isEachRequest } from "./each.js";
import { KeepAliveTracker, applyKeepAlive, syncLiveTabs } from "./keepalive.js";
import { type Handler, PageCommands, type Resolved, refreshLocation } from "./page-commands.js";
import { type Params, isRecord, optionalBoolean, optionalString, profileParam, requireBrowser, requireString } from "./params.js";
import type { ContextRegistry } from "./registry.js";
import { noCurrent, parseRequest, redact, toErrorResponse, typedValueOf } from "./responses.js";
import { extensionTabToOpen } from "./tabs.js";

export interface DaemonServiceDeps {
  registry: ContextRegistry; driverFactory: DriverFactory; paths: Paths;
  env?: NodeJS.ProcessEnv; now?: () => Date;
  extensionBridge?: ExtensionBridge; extensionDriver?: BrowserDriver; macosDriver?: BrowserDriver;
}
export interface RoutedRequest { key: string | null; request: Request; }

const CONTEXT_METHODS: ReadonlySet<string> = new Set<Method>([
  "close", "goto", "back", "forward", "reload", "inspect", "screenshot", "console", "network", "click", "type", "select", "press", "upload", "keepalive",
]);

export class DaemonService {
  private readonly registry: ContextRegistry;
  private readonly keepAlive = new KeepAliveTracker();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly drivers = new Map<BrowserName, BrowserDriver>();
  private readonly contextDrivers = new Map<string, BrowserDriver>();
  private readonly shutdownListeners: Array<() => void> = [];
  private readonly binder: TabBinder;
  private readonly handlers: Record<Method, Handler>;

  constructor(private readonly deps: DaemonServiceDeps) {
    this.registry = deps.registry;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => new Date());
    this.binder = new TabBinder({
      ...deps, env: this.env, now: this.now, drivers: this.drivers, driverFor: (browser) => this.driverFor(browser),
      attach: (id, driver, session) => this.attach(id, driver, session),
      onKeepAlive: (id, reused) => this.enableBoundKeepAlive(id, reused),
    });
    const page = new PageCommands({ registry: this.registry, keepAlive: this.keepAlive, paths: deps.paths, env: this.env, now: this.now, resolve: (p) => this.resolve(p) });
    this.handlers = { ...this.contextHandlers(), ...page.handlers() };
    deps.extensionBridge?.onTabsChanged((_key, tabs) => syncLiveTabs(this.registry, this.keepAlive, tabs));
  }

  async handle(req: Request): Promise<Response> {
    const raw: unknown = req;
    if (isEachRequest(raw)) return eachResponse(this.registry, raw, (request) => this.handle(request));
    const secret = typedValueOf(raw);
    try {
      const { method, params } = parseRequest(raw, this.handlers);
      return await this.handlers[method](params);
    } catch (err) {
      return redact(toErrorResponse(err), secret);
    }
  }

  /** User-initiated share: no active change, and the sensitive-tab gate is bypassed. */
  async shareFromExtension(tabId: string): Promise<string> {
    const res = await this.binder.shareFromExtension(tabId);
    if (typeof res.context !== "string") throw new AtcError("INTERNAL", "share did not return a context");
    return res.context;
  }

  route(req: Request): RoutedRequest {
    const raw: unknown = req;
    if (!isRecord(raw) || typeof raw.method !== "string" || !CONTEXT_METHODS.has(raw.method)) return { key: null, request: req };
    if (raw.params !== undefined && !isRecord(raw.params)) return { key: null, request: req };
    if (raw.params !== undefined && raw.params.each === true) return { key: null, request: req };
    const params = isRecord(raw.params) ? raw.params : {};
    if (typeof params.context === "string") return { key: params.context, request: req };
    const implicit = params.context === undefined ? this.implicitContextId() : null;
    if (implicit === null) return { key: null, request: req };
    return { key: implicit, request: { ...raw, params: { ...params, context: implicit } } as Request };
  }

  onShutdown(listener: () => void): void { this.shutdownListeners.push(listener); }
  async closeAll(): Promise<void> { await Promise.allSettled(this.registry.openSessions().map(({ id }) => this.closeContext(id))); }

  private contextHandlers(): Pick<Record<Method, Handler>, "open" | "tabs" | "bind" | "bindings" | "list" | "use" | "current" | "close" | "doctor" | "ping" | "shutdown"> {
    return {
      open: (p) => this.open(p),
      tabs: (p) => this.binder.tabs(p),
      bind: (p) => this.binder.bind(p),
      bindings: (p) => Promise.resolve(bindingsResponse(this.registry, p, this.keepAlive)),
      list: () => Promise.resolve({ ok: true, ...this.registry.snapshot() }),
      use: (p) => this.use(p),
      current: () => this.currentContext(),
      close: (p) => this.close(p),
      doctor: () => this.doctor(),
      ping: () => Promise.resolve({ ok: true, pid: process.pid, protocol: DAEMON_PROTOCOL_VERSION }),
      shutdown: () => this.shutdown(),
    };
  }

  private async open(params: Params): Promise<OkResponse> {
    const browser = requireBrowser(params);
    const profile = profileParam(params);
    const headless = optionalBoolean(params, "headless") ?? this.env.ATC_HEADLESS === "1";
    const makeCurrent = optionalBoolean(params, "use") ?? false;
    if (browser === "extension") return this.binder.bind({ tab: (await extensionTabToOpen(this.deps.extensionDriver)).tabId, use: makeCurrent });
    const driver = this.driverFor(browser);
    const session = await driver.open({ profile, headless });
    const identity = session.tabId === undefined ? {} : { source: "managed" as const, tabId: session.tabId };
    const ctx = this.registry.create({ browser, profile, ...identity, createdAt: this.now().toISOString() }, session);
    this.attach(ctx.id, driver, session);
    await refreshLocation(this.registry, ctx.id, driver, session, this.keepAlive);
    if (this.registry.session(ctx.id) === session && (makeCurrent || this.registry.current === null)) this.registry.setCurrent(ctx.id);
    return { ok: true, context: ctx.id, browser, profile, current: this.registry.current === ctx.id };
  }

  private async doctor(): Promise<OkResponse> {
    const { paths, extensionBridge } = this.deps;
    const tabs = await this.binder.discover();
    const base = { paths, env: this.env, tabs, openContexts: this.registry.openSessions().length, current: this.registry.current };
    return doctorReport(extensionBridge === undefined ? base : { ...base, bridge: extensionBridge });
  }

  private use(params: Params): Promise<OkResponse> {
    const { ctx } = this.resolve({ context: requireString(params, "context") });
    this.registry.setCurrent(ctx.id);
    return Promise.resolve({ ok: true, context: ctx.id });
  }
  private currentContext(): Promise<OkResponse> {
    const id = this.implicitContextId();
    if (id === null) throw noCurrent(listBindings(this.registry, {}, this.keepAlive).bindings);
    return Promise.resolve({ ok: true, context: id });
  }
  private async close(params: Params): Promise<OkResponse> {
    const { ctx } = this.resolve(params);
    await this.closeContext(ctx.id);
    return { ok: true, context: ctx.id };
  }
  private async shutdown(): Promise<OkResponse> {
    await this.closeAll();
    const listeners = this.shutdownListeners.splice(0);
    setImmediate(() => listeners.forEach((listener) => listener()));
    return { ok: true };
  }
  private async closeContext(id: string): Promise<void> {
    const ctx = this.registry.get(id);
    this.keepAlive.disable(id);
    const session = this.registry.markClosed(id);
    const driver = this.contextDrivers.get(id) ?? (ctx === undefined ? undefined : this.drivers.get(ctx.browser));
    this.contextDrivers.delete(id);
    if (session !== undefined && driver !== undefined) await driver.close(session);
  }
  private attach(id: string, driver: BrowserDriver, session: BrowserSession): void {
    this.contextDrivers.set(id, driver);
    driver.onDisconnect(session, () => {
      if (this.registry.session(id) !== session) return;
      this.keepAlive.disable(id);
      this.registry.markClosed(id);
      this.contextDrivers.delete(id);
    });
  }
  private async enableBoundKeepAlive(id: string, reused: boolean): Promise<void> {
    try { await applyKeepAlive(this.resolve({ context: id }), this.registry, this.keepAlive, true); }
    catch (error) { if (!reused) await this.closeContext(id); throw error; }
  }
  private implicitContextId(): string | null {
    if (this.registry.current !== null) return this.registry.current;
    const open = this.registry.openSessions();
    return open.length === 1 ? (open[0]?.id ?? null) : null;
  }

  private resolve(params: Params): Resolved {
    const id = optionalString(params, "context") ?? this.implicitContextId();
    if (id === null) throw noCurrent(listBindings(this.registry, {}, this.keepAlive).bindings);
    const ctx = this.registry.get(id);
    if (ctx === undefined) throw new AtcError("CONTEXT_NOT_FOUND", `no context ${id}`, { context: id });
    const session = this.registry.session(id);
    const driver = this.contextDrivers.get(id) ?? this.drivers.get(ctx.browser);
    if (ctx.status === "closed" || session === undefined || driver === undefined) throw new AtcError("CONTEXT_CLOSED", `context ${id} is closed`, { context: id });
    return { ctx, session, driver };
  }

  private driverFor(browser: BrowserName): BrowserDriver {
    const driver = this.drivers.get(browser) ?? this.deps.driverFactory(browser);
    this.drivers.set(browser, driver);
    return driver;
  }
}
