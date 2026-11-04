/**
 * Native messaging relay: browser (length-prefixed frames on stdio) <-> daemon
 * (NDJSON on the owner-only extension socket). Replays the extension's
 * identity and latest tab list whenever it (re)connects to a restarted daemon.
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
}

const REPLAYED_TYPES = new Set(["hello", "tabs"]);

export class NativeRelay {
  private daemon: Socket | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly replay = new Map<string, unknown>();

  constructor(private readonly io: RelayIo) {}

  start(): void {
    this.connect();
  }

  fromBrowser(chunk: Buffer): void {
    for (const message of this.decoder.push(chunk)) this.forward(message);
  }

  private forward(message: unknown): void {
    const shaped = this.authenticated(message);
    const type = typeof shaped === "object" && shaped !== null ? (shaped as { type?: unknown }).type : undefined;
    if (typeof type === "string" && REPLAYED_TYPES.has(type)) this.replay.set(type, shaped);
    if (this.daemon !== null) writeLine(this.daemon, shaped);
  }

  private authenticated(message: unknown): unknown {
    if (this.io.authToken === undefined || typeof message !== "object" || message === null) return message;
    const record = message as Record<string, unknown>;
    return record.type === "hello" ? { ...record, auth: this.io.authToken } : message;
  }

  private connect(): void {
    const socket = this.io.connectToDaemon();
    socket.on("connect", () => this.attach(socket));
    readLines(socket, MAX_OUTBOUND_FRAME_BYTES, { onLine: (line) => this.toBrowser(line), onOverflow: () => socket.destroy() });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.detach(socket));
  }

  private attach(socket: Socket): void {
    this.daemon = socket;
    this.tellBrowser({ type: "daemon", connected: true });
    for (const type of REPLAYED_TYPES) {
      const message = this.replay.get(type);
      if (message !== undefined) writeLine(socket, message);
    }
  }

  private detach(socket: Socket): void {
    if (this.daemon === socket) {
      this.daemon = null;
      this.tellBrowser({ type: "daemon", connected: false });
    }
    this.io.schedule(() => this.connect(), HOST_RECONNECT_MS);
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
