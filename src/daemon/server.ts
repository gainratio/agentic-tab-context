/**
 * NDJSON-over-Unix-socket front end for DaemonService.
 *
 * One `RequestEnvelope` per line in, one `ResponseEnvelope` per line out.
 * Requests that target the same context run strictly one after another (a
 * per-context promise chain) so two commands never interleave on one tab;
 * requests for different contexts, or for no context, run concurrently.
 */
import type { Socket } from "node:net";
import type { Paths, Request, RequestEnvelope, Response, ResponseEnvelope } from "../contracts/protocol.js";
import { readLines, writeLine } from "../transport/lines.js";
import { type RunningServer, listenOwnerOnly } from "../transport/unix-server.js";
import { isRecord } from "./params.js";
import type { DaemonService } from "./service.js";

export { assertSocketPathFits, type RunningServer } from "../transport/unix-server.js";

/** Metadata about one handled request. Never contains params or page content. */
export interface RequestLogEntry {
  id: number;
  method: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface ServerOptions {
  onRequest?: (entry: RequestLogEntry) => void;
}

const MAX_LINE_BYTES = 1024 * 1024;

export function startServer(service: DaemonService, paths: Paths, options: ServerOptions = {}): Promise<RunningServer> {
  const queue = new KeyedQueue();
  return listenOwnerOnly(paths.socket, (socket) => serveConnection(socket, service, queue, options));
}

function serveConnection(socket: Socket, service: DaemonService, queue: KeyedQueue, options: ServerOptions): void {
  readLines(socket, MAX_LINE_BYTES, {
    onLine: (line) => void dispatchLine(line, service, queue, options).then((envelope) => writeLine(socket, envelope)),
    onOverflow: () => {
      writeLine(socket, invalidEnvelope(-1, "request line too long"));
      socket.end();
    },
  });
}

async function dispatchLine(
  line: string,
  service: DaemonService,
  queue: KeyedQueue,
  options: ServerOptions,
): Promise<ResponseEnvelope> {
  try {
    return await dispatchParsed(parseEnvelope(line), service, queue, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: -1, response: { ok: false, error: "INTERNAL", message } };
  }
}

async function dispatchParsed(
  parsed: RequestEnvelope | ResponseEnvelope,
  service: DaemonService,
  queue: KeyedQueue,
  options: ServerOptions,
): Promise<ResponseEnvelope> {
  if ("response" in parsed) return parsed;
  const started = Date.now();
  const { key, request } = service.route(parsed.request);
  const response = await queue.run(key, () => service.handle(request));
  options.onRequest?.(logEntry(parsed, response, Date.now() - started));
  return { id: parsed.id, response };
}

function parseEnvelope(line: string): RequestEnvelope | ResponseEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return invalidEnvelope(-1, "malformed JSON request line");
  }
  if (!isRecord(value)) return invalidEnvelope(-1, "request envelope must be a JSON object");
  const id = value.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    return invalidEnvelope(-1, "envelope id must be an integer");
  }
  if (!isRecord(value.request) || typeof value.request.method !== "string") {
    return invalidEnvelope(id, "envelope request must be an object with a string method");
  }
  return { id, request: value.request as unknown as Request };
}

function invalidEnvelope(id: number, message: string): ResponseEnvelope {
  return { id, response: { ok: false, error: "INVALID_ARGUMENT", message } };
}

function logEntry(envelope: RequestEnvelope, response: Response, ms: number): RequestLogEntry {
  const entry: RequestLogEntry = { id: envelope.id, method: envelope.request.method, ok: response.ok, ms };
  if (!response.ok) entry.error = response.error;
  return entry;
}

/** Runs tasks with the same key strictly in order; a null key never waits. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string | null, task: () => Promise<T>): Promise<T> {
    if (key === null) return task();
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
