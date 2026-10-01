/**
 * Driver factory: the only entry point the daemon uses to obtain a BrowserDriver.
 */
import { TabCtxError } from "../contracts/errors.js";
import type { BrowserDriver, BrowserName } from "../contracts/types.js";
import { ChromiumDriver } from "./chromium/driver.js";

export interface DriverOptions {
  /** Directory holding one user-data dir per profile name. */
  profilesDir: string;
  /** Overrides the browser executable (e.g. from TABCTX_CHROMIUM_PATH). */
  executablePath?: string;
}

export function createDriver(browser: BrowserName, options: DriverOptions): BrowserDriver {
  switch (browser) {
    case "chromium":
    case "chrome":
      return new ChromiumDriver(browser, options);
    case "safari":
      throw new TabCtxError(
        "UNSUPPORTED_BROWSER",
        "Safari support is planned but not available yet: Safari's WebDriver runs in an isolated " +
          "automation window that locks out manual input, which conflicts with the human logging in " +
          "manually. Use chromium or chrome for now.",
        { browser },
      );
    case "firefox":
      throw new TabCtxError(
        "UNSUPPORTED_BROWSER",
        "Firefox support is planned but not available yet. Use chromium or chrome for now.",
        { browser },
      );
    default:
      throw new TabCtxError("UNSUPPORTED_BROWSER", `Unknown browser: ${String(browser)}`, {
        browser: String(browser),
      });
  }
}
