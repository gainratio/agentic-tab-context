/**
 * CLI <-> daemon wire protocol: newline-delimited JSON over a Unix domain socket
 * at `${ATC_HOME}/daemon.sock`. One request line, one response line.
 */
import type { ErrorCode } from "./errors.js";
import type { BindOptions, BrowserName, Target } from "./types.js";

/** `context` omitted => the daemon uses the current context (see `use`). */
export type Request =
  | { method: "open"; params: { browser: BrowserName; profile?: string; headless?: boolean; use?: boolean } }
  | { method: "tabs"; params: { browser?: BrowserName; query?: string; active?: boolean } }
  | { method: "bind"; params: BindOptions }
  | { method: "list"; params: Record<string, never> }
  | { method: "use"; params: { context: string } }
  | { method: "current"; params: Record<string, never> }
  | { method: "close"; params: { context?: string } }
  | { method: "goto"; params: { context?: string; url: string } }
  | { method: "back" | "forward" | "reload"; params: { context?: string } }
  | { method: "inspect"; params: { context?: string } }
  | { method: "screenshot"; params: { context?: string; out?: string; fullPage?: boolean } }
  | { method: "console" | "network"; params: { context?: string; since?: number } }
  | { method: "click"; params: { context?: string; target: Target } }
  | { method: "type" | "select"; params: { context?: string; target: Target; value: string } }
  | { method: "doctor"; params: Record<string, never> }
  | { method: "ping"; params: Record<string, never> }
  | { method: "shutdown"; params: Record<string, never> };

export type Method = Request["method"];

export interface RequestEnvelope {
  id: number;
  request: Request;
}

export type OkResponse = { ok: true } & Record<string, unknown>;
export interface ErrorResponse {
  ok: false;
  error: ErrorCode;
  message: string;
  [key: string]: unknown;
}
export type Response = OkResponse | ErrorResponse;

export interface ResponseEnvelope {
  id: number;
  response: Response;
}

/** Paths derived from ATC_HOME (default: ~/.atc). */
export interface Paths {
  home: string;
  /** CLI <-> daemon socket. */
  socket: string;
  /** Native messaging host <-> daemon socket (browser extension traffic). */
  extensionSocket: string;
  state: string;
  profiles: string;
  screenshots: string;
  daemonLog: string;
  /** Launcher script the browser runs for native messaging. */
  nativeHost: string;
}
