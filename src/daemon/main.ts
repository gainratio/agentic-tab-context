/**
 * Daemon entrypoint: `node dist/daemon/main.js`. Started on demand by the CLI.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolvePaths } from "../contracts/paths.js";
import type { Paths } from "../contracts/protocol.js";
import type { BrowserName } from "../contracts/types.js";
import { ExtensionBridge } from "../drivers/extension/bridge.js";
import { ExtensionDriver } from "../drivers/extension/driver.js";
import { createDriver } from "../drivers/index.js";
import { MacosTabDriver } from "../drivers/macos/driver.js";
import type { RunningServer } from "../transport/unix-server.js";
import { ContextRegistry } from "./registry.js";
import { startServer } from "./server.js";
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildService(paths: Paths, bridge: ExtensionBridge): DaemonService {
  const extensionDriver = new ExtensionDriver(bridge);
  const executablePath = process.env.ATC_CHROMIUM_PATH;
  const options = { profilesDir: paths.profiles, extensionDriver, ...(executablePath ? { executablePath } : {}) };
  const service = new DaemonService({
    registry: new ContextRegistry({ statePath: paths.state }),
    driverFactory: (browser: BrowserName) => createDriver(browser, options),
    paths,
    extensionBridge: bridge,
    extensionDriver,
    macosDriver: new MacosTabDriver(),
  });
  bridge.onPinTab((tabId) => bindFromPopup(service, tabId));
  return service;
}

/** The extension popup's "use this tab" button binds that tab and makes it current. */
async function bindFromPopup(service: DaemonService, tabId: string): Promise<string> {
  const res = await service.handle({ method: "bind", params: { tab: tabId, use: true } });
  if (!res.ok) throw new Error(res.message);
  return String(res.context);
}

function handleSignals(stop: (reason: string) => Promise<void>, log: LogFn): void {
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  process.on("uncaughtException", (err) => {
    log("uncaught_exception", { message: errorMessage(err) });
    void stop("uncaught_exception");
  });
  process.on("unhandledRejection", (reason) => log("unhandled_rejection", { message: errorMessage(reason) }));
}

function stopper(service: DaemonService, bridge: ExtensionBridge, server: RunningServer, log: LogFn): (reason: string) => Promise<void> {
  let stopping = false;
  return async (reason) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { reason });
    await service.closeAll();
    await Promise.all([bridge.close(), server.close()]);
    log("stopped", { reason });
    process.exit(0);
  };
}

async function serve(paths: Paths, service: DaemonService, bridge: ExtensionBridge, log: LogFn): Promise<void> {
  await bridge.start(paths.extensionSocket);
  const server = await startServer(service, paths, { onRequest: (entry) => log("request", { ...entry }) });
  const stop = stopper(service, bridge, server, log);
  service.onShutdown(() => void stop("shutdown"));
  handleSignals(stop, log);
  log("started", { socket: paths.socket, extensionSocket: paths.extensionSocket });
}

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = createLogger(paths);
  const bridge = new ExtensionBridge();
  try {
    await serve(paths, buildService(paths, bridge), bridge, log);
  } catch (err) {
    await bridge.close();
    log("start_failed", { message: errorMessage(err) });
    process.exitCode = 1;
  }
}

await runDaemon();
