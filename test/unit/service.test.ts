import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtcError } from "../../src/contracts/errors.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { Paths, Request, Response } from "../../src/contracts/protocol.js";
import type { BrowserName } from "../../src/contracts/types.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { fileTimestamp } from "../../src/daemon/responses.js";
import { DaemonService } from "../../src/daemon/service.js";
import { resolveGotoUrl } from "../../src/daemon/url.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

const NOW = new Date("2026-10-01T12:34:56.789Z");

let home: string;
let paths: Paths;
let drivers: Map<BrowserName, FakeDriver>;
let factoryCalls: BrowserName[];
let registry: ContextRegistry;
let service: DaemonService;

function makeService(env: NodeJS.ProcessEnv = {}): DaemonService {
  return new DaemonService({
    registry,
    paths,
    env,
    now: () => NOW,
    driverFactory: (browser) => {
      factoryCalls.push(browser);
      if (browser === "safari" || browser === "firefox") {
        throw new AtcError("UNSUPPORTED_BROWSER", `${browser} is not supported`, { browser });
      }
      const driver = new FakeDriver(browser);
      drivers.set(browser, driver);
      return driver;
    },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atc-service-"));
  paths = resolvePaths({ ATC_HOME: home });
  drivers = new Map();
  factoryCalls = [];
  registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0001, 0x0002, 0x0003, 0x0004]) });
  service = makeService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function call(request: unknown): Promise<Response> {
  return service.handle(request as Request);
}

function chromium(): FakeDriver {
  const driver = drivers.get("chromium");
  if (driver === undefined) throw new Error("chromium driver not created");
  return driver;
}

async function openOk(params: Record<string, unknown> = {}): Promise<string> {
  const res = await call({ method: "open", params: { browser: "chromium", ...params } });
  if (!res.ok) throw new Error(`open failed: ${res.message}`);
  return String(res.context);
}

describe("open", () => {
  it("opens with defaults and makes the first context current", async () => {
    const res = await call({ method: "open", params: { browser: "chromium" } });
    expect(res).toEqual({ ok: true, context: "ctx_0001", browser: "chromium", profile: "default", current: true });
    expect(chromium().state(chromium().sessionIds()[0] ?? "").options).toEqual({ profile: "default", headless: false });
    expect(registry.get("ctx_0001")).toMatchObject({ createdAt: NOW.toISOString(), status: "open" });
  });

  it("does not steal current unless use: true", async () => {
    await openOk();
    const second = await call({ method: "open", params: { browser: "chromium", profile: "work" } });
    expect(second).toMatchObject({ context: "ctx_0002", profile: "work", current: false });
    expect(registry.current).toBe("ctx_0001");
    const third = await call({ method: "open", params: { browser: "chromium", use: true } });
    expect(third).toMatchObject({ context: "ctx_0003", current: true });
    expect(registry.current).toBe("ctx_0003");
  });

  it("caches one driver per browser name", async () => {
    await openOk();
    await openOk();
    await call({ method: "open", params: { browser: "chrome" } });
    expect(factoryCalls).toEqual(["chromium", "chrome"]);
  });

  it("takes headless from params, else ATC_HEADLESS=1", async () => {
    service = makeService({ ATC_HEADLESS: "1" });
    await openOk();
    await openOk({ headless: false });
    const [a, b] = chromium().sessionIds();
    expect(chromium().state(a ?? "").options.headless).toBe(true);
    expect(chromium().state(b ?? "").options.headless).toBe(false);
  });

  it("validates browser and profile", async () => {
    expect(await call({ method: "open", params: { browser: "netscape" } })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(await call({ method: "open", params: { browser: "chromium", profile: "../etc" } })).toMatchObject({
      ok: false,
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "open", params: { browser: "chromium", profile: "x".repeat(65) } })).toMatchObject({
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "open", params: { browser: "chromium", headless: "yes" } })).toMatchObject({
      error: "INVALID_ARGUMENT",
    });
  });

  it("passes UNSUPPORTED_BROWSER through with details", async () => {
    expect(await call({ method: "open", params: { browser: "safari" } })).toEqual({
      ok: false,
      error: "UNSUPPORTED_BROWSER",
      message: "safari is not supported",
      browser: "safari",
    });
  });
});

describe("list / use / current / close", () => {
  it("lists contexts and current", async () => {
    const id = await openOk();
    const res = await call({ method: "list", params: {} });
    expect(res).toMatchObject({ ok: true, current: id, contexts: [{ id, status: "open", url: "about:blank" }] });
  });

  it("use switches current and reports errors", async () => {
    await openOk();
    const b = await openOk();
    expect(await call({ method: "use", params: { context: b } })).toEqual({ ok: true, context: b });
    expect(registry.current).toBe(b);
    expect(await call({ method: "use", params: { context: "ctx_dead" } })).toMatchObject({
      ok: false,
      error: "CONTEXT_NOT_FOUND",
      context: "ctx_dead",
    });
    await call({ method: "close", params: { context: b } });
    expect(await call({ method: "use", params: { context: b } })).toMatchObject({ ok: false, error: "CONTEXT_CLOSED" });
    expect(await call({ method: "use", params: {} })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
  });

  it("current returns the context or NO_CURRENT_CONTEXT", async () => {
    expect(await call({ method: "current", params: {} })).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    const id = await openOk();
    expect(await call({ method: "current", params: {} })).toEqual({ ok: true, context: id });
  });

  it("close closes the driver session, marks closed and clears current", async () => {
    const id = await openOk();
    expect(await call({ method: "close", params: {} })).toEqual({ ok: true, context: id });
    expect(chromium().calls.filter((c) => c.method === "close")).toHaveLength(1);
    expect(registry.get(id)?.status).toBe("closed");
    expect(registry.current).toBeNull();
    expect(await call({ method: "close", params: { context: id } })).toMatchObject({ error: "CONTEXT_CLOSED" });
    expect(await call({ method: "close", params: {} })).toMatchObject({ error: "NO_CURRENT_CONTEXT" });
  });

  it("closing a non-current context keeps current", async () => {
    const a = await openOk();
    const b = await openOk();
    await call({ method: "close", params: { context: b } });
    expect(registry.current).toBe(a);
  });

  it("a browser disconnect closes the context and clears current", async () => {
    const id = await openOk();
    chromium().disconnect(chromium().sessionIds()[0] ?? "");
    expect(registry.get(id)?.status).toBe("closed");
    expect(registry.current).toBeNull();
    expect(await call({ method: "inspect", params: { context: id } })).toMatchObject({ error: "CONTEXT_CLOSED" });
  });
});

describe("context resolution for page commands", () => {
  it("uses explicit context, else current, with typed errors", async () => {
    expect(await call({ method: "reload", params: {} })).toMatchObject({ error: "NO_CURRENT_CONTEXT" });
    expect(await call({ method: "reload", params: { context: "ctx_beef" } })).toMatchObject({ error: "CONTEXT_NOT_FOUND" });
    const a = await openOk();
    const b = await openOk();
    await call({ method: "goto", params: { context: b, url: "https://b.example/" } });
    expect(await call({ method: "inspect", params: {} })).toMatchObject({ context: a, url: "about:blank" });
    expect(await call({ method: "inspect", params: { context: b } })).toMatchObject({ context: b, url: "https://b.example/" });
  });
});

describe("goto and history", () => {
  it("navigates absolute URLs and refreshes url/title in the registry", async () => {
    const id = await openOk();
    const res = await call({ method: "goto", params: { url: "https://example.com/app.html" } });
    expect(res).toEqual({ ok: true, context: id, url: "https://example.com/app.html", title: "app.html" });
    expect(registry.get(id)).toMatchObject({ url: "https://example.com/app.html", title: "app.html" });
  });

  it("resolves relative URLs against the current page", async () => {
    await openOk();
    await call({ method: "goto", params: { url: "https://example.com/docs/app.html" } });
    expect(await call({ method: "goto", params: { url: "/pricing" } })).toMatchObject({ url: "https://example.com/pricing" });
    await call({ method: "goto", params: { url: "https://example.com/docs/app.html" } });
    expect(await call({ method: "goto", params: { url: "pricing.html" } })).toMatchObject({
      url: "https://example.com/docs/pricing.html",
    });
  });

  it("turns a bare host into https", async () => {
    await openOk();
    expect(await call({ method: "goto", params: { url: "example.com" } })).toMatchObject({ url: "https://example.com/" });
  });

  it("rejects a relative URL when the context has no http(s) page yet", async () => {
    await openOk();
    const res = await call({ method: "goto", params: { url: "/pricing" } });
    expect(res).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(chromium().calls.some((c) => c.method === "navigate")).toBe(false);
  });

  it("requires a url string", async () => {
    await openOk();
    expect(await call({ method: "goto", params: {} })).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call({ method: "goto", params: { url: "   " } })).toMatchObject({ error: "INVALID_ARGUMENT" });
  });

  it("back / forward / reload respond with the new location", async () => {
    const id = await openOk();
    await call({ method: "goto", params: { url: "https://example.com/a" } });
    await call({ method: "goto", params: { url: "/b" } });
    expect(await call({ method: "back", params: {} })).toEqual({ ok: true, context: id, url: "https://example.com/a", title: "a" });
    expect(await call({ method: "forward", params: {} })).toMatchObject({ url: "https://example.com/b" });
    expect(await call({ method: "reload", params: {} })).toMatchObject({ url: "https://example.com/b", title: "b" });
    expect(registry.get(id)?.url).toBe("https://example.com/b");
  });

  it("passes NAVIGATION_FAILED through", async () => {
    await openOk();
    chromium().failNext("navigate", new AtcError("NAVIGATION_FAILED", "net::ERR_NAME_NOT_RESOLVED"));
    expect(await call({ method: "goto", params: { url: "https://nope.invalid/" } })).toEqual({
      ok: false,
      error: "NAVIGATION_FAILED",
      message: "net::ERR_NAME_NOT_RESOLVED",
    });
  });
});

describe("resolveGotoUrl", () => {
  const base = "https://example.com/docs/app.html";
  it.each([
    ["https://x.test/a", undefined, "https://x.test/a"],
    ["about:blank", undefined, "about:blank"],
    ["example.com", undefined, "https://example.com/"],
    ["sub.example.co.uk/path?q=1", undefined, "https://sub.example.co.uk/path?q=1"],
    ["localhost:3000/x", undefined, "http://localhost:3000/x"],
    ["127.0.0.1:8080", undefined, "http://127.0.0.1:8080/"],
    ["/pricing", base, "https://example.com/pricing"],
    ["./pricing.html", base, "https://example.com/docs/pricing.html"],
    ["../root.html", base, "https://example.com/root.html"],
    ["pricing.html", base, "https://example.com/docs/pricing.html"],
    ["guide/intro", base, "https://example.com/docs/guide/intro"],
    ["?q=1", base, "https://example.com/docs/app.html?q=1"],
  ])("%s (base %s) -> %s", (input, b, expected) => {
    expect(resolveGotoUrl(input, b)).toBe(expected);
  });

  it("rejects relative URLs without an http(s) base", () => {
    expect(() => resolveGotoUrl("/x", undefined)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveGotoUrl("/x", "about:blank")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    expect(() => resolveGotoUrl("pricing.html", "file:///tmp/a.html")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("rejects unparseable absolute URLs", () => {
    expect(() => resolveGotoUrl("http://", undefined)).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});

describe("inspect, screenshot, console, network", () => {
  it("inspect returns the aria snapshot and refreshes the registry", async () => {
    const id = await openOk();
    await call({ method: "goto", params: { url: "https://example.com/app" } });
    expect(await call({ method: "inspect", params: {} })).toEqual({
      ok: true,
      context: id,
      url: "https://example.com/app",
      title: "app",
      aria: '- heading "app"',
    });
  });

  it("screenshot defaults to the screenshots dir with a filesystem-safe timestamp", async () => {
    const id = await openOk();
    const res = await call({ method: "screenshot", params: {} });
    const expected = join(paths.screenshots, `${id}-2026-10-01T12-34-56-789Z.png`);
    expect(res).toEqual({ ok: true, context: id, path: expected, bytes: 8 });
    expect(await readFile(expected, "utf8")).toBe("fake-png");
    expect(fileTimestamp(NOW)).not.toMatch(/[:.]/);
  });

  it("screenshot honors an absolute out path and fullPage, and rejects relative out", async () => {
    await openOk();
    const out = join(home, "nested", "shot.png");
    expect(await call({ method: "screenshot", params: { out, fullPage: true } })).toMatchObject({ ok: true, path: out });
    expect(chromium().calls.find((c) => c.method === "screenshot")?.args).toEqual([out, true]);
    expect(await call({ method: "screenshot", params: { out: "shot.png" } })).toMatchObject({ error: "INVALID_ARGUMENT" });
  });

  it("console returns entries after since, and next = last seq (or since when empty)", async () => {
    const id = await openOk();
    const state = chromium().state(chromium().sessionIds()[0] ?? "");
    state.console.push(
      { seq: 1, type: "log", text: "one", at: "t" },
      { seq: 2, type: "error", text: "two", at: "t" },
      { seq: 3, type: "log", text: "three", at: "t" },
    );
    const all = await call({ method: "console", params: {} });
    expect(all).toMatchObject({ ok: true, context: id, next: 3 });
    expect(all.ok && Array.isArray(all.entries) ? all.entries : []).toHaveLength(3);
    const tail = await call({ method: "console", params: { since: 1 } });
    expect(tail).toMatchObject({ next: 3, entries: [{ seq: 2 }, { seq: 3 }] });
    expect(await call({ method: "console", params: { since: 3 } })).toEqual({ ok: true, context: id, entries: [], next: 3 });
    expect(await call({ method: "console", params: { since: -1 } })).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call({ method: "console", params: { since: 1.5 } })).toMatchObject({ error: "INVALID_ARGUMENT" });
  });

  it("network follows the same next semantics", async () => {
    await openOk();
    const state = chromium().state(chromium().sessionIds()[0] ?? "");
    expect(await call({ method: "network", params: {} })).toMatchObject({ entries: [], next: 0 });
    state.network.push({ seq: 5, method: "GET", url: "https://x/missing.json", resourceType: "fetch", status: 404, at: "t" });
    expect(await call({ method: "network", params: { since: 0 } })).toMatchObject({ next: 5, entries: [{ status: 404 }] });
  });
});

describe("actions", () => {
  const target = { kind: "label", label: "Password" };

  it("click / type / select respond with matched: 1", async () => {
    const id = await openOk();
    expect(await call({ method: "click", params: { target: { kind: "role", role: "button", name: "Save" } } })).toEqual({
      ok: true,
      context: id,
      matched: 1,
    });
    expect(await call({ method: "type", params: { target, value: "hunter2" } })).toEqual({ ok: true, context: id, matched: 1 });
    expect(await call({ method: "select", params: { target, value: "Stage" } })).toEqual({ ok: true, context: id, matched: 1 });
    const typed = chromium().calls.find((c) => c.method === "type");
    expect(typed?.args).toEqual([target, "hunter2"]);
  });

  it("validates targets and values", async () => {
    await openOk();
    expect(await call({ method: "click", params: {} })).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call({ method: "click", params: { target: { kind: "xpath", xpath: "//a" } } })).toMatchObject({
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "click", params: { target: { kind: "text", text: "" } } })).toMatchObject({
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "click", params: { target: { kind: "text", text: "x", nth: -1 } } })).toMatchObject({
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "type", params: { target } })).toMatchObject({ error: "INVALID_ARGUMENT" });
  });

  it("forwards nth to the driver", async () => {
    await openOk();
    await call({ method: "click", params: { target: { kind: "role", role: "button", name: "Delete", nth: 1 } } });
    expect(chromium().calls.find((c) => c.method === "click")?.args).toEqual([
      { kind: "role", role: "button", name: "Delete", nth: 1 },
    ]);
  });

  it("passes AMBIGUOUS_TARGET details through", async () => {
    await openOk();
    chromium().failNext("click", new AtcError("AMBIGUOUS_TARGET", "2 elements match", { matched: 2 }));
    expect(await call({ method: "click", params: { target: { kind: "role", role: "button", name: "Delete" } } })).toEqual({
      ok: false,
      error: "AMBIGUOUS_TARGET",
      message: "2 elements match",
      matched: 2,
    });
  });

  it("details can never override ok/error/message", async () => {
    await openOk();
    chromium().failNext("click", new AtcError("TARGET_NOT_FOUND", "nothing", { ok: true, error: "X", message: "y" }));
    expect(await call({ method: "click", params: { target } })).toEqual({
      ok: false,
      error: "TARGET_NOT_FOUND",
      message: "nothing",
    });
  });

  it("maps unknown errors to INTERNAL", async () => {
    await openOk();
    chromium().failNext("click", new Error("kaboom"));
    expect(await call({ method: "click", params: { target } })).toEqual({ ok: false, error: "INTERNAL", message: "kaboom" });
    chromium().failNext("click", "string failure");
    expect(await call({ method: "click", params: { target } })).toEqual({
      ok: false,
      error: "INTERNAL",
      message: "string failure",
    });
  });

  it("never echoes the typed value in error responses", async () => {
    await openOk();
    chromium().failNext(
      "type",
      new AtcError("ACTION_FAILED", 'fill("s3cret-pw") failed', { detail: "value s3cret-pw", nested: ["s3cret-pw"] }),
    );
    const res = await call({ method: "type", params: { target, value: "s3cret-pw" } });
    expect(res).toMatchObject({ ok: false, error: "ACTION_FAILED" });
    expect(JSON.stringify(res)).not.toContain("s3cret-pw");
    expect(res).toMatchObject({ message: 'fill("[redacted]") failed', nested: ["[redacted]"] });
  });
});

describe("protocol-level", () => {
  it("rejects unknown methods and malformed requests", async () => {
    expect(await call({ method: "explode", params: {} })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(await call({ params: {} })).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call(null)).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call({ method: "list", params: 3 })).toMatchObject({ error: "INVALID_ARGUMENT" });
    expect(await call({ method: "toString", params: {} })).toMatchObject({ error: "INVALID_ARGUMENT" });
  });

  it("ping returns the pid", async () => {
    expect(await call({ method: "ping", params: {} })).toEqual({ ok: true, pid: process.pid });
  });

  it("shutdown closes every open session, then fires onShutdown after responding", async () => {
    await openOk();
    await openOk();
    let fired = 0;
    service.onShutdown(() => {
      fired += 1;
    });
    const res = await call({ method: "shutdown", params: {} });
    expect(res).toEqual({ ok: true });
    expect(fired).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fired).toBe(1);
    expect(registry.openSessions()).toEqual([]);
    expect(chromium().calls.filter((c) => c.method === "close")).toHaveLength(2);
  });

  it("closeAll tolerates driver close failures", async () => {
    const id = await openOk();
    chromium().failNext("close", new Error("already gone"));
    await service.closeAll();
    expect(registry.get(id)?.status).toBe("closed");
  });

  it("route pins context-less page commands to the current context", async () => {
    const id = await openOk();
    expect(service.route({ method: "goto", params: { url: "/x" } })).toEqual({
      key: id,
      request: { method: "goto", params: { url: "/x", context: id } },
    });
    expect(service.route({ method: "goto", params: { context: "ctx_9999", url: "/x" } }).key).toBe("ctx_9999");
    expect(service.route({ method: "list", params: {} }).key).toBeNull();
    await call({ method: "close", params: {} });
    expect(service.route({ method: "inspect", params: {} }).key).toBeNull();
  });
});
