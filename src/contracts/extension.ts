/**
 * Wire contract between the browser extension and the daemon.
 *
 * The extension talks to a native-messaging host that the browser launches
 * (only for our extension ID); the host relays each message as one NDJSON
 * line over the owner-only `extension.sock`. There is no network port.
 */

/** Native messaging host name registered with each browser. */
export const NATIVE_HOST_NAME = "com.gainratio.atc";
/** How often the native host retries reaching a daemon that is not running yet. */
export const HOST_RECONNECT_MS = 500;
/** Longest the extension waits for a navigation to finish loading (sent with each command). */
export const EXTENSION_NAVIGATION_TIMEOUT_MS = 30_000;
/** Daemon-side deadline per command: the navigation budget plus one reconnect cycle of slack. */
export const EXTENSION_COMMAND_TIMEOUT_MS = EXTENSION_NAVIGATION_TIMEOUT_MS + 10 * HOST_RECONNECT_MS;
/** Browser labels the extension may report about itself. */
export const EXTENSION_BROWSERS = ["chrome", "chromium", "brave", "edge", "firefox"] as const;
export type ExtensionBrowser = (typeof EXTENSION_BROWSERS)[number];

export const EXTENSION_ACTIONS = [
  "navigate",
  "back",
  "forward",
  "reload",
  "location",
  "screenshot",
  "page",
  "watch",
  "unwatch",
] as const;
export type ExtensionAction = (typeof EXTENSION_ACTIONS)[number];

export interface ExtensionTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

export type ExtensionToDaemon =
  | { type: "hello"; browser: ExtensionBrowser; instance: string }
  | { type: "tabs"; tabs: ExtensionTab[] }
  | { type: "result"; id: number; ok: boolean; result?: unknown; error?: string; message?: string }
  | { type: "pin"; id: number; tabId: number };

export type DaemonToExtension =
  | { type: "command"; id: number; tabId: number; action: ExtensionAction; payload: Record<string, unknown> }
  | { type: "pinned"; id: number; ok: boolean; context?: string; message?: string };

/** Sent by the native host itself so the extension can show whether atc is reachable. */
export interface HostToExtension {
  type: "daemon";
  connected: boolean;
}
