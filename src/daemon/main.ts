/**
 * Daemon entrypoint: `node dist/daemon/main.js`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolvePaths } from "../contracts/paths.js";
import type { Paths } from "../contracts/protocol.js";
import type { BrowserName } from "../contracts/types.js";
import { DEFAULT_BRIDGE_PORT, ExtensionBridge } from "../drivers/extension/bridge.js";
import { ExtensionDriver } from "../drivers/extension/driver.js";
import { createDriver, type DriverOptions } from "../drivers/index.js";
import { MacosTabDriver } from "../drivers/macos/driver.js";
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

function driverOptions(paths: Paths, extensionBridge: ExtensionBridge): DriverOptions {
  const executablePath = process.env.ABT_BROWSER_PATH ?? process.env.TABCTX_CHROMIUM_PATH;
  return executablePath === undefined || executablePath === ""
    ? { profilesDir: paths.profiles, extensionBridge }
    : { profilesDir: paths.profiles, executablePath, extensionBridge };
}

function bridgePortFromEnv(): number {
  const raw = process.env.ABT_BRIDGE_PORT ?? process.env.TABCTX_BRIDGE_PORT;
  if (raw === undefined || raw === "") return DEFAULT_BRIDGE_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : DEFAULT_BRIDGE_PORT;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runDaemon(): Promise<void> {
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = createLogger(paths);
  const registry = new ContextRegistry({ statePath: paths.state });
  const extensionBridge = new ExtensionBridge();
  await extensionBridge.start(bridgePortFromEnv());
  const extensionDriver = new ExtensionDriver(extensionBridge);
  const macosDriver = new MacosTabDriver();
  const options = driverOptions(paths, extensionBridge);
  const driverFactory = (browser: BrowserName) => createDriver(browser, options);
  const service = new DaemonService({
    registry,
    driverFactory,
    paths,
    extensionBridge,
    extensionDriver,
    macosDriver,
  });
  extensionBridge.onPinTab(async (tabId) => {
    const res = await service.handle({ method: "bind", params: { tab: tabId, use: true } });
    return res.ok && typeof res.context === "string" ? res.context : "";
  });

  let server: RunningServer;
  try {
    server = await startServer(service, paths, { onRequest: (entry) => log("request", { ...entry }) });
  } catch (err) {
    await extensionBridge.close();
    log("start_failed", { message: errorMessage(err) });
    process.exitCode = 1;
    return;
  }
  log("started", { socket: paths.socket, bridgePort: extensionBridge.port });

  let stopping = false;
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log("stopping", { reason });
    await service.closeAll();
    await extensionBridge.close();
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
