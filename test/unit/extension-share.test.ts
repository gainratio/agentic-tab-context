/**
 * Sensitive-tab enforcement: the CLI/agent `bind` path refuses sensitive URLs,
 * while the user-initiated extension share path allows them and never changes
 * the active context on its own.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { BrowserSession, LiveTab } from "../../src/contracts/types.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

function extensionTab(rawId: number, url: string, title: string, active = false): LiveTab {
  return { tabId: `ext:chrome-0a1b2c3d:${String(rawId)}`, browser: "chrome", source: "extension", url, title, active };
}

const SAFE = extensionTab(1, "https://docs.example.com/guide", "Docs", true);
const MAIL = extensionTab(2, "https://mail.google.com/mail/u/0/", "Inbox");
const FILE = extensionTab(3, "file:///Users/me/Documents/taxes.pdf", "taxes.pdf");
const MACOS: LiveTab = {
  tabId: "macos:safari:1:1",
  browser: "safari",
  source: "macos",
  url: "https://example.net/",
  title: "Example",
  active: true,
};

/** A live-tab driver: lists fixed tabs and binds by id. */
class FakeLiveDriver extends FakeDriver {
  readonly bound: string[] = [];
  constructor(
    name: "chrome" | "safari",
    private readonly tabs: readonly LiveTab[],
  ) {
    super(name);
  }
  listTabs(): Promise<LiveTab[]> {
    return Promise.resolve([...this.tabs]);
  }
  async bindTab(tabId: string): Promise<BrowserSession> {
    this.bound.push(tabId);
    return this.open({ profile: "live", headless: false });
  }
}

let home: string;
let registry: ContextRegistry;
let service: DaemonService;
let extension: FakeLiveDriver;
let macos: FakeLiveDriver;
let managed: FakeDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atc-share-"));
  const paths = resolvePaths({ ATC_HOME: home });
  registry = new ContextRegistry({
    statePath: paths.state,
    random: sequenceRandom([0x1001, 0x1002, 0x1003, 0x1004, 0x1005]),
  });
  extension = new FakeLiveDriver("chrome", [SAFE, MAIL, FILE]);
  macos = new FakeLiveDriver("safari", [MACOS]);
  managed = new FakeDriver("chrome");
  service = new DaemonService({
    registry,
    paths,
    env: {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    extensionDriver: extension,
    macosDriver: macos,
    driverFactory: (browser) => (browser === "chrome" ? managed : new FakeDriver(browser)),
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function openManaged(): Promise<string> {
  const opened = await service.handle({ method: "open", params: { browser: "chrome" } });
  if (!opened.ok || typeof opened.context !== "string") throw new Error("managed open failed");
  return opened.context;
}

describe("sensitive-tab enforcement", () => {
  it("binds safe tabs through the agent path, unchanged", async () => {
    const bound = await service.handle({ method: "bind", params: { tab: SAFE.tabId } });
    expect(bound).toMatchObject({ ok: true, source: "extension", tabId: SAFE.tabId, current: true });
    expect(extension.bound).toEqual([SAFE.tabId]);
  });

  it("rejects sensitive mail and file tabs, creating no context and calling no driver", async () => {
    for (const tab of [MAIL, FILE]) {
      expect(await service.handle({ method: "bind", params: { tab: tab.tabId } })).toMatchObject({
        ok: false,
        error: "ACTION_BLOCKED_SENSITIVE",
      });
    }
    expect(extension.bound).toEqual([]);
    expect(registry.list()).toEqual([]);
    expect(registry.current).toBeNull();
  });

  it("does not expose the sensitive URL in the block message", async () => {
    const blocked = await service.handle({ method: "bind", params: { tab: MAIL.tabId } });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.message)).toContain("side panel");
    expect(String(blocked.message)).not.toContain("mail/u/0");
  });

  it("still blocks the agent path after a user has shared the same sensitive tab", async () => {
    const context = await service.shareFromExtension(MAIL.tabId);
    expect(await service.handle({ method: "bind", params: { tab: MAIL.tabId } })).toMatchObject({
      ok: false,
      error: "ACTION_BLOCKED_SENSITIVE",
    });
    expect(registry.current).toBeNull();
    expect(registry.get(context)?.status).toBe("open");
  });
});

describe("shareFromExtension", () => {
  it("shares a sensitive tab and leaves an existing current context alone", async () => {
    const current = await openManaged();
    const context = await service.shareFromExtension(MAIL.tabId);

    expect(extension.bound).toEqual([MAIL.tabId]);
    expect(registry.get(context)).toMatchObject({
      status: "open",
      source: "extension",
      tabId: MAIL.tabId,
      url: MAIL.url,
      title: MAIL.title,
    });
    expect(registry.current).toBe(current);

    expect(await service.handle({ method: "bindings", params: {} })).toMatchObject({
      ok: true,
      current,
      bindings: [
        { context: current, current: true },
        { context, current: false, source: "extension", tabId: MAIL.tabId, url: MAIL.url },
      ],
    });
  });

  it("does not adopt a first context: sharing never changes the active target", async () => {
    const context = await service.shareFromExtension(SAFE.tabId);
    expect(registry.current).toBeNull();
    expect(await service.handle({ method: "bindings", params: {} })).toMatchObject({
      ok: true,
      current: null,
      bindings: [{ context, current: false }],
    });
  });

  it("makes a shared tab current only through the explicit activate/use path (popup pin)", async () => {
    const context = await service.shareFromExtension(MAIL.tabId);
    expect(registry.current).toBeNull();
    expect(await service.handle({ method: "use", params: { context } })).toEqual({ ok: true, context });
    expect(registry.current).toBe(context);
  });

  it("reuses the context for a repeated share without rebinding", async () => {
    const first = await service.shareFromExtension(SAFE.tabId);
    const second = await service.shareFromExtension(SAFE.tabId);
    expect(second).toBe(first);
    expect(extension.bound).toEqual([SAFE.tabId]);
  });

  it("rejects unknown tab ids and tabs from other sources", async () => {
    await expect(service.shareFromExtension("ext:chrome-0a1b2c3d:99")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    await expect(service.shareFromExtension(MACOS.tabId)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(extension.bound).toEqual([]);
    expect(registry.list()).toEqual([]);
  });
});
