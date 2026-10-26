/**
 * Node-side access to the single in-page agent (`extension/page-agent.js`) and
 * the result handling both live-tab drivers (extension, macOS) share.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AtcError, toErrorCode } from "../contracts/errors.js";
import type { ActionResult, ConsoleEntry, NetworkEntry, PageState, Target } from "../contracts/types.js";
import { describeTarget } from "./target.js";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PAGE_AGENT_PATH = join(PACKAGE_ROOT, "extension", "page-agent.js");

export type ActAction = "click" | "type" | "select";

export type PageOp =
  | { op: "inspect" }
  | { op: "watch" }
  | { op: "unwatch" }
  | { op: "logs"; kind: "console" | "network"; since: number }
  | { op: "act"; action: ActAction; target: Target; label: string; value?: string }
  | { op: "press"; key: string }
  | { op: "upload"; target: Target; label: string; files: ReadonlyArray<{ name: string; type: string; base64: string }> };

let cachedSource: string | undefined;

/** A self-contained script expression that runs `op` and evaluates to its JSON result. */
export function pageExpression(op: PageOp): string {
  cachedSource ??= ["page-agent-watch.js", "page-agent-actions.js", "page-agent.js"].map((file) => readFileSync(join(PACKAGE_ROOT, "extension", file), "utf8")).join("\n");
  return `${cachedSource}\n;JSON.stringify(globalThis.__atcAgent.run(${JSON.stringify(op)}))`;
}

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
};

/** Read one local file for a file-input upload, with a hard size cap. */
export function uploadOp(target: Target, path: string): PageOp {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) {
    throw new AtcError("INVALID_ARGUMENT", `upload file must be a regular file no larger than ${MAX_UPLOAD_BYTES} bytes`);
  }
  const name = basename(path);
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : undefined;
  return {
    op: "upload",
    target,
    label: describeTarget(target),
    files: [{ name, type: (extension && MIME[extension]) ?? "application/octet-stream", base64: readFileSync(path).toString("base64") }],
  };
}

export function actOp(action: ActAction, target: Target, value?: string): PageOp {
  const op: PageOp = { op: "act", action, target, label: describeTarget(target) };
  return value === undefined ? op : { ...op, value };
}

interface RawAct {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  matched?: unknown;
}

/** Turn the agent's act result into an ActionResult or a typed error. */
export function toActionResult(raw: unknown): ActionResult {
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as RawAct;
  if (result.ok === true) return { matched: 1 };
  const message = typeof result.message === "string" ? result.message : "the page action failed";
  const details = typeof result.matched === "number" ? { matched: result.matched } : {};
  throw new AtcError(toErrorCode(result.error), message, details);
}

export function toPageState(raw: unknown): PageState {
  const state = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PageState>;
  return { url: String(state.url ?? ""), title: String(state.title ?? ""), aria: String(state.aria ?? "") };
}

export function toEntries<T extends ConsoleEntry | NetworkEntry>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}
