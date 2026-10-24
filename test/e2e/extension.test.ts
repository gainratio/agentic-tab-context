/**
 * The headline flow, for real: Chromium with the atc extension loaded, native
 * messaging to the daemon, and separate `atc` processes binding to and driving
 * a tab that was already open. No browser is opened by atc.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it("does not disclose existing or edited password values through CLI inspect", async () => {
    await page.evaluate(() => {
      const label = document.createElement("label");
      label.id = "password-fixture";
      label.textContent = "Password";
      const input = document.createElement("input");
      input.type = "password";
      input.value = "EXTENSION_PREFILLED_PASSWORD";
      label.append(input);
      document.body.append(label);
    });
    expect(String((await atc("inspect")).json.aria)).not.toContain("EXTENSION_PREFILLED_PASSWORD");
    await page.getByLabel("Password", { exact: true }).fill("EXTENSION_EDITED_PASSWORD");
    expect(String((await atc("inspect")).json.aria)).not.toContain("EXTENSION_EDITED_PASSWORD");
    await page.getByLabel("Password", { exact: true }).evaluate((element) => { (element as HTMLInputElement).type = "text"; });
    expect(String((await atc("inspect")).json.aria)).not.toContain("EXTENSION_EDITED_PASSWORD");
    await page.locator("#password-fixture").evaluate((element) => element.remove());
  });

  it("rejects unsupported full-page capture explicitly", async () => {
    expect((await atc("screenshot", "--full-page")).json).toMatchObject({ ok: false, error: "UNSUPPORTED_ACTION" });
  });

  it("keeps an exact extension binding separate from a managed tab at the same URL", async () => {
    const opened = await atc("open", "chromium", "--headless", "--profile", "identity-regression");
    const managed = String(opened.json.context);
    try {
      expect(opened.json).toMatchObject({ ok: true, browser: "chromium" });
      expect((await atc("goto", page.url(), "--context", managed)).json).toMatchObject({ ok: true });
      expect((await atc("type", "--context", managed, "--label", "Product Name", "--value", "MANAGED_IDENTITY_SENTINEL")).json).toMatchObject({ ok: true });
      const tabs = tabsOf(await fixtureTabs());
      const extensionTab = tabs.find((tab) => tab.source === "extension");
      expect(extensionTab).toBeDefined();
      expect((await atc("bind", "--tab", String(extensionTab?.tabId))).json).toMatchObject({ ok: true, context: ctx, source: "extension", reused: true });
      expect((await atc("type", "--label", "Product Name", "--value", "EXTENSION_IDENTITY_SENTINEL")).json).toMatchObject({ ok: true });
      expect(await page.getByLabel("Product Name", { exact: true }).inputValue()).toBe("EXTENSION_IDENTITY_SENTINEL");
      expect(String((await atc("inspect")).json.aria)).toContain("EXTENSION_IDENTITY_SENTINEL");
      const managedAria = String((await atc("inspect", "--context", managed)).json.aria);
      expect(managedAria).toContain("MANAGED_IDENTITY_SENTINEL");
      expect(managedAria).not.toContain("EXTENSION_IDENTITY_SENTINEL");
    } finally {
      await atc("close", "--context", managed);
      await atc("use", ctx);
    }
  });

  it("removes a rejected legacy binding from capture membership before reload", async () => {
    const legacy = await context.newPage();
    try {
      await legacy.goto(`${fixtures.baseUrl}/app.html?legacy-upgrade`);
      await legacy.evaluate('globalThis.__atcAgent = { version: 1, store: { watching: true, console: [], network: [] }, record() {} };');
      const listed = await eventually(fixtureTabs, (r) => tabsOf(r).some((tab) => String(tab.url).includes("legacy-upgrade")));
      const legacyId = String(tabsOf(listed).find((tab) => String(tab.url).includes("legacy-upgrade"))?.tabId);
      const bound = await atc("bind", "--tab", legacyId);
      expect(bound.json).toMatchObject({ ok: false });
      expect(String(bound.json.message)).toContain("ATC_RELOAD_REQUIRED");
      const worker = context.serviceWorkers()[0]!;
      const watched = await worker.evaluate('chrome.storage.session.get("atcWatched").then((value) => value.atcWatched || [])');
      expect(watched).not.toContain(Number(legacyId.split(":").at(-1)));
      await legacy.reload();
      expect(await legacy.evaluate('typeof globalThis.__atcAgent')).toBe("undefined");
    } finally {
      await legacy.close();
      await atc("use", ctx);
    }
  });

  it("reports console messages and failed requests", async () => {
    await atc("click", "--role", "button", "--name", "Break");
    const logs = await eventually(() => atc("console"), (r) => JSON.stringify(r.json.entries).includes("boom"));
    expect(JSON.stringify(logs.json.entries)).toContain("boom");
    const network = await atc("network");
    expect((network.json.entries as Json[]).find((e) => String(e.url).endsWith("/missing.json"))).toMatchObject({ status: 404 });
  });

  it("stops capture on close and starts a fresh capture after rebinding", async () => {
    expect((await atc("close", "--context", ctx)).json).toMatchObject({ ok: true });
    await page.evaluate('console.log("while-unbound");');
    expect(await page.evaluate('({ watching: __atcAgent.store.watching, console: __atcAgent.store.console.length, network: __atcAgent.store.network.length })')).toEqual({ watching: false, console: 0, network: 0 });
    const bound = await atc("bind", "Fixture App", "--browser", "chromium");
    expect(bound.json).toMatchObject({ ok: true, reused: false });
    ctx = String(bound.json.context);
    await page.evaluate('console.log("after-rebind");');
    const text = JSON.stringify((await atc("console")).json.entries);
    expect(text).toContain("after-rebind");
    expect(text).not.toMatch(/while-unbound|boom/);
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

  it("keeps concurrent screenshots attached to their own bound tabs", async () => {
    const first = await context.newPage();
    const second = await context.newPage();
    const colors = [[18, 52, 86], [86, 52, 18]];
    const ids: string[] = [];
    try {
      for (const [index, tab] of [first, second].entries()) {
        await tab.goto(`${fixtures.baseUrl}/app.html?capture=${index}`);
        await tab.evaluate(({ index, color }) => {
          document.title = `Capture ${index}`;
          document.body.innerHTML = "";
          document.body.style.background = `rgb(${color.join(",")})`;
          document.documentElement.style.background = `rgb(${color.join(",")})`;
        }, { index, color: colors[index]! });
      }
      const listed = await eventually(() => atc("tabs", "--query", "Capture", "--browser", "chromium"), (r) => tabsOf(r).length === 2);
      for (const index of [0, 1]) ids.push(String((await atc("bind", "--tab", String(tabsOf(listed).find((t) => t.title === `Capture ${index}`)?.tabId))).json.context));
      const shots = await Promise.all(ids.map((id) => atc("screenshot", "--context", id)));
      expect(shots.map((shot) => shot.json.ok), JSON.stringify(shots)).toEqual([true, true]);
      for (const [index, shot] of shots.entries()) {
        const data = `data:image/png;base64,${readFileSync(String(shot.json.path)).toString("base64")}`;
        const pixel = await page.evaluate(async (url) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width; canvas.height = image.height;
          const drawing = canvas.getContext("2d")!;
          drawing.drawImage(image, 0, 0);
          return [...drawing.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3);
        }, data);
        expect(pixel).toEqual(colors[index]);
      }
    } finally {
      for (const id of ids) await atc("close", "--context", id);
      await first.close(); await second.close();
      await atc("use", ctx);
    }
  });

  it("stops capture after daemon death and starts fresh after reconnecting", async () => {
    const report = await atc("doctor");
    const daemon = report.json.daemon as { pid: number; home: string };
    expect(daemon.home).toBe(home);
    expect(Number.isSafeInteger(daemon.pid) && daemon.pid > 0 && daemon.pid !== process.pid).toBe(true);
    process.kill(daemon.pid, "SIGKILL");
    const stopped = await eventually(() => page.evaluate<{ watching: boolean; console: number; network: number }>('({ watching: __atcAgent.store.watching, console: __atcAgent.store.console.length, network: __atcAgent.store.network.length })'), (state) => !state.watching);
    expect(stopped).toEqual({ watching: false, console: 0, network: 0 });
    const worker = context.serviceWorkers()[0]!;
    expect(await worker.evaluate('chrome.storage.session.get("atcWatched").then((value) => value.atcWatched || [])')).toEqual([]);
    await page.reload();
    expect(await page.evaluate('typeof globalThis.__atcAgent')).toBe("undefined");
    const listed = await eventually(fixtureTabs, (r) => tabsOf(r).some((tab) => tab.source === "extension"));
    const tab = tabsOf(listed).find((entry) => entry.source === "extension");
    const rebound = await atc("bind", "--tab", String(tab?.tabId));
    expect(rebound.json).toMatchObject({ ok: true, source: "extension", reused: false });
    ctx = String(rebound.json.context);
    await page.evaluate('console.log("after-daemon-reconnect")');
    expect(JSON.stringify((await atc("console")).json.entries)).toContain("after-daemon-reconnect");
  });

  it("closes the context when the user closes the tab", async () => {
    await page.close();
    const current = await eventually(() => atc("current"), (r) => r.json.ok === false);
    expect(current.json).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    expect((await atc("inspect", "--context", ctx)).json).toMatchObject({ ok: false, error: "CONTEXT_CLOSED" });
  });
});
