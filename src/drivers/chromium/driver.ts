/**
 * ChromiumDriver: a BrowserDriver backed by Playwright's persistent Chromium context.
 *
 * One session == one persistent context (one user-data dir per profile) tracking exactly one page.
 * Playwright objects never leave this module; callers only ever see an opaque `sessionId`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readlink, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  chromium,
  errors,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
} from "playwright-core";
import { TabCtxError, type ErrorCode } from "../../contracts/errors.js";
import type {
  ActionResult,
  BrowserDriver,
  BrowserSession,
  ConsoleEntry,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../contracts/types.js";
import type { DriverOptions } from "../index.js";
import { describeTarget, pickOption, resolveTarget, type SelectOptionInfo } from "../target.js";

export type ChromiumFamily = "chromium" | "chrome";

const VIEWPORT = { width: 1280, height: 800 } as const;
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const LOG_CAPACITY = 500;
const ERROR_PAGE_SETTLE_MS = 2_000;

/** User-data dirs currently owned by a session in this process (all driver instances). */
const profilesInUse = new Set<string>();

/** Fixed-size log that numbers entries 1, 2, 3, ... and drops the oldest past capacity. */
class SeqLog<T extends { seq: number }> {
  private readonly items: T[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity: number) {}

  push(build: (seq: number) => T): void {
    this.items.push(build(this.nextSeq));
    this.nextSeq += 1;
    if (this.items.length > this.capacity) this.items.shift();
  }

  since(seq: number): T[] {
    return this.items.filter((item) => item.seq > seq).map((item) => ({ ...item }));
  }
}

interface SessionState {
  readonly id: string;
  readonly profileDir: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly consoleLog: SeqLog<ConsoleEntry>;
  readonly networkLog: SeqLog<NetworkEntry>;
  readonly disconnectCallbacks: Array<() => void>;
  disconnected: boolean;
  closing?: Promise<void>;
}

interface FailureContext {
  action: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
  /** A value (e.g. typed text) that must never appear in the error message. */
  secret?: string;
}

export class ChromiumDriver implements BrowserDriver {
  readonly name: ChromiumFamily;
  private readonly options: DriverOptions;
  private readonly sessions = new Map<string, SessionState>();

  constructor(name: ChromiumFamily, options: DriverOptions) {
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
      profilesInUse.delete(profileDir);
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
    await navigation(state, navFailure("navigate", url), () =>
      state.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async back(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, navFailure("go back", state.page.url()), () =>
      state.page.goBack({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async forward(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, navFailure("go forward", state.page.url()), () =>
      state.page.goForward({ waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS }),
    );
  }

  async reload(session: BrowserSession): Promise<void> {
    const state = this.live(session);
    await navigation(state, navFailure("reload", state.page.url()), () =>
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

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    const state = this.live(session);
    return Promise.resolve(state.consoleLog.since(validateSinceSeq(sinceSeq)));
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    const state = this.live(session);
    return Promise.resolve(state.networkLog.since(validateSinceSeq(sinceSeq)));
  }

  private async launch(profileDir: string, headless: boolean): Promise<BrowserContext> {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: VIEWPORT,
      ...this.executableOptions(),
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return context;
  }

  private executableOptions(): { executablePath: string } | { channel: string } | Record<string, never> {
    if (this.options.executablePath !== undefined) return { executablePath: this.options.executablePath };
    if (this.name === "chrome") return { channel: "chrome" };
    return {};
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
      consoleLog: new SeqLog<ConsoleEntry>(LOG_CAPACITY),
      networkLog: new SeqLog<NetworkEntry>(LOG_CAPACITY),
      disconnectCallbacks: [],
      disconnected: false,
    };
    this.sessions.set(state.id, state);
    recordConsole(state);
    recordNetwork(state);
    context.on("close", () => void this.shutdown(state));
    page.on("close", () => void this.shutdown(state));
    return { sessionId: state.id };
  }

  /** Close the context (once), free the profile, forget the session, then fire disconnect callbacks. */
  private shutdown(state: SessionState): Promise<void> {
    state.closing ??= this.finishShutdown(state);
    return state.closing;
  }

  private async finishShutdown(state: SessionState): Promise<void> {
    try {
      await state.context.close();
    } catch {
      // The browser may already be gone; either way the session is over.
    } finally {
      profilesInUse.delete(state.profileDir);
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

function fireDisconnect(state: SessionState): void {
  if (state.disconnected) return;
  state.disconnected = true;
  for (const callback of state.disconnectCallbacks.splice(0)) {
    try {
      callback();
    } catch {
      // A misbehaving listener must not break shutdown for the others.
    }
  }
}

async function selectOption(locator: Locator, target: Target, value: string): Promise<void> {
  const options = await readSelectOptions(locator);
  if (options === null) {
    throw new TabCtxError("ACTION_FAILED", `Target ${describeTarget(target)} is not a <select> element`);
  }
  const choice = pickOption(options, value);
  if (choice === null) {
    throw new TabCtxError(
      "TARGET_NOT_FOUND",
      `The <select> matched by ${describeTarget(target)} has no option with that label or value`,
      { matched: 0 },
    );
  }
  await locator.selectOption(choice, { timeout: ACTION_TIMEOUT_MS });
}

function readSelectOptions(locator: Locator): Promise<SelectOptionInfo[] | null> {
  return locator.evaluate((element) =>
    element instanceof HTMLSelectElement
      ? Array.from(element.options, (option) => ({ label: option.label, value: option.value }))
      : null,
  );
}

function recordConsole(state: SessionState): void {
  state.page.on("console", (message: ConsoleMessage) => {
    const url = message.location().url;
    state.consoleLog.push((seq) => ({
      seq,
      type: message.type(),
      text: message.text(),
      ...(url === "" ? {} : { url }),
      at: new Date().toISOString(),
    }));
  });
  state.page.on("pageerror", (error: Error) => {
    state.consoleLog.push((seq) => ({
      seq,
      type: "pageerror",
      text: error.message,
      url: state.page.url(),
      at: new Date().toISOString(),
    }));
  });
}

function recordNetwork(state: SessionState): void {
  state.page.on("requestfinished", (request: Request) => {
    void request
      .response()
      .then((response) => response?.status())
      .catch(() => undefined)
      .then((status) => {
        state.networkLog.push((seq) => ({
          ...requestFields(seq, request),
          ...(status === undefined ? {} : { status }),
        }));
      });
  });
  state.page.on("requestfailed", (request: Request) => {
    state.networkLog.push((seq) => ({
      ...requestFields(seq, request),
      failure: request.failure()?.errorText ?? "unknown failure",
    }));
  });
}

function requestFields(seq: number, request: Request): NetworkEntry {
  return {
    seq,
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    at: new Date().toISOString(),
  };
}

/** Run a navigation; on failure, let Chromium's error page settle before reporting it. */
async function navigation(state: SessionState, failure: FailureContext, run: () => Promise<unknown>): Promise<void> {
  await guard(state, failure, async () => {
    try {
      await run();
    } catch (error) {
      await settleErrorPage(state.page, error);
      throw error;
    }
  });
}

/**
 * After a network-level failure (net::ERR_*), Chromium commits `chrome-error://chromewebdata/`
 * a moment *after* Playwright rejects. Without waiting, that late commit interrupts the next
 * navigation. Best effort and bounded; ERR_ABORTED produces no error page, so it is skipped.
 */
async function settleErrorPage(page: Page, error: unknown): Promise<void> {
  if (!/net::ERR_(?!ABORTED)/.test(firstLine(error))) return;
  try {
    if (!page.url().startsWith("chrome-error:")) {
      await page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: ERROR_PAGE_SETTLE_MS,
      });
    }
    await page.waitForLoadState("load", { timeout: ERROR_PAGE_SETTLE_MS });
  } catch {
    // Nothing committed in time; report the original failure regardless.
  }
}

function navFailure(action: string, url: string): FailureContext {
  return { action, code: "NAVIGATION_FAILED", details: { url } };
}

async function guard<T>(state: SessionState, failure: FailureContext, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (state.closing !== undefined && !(error instanceof TabCtxError)) {
      throw new TabCtxError("CONTEXT_CLOSED", `Cannot ${failure.action}: the browser context closed`);
    }
    throw toTabCtxError(error, failure);
  }
}

/** Map any thrown value to a TabCtxError without leaking secrets or Playwright call logs. */
function toTabCtxError(error: unknown, failure: FailureContext): TabCtxError {
  if (error instanceof TabCtxError) return error;
  const reason = scrub(firstLine(error), failure.secret);
  const details = failure.details ?? {};
  if (error instanceof errors.TimeoutError) {
    return new TabCtxError("TIMEOUT", `Timed out trying to ${failure.action}: ${reason}`, details);
  }
  if (/has been closed/i.test(reason)) {
    return new TabCtxError("CONTEXT_CLOSED", `Cannot ${failure.action}: the browser context closed`, details);
  }
  return new TabCtxError(failure.code, `Failed to ${failure.action}: ${reason}`, details);
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n")[0] ?? "").trim();
}

function scrub(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") return text;
  return text.split(secret).join("[redacted]");
}

function validateProfileName(profile: string): string {
  const invalid = profile === "" || profile === "." || profile === ".." || /[/\\\0]/.test(profile);
  if (invalid) {
    throw new TabCtxError("INVALID_ARGUMENT", "Profile name must be a non-empty name without path separators", {
      profile,
    });
  }
  return profile;
}

function validateSinceSeq(sinceSeq: number): number {
  if (!Number.isFinite(sinceSeq)) {
    throw new TabCtxError("INVALID_ARGUMENT", "since must be a finite number");
  }
  return sinceSeq;
}

function profileInUse(profile: string): TabCtxError {
  return new TabCtxError(
    "ACTION_FAILED",
    `Profile "${profile}" is already in use by another open context; close it first or use a different --profile`,
    { profile },
  );
}

/** Synchronously reserve the profile dir so concurrent opens of the same profile cannot race. */
function claimProfile(profileDir: string, profile: string): void {
  if (profilesInUse.has(profileDir)) throw profileInUse(profile);
  profilesInUse.add(profileDir);
}

/**
 * Chromium writes `SingletonLock -> <hostname>-<pid>` into a user-data dir it owns. If that
 * process is alive on this host, a launch would fail (or hand off to it), so fail cleanly first.
 * Stale locks from dead processes are ignored; Chromium cleans those up itself.
 */
async function assertNotLockedByOtherProcess(profileDir: string, profile: string): Promise<void> {
  const owner = await readSingletonLock(profileDir);
  if (owner !== null && owner.host === hostname() && isProcessAlive(owner.pid)) {
    throw profileInUse(profile);
  }
}

async function readSingletonLock(profileDir: string): Promise<{ host: string; pid: number } | null> {
  try {
    const link = await readlink(join(profileDir, "SingletonLock"));
    const match = /^(.*)-(\d+)$/.exec(link);
    if (match === null) return null;
    return { host: match[1] ?? "", pid: Number(match[2]) };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
