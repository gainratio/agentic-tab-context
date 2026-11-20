/**
 * Shared detached daemon spawner used by both the CLI client and the browser
 * native-messaging host so opening Chrome or clicking the extension starts
 * the daemon automatically without requiring a terminal command first.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Paths } from "../contracts/protocol.js";

/** The subset of a spawned child the caller needs. */
export interface SpawnedProcess {
  unref(): void;
}

/** Same shape as `child_process.spawn`, so tests can substitute a fake. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export interface SpawnDaemonOptions {
  /** Absolute path of the compiled daemon entrypoint. */
  daemonEntry?: string;
  spawn?: SpawnFn;
  /** Environment handed to the daemon (it resolves ATC_HOME from it). */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_DAEMON_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));

function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(command, [...args], options);
  child.on("error", () => undefined);
  return child;
}

/** Spawn the background daemon detached from the caller's stdio. */
export async function spawnDaemon(paths: Paths, options: SpawnDaemonOptions = {}): Promise<void> {
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
