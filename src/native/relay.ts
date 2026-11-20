/**
 * Native messaging relay: browser (length-prefixed frames on stdio) <-> daemon
 * (NDJSON on the owner-only extension socket). Auto-starts the daemon when the
 * socket is absent and replays identity + latest tab list on every reconnect.
 */
import type { Socket } from "node:net";
import { HOST_RECONNECT_MS, type HostToExtension } from "../contracts/extension.js";
import { FrameDecoder, MAX_OUTBOUND_FRAME_BYTES, encodeFrame } from "../transport/frames.js";
import { readLines, writeLine } from "../transport/lines.js";

export interface RelayIo {
  writeToBrowser(frame: Buffer): void;
  connectToDaemon(): Socket;
  schedule(task: () => void, ms: number): void;
  /** Per-install token injected into the extension hello; never sent to the page. */
  authToken?: string;
  /** Re-read the per-install auth token dynamically when connecting to a fresh daemon. */
  readAuthToken?: () => string | undefined;
  /** Start the daemon automatically when the extension socket is not yet listening. */
  ensureDaemon?: () => void | Promise<void>;
  now?: () => number;
}

const REPLAYED_TYPES = new Set(["hello", "tabs"]);
const START_POLL_MS = 200;
const START_FAST_RETRIES = 15;
const SPAWN_COOLDOWN_MS = 5_000;
const NO_DAEMON_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

export class NativeRelay {
  private daemon: Socket | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly replay = new Map<string, unknown>();
  private lastSpawnAt = Number.NEGATIVE_INFINITY;
  private fastRetries = 0;

  constructor(private readonly io: RelayIo) {}

  start(): void {
    this.connect();
  }

  fromBrowser(chunk: Buffer): void {
    for (const message of this.decoder.push(chunk)) this.forward(message);
  }

  private forward(message: unknown): void {
    const type = messageType(message);
    if (type !== undefined && REPLAYED_TYPES.has(type)) this.replay.set(type, message);
    if (this.daemon !== null) writeLine(this.daemon, this.authenticated(message));
  }

  private currentToken(): string | undefined {
    return this.io.readAuthToken?.() ?? this.io.authToken;
  }

  private authenticated(message: unknown): unknown {
    const token = this.currentToken();
    if (token === undefined || typeof message !== "object" || message === null) return message;
    const record = message as Record<string, unknown>;
    return record.type === "hello" ? { ...record, auth: token } : message;
  }

  private connect(): void {
    const socket = this.io.connectToDaemon();
    socket.on("connect", () => this.attach(socket));
    readLines(socket, MAX_OUTBOUND_FRAME_BYTES, { onLine: (line) => this.toBrowser(line), onOverflow: () => socket.destroy() });
    socket.on("error", (err) => this.onSocketError(socket, err));
    socket.on("close", () => this.detach(socket));
  }

  private onSocketError(socket: Socket, err: unknown): void {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    if (typeof code === "string" && NO_DAEMON_CODES.has(code)) this.maybeStartDaemon();
    socket.destroy();
  }

  private maybeStartDaemon(): void {
    if (this.io.ensureDaemon === undefined) return;
    const now = this.io.now?.() ?? Date.now();
    if (now - this.lastSpawnAt < SPAWN_COOLDOWN_MS) return;
    this.lastSpawnAt = now;
    this.fastRetries = START_FAST_RETRIES;
    void Promise.resolve(this.io.ensureDaemon()).catch(() => undefined);
  }

  private nextDelayMs(): number {
    if (this.fastRetries <= 0) return HOST_RECONNECT_MS;
    this.fastRetries -= 1;
    return START_POLL_MS;
  }

  private attach(socket: Socket): void {
    this.daemon = socket;
    this.fastRetries = 0;
    this.tellBrowser({ type: "daemon", connected: true });
    for (const type of REPLAYED_TYPES) {
      const message = this.replay.get(type);
      if (message !== undefined) writeLine(socket, this.authenticated(message));
    }
  }

  private detach(socket: Socket): void {
    if (this.daemon === socket) {
      this.daemon = null;
      this.tellBrowser({ type: "daemon", connected: false });
    }
    this.io.schedule(() => this.connect(), this.nextDelayMs());
  }

  private tellBrowser(message: HostToExtension): void {
    this.io.writeToBrowser(encodeFrame(message));
  }

  private toBrowser(line: string): void {
    try {
      this.io.writeToBrowser(encodeFrame(JSON.parse(line) as unknown));
    } catch {
      // A malformed or oversized daemon message is dropped; the daemon times the command out.
    }
  }
}

function messageType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
