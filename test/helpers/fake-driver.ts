/**
 * In-memory BrowserDriver for daemon tests. Never launches a browser.
 *
 * - Each session has a history stack of URLs; titles derive from the URL.
 * - `failNext(method, error)` makes the next call of that method throw.
 * - `delayMs` makes every page call wait, and `active`/`maxActive` record
 *   per-session overlap so tests can prove serialization.
 * - `disconnect(session)` fires the registered onDisconnect callback.
 */
import { writeFile } from "node:fs/promises";
import type {
  ActionResult,
  BrowserDriver,
  BrowserName,
  BrowserSession,
  ConsoleEntry,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../src/contracts/types.js";

export interface FakeSessionState {
  options: OpenOptions;
  history: string[];
  index: number;
  closed: boolean;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  onDisconnect?: () => void;
}

export interface FakeCall {
  method: string;
  sessionId: string;
  args: unknown[];
}

export class FakeDriver implements BrowserDriver {
  readonly name: BrowserName;
  readonly sessions = new Map<string, FakeSessionState>();
  readonly calls: FakeCall[] = [];
  delayMs = 0;
  /** Current number of in-flight page calls, per session id. */
  readonly active = new Map<string, number>();
  /** Max overlap ever seen per session id, and across all sessions. */
  readonly maxActive = new Map<string, number>();
  maxActiveOverall = 0;
  private activeOverall = 0;
  private counter = 0;
  private readonly failures = new Map<string, unknown>();
  private readonly actionResults = new Map<string, ActionResult>();

  constructor(name: BrowserName = "chromium") {
    this.name = name;
  }

  failNext(method: keyof BrowserDriver, error: unknown): void {
    this.failures.set(method, error);
  }

  state(session: BrowserSession | string): FakeSessionState {
    const id = typeof session === "string" ? session : session.sessionId;
    const state = this.sessions.get(id);
    if (state === undefined) throw new Error(`unknown fake session ${id}`);
    return state;
  }

  disconnect(session: BrowserSession | string): void {
    const state = this.state(session);
    state.closed = true;
    state.onDisconnect?.();
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  async open(options: OpenOptions): Promise<BrowserSession> {
    this.counter += 1;
    const sessionId = `fake-${this.name}-${this.counter}`;
    this.record("open", sessionId, [options]);
    this.maybeFail("open");
    this.sessions.set(sessionId, { options, history: ["about:blank"], index: 0, closed: false, console: [], network: [] });
    return { sessionId };
  }

  async close(session: BrowserSession): Promise<void> {
    this.record("close", session.sessionId, []);
    this.maybeFail("close");
    this.state(session).closed = true;
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    this.state(session).onDisconnect = callback;
  }

  navigate(session: BrowserSession, url: string): Promise<void> {
    return this.page("navigate", session, [url], (s) => {
      s.history = [...s.history.slice(0, s.index + 1), url];
      s.index = s.history.length - 1;
    });
  }

  back(session: BrowserSession): Promise<void> {
    return this.page("back", session, [], (s) => {
      s.index = Math.max(0, s.index - 1);
    });
  }

  forward(session: BrowserSession): Promise<void> {
    return this.page("forward", session, [], (s) => {
      s.index = Math.min(s.history.length - 1, s.index + 1);
    });
  }

  reload(session: BrowserSession): Promise<void> {
    return this.page("reload", session, [], () => undefined);
  }

  location(session: BrowserSession): Promise<{ url: string; title: string }> {
    return this.page("location", session, [], (s) => locationOf(s));
  }

  inspect(session: BrowserSession): Promise<PageState> {
    return this.page("inspect", session, [], (s) => ({ ...locationOf(s), aria: `- heading "${titleOf(currentUrl(s))}"` }));
  }

  setActionResult(method: "click" | "type" | "select" | "press", result: ActionResult): void {
    this.actionResults.set(method, result);
  }

  click(session: BrowserSession, target: Target): Promise<ActionResult> {
    return this.page("click", session, [target], () => this.actionResults.get("click") ?? { matched: 1 });
  }

  type(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.page("type", session, [target, value], () => this.actionResults.get("type") ?? { matched: 1 });
  }

  select(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.page("select", session, [target, value], () => this.actionResults.get("select") ?? { matched: 1 });
  }

  press(session: BrowserSession, key: string): Promise<ActionResult> {
    return this.page("press", session, [key], () => this.actionResults.get("press") ?? { matched: 1 });
  }

  screenshot(session: BrowserSession, path: string, fullPage: boolean): Promise<ScreenshotResult> {
    return this.page("screenshot", session, [path, fullPage], async () => {
      const bytes = Buffer.from("fake-png");
      await writeFile(path, bytes);
      return { path, bytes: bytes.length };
    });
  }

  console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    return this.page("console", session, [sinceSeq], (s) => s.console.filter((e) => e.seq > sinceSeq));
  }

  network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    return this.page("network", session, [sinceSeq], (s) => s.network.filter((e) => e.seq > sinceSeq));
  }

  private record(method: string, sessionId: string, args: unknown[]): void {
    this.calls.push({ method, sessionId, args });
  }

  private maybeFail(method: string): void {
    if (!this.failures.has(method)) return;
    const error = this.failures.get(method);
    this.failures.delete(method);
    throw error;
  }

  private async page<T>(
    method: string,
    session: BrowserSession,
    args: unknown[],
    body: (state: FakeSessionState) => T | Promise<T>,
  ): Promise<T> {
    const id = session.sessionId;
    this.record(method, id, args);
    this.enter(id);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.maybeFail(method);
      const state = this.state(session);
      if (state.closed) throw new Error("fake session is closed");
      return await body(state);
    } finally {
      this.leave(id);
    }
  }

  private enter(id: string): void {
    const now = (this.active.get(id) ?? 0) + 1;
    this.active.set(id, now);
    this.maxActive.set(id, Math.max(this.maxActive.get(id) ?? 0, now));
    this.activeOverall += 1;
    this.maxActiveOverall = Math.max(this.maxActiveOverall, this.activeOverall);
  }

  private leave(id: string): void {
    this.active.set(id, (this.active.get(id) ?? 1) - 1);
    this.activeOverall -= 1;
  }
}

function currentUrl(state: FakeSessionState): string {
  return state.history[state.index] ?? "about:blank";
}

function titleOf(url: string): string {
  if (url === "about:blank") return "";
  const path = new URL(url).pathname;
  return path === "/" ? "Home" : path.replace(/^\//, "");
}

function locationOf(state: FakeSessionState): { url: string; title: string } {
  const url = currentUrl(state);
  return { url, title: titleOf(url) };
}

/** A deterministic random source returning the given 16-bit values in order. */
export function sequenceRandom(values: number[]): (size: number) => Uint8Array {
  let i = 0;
  return (size: number) => {
    const value = values[i % values.length] ?? 0;
    i += 1;
    const out = new Uint8Array(size);
    out[0] = (value >> 8) & 0xff;
    if (size > 1) out[1] = value & 0xff;
    return out;
  };
}
