import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { resolveExecutable } from "../../src/drivers/playwright/executables.js";
import { ROOT } from "../helpers/cli.js";

interface TestTab {
  id: number;
  index: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
}

interface TestBinding {
  context: string;
  tabId: string | null;
  browser: string;
  source: string | null;
  url: string | null;
  title: string | null;
  current: boolean;
}

interface SidepanelModel {
  tabs: TestTab[];
  bindings: TestBinding[];
  current: string | null;
  removed: number[];
  shareCalls: number[];
  messages: Array<{ type: string; tabId?: number; context?: string }>;
  listeners: Array<(message: unknown) => void>;
  removeGate: Promise<void> | null;
  releaseRemove: (() => void) | null;
}

const INITIAL_TABS: TestTab[] = [
  { id: 7, index: 0, windowId: 1, active: true, title: "Inbox (4) — me@example.com", url: "https://mail.google.com/mail/u/0/#inbox" },
  { id: 8, index: 1, windowId: 1, active: false, title: "Fix stale snapshot race · PR #482", url: "https://github.com/gainratio/agentic-tab-context/pull/482" },
  { id: 9, index: 2, windowId: 1, active: false, title: "Checkout Sessions | Stripe API", url: "https://docs.stripe.com/api/checkout/sessions" },
  { id: 10, index: 3, windowId: 1, active: false, title: "ATC side panel — explorations", url: "https://www.figma.com/file/atc-side-panel" },
  { id: 11, index: 4, windowId: 1, active: false, title: "Test results — MyChart", url: "https://mychart.org/mychart/test-results" },
  { id: 12, index: 5, windowId: 1, active: false, title: "Agentic Tab Context — Chrome Web Store", url: "https://chromewebstore.google.com/detail/agentic-tab-context" },
  { id: 13, index: 6, windowId: 1, active: false, title: "Extensions", url: "chrome://extensions" },
  { id: 14, index: 7, windowId: 1, active: false, title: "Private docs", url: "https://needsaccess.example/private" },
  { id: 15, index: 0, windowId: 2, active: false, title: "Other window tab", url: "https://other.example/work" },
];

const INITIAL_BINDINGS: TestBinding[] = [
  {
    context: "ctx_mail",
    tabId: "ext:chromium-0a1b2c3d:7",
    browser: "chromium",
    source: "extension",
    url: "https://mail.google.com/mail/u/0/#inbox",
    title: "Inbox (4) — me@example.com",
    current: true,
  },
  {
    context: "ctx_github",
    tabId: "ext:chromium-0a1b2c3d:8",
    browser: "chromium",
    source: "extension",
    url: "https://github.com/gainratio/agentic-tab-context/pull/482",
    title: "Fix stale snapshot race · PR #482",
    current: false,
  },
];

let browser: Browser;
const pages: Page[] = [];

beforeAll(async () => {
  const executablePath = resolveExecutable("chromium", process.env.ATC_CHROMIUM_PATH);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
afterEach(async () => Promise.all(pages.splice(0).map((page) => page.close())));
afterAll(async () => browser?.close());

async function sidepanel(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 360, height: 840 } });
  pages.push(page);
  await page.addInitScript(
    ({ tabs, bindings, current }: { tabs: TestTab[]; bindings: TestBinding[]; current: string | null }) => {
      const model: SidepanelModel = {
        tabs: tabs.map((tab) => ({ ...tab })),
        bindings: bindings.map((binding) => ({ ...binding })),
        current,
        removed: [],
        shareCalls: [],
        messages: [],
        listeners: [],
        removeGate: null,
        releaseRemove: null,
      };
      Object.defineProperty(globalThis, "__atcTest", { value: model, configurable: true });

      const chromeApi = {
        tabs: {
          query: async () => model.tabs.map((tab) => ({ ...tab })),
          remove: async (id: number) => {
            model.removed.push(id);
            if (model.removeGate !== null) await model.removeGate;
            model.tabs = model.tabs.filter((tab) => tab.id !== id);
          },
        },
        windows: { getCurrent: async () => ({ id: 1 }) },
        permissions: {
          contains: async ({ origins }: { origins: string[] }) =>
            !origins.some((origin) => origin.includes("needsaccess")),
        },
        runtime: {
          sendMessage: async (message: { type: string; tabId?: number; context?: string }) => {
            model.messages.push({ ...message });
            if (message.type === "atc:bindings") {
              return { ok: true, current: model.current, bindings: model.bindings.map((binding) => ({ ...binding })) };
            }
            if (message.type === "atc:share") {
              const tab = model.tabs.find((entry) => entry.id === message.tabId);
              if (tab === undefined) return { ok: false, message: "that tab is no longer open" };
              model.shareCalls.push(tab.id);
              const context = `ctx_${tab.id}`;
              if (!model.bindings.some((binding) => binding.context === context)) {
                model.bindings.push({
                  context,
                  tabId: `ext:chromium-0a1b2c3d:${tab.id}`,
                  browser: "chromium",
                  source: "extension",
                  url: tab.url,
                  title: tab.title,
                  current: false,
                });
              }
              return { ok: true, context };
            }
            if (message.type === "atc:unshare") {
              model.bindings = model.bindings.filter((binding) => binding.context !== message.context);
              if (model.current === message.context) model.current = null;
              return { ok: true, context: message.context };
            }
            if (message.type === "atc:activate") {
              model.current = message.context ?? null;
              return { ok: true, context: message.context };
            }
            return { ok: false, message: "unsupported request" };
          },
          onMessage: {
            addListener: (listener: (message: unknown) => void) => {
              model.listeners.push(listener);
            },
          },
        },
      };
      Object.defineProperty(globalThis, "chrome", { value: chromeApi, configurable: true });
    },
    { tabs: INITIAL_TABS, bindings: INITIAL_BINDINGS, current: "ctx_mail" },
  );
  await page.goto(pathToFileURL(join(ROOT, "extension/sidepanel/index.html")).href);
  await page.waitForFunction(() => document.querySelectorAll("#tab-list .tab-row").length > 0);
  await page.waitForFunction(() => document.getElementById("shared-count")?.textContent === "2");
  return page;
}

function row(page: Page, id: number): Locator {
  return page.locator(`[data-tab-id="${id}"]`);
}

async function messages(page: Page): Promise<SidepanelModel["messages"]> {
  return page.evaluate(
    () => (globalThis as unknown as { __atcTest: SidepanelModel }).__atcTest.messages,
  );
}

async function waitForVisible(locator: Locator): Promise<void> {
  await expect.poll(() => locator.isVisible(), { timeout: 5_000 }).toBe(true);
}

async function waitForHidden(locator: Locator): Promise<void> {
  await expect.poll(() => locator.isVisible(), { timeout: 5_000 }).toBe(false);
}

async function waitForCount(locator: Locator, count: number): Promise<void> {
  await expect.poll(() => locator.count(), { timeout: 5_000 }).toBe(count);
}

async function waitForText(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => locator.innerText(), { timeout: 5_000 }).toBe(text);
}

async function waitForContains(locator: Locator, text: string): Promise<void> {
  await expect.poll(() => locator.innerText(), { timeout: 5_000 }).toContain(text);
}

it("renders shared contexts, counts, active target, badges, and filters", async () => {
  const page = await sidepanel();
  expect(await page.locator("#shared-count").innerText()).toBe("2");
  expect(await page.locator("#shared-count-sr").innerText()).toBe("2 tabs shared");
  expect(await page.locator("#active-target").innerText()).toContain("Inbox (4)");
  expect(await page.locator("#tab-list .tab-row").count()).toBe(9);

  await waitForVisible(row(page, 7).locator(".badge-shared"));
  await waitForVisible(row(page, 7).locator(".badge-sensitive"));
  await waitForVisible(row(page, 7).locator(".badge-active"));
  await waitForVisible(row(page, 8).locator(".badge-shared"));
  await waitForCount(row(page, 9).locator(".badge-shared"), 0);
  await waitForVisible(row(page, 14).getByText("Needs access", { exact: true }));
  await waitForVisible(row(page, 13).getByText("Unsupported", { exact: true }));
  await waitForVisible(row(page, 12).getByText("Sensitive", { exact: true }));

  expect(await page.locator('[data-count-for="all"]').innerText()).toBe("9");
  expect(await page.locator('[data-count-for="shared"]').innerText()).toBe("2");
  expect(await page.locator('[data-count-for="sensitive"]').innerText()).toBe("4");
  expect(await page.locator('[data-count-for="window"]').innerText()).toBe("8");

  await page.locator('[data-filter="sensitive"]').click();
  await waitForCount(page.locator("#tab-list .tab-row"), 4);
  expect(await page.locator("#results-count").innerText()).toBe("4 tabs");
  await page.locator('[data-filter="window"]').click();
  await waitForCount(page.locator("#tab-list .tab-row"), 8);
  await page.locator('[data-filter="all"]').click();
  await waitForCount(page.locator("#tab-list .tab-row"), 9);
});

it("searches title/host/url with Cmd/Ctrl+K and clears to an empty state", async () => {
  const page = await sidepanel();
  await page.keyboard.press("Control+K");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("tab-search");
  await page.keyboard.type("figma");
  await waitForCount(page.locator("#tab-list .tab-row"), 1);
  await waitForVisible(row(page, 10));
  expect(await page.locator("#results-count").innerText()).toBe("1 tab");

  await page.locator("#tab-search").fill("zzzz-no-match");
  await waitForContains(page.locator("#list-empty"), "No tabs match");
  await page.locator('[data-empty-action="clear-search"]').click();
  await waitForCount(page.locator("#tab-list .tab-row"), 9);
  expect(await page.locator("#tab-search").inputValue()).toBe("");
});

it("shares one selected tab through inline confirmation, not a modal", async () => {
  const page = await sidepanel();
  await row(page, 9).locator("[data-select-id]").check();
  await waitForText(page.locator("#selection-status"), "1 tab selected");
  await page.locator("#share-selected").click();
  await waitForVisible(page.locator("#inline-confirm"));
  expect(await page.locator("#share-dialog").isVisible()).toBe(false);
  await waitForContains(page.locator("#inline-confirm"), "Stripe API");
  expect(await page.locator("#inline-confirm").innerText()).toContain("docs.stripe.com");

  await page.locator("#inline-share").click();
  await waitForVisible(row(page, 9).locator(".badge-shared"));
  await waitForText(page.locator("#shared-count"), "3");
  expect((await messages(page)).some((message) => message.type === "atc:share" && message.tabId === 9)).toBe(true);
  await waitForContains(page.locator("#toast"), "Shared");
});

it("confirms multi-tab shares with a sheet that lists every title and domain", async () => {
  const page = await sidepanel();
  await row(page, 9).locator("[data-select-id]").check();
  await row(page, 10).locator("[data-select-id]").check();
  await waitForText(page.locator("#selection-status"), "2 tabs selected");
  await page.locator("#share-selected").click();
  await waitForVisible(page.locator("#share-dialog"));
  expect(await page.locator("#share-title").innerText()).toBe("Share 2 tabs?");
  expect(await page.locator("#share-list").innerText()).toContain("Stripe API");
  expect(await page.locator("#share-list").innerText()).toContain("ATC side panel — explorations");
  expect(await page.locator("#share-domains").innerText()).toContain("docs.stripe.com");
  expect(await page.locator("#share-domains").innerText()).toContain("figma.com");
  await page.locator("#share-confirm").click();
  await waitForHidden(page.locator("#share-dialog"));
  await waitForVisible(row(page, 9).locator(".badge-shared"));
  await waitForVisible(row(page, 10).locator(".badge-shared"));
  await waitForText(page.locator("#shared-count"), "4");
});

it("keeps sensitive rows locked until their own explicit confirmation", async () => {
  const page = await sidepanel();
  await waitForVisible(row(page, 11).locator(".lock-cell"));
  expect(await row(page, 11).locator('input[type="checkbox"]').count()).toBe(0);
  await waitForVisible(row(page, 11).locator("[data-share-sensitive]"));

  await row(page, 11).locator("[data-share-sensitive]").click();
  await waitForVisible(page.locator("#sensitive-dialog"));
  expect(await page.locator("#sensitive-dialog").innerText()).toContain("Test results — MyChart");
  expect(await page.locator("#sensitive-dialog").innerText()).toContain("mychart.org");
  expect((await messages(page)).some((message) => message.type === "atc:share")).toBe(false);

  await page.getByRole("button", { name: "Keep locked" }).click();
  await waitForHidden(page.locator("#sensitive-dialog"));
  expect((await messages(page)).some((message) => message.type === "atc:share")).toBe(false);

  await row(page, 11).locator("[data-share-sensitive]").click();
  await page.locator("#sensitive-confirm").click();
  await waitForVisible(row(page, 11).locator(".badge-shared"));
  await waitForVisible(row(page, 11).locator(".badge-sensitive"));
  expect((await messages(page)).some((message) => message.type === "atc:share" && message.tabId === 11)).toBe(true);
  await waitForContains(page.locator("#toast"), "unlocked this sensitive tab");
});

it("unshares through the checkbox without closing the browser tab", async () => {
  const page = await sidepanel();
  await row(page, 8).locator("input[data-unshare-tab]").click();
  await waitForCount(row(page, 8).locator(".badge-shared"), 0);
  expect(await row(page, 8).isVisible()).toBe(true);
  await waitForVisible(row(page, 8).locator("[data-select-id]"));
  expect((await messages(page)).some((message) => message.type === "atc:unshare" && message.context === "ctx_github")).toBe(true);
  const removed = await page.evaluate(() => (globalThis as unknown as { __atcTest: { removed: number[] } }).__atcTest.removed);
  expect(removed).toEqual([]);
  await waitForText(page.locator("#shared-count"), "1");
});

it("moves the active target when a shared row is clicked", async () => {
  const page = await sidepanel();
  expect(await page.locator("#active-target").innerText()).toContain("Inbox (4)");
  await row(page, 8).locator("[data-row-main]").click();
  await waitForContains(page.locator("#active-target"), "Fix stale snapshot race");
  await waitForVisible(row(page, 8).locator(".badge-active"));
  await waitForCount(row(page, 7).locator(".badge-active"), 0);
  expect((await messages(page)).some((message) => message.type === "atc:activate" && message.context === "ctx_github")).toBe(true);
});

it("closes a browser tab with × and removes the row before the tab API settles", async () => {
  const page = await sidepanel();
  await page.evaluate(() => {
    const model = (globalThis as unknown as { __atcTest: SidepanelModel }).__atcTest;
    model.removeGate = new Promise((resolve) => {
      model.releaseRemove = resolve;
    });
  });
  await row(page, 9).locator("[data-close-tab]").click();
  expect(await row(page, 9).count()).toBe(0);
  const removed = await page.evaluate(
    () => (globalThis as unknown as { __atcTest: { removed: number[] } }).__atcTest.removed,
  );
  expect(removed).toContain(9);
  await waitForContains(page.locator("#toast"), "Closed");
  await page.evaluate(() => (globalThis as unknown as { __atcTest: SidepanelModel }).__atcTest.releaseRemove?.());
});

it("stays usable at a narrow side-panel width", async () => {
  const page = await sidepanel();
  await page.setViewportSize({ width: 300, height: 700 });
  expect(await page.locator("#tab-list .tab-row").count()).toBe(9);
  const rowBox = await row(page, 8).boundingBox();
  expect(rowBox!.width).toBeLessThanOrEqual(300);
  expect(await page.locator("#search-kbd").isVisible()).toBe(false);
});
