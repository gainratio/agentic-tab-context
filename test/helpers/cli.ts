/** Runs the real `atc` binary as a separate process and parses its one-line JSON output. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(ROOT, "bin", "atc.js");

export type Json = Record<string, unknown>;

export interface CliResult {
  code: number;
  json: Json;
  lines: number;
}

function parse(stdout: string, code: number): CliResult {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return { code, json: JSON.parse(lines.at(-1) ?? "{}") as Json, lines: lines.length };
}

export function cli(env: NodeJS.ProcessEnv): (...args: string[]) => Promise<CliResult> {
  return async (...args) => {
    try {
      const { stdout } = await run(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
      return parse(stdout, 0);
    } catch (error) {
      const failed = error as { stdout?: string; code?: number };
      return parse(failed.stdout ?? "", failed.code ?? -1);
    }
  };
}

/** Retry `probe` until `done` accepts its result, for state that settles asynchronously. */
export async function eventually<T>(probe: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await probe();
  }
  return value;
}
