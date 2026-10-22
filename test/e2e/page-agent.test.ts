/**
 * The single in-page agent (extension/page-agent.js), exercised in real
 * Chromium exactly the way the macOS driver evaluates it.
 */
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PageOp, actOp, pageExpression } from "../../src/drivers/page-agent.js";
import { resolveExecutable } from "../../src/drivers/playwright/executables.js";
import { type FixtureServer, startFixtureServer } from "../helpers/fixture-server.js";

let browser: Browser;
let page: Page;
let fixtures: FixtureServer;

async function run(op: PageOp): Promise<Record<string, unknown> & unknown[]> {
  return JSON.parse(await page.evaluate(pageExpression(op))) as Record<string, unknown> & unknown[];
}

beforeAll(async () => {
  fixtures = await startFixtureServer();
  const executablePath = resolveExecutable("chromium", process.env.ATC_CHROMIUM_PATH);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});

afterAll(async () => {
  await browser.close();
  await fixtures.close();
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.goto(`${fixtures.baseUrl}/app.html`);
});

afterEach(async () => { await page.close(); });

describe("page agent", () => {
  it("describes visible headings, links, form controls and buttons, and skips hidden ones", async () => {
    const { aria, title } = await run({ op: "inspect" });
    expect(title).toBe("Fixture App");
    expect(aria).toContain('- heading "Fixture App"');
    expect(aria).toContain('- link "Pricing"');
    expect(aria).toContain('- textbox "Product Name"');
    expect(aria).toContain('  - option "Dev" [selected]');
    expect(aria).not.toContain("Hidden Only");
  });

  it("types, selects and clicks by exact accessible names", async () => {
    expect(await run(actOp("type", { kind: "label", label: "Product Name" }, "Blue Shirt"))).toEqual({ ok: true, matched: 1 });
    expect(await run(actOp("select", { kind: "label", label: "Environment" }, "Stage"))).toEqual({ ok: true, matched: 1 });
    expect(await run(actOp("click", { kind: "role", role: "button", name: "Save" }))).toEqual({ ok: true, matched: 1 });
    expect((await run({ op: "inspect" })).aria).toContain("Saved: Blue Shirt");
  });

  it("finds and operates labelled controls in open shadow roots", async () => {
    await page.evaluate(() => {
      const host = document.createElement("div");
      document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML = '<label for="shadow-field">Shadow Field</label><input id="shadow-field"><button id="shadow-action">Shadow Action</button>';
      host.shadowRoot!.querySelector("button")!.addEventListener("click", () => host.setAttribute("data-clicked", "true"));
    });
    expect((await run({ op: "inspect" })).aria).toContain('textbox "Shadow Field"');
    expect(await run(actOp("type", { kind: "label", label: "Shadow Field" }, "shadow value"))).toMatchObject({ ok: true });
    expect(await page.getByLabel("Shadow Field").inputValue()).toBe("shadow value");
    expect(await run(actOp("click", { kind: "selector", selector: "#shadow-action" }))).toMatchObject({ ok: true });
    expect(await run(actOp("click", { kind: "role", role: "button", name: "Shadow Action" }))).toMatchObject({ ok: true });
    expect(await page.locator("[data-clicked=true]").count()).toBe(1);
  });

  it("never guesses between matches and reports what it found", async () => {
    const del = { kind: "role", role: "button", name: "Delete" } as const;
    expect(await run(actOp("click", del))).toMatchObject({ ok: false, error: "AMBIGUOUS_TARGET", matched: 2 });
    expect(await run(actOp("click", { ...del, nth: 1 }))).toEqual({ ok: true, matched: 1 });
    expect(await run(actOp("click", { ...del, nth: 5 }))).toMatchObject({ ok: false, error: "TARGET_NOT_FOUND", matched: 2 });
    expect(await run(actOp("click", { kind: "text", text: "Hidden Only" }))).toMatchObject({ error: "TARGET_NOT_FOUND" });
    expect(await run(actOp("select", { kind: "label", label: "Environment" }, "Nope"))).toMatchObject({ error: "TARGET_NOT_FOUND" });
  });

  it("captures console messages and failed fetches after it starts watching", async () => {
    await run({ op: "watch" });
    await run(actOp("click", { kind: "role", role: "button", name: "Break" }));
    await page.waitForTimeout(300);
    const consoleEntries = await run({ op: "logs", kind: "console", since: 0 });
    expect(consoleEntries.some((e) => (e as { text: string }).text === "boom")).toBe(true);
    const network = await run({ op: "logs", kind: "network", since: 0 });
    expect(network.find((e) => String((e as { url: string }).url).endsWith("/missing.json"))).toMatchObject({ status: 404 });
  });

  it("is safe to inject repeatedly without losing captured logs", async () => {
    await run({ op: "watch" });
    await page.evaluate(() => console.log("first"));
    await run({ op: "watch" });
    const entries = await run({ op: "logs", kind: "console", since: 0 });
    expect(entries.filter((e) => (e as { text: string }).text === "first")).toHaveLength(1);
  });

  it("redacts prefilled and edited password fields, including revealed password autocomplete controls", async () => {
    await page.setContent('<label>Password<input type="password" value="PREFILLED_PASSWORD"></label><label>Revealed<input type="text" autocomplete="current-password" value="REVEALED_PASSWORD"></label>');
    expect((await run({ op: "inspect" })).aria).not.toMatch(/PREFILLED_PASSWORD|REVEALED_PASSWORD/);
    await page.getByLabel("Password", { exact: true }).fill("EDITED_PASSWORD");
    expect((await run({ op: "inspect" })).aria).not.toContain("EDITED_PASSWORD");
    expect((await run({ op: "inspect" })).aria).toContain('[redacted]');
  });

  it("restores capture hooks and clears retained content when unbound", async () => {
    await page.evaluate('globalThis.__atcOriginalHooks = { log: console.log, fetch };');
    await run({ op: "watch" });
    await page.evaluate('console.log("while-bound"); fetch("/bound-request");');
    await run({ op: "unwatch" });
    await page.evaluate('console.log("while-unbound");');
    const state = await page.evaluate('({ watching: __atcAgent.store.watching, consoleCount: __atcAgent.store.console.length, networkCount: __atcAgent.store.network.length, logRestored: console.log === __atcOriginalHooks.log, fetchRestored: fetch === __atcOriginalHooks.fetch })');
    expect(state).toEqual({ watching: false, consoleCount: 0, networkCount: 0, logRestored: true, fetchRestored: true });
    expect(await run({ op: "logs", kind: "console", since: 0 })).toEqual([]);
    await run({ op: "watch" });
    await page.evaluate('console.log("after-rebind");');
    const entries = await run({ op: "logs", kind: "console", since: 0 });
    expect(entries.map((entry) => (entry as { text: string }).text)).toEqual(["after-rebind"]);
  });

  it("blocks a legacy active capture agent until reload and clears its buffers", async () => {
    await page.evaluate('globalThis.__atcAgent = { version: 1, store: { watching: true, console: ["old"], network: ["old"] }, record() {}, run() {} };');
    await expect(run({ op: "watch" })).rejects.toThrow(/ATC_RELOAD_REQUIRED/);
    expect(await page.evaluate('({ console: __atcAgent.store.console, network: __atcAgent.store.network, watching: __atcAgent.store.watching })')).toEqual({ console: [], network: [], watching: false });
    await expect(run({ op: "watch" })).rejects.toThrow(/ATC_RELOAD_REQUIRED/);
    await page.reload();
    expect(await run({ op: "watch" })).toEqual({ ok: true });
  });

});
