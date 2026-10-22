/**
 * Native messaging: frame codec, line framing, the browser<->daemon relay, and
 * native host registration (`atc setup`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "../../src/cli/setup.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import { extensionIdFromKey, extensionManifest, installNativeHost } from "../../src/native/install.js";
import { NativeRelay } from "../../src/native/relay.js";
import { FrameDecoder, MAX_OUTBOUND_FRAME_BYTES, encodeFrame } from "../../src/transport/frames.js";
import { LineSplitter } from "../../src/transport/lines.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atc-nm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("frames", () => {
  it("round-trips messages split at arbitrary chunk boundaries", () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "two" })]);
    const decoder = new FrameDecoder();
    const out = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])));
    expect(out).toEqual([{ a: 1 }, { b: "two" }]);
  });

  it("refuses to send a message larger than browsers accept", () => {
    expect(() => encodeFrame("x".repeat(MAX_OUTBOUND_FRAME_BYTES))).toThrow(RangeError);
  });

  it("refuses an inbound frame header above the 64 MiB cap", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(RangeError);
  });
});

describe("LineSplitter", () => {
  it("emits complete non-blank lines and reports overflow once", () => {
    const lines: string[] = [];
    let overflows = 0;
    const splitter = new LineSplitter(8, { onLine: (l) => lines.push(l), onOverflow: () => (overflows += 1) });
    splitter.push("ab\n\ncd");
    splitter.push("\n0123456789");
    expect(lines).toEqual(["ab", "cd"]);
    expect(overflows).toBe(1);
  });
});

/** A stand-in daemon on a Unix socket that records lines and lets the test push lines back. */
class FakeDaemon {
  readonly connections: Socket[] = [];
  readonly lines: unknown[] = [];
  private constructor(private readonly server: Server) {}

  static async start(path: string): Promise<FakeDaemon> {
    let daemon: FakeDaemon | undefined;
    const server = createServer((socket) => daemon?.accept(socket));
    daemon = new FakeDaemon(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return daemon;
  }

  private accept(socket: Socket): void {
    this.connections.push(socket);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => chunk.split("\n").filter(Boolean).forEach((l) => this.lines.push(JSON.parse(l))));
  }

  close(): Promise<void> {
    this.connections.forEach((s) => s.destroy());
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("NativeRelay", () => {
  it("relays both ways, reports daemon reachability, and replays identity after a daemon restart", async () => {
    const socketPath = join(dir, "x.sock");
    const daemon = await FakeDaemon.start(socketPath);
    const toBrowser: unknown[] = [];
    const decoder = new FrameDecoder();
    const relay = new NativeRelay({
      writeToBrowser: (frame) => toBrowser.push(...decoder.push(frame)),
      connectToDaemon: () => createConnection(socketPath),
      schedule: (task) => setTimeout(task, 1),
    });
    relay.start();
    await until(() => daemon.connections.length === 1);
    relay.fromBrowser(Buffer.concat([encodeFrame({ type: "hello", browser: "chrome", instance: "0a1b2c3d" }), encodeFrame({ type: "tabs", tabs: [] })]));
    await until(() => daemon.lines.length === 2);
    daemon.connections[0]?.write(`${JSON.stringify({ type: "command", id: 1 })}\n`);
    await until(() => toBrowser.some((m) => (m as { type?: string }).type === "command"));
    expect(toBrowser[0]).toEqual({ type: "daemon", connected: true });

    daemon.connections[0]?.destroy();
    await until(() => toBrowser.some((m) => JSON.stringify(m) === JSON.stringify({ type: "daemon", connected: false })));
    await until(() => daemon.connections.length === 2 && daemon.lines.length === 4);
    expect(daemon.lines.slice(2).map((m) => (m as { type: string }).type)).toEqual(["hello", "tabs"]);
    daemon.connections[1]?.destroy();
    await daemon.close();
  });
});

describe("native host registration", () => {
  it("derives the extension id from the manifest key exactly as Chrome does", () => {
    expect(extensionIdFromKey(extensionManifest().key)).toMatch(/^[a-p]{32}$/);
    expect(extensionIdFromKey(extensionManifest().key)).toBe("aecjddiglfcfcghkkoccljblamebifgd");
  });

  it("registers only with browsers that are installed, allowing only our extension", () => {
    const home = join(dir, "home");
    const support = join(home, "Library", "Application Support");
    mkdirSync(join(support, "Google", "Chrome"), { recursive: true });
    mkdirSync(join(support, "Mozilla"), { recursive: true });
    const paths = resolvePaths({ ATC_HOME: join(dir, "atc") });
    const written = installNativeHost({ paths, home, platform: "darwin", extraExtensionIds: ["storeid"] });
    expect(written).toHaveLength(2);
    const chrome = JSON.parse(readFileSync(join(support, "Google", "Chrome", "NativeMessagingHosts", "com.gainratio.atc.json"), "utf8"));
    expect(chrome).toMatchObject({ name: "com.gainratio.atc", type: "stdio", path: paths.nativeHost });
    expect(chrome.allowed_origins).toEqual(["chrome-extension://aecjddiglfcfcghkkoccljblamebifgd/", "chrome-extension://storeid/"]);
    const firefox = JSON.parse(readFileSync(join(support, "Mozilla", "NativeMessagingHosts", "com.gainratio.atc.json"), "utf8"));
    expect(firefox.allowed_extensions).toEqual([extensionManifest().geckoId]);
  });

  it("writes an owner-only launcher that pins node and ATC_HOME", () => {
    const paths = resolvePaths({ ATC_HOME: join(dir, "it's home") });
    installNativeHost({ paths, home: join(dir, "empty"), platform: "linux", extraExtensionIds: [] });
    const script = readFileSync(paths.nativeHost, "utf8");
    expect(script).toContain(`ATC_HOME='${join(dir, "it'\\''s home")}'`);
    expect(script).toContain(`'${process.execPath}'`);
    expect(statSync(paths.nativeHost).mode & 0o777).toBe(0o700);
  });

  it("installs the skill where Claude Code, Codex and Antigravity look for it", () => {
    const home = join(dir, "home");
    const result = runSetup({ HOME: home, ATC_HOME: join(dir, "atc") }, "linux");
    expect(result.installedSkills).toEqual([
      join(home, ".claude", "skills", "agentic-tab-context", "SKILL.md"),
      join(home, ".agents", "skills", "agentic-tab-context", "SKILL.md"),
      join(home, ".gemini", "config", "skills", "agentic-tab-context", "SKILL.md"),
    ]);
  });
});
