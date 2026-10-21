/**
 * PlaywrightDriver: cross-browser persistent context driver supporting
 * chromium, chrome, brave, edge, firefox, safari, and webkit.
 */
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { TabCtxError } from "../../contracts/errors.js";
import type {
  ActionResult,
  BrowserDriver,
  BrowserSession,
  ConsoleEntry,
  LiveTab,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../contracts/types.js";
import type { DriverOptions } from "../index.js";
import { describeTarget, resolveTarget } from "../target.js";
import { engineFor, resolveExecutable, type PlaywrightBrowserName } from "./executables.js";
import {
  ACTION_TIMEOUT_MS,
  fireDisconnect,
  guard,
  NAVIGATION_TIMEOUT_MS,
  navFailure,
  navigation,
  selectOption,
  toTabCtxError,
  type DisconnectableState,
  type FailureContext,
} from "./helpers.js";
import { assertNotLockedByOtherProcess, claimProfile, releaseProfile, validateProfileName } from "./locks.js";
import { attachPageLogs, SeqLog, validateSinceSeq } from "./logs.js";

const VIEWPORT = { width: 1280, height: 800 } as const;

interface SessionState extends DisconnectableState {
  readonly id: string;
  readonly profileDir: string;
  readonly context: BrowserContext;
  page: Page;
  readonly ownsContext: boolean;
  readonly consoleLog: SeqLog<ConsoleEntry>;
  readonly networkLog: SeqLog<NetworkEntry>;
}

export class PlaywrightDriver implements BrowserDriver {
  readonly name: PlaywrightBrowserName;
  private readonly options: DriverOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(name: PlaywrightBrowserName, options: DriverOptions) {
    this.name = name;
    this.options = options;
  }

  async open(options: OpenOptions): Promise<BrowserSession> {
    const profileDir = resolve(this.options.profilesDir, validateProfileName(options.profile));
    claimProfile(profileDir, options.profile);
    try {
      await assertNotLockedByOtherProcess(profileDir, options.profile);
      await mkdir(profileDir, { recursive: true });
      const context = await this.launch(profileDir, options.headless);
      return await this.track(context, profileDir);
    } catch (error) {
      releaseProfile(profileDir);
      throw toTabCtxError(error, { action: "open browser", code: "ACTION_FAILED" });
    }
  }

  async close(session: BrowserSession): Promise<void> {
    const state = this.sessions.get(session.sessionId);
    if (state !== undefined) await this.shutdown(state);
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.disconnected) {
      queueMicrotask(callback);
      return;
    }
    state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("navigate", url), () =>
      state.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async back(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("go back", state.page.url()), () =>
      state.page.goBack({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async forward(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("go forward", state.page.url()), () =>
      state.page.goForward({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async reload(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("reload", state.page.url()), () =>
      state.page.reload({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const state = this.live(session);
    return guard(state, { action: "read location", code: "ACTION_FAILED" }, async () => ({
      url: state.page.url(),
      title: await state.page.title(),
    }));
  }

  async inspect(session: BrowserSession): Promise<PageState> {
    const state = this.live(session);
    return guard(state, { action: "inspect", code: "ACTION_FAILED" }, async () => ({
      url: state.page.url(),
      title: await state.page.title(),
      aria: await state.page.locator("body").ariaSnapshot(),
    }));
  }

  async click(session: BrowserSession, target: Target): Promise<ActionResult> {
    return this.act(session, target, { action: "click", code: "ACTION_FAILED" }, async (locator) => {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    });
  }

  async type(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    const failure: FailureContext = { action: "type", code: "ACTION_FAILED", secret: value };
    return this.act(session, target, failure, async (locator) => {
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
    });
  }

  async select(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    const failure: FailureContext = { action: "select", code: "ACTION_FAILED", secret: value };
    return this.act(session, target, failure, async (locator) => {
      await selectOption(locator, target, value);
    });
  }

  async screenshot(session: BrowserSession, path: string, fullPage: boolean): Promise<ScreenshotResult> {
    const state = this.live(session);
    const absolute = resolve(path);
    return guard(state, { action: "screenshot", code: "ACTION_FAILED", details: { path: absolute } }, async () => {
      await mkdir(dirname(absolute), { recursive: true });
      await state.page.screenshot({ path: absolute, fullPage, type: "png" });
      const { size } = await stat(absolute);
      return { path: absolute, bytes: size };
    });
  }

  console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    try {
      const state = this.live(session);
      return Promise.resolve(state.consoleLog.since(validateSinceSeq(sinceSeq)));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    try {
      const state = this.live(session);
      return Promise.resolve(state.networkLog.since(validateSinceSeq(sinceSeq)));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async listTabs(): Promise<LiveTab[]> {
    const tabs: LiveTab[] = [];
    for (const state of this.sessions.values()) {
      if (state.closing !== undefined || !state.ownsContext) continue;
      const pages = state.context.pages();
      for (let i = 0; i < pages.length; i += 1) {
        const page = pages[i];
        if (page === undefined || page.isClosed()) continue;
        const title = await page.title().catch(() => "");
        tabs.push({
          tabId: `managed:${this.name}:${state.id}:${i}`,
          browser: this.name,
          source: "managed",
          url: page.url(),
          title,
          active: page === state.page,
        });
      }
    }
    return tabs;
  }

  bindTab(tabId: string): Promise<BrowserSession> {
    const match = /^managed:[^:]+:([^:]+):(\d+)$/.exec(tabId);
    const owner = match === null ? undefined : this.sessions.get(match[1] ?? "");
    const page = owner?.context.pages()[Number(match?.[2] ?? -1)];
    if (owner === undefined || page === undefined || page.isClosed()) {
      throw new TabCtxError("TARGET_NOT_FOUND", `Tab ${tabId} is no longer open`);
    }
    owner.page = page;
    return Promise.resolve({ sessionId: owner.id });
  }

  private async launch(profileDir: string, headless: boolean): Promise<BrowserContext> {
    const engine = engineFor(this.name);
    const executablePath = resolveExecutable(this.name, this.options.executablePath);
    const context = await engine.launchPersistentContext(profileDir, {
      headless,
      viewport: VIEWPORT,
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return context;
  }

  private async track(context: BrowserContext, profileDir: string): Promise<BrowserSession> {
    let page: Page;
    try {
      page = context.pages()[0] ?? (await context.newPage());
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    const state: SessionState = {
      id: randomUUID(),
      profileDir,
      context,
      page,
      ownsContext: true,
      consoleLog: new SeqLog<ConsoleEntry>(),
      networkLog: new SeqLog<NetworkEntry>(),
      disconnectCallbacks: [],
      disconnected: false,
    };
    this.sessions.set(state.id, state);
    attachPageLogs(page, state.consoleLog, state.networkLog);
    context.on("close", () => void this.shutdown(state));
    page.on("close", () => void this.shutdown(state));
    return { sessionId: state.id };
  }

  private shutdown(state: SessionState): Promise<void> {
    state.closing ??= this.finishShutdown(state);
    return state.closing;
  }

  private async finishShutdown(state: SessionState): Promise<void> {
    try {
      await state.context.close();
    } catch {
      // Browser may already be gone.
    } finally {
      releaseProfile(state.profileDir);
      this.sessions.delete(state.id);
      fireDisconnect(state);
    }
  }

  private live(session: BrowserSession): SessionState {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closing !== undefined) {
      throw new TabCtxError("CONTEXT_CLOSED", "This browser context is closed or unknown");
    }
    return state;
  }

  private async act(
    session: BrowserSession,
    target: Target,
    failure: FailureContext,
    perform: (locator: Locator) => Promise<void>,
  ): Promise<ActionResult> {
    const state = this.live(session);
    const scoped: FailureContext = { ...failure, action: `${failure.action} ${describeTarget(target)}` };
    await guard(state, scoped, async () => {
      await perform(await resolveTarget(state.page, target));
    });
    return { matched: 1 };
  }
}
