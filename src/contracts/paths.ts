import { homedir } from "node:os";
import { join } from "node:path";
import type { Paths } from "./protocol.js";

/** Resolve every on-disk location from ABT_HOME or TABCTX_HOME (default ~/.tabctx). */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.ABT_HOME ?? env.TABCTX_HOME ?? join(homedir(), ".tabctx");
  return {
    home,
    socket: join(home, "daemon.sock"),
    state: join(home, "state.json"),
    profiles: join(home, "profiles"),
    screenshots: join(home, "screenshots"),
    daemonLog: join(home, "daemon.log"),
  };
}
