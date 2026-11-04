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
import { isSensitiveUrl } from "./sensitive.js";
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
  /** Test/backward escape hatch; normal extension use requires a user share. */
  env?: NodeJS.ProcessEnv;
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

  /** The CLI/agent binding path: sensitive tabs are refused unless the user shares them from the extension. */
  async bind(params: Params): Promise<OkResponse> {
    const options = parseBindOptions(params);
    const chosen = selectTabToBind(await this.discover(), options);
    assertNotSensitive(chosen);
    assertSharedOrManaged(this.deps, chosen);
    return this.bindSerialized(chosen, options.use ?? true, true);
  }

  /**
   * User-initiated share from the extension side panel/popup. Sensitive origins
   * are allowed because the user picked this tab, and `current` is left alone:
   * sharing a tab never retargets the agent's active context.
   */
  async shareFromExtension(tabId: string): Promise<OkResponse> {
    const chosen = (await this.discover()).find((tab) => tab.tabId === tabId && tab.source === "extension");
    if (chosen === undefined) {
      throw new AtcError("TARGET_NOT_FOUND", "that extension tab is no longer open", { tabId });
    }
    return this.bindSerialized(chosen, false, false);
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

  private bindSerialized(tab: LiveTab, makeCurrent: boolean, adoptIfNoCurrent: boolean): Promise<OkResponse> {
    const previous = this.pendingBindings.get(tab.tabId) ?? Promise.resolve();
    const result = previous.then(() => this.bindSelected(tab, makeCurrent, adoptIfNoCurrent));
    const tail = result.then(() => undefined, () => undefined);
    this.pendingBindings.set(tab.tabId, tail);
    void tail.then(() => { if (this.pendingBindings.get(tab.tabId) === tail) this.pendingBindings.delete(tab.tabId); });
    return result;
  }

  private bindSelected(tab: LiveTab, makeCurrent: boolean, adoptIfNoCurrent: boolean): Promise<OkResponse> {
    const { registry } = this.deps;
    const existing = registry.findOpenByTabId(tab.tabId) ?? (tab.context === undefined ? undefined : registry.get(tab.context));
    return existing?.status === "open"
      ? Promise.resolve(this.reuse(existing, tab, makeCurrent))
      : this.bindNew(tab, makeCurrent, adoptIfNoCurrent);
  }

  private async bindNew(chosen: LiveTab, makeCurrent: boolean, adoptIfNoCurrent: boolean): Promise<OkResponse> {
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
    if (makeCurrent || (adoptIfNoCurrent && registry.current === null)) registry.setCurrent(ctx.id);
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

function assertNotSensitive(tab: LiveTab): void {
  if (!isSensitiveUrl(tab.url)) return;
  const host = hostOf(tab.url);
  const where = host === undefined ? "this tab" : `(${host})`;
  throw new AtcError(
    "ACTION_BLOCKED_SENSITIVE",
    `atc will not bind sensitive tab ${where}; open it from the ATC side panel to share it explicitly`,
  );
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function assertSharedOrManaged(deps: BinderDeps, tab: LiveTab): void {
  if (tab.source !== "extension") return;
  if (deps.registry.findOpenByTabId(tab.tabId) !== undefined) return;
  if (deps.env?.ATC_ALLOW_AGENT_BIND === "1") return;
  throw new AtcError("TAB_NOT_SHARED", "This tab has not been shared. Open the ATC side panel and choose Share first.", { tabId: tab.tabId });
}
