/** Stable page identities and reference-counted bindings for owned browsers. */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { AtcError } from "../../contracts/errors.js";
import type { BrowserSession, ConsoleEntry, LiveTab, NetworkEntry } from "../../contracts/types.js";
import type { ManagedBrowser } from "./executables.js";
import { fireDisconnect } from "./helpers.js";
import { releaseProfile } from "./locks.js";
import { attachPageLogs, SeqLog } from "./logs.js";
import type { SessionState } from "./session.js";

interface ManagedPage {
  readonly id: string;
  readonly page: Page;
  readonly consoleLog: SessionState["consoleLog"];
  readonly networkLog: SessionState["networkLog"];
}

interface Owner {
  readonly root: SessionState;
  readonly pages: Map<string, ManagedPage>;
  readonly byPage: WeakMap<Page, ManagedPage>;
  readonly bindings: Set<string>;
  nextId: number;
  active: Page | undefined;
  closing?: Promise<void>;
}

export class ManagedTabs {
  private readonly owners = new Map<string, Owner>();
  private readonly targets = new Map<string, { owner: Owner; tab: ManagedPage }>();

  constructor(private readonly browser: ManagedBrowser, private readonly sessions: Map<string, SessionState>) {}

  track(root: SessionState): BrowserSession {
    const owner: Owner = { root, pages: new Map(), byPage: new WeakMap(), bindings: new Set([root.id]), nextId: 0, active: root.page };
    this.owners.set(root.id, owner);
    this.sessions.set(root.id, root);
    this.register(owner, root.page, root);
    for (const page of root.context.pages()) this.register(owner, page);
    root.context.on("page", (page) => this.register(owner, page));
    root.context.on("close", () => this.contextClosed(owner));
    return this.handle(root);
  }

  bind(tabId: string): BrowserSession {
    const target = this.targets.get(tabId);
    if (target === undefined || target.owner.closing !== undefined || target.tab.page.isClosed()) throw this.missing(tabId);
    const { owner, tab } = target;
    const existing = [...owner.bindings].map((id) => this.sessions.get(id)).find((state) => state?.page === tab.page);
    owner.active = tab.page;
    if (existing !== undefined) return this.handle(existing);
    const state = this.binding(owner, tab);
    owner.bindings.add(state.id);
    this.sessions.set(state.id, state);
    return this.handle(state);
  }

  async close(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const owner = this.owners.get(state.ownerId);
    if (owner === undefined) return;
    this.detach(owner, state);
    if (owner.bindings.size === 0) await this.shutdown(owner);
  }

  async list(): Promise<LiveTab[]> {
    const open = [...this.owners.values()].filter((owner) => owner.closing === undefined);
    return (await Promise.all(open.map((owner) => this.listOwner(owner)))).flat();
  }

  private listOwner(owner: Owner): Promise<LiveTab[]> {
    const pages = [...owner.pages.values()].filter((tab) => !tab.page.isClosed());
    return Promise.all(pages.map(async (tab) => ({
      tabId: tab.id, browser: this.browser, source: "managed" as const,
      url: tab.page.url(), title: await tab.page.title().catch(() => ""), active: tab.page === owner.active,
    })));
  }

  private register(owner: Owner, page: Page, initial?: SessionState): void {
    if (owner.byPage.has(page) || page.isClosed()) return;
    const tab = this.newPage(owner, page, initial);
    owner.byPage.set(page, tab);
    owner.pages.set(tab.id, tab);
    this.targets.set(tab.id, { owner, tab });
    page.on("close", () => this.pageClosed(owner, tab));
  }

  private newPage(owner: Owner, page: Page, initial?: SessionState): ManagedPage {
    const id = `managed:${this.browser}:${owner.root.id}:${owner.nextId++}`;
    const consoleLog = initial?.consoleLog ?? new SeqLog<ConsoleEntry>();
    const networkLog = initial?.networkLog ?? new SeqLog<NetworkEntry>();
    if (initial === undefined) attachPageLogs(page, consoleLog, networkLog);
    return { id, page, consoleLog, networkLog };
  }

  private binding(owner: Owner, tab: ManagedPage): SessionState {
    return {
      id: randomUUID(), ownerId: owner.root.id, tabId: tab.id,
      profileDir: owner.root.profileDir, context: owner.root.context, page: tab.page,
      consoleLog: tab.consoleLog, networkLog: tab.networkLog,
      disconnectCallbacks: [], disconnected: false,
    };
  }

  private handle(state: SessionState): BrowserSession {
    return { sessionId: state.id, tabId: state.tabId };
  }

  private pageClosed(owner: Owner, tab: ManagedPage): void {
    owner.pages.delete(tab.id);
    this.targets.delete(tab.id);
    if (owner.active === tab.page) owner.active = undefined;
    for (const id of [...owner.bindings]) {
      const state = this.sessions.get(id);
      if (state?.page === tab.page) this.detach(owner, state);
    }
    if (owner.bindings.size === 0) void this.shutdown(owner);
  }

  private detach(owner: Owner, state: SessionState): void {
    owner.bindings.delete(state.id);
    this.sessions.delete(state.id);
    fireDisconnect(state);
  }

  private shutdown(owner: Owner): Promise<void> {
    owner.closing ??= this.closeContext(owner);
    return owner.closing;
  }

  private async closeContext(owner: Owner): Promise<void> {
    await owner.root.context.close().catch(() => undefined);
    this.contextClosed(owner);
  }

  private contextClosed(owner: Owner): void {
    if (!this.owners.delete(owner.root.id)) return;
    for (const tab of owner.pages.values()) this.targets.delete(tab.id);
    for (const id of [...owner.bindings]) {
      const state = this.sessions.get(id);
      if (state !== undefined) this.detach(owner, state);
    }
    releaseProfile(owner.root.profileDir);
  }

  private missing(tabId: string): AtcError {
    return new AtcError("TARGET_NOT_FOUND", `tab ${tabId} is no longer open`);
  }
}
