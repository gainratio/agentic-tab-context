/**
 * Apple Events (JXA) plumbing for macOS live tabs: the runner, the scripts
 * that list and locate tabs, and translation of script failures.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AtcError } from "../../contracts/errors.js";
import type { BrowserName } from "../../contracts/types.js";

const execFileAsync = promisify(execFile);
const OSASCRIPT_TIMEOUT_MS = 5_000;

export type JxaRunner = (script: string) => Promise<string>;

/** macOS application name -> browser label. Chromium-family apps expose a stable tab `id`. */
export const APP_BY_BROWSER: Readonly<Partial<Record<BrowserName, string>>> = {
  chrome: "Google Chrome",
  brave: "Brave Browser",
  edge: "Microsoft Edge",
  chromium: "Chromium",
  safari: "Safari",
};

export async function defaultJxaRunner(script: string): Promise<string> {
  if (process.platform !== "darwin") return "[]";
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: OSASCRIPT_TIMEOUT_MS });
    return stdout.trim();
  } catch (error) {
    throw osascriptFailure(error);
  }
}

/**
 * Keep only what osascript printed. Node's own message echoes the whole command
 * line, including the script and its failure markers, which would be misread.
 */
export function osascriptFailure(error: unknown): Error {
  const failed = (typeof error === "object" && error !== null ? error : {}) as { stderr?: unknown; code?: unknown };
  const stderr = typeof failed.stderr === "string" ? failed.stderr.trim() : "";
  return new Error(stderr === "" ? `osascript failed (exit ${String(failed.code ?? "unknown")})` : stderr);
}

/** Lists every tab of every running supported browser. Read-only; triggers no permission prompt. */
export const LIST_SCRIPT = `
    const out = [];
    for (const [browser, appName] of Object.entries(${JSON.stringify(APP_BY_BROWSER)})) {
      try {
        const app = Application(appName);
        if (!app.running()) continue;
        const safari = appName === "Safari";
        app.windows().forEach((w, wi) => {
          const activeIndex = safari ? w.currentTab.index() : w.activeTabIndex();
          w.tabs().forEach((t, ti) => out.push({
            tabId: "macos:" + browser + ":" + (safari ? (wi + 1) + ":" + (ti + 1) : String(t.id())),
            browser, source: "macos", url: t.url() || "", title: (safari ? t.name() : t.title()) || "",
            active: wi === 0 && ti + 1 === activeIndex,
          }));
        });
      } catch (e) {}
    }
    JSON.stringify(out);`;

/** Chromium-family: find the tab by its browser-assigned id wherever it is now. */
export function chromiumPrelude(appName: string, tabId: string): string {
  return `
    const app = Application(${JSON.stringify(appName)});
    let tab = null;
    for (const w of app.windows()) { for (const t of w.tabs()) { if (String(t.id()) === ${JSON.stringify(tabId)}) tab = t; } }
    if (tab === null) throw new Error("ATC_TAB_GONE");`;
}

export interface SafariPosition {
  window: number;
  tab: number;
  url: string;
}

/**
 * Safari has no tab id. Trust the remembered position only if it still shows the
 * remembered URL (or we just navigated it); otherwise follow that URL if exactly
 * one tab shows it, else fail closed.
 */
export function safariLocateScript(position: SafariPosition, justNavigated: boolean): string {
  return `
    const app = Application("Safari");
    const want = ${JSON.stringify(position.url)};
    let hit = null;
    try { const t = app.windows[${position.window - 1}].tabs[${position.tab - 1}]; if (${justNavigated} || t.url() === want) hit = [${position.window}, ${position.tab}, t.url()]; } catch (e) {}
    if (hit === null) {
      const hits = [];
      app.windows().forEach((w, wi) => w.tabs().forEach((t, ti) => { if (t.url() === want) hits.push([wi + 1, ti + 1, want]); }));
      if (hits.length !== 1) throw new Error(hits.length === 0 ? "ATC_TAB_MOVED" : "ATC_TAB_AMBIGUOUS");
      hit = hits[0];
    }
    JSON.stringify({ window: hit[0], tab: hit[1], url: hit[2] || "" });`;
}

export function safariPrelude(position: SafariPosition): string {
  return `
    const app = Application("Safari");
    const tab = app.windows[${position.window - 1}].tabs[${position.tab - 1}];`;
}

const FAILURES: ReadonlyArray<readonly [RegExp, (appName: string) => AtcError]> = [
  [/ATC_TAB_GONE/, () => new AtcError("CONTEXT_CLOSED", "the bound tab was closed")],
  [/ATC_TAB_MOVED/, () => new AtcError("TAB_MOVED", "the bound Safari tab moved or navigated away; run `atc bind` again")],
  [/ATC_TAB_AMBIGUOUS/, () => new AtcError("TAB_MOVED", "several Safari tabs now show the bound page; run `atc bind --tab <id>`")],
  [
    /Allow JavaScript from Apple Events|JavaScript through AppleScript is turned off|-1743/i,
    (app) =>
      new AtcError(
        "ACTION_FAILED",
        `${app} blocks page access from other apps. Either install the atc browser extension (\`atc doctor\` shows how) ` +
          `or enable ${app === "Safari" ? "Develop" : "View > Developer"} > Allow JavaScript from Apple Events.`,
      ),
  ],
];

export function toJxaError(error: unknown, appName: string): AtcError {
  const message = error instanceof Error ? error.message : String(error);
  const match = FAILURES.find(([pattern]) => pattern.test(message));
  return match === undefined ? new AtcError("ACTION_FAILED", `${appName} did not respond: ${message}`) : match[1](appName);
}
