/**
 * Launching and tracking one persistent Playwright browser context per profile.
 */
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright-core";
import { AtcError } from "../../contracts/errors.js";
import type { ConsoleEntry, NetworkEntry } from "../../contracts/types.js";
import { type ManagedBrowser, engineFor, resolveExecutable } from "./executables.js";
import { ACTION_TIMEOUT_MS, type DisconnectableState, NAVIGATION_TIMEOUT_MS } from "./helpers.js";
import { SeqLog, attachPageLogs } from "./logs.js";

const VIEWPORT = { width: 1280, height: 800 } as const;

const INSTALL_HINTS: Readonly<Record<ManagedBrowser, string>> = {
  chromium: "Playwright's Chromium is not installed; run `npx playwright-core install chromium`",
  firefox: "Playwright's Firefox is not installed; run `npx playwright-core install firefox`",
  webkit: "Playwright's WebKit is not installed; run `npx playwright-core install webkit`",
  chrome: "Google Chrome is not installed; use `atc open chromium` instead",
  brave: "Brave is not installed",
  edge: "Microsoft Edge is not installed",
};

export interface SessionState extends DisconnectableState {
  readonly id: string;
  readonly profileDir: string;
  readonly context: BrowserContext;
  page: Page;
  readonly consoleLog: SeqLog<ConsoleEntry>;
  readonly networkLog: SeqLog<NetworkEntry>;
}

export async function launchContext(
  browser: ManagedBrowser,
  profileDir: string,
  headless: boolean,
  chromiumOverride?: string,
): Promise<BrowserContext> {
  const executablePath = resolveExecutable(browser, chromiumOverride);
  if (executablePath === undefined) throw new AtcError("UNSUPPORTED_BROWSER", INSTALL_HINTS[browser], { browser });
  const context = await engineFor(browser).launchPersistentContext(profileDir, { headless, viewport: VIEWPORT, executablePath });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  return context;
}

/** Wrap a fresh context: reuse its first page (or open one) and start recording logs. */
export async function newSession(context: BrowserContext, profileDir: string): Promise<SessionState> {
  const page = await firstPage(context);
  const state: SessionState = {
    id: randomUUID(),
    profileDir,
    context,
    page,
    consoleLog: new SeqLog<ConsoleEntry>(),
    networkLog: new SeqLog<NetworkEntry>(),
    disconnectCallbacks: [],
    disconnected: false,
  };
  attachPageLogs(page, state.consoleLog, state.networkLog);
  return state;
}

async function firstPage(context: BrowserContext): Promise<Page> {
  try {
    return context.pages()[0] ?? (await context.newPage());
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
