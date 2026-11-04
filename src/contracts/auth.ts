import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Paths } from "./protocol.js";

/** Read the per-install socket token, if the daemon has created one. */
export function readToken(paths: Paths): string | undefined {
  try {
    const token = readFileSync(paths.token, "utf8").trim();
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

/** Create the token on first daemon start; owner-only. */
export function ensureToken(paths: Paths): string {
  const existing = readToken(paths);
  if (existing !== undefined) return existing;
  mkdirSync(dirname(paths.token), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(paths.token, `${token}\n`, { mode: 0o600 });
  chmodSync(paths.token, 0o600);
  return token;
}

export function tokenMatches(expected: string | undefined, actual: unknown): boolean {
  return expected === undefined || (typeof actual === "string" && actual === expected);
}
