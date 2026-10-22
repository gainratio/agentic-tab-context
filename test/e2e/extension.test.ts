/**
 * The headline flow, for real: Chromium with the atc extension loaded, native
 * messaging to the daemon, and separate `atc` processes binding to and driving
 * a tab that was already open. No browser is opened by atc.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NATIVE_HOST_NAME } from "../../src/contracts/extension.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import { resolveExecutable } from "../../src/drivers/playwright/executables.js";
import { EXTENSION_DIR, extensionIdFromKey, extensionManifest, hostManifest, writeLauncher } from "../../src/native/install.js";
import { type CliResult, type Json, cli, eventually } from "../helpers/cli.js";
import { type FixtureServer, startFixtureServer } from "../helpers/fixture-server.js";

let home: string;
let userDataDir: string;
let fixtures: FixtureServer;
let context: BrowserContext;
let page: Page;
let atc: (...args: string[]) => Promise<CliResult>;

/** Register the native host inside this throwaway profile (Chrome reads <user-data-dir>/NativeMessagingHosts). */
function registerHost(): void {
  const paths = resolvePaths({ ATC_HOME: home });
  writeLauncher(paths);
  const { key, geckoId } = extensionManifest();
  const dir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${NATIVE_HOST_NAME}.json`), JSON.stringify(hostManifest(paths.nativeHost, false, [extensionIdFromKey(key)], geckoId)));
}

async function launchWithExtension(): Promise<BrowserContext> {
  const executablePath = resolveExecutable("chromium", process.env.ATC_CHROMIUM_PATH);
  return chromium.launchPersistentContext(userDataDir, {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
}

const fixtureTabs = (): Promise<CliResult> => atc("tabs", "--query", "Fixture App", "--browser", "chromium");
const tabsOf = (result: CliResult): Json[] => (result.json.tabs as Json[] | undefined) ?? [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "atc-x-"));
  userDataDir = mkdtempSync(join(tmpdir(), "atc-xp-"));
  atc = cli({ ATC_HOME: home });
  fixtures = await startFixtureServer();
  registerHost();
  await atc("tabs");
  context = await launchWithExtension();
  page = await context.newPage();
  await page.goto(`${fixtures.baseUrl}/app.html`);
});

afterAll(async () => {
  await atc("shutdown");
  await context?.close();
  await fixtures?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("browser extension end to end", () => {
  let ctx = "";

  it("loads with the pinned extension id that the native host allows", async () => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    expect(worker.url()).toContain(`chrome-extension://${extensionIdFromKey(extensionManifest().key)}/`);
  });

  it("sees the already-open tab through native messaging", async () => {
    const listed = await eventually(fixtureTabs, (r) => tabsOf(r).length === 1);
    expect(tabsOf(listed)[0]).toMatchObject({ source: "extension", browser: "chromium", title: "Fixture App" });
    expect(String(tabsOf(listed)[0]?.tabId)).toMatch(/^ext:chromium-[0-9a-f]{8}:\d+$/);
  });

  it("binds to it instead of opening a new tab", async () => {
    const pagesBefore = context.pages().length;
    const bound = await atc("bind", "Fixture App", "--browser", "chromium");
    expect(bound.json).toMatchObject({ ok: true, source: "extension", title: "Fixture App", current: true, reused: false });
    ctx = String(bound.json.context);
    expect(context.pages().length).toBe(pagesBefore);
    expect((await atc("bind", "Fixture App", "--browser", "chromium")).json).toMatchObject({ context: ctx, reused: true });
  });

  it("reads and operates the page across separate processes", async () => {
    expect((await atc("inspect")).json.aria).toContain('- heading "Fixture App"');
    expect((await atc("type", "--label", "Product Name", "--value", "Blue Shirt")).json).toMatchObject({ ok: true, matched: 1 });
    expect((await atc("select", "--label", "Environment", "--value", "Stage")).json).toMatchObject({ ok: true });
    expect((await atc("click", "--role", "button", "--name", "Save")).json).toMatchObject({ ok: true, matched: 1 });
    expect(await page.textContent("#status")).toBe("Saved: Blue Shirt");
    expect((await atc("click", "--role", "button", "--name", "Delete")).json).toMatchObject({ ok: false, error: "AMBIGUOUS_TARGET", matched: 2 });
  });

  it("reports console messages and failed requests", async () => {
    await atc("click", "--role", "button", "--name", "Break");
    const logs = await eventually(() => atc("console"), (r) => JSON.stringify(r.json.entries).includes("boom"));
    expect(JSON.stringify(logs.json.entries)).toContain("boom");
    const network = await atc("network");
    expect((network.json.entries as Json[]).find((e) => String(e.url).endsWith("/missing.json"))).toMatchObject({ status: 404 });
  });

  it("navigates, goes back, and takes a screenshot of the tab", async () => {
    expect((await atc("goto", "/pricing.html")).json).toMatchObject({ ok: true, title: "Pricing" });
    expect((await atc("back")).json).toMatchObject({ ok: true, title: "Fixture App" });
    const shot = await atc("screenshot");
    expect(shot.json).toMatchObject({ ok: true });
    expect(existsSync(String(shot.json.path)) && statSync(String(shot.json.path)).size > 0).toBe(true);
  });

  it("reports the extension as connected in doctor", async () => {
    const report = await atc("doctor");
    expect((report.json.extension as { connected: Json[] }).connected).toEqual([expect.objectContaining({ browser: "chromium" })]);
  });

  it("closes the context when the user closes the tab", async () => {
    await page.close();
    const current = await eventually(() => atc("current"), (r) => r.json.ok === false);
    expect(current.json).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    expect((await atc("inspect", "--context", ctx)).json).toMatchObject({ ok: false, error: "CONTEXT_CLOSED" });
  });
});
