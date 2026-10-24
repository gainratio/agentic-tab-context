/**
 * Separate `atc` processes drive one persistent managed Chromium window
 * through the real daemon. State set by one command (typed text, navigation
 * history) must still be there for the next.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliResult, type Json, cli } from "../helpers/cli.js";
import { type FixtureServer, startFixtureServer } from "../helpers/fixture-server.js";

let home: string;
let fixtures: FixtureServer;
let atc: (...args: string[]) => Promise<CliResult>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "atc-e2e-"));
  atc = cli({ ATC_HOME: home, ATC_HEADLESS: "1" });
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await atc("shutdown");
  await fixtures.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("atc end to end (managed window)", () => {
  let ctx = "";

  it("opens a sticky context and makes it current", async () => {
    const opened = await atc("open", "chromium", "--use");
    expect(opened.code).toBe(0);
    expect(opened.lines).toBe(1);
    ctx = String(opened.json.context);
    expect(ctx).toMatch(/^ctx_[0-9a-f]{4,}$/);
    expect((await atc("current")).json).toMatchObject({ ok: true, context: ctx });
  });

  it("navigates absolute, then relative to the current page", async () => {
    expect((await atc("goto", `${fixtures.baseUrl}/app.html`)).json).toMatchObject({ ok: true, title: "Fixture App" });
    expect((await atc("goto", "/pricing.html")).json).toMatchObject({ ok: true, title: "Pricing" });
    expect((await atc("back")).json).toMatchObject({ ok: true, title: "Fixture App" });
  });

  it("keeps page state across separate CLI processes", async () => {
    expect((await atc("type", "--label", "Product Name", "--value", "Blue Shirt")).json).toMatchObject({ ok: true, matched: 1 });
    expect((await atc("select", "--label", "Environment", "--value", "Stage")).code).toBe(0);
    expect((await atc("click", "--role", "button", "--name", "Save")).json).toMatchObject({ ok: true, matched: 1 });
    expect(String((await atc("inspect")).json.aria)).toContain("Saved: Blue Shirt");
  });

  it("refuses to guess between ambiguous targets", async () => {
    const ambiguous = await atc("click", "--role", "button", "--name", "Delete");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json).toMatchObject({ ok: false, error: "AMBIGUOUS_TARGET", matched: 2 });
    expect((await atc("click", "--role", "button", "--name", "Delete", "--nth", "1")).json).toMatchObject({ ok: true, matched: 1 });
    expect((await atc("click", "--role", "button", "--name", "Nope")).json).toMatchObject({ ok: false, error: "TARGET_NOT_FOUND" });
  });

  it("exposes console and network activity", async () => {
    await atc("click", "--role", "button", "--name", "Break");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const texts = ((await atc("console")).json.entries as Json[]).map((entry) => String(entry.text));
    expect(texts.some((text) => text.includes("boom"))).toBe(true);
    const missing = ((await atc("network")).json.entries as Json[]).find((entry) => String(entry.url).endsWith("/missing.json"));
    expect(missing).toMatchObject({ status: 404 });
  });

  it("writes a screenshot", async () => {
    const shot = await atc("screenshot");
    expect(shot.code).toBe(0);
    expect(existsSync(String(shot.json.path)) && statSync(String(shot.json.path)).size > 0).toBe(true);
  });

  it("lists managed tabs and binds to one", async () => {
    const tabs = (await atc("tabs")).json.tabs as Json[];
    expect(tabs.some((t) => String(t.url).endsWith("/app.html") && t.source === "managed")).toBe(true);
    expect((await atc("bind", "--query", "Fixture App", "--browser", "chromium")).json).toMatchObject({ ok: true, context: ctx, reused: true });
  });

  it("explains next steps in doctor", async () => {
    const report = await atc("doctor");
    expect(report.json).toMatchObject({ ok: true, contexts: { current: ctx } });
    expect(Array.isArray(report.json.nextSteps)).toBe(true);
  });

  it("rejects bad input and unsupported browsers with typed errors", async () => {
    expect((await atc("open", "opera")).json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect((await atc("open", "safari")).json).toMatchObject({ ok: false, error: "UNSUPPORTED_BROWSER" });
    expect((await atc("click")).json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
  });

  it("closes the context and forgets it as current", async () => {
    expect((await atc("close", ctx)).json).toMatchObject({ ok: true, context: ctx });
    expect((await atc("current")).json).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    expect((await atc("goto", "--context", ctx, "/app.html")).json).toMatchObject({ ok: false, error: "CONTEXT_CLOSED" });
  });
});
