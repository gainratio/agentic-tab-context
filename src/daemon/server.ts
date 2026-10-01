/**
 * NDJSON-over-Unix-socket front end for DaemonService.
 *
 * One `RequestEnvelope` per line in, one `ResponseEnvelope` per line out.
 * Requests that target the same context run strictly one after another (a
 * per-context promise chain) so two commands never interleave on one tab;
 * requests for different contexts, or for no context, run concurrently.
 */
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { TabCtxError } from "../contracts/errors.js";
import type { Paths, Request, RequestEnvelope, Response, ResponseEnvelope } from "../contracts/protocol.js";
import { isRecord } from "./params.js";
import type { DaemonService } from "./service.js";

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

export interface RunningServer {
  close(): Promise<void>;
}

const MAX_LINE_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 1000;
const SOCKET_DRAIN_MS = 1000;

export async function startServer(service: DaemonService, paths: Paths, options: ServerOptions = {}): Promise<RunningServer> {
  assertSocketPathFits(paths.socket);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  await clearStaleSocket(paths.socket);
  const queue = new KeyedQueue();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveConnection(socket, (line) => dispatchLine(line, service, queue, options));
  });
  await listen(server, paths.socket);
  const close = (): Promise<void> => closeServer(server, sockets, paths.socket);
  try {
    await chmod(paths.socket, 0o600);
  } catch (err) {
    await close();
    throw err;
  }
  return { close };
}

/**
 * The kernel silently truncates over-long Unix socket paths (sun_path is 108
 * bytes on Linux, 104 on macOS, including the NUL), so fail loudly instead.
 */
export function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform = process.platform): void {
  const limit = platform === "linux" ? 107 : 103;
  if (Buffer.byteLength(socketPath) > limit) {
    throw new TabCtxError(
      "INVALID_ARGUMENT",
      `socket path is ${Buffer.byteLength(socketPath)} bytes (max ${limit}); set TABCTX_HOME to a shorter directory`,
      { socket: socketPath },
    );
  }
}

// --- socket lifecycle ---------------------------------------------------------

async function clearStaleSocket(socketPath: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await lstat(socketPath)).isSocket();
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (!isSocket) throw new TabCtxError("INTERNAL", `${socketPath} exists and is not a socket`);
  if (await isAlive(socketPath)) {
    throw new TabCtxError("INTERNAL", `a daemon is already listening on ${socketPath}`);
  }
  await unlink(socketPath).catch((err: unknown) => {
    if (errnoCode(err) !== "ENOENT") throw err;
  });
}

/** True if something accepts connections on the socket. */
function isAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(socketPath);
    const finish = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(PROBE_TIMEOUT_MS, () => finish(true)); // hung but present: do not steal it
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server, sockets: Set<Socket>, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      unlink(socketPath).catch(() => undefined).finally(resolve);
    });
    for (const socket of sockets) {
      socket.end(); // flush pending replies, then force-close stragglers
      setTimeout(() => socket.destroy(), SOCKET_DRAIN_MS).unref();
    }
  });
}

// --- NDJSON framing -------------------------------------------------------------

function serveConnection(socket: Socket, onLine: (line: string) => Promise<ResponseEnvelope>): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") void onLine(line).then((envelope) => reply(socket, envelope));
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      reply(socket, invalidEnvelope(-1, "request line too long"));
      socket.end();
      buffer = "";
    }
  });
  socket.on("error", () => socket.destroy());
}

function reply(socket: Socket, envelope: ResponseEnvelope): void {
  if (socket.writable) socket.write(`${JSON.stringify(envelope)}\n`);
}

// --- dispatch -------------------------------------------------------------------

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

function errnoCode(err: unknown): unknown {
  return isRecord(err) ? err.code : undefined;
}
