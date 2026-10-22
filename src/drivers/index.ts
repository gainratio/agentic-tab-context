/**
 * Driver factory: the only entry point the daemon uses to obtain a BrowserDriver
 * for a managed (`atc open`) window.
 */
import { AtcError } from "../contracts/errors.js";
import type { BrowserDriver, BrowserName } from "../contracts/types.js";
import { MANAGED_BROWSERS, type ManagedBrowser } from "./playwright/executables.js";
import { PlaywrightDriver } from "./playwright/driver.js";

export interface DriverOptions {
  /** Directory holding one user-data dir per profile name. */
  profilesDir: string;
  /** Overrides the `chromium` executable (ATC_CHROMIUM_PATH). */
  executablePath?: string;
  /** The shared driver for tabs reached through the browser extension. */
  extensionDriver?: BrowserDriver;
}

const SAFARI_GUIDANCE =
  "Safari cannot be automated with your own profile. Use `atc bind --browser safari` to work in a Safari tab " +
  "you already have open, or `atc open webkit` for a separate WebKit window.";

function isManaged(browser: BrowserName): browser is ManagedBrowser {
  return (MANAGED_BROWSERS as readonly string[]).includes(browser);
}

export function createDriver(browser: BrowserName, options: DriverOptions): BrowserDriver {
  if (isManaged(browser)) return new PlaywrightDriver(browser, options);
  if (browser === "extension" && options.extensionDriver !== undefined) return options.extensionDriver;
  const message = browser === "safari" ? SAFARI_GUIDANCE : `cannot open a ${String(browser)} window`;
  throw new AtcError("UNSUPPORTED_BROWSER", message, { browser: String(browser) });
}
