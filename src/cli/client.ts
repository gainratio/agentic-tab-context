/**
 * CLI side of the daemon protocol: one NDJSON request line out, one response
 * line back, over the Unix socket at `paths.socket`. Auto-starts the daemon
 * when nothing is listening (except for `shutdown`).
 */
import { readToken } from "../contracts/auth.js";
import { AtcError } from "../contracts/errors.js";
import type { Paths, Request, Response } from "../contracts/protocol.js";
import { DEFAULT_DAEMON_ENTRY, type SpawnDaemonOptions, type SpawnFn, type SpawnedProcess, spawnDaemon } from "../daemon/spawn.js";
import { NoDaemon, exchange } from "./exchange.js";

export { DEFAULT_DAEMON_ENTRY, type SpawnFn, type SpawnedProcess };

export interface ClientOptions extends SpawnDaemonOptions {
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_START_TIMEOUT_MS = 10_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
const PING_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingOnce(paths: Paths): Promise<boolean> {
  try {
    const response = await exchange(paths.socket, { method: "ping", params: {} }, PING_TIMEOUT_MS, readToken(paths));
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
    return await exchange(paths.socket, request, timeout, readToken(paths));
  } catch (error) {
    if (!(error instanceof NoDaemon)) throw error;
  }
  if (request.method === "shutdown") return { ok: true, running: false };
  await spawnDaemon(paths, options);
  await waitForDaemon(paths, options);
  try {
    return await exchange(paths.socket, request, timeout, readToken(paths));
  } catch (error) {
    throw asDaemonUnavailable(error);
  }
}
