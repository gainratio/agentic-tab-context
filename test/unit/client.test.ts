import type { SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { link, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendRequest, type SpawnFn } from "../../src/cli/client.js";
import { AtcError } from "../../src/contracts/errors.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { Paths, RequestEnvelope, Response } from "../../src/contracts/protocol.js";

type Handler = (envelope: RequestEnvelope, socket: Socket) => void;

let root: string;
let paths: Paths;
const servers: Server[] = [];

function reply(socket: Socket, id: number, response: Response): void {
  socket.write(`${JSON.stringify({ id, response })}\n`);
}

/** Default fake daemon: answers ping with a pid and echoes everything else. */
const echo: Handler = (envelope, socket) => {
  if (envelope.request.method === "ping") reply(socket, envelope.id, { ok: true, pid: 4242 });
  else reply(socket, envelope.id, { ok: true, echo: envelope.request });
};

async function startServer(handler: Handler = echo): Promise<Server> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handler(JSON.parse(buffer.slice(0, newline)) as RequestEnvelope, socket);
      buffer = buffer.slice(newline + 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
  return server;
}

async function rejection(promise: Promise<unknown>): Promise<AtcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AtcError);
    return error as AtcError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atc-client-"));
  paths = resolvePaths({ ATC_HOME: join(root, "home") });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(root, { recursive: true, force: true });
});

describe("sendRequest against a running daemon", () => {
  it("round-trips one request and one response line", async () => {
    await startServer();
    const response = await sendRequest({ method: "goto", params: { url: "/x" } }, paths, {
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    expect(response).toStrictEqual({ ok: true, echo: { method: "goto", params: { url: "/x" } } });
  });

  it("passes daemon error responses through untouched", async () => {
    await startServer((envelope, socket) =>
      reply(socket, envelope.id, { ok: false, error: "AMBIGUOUS_TARGET", message: "2 matches", matched: 2 }),
    );
    const response = await sendRequest({ method: "click", params: { target: { kind: "text", text: "a" } } }, paths);
    expect(response).toStrictEqual({ ok: false, error: "AMBIGUOUS_TARGET", message: "2 matches", matched: 2 });
  });

  it("times out with TIMEOUT when the daemon never answers", async () => {
    await startServer(() => undefined);
    const error = await rejection(sendRequest({ method: "list", params: {} }, paths, { requestTimeoutMs: 150 }));
    expect(error.code).toBe("TIMEOUT");
  });

  it("reports DAEMON_UNAVAILABLE when the daemon hangs up without answering", async () => {
    await startServer((_envelope, socket) => socket.end());
    const error = await rejection(sendRequest({ method: "list", params: {} }, paths));
    expect(error.code).toBe("DAEMON_UNAVAILABLE");
  });

  it("reports INTERNAL for a malformed or mismatched response", async () => {
    await startServer((envelope, socket) => reply(socket, envelope.id + 1, { ok: true }));
    expect((await rejection(sendRequest({ method: "list", params: {} }, paths))).code).toBe("INTERNAL");
  });

  it("reports INTERNAL for a non-JSON response", async () => {
    await startServer((_envelope, socket) => socket.write("not json\n"));
    expect((await rejection(sendRequest({ method: "list", params: {} }, paths))).code).toBe("INTERNAL");
  });

  it("forwards shutdown to a running daemon", async () => {
    await startServer((envelope, socket) => reply(socket, envelope.id, { ok: true, running: true }));
    expect(await sendRequest({ method: "shutdown", params: {} }, paths)).toStrictEqual({ ok: true, running: true });
  });
});

describe("sendRequest auto-start", () => {
  it("spawns the daemon detached with logs appended, waits for ping, then sends the request", async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    let unrefs = 0;
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      // Simulate a daemon that takes a moment to bind its socket.
      setTimeout(() => void startServer(), 250);
      return { unref: () => void (unrefs += 1) };
    };
    const env = { ATC_HOME: paths.home, MARKER: "1" };

    const response = await sendRequest({ method: "list", params: {} }, paths, {
      spawn,
      daemonEntry: "/fake/daemon/main.js",
      env,
    });

    expect(response).toStrictEqual({ ok: true, echo: { method: "list", params: {} } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.command).toBe(process.execPath);
    expect(call?.args).toStrictEqual(["/fake/daemon/main.js"]);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.env).toBe(env);
    const stdio = call?.options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(unrefs).toBe(1);
    expect(statSync(paths.home).mode & 0o777).toBe(0o700);
    expect(existsSync(paths.daemonLog)).toBe(true);
  });

  it("defaults the daemon entry to dist/daemon/main.js next to the CLI", async () => {
    let entry = "";
    const spawn: SpawnFn = (_command, args) => {
      entry = args[0] ?? "";
      setTimeout(() => void startServer(), 10);
      return { unref: () => undefined };
    };
    await sendRequest({ method: "list", params: {} }, paths, { spawn });
    expect(entry).toMatch(/[/\\]daemon[/\\]main\.js$/);
  });

  it("fails with DAEMON_UNAVAILABLE when the spawned daemon never comes up", async () => {
    const spawn: SpawnFn = () => ({ unref: () => undefined });
    const started = Date.now();
    const error = await rejection(
      sendRequest({ method: "list", params: {} }, paths, { spawn, startTimeoutMs: 400, pollIntervalMs: 50 }),
    );
    expect(error.code).toBe("DAEMON_UNAVAILABLE");
    expect(error.message).toContain(paths.daemonLog);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("returns running:false for shutdown without starting a daemon", async () => {
    let spawned = false;
    const spawn: SpawnFn = () => {
      spawned = true;
      return { unref: () => undefined };
    };
    const response = await sendRequest({ method: "shutdown", params: {} }, paths, { spawn });
    expect(response).toStrictEqual({ ok: true, running: false });
    expect(spawned).toBe(false);
    expect(existsSync(paths.home)).toBe(false);
  });

  it("treats a stale socket file (ECONNREFUSED) as no daemon", async () => {
    const server = await startServer();
    const keep = join(root, "stale.sock");
    await link(paths.socket, keep);
    await new Promise((resolve) => server.close(resolve));
    await rename(keep, paths.socket);
    expect(existsSync(paths.socket)).toBe(true);
    const response = await sendRequest({ method: "shutdown", params: {} }, paths);
    expect(response).toStrictEqual({ ok: true, running: false });
  });
});
