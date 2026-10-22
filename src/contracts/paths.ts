/**
 * Filesystem layout under ATC_HOME (default: ~/.atc).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Paths } from "./protocol.js";

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configured = env.ATC_HOME?.trim() ?? "";
  const home = configured === "" ? join(homedir(), ".atc") : resolve(configured);
  return {
    home,
    socket: join(home, "daemon.sock"),
    extensionSocket: join(home, "extension.sock"),
    state: join(home, "state.json"),
    profiles: join(home, "profiles"),
    screenshots: join(home, "screenshots"),
    daemonLog: join(home, "daemon.log"),
    nativeHost: join(home, "native-host"),
  };
}
