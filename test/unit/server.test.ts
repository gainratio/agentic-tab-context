import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { Paths, Request, ResponseEnvelope } from "../../src/contracts/protocol.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { type RequestLogEntry, type RunningServer, KeyedQueue, assertSocketPathFits, startServer } from "../../src/daemon/server.js";
import { DaemonService } from "../../src/daemon/service.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

let home: string;
let paths: Paths;
let driver: FakeDriver;
let service: DaemonService;
let server: RunningServer | undefined;
let logs: RequestLogEntry[];

beforeEach(async () => {
  // Unix socket paths are limited to ~104 bytes, so keep ATC_HOME short.
  home = await mkdtemp(join(tmpdir(), "tcx-"));
  paths = resolvePaths({ ATC_HOME: join(home, "h") });
  driver = new FakeDriver("chromium");
  const registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0001, 0x0002, 0x0003]) });
  service = new DaemonService({ registry, paths, env: {}, driverFactory: () => driver });
  logs = [];
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(home, { recursive: true, force: true });
});

async function start(): Promise<RunningServer> {
  server = await startServer(service, paths, { onRequest: (entry) => logs.push(entry) });
  return server;
}

/** Sends raw text on a fresh connection and collects `count` response lines. */
function sendRaw(text: string, count = 1): Promise<ResponseEnvelope[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket);
    const lines: ResponseEnvelope[] = [];
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        lines.push(JSON.parse(buffer.slice(0, nl)) as ResponseEnvelope);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      if (lines.length >= count) {
        socket.destroy();
        resolve(lines);
      }
    });
    socket.on("error", reject);
  });
}

async function send(id: number, request: Request): Promise<ResponseEnvelope> {
  const [reply] = await sendRaw(`${JSON.stringify({ id, request })}\n`);
  if (reply === undefined) throw new Error("no reply");
  return reply;
}

async function openContext(id: number): Promise<string> {
  const reply = await send(id, { method: "open", params: { browser: "chromium" } });
  if (!reply.response.ok) throw new Error(reply.response.message);
  return String(reply.response.context);
}

describe("startServer", () => {
  it("round-trips requests over the Unix socket with restrictive permissions", async () => {
    await start();
    expect(await send(7, { method: "ping", params: {} })).toEqual({ id: 7, response: { ok: true, pid: process.pid } });
    expect((await stat(paths.socket)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
    expect(logs).toEqual([{ id: 7, method: "ping", ok: true, ms: expect.any(Number) as number }]);
  });

  it("answers several lines on one connection, matching ids", async () => {
    await start();
    const text = `${JSON.stringify({ id: 1, request: { method: "ping", params: {} } })}\n${JSON.stringify({
      id: 2,
      request: { method: "current", params: {} },
    })}\n`;
    const replies = await sendRaw(text, 2);
    const byId = new Map(replies.map((r) => [r.id, r.response]));
    expect(byId.get(1)).toMatchObject({ ok: true });
    expect(byId.get(2)).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
    expect(logs.find((l) => l.id === 2)).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
  });

  it("answers a malformed line with id -1 and INVALID_ARGUMENT, and keeps serving", async () => {
    await start();
    const [bad] = await sendRaw("{this is not json\n");
    expect(bad).toMatchObject({ id: -1, response: { ok: false, error: "INVALID_ARGUMENT" } });
    const [noMethod] = await sendRaw(`${JSON.stringify({ id: 4, request: {} })}\n`);
    expect(noMethod).toMatchObject({ id: 4, response: { ok: false, error: "INVALID_ARGUMENT" } });
    const [badId] = await sendRaw(`${JSON.stringify({ id: "x", request: { method: "ping", params: {} } })}\n`);
    expect(badId).toMatchObject({ id: -1, response: { error: "INVALID_ARGUMENT" } });
    expect(await send(5, { method: "ping", params: {} })).toMatchObject({ id: 5, response: { ok: true } });
  });

  it.each([[], null, 42, "invalid"].map((params) => ({ params })))("rejects malformed close params before routing to the current context: $params", async ({ params }) => {
    await start();
    const context = await openContext(1);
    const [reply] = await sendRaw(`${JSON.stringify({ id: 2, request: { method: "close", params } })}\n`);
    expect(reply).toMatchObject({ id: 2, response: { ok: false, error: "INVALID_ARGUMENT" } });
    expect(driver.calls.filter((call) => call.method === "close")).toHaveLength(0);
    expect(await send(3, { method: "inspect", params: { context } })).toMatchObject({ response: { ok: true, context } });
  });

  it("removes a stale socket file nobody answers on", async () => {
    await mkdir(paths.home, { recursive: true });
    // Simulate a crashed daemon: a process listens, then dies by SIGKILL, leaving the file.
    const script = `require("node:net").createServer().listen(${JSON.stringify(paths.socket)}, () => console.log("up"))`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect((await lstat(paths.socket)).isSocket()).toBe(true);
    await start();
    expect(await send(1, { method: "ping", params: {} })).toMatchObject({ response: { ok: true } });
  });

  it("refuses to replace a non-socket file at the socket path", async () => {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.socket, "not a socket");
    await expect(startServer(service, paths)).rejects.toThrow(/not a socket/);
  });

  it("refuses to start when a live daemon answers on the socket", async () => {
    await start();
    await expect(startServer(service, paths)).rejects.toThrow(/already listening/);
    expect(await send(1, { method: "ping", params: {} })).toMatchObject({ response: { ok: true } });
  });

  it("refuses socket paths the kernel would truncate", async () => {
    const longHome = join(home, "x".repeat(120));
    await expect(startServer(service, resolvePaths({ ATC_HOME: longHome }))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(() => assertSocketPathFits(`/${"a".repeat(106)}`, "linux")).not.toThrow();
    expect(() => assertSocketPathFits(`/${"a".repeat(107)}`, "linux")).toThrow();
    expect(() => assertSocketPathFits(`/${"a".repeat(103)}`, "darwin")).toThrow();
  });

  it("close() stops listening and removes the socket file", async () => {
    const running = await start();
    await running.close();
    server = undefined;
    await expect(lstat(paths.socket)).rejects.toThrow();
  });

  it("serializes requests on one context but runs different contexts concurrently", async () => {
    await start();
    const a = await openContext(1);
    const b = await openContext(2);
    driver.delayMs = 80;
    const [sa, sb] = driver.sessionIds();

    await Promise.all([
      send(10, { method: "reload", params: { context: a } }),
      send(11, { method: "reload", params: {} }), // implicit current === a
      send(12, { method: "inspect", params: { context: a } }),
    ]);
    expect(driver.maxActive.get(sa ?? "")).toBe(1);

    driver.maxActiveOverall = 0;
    await Promise.all([
      send(20, { method: "reload", params: { context: a } }),
      send(21, { method: "reload", params: { context: b } }),
    ]);
    expect(driver.maxActive.get(sb ?? "")).toBe(1);
    expect(driver.maxActiveOverall).toBe(2);
  });

  it("shutdown delivers its reply even when the hook closes the server", async () => {
    const running = await start();
    await openContext(1);
    let closed: Promise<void> | undefined;
    service.onShutdown(() => {
      closed = running.close();
    });
    const reply = await send(9, { method: "shutdown", params: {} });
    expect(reply).toEqual({ id: 9, response: { ok: true } });
    expect(driver.calls.filter((c) => c.method === "close")).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBeDefined();
    await closed;
    server = undefined;
    await expect(lstat(paths.socket)).rejects.toThrow();
  });
});

describe("KeyedQueue", () => {
  it("keeps running a key's queue after a task rejects", async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const first = queue.run("k", async () => {
      order.push("first");
      throw new Error("boom");
    });
    const second = queue.run("k", async () => {
      order.push("second");
      return 2;
    });
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first", "second"]);
  });

  it("does not queue null keys", async () => {
    const queue = new KeyedQueue();
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    };
    await Promise.all([queue.run(null, task), queue.run(null, task)]);
    expect(peak).toBe(2);
  });
});
