/**
 * CLI side of the daemon protocol: one NDJSON request line out, one response
 * line back, over the Unix socket at `paths.socket`. Auto-starts the daemon
 * when nothing is listening (except for `shutdown`).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { ERROR_CODES, TabCtxError } from "../contracts/errors.js";
import type { Paths, Request, RequestEnvelope, Response } from "../contracts/protocol.js";

/** The subset of a spawned child the client needs. */
export interface SpawnedProcess {
  unref(): void;
}

/** Same shape as `child_process.spawn`, so tests can substitute a fake. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface ClientOptions {
  /** Absolute path of the compiled daemon entrypoint. */
  daemonEntry?: string;
  spawn?: SpawnFn;
  /** Environment handed to the daemon (it resolves TABCTX_HOME from it). */
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_START_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
const PING_TIMEOUT_MS = 2_000;

export const DEFAULT_DAEMON_ENTRY = fileURLToPath(new URL("../daemon/main.js", import.meta.url));

/** Raised internally when nothing is listening on the socket yet. */
class NoDaemon extends Error {}

let nextId = 1;

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(command, [...args], options);
  // A spawn failure surfaces later as DAEMON_UNAVAILABLE; never crash the CLI on it.
  child.on("error", () => undefined);
  return child;
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is Response {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return (
    value.ok === false &&
    typeof value.message === "string" &&
    (ERROR_CODES as readonly unknown[]).includes(value.error)
  );
}

function decodeLine(line: string, id: number): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new TabCtxError("INTERNAL", "daemon sent a response that is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.id !== id || !isResponse(parsed.response)) {
    throw new TabCtxError("INTERNAL", "daemon sent a malformed or mismatched response envelope");
  }
  return parsed.response;
}

// ---------------------------------------------------------------------------
// One request/response exchange
// ---------------------------------------------------------------------------

function connectError(error: NodeJS.ErrnoException, connected: boolean): Error {
  if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) return new NoDaemon(error.code);
  return new TabCtxError("DAEMON_UNAVAILABLE", `daemon connection failed: ${error.code ?? error.message}`);
}

/** Send one envelope and resolve with the decoded response line. */
export function exchange(socketPath: string, request: Request, timeoutMs: number): Promise<Response> {
  const id = nextId++;
  const envelope: RequestEnvelope = { id, request };
  return new Promise<Response>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let connected = false;
    let buffer = "";
    let settled = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      outcome();
    };
    const timer = setTimeout(() => {
      const message = `daemon did not answer "${request.method}" within ${timeoutMs} ms`;
      finish(() => reject(new TabCtxError("TIMEOUT", message, { timeoutMs })));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(envelope)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(decodeLine(line, id));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(connectError(error, connected))));
    socket.on("close", () => {
      const message = "daemon closed the connection without responding";
      finish(() => reject(new TabCtxError("DAEMON_UNAVAILABLE", message)));
    });
  });
}

// ---------------------------------------------------------------------------
// Auto-start
// ---------------------------------------------------------------------------

async function startDaemon(paths: Paths, options: ClientOptions): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const logFd = openSync(paths.daemonLog, "a", 0o600);
  try {
    const run = options.spawn ?? defaultSpawn;
    const child = run(process.execPath, [options.daemonEntry ?? DEFAULT_DAEMON_ENTRY], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: options.env ?? process.env,
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingOnce(paths: Paths): Promise<boolean> {
  try {
    const response = await exchange(paths.socket, { method: "ping", params: {} }, PING_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(paths: Paths, options: ClientOptions): Promise<void> {
  const startTimeout = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const deadline = Date.now() + startTimeout;
  while (Date.now() < deadline) {
    if (await pingOnce(paths)) return;
    await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  throw new TabCtxError(
    "DAEMON_UNAVAILABLE",
    `daemon did not become ready within ${startTimeout} ms; see ${paths.daemonLog}`,
    { log: paths.daemonLog },
  );
}

function asDaemonUnavailable(error: unknown): unknown {
  if (error instanceof NoDaemon) {
    return new TabCtxError("DAEMON_UNAVAILABLE", "daemon is not reachable after start-up");
  }
  return error;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Send one request to the daemon, starting it first if necessary. */
export async function sendRequest(request: Request, paths: Paths, options: ClientOptions = {}): Promise<Response> {
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  try {
    return await exchange(paths.socket, request, timeout);
  } catch (error) {
    if (!(error instanceof NoDaemon)) throw error;
  }
  if (request.method === "shutdown") return { ok: true, running: false };
  await startDaemon(paths, options);
  await waitForDaemon(paths, options);
  try {
    return await exchange(paths.socket, request, timeout);
  } catch (error) {
    throw asDaemonUnavailable(error);
  }
}
