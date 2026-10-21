import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TabCtxError, type ErrorCode } from "../../src/contracts/errors.js";
import type { BrowserDriver, BrowserSession, Target } from "../../src/contracts/types.js";
import { createDriver } from "../../src/drivers/index.js";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server.js";

const DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

function chromiumPath(): string | undefined {
  const fromEnv = process.env.TABCTX_CHROMIUM_PATH;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return existsSync(DEFAULT_CHROMIUM) ? DEFAULT_CHROMIUM : undefined;
}

async function expectTabCtxError(
  promise: Promise<unknown>,
  code: ErrorCode,
  details?: Record<string, unknown>,
): Promise<TabCtxError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}, but the call succeeded`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TabCtxError);
  const typed = error as TabCtxError;
  expect(typed.code).toBe(code);
  if (details !== undefined) expect(typed.details).toEqual(details);
  return typed;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

/** A localhost port with nothing listening on it (connection refused). */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", resolveListen));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

const save: Target = { kind: "role", role: "button", name: "Save" };
const deleteButton: Target = { kind: "role", role: "button", name: "Delete" };

describe("ChromiumDriver (e2e, headless)", () => {
  let server: FixtureServer;
  let workDir: string;
  let driver: BrowserDriver;
  let session: BrowserSession;
  const opened: BrowserSession[] = [];

  async function openSession(profile: string): Promise<BrowserSession> {
    const result = await driver.open({ profile, headless: true });
    opened.push(result);
    return result;
  }

  beforeAll(async () => {
    server = await startFixtureServer();
    workDir = await mkdtemp(join(tmpdir(), "tabctx-driver-"));
    const executablePath = chromiumPath();
    driver = createDriver("chromium", {
      profilesDir: join(workDir, "profiles"),
      ...(executablePath === undefined ? {} : { executablePath }),
    });
    session = await openSession("main");
  });

  afterAll(async () => {
    for (const each of opened) await driver.close(each);
    await server.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("navigates to the fixture and reports location and title", async () => {
    await driver.navigate(session, `${server.baseUrl}/app.html`);
    expect(await driver.location(session)).toEqual({ url: `${server.baseUrl}/app.html`, title: "Fixture App" });
  });

  it("inspect returns an ARIA snapshot containing the Save button", async () => {
    const state = await driver.inspect(session);
    expect(state.url).toBe(`${server.baseUrl}/app.html`);
    expect(state.title).toBe("Fixture App");
    expect(state.aria).toContain('button "Save"');
  });

  it("clicks a uniquely matched button", async () => {
    expect(await driver.click(session, save)).toEqual({ matched: 1 });
  });

  it("refuses an ambiguous target and reports the match count", async () => {
    const error = await expectTabCtxError(driver.click(session, deleteButton), "AMBIGUOUS_TARGET", { matched: 2 });
    expect(error.message).toContain("Delete");
  });

  it("uses nth as the explicit escape hatch", async () => {
    expect(await driver.click(session, { ...deleteButton, nth: 1 })).toEqual({ matched: 1 });
  });

  it("rejects an out-of-range nth with TARGET_NOT_FOUND", async () => {
    await expectTabCtxError(driver.click(session, { ...deleteButton, nth: 5 }), "TARGET_NOT_FOUND", { matched: 2 });
  });

  it("does not count hidden elements", async () => {
    await expectTabCtxError(
      driver.click(session, { kind: "role", role: "button", name: "Hidden Only" }),
      "TARGET_NOT_FOUND",
      { matched: 0 },
    );
    await expectTabCtxError(
      driver.click(session, { kind: "selector", selector: "section button" }),
      "AMBIGUOUS_TARGET",
      { matched: 2 },
    );
  });

  it("matches names exactly, not by substring", async () => {
    await expectTabCtxError(driver.click(session, { kind: "role", role: "button", name: "Sav" }), "TARGET_NOT_FOUND");
  });

  it("types into a labelled field and the page sees the value", async () => {
    const value = "Blue Shirt 42";
    expect(await driver.type(session, { kind: "label", label: "Product Name" }, value)).toEqual({ matched: 1 });
    await driver.click(session, save);
    const state = await driver.inspect(session);
    expect(state.aria).toContain(`Saved: ${value}`);
  });

  it("never leaks the typed value in errors", async () => {
    const secret = "hunter2-secret";
    const error = await expectTabCtxError(
      driver.type(session, { kind: "label", label: "No Such Field" }, secret),
      "TARGET_NOT_FOUND",
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
  });

  it("selects an option by label, falling back to value", async () => {
    const env: Target = { kind: "label", label: "Environment" };
    expect(await driver.select(session, env, "Stage")).toEqual({ matched: 1 });
    expect((await driver.inspect(session)).aria).toMatch(/combobox "Environment"[^\n]*\n(?:[^\n]*\n)*?[^\n]*option "Stage" \[selected\]/);
    expect(await driver.select(session, env, "Prod")).toEqual({ matched: 1 });
    await expectTabCtxError(driver.select(session, env, "Nope"), "TARGET_NOT_FOUND");
  });

  it("captures console logs and errors with increasing seq", async () => {
    await driver.click(session, { kind: "text", text: "Break" });
    const entries = await waitFor(
      () => driver.console(session, 0),
      (list) => list.some((entry) => entry.text === "boom"),
    );
    expect(entries.some((entry) => entry.type === "log" && entry.text.startsWith("saved"))).toBe(true);
    expect(entries.some((entry) => entry.type === "error" && entry.text === "boom")).toBe(true);
    const seqs = entries.map((entry) => entry.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (const entry of entries) expect(Number.isNaN(Date.parse(entry.at))).toBe(false);

    const last = seqs.at(-1) ?? 0;
    expect(await driver.console(session, last)).toEqual([]);
    expect((await driver.console(session, last - 1)).map((entry) => entry.seq)).toEqual([last]);
  });

  it("captures uncaught page errors as pageerror", async () => {
    await driver.navigate(session, "data:text/html,<script>throw new Error('kaboom')</script>");
    const entries = await waitFor(
      () => driver.console(session, 0),
      (list) => list.some((entry) => entry.type === "pageerror"),
    );
    expect(entries.find((entry) => entry.type === "pageerror")?.text).toContain("kaboom");
    await driver.navigate(session, `${server.baseUrl}/app.html`);
  });

  it("captures network requests including the 404 for /missing.json", async () => {
    await driver.click(session, { kind: "text", text: "Break" });
    const entries = await waitFor(
      () => driver.network(session, 0),
      (list) => list.some((entry) => entry.url.endsWith("/missing.json") && entry.status === 404),
    );
    const missing = entries.find((entry) => entry.url === `${server.baseUrl}/missing.json` && entry.status !== undefined);
    expect(missing).toMatchObject({ method: "GET", status: 404 });
    const page = entries.find((entry) => entry.url === `${server.baseUrl}/app.html`);
    expect(page).toMatchObject({ method: "GET", status: 200, resourceType: "document" });
    expect(entries[0]?.seq).toBe(1);
  });

  it("records failed requests with a failure reason, and the next navigation still works", async () => {
    const before = (await driver.network(session, 0)).at(-1)?.seq ?? 0;
    const unreachable = `http://127.0.0.1:${await closedPort()}/unreachable`;
    await expectTabCtxError(driver.navigate(session, unreachable), "NAVIGATION_FAILED", { url: unreachable });
    const entries = await driver.network(session, before);
    const failed = entries.find((entry) => entry.url === unreachable);
    expect(failed?.failure).toBeTruthy();
    expect(failed?.status).toBeUndefined();
    await driver.navigate(session, `${server.baseUrl}/app.html`);
    expect((await driver.location(session)).title).toBe("Fixture App");
  });

  it("writes a non-empty PNG screenshot, creating parent dirs", async () => {
    await driver.navigate(session, `${server.baseUrl}/app.html`);
    const path = join(workDir, "shots", "nested", "app.png");
    const result = await driver.screenshot(session, path, true);
    expect(result.path).toBe(path);
    expect(result.bytes).toBeGreaterThan(0);
    expect((await stat(path)).size).toBe(result.bytes);
  });

  it("supports back, forward and reload", async () => {
    await driver.navigate(session, `${server.baseUrl}/app.html`);
    await driver.navigate(session, `${server.baseUrl}/pricing.html`);
    expect((await driver.location(session)).title).toBe("Pricing");
    await driver.back(session);
    expect(await driver.location(session)).toEqual({ url: `${server.baseUrl}/app.html`, title: "Fixture App" });
    await driver.forward(session);
    expect((await driver.location(session)).title).toBe("Pricing");
    await driver.reload(session);
    expect(await driver.location(session)).toEqual({ url: `${server.baseUrl}/pricing.html`, title: "Pricing" });
  });

  it("refuses to open a profile that is already in use", async () => {
    const error = await expectTabCtxError(driver.open({ profile: "main", headless: true }), "ACTION_FAILED");
    expect(error.message).toContain("main");
  });

  it("refuses a profile whose user-data dir is locked by another live Chromium process", async () => {
    const lockedDir = join(workDir, "profiles", "locked-elsewhere");
    await mkdir(lockedDir, { recursive: true });
    await symlink(`${hostname()}-${process.ppid}`, join(lockedDir, "SingletonLock"));
    await expectTabCtxError(driver.open({ profile: "locked-elsewhere", headless: true }), "ACTION_FAILED", {
      profile: "locked-elsewhere",
    });
  });

  it("ignores a stale SingletonLock left by a dead process", async () => {
    const staleDir = join(workDir, "profiles", "stale-lock");
    await mkdir(staleDir, { recursive: true });
    await symlink(`${hostname()}-2147483646`, join(staleDir, "SingletonLock"));
    const stale = await openSession("stale-lock");
    await driver.close(stale);
  });

  it("rejects profile names that would escape the profiles dir", async () => {
    await expectTabCtxError(driver.open({ profile: "../evil", headless: true }), "INVALID_ARGUMENT");
  });

  it("fires onDisconnect exactly once, then reports CONTEXT_CLOSED", async () => {
    const other = await openSession("secondary");
    let fired = 0;
    driver.onDisconnect(other, () => {
      fired += 1;
    });
    await driver.close(other);
    await driver.close(other); // idempotent
    expect(fired).toBe(1);

    await expectTabCtxError(driver.location(other), "CONTEXT_CLOSED");
    await expectTabCtxError(driver.navigate(other, `${server.baseUrl}/app.html`), "CONTEXT_CLOSED");
    await expectTabCtxError(driver.click(other, save), "CONTEXT_CLOSED");
    await expectTabCtxError(driver.console(other, 0), "CONTEXT_CLOSED");
    await expectTabCtxError(driver.network(other, 0), "CONTEXT_CLOSED");
  });

  it("frees the profile after close so it can be reopened", async () => {
    const reopened = await openSession("secondary");
    await driver.navigate(reopened, `${server.baseUrl}/pricing.html`);
    expect((await driver.location(reopened)).title).toBe("Pricing");
    await driver.close(reopened);
  });

  it("treats unknown sessions as CONTEXT_CLOSED", async () => {
    await expectTabCtxError(driver.inspect({ sessionId: "nope" }), "CONTEXT_CLOSED");
  });
});

describe("createDriver", () => {
  it("returns drivers for chromium, chrome, brave, edge, firefox, safari, webkit, and extension", () => {
    expect(createDriver("chromium", { profilesDir: tmpdir() }).name).toBe("chromium");
    expect(createDriver("chrome", { profilesDir: tmpdir() }).name).toBe("chrome");
    expect(createDriver("brave", { profilesDir: tmpdir() }).name).toBe("brave");
    expect(createDriver("edge", { profilesDir: tmpdir() }).name).toBe("edge");
    expect(createDriver("firefox", { profilesDir: tmpdir() }).name).toBe("firefox");
    expect(createDriver("safari", { profilesDir: tmpdir() }).name).toBe("safari");
    expect(createDriver("webkit", { profilesDir: tmpdir() }).name).toBe("webkit");
    expect(createDriver("extension", { profilesDir: tmpdir() }).name).toBe("extension");
  });

  it("rejects unknown browser names with UNSUPPORTED_BROWSER", () => {
    expect(() => createDriver("opera" as never, { profilesDir: tmpdir() })).toThrowError(TabCtxError);
    try {
      createDriver("opera" as never, { profilesDir: tmpdir() });
    } catch (error) {
      expect((error as TabCtxError).code).toBe("UNSUPPORTED_BROWSER");
    }
  });
});
