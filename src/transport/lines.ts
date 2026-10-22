/**
 * Newline-delimited JSON framing shared by every Unix-socket peer
 * (CLI <-> daemon, native host <-> daemon).
 */
import type { Socket } from "node:net";

export interface LineHandlers {
  onLine: (line: string) => void;
  /** Called once if a line exceeds `maxBytes`; the remaining stream is ignored. */
  onOverflow: () => void;
}

/** Splits a UTF-8 socket stream into complete lines, enforcing a per-line byte cap. */
export class LineSplitter {
  private buffer = "";
  private overflowed = false;
  private readonly maxBytes: number;
  private readonly handlers: LineHandlers;

  constructor(maxBytes: number, handlers: LineHandlers) {
    this.maxBytes = maxBytes;
    this.handlers = handlers;
  }

  push(chunk: string): void {
    if (this.overflowed) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.acceptLine(line)) return;
      newline = this.buffer.indexOf("\n");
    }
    this.withinLimit(this.buffer);
  }

  private acceptLine(line: string): boolean {
    if (!this.withinLimit(line)) return false;
    if (line.trim() !== "") this.handlers.onLine(line);
    return true;
  }

  private withinLimit(text: string): boolean {
    if (Buffer.byteLength(text) <= this.maxBytes) return true;
    this.buffer = "";
    this.overflowed = true;
    this.handlers.onOverflow();
    return false;
  }
}

/** Attach a LineSplitter to a socket in UTF-8 mode. */
export function readLines(socket: Socket, maxBytes: number, handlers: LineHandlers): void {
  const splitter = new LineSplitter(maxBytes, handlers);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => splitter.push(chunk));
}

export function writeLine(socket: Socket, value: unknown): void {
  if (socket.writable) socket.write(`${JSON.stringify(value)}\n`);
}
