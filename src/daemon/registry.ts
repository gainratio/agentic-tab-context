/**
 * ContextRegistry: the daemon's single source of truth for TabContext records.
 */
import { randomBytes } from "node:crypto";
import { AtcError } from "../contracts/errors.js";
import type { BrowserName, BrowserSession, TabContext, TabSource } from "../contracts/types.js";
import { redactUrl } from "./redaction.js";
import {
  ID_PATTERN,
  compareContexts,
  isContextExpired,
  loadContexts,
  resolveContextTtlMs,
  writeStateFile,
} from "./registry-store.js";

/** Returns `size` random bytes. Injectable so tests can force id collisions. */
export type RandomSource = (size: number) => Uint8Array;

export interface ContextRegistryOptions {
  statePath: string;
  random?: RandomSource;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface NewContext {
  browser: BrowserName;
  profile: string;
  createdAt: string;
  source?: TabSource;
  tabId?: string;
}

export interface RegistrySnapshot {
  current: string | null;
  contexts: TabContext[];
}

const MAX_ID_ATTEMPTS = 4096;

export class ContextRegistry {
  private readonly statePath: string;
  private readonly random: RandomSource;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly contexts = new Map<string, TabContext>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly usedIds = new Set<string>();
  private currentId: string | null = null;

  constructor(options: ContextRegistryOptions) {
    this.statePath = options.statePath;
    this.random = options.random ?? randomBytes;
    this.ttlMs = resolveContextTtlMs(options.env, options.ttlMs);
    this.now = options.now ?? (() => new Date());
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

  findOpenByTabId(tabId: string): TabContext | undefined {
    for (const ctx of this.contexts.values()) {
      if (ctx.status === "open" && ctx.tabId === tabId) return { ...ctx };
    }
    return undefined;
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
    const { browser, profile, createdAt, source, tabId } = input;
    const ctx: TabContext = {
      id, browser, status: "open", profile, createdAt,
      ...(source === undefined ? {} : { source }),
      ...(tabId === undefined ? {} : { tabId }),
    };
    this.contexts.set(id, ctx);
    this.sessions.set(id, session);
    if (Number.isFinite(Date.parse(createdAt))) this.pruneAt(Date.parse(createdAt));
    this.persist();
    return { ...ctx };
  }

  /** Prune closed contexts whose age exceeds `ttlMs`. Returns removed context ids. */
  prune(now: Date = this.now()): string[] {
    const removed = this.pruneAt(now.getTime());
    if (removed.length > 0) this.persist();
    return removed;
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
      throw new AtcError("INTERNAL", `cannot make ${id} current: not an open context`);
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
    throw new AtcError("INTERNAL", "could not allocate a unique context id");
  }

  private load(): void {
    const restored = loadContexts(this.statePath);
    if (restored === undefined) return;
    const nowMs = this.now().getTime();
    for (const ctx of restored) {
      this.usedIds.add(ctx.id);
      const closed: TabContext = { ...ctx, status: "closed" };
      if (!isContextExpired(closed, nowMs, this.ttlMs)) this.contexts.set(ctx.id, closed);
    }
    this.currentId = null;
    this.persist();
  }

  private pruneAt(nowMs: number): string[] {
    const removed: string[] = [];
    for (const [id, ctx] of this.contexts) {
      if (isContextExpired(ctx, nowMs, this.ttlMs)) {
        this.contexts.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  private persist(): void {
    const snapshot = this.snapshot();
    writeStateFile(this.statePath, {
      ...snapshot,
      contexts: snapshot.contexts.map((ctx) => (ctx.url === undefined ? ctx : { ...ctx, url: redactUrl(ctx.url) })),
    });
  }
}
