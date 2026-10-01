/**
 * CLI <-> daemon wire protocol: newline-delimited JSON over a Unix domain socket
 * at `${TABCTX_HOME}/daemon.sock`. One request line, one response line.
 *
 * Every response is the exact JSON the CLI prints to stdout, so CLI output and
 * daemon output can never drift.
 */
import type { ErrorCode } from "./errors.js";
import type { BrowserName, Target } from "./types.js";

/** `context` omitted => the daemon uses the current context (see `use`). */
export type Request =
  | { method: "open"; params: { browser: BrowserName; profile?: string; headless?: boolean; use?: boolean } }
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
  [key: string]: unknown; // e.g. { matched: 2 } for AMBIGUOUS_TARGET
}
export type Response = OkResponse | ErrorResponse;

export interface ResponseEnvelope {
  id: number;
  response: Response;
}

/** Paths derived from TABCTX_HOME (default: ~/.tabctx). */
export interface Paths {
  home: string;
  socket: string;
  state: string; // registry snapshot: { current, contexts }
  profiles: string; // one user-data-dir per profile name
  screenshots: string;
  daemonLog: string;
}
