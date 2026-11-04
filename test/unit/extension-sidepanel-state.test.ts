import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type StateApi = {
  classifyUrl(url: string): { sensitive: boolean; supported: boolean; unsupported: boolean; category: string | null };
  isSensitiveUrl(url: string): boolean;
  hostOf(url: string): string;
  parseExtensionTabId(tabId: unknown): { key: string; tabId: number } | null;
  normalizeBindingsReply(reply: unknown): {
    ok: boolean;
    current: string | null;
    bindings: Array<Record<string, unknown>>;
    message?: string;
  };
  normalizeOutcomeReply(reply: unknown): { ok: boolean; context?: string; message?: string };
  createRows(tabs: unknown[], snapshot: unknown, options?: unknown): Row[];
  visibleRows(rows: Row[], options: Record<string, unknown>): Row[];
  counts(rows: Row[], windowId: number | null): Record<string, number>;
  isSelectable(row: Row): boolean;
  createSharePlan(rows: Row[], selected: Set<number> | number[]): {
    tabs: Row[];
    count: number;
    domains: string[];
    single: boolean;
    lockedSensitive: number;
  };
  emptyState(rows: Row[], options: Record<string, unknown>): { title: string; action: string | null } | null;
  faviconColor(host: string): string;
  pluralize(count: number, singular: string): string;
};

interface Row {
  id: number;
  title: string;
  host: string;
  url: string;
  windowId: number | null;
  shared: boolean;
  activeTarget: boolean;
  sensitive: boolean;
  supported: boolean;
  unsupported: boolean;
  needsAccess: boolean;
  context: string | null;
  category: string | null;
}

function stateApi(): StateApi {
  const files = ["state.js", "state-bindings.js", "state-view.js"].map((name) =>
    readFileSync(join(import.meta.dirname, "../../extension/sidepanel", name), "utf8"),
  );
  const context = vm.createContext({ URL });
  vm.runInContext(`${files.join("\n")}\nglobalThis.api = ATCState;`, context);
  return context.api as StateApi;
}

const BINDINGS = [
  {
    context: "ctx_mail",
    tabId: "ext:chromium-0a1b2c3d:7",
    browser: "chromium",
    source: "extension",
    url: "https://mail.google.com/mail/u/0/",
    title: "Inbox",
    current: true,
  },
  {
    context: "ctx_pr",
    tabId: "ext:chromium-0a1b2c3d:8",
    browser: "chromium",
    source: "extension",
    url: "https://github.com/gainratio/atc/pull/482",
    title: "Fix race · PR #482",
    current: false,
  },
];

const TABS = [
  { id: 7, index: 0, windowId: 1, active: true, title: "Inbox (4)", url: "https://mail.google.com/mail/u/0/" },
  { id: 8, index: 1, windowId: 1, active: false, title: "Fix race · PR #482", url: "https://github.com/gainratio/atc/pull/482" },
  { id: 9, index: 2, windowId: 1, active: false, title: "Stripe docs", url: "https://docs.stripe.com/api/checkout/sessions" },
  { id: 10, index: 3, windowId: 1, active: false, title: "Other window", url: "https://example.test/other", windowIdOverride: 2 },
];

function rows(): Row[] {
  return stateApi().createRows(
    TABS.map(({ windowIdOverride, ...tab }) => ({ ...tab, windowId: windowIdOverride ?? tab.windowId })),
    { current: "ctx_mail", bindings: BINDINGS },
    { needsAccess: { 9: true } },
  );
}

describe("side-panel sensitive classifier", () => {
  it.each([
    ["https://mail.google.com/mail/u/0/", true],
    ["https://outlook.office.com/mail", true],
    ["https://proton.me/mail", true],
    ["https://secure.chase.com/web/auth/dashboard", true],
    ["https://www.bankofamerica.com/", true],
    ["https://mychart.org/test-results", true],
    ["https://my.1password.com/vaults", true],
    ["https://lastpass.com/", true],
    ["https://bitwarden.com/", true],
    ["https://chromewebstore.google.com/detail/x", true],
    ["https://chrome.google.com/webstore/category/extensions", true],
    ["file:///Users/me/secret.txt", true],
    ["chrome://extensions", true],
    ["https://dashboard.stripe.com/test/payments", true],
    ["https://docs.stripe.com/api/checkout/sessions", false],
    ["https://example.com/docs", false],
    ["about:blank", false],
  ])("classifies %s as sensitive=%s", (url, sensitive) => {
    expect(stateApi().isSensitiveUrl(url)).toBe(sensitive);
  });

  it("marks file and browser pages unsupported as well as sensitive", () => {
    const state = stateApi();
    expect(state.classifyUrl("file:///Users/me/secret.txt")).toMatchObject({ sensitive: true, unsupported: true });
    expect(state.classifyUrl("chrome://extensions")).toMatchObject({ sensitive: true, unsupported: true });
    expect(state.classifyUrl("https://mail.google.com/")).toMatchObject({
      sensitive: true,
      supported: true,
      unsupported: false,
      category: "Mail",
    });
  });

  it("names the category shown in the sensitive confirmation", () => {
    const state = stateApi();
    expect(state.classifyUrl("https://secure.chase.com/").category).toBe("Banking");
    expect(state.classifyUrl("https://mychart.org/").category).toBe("Health");
    expect(state.classifyUrl("https://my.1password.com/").category).toBe("Passwords");
    expect(state.classifyUrl("https://chromewebstore.google.com/").category).toBe("Web Store");
  });

  it("derives a human host for http, file, and browser URLs", () => {
    const state = stateApi();
    expect(state.hostOf("https://www.example.com/a")).toBe("example.com");
    expect(state.hostOf("file:///tmp/a")).toBe("Local file");
    expect(state.hostOf("chrome://extensions")).toBe("chrome://extensions");
  });
});

describe("side-panel binding state", () => {
  it("parses the daemon's extension tab id format", () => {
    const state = stateApi();
    expect(state.parseExtensionTabId("ext:chromium-0a1b2c3d:7")).toEqual({ key: "chromium-0a1b2c3d", tabId: 7 });
    expect(state.parseExtensionTabId("ext:firefox-deadbeef:42")).toEqual({ key: "firefox-deadbeef", tabId: 42 });
    expect(state.parseExtensionTabId("ext:chromium-0a1b2c3d:0")).toBeNull();
    expect(state.parseExtensionTabId("ext:../x:1")).toBeNull();
    expect(state.parseExtensionTabId("7")).toBeNull();
    expect(state.parseExtensionTabId(null)).toBeNull();
  });

  it("maps raw tab ids to shared contexts and the active target", () => {
    const built = rows();
    expect(built).toHaveLength(4);
    expect(built[0]).toMatchObject({ id: 7, shared: true, activeTarget: true, sensitive: true, context: "ctx_mail" });
    expect(built[1]).toMatchObject({ id: 8, shared: true, activeTarget: false, sensitive: false, context: "ctx_pr" });
    expect(built[2]).toMatchObject({ id: 9, shared: false, needsAccess: true, supported: true });
    expect(built[3]).toMatchObject({ id: 10, shared: false, windowId: 2 });
  });

  it("rejects malformed bindings replies instead of trusting them", () => {
    const state = stateApi();
    expect(state.normalizeBindingsReply({ ok: true, current: null, bindings: [] })).toMatchObject({ ok: true });
    expect(state.normalizeBindingsReply({ ok: true, current: "ctx_1", bindings: BINDINGS })).toMatchObject({
      ok: true,
      current: "ctx_1",
    });
    for (const reply of [
      undefined,
      null,
      { ok: "yes", current: null, bindings: [] },
      { ok: true, current: 3, bindings: [] },
      { ok: true, current: null, bindings: {} },
      { ok: true, current: null, bindings: [{ context: "", tabId: "x", browser: "chrome", source: "extension", url: null, title: null, current: false }] },
      { ok: true, current: null, bindings: [{ context: "ctx", tabId: 7, browser: "chrome", source: "extension", url: null, title: null, current: false }] },
    ]) {
      expect(state.normalizeBindingsReply(reply)).toMatchObject({ ok: false, bindings: [] });
    }
  });

  it("validates action outcomes", () => {
    const state = stateApi();
    expect(state.normalizeOutcomeReply({ ok: true, context: "ctx_1" })).toEqual({ ok: true, context: "ctx_1" });
    expect(state.normalizeOutcomeReply({ ok: false, message: "nope" })).toEqual({ ok: false, message: "nope" });
    expect(state.normalizeOutcomeReply({ ok: true, context: 4 })).toMatchObject({ ok: false });
    expect(state.normalizeOutcomeReply("shared")).toMatchObject({ ok: false });
  });

  it("filters by shared, sensitive, window, and title/host/url search", () => {
    const state = stateApi();
    const built = rows();
    expect(state.visibleRows(built, { filter: "shared", query: "", windowId: 1 }).map((row) => row.id)).toEqual([7, 8]);
    expect(state.visibleRows(built, { filter: "sensitive", query: "", windowId: 1 }).map((row) => row.id)).toEqual([7]);
    expect(state.visibleRows(built, { filter: "window", query: "", windowId: 2 }).map((row) => row.id)).toEqual([10]);
    expect(state.visibleRows(built, { filter: "all", query: "pr #482", windowId: 1 }).map((row) => row.id)).toEqual([8]);
    expect(state.visibleRows(built, { filter: "all", query: "docs.stripe", windowId: 1 }).map((row) => row.id)).toEqual([9]);
    expect(state.counts(built, 1)).toEqual({ all: 4, shared: 2, sensitive: 1, window: 3 });
  });

  it("never puts sensitive, unsupported, shared, or access-missing tabs in a share plan", () => {
    const state = stateApi();
    const built = rows();
    const inaccessible = built.find((row) => row.id === 9);
    expect(inaccessible).toBeDefined();
    expect(state.isSelectable(inaccessible!)).toBe(false);
    const plan = state.createSharePlan(built, new Set([7, 8, 9, 10]));
    expect(plan.tabs.map((row) => row.id)).toEqual([10]);
    expect(plan).toMatchObject({ count: 1, single: true, domains: ["example.test"] });
  });

  it("reports empty-state copy for search and filters", () => {
    const state = stateApi();
    const built = rows();
    expect(state.emptyState(built, { filter: "all", query: "zzz", windowId: 1 })).toMatchObject({
      title: "No tabs match “zzz”",
      action: "clear-search",
    });
    expect(state.emptyState([], { filter: "all", query: "", windowId: 1 })).toMatchObject({ title: "No open tabs" });
    expect(state.emptyState(built, { filter: "sensitive", query: "zzz", windowId: 1 })).toMatchObject({
      action: "clear-search",
    });
  });

  it("gives each host a stable, distinct dot color", () => {
    const state = stateApi();
    expect(state.faviconColor("github.com")).toBe(state.faviconColor("github.com"));
    expect(state.faviconColor("github.com")).toMatch(/^hsl\(\d+ 48% 48%\)$/);
    expect(state.faviconColor("github.com")).not.toBe(state.faviconColor("mail.google.com"));
  });
});
