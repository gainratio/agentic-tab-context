/**
 * Bounded sequence-numbered console and network ring buffers for Playwright pages.
 */
import type { ConsoleMessage, Page, Request } from "playwright-core";
import { AtcError } from "../../contracts/errors.js";
import type { ConsoleEntry, NetworkEntry } from "../../contracts/types.js";

export const LOG_CAPACITY = 500;
export const MAX_LOG_ENTRY_BYTES = 4 * 1024;
export const MAX_LOG_BUFFER_BYTES = 256 * 1024;

export interface SeqLogOptions {
  capacity?: number;
  maxEntryBytes?: number;
  maxBufferBytes?: number;
}

/** Fixed-size log that numbers entries 1, 2, 3, ... and drops the oldest past count or byte caps. */
export class SeqLog<T extends { seq: number }> {
  private readonly items: T[] = [];
  private readonly capacity: number;
  private readonly maxEntryBytes: number;
  private readonly maxBufferBytes: number;
  private nextSeq = 1;

  constructor(options: number | SeqLogOptions = LOG_CAPACITY) {
    const resolved = typeof options === "number" ? { capacity: options } : options;
    this.capacity = resolved.capacity ?? LOG_CAPACITY;
    this.maxEntryBytes = resolved.maxEntryBytes ?? MAX_LOG_ENTRY_BYTES;
    this.maxBufferBytes = resolved.maxBufferBytes ?? MAX_LOG_BUFFER_BYTES;
  }

  push(build: (seq: number) => T): void {
    const entry = truncateLogEntry(build(this.nextSeq), this.maxEntryBytes);
    this.items.push(entry);
    this.nextSeq += 1;
    trimLogBuffer(this.items, this.capacity, this.maxBufferBytes);
  }

  since(seq: number): T[] {
    return this.items.filter((item) => item.seq > seq).map((item) => ({ ...item }));
  }
}

export function truncateLogString(value: string, maxBytes: number = MAX_LOG_ENTRY_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "...[truncated]";
  const budget = Math.max(0, maxBytes - suffix.length);
  return `${Buffer.from(value, "utf8").subarray(0, budget).toString("utf8")}${suffix}`;
}

export function truncateLogEntry<T extends { seq: number }>(entry: T, maxBytes: number = MAX_LOG_ENTRY_BYTES): T {
  const shaped = { ...(entry as Record<string, unknown>) };
  for (const key of ["text", "url", "failure"]) {
    if (typeof shaped[key] === "string") shaped[key] = truncateLogString(shaped[key] as string, maxBytes);
  }
  return shaped as T;
}

export function trimLogBuffer<T>(items: T[], capacity: number = LOG_CAPACITY, maxBufferBytes: number = MAX_LOG_BUFFER_BYTES): void {
  while (items.length > capacity) items.shift();
  let totalBytes = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), "utf8"), 0);
  while (items.length > 0 && totalBytes > maxBufferBytes) {
    const removed = items.shift();
    if (removed !== undefined) totalBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
  }
}

export function validateSinceSeq(sinceSeq: number): number {
  if (!Number.isFinite(sinceSeq)) {
    throw new AtcError("INVALID_ARGUMENT", "since must be a finite number");
  }
  return sinceSeq;
}

export function attachPageLogs(page: Page, consoleLog: SeqLog<ConsoleEntry>, networkLog: SeqLog<NetworkEntry>): void {
  recordConsole(page, consoleLog);
  recordNetwork(page, networkLog);
}

function recordConsole(page: Page, consoleLog: SeqLog<ConsoleEntry>): void {
  page.on("console", (message: ConsoleMessage) => consoleLog.push((seq) => consoleEntry(seq, message)));
  page.on("pageerror", (error: Error) => {
    consoleLog.push((seq) => ({ seq, type: "pageerror", text: error.message, url: page.url(), at: new Date().toISOString() }));
  });
}

function consoleEntry(seq: number, message: ConsoleMessage): ConsoleEntry {
  const url = message.location().url;
  return { seq, type: message.type(), text: message.text(), ...(url === "" ? {} : { url }), at: new Date().toISOString() };
}

function recordNetwork(page: Page, networkLog: SeqLog<NetworkEntry>): void {
  page.on("requestfinished", (request: Request) => {
    void responseStatus(request).then((status) => {
      networkLog.push((seq) => ({ ...requestFields(seq, request), ...(status === undefined ? {} : { status }) }));
    });
  });
  page.on("requestfailed", (request: Request) => {
    networkLog.push((seq) => ({ ...requestFields(seq, request), failure: request.failure()?.errorText ?? "unknown failure" }));
  });
}

async function responseStatus(request: Request): Promise<number | undefined> {
  try {
    return (await request.response())?.status();
  } catch {
    return undefined;
  }
}

function requestFields(seq: number, request: Request): NetworkEntry {
  return {
    seq,
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    at: new Date().toISOString(),
  };
}
