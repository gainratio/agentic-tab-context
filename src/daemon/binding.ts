/**
 * `atc tabs` and `atc bind`: find the tab the user already has open and turn
 * it into a context. Re-binding the same tab reuses its context.
 */
import { AtcError } from "../contracts/errors.js";
import type { OkResponse } from "../contracts/protocol.js";
import type { BrowserDriver, BrowserName, BrowserSession, LiveTab, TabContext } from "../contracts/types.js";
import type { ExtensionBridge } from "../drivers/extension/bridge.js";
import { type Params, optionalBoolean, optionalBrowser, optionalString, parseBindOptions } from "./params.js";
import type { ContextRegistry } from "./registry.js";
import { collectAllTabs, filterTabs, selectTabToBind } from "./tabs.js";

export interface BinderDeps {
  registry: ContextRegistry;
  now: () => Date;
  drivers: ReadonlyMap<BrowserName, BrowserDriver>;
  driverFor: (browser: BrowserName) => BrowserDriver;
  /** Record which driver owns a new context and close it if the browser goes away. */
  attach: (contextId: string, driver: BrowserDriver, session: BrowserSession) => void;
  extensionBridge?: ExtensionBridge;
  extensionDriver?: BrowserDriver;
  macosDriver?: BrowserDriver;
}

export class TabBinder {
  private readonly pendingBindings = new Map<string, Promise<void>>();

  constructor(private readonly deps: BinderDeps) {}

  async tabs(params: Params): Promise<OkResponse> {
    const browser = optionalBrowser(params);
    const query = optionalString(params, "query");
    const active = optionalBoolean(params, "active");
    const filter = { ...(browser && { browser }), ...(query !== undefined && { query }), ...(active !== undefined && { active }) };
    return { ok: true, tabs: filterTabs(await this.discover(), filter) };
  }

  async bind(params: Params): Promise<OkResponse> {
    const options = parseBindOptions(params);
    const chosen = selectTabToBind(await this.discover(), options);
    return this.bindSerialized(chosen, options.use ?? true);
  }

  async discover(): Promise<LiveTab[]> {
    await this.deps.extensionBridge?.settle();
    const { registry, drivers, extensionDriver, macosDriver } = this.deps;
    return collectAllTabs({ registry, drivers, ...(extensionDriver && { extensionDriver }), ...(macosDriver && { macosDriver }) });
  }

  private reuse(existing: TabContext, chosen: LiveTab, makeCurrent: boolean): OkResponse {
    if (makeCurrent) this.deps.registry.setCurrent(existing.id);
    return this.bound(existing.id, chosen, true);
  }

  private bindSerialized(tab: LiveTab, makeCurrent: boolean): Promise<OkResponse> {
    const previous = this.pendingBindings.get(tab.tabId) ?? Promise.resolve();
    const result = previous.then(() => this.bindSelected(tab, makeCurrent));
    const tail = result.then(() => undefined, () => undefined);
    this.pendingBindings.set(tab.tabId, tail);
    void tail.then(() => { if (this.pendingBindings.get(tab.tabId) === tail) this.pendingBindings.delete(tab.tabId); });
    return result;
  }

  private bindSelected(tab: LiveTab, makeCurrent: boolean): Promise<OkResponse> {
    const { registry } = this.deps;
    const existing = registry.findOpenByTabId(tab.tabId) ?? (tab.context === undefined ? undefined : registry.get(tab.context));
    return existing?.status === "open" ? Promise.resolve(this.reuse(existing, tab, makeCurrent)) : this.bindNew(tab, makeCurrent);
  }

  private async bindNew(chosen: LiveTab, makeCurrent: boolean): Promise<OkResponse> {
    const driver = this.driverForTab(chosen);
    if (driver.bindTab === undefined) throw new AtcError("UNSUPPORTED_ACTION", `${chosen.source} tabs cannot be bound`);
    const session = await driver.bindTab(chosen.tabId);
    const { registry } = this.deps;
    const ctx = registry.create(
      { browser: chosen.browser, profile: "live", source: chosen.source, tabId: chosen.tabId, createdAt: this.deps.now().toISOString() },
      session,
    );
    this.deps.attach(ctx.id, driver, session);
    registry.updateLocation(ctx.id, { url: chosen.url, title: chosen.title });
    if (makeCurrent || registry.current === null) registry.setCurrent(ctx.id);
    return this.bound(ctx.id, chosen, false);
  }

  private bound(contextId: string, tab: LiveTab, reused: boolean): OkResponse {
    const { tabId, browser, source, url, title } = tab;
    return { ok: true, context: contextId, tabId, browser, source, url, title, current: this.deps.registry.current === contextId, reused };
  }

  private driverForTab(tab: LiveTab): BrowserDriver {
    if (tab.source === "extension" && this.deps.extensionDriver !== undefined) return this.deps.extensionDriver;
    if (tab.source === "macos" && this.deps.macosDriver !== undefined) return this.deps.macosDriver;
    return this.deps.driverFor(tab.browser);
  }
}
