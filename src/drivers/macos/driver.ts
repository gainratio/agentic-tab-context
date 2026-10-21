/**
 * MacosTabDriver: zero-config discovery and binding to already-open tabs in
 * macOS browsers (Google Chrome, Safari, Brave Browser, Microsoft Edge) via JXA.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { TabCtxError } from "../../contracts/errors.js";
import type {
  ActionResult,
  BrowserDriver,
  BrowserName,
  BrowserSession,
  ConsoleEntry,
  LiveTab,
  NetworkEntry,
  OpenOptions,
  PageState,
  ScreenshotResult,
  Target,
} from "../../contracts/types.js";
import { buildActionExpression, buildInspectExpression, buildLogsExpression } from "../dom-script.js";

const execFileAsync = promisify(execFile);

export type JxaRunner = (script: string) => Promise<string>;

const APP_MAP: Readonly<Record<string, BrowserName>> = {
  "Google Chrome": "chrome",
  Safari: "safari",
  "Brave Browser": "brave",
  "Microsoft Edge": "edge",
  Chromium: "chromium",
};

const BROWSER_TO_APP: Readonly<Record<string, string>> = {
  chrome: "Google Chrome",
  safari: "Safari",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
  chromium: "Chromium",
};

export async function defaultJxaRunner(script: string): Promise<string> {
  if (process.platform !== "darwin") return "[]";
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 5_000 });
  return stdout.trim();
}

export async function listMacosTabs(runJxa: JxaRunner = defaultJxaRunner): Promise<LiveTab[]> {
  if (process.platform !== "darwin" && runJxa === defaultJxaRunner) return [];
  const script = `
    const map = ${JSON.stringify(APP_MAP)};
    const out = [];
    for (const [appName, browser] of Object.entries(map)) {
      try {
        const app = Application(appName);
        if (!app.running()) continue;
        const wins = app.windows();
        for (let w = 0; w < wins.length; w++) {
          const tabs = wins[w].tabs();
          const activeIdx = appName === "Safari" ? wins[w].currentTab.index() : wins[w].activeTabIndex();
          for (let t = 0; t < tabs.length; t++) {
            const tab = tabs[t];
            const url = tab.url() || "";
            const title = (appName === "Safari" ? tab.name() : tab.title()) || "";
            out.push({
              tabId: "macos:" + browser + ":" + (w + 1) + ":" + (t + 1),
              browser,
              source: "macos",
              url,
              title,
              active: w === 0 && (t + 1) === activeIdx
            });
          }
        }
      } catch (e) {}
    }
    JSON.stringify(out);
  `;
  try {
    return JSON.parse(await runJxa(script)) as LiveTab[];
  } catch {
    return [];
  }
}

interface MacosSession {
  id: string;
  browser: BrowserName;
  appName: string;
  winIndex: number;
  tabIndex: number;
  closed: boolean;
  disconnectCallbacks: Array<() => void>;
}

export class MacosTabDriver implements BrowserDriver {
  readonly name: BrowserName = "chrome";
  private readonly runJxa: JxaRunner;
  private readonly sessions = new Map<string, MacosSession>();

  constructor(runJxa: JxaRunner = defaultJxaRunner) {
    this.runJxa = runJxa;
  }

  async open(_options: OpenOptions): Promise<BrowserSession> {
    const tabs = await this.listTabs();
    const active = tabs.find((t) => t.active) ?? tabs[0];
    if (active === undefined) {
      throw new TabCtxError("TARGET_NOT_FOUND", "No open macOS browser tabs found");
    }
    return this.bindTab(active.tabId);
  }

  listTabs(): Promise<LiveTab[]> {
    return listMacosTabs(this.runJxa);
  }

  bindTab(tabId: string): Promise<BrowserSession> {
    const match = /^macos:([a-z]+):(\d+):(\d+)$/.exec(tabId);
    const browser = (match?.[1] ?? "") as BrowserName;
    const appName = BROWSER_TO_APP[browser];
    if (match === null || appName === undefined) {
      throw new TabCtxError("INVALID_ARGUMENT", `Invalid macos tabId: ${tabId}`);
    }
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      browser,
      appName,
      winIndex: Number(match[2]),
      tabIndex: Number(match[3]),
      closed: false,
      disconnectCallbacks: [],
    });
    return Promise.resolve({ sessionId: id });
  }

  close(session: BrowserSession): Promise<void> {
    const state = this.sessions.get(session.sessionId);
    if (state !== undefined && !state.closed) {
      state.closed = true;
      this.sessions.delete(state.id);
      for (const cb of state.disconnectCallbacks.splice(0)) cb();
    }
    return Promise.resolve();
  }

  onDisconnect(session: BrowserSession, callback: () => void): void {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closed) queueMicrotask(callback);
    else state.disconnectCallbacks.push(callback);
  }

  async navigate(session: BrowserSession, url: string): Promise<void> {
    const s = this.live(session);
    await this.runJxa(`
      const app = Application(${JSON.stringify(s.appName)});
      const tab = app.windows[${s.winIndex - 1}].tabs[${s.tabIndex - 1}];
      tab.url = ${JSON.stringify(url)};
      "ok";
    `);
  }

  async back(session: BrowserSession): Promise<void> {
    await this.evalJs(session, "history.back(); 'ok'");
  }

  async forward(session: BrowserSession): Promise<void> {
    await this.evalJs(session, "history.forward(); 'ok'");
  }

  async reload(session: BrowserSession): Promise<void> {
    const s = this.live(session);
    if (s.appName === "Safari") {
      await this.evalJs(session, "location.reload(); 'ok'");
      return;
    }
    await this.runJxa(`
      const app = Application(${JSON.stringify(s.appName)});
      app.windows[${s.winIndex - 1}].tabs[${s.tabIndex - 1}].reload();
      "ok";
    `);
  }

  async location(session: BrowserSession): Promise<{ url: string; title: string }> {
    const s = this.live(session);
    const out = await this.runJxa(`
      const app = Application(${JSON.stringify(s.appName)});
      const tab = app.windows[${s.winIndex - 1}].tabs[${s.tabIndex - 1}];
      const url = tab.url() || "";
      const title = (${JSON.stringify(s.appName)} === "Safari" ? tab.name() : tab.title()) || "";
      JSON.stringify({ url, title });
    `);
    return JSON.parse(out) as { url: string; title: string };
  }

  async inspect(session: BrowserSession): Promise<PageState> {
    const raw = await this.evalJs(session, buildInspectExpression());
    return JSON.parse(raw) as PageState;
  }

  click(session: BrowserSession, target: Target): Promise<ActionResult> {
    return this.act(session, "click", target);
  }

  type(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.act(session, "type", target, value);
  }

  select(session: BrowserSession, target: Target, value: string): Promise<ActionResult> {
    return this.act(session, "select", target, value);
  }

  async screenshot(_session: BrowserSession, path: string, _fullPage: boolean): Promise<ScreenshotResult> {
    const absolute = resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await execFileAsync("screencapture", ["-x", absolute]);
    const { size } = await stat(absolute);
    return { path: absolute, bytes: size };
  }

  async console(session: BrowserSession, sinceSeq: number): Promise<ConsoleEntry[]> {
    const raw = await this.evalJs(session, buildLogsExpression("console", sinceSeq));
    return JSON.parse(raw) as ConsoleEntry[];
  }

  async network(session: BrowserSession, sinceSeq: number): Promise<NetworkEntry[]> {
    const raw = await this.evalJs(session, buildLogsExpression("network", sinceSeq));
    return JSON.parse(raw) as NetworkEntry[];
  }

  private async act(
    session: BrowserSession,
    action: "click" | "type" | "select",
    target: Target,
    value?: string,
  ): Promise<ActionResult> {
    const raw = await this.evalJs(session, buildActionExpression(action, target, value));
    const parsed = JSON.parse(raw) as { ok: boolean; error?: "TARGET_NOT_FOUND"; message?: string; matched?: number };
    if (!parsed.ok) {
      throw new TabCtxError(parsed.error ?? "ACTION_FAILED", parsed.message ?? "Action failed", {
        ...(parsed.matched === undefined ? {} : { matched: parsed.matched }),
      });
    }
    return { matched: 1 };
  }

  private async evalJs(session: BrowserSession, expression: string): Promise<string> {
    const s = this.live(session);
    const call =
      s.appName === "Safari"
        ? `app.doJavaScript(${JSON.stringify(expression)}, { in: tab })`
        : `app.execute(tab, { javascript: ${JSON.stringify(expression)} })`;
    try {
      return await this.runJxa(`
        const app = Application(${JSON.stringify(s.appName)});
        const tab = app.windows[${s.winIndex - 1}].tabs[${s.tabIndex - 1}];
        String(${call});
      `);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/AppleScript is turned off|Allow JavaScript from Apple Events/i.test(msg)) {
        throw new TabCtxError(
          "ACTION_FAILED",
          `Live DOM access in ${s.appName} requires either: (1) menu bar View > Developer > Allow JavaScript from Apple Events, or (2) loading the Agentic Browser Tab extension (see 'abt setup').`,
        );
      }
      throw new TabCtxError("ACTION_FAILED", `Failed to evaluate in ${s.appName} tab: ${msg}`);
    }
  }

  private live(session: BrowserSession): MacosSession {
    const state = this.sessions.get(session.sessionId);
    if (state === undefined || state.closed) {
      throw new TabCtxError("CONTEXT_CLOSED", "This browser context is closed or unknown");
    }
    return state;
  }
}
