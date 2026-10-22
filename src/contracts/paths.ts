/**
 * Filesystem layout under ATC_HOME / ABT_HOME / TABCTX_HOME (default: ~/.tabctx).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Paths } from "./protocol.js";

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const configured = env.ATC_HOME?.trim() ?? env.ABT_HOME?.trim() ?? env.TABCTX_HOME?.trim();
  const home =
    configured !== undefined && configured.length > 0 ? resolve(configured) : join(homedir(), ".tabctx");
  return {
    home,
    socket: join(home, "daemon.sock"),
    state: join(home, "state.json"),
    profiles: join(home, "profiles"),
    screenshots: join(home, "screenshots"),
    daemonLog: join(home, "daemon.log"),
  };
}
