/**
 * Owner-only Unix socket servers: path-length guard, stale-socket recovery,
 * 0700 home directory, 0600 socket file, and graceful close.
 */
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { AtcError } from "../contracts/errors.js";

export interface RunningServer {
  close(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 1000;
const SOCKET_DRAIN_MS = 1000;

/** Listen on `socketPath` with owner-only permissions; `onConnection` gets each client socket. */
export async function listenOwnerOnly(socketPath: string, onConnection: (socket: Socket) => void): Promise<RunningServer> {
  assertSocketPathFits(socketPath);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(socketPath), 0o700);
  await clearStaleSocket(socketPath);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => track(sockets, socket, onConnection));
  await listen(server, socketPath);
  const close = (): Promise<void> => closeServer(server, sockets, socketPath);
  await chmod(socketPath, 0o600).catch(async (err: unknown) => {
    await close();
    throw err;
  });
  return { close };
}

function track(sockets: Set<Socket>, socket: Socket, onConnection: (socket: Socket) => void): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => socket.destroy());
  onConnection(socket);
}

/**
 * The kernel silently truncates over-long Unix socket paths (sun_path is 108
 * bytes on Linux, 104 on macOS, including the NUL), so fail loudly instead.
 */
export function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform = process.platform): void {
  const limit = platform === "linux" ? 107 : 103;
  if (Buffer.byteLength(socketPath) > limit) {
    throw new AtcError(
      "INVALID_ARGUMENT",
      `socket path is ${Buffer.byteLength(socketPath)} bytes (max ${limit}); set ATC_HOME to a shorter directory`,
      { socket: socketPath },
    );
  }
}

async function clearStaleSocket(socketPath: string): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await lstat(socketPath)).isSocket();
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  if (!isSocket) throw new AtcError("INTERNAL", `${socketPath} exists and is not a socket`);
  if (await isAlive(socketPath)) throw new AtcError("INTERNAL", `something is already listening on ${socketPath}`);
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

function errnoCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}
