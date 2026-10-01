import { describe, expect, it } from "vitest";
import { main, type Transport } from "../../src/cli/main.js";
import { TabCtxError } from "../../src/contracts/errors.js";
import type { Paths, Request, Response } from "../../src/contracts/protocol.js";

interface Captured {
  code: number;
  writes: string[];
  json: Record<string, unknown>;
  sent: Array<{ request: Request; paths: Paths }>;
}

async function runMain(argv: string[], respond: (request: Request) => Promise<Response> | Response): Promise<Captured> {
  const writes: string[] = [];
  const sent: Captured["sent"] = [];
  const transport: Transport = async (request, paths) => {
    sent.push({ request, paths });
    return respond(request);
  };
  const code = await main(argv, { stdout: (s) => writes.push(s), env: { TABCTX_HOME: "/tmp/tabctx-main-test" }, transport });
  expect(writes).toHaveLength(1);
  const line = writes[0] ?? "";
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
  return { code, writes, json: JSON.parse(line) as Record<string, unknown>, sent };
}

const unreachable = (): Response => {
  throw new Error("transport must not be called");
};

describe("main", () => {
  it("prints the daemon response as one compact JSON line and exits 0 on ok", async () => {
    const result = await runMain(["open", "chromium", "--use"], () => ({ ok: true, context: "ctx_7f21" }));
    expect(result.code).toBe(0);
    expect(result.writes[0]).toBe('{"ok":true,"context":"ctx_7f21"}\n');
    expect(result.sent[0]?.request).toStrictEqual({ method: "open", params: { browser: "chromium", use: true } });
  });

  it("resolves paths from the injected env", async () => {
    const result = await runMain(["list"], () => ({ ok: true, contexts: [], current: null }));
    expect(result.sent[0]?.paths.socket).toBe("/tmp/tabctx-main-test/daemon.sock");
  });

  it("exits 1 and passes daemon errors through", async () => {
    const error: Response = { ok: false, error: "AMBIGUOUS_TARGET", message: "2 elements match", matched: 2 };
    const result = await runMain(["click", "--role", "button", "--name", "Delete"], () => error);
    expect(result.code).toBe(1);
    expect(result.json).toStrictEqual(error);
  });

  it("keeps multi-line payloads on a single stdout line", async () => {
    const result = await runMain(["inspect"], () => ({ ok: true, url: "u", title: "t", aria: "- heading\n- button" }));
    expect(result.code).toBe(0);
    expect(result.json.aria).toBe("- heading\n- button");
  });

  it("prints local INVALID_ARGUMENT errors without contacting the daemon", async () => {
    const result = await runMain(["click"], unreachable);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(String(result.json.message)).toMatch(/target is required/);
    expect(result.sent).toHaveLength(0);
  });

  it("prints unknown commands as INVALID_ARGUMENT", async () => {
    const result = await runMain(["nope"], unreachable);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
  });

  it("spreads TabCtxError details but never lets them override ok/error/message", async () => {
    const result = await runMain(["list"], () => {
      throw new TabCtxError("DAEMON_UNAVAILABLE", "no daemon", { log: "/x/daemon.log", ok: true, error: "X" });
    });
    expect(result.code).toBe(1);
    expect(result.json).toStrictEqual({
      ok: false,
      error: "DAEMON_UNAVAILABLE",
      message: "no daemon",
      log: "/x/daemon.log",
    });
  });

  it("maps unexpected errors to INTERNAL", async () => {
    const result = await runMain(["list"], () => {
      throw new Error("kaboom");
    });
    expect(result.code).toBe(1);
    expect(result.json).toStrictEqual({ ok: false, error: "INTERNAL", message: "kaboom" });
  });

  it.each([["help"], ["--help"], ["-h"], ["goto", "--help"]])("prints usage JSON for %s", async (...argv) => {
    const result = await runMain(argv, unreachable);
    expect(result.code).toBe(0);
    expect(result.json.ok).toBe(true);
    const usage = result.json.usage as unknown[];
    expect(Array.isArray(usage)).toBe(true);
    expect(usage.every((line) => typeof line === "string")).toBe(true);
    for (const command of ["open", "goto", "click", "type", "select", "console", "network", "shutdown"]) {
      expect(usage.some((line) => String(line).startsWith(`tabctx ${command}`) || String(line).includes(` ${command} `))).toBe(
        true,
      );
    }
    expect(result.sent).toHaveLength(0);
  });
});
