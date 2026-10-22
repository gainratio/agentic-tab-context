/**
 * One NDJSON request/response exchange with the daemon over its Unix socket.
 */
import { createConnection, type Socket } from "node:net";
import { ERROR_CODES, AtcError } from "../contracts/errors.js";
import type { Request, RequestEnvelope, Response } from "../contracts/protocol.js";
import { readLines, writeLine } from "../transport/lines.js";

/** Raised when nothing is listening on the socket yet. */
export class NoDaemon extends Error {}

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
let nextId = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is Response {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return (
    value.ok === false &&
    typeof value.message === "string" &&
    (ERROR_CODES as readonly unknown[]).includes(value.error)
  );
}

function decodeLine(line: string, id: number): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new AtcError("INTERNAL", "daemon sent a response that is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.id !== id || !isResponse(parsed.response)) {
    throw new AtcError("INTERNAL", "daemon sent a malformed or mismatched response envelope");
  }
  return parsed.response;
}

function connectError(error: NodeJS.ErrnoException, connected: boolean): Error {
  if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) return new NoDaemon(error.code);
  return new AtcError("DAEMON_UNAVAILABLE", `daemon connection failed: ${error.code ?? error.message}`);
}

/** Settles one request at most once, always tearing down the socket and timer. */
class Exchange {
  connected = false;
  private settled = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly resolve: (response: Response) => void,
    private readonly reject: (error: unknown) => void,
    timeout: { ms: number; method: string },
  ) {
    const message = `daemon did not answer "${timeout.method}" within ${timeout.ms} ms`;
    this.timer = setTimeout(() => this.fail(new AtcError("TIMEOUT", message, { timeoutMs: timeout.ms })), timeout.ms);
  }

  succeed(line: string, id: number): void {
    let response: Response;
    try {
      response = decodeLine(line, id);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.finish(() => this.resolve(response));
  }

  fail(error: unknown): void {
    this.finish(() => this.reject(error));
  }

  private finish(outcome: () => void): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.socket.destroy();
    outcome();
  }
}

/** Send one envelope and resolve with the decoded response line. */
export function exchange(socketPath: string, request: Request, timeoutMs: number): Promise<Response> {
  const id = nextId++;
  return new Promise<Response>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const ex = new Exchange(socket, resolve, reject, { ms: timeoutMs, method: request.method });
    socket.on("connect", () => {
      ex.connected = true;
      writeLine(socket, { id, request } satisfies RequestEnvelope);
    });
    readLines(socket, MAX_RESPONSE_BYTES, {
      onLine: (line) => ex.succeed(line, id),
      onOverflow: () => ex.fail(new AtcError("INTERNAL", "daemon response exceeded the size limit")),
    });
    socket.on("error", (error: NodeJS.ErrnoException) => ex.fail(connectError(error, ex.connected)));
    socket.on("close", () => ex.fail(new AtcError("DAEMON_UNAVAILABLE", "daemon closed the connection without responding")));
  });
}
