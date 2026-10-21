/**
 * The success criterion from SPEC.md, end to end: separate `tabctx` processes
 * drive one persistent Chromium tab through the real daemon. State set by one
 * command (typed text, navigation history) must still be there for the next.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../helpers/fixture-server.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(ROOT, "bin", "tabctx.js");
const DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

type Json = Record<string, unknown>;

let home: string;
let fixtures: { baseUrl: string; close(): Promise<void> };

function env(): NodeJS.ProcessEnv {
  const chromium = process.env.TABCTX_CHROMIUM_PATH ?? DEFAULT_CHROMIUM;
  return { ...process.env, TABCTX_HOME: home, TABCTX_HEADLESS: "1", TABCTX_CHROMIUM_PATH: chromium };
}

async function tabctx(...args: string[]): Promise<{ code: number; json: Json; lines: number }> {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args], { env: env() });
    return parse(stdout, 0);
  } catch (error) {
    const failed = error as { stdout?: string; code?: number };
    return parse(failed.stdout ?? "", failed.code ?? -1);
  }
}

function parse(stdout: string, code: number): { code: number; json: Json; lines: number } {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return { code, json: JSON.parse(lines.at(-1) ?? "{}") as Json, lines: lines.length };
}

beforeAll(async () => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
  home = mkdtempSync(join(tmpdir(), "tabctx-e2e-"));
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await tabctx("shutdown");
  await fixtures.close();
  rmSync(home, { recursive: true, force: true });
});

describe("tabctx end to end", () => {
  let ctx = "";

  it("opens a sticky context and makes it current", async () => {
    const opened = await tabctx("open", "chromium", "--use");
    expect(opened.code).toBe(0);
    expect(opened.lines).toBe(1);
    ctx = String(opened.json.context);
    expect(ctx).toMatch(/^ctx_[0-9a-f]{4,}$/);

    const current = await tabctx("current");
    expect(current.json).toMatchObject({ ok: true, context: ctx });
  });

  it("navigates absolute, then relative to the current page", async () => {
    const app = await tabctx("goto", `${fixtures.baseUrl}/app.html`);
    expect(app.json).toMatchObject({ ok: true, title: "Fixture App" });

    const pricing = await tabctx("goto", "/pricing.html");
    expect(pricing.json).toMatchObject({ ok: true, title: "Pricing" });

    const back = await tabctx("back");
    expect(back.json).toMatchObject({ ok: true, title: "Fixture App" });
  });

  it("keeps page state across separate CLI processes", async () => {
    expect((await tabctx("type", "--label", "Product Name", "--value", "Blue Shirt")).json).toMatchObject({
      ok: true,
      matched: 1,
    });
    expect((await tabctx("select", "--label", "Environment", "--value", "Stage")).code).toBe(0);
    expect((await tabctx("click", "--role", "button", "--name", "Save")).json).toMatchObject({ ok: true, matched: 1 });

    const inspected = await tabctx("inspect");
    expect(inspected.code).toBe(0);
    expect(String(inspected.json.aria)).toContain("Saved: Blue Shirt");
  });

  it("refuses to guess between ambiguous targets", async () => {
    const ambiguous = await tabctx("click", "--role", "button", "--name", "Delete");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.json).toMatchObject({ ok: false, error: "AMBIGUOUS_TARGET", matched: 2 });

    const explicit = await tabctx("click", "--role", "button", "--name", "Delete", "--nth", "1");
    expect(explicit.json).toMatchObject({ ok: true, matched: 1 });

    const missing = await tabctx("click", "--role", "button", "--name", "Nope");
    expect(missing.json).toMatchObject({ ok: false, error: "TARGET_NOT_FOUND" });
  });

  it("exposes console and network activity", async () => {
    await tabctx("click", "--role", "button", "--name", "Break");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const consoleOut = await tabctx("console");
    const texts = (consoleOut.json.entries as Json[]).map((entry) => String(entry.text));
    expect(texts.some((text) => text.includes("boom"))).toBe(true);

    const network = await tabctx("network");
    const missing = (network.json.entries as Json[]).find((entry) => String(entry.url).endsWith("/missing.json"));
    expect(missing).toMatchObject({ status: 404 });
  });

  it("writes a screenshot", async () => {
    const shot = await tabctx("screenshot");
    expect(shot.code).toBe(0);
    const path = String(shot.json.path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it("discovers open tabs via `tabs` and binds to a live tab via `bind`", async () => {
    const listed = await tabctx("tabs");
    expect(listed.code).toBe(0);
    const tabs = listed.json.tabs as Json[];
    expect(tabs.some((t) => String(t.url).endsWith("/app.html"))).toBe(true);

    const bound = await tabctx("bind", "--query", "Fixture App");
    expect(bound.code).toBe(0);
    expect(bound.json).toMatchObject({ ok: true, context: ctx, browser: "chromium", title: "Fixture App" });

    const doc = await tabctx("doctor");
    expect(doc.code).toBe(0);
    expect(doc.json).toMatchObject({ ok: true });
  });

  it("rejects unknown browsers and bad arguments with typed errors", async () => {
    expect((await tabctx("open", "opera")).json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect((await tabctx("click")).json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
  });

  it("closes the context and forgets it as current", async () => {
    expect((await tabctx("close", ctx)).json).toMatchObject({ ok: true, context: ctx });
    expect((await tabctx("current")).json).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    expect((await tabctx("goto", "--context", ctx, "/app.html")).json).toMatchObject({
      ok: false,
      error: "CONTEXT_CLOSED",
    });
  });
});
