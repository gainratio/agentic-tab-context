/**
 * PlaywrightDriver: a persistent browser window per profile (`atc open`), for
 * chromium, chrome, brave, edge, firefox and webkit. Logins stay in the profile.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Locator } from "playwright-core";
import { AtcError } from "../../contracts/errors.js";
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
import type { ManagedBrowser } from "./executables.js";
import { ACTION_TIMEOUT_MS, type FailureContext, NAVIGATION_TIMEOUT_MS, fireDisconnect, guard, navFailure, navigation, selectOption, toAtcError } from "./helpers.js";
import { assertNotLockedByOtherProcess, claimProfile, releaseProfile, validateProfileName } from "./locks.js";
import { validateSinceSeq } from "./logs.js";
import { type SessionState, launchContext, newSession } from "./session.js";

const LOAD = { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS } as const;
const MANAGED_TAB = /^managed:[^:]+:([^:]+):(\d+)$/;

export class PlaywrightDriver implements BrowserDriver {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    readonly name: ManagedBrowser,
    private readonly options: DriverOptions,
  ) {}

  async open(options: OpenOptions): Promise<BrowserSession> {
    const profileDir = resolve(this.options.profilesDir, validateProfileName(options.profile));
    claimProfile(profileDir, options.profile);
    try {
      await assertNotLockedByOtherProcess(profileDir, options.profile);
      await mkdir(profileDir, { recursive: true });
      return this.track(await newSession(await launchContext(this.name, profileDir, options.headless, this.options.executablePath), profileDir));
    } catch (error) {
      releaseProfile(profileDir);
      throw toAtcError(error, { action: "open browser", code: "ACTION_FAILED" });
    }
  }

  async close(session: BrowserSession): Promise<void> {
    const state = this.sessions.get(session.sessionId);
    if (state !== undefined) await this.shutdown(state);
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.disconnected) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("navigate", url), () => state.page.goto(url, LOAD));
  }

  async back(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("go back", state.page.url()), () => state.page.goBack(LOAD));
  }

  async forward(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("go forward", state.page.url()), () => state.page.goForward(LOAD));
  }

  async reload(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, state.page, navFailure("reload", state.page.url()), () => state.page.reload(LOAD));
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const state = this.live(session);
    return guard(state, { action: "read location", code: "ACTION_FAILED" }, async () => ({ url: state.page.url(), title: await state.page.title() }));
  }

  async inspect(session: BrowserSession): Promise<PageState> {
    const state = this.live(session);
    return guard(state, { action: "inspect", code: "ACTION_FAILED" }, async () => ({
      url: state.page.url(),
      title: await state.page.title(),
      aria: await state.page.locator("body").ariaSnapshot(),
    }));
  }

  click(session: BrowserSession, target: Target): Promise<ActionResult> {
    return this.act(session, target, { action: "click", code: "ACTION_FAILED" }, (locator) => locator.click({ timeout: ACTION_TIMEOUT_MS }));
  }

  type(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    const failure: FailureContext = { action: "type", code: "ACTION_FAILED", secret: value };
    return this.act(session, target, failure, (locator) => locator.fill(value, { timeout: ACTION_TIMEOUT_MS }));
  }

  select(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    const failure: FailureContext = { action: "select", code: "ACTION_FAILED", secret: value };
    return this.act(session, target, failure, (locator) => selectOption(locator, target, value));
  }

  async screenshot(session: BrowserSession, path: string, fullPage: boolean): Promise<ScreenshotResult> {
    const state = this.live(session);
    const absolute = resolve(path);
    return guard(state, { action: "screenshot", code: "ACTION_FAILED", details: { path: absolute } }, async () => {
      await mkdir(dirname(absolute), { recursive: true });
      await state.page.screenshot({ path: absolute, fullPage, type: "png" });
      return { path: absolute, bytes: (await stat(absolute)).size };
    });
  }

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    return this.live(session).consoleLog.since(validateSinceSeq(sinceSeq));
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    return this.live(session).networkLog.since(validateSinceSeq(sinceSeq));
  }

  async listTabs(): Promise<LiveTab[]> {
    const open = [...this.sessions.values()].filter((state) => state.closing === undefined);
    const nested = await Promise.all(open.map((state) => this.tabsOf(state)));
    return nested.flat();
  }

  bindTab(tabId: string): Promise<BrowserSession> {
    const match = MANAGED_TAB.exec(tabId);
    const owner = match === null ? undefined : this.sessions.get(match[1] ?? "");
    const page = owner?.context.pages()[Number(match?.[2] ?? -1)];
    if (owner === undefined || page === undefined || page.isClosed()) {
      return Promise.reject(new AtcError("TARGET_NOT_FOUND", `tab ${tabId} is no longer open`));
    }
    owner.page = page;
    return Promise.resolve({ sessionId: owner.id });
  }

  private async tabsOf(state: SessionState): Promise<LiveTab[]> {
    const pages = state.context.pages().map((page, index) => ({ page, index })).filter(({ page }) => !page.isClosed());
    return Promise.all(
      pages.map(async ({ page, index }) => ({
        tabId: `managed:${this.name}:${state.id}:${index}`,
        browser: this.name,
        source: "managed" as const,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: page === state.page,
      })),
    );
  }

  private track(state: SessionState): BrowserSession {
    this.sessions.set(state.id, state);
    state.context.on("close", () => void this.shutdown(state));
    state.page.on("close", () => void this.shutdown(state));
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

  /** Throws CONTEXT_CLOSED synchronously-in-a-promise for closed or unknown sessions. */
  private live(session: BrowserSession): SessionState {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closing !== undefined) throw new AtcError("CONTEXT_CLOSED", "This browser context is closed or unknown");
    return state;
  }

  private async act(session: BrowserSession, target: Target, failure: FailureContext, perform: (locator: Locator) => Promise<void>): Promise<ActionResult> {
    const state = this.live(session);
    const scoped: FailureContext = { ...failure, action: `${failure.action} ${describeTarget(target)}` };
    await guard(state, scoped, async () => perform(await resolveTarget(state.page, target)));
    return { matched: 1 };
  }
}
