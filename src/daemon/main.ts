/**
 * Daemon entrypoint: `node dist/daemon/main.js`.
 *
 * Logs are one JSON object per line in `paths.daemonLog` and only ever carry
 * metadata (method, outcome, timing); never page content or typed values.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolvePaths } from "../contracts/paths.js";
import type { Paths } from "../contracts/protocol.js";
import type { BrowserName } from "../contracts/types.js";
import { createDriver } from "../drivers/index.js";
import { ContextRegistry } from "./registry.js";
import { type RunningServer, startServer } from "./server.js";
import { DaemonService } from "./service.js";

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

function createLogger(paths: Paths): LogFn {
  return (event, fields = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields });
    try {
      appendFileSync(paths.daemonLog, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the daemon down.
    }
  };
}

function driverOptions(paths: Paths): { profilesDir: string; executablePath?: string } {
  const executablePath = process.env.TABCTX_CHROMIUM_PATH;
  return executablePath === undefined || executablePath === ""
    ? { profilesDir: paths.profiles }
    : { profilesDir: paths.profiles, executablePath };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = createLogger(paths);
  const registry = new ContextRegistry({ statePath: paths.state });
  const options = driverOptions(paths);
  const driverFactory = (browser: BrowserName) => createDriver(browser, options);
  const service = new DaemonService({ registry, driverFactory, paths });

  let server: RunningServer;
  try {
    server = await startServer(service, paths, { onRequest: (entry) => log("request", { ...entry }) });
  } catch (err) {
    log("start_failed", { message: errorMessage(err) });
    process.exitCode = 1;
    return;
  }
  log("started", { socket: paths.socket });

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("stopping", { reason });
    await service.closeAll();
    await server.close();
    log("stopped", { reason });
    process.exit(0);
  };

  service.onShutdown(() => void stop("shutdown"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  process.on("uncaughtException", (err) => {
    log("uncaught_exception", { message: errorMessage(err) });
    void stop("uncaught_exception");
  });
  process.on("unhandledRejection", (reason) => {
    log("unhandled_rejection", { message: errorMessage(reason) });
  });
}

await runDaemon();
