/**
 * CLI side of the daemon protocol: one NDJSON request line out, one response
 * line back, over the Unix socket at `paths.socket`. Auto-starts the daemon
 * when nothing is listening (except for `shutdown`).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AtcError } from "../contracts/errors.js";
import type { Paths, Request, Response } from "../contracts/protocol.js";
import { NoDaemon, exchange } from "./exchange.js";

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
  /** Environment handed to the daemon (it resolves ATC_HOME from it). */
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

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(command, [...args], options);
  // A spawn failure surfaces later as DAEMON_UNAVAILABLE; never crash the CLI on it.
  child.on("error", () => undefined);
  return child;
}

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
  throw new AtcError(
    "DAEMON_UNAVAILABLE",
    `daemon did not become ready within ${startTimeout} ms; see ${paths.daemonLog}`,
    { log: paths.daemonLog },
  );
}

function asDaemonUnavailable(error: unknown): unknown {
  if (error instanceof NoDaemon) {
    return new AtcError("DAEMON_UNAVAILABLE", "daemon is not reachable after start-up");
  }
  return error;
}

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
