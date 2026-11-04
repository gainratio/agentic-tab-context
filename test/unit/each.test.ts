import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { Paths, Request, Response } from "../../src/contracts/protocol.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

let home: string;
let paths: Paths;
let registry: ContextRegistry;
let service: DaemonService;
let driver: FakeDriver;

function call(request: unknown): Promise<Response> {
  return service.handle(request as Request);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atc-each-"));
  paths = resolvePaths({ ATC_HOME: home });
  registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0101, 0x0202, 0x0303]) });
  driver = new FakeDriver("chromium");
  service = new DaemonService({ registry, paths, env: {}, now: () => new Date("2026-01-01T00:00:00.000Z"), driverFactory: () => driver });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("--each actions", () => {
  it("returns an empty result set with no open contexts", async () => {
    expect(await call({ method: "click", params: { each: true, target: { kind: "role", role: "button" } } })).toEqual({ ok: true, results: [] });
  });

  it("runs one action against every open context and reports each result", async () => {
    const first = await call({ method: "open", params: { browser: "chromium", use: true } });
    const second = await call({ method: "open", params: { browser: "chromium" } });
    const response = await call({ method: "click", params: { each: true, target: { kind: "role", role: "button" } } });
    expect(response).toMatchObject({ ok: true });
    const results = (response as unknown as { results: Array<Record<string, unknown>> }).results;
    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.context).sort()).toEqual([String(first.context), String(second.context)].sort());
    expect(results.every((entry) => entry.ok === true && entry.matched === 1)).toBe(true);
  });

  it("does not pin each to the current context in request routing", () => {
    const routed = service.route({ method: "click", params: { each: true, target: { kind: "role", role: "button" } } });
    expect(routed.key).toBeNull();
  });

  it("reports a per-tab failure without hiding successes", async () => {
    await call({ method: "open", params: { browser: "chromium", use: true } });
    await call({ method: "open", params: { browser: "chromium" } });
    const sessions = registry.openSessions();
    driver.failNext("click", new Error("tab failed"));
    const response = await call({ method: "click", params: { each: true, target: { kind: "role", role: "button" } } });
    const results = (response as unknown as { results: Array<Record<string, unknown>> }).results;
    expect(results.some((entry) => entry.ok === false)).toBe(true);
    expect(results.some((entry) => entry.ok === true)).toBe(true);
    expect(sessions).toHaveLength(2);
  });
});
