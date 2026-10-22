/**
 * Daemon side of the browser-extension link: an owner-only Unix socket that
 * native-messaging hosts connect to. No TCP port, so web pages cannot reach it,
 * and the browser only launches the host for our own extension ID.
 */
import { AtcError } from "../../contracts/errors.js";
import { type ExtensionAction, HOST_RECONNECT_MS } from "../../contracts/extension.js";
import type { LiveTab } from "../../contracts/types.js";
import { type RunningServer, listenOwnerOnly } from "../../transport/unix-server.js";
import { ExtensionConnection } from "./connection.js";

const TAB_ID_PATTERN = /^ext:([a-z]+-[0-9a-f]{8}):(\d+)$/;
/** After daemon start, wait this long for already-running browsers' hosts to reconnect. */
const STARTUP_GRACE_MS = 4 * HOST_RECONNECT_MS;

export interface ConnectedExtension {
  key: string;
  browser: string;
  tabs: number;
}

export class ExtensionBridge {
  private server: RunningServer | null = null;
  private startedAt = 0;
  private readonly connections = new Map<string, ExtensionConnection>();
  private pinHandler: (tabId: string) => Promise<string> = () => Promise.reject(new Error("daemon is not ready"));
  private tabsListener: (key: string, tabs: readonly LiveTab[]) => void = () => undefined;

  async start(socketPath: string): Promise<void> {
    this.startedAt = Date.now();
    this.server = await listenOwnerOnly(socketPath, (socket) => {
      const connection = new ExtensionConnection(socket, {
        onIdentified: (conn) => this.connections.set(conn.key, conn),
        onTabs: (conn) => this.tabsListener(conn.key, conn.tabs),
        onPin: (tabId) => this.pinHandler(tabId),
      });
      socket.on("close", () => this.forget(connection));
    });
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  onPinTab(handler: (tabId: string) => Promise<string>): void {
    this.pinHandler = handler;
  }

  onTabsChanged(listener: (key: string, tabs: readonly LiveTab[]) => void): void {
    this.tabsListener = listener;
  }

  connected(): ConnectedExtension[] {
    return [...this.connections.values()].map((c) => ({ key: c.key, browser: c.browser, tabs: c.tabs.length }));
  }

  listTabs(): LiveTab[] {
    return [...this.connections.values()].flatMap((c) => c.tabs.map((tab) => ({ ...tab })));
  }

  /** Right after start-up, give already-open browsers a moment to reconnect before listing tabs. */
  async settle(): Promise<void> {
    const remaining = this.startedAt + STARTUP_GRACE_MS - Date.now();
    if (this.connections.size > 0 || remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }

  async dispatch(tabId: string, action: ExtensionAction, payload: Record<string, unknown> = {}): Promise<unknown> {
    const { key, rawTabId } = parseExtensionTabId(tabId);
    const connection = this.connections.get(key);
    if (connection === undefined) {
      throw new AtcError("ACTION_FAILED", `the browser extension for ${key} is not connected; is that browser still open?`);
    }
    return connection.dispatch(rawTabId, action, payload);
  }

  private forget(connection: ExtensionConnection): void {
    if (this.connections.get(connection.key) === connection) this.connections.delete(connection.key);
  }
}

export function parseExtensionTabId(tabId: string): { key: string; rawTabId: number } {
  const match = TAB_ID_PATTERN.exec(tabId);
  if (match === null) throw new AtcError("INVALID_ARGUMENT", `not an extension tab id: ${tabId}`);
  return { key: match[1] ?? "", rawTabId: Number(match[2]) };
}
