/**
 * Bounded sequence-numbered console and network ring buffers for Playwright pages.
 */
import type { ConsoleMessage, Page, Request } from "playwright-core";
import { TabCtxError } from "../../contracts/errors.js";
import type { ConsoleEntry, NetworkEntry } from "../../contracts/types.js";

export const LOG_CAPACITY = 500;

/** Fixed-size log that numbers entries 1, 2, 3, ... and drops the oldest past capacity. */
export class SeqLog<T extends { seq: number }> {
  private readonly items: T[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity: number = LOG_CAPACITY) {}

  push(build: (seq: number) => T): void {
    this.items.push(build(this.nextSeq));
    this.nextSeq += 1;
    if (this.items.length > this.capacity) this.items.shift();
  }

  since(seq: number): T[] {
    return this.items.filter((item) => item.seq > seq).map((item) => ({ ...item }));
  }
}

export function validateSinceSeq(sinceSeq: number): number {
  if (!Number.isFinite(sinceSeq)) {
    throw new TabCtxError("INVALID_ARGUMENT", "since must be a finite number");
  }
  return sinceSeq;
}

export function attachPageLogs(page: Page, consoleLog: SeqLog<ConsoleEntry>, networkLog: SeqLog<NetworkEntry>): void {
  recordConsole(page, consoleLog);
  recordNetwork(page, networkLog);
}

function recordConsole(page: Page, consoleLog: SeqLog<ConsoleEntry>): void {
  page.on("console", (message: ConsoleMessage) => {
    const url = message.location().url;
    consoleLog.push((seq) => ({
      seq,
      type: message.type(),
      text: message.text(),
      ...(url === "" ? {} : { url }),
      at: new Date().toISOString(),
    }));
  });
  page.on("pageerror", (error: Error) => {
    consoleLog.push((seq) => ({
      seq,
      type: "pageerror",
      text: error.message,
      url: page.url(),
      at: new Date().toISOString(),
    }));
  });
}

function recordNetwork(page: Page, networkLog: SeqLog<NetworkEntry>): void {
  page.on("requestfinished", (request: Request) => {
    void request
      .response()
      .then((response) => response?.status())
      .catch(() => undefined)
      .then((status) => {
        networkLog.push((seq) => ({
          ...requestFields(seq, request),
          ...(status === undefined ? {} : { status }),
        }));
      });
  });
  page.on("requestfailed", (request: Request) => {
    networkLog.push((seq) => ({
      ...requestFields(seq, request),
      failure: request.failure()?.errorText ?? "unknown failure",
    }));
  });
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
