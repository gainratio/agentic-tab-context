/**
 * The side-panel half of the real workflow: a fake native host talks to the
 * actual daemon process through `extension.sock`, so this exercises the wiring
 * in `daemon/main.ts` (not just the service in isolation).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import { type CliResult, type Json, cli, eventually } from "../helpers/cli.js";

const INSTANCE = "0a1b2c3d";
const MAIL_TAB = `ext:chromium-${INSTANCE}:7`;
const SAFE_TAB = `ext:chromium-${INSTANCE}:8`;

class FakeHost {
  private buffer = "";
  private readonly inbox: Json[] = [];
  private waiter: ((message: Json) => void) | null = null;

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
  }

  static connect(path: string): Promise<FakeHost> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new FakeHost(socket)));
      socket.once("error", reject);
    });
  }

  send(message: Json): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  next(): Promise<Json> {
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiter = resolve));
  }

  async answer(result: unknown): Promise<Json> {
    const command = await this.next();
    this.send({ type: "result", id: command.id, ok: true, result });
    return command;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i !== -1; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      const message = JSON.parse(line) as Json;
      const waiter = this.waiter;
      this.waiter = null;
      if (waiter === null) this.inbox.push(message);
      else waiter(message);
    }
  }
}

let home: string;
let socketPath: string;
let atc: (...args: string[]) => Promise<CliResult>;
let host: FakeHost;

const tabsOf = (result: CliResult): Json[] => (result.json.tabs as Json[] | undefined) ?? [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "atc-panel-"));
  atc = cli({ ATC_HOME: home });
  await atc("tabs");
  socketPath = resolvePaths({ ATC_HOME: home }).extensionSocket;
  host = await FakeHost.connect(socketPath);
  host.send({ type: "hello", browser: "chromium", instance: INSTANCE });
  host.send({
    type: "tabs",
    tabs: [
      { id: 7, url: "https://mail.google.com/mail/u/0/", title: "Inbox", active: true },
      { id: 8, url: "https://example.com/", title: "Example", active: false },
    ],
  });
  await eventually(() => atc("tabs"), (result) => tabsOf(result).length === 2);
});

afterAll(async () => {
  // Drop the transport first so daemon shutdown cannot wait on an unanswered command.
  host?.socket.destroy();
  await atc("shutdown");
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("side panel through the real daemon", () => {
  it("serves bindings, allows a sensitive share, activates it, and unshares it", async () => {
    host.send({ type: "bindings", id: 1 });
    expect(await host.next()).toEqual({ type: "bindings", id: 1, ok: true, current: null, bindings: [] });

    host.send({ type: "share", id: 2, tabId: 7 });
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 7, action: "watch" });
    const shared = await host.next();
    expect(shared).toMatchObject({ type: "shared", id: 2, ok: true });
    const context = String(shared.context);
    expect(context).toMatch(/^ctx_[0-9a-f]{4}$/);

    host.send({ type: "bindings", id: 3 });
    expect(await host.next()).toMatchObject({
      type: "bindings",
      id: 3,
      ok: true,
      current: null,
      bindings: [{ context, tabId: MAIL_TAB, source: "extension", url: "https://mail.google.com/mail/u/0/", current: false }],
    });

    const denied = await atc("bind", "--tab", MAIL_TAB);
    expect(denied.json).toMatchObject({ ok: false, error: "ACTION_BLOCKED_SENSITIVE" });

    host.send({ type: "activate", id: 4, context });
    expect(await host.next()).toEqual({ type: "activated", id: 4, ok: true, context });
    expect((await atc("current")).json).toMatchObject({ ok: true, context });

    host.send({ type: "unshare", id: 5, context });
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 7, action: "unwatch" });
    expect(await host.next()).toEqual({ type: "unshared", id: 5, ok: true, context });
    expect((await atc("bindings")).json).toEqual({ ok: true, current: null, bindings: [] });
  });

  it("reports unknown ids as errors without breaking the connection", async () => {
    host.send({ type: "share", id: 6, tabId: 99 });
    expect(await host.next()).toMatchObject({ type: "shared", id: 6, ok: false });
    host.send({ type: "activate", id: 7, context: "ctx_dead" });
    expect(await host.next()).toMatchObject({ type: "activated", id: 7, ok: false });
    host.send({ type: "bindings", id: 8 });
    expect(await host.next()).toMatchObject({ type: "bindings", id: 8, ok: true });
  });

  it("keeps the popup pin path working for a sensitive tab", async () => {
    host.send({ type: "pin", id: 9, tabId: 7 });
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 7, action: "watch" });
    const pinned = await host.next();
    expect(pinned).toMatchObject({ type: "pinned", id: 9, ok: true });
    const context = String(pinned.context);
    expect((await atc("current")).json).toMatchObject({ ok: true, context });

    host.send({ type: "unshare", id: 10, context });
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 7, action: "unwatch" });
    expect(await host.next()).toEqual({ type: "unshared", id: 10, ok: true, context });
  });

  it("binds a safe tab from the agent path normally", async () => {
    const binding = atc("bind", "--tab", SAFE_TAB);
    expect(await host.answer({ ok: true })).toMatchObject({ type: "command", tabId: 8, action: "watch" });
    const bound = await binding;
    expect(bound.json).toMatchObject({ ok: true, tabId: SAFE_TAB, source: "extension", current: true });
  });
});
