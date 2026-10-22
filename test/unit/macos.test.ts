/**
 * macOS live tabs: identity is re-verified before every action, so a closed,
 * moved or reused tab fails closed instead of silently acting on another page.
 */
import { describe, expect, it } from "vitest";
import { AtcError } from "../../src/contracts/errors.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import { doctorReport } from "../../src/daemon/doctor.js";
import { createDriver } from "../../src/drivers/index.js";
import { MacosTabDriver } from "../../src/drivers/macos/driver.js";
import { LIST_SCRIPT, osascriptFailure, toJxaError } from "../../src/drivers/macos/jxa.js";

const CHROME_TAB = { tabId: "macos:chrome:1234", browser: "chrome", source: "macos", url: "http://localhost:5182/screen", title: "AML", active: true } as const;
const SAFARI_TAB = { tabId: "macos:safari:1:2", browser: "safari", source: "macos", url: "https://example.com/a", title: "A", active: false } as const;

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

  it("refuses to open Safari when it is the only available tab", async () => {
    const scripts: string[] = [];
    const driver = new MacosTabDriver(async (script) => {
      scripts.push(script);
      return JSON.stringify([{ ...SAFARI_TAB, active: true }]);
    });
    await expect(driver.open({ profile: "live", headless: false })).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    expect(scripts).toEqual([LIST_SCRIPT]);
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

  it("keeps Safari discovery-only instead of trusting a position or matching URL", async () => {
    const jxa = fakeJxa([]);
    const driver = new MacosTabDriver(jxa.run);
    expect((await driver.listTabs()).find((tab) => tab.browser === "safari")).toEqual(SAFARI_TAB);
    await expect(driver.bindTab(SAFARI_TAB.tabId, SAFARI_TAB.url)).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    expect(jxa.scripts).toEqual([LIST_SCRIPT]);
  });

  it("stops page capture before detaching a stable macOS binding", async () => {
    const jxa = fakeJxa(["{}", "{}"]);
    const driver = new MacosTabDriver(jxa.run);
    const session = await driver.bindTab(CHROME_TAB.tabId);
    await driver.close(session);
    expect(jxa.scripts.at(-1)).toContain(String.raw`\"op\":\"unwatch\"`);
    const count = jxa.scripts.length;
    await driver.close(session);
    expect(jxa.scripts).toHaveLength(count);
    await expect(driver.inspect(session)).rejects.toMatchObject({ code: "CONTEXT_CLOSED" });
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

describe("Safari capability guidance", () => {
  it("refuses managed Safari with discovery-only guidance", () => {
    expect(() => createDriver("safari", { profilesDir: "/unused" })).toThrowError(/Safari.*discovery only/);
    expect(() => createDriver("safari", { profilesDir: "/unused" })).not.toThrowError(/atc bind --browser safari/);
  });

  it("doctor distinguishes stable Chromium page access from Safari discovery", () => {
    const report = doctorReport({
      paths: resolvePaths({ ATC_HOME: "/tmp/atc-doctor-guidance-unit" }), env: {},
      tabs: [SAFARI_TAB], openContexts: 0, current: null, platform: "darwin",
    });
    expect(report.nextSteps).toContainEqual(expect.stringMatching(/Safari.*discovery only/));
    expect(report.nextSteps).not.toContainEqual(expect.stringContaining("macOS tabs can be listed and bound"));
  });
});
