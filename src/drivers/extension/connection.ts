/**
 * One connected browser extension instance (one browser profile), as seen
 * through its native-messaging host. Owns that instance's tab list and the
 * commands in flight to it.
 */
import type { Socket } from "node:net";
import { AtcError, toErrorCode } from "../../contracts/errors.js";
import {
  EXTENSION_COMMAND_TIMEOUT_MS,
  EXTENSION_NAVIGATION_TIMEOUT_MS,
  type ExtensionAction,
  type ExtensionTab,
  type ExtensionToDaemon,
} from "../../contracts/extension.js";
import type { BrowserName, LiveTab } from "../../contracts/types.js";
import { readLines, writeLine } from "../../transport/lines.js";
import { parseExtensionMessage } from "./messages.js";

/** Chrome's cap on one extension-to-host message; anything larger is not from a real browser. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectionEvents {
  onIdentified: (connection: ExtensionConnection) => void;
  onTabs: (connection: ExtensionConnection) => void;
  onPin: (tabId: string) => Promise<string>;
}

export class ExtensionConnection {
  key = "";
  browser: BrowserName = "chrome";
  tabs: LiveTab[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly socket: Socket,
    private readonly events: ConnectionEvents,
  ) {
    readLines(socket, MAX_LINE_BYTES, { onLine: (line) => this.receive(line), onOverflow: () => socket.destroy() });
    socket.on("close", () => this.rejectAll());
  }

  tabId(rawTabId: number): string {
    return `ext:${this.key}:${String(rawTabId)}`;
  }

  dispatch(rawTabId: number, action: ExtensionAction, payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = { type: "command", id, tabId: rawTabId, action, payload: { ...payload, timeoutMs: EXTENSION_NAVIGATION_TIMEOUT_MS } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, () => reject(timeoutError(action))), EXTENSION_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      writeLine(this.socket, message);
    });
  }

  private receive(line: string): void {
    const message = parseExtensionMessage(line);
    if (message === undefined) return;
    if (message.type === "hello") this.identify(message.browser, message.instance);
    else if (this.key === "") return;
    else if (message.type === "tabs") this.updateTabs(message.tabs);
    else if (message.type === "result") this.complete(message);
    else void this.pin(message.id, message.tabId);
  }

  private identify(browser: BrowserName, instance: string): void {
    this.browser = browser;
    this.key = `${browser}-${instance}`;
    this.events.onIdentified(this);
  }

  private updateTabs(tabs: ExtensionTab[]): void {
    this.tabs = tabs.map((tab) => ({
      tabId: this.tabId(tab.id),
      browser: this.browser,
      source: "extension",
      url: tab.url,
      title: tab.title,
      active: tab.active,
    }));
    this.events.onTabs(this);
  }

  private complete(message: Extract<ExtensionToDaemon, { type: "result" }>): void {
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.settle(message.id, () => {
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new AtcError(toErrorCode(message.error), message.message ?? "browser extension reported an error"));
    });
  }

  private async pin(id: number, rawTabId: number): Promise<void> {
    try {
      const context = await this.events.onPin(this.tabId(rawTabId));
      writeLine(this.socket, { type: "pinned", id, ok: true, context });
    } catch (error) {
      writeLine(this.socket, { type: "pinned", id, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private settle(id: number, outcome: () => void): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    outcome();
  }

  private rejectAll(): void {
    for (const [id, entry] of this.pending) {
      this.settle(id, () => entry.reject(new AtcError("ACTION_FAILED", "browser extension disconnected mid-command")));
    }
  }
}

function timeoutError(action: ExtensionAction): AtcError {
  return new AtcError("TIMEOUT", `browser extension did not finish "${action}" in ${EXTENSION_COMMAND_TIMEOUT_MS} ms`);
}
