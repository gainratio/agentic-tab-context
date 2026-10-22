/**
 * On-disk snapshot of the context registry (`state.json`): atomic writes and
 * tolerant reads. Contexts restored from disk are always marked closed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BROWSERS, type BrowserName, type TabContext } from "../contracts/types.js";

export const ID_PATTERN = /^ctx_[0-9a-f]{4}$/;
let writeCounter = 0;

/** Write via a temp file + rename so a crash never leaves a half-written state file. */
export function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeCounter += 1;
  const tmp = `${path}.${process.pid}.${writeCounter}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Contexts from the last run, or undefined when there is no readable state file yet. */
export function loadContexts(path: string): TabContext[] | undefined {
  const raw = readStateFile(path);
  return raw === undefined ? undefined : parseContexts(raw);
}

export function compareContexts(a: TabContext, b: TabContext): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function readStateFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseContexts(raw: unknown): TabContext[] {
  if (!isRecord(raw) || !Array.isArray(raw.contexts)) return [];
  const out: TabContext[] = [];
  for (const item of raw.contexts) {
    const ctx = toTabContext(item);
    if (ctx !== undefined) out.push(ctx);
  }
  return out;
}

function toTabContext(item: unknown): TabContext | undefined {
  if (!isRecord(item)) return undefined;
  const { id, browser, profile, createdAt, url, title, source, tabId } = item;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
  if (typeof browser !== "string" || !isBrowserName(browser)) return undefined;
  if (typeof profile !== "string" || typeof createdAt !== "string") return undefined;
  const ctx: TabContext = { id, browser, status: "closed", profile, createdAt };
  if (typeof url === "string") ctx.url = url;
  if (typeof title === "string") ctx.title = title;
  if (source === "extension" || source === "managed" || source === "macos") ctx.source = source;
  if (typeof tabId === "string") ctx.tabId = tabId;
  return ctx;
}

function isBrowserName(value: string): value is BrowserName {
  return (BROWSERS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code;
}
