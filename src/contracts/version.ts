/** Package version and daemon protocol version (single source of truth). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DAEMON_PROTOCOL_VERSION = 2;

const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
export const PACKAGE_VERSION: string = (JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version?: string }).version ?? "0.0.0";
