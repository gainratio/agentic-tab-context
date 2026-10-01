/**
 * ContextRegistry: the daemon's single source of truth for TabContext records.
 *
 * Holds the public `TabContext` view of every context ever created in this
 * TABCTX_HOME, the live driver `BrowserSession` for each open one, and the
 * `current` context id. Every mutation is persisted atomically to
 * `paths.state` (public fields only; sessions never touch disk).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TabCtxError } from "../contracts/errors.js";
import { BROWSERS, type BrowserName, type BrowserSession, type TabContext } from "../contracts/types.js";

/** Returns `size` random bytes. Injectable so tests can force id collisions. */
export type RandomSource = (size: number) => Uint8Array;

export interface ContextRegistryOptions {
  statePath: string;
  random?: RandomSource;
}

export interface NewContext {
  browser: BrowserName;
  profile: string;
  createdAt: string;
}

export interface RegistrySnapshot {
  current: string | null;
  contexts: TabContext[];
}

const ID_PATTERN = /^ctx_[0-9a-f]{4}$/;
const MAX_ID_ATTEMPTS = 4096;

export class ContextRegistry {
  private readonly statePath: string;
  private readonly random: RandomSource;
  private readonly contexts = new Map<string, TabContext>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly usedIds = new Set<string>();
  private currentId: string | null = null;
  private writeCounter = 0;

  constructor(options: ContextRegistryOptions) {
    this.statePath = options.statePath;
    this.random = options.random ?? randomBytes;
    this.load();
  }

  get current(): string | null {
    return this.currentId;
  }

  get(id: string): TabContext | undefined {
    const ctx = this.contexts.get(id);
    return ctx === undefined ? undefined : { ...ctx };
  }

  session(id: string): BrowserSession | undefined {
    return this.sessions.get(id);
  }

  /** Contexts sorted by `createdAt`, then `id`. Returned objects are copies. */
  list(): TabContext[] {
    return [...this.contexts.values()].map((ctx) => ({ ...ctx })).sort(compareContexts);
  }

  /** Ids and sessions of every context that is still open. */
  openSessions(): Array<{ id: string; session: BrowserSession }> {
    return [...this.sessions.entries()].map(([id, session]) => ({ id, session }));
  }

  create(input: NewContext, session: BrowserSession): TabContext {
    const id = this.nextId();
    const ctx: TabContext = { id, browser: input.browser, status: "open", profile: input.profile, createdAt: input.createdAt };
    this.contexts.set(id, ctx);
    this.sessions.set(id, session);
    this.persist();
    return { ...ctx };
  }

  /** Records the page location last observed for an open context. */
  updateLocation(id: string, location: { url: string; title: string }): void {
    const ctx = this.contexts.get(id);
    if (ctx === undefined || ctx.status !== "open") return;
    if (ctx.url === location.url && ctx.title === location.title) return;
    ctx.url = location.url;
    ctx.title = location.title;
    this.persist();
  }

  /**
   * Marks a context closed, forgets its session and clears `current` if it
   * pointed here. Returns the session that was attached, if any. Idempotent.
   */
  markClosed(id: string): BrowserSession | undefined {
    const ctx = this.contexts.get(id);
    if (ctx === undefined) return undefined;
    const session = this.sessions.get(id);
    const changed = ctx.status !== "closed" || this.currentId === id;
    ctx.status = "closed";
    this.sessions.delete(id);
    if (this.currentId === id) this.currentId = null;
    if (changed) this.persist();
    return session;
  }

  setCurrent(id: string | null): void {
    if (id !== null && this.contexts.get(id)?.status !== "open") {
      throw new TabCtxError("INTERNAL", `cannot make ${id} current: not an open context`);
    }
    if (this.currentId === id) return;
    this.currentId = id;
    this.persist();
  }

  snapshot(): RegistrySnapshot {
    return { current: this.currentId, contexts: this.list() };
  }

  private nextId(): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = `ctx_${Buffer.from(this.random(2)).toString("hex").slice(0, 4)}`;
      if (ID_PATTERN.test(id) && !this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
    throw new TabCtxError("INTERNAL", "could not allocate a unique context id");
  }

  private load(): void {
    const raw = readStateFile(this.statePath);
    if (raw === undefined) return;
    for (const ctx of parseContexts(raw)) {
      this.contexts.set(ctx.id, { ...ctx, status: "closed" });
      this.usedIds.add(ctx.id);
    }
    // Every loaded browser died with the previous daemon, so nothing can be current.
    this.currentId = null;
    this.persist();
  }

  private persist(): void {
    const data = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    this.writeCounter += 1;
    const tmp = `${this.statePath}.${process.pid}.${this.writeCounter}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
}

function compareContexts(a: TabContext, b: TabContext): number {
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
    return undefined; // Corrupt snapshot: start empty; the next write replaces it.
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
  const { id, browser, profile, createdAt, url, title } = item;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return undefined;
  if (typeof browser !== "string" || !isBrowserName(browser)) return undefined;
  if (typeof profile !== "string" || typeof createdAt !== "string") return undefined;
  const ctx: TabContext = { id, browser, status: "closed", profile, createdAt };
  if (typeof url === "string") ctx.url = url;
  if (typeof title === "string") ctx.title = title;
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
