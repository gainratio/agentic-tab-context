/**
 * Shared contracts for agentic-tab-context (atc). Every module (cli,
 * daemon, drivers) imports from here and never from each other's internals.
 */

export const BROWSERS = [
  "chromium",
  "chrome",
  "brave",
  "edge",
  "firefox",
  "safari",
  "webkit",
  "extension",
] as const;
export type BrowserName = (typeof BROWSERS)[number];

export type ContextStatus = "open" | "closed";
export type TabSource = "extension" | "managed" | "macos";

/** The public, stable view of one browser context. */
export interface TabContext {
  id: string; // "ctx_7f21"
  browser: BrowserName;
  status: ContextStatus;
  profile: string;
  source?: TabSource;
  tabId?: string;
  url?: string;
  title?: string;
  createdAt: string; // ISO-8601
}

/** One live open tab discovered across extension, managed, or OS browsers. */
export interface LiveTab {
  tabId: string;
  browser: BrowserName;
  source: TabSource;
  url: string;
  title: string;
  active: boolean;
  context?: string;
}

/** Filter for finding and binding to an already-open browser tab. */
export interface BindOptions {
  tab?: string;
  query?: string;
  url?: string;
  title?: string;
  browser?: BrowserName;
  active?: boolean;
  use?: boolean;
}

/** Locator kinds whose value lives in a field named after the kind (label.label, text.text, ...). */
export const SIMPLE_LOCATOR_KINDS = ["label", "text", "placeholder", "testid", "selector"] as const;
export type SimpleLocatorKind = (typeof SIMPLE_LOCATOR_KINDS)[number];

export function simpleTarget(kind: SimpleLocatorKind, value: string): Target {
  return { kind, [kind]: value } as unknown as Target;
}

/** How a command picks exactly one element. Exactly one locator kind is set. */
export type Target = (
  | { kind: "role"; role: string; name?: string; nth?: number }
  | { kind: "label"; label: string; nth?: number }
  | { kind: "text"; text: string; nth?: number }
  | { kind: "placeholder"; placeholder: string; nth?: number }
  | { kind: "testid"; testid: string; nth?: number }
  | { kind: "selector"; selector: string; nth?: number }
) & { readonly within?: string };

export interface PageState {
  url: string;
  title: string;
  /** ARIA snapshot (YAML) of the page body: roles, names, values. */
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
  seq: number;
  type: string;
  text: string;
  url?: string;
  at: string;
}

export interface NetworkEntry {
  seq: number;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
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
  /** Stable target identity, when the driver can enumerate and rebind tabs. */
  readonly tabId?: string;
}

/** One adapter per browser family. Every method is deterministic: it never guesses. */
export interface BrowserDriver {
  readonly name: BrowserName;
  open(options: OpenOptions): Promise<BrowserSession>;
  close(session: BrowserSession): Promise<void>;
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
  press(session: BrowserSession, key: string): Promise<ActionResult>;
  upload(session: BrowserSession, target: Target, path: string): Promise<ActionResult>;
  screenshot(session: BrowserSession, path: string, fullPage: boolean): Promise<ScreenshotResult>;
  console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]>;
  network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]>;
  listTabs?(): Promise<LiveTab[]>;
  bindTab?(tabId: string): Promise<BrowserSession>;
}

export type DriverFactory = (browser: BrowserName) => BrowserDriver;
