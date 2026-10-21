/**
 * Browser executable discovery across Playwright caches and OS install paths.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type BrowserType } from "playwright-core";
import type { BrowserName } from "../../contracts/types.js";

export type PlaywrightBrowserName = "chromium" | "chrome" | "brave" | "edge" | "firefox" | "safari" | "webkit";

const SYSTEM_PATHS: Readonly<Record<PlaywrightBrowserName, readonly string[]>> = {
  chrome: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ],
  chromium: [
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  brave: [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/brave-browser",
  ],
  edge: [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/microsoft-edge",
  ],
  firefox: [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
  ],
  safari: [],
  webkit: [],
};

export function engineFor(browser: PlaywrightBrowserName): BrowserType {
  if (browser === "firefox") return firefox;
  if (browser === "safari" || browser === "webkit") return webkit;
  return chromium;
}

export function resolveExecutable(browser: PlaywrightBrowserName, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  const engine = engineFor(browser);
  if (browser === "chromium" || browser === "firefox" || browser === "safari" || browser === "webkit") {
    const pwDefault = safeDefaultExecutable(engine);
    if (pwDefault !== undefined) return pwDefault;
    const cached = findCachedPlaywrightBinary(browser === "safari" ? "webkit" : browser);
    if (cached !== undefined) return cached;
  }
  const sys = SYSTEM_PATHS[browser].find((candidate) => existsSync(candidate));
  if (sys !== undefined) return sys;
  return safeDefaultExecutable(engine);
}

function safeDefaultExecutable(engine: BrowserType): string | undefined {
  try {
    const p = engine.executablePath();
    return p !== "" && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function cacheRoots(): string[] {
  const home = homedir();
  return [
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, ".cache", "ms-playwright"),
    "/opt/pw-browsers",
  ];
}

function findCachedPlaywrightBinary(family: "chromium" | "firefox" | "webkit"): string | undefined {
  for (const root of cacheRoots()) {
    const match = scanCacheRoot(root, family);
    if (match !== undefined) return match;
  }
  return undefined;
}

function scanCacheRoot(root: string, family: "chromium" | "firefox" | "webkit"): string | undefined {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((name) => name.startsWith(`${family}-`))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const candidate = candidatePaths(join(root, dir), family).find((p) => existsSync(p));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function candidatePaths(base: string, family: "chromium" | "firefox" | "webkit"): string[] {
  if (family === "chromium") {
    return [
      join(base, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      join(base, "chrome-linux", "chrome"),
    ];
  }
  if (family === "firefox") {
    return [
      join(base, "firefox", "Nightly.app", "Contents", "MacOS", "firefox"),
      join(base, "firefox", "firefox"),
    ];
  }
  return [join(base, "pw_run.sh")];
}

export function detectInstalledBrowsers(explicit?: string): Record<BrowserName, { available: boolean; executablePath?: string }> {
  const names: PlaywrightBrowserName[] = ["chromium", "chrome", "brave", "edge", "firefox", "safari", "webkit"];
  const report = {} as Record<BrowserName, { available: boolean; executablePath?: string }>;
  for (const name of names) {
    const exe = resolveExecutable(name, explicit);
    report[name] = exe === undefined ? { available: false } : { available: true, executablePath: exe };
  }
  report.extension = { available: true };
  return report;
}
