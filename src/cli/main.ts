/**
 * abt / tabctx CLI entry: parse argv, send one request to the daemon (or run local
 * setup), print exactly one line of compact JSON on stdout, and return the exit code.
 */
import { isTabCtxError } from "../contracts/errors.js";
import { resolvePaths } from "../contracts/paths.js";
import type { ErrorResponse, Paths, Request, Response } from "../contracts/protocol.js";
import { parseArgs, USAGE } from "./args.js";
import { sendRequest } from "./client.js";
import { runSetup } from "./setup.js";

export type Transport = (request: Request, paths: Paths, env: NodeJS.ProcessEnv) => Promise<Response>;

export interface MainIo {
  stdout: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
}

const RESERVED_KEYS = new Set(["ok", "error", "message"]);

const defaultTransport: Transport = (request, paths, env) => sendRequest(request, paths, { env });

function errorResponse(error: unknown): ErrorResponse {
  if (isTabCtxError(error)) {
    const details = Object.fromEntries(Object.entries(error.details).filter(([key]) => !RESERVED_KEYS.has(key)));
    return { ok: false, error: error.code, message: error.message, ...details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: "INTERNAL", message };
}

function serialize(response: Response): string {
  try {
    return JSON.stringify(response);
  } catch (error) {
    return JSON.stringify(errorResponse(new Error(`unserializable output: ${String(error)}`)));
  }
}

function writeProcessStdout(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(line, () => resolve());
  });
}

async function run(argv: string[], env: NodeJS.ProcessEnv, transport: Transport): Promise<Response> {
  try {
    const parsed = parseArgs(argv);
    if ("help" in parsed) return { ok: true, usage: [...USAGE] };
    if ("setup" in parsed) return runSetup(env);
    return await transport(parsed, resolvePaths(env), env);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function main(argv: string[], io?: MainIo): Promise<number> {
  const env = io?.env ?? process.env;
  const response = await run(argv, env, io?.transport ?? defaultTransport);
  const line = `${serialize(response)}\n`;
  if (io === undefined) await writeProcessStdout(line);
  else io.stdout(line);
  return response.ok === true ? 0 : 1;
}
