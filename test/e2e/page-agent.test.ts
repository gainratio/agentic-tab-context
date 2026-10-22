/**
 * The single in-page agent (extension/page-agent.js), exercised in real
 * Chromium exactly the way the macOS driver evaluates it.
 */
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
});
