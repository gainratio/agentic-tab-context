/**
 * Browser native-messaging framing: each message is a 4-byte little-endian
 * length followed by that many bytes of UTF-8 JSON.
 */

/** Chrome's documented cap on a single message from the browser to the host (64 MiB). */
export const MAX_INBOUND_FRAME_BYTES = 64 * 1024 * 1024;
/** Chrome's documented cap on a single message from the host to the browser (1 MiB). */
export const MAX_OUTBOUND_FRAME_BYTES = 1024 * 1024;
const HEADER_BYTES = 4;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_OUTBOUND_FRAME_BYTES) {
    throw new RangeError(`native message is ${body.length} bytes; browsers accept at most ${MAX_OUTBOUND_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incrementally decodes frames from arbitrary stdin chunk boundaries. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);

  /** Returns every complete message in order; throws on an oversized frame. */
  push(chunk: Buffer): unknown[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    let frame = this.nextFrame();
    while (frame !== undefined) {
      messages.push(JSON.parse(frame.toString("utf8")) as unknown);
      frame = this.nextFrame();
    }
    return messages;
  }

  private nextFrame(): Buffer | undefined {
    if (this.pending.length < HEADER_BYTES) return undefined;
    const length = this.pending.readUInt32LE(0);
    if (length > MAX_INBOUND_FRAME_BYTES) throw new RangeError(`native message of ${length} bytes exceeds the cap`);
    if (this.pending.length < HEADER_BYTES + length) return undefined;
    const body = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
    this.pending = this.pending.subarray(HEADER_BYTES + length);
    return body;
  }
}
