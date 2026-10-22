import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { resolveExecutable } from "../../src/drivers/playwright/executables.js";
import { ROOT } from "../helpers/cli.js";

let browser: Browser;
const pages: Page[] = [];
beforeAll(async () => {
  const executablePath = resolveExecutable("chromium", process.env.ATC_CHROMIUM_PATH);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
afterEach(async () => Promise.all(pages.splice(0).map((page) => page.close())));
afterAll(async () => browser?.close());

async function popup(rejectPin = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 320, height: 340 } });
  pages.push(page);
  await page.addInitScript(({ rejectPin }) => {
    Object.defineProperty(globalThis, "chrome", { value: {
      tabs: { query: async () => [{ id: 7, title: "Fixture tab", url: "https://example.test/" }] },
      runtime: { sendMessage: async (message: { type: string }) => {
        if (message.type === "atc:status") return { atcDaemon: true };
        if (rejectPin) throw new Error("Disconnected");
        return { ok: true, context: "ctx_fixture" };
      } },
    } });
  }, { rejectPin });
  await page.goto(pathToFileURL(join(ROOT, "extension/popup/popup.html")).href);
  await page.waitForFunction(() => !(document.getElementById("bind-btn") as HTMLButtonElement).disabled);
  return page;
}

it("explains toolbar usage when opened as a file without extension APIs", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  pages.push(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(pathToFileURL(join(ROOT, "extension/popup/popup.html")).href);
  expect(await page.getByRole("heading", { name: "Open this from your browser toolbar" }).isVisible()).toBe(true);
  expect(await page.locator("#status-text").innerText()).toBe("Opened outside the browser extension");
  expect(await page.locator("#standalone-help").innerText()).toContain("chrome://extensions");
  expect(await page.locator("#standalone-help").innerText()).toContain("return to your assistant");
  expect(await page.locator("#bind-btn").isVisible()).toBe(false);
  expect(await page.locator(".tab-box").isVisible()).toBe(false);
  expect(errors).toEqual([]);
  const card = await page.locator(".card").boundingBox();
  expect(card!.width).toBeGreaterThan(400);
  expect(Math.abs(card!.x + card!.width / 2 - 550)).toBeLessThan(2);
});

it("announces status and binding feedback, and works from the keyboard", async () => {
  const page = await popup();
  expect(await page.locator("#status-text").getAttribute("role")).toBe("status");
  expect(await page.locator("#feedback").getAttribute("aria-live")).toBe("polite");
  await page.keyboard.press("Tab");
  expect(await page.locator("#bind-btn").evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("feedback")!.hidden);
  expect(await page.locator("#feedback").innerText()).toContain("Bound.");
});

function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

it("keeps readable hover text and a visible keyboard focus indicator", async () => {
  const page = await popup();
  const button = page.locator("#bind-btn");
  await button.hover();
  const colors = await button.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  const values = [luminance(colors.color), luminance(colors.background)].sort((a, b) => a - b);
  expect((values[1]! + 0.05) / (values[0]! + 0.05)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press("Tab");
  const outline = await button.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});

it("reports a lost connection and restores the bind control", async () => {
  const page = await popup(true);
  await page.getByRole("button", { name: "Let my assistant use this tab" }).click();
  await page.waitForFunction(() => !document.getElementById("feedback")!.hidden, undefined, { timeout: 2_000 });
  expect(await page.locator("#feedback").innerText()).toContain("Could not bind");
  expect(await page.locator("#bind-btn").isEnabled()).toBe(true);
});
