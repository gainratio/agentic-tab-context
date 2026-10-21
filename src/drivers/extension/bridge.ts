/**
 * Localhost HTTP bridge between the daemon and the Agentic Browser Tab WebExtension.
 * Listens strictly on 127.0.0.1 so only local browser extensions can connect.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TabCtxError } from "../../contracts/errors.js";
import type { BrowserName, LiveTab } from "../../contracts/types.js";

export interface BridgeCommand {
  id: number;
  tabId: number;
  action: string;
  payload: Record<string, unknown>;
}

export interface BridgeCommandResult {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

interface PendingCommand {
  command: BridgeCommand;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_BRIDGE_PORT = 43919;
const COMMAND_TIMEOUT_MS = 15_000;
const LONG_POLL_MS = 10_000;
const STALE_EXTENSION_MS = 30_000;

export class ExtensionBridge {
  private server: Server | null = null;
  private boundPort = 0;
  private lastSeenAt = 0;
  private tabs: LiveTab[] = [];
  private nextCmdId = 1;
  private readonly queue: BridgeCommand[] = [];
  private readonly pending = new Map<number, PendingCommand>();
  private pollWaiter: ((cmd: BridgeCommand | null) => void) | null = null;
  private pinHandler: ((tabId: string) => Promise<string>) | null = null;

  get port(): number {
    return this.boundPort;
  }

  isConnected(): boolean {
    return this.lastSeenAt > 0 && Date.now() - this.lastSeenAt < STALE_EXTENSION_MS;
  }

  listTabs(): LiveTab[] {
    if (!this.isConnected()) return [];
    return this.tabs.map((tab) => ({ ...tab }));
  }

  onPinTab(handler: (tabId: string) => Promise<string>): void {
    this.pinHandler = handler;
  }

  async start(port: number = DEFAULT_BRIDGE_PORT): Promise<number> {
    if (this.server !== null) return this.boundPort;
    const srv = createServer((req, res) => void this.handleHttp(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(port, "127.0.0.1", () => {
          srv.off("error", reject);
          resolve();
        });
      });
      this.server = srv;
      this.boundPort = (srv.address() as AddressInfo).port;
      return this.boundPort;
    } catch {
      return 0;
    }
  }

  async close(): Promise<void> {
    if (this.pollWaiter !== null) {
      this.pollWaiter(null);
      this.pollWaiter = null;
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new TabCtxError("CONTEXT_CLOSED", "Extension bridge shutting down"));
    }
    this.pending.clear();
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  dispatch(rawTabId: number, action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected()) {
      throw new TabCtxError(
        "ACTION_FAILED",
        "Browser extension is not connected; load the extension from `abt setup` or use `abt open <browser>`",
      );
    }
    const id = this.nextCmdId++;
    const command: BridgeCommand = { id, tabId: rawTabId, action, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TabCtxError("TIMEOUT", `Timed out waiting for extension to ${action}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { command, resolve, reject, timer });
      if (this.pollWaiter !== null) {
        const waiter = this.pollWaiter;
        this.pollWaiter = null;
        waiter(command);
      } else {
        this.queue.push(command);
      }
    });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/bridge/status") {
      sendJson(res, 200, { ok: true, connected: this.isConnected(), tabs: this.listTabs() });
    } else if (req.method === "POST" && url === "/bridge/tabs") {
      await this.handleTabsSync(req, res);
    } else if (req.method === "GET" && url === "/bridge/poll") {
      await this.handlePoll(res);
    } else if (req.method === "POST" && url === "/bridge/result") {
      await this.handleResult(req, res);
    } else {
      sendJson(res, 404, { ok: false, error: "not_found" });
    }
  }

  private async handleTabsSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    this.lastSeenAt = Date.now();
    const browser = normalizeBrowser(body.browser);
    const rawTabs = Array.isArray(body.tabs) ? body.tabs : [];
    this.tabs = rawTabs
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null && typeof t.id === "number")
      .map((t) => ({
        tabId: `ext:${browser}:${String(t.id)}`,
        browser,
        source: "extension" as const,
        url: typeof t.url === "string" ? t.url : "",
        title: typeof t.title === "string" ? t.title : "",
        active: Boolean(t.active),
      }));
    let pinnedContext: string | undefined;
    if (typeof body.pinTabId === "number" && this.pinHandler !== null) {
      pinnedContext = await this.pinHandler(`ext:${browser}:${String(body.pinTabId)}`).catch(() => undefined);
    }
    sendJson(res, 200, { ok: true, count: this.tabs.length, ...(pinnedContext === undefined ? {} : { context: pinnedContext }) });
  }

  private async handlePoll(res: ServerResponse): Promise<void> {
    this.lastSeenAt = Date.now();
    const next = this.queue.shift();
    if (next !== undefined) {
      sendJson(res, 200, { ok: true, command: next });
      return;
    }
    const command = await new Promise<BridgeCommand | null>((resolve) => {
      if (this.pollWaiter !== null) this.pollWaiter(null);
      const timer = setTimeout(() => {
        if (this.pollWaiter === waiter) this.pollWaiter = null;
        resolve(null);
      }, LONG_POLL_MS);
      const waiter = (cmd: BridgeCommand | null): void => {
        clearTimeout(timer);
        resolve(cmd);
      };
      this.pollWaiter = waiter;
    });
    sendJson(res, 200, { ok: true, command });
  }

  private async handleResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.lastSeenAt = Date.now();
    const body = (await readJsonBody(req)) as unknown as BridgeCommandResult;
    const entry = this.pending.get(body.id);
    if (entry !== undefined) {
      this.pending.delete(body.id);
      clearTimeout(entry.timer);
      if (body.ok) entry.resolve(body.result);
      else entry.reject(new TabCtxError((body.error as "ACTION_FAILED") ?? "ACTION_FAILED", body.message ?? "Extension error", body.details ?? {}));
    }
    sendJson(res, 200, { ok: true });
  }
}

function normalizeBrowser(raw: unknown): BrowserName {
  if (raw === "chrome" || raw === "brave" || raw === "edge" || raw === "firefox" || raw === "safari" || raw === "chromium") {
    return raw;
  }
  return "chrome";
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve((JSON.parse(data) as Record<string, unknown>) ?? {});
      } catch {
        resolve({});
      }
    });
  });
}
