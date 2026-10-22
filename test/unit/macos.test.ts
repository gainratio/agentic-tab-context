/**
 * macOS live tabs: identity is re-verified before every action, so a closed,
 * moved or reused tab fails closed instead of silently acting on another page.
 */
import { describe, expect, it } from "vitest";
import { AtcError } from "../../src/contracts/errors.js";
import { MacosTabDriver } from "../../src/drivers/macos/driver.js";
import { LIST_SCRIPT, osascriptFailure, toJxaError } from "../../src/drivers/macos/jxa.js";

const CHROME_TAB = { tabId: "macos:chrome:1234", browser: "chrome", source: "macos", url: "http://localhost:5182/screen", title: "AML", active: true };
const SAFARI_TAB = { tabId: "macos:safari:1:2", browser: "safari", source: "macos", url: "https://example.com/a", title: "A", active: false };

/** Records every script and answers from a queue (or throws, like osascript). */
function fakeJxa(answers: Array<string | Error>): { run: (script: string) => Promise<string>; scripts: string[] } {
  const scripts: string[] = [];
  const run = (script: string): Promise<string> => {
    scripts.push(script);
    if (script === LIST_SCRIPT) return Promise.resolve(JSON.stringify([CHROME_TAB, SAFARI_TAB]));
    const next = answers.shift() ?? "{}";
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { run, scripts };
}

describe("MacosTabDriver", () => {
  it("lists tabs and finds Chromium-family tabs by their stable id, wherever they moved", async () => {
    const jxa = fakeJxa(["{}", JSON.stringify({ url: "http://localhost:5182/screen", title: "AML", aria: "- heading \"AML\"" })]);
    const driver = new MacosTabDriver(jxa.run);
    expect(await driver.listTabs()).toHaveLength(2);
    const session = await driver.bindTab(CHROME_TAB.tabId);
    const state = await driver.inspect(session);
    expect(state.aria).toBe('- heading "AML"');
    const inspectScript = jxa.scripts.at(-1) ?? "";
    expect(inspectScript).toContain('String(t.id()) === "1234"');
    expect(inspectScript).toContain("globalThis.__atcAgent");
    expect(inspectScript).not.toMatch(/windows\[\d+\]\.tabs\[\d+\]/);
  });

  it("closes the context when the bound tab is gone", async () => {
    const jxa = fakeJxa(["{}", new Error("execution error: Error: ATC_TAB_GONE (-2700)")]);
    const driver = new MacosTabDriver(jxa.run);
    const session = await driver.bindTab(CHROME_TAB.tabId);
    let closed = 0;
    driver.onDisconnect(session, () => (closed += 1));
    await expect(driver.location(session)).rejects.toMatchObject({ code: "CONTEXT_CLOSED" });
    expect(closed).toBe(1);
    await expect(driver.location(session)).rejects.toMatchObject({ code: "CONTEXT_CLOSED" });
  });

  it("fails closed with TAB_MOVED when a Safari tab no longer shows the bound page", async () => {
    const jxa = fakeJxa([JSON.stringify({ window: 1, tab: 2, url: SAFARI_TAB.url }), "{}", new Error("Error: ATC_TAB_MOVED")]);
    const driver = new MacosTabDriver(jxa.run);
    const session = await driver.bindTab(SAFARI_TAB.tabId, SAFARI_TAB.url);
    await expect(driver.location(session)).rejects.toMatchObject({ code: "TAB_MOVED" });
    const locate = jxa.scripts.find((s) => s.includes('const want = "https://example.com/a"')) ?? "";
    expect(locate).toContain("hits.length !== 1");
  });

  it("explains how to enable page access when the browser blocks Apple Events JavaScript", async () => {
    const blocked = new Error("Executing JavaScript through AppleScript is turned off. Allow JavaScript from Apple Events.");
    const jxa = fakeJxa(["{}", blocked]);
    const driver = new MacosTabDriver(jxa.run);
    const session = await driver.bindTab(CHROME_TAB.tabId);
    const failure = await driver.inspect(session).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AtcError);
    expect(failure).toMatchObject({ code: "ACTION_FAILED" });
    expect((failure as AtcError).message).toMatch(/atc browser extension|Allow JavaScript from Apple Events/);
  });

  it("never captures the whole screen for a tab screenshot", async () => {
    const driver = new MacosTabDriver(fakeJxa(["{}"]).run);
    const session = await driver.bindTab(CHROME_TAB.tabId);
    await expect(driver.screenshot(session, "/tmp/x.png", false)).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
  });

  it("rejects ids that are not macOS tab ids", async () => {
    const driver = new MacosTabDriver(fakeJxa([]).run);
    await expect(driver.bindTab("macos:netscape:1")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(driver.bindTab("macos:safari:not-a-position")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("osascriptFailure", () => {
  // Regression: Node's execFile error message echoes the script, which contains
  // the literal "ATC_TAB_GONE" marker, so every failure looked like a closed tab.
  it("uses only what osascript printed, never the echoed command line", () => {
    const execError = Object.assign(new Error('Command failed: osascript -l JavaScript -e throw new Error("ATC_TAB_GONE")'), {
      stderr: "execution error: Error: Executing JavaScript through AppleScript is turned off. (12)\n",
      code: 1,
    });
    const failure = osascriptFailure(execError);
    expect(failure.message).not.toContain("ATC_TAB_GONE");
    expect(toJxaError(failure, "Google Chrome").code).toBe("ACTION_FAILED");
  });

  it("does not echo the script even when osascript printed nothing", () => {
    const failure = osascriptFailure(Object.assign(new Error("Command failed: osascript ... ATC_TAB_GONE"), { stderr: "", code: 1 }));
    expect(failure.message).toBe("osascript failed (exit 1)");
  });
});
