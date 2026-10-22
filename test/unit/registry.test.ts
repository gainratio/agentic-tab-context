import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { sequenceRandom } from "../helpers/fake-driver.js";

let home: string;
let statePath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atc-registry-"));
  statePath = join(home, "state.json");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const base = { browser: "chromium" as const, profile: "default" };

function session(n: number): { sessionId: string } {
  return { sessionId: `s${n}` };
}

async function readState(): Promise<{ current: string | null; contexts: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(statePath, "utf8")) as { current: string | null; contexts: Array<Record<string, unknown>> };
}

describe("ContextRegistry ids", () => {
  it("formats ids as ctx_ + 4 lowercase hex chars", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x7f21, 0xabcd]) });
    expect(registry.create({ ...base, createdAt: "2026-01-01T00:00:00.000Z" }, session(1)).id).toBe("ctx_7f21");
    expect(registry.create({ ...base, createdAt: "2026-01-01T00:00:00.000Z" }, session(2)).id).toBe("ctx_abcd");
  });

  it("uses crypto random by default and still matches the format", () => {
    const registry = new ContextRegistry({ statePath });
    const ids = Array.from({ length: 20 }, (_, i) => registry.create({ ...base, createdAt: "t" }, session(i)).id);
    for (const id of ids) expect(id).toMatch(/^ctx_[0-9a-f]{4}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("retries when the random source collides, and never reuses ids", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x0001, 0x0001, 0x0001, 0x0002]) });
    const a = registry.create({ ...base, createdAt: "t" }, session(1));
    const b = registry.create({ ...base, createdAt: "t" }, session(2));
    expect([a.id, b.id]).toEqual(["ctx_0001", "ctx_0002"]);
  });

  it("never reuses ids of persisted closed contexts after reload", () => {
    const first = new ContextRegistry({ statePath, random: sequenceRandom([0x00aa]) });
    first.create({ ...base, createdAt: "t" }, session(1));
    const second = new ContextRegistry({ statePath, random: sequenceRandom([0x00aa, 0x00aa, 0x00bb]) });
    expect(second.create({ ...base, createdAt: "t" }, session(2)).id).toBe("ctx_00bb");
  });

  it("fails with INTERNAL when no unique id can be found", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x1234]) });
    registry.create({ ...base, createdAt: "t" }, session(1));
    expect(() => registry.create({ ...base, createdAt: "t" }, session(2))).toThrow(
      expect.objectContaining({ code: "INTERNAL" }),
    );
  });
});

describe("ContextRegistry state", () => {
  it("persists public fields only after every mutation, atomically", async () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x0a0a]) });
    const ctx = registry.create({ ...base, createdAt: "2026-01-01T00:00:00.000Z" }, session(1));
    registry.setCurrent(ctx.id);
    registry.updateLocation(ctx.id, { url: "https://example.com/", title: "Example" });

    const state = await readState();
    expect(state.current).toBe(ctx.id);
    expect(state.contexts).toEqual([
      {
        id: "ctx_0a0a",
        browser: "chromium",
        status: "open",
        profile: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        url: "https://example.com/",
        title: "Example",
      },
    ]);
    expect(JSON.stringify(state)).not.toContain("sessionId");
    expect((await readdir(home)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reload marks every context closed and clears current", async () => {
    const first = new ContextRegistry({ statePath, random: sequenceRandom([0x0001, 0x0002]) });
    const a = first.create({ ...base, createdAt: "t1" }, session(1));
    first.create({ ...base, createdAt: "t2" }, session(2));
    first.setCurrent(a.id);

    const second = new ContextRegistry({ statePath });
    expect(second.current).toBeNull();
    expect(second.list().map((c) => [c.id, c.status])).toEqual([
      ["ctx_0001", "closed"],
      ["ctx_0002", "closed"],
    ]);
    expect(second.session(a.id)).toBeUndefined();
    expect(second.openSessions()).toEqual([]);
    expect((await readState()).current).toBeNull();
  });

  it("ignores a corrupt or malformed state file", async () => {
    await writeFile(statePath, "{not json");
    expect(new ContextRegistry({ statePath }).list()).toEqual([]);
    await writeFile(statePath, JSON.stringify({ current: "ctx_0001", contexts: [{ id: "bogus" }, 7] }));
    const registry = new ContextRegistry({ statePath });
    expect(registry.list()).toEqual([]);
    expect(registry.current).toBeNull();
  });

  it("lists by createdAt then id", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x000c, 0x000b, 0x000a]) });
    registry.create({ ...base, createdAt: "2026-01-02T00:00:00.000Z" }, session(1)); // ctx_000c
    registry.create({ ...base, createdAt: "2026-01-01T00:00:00.000Z" }, session(2)); // ctx_000b
    registry.create({ ...base, createdAt: "2026-01-02T00:00:00.000Z" }, session(3)); // ctx_000a
    expect(registry.list().map((c) => c.id)).toEqual(["ctx_000b", "ctx_000a", "ctx_000c"]);
  });

  it("markClosed drops the session, clears current and is idempotent", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x0001]) });
    const ctx = registry.create({ ...base, createdAt: "t" }, session(1));
    registry.setCurrent(ctx.id);
    expect(registry.markClosed(ctx.id)).toEqual(session(1));
    expect(registry.current).toBeNull();
    expect(registry.get(ctx.id)?.status).toBe("closed");
    expect(registry.markClosed(ctx.id)).toBeUndefined();
    expect(registry.markClosed("ctx_ffff")).toBeUndefined();
  });

  it("refuses to make a closed or unknown context current", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x0001]) });
    const ctx = registry.create({ ...base, createdAt: "t" }, session(1));
    registry.markClosed(ctx.id);
    expect(() => registry.setCurrent(ctx.id)).toThrow();
    expect(() => registry.setCurrent("ctx_9999")).toThrow();
  });

  it("returns copies so callers cannot mutate registry state", () => {
    const registry = new ContextRegistry({ statePath, random: sequenceRandom([0x0001]) });
    const ctx = registry.create({ ...base, createdAt: "t" }, session(1));
    const copy = registry.get(ctx.id);
    if (copy === undefined) throw new Error("missing");
    copy.status = "closed";
    expect(registry.get(ctx.id)?.status).toBe("open");
  });
});
