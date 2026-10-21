/**
 * Driver factory: the only entry point the daemon uses to obtain a BrowserDriver.
 */
import { TabCtxError } from "../contracts/errors.js";
import type { BrowserDriver, BrowserName } from "../contracts/types.js";
import { ExtensionBridge } from "./extension/bridge.js";
import { ExtensionDriver } from "./extension/driver.js";
import { PlaywrightDriver } from "./playwright/driver.js";

export interface DriverOptions {
  /** Directory holding one user-data dir per profile name. */
  profilesDir: string;
  /** Overrides the browser executable (e.g. from TABCTX_CHROMIUM_PATH). */
  executablePath?: string;
  /** Shared extension bridge for live browser tab attachment. */
  extensionBridge?: ExtensionBridge;
}

export function createDriver(browser: BrowserName, options: DriverOptions): BrowserDriver {
  switch (browser) {
    case "chromium":
    case "chrome":
    case "brave":
    case "edge":
    case "firefox":
    case "safari":
    case "webkit":
      return new PlaywrightDriver(browser, options);
    case "extension":
      return new ExtensionDriver(options.extensionBridge ?? new ExtensionBridge());
    default:
      throw new TabCtxError("UNSUPPORTED_BROWSER", `Unknown browser: ${String(browser)}`, {
        browser: String(browser),
      });
  }
}
