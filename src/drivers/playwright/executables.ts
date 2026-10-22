/**
 * Finds the browser executable for a managed (`atc open`) window. Only real
 * matches are returned: Brave/Edge/Chrome must actually be installed, and
 * Firefox/WebKit must be Playwright's builds (stock Firefox and Safari cannot
 * be automated this way). Nothing silently substitutes another browser.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserType, chromium, firefox, webkit } from "playwright-core";

export const MANAGED_BROWSERS = ["chromium", "chrome", "brave", "edge", "firefox", "webkit"] as const;
export type ManagedBrowser = (typeof MANAGED_BROWSERS)[number];
type Family = "chromium" | "firefox" | "webkit";

const INSTALLED_APPS: Readonly<Record<"chrome" | "brave" | "edge", readonly string[]>> = {
  chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
  brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/usr/bin/brave-browser"],
  edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/microsoft-edge"],
};

export function engineFor(browser: ManagedBrowser): BrowserType {
  if (browser === "firefox") return firefox;
  if (browser === "webkit") return webkit;
  return chromium;
}

/** `chromiumOverride` (ATC_CHROMIUM_PATH) applies only to the `chromium` target. */
export function resolveExecutable(browser: ManagedBrowser, chromiumOverride?: string): string | undefined {
  if (browser === "chromium" && chromiumOverride !== undefined && existsSync(chromiumOverride)) return chromiumOverride;
  if (browser === "chrome" || browser === "brave" || browser === "edge") return INSTALLED_APPS[browser].find(existsSync);
  return playwrightBuild(engineFor(browser), browser);
}

function playwrightBuild(engine: BrowserType, family: Family): string | undefined {
  try {
    const path = engine.executablePath();
    if (path !== "" && existsSync(path)) return path;
  } catch {
    // Fall through to scanning caches from other Playwright versions.
  }
  return cacheRoots().map((root) => scanCacheRoot(root, family)).find((path) => path !== undefined);
}

function cacheRoots(): string[] {
  const home = homedir();
  return [join(home, "Library", "Caches", "ms-playwright"), join(home, ".cache", "ms-playwright"), "/opt/pw-browsers"];
}

function scanCacheRoot(root: string, family: Family): string | undefined {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).filter((name) => name.startsWith(`${family}-`)).sort().reverse();
  return dirs.flatMap((dir) => candidatePaths(join(root, dir), family)).find(existsSync);
}

function candidatePaths(base: string, family: Family): string[] {
  const mac = (dir: string, app: string, bin: string): string => join(base, dir, `${app}.app`, "Contents", "MacOS", bin);
  if (family === "chromium") {
    return [
      mac("chrome-mac-arm64", "Google Chrome for Testing", "Google Chrome for Testing"),
      mac("chrome-mac-x64", "Google Chrome for Testing", "Google Chrome for Testing"),
      mac("chrome-mac", "Chromium", "Chromium"),
      join(base, "chrome-linux64", "chrome"),
      join(base, "chrome-linux", "chrome"),
    ];
  }
  if (family === "firefox") return [mac("firefox", "Nightly", "firefox"), join(base, "firefox", "firefox")];
  return [join(base, "pw_run.sh")];
}

export type BrowserAvailability = Record<ManagedBrowser, { available: boolean; executablePath?: string }>;

export function detectInstalledBrowsers(chromiumOverride?: string): BrowserAvailability {
  const entries = MANAGED_BROWSERS.map((name) => {
    const path = resolveExecutable(name, chromiumOverride);
    return [name, path === undefined ? { available: false } : { available: true, executablePath: path }] as const;
  });
  return Object.fromEntries(entries) as BrowserAvailability;
}
