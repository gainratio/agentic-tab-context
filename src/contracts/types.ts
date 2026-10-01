/**
 * Shared contracts for tabctx. Every module (cli, daemon, drivers) imports from
 * here and never from each other's internals. Browser-native identifiers (CDP
 * targets, WebDriver handles, Playwright objects) never cross this boundary.
 */

export const BROWSERS = ["chromium", "chrome", "safari", "firefox"] as const;
export type BrowserName = (typeof BROWSERS)[number];

export type ContextStatus = "open" | "closed";

/** The public, stable view of one browser context. */
export interface TabContext {
  id: string; // "ctx_7f21"
  browser: BrowserName;
  status: ContextStatus;
  profile: string; // profile name; same profile => same cookies/logins across contexts and restarts
  url?: string;
  title?: string;
  createdAt: string; // ISO-8601
}

/** How a command picks exactly one element. Exactly one locator kind is set. */
export type Target =
  | { kind: "role"; role: string; name?: string; nth?: number }
  | { kind: "label"; label: string; nth?: number }
  | { kind: "text"; text: string; nth?: number }
  | { kind: "placeholder"; placeholder: string; nth?: number }
  | { kind: "testid"; testid: string; nth?: number }
  | { kind: "selector"; selector: string; nth?: number };

export interface PageState {
  url: string;
  title: string;
  /** Playwright ARIA snapshot (YAML) of the page body: roles, names, values. */
  aria: string;
}

export interface ActionResult {
  matched: number; // always 1 on success
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
}

export interface ConsoleEntry {
  seq: number; // monotonically increasing per context
  type: string; // "log" | "error" | "warning" | "pageerror" | ...
  text: string;
  url?: string;
  at: string; // ISO-8601
}

export interface NetworkEntry {
  seq: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number; // absent when the request failed or has not completed
  failure?: string;
  at: string;
}

export interface OpenOptions {
  profile: string;
  headless: boolean;
}

/** Opaque handle owned by a driver. The daemon never looks inside. */
export interface BrowserSession {
  readonly sessionId: string;
}

/** One adapter per browser family. Every method is deterministic: it never guesses. */
export interface BrowserDriver {
  readonly name: BrowserName;
  open(options: OpenOptions): Promise<BrowserSession>;
  close(session: BrowserSession): Promise<void>;
  /** Registers a callback fired once when the underlying browser/page disappears. */
  onDisconnect(session: BrowserSession, callback: () => void): void;
  navigate(session: BrowserSession, url: string): Promise<void>;
  back(session: BrowserSession): Promise<void>;
  forward(session: BrowserSession): Promise<void>;
  reload(session: BrowserSession): Promise<void>;
  location(session: BrowserSession): Promise<{ url: string; title: string }>;
  inspect(session: BrowserSession): Promise<PageState>;
  click(session: BrowserSession, target: Target): Promise<ActionResult>;
  type(session: BrowserSession, target: Target, value: string): Promise<ActionResult>;
  select(session: BrowserSession, target: Target, value: string): Promise<ActionResult>;
  screenshot(session: BrowserSession, path: string, fullPage: boolean): Promise<ScreenshotResult>;
  console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]>;
  network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]>;
}

export type DriverFactory = (browser: BrowserName) => BrowserDriver;
