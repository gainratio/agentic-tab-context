/**
 * `atc tabs` / `atc bind`: deterministic tab selection, binding through the
 * daemon, reuse of an already-bound tab, and the doctor report.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtcError } from "../../src/contracts/errors.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { BrowserSession, LiveTab } from "../../src/contracts/types.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { filterTabs, selectTabToBind } from "../../src/daemon/tabs.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

const TABS: readonly LiveTab[] = [
  { tabId: "ext:chrome-0a1b2c3d:101", browser: "chrome", source: "extension", url: "http://localhost:5181/", title: "EdgeReco", active: true },
  { tabId: "macos:safari:1:1", browser: "safari", source: "macos", url: "http://localhost:5182/screen", title: "AML-Filter", active: true },
  { tabId: "macos:safari:1:2", browser: "safari", source: "macos", url: "http://localhost:5183/", title: "AlmaMesh", active: false },
];

/** A live-tab driver: lists fixed tabs and binds by id. */
class FakeLiveDriver extends FakeDriver {
  readonly bound: string[] = [];
  constructor(private readonly tabs: readonly LiveTab[]) {
    super("chrome");
  }
  listTabs(): Promise<LiveTab[]> {
    return Promise.resolve([...this.tabs]);
  }
  async bindTab(tabId: string): Promise<BrowserSession> {
    this.bound.push(tabId);
    return this.open({ profile: "live", headless: false });
  }
}

describe("filterTabs & selectTabToBind", () => {
  it("filters by query, url, title, browser, active, and tab id", () => {
    expect(filterTabs(TABS, { query: "aml-filter" })).toHaveLength(1);
    expect(filterTabs(TABS, { browser: "safari" })).toHaveLength(2);
    expect(filterTabs(TABS, { browser: "safari", active: true })).toHaveLength(1);
    expect(filterTabs(TABS, { url: "5183" })).toHaveLength(1);
    expect(filterTabs(TABS, { title: "EdgeReco" })).toHaveLength(1);
    expect(filterTabs(TABS, { tab: "macos:safari:1:2" })).toHaveLength(1);
  });

  it("picks the single match, else an exact match, else the extension's active tab", () => {
    expect(selectTabToBind(TABS, { query: "AlmaMesh" }).tabId).toBe("macos:safari:1:2");
    expect(selectTabToBind(TABS, { query: "http://localhost:5183/" }).tabId).toBe("macos:safari:1:2");
    expect(selectTabToBind(TABS, { query: "localhost" }).tabId).toBe("ext:chrome-0a1b2c3d:101");
  });

  it("never guesses: no match is TARGET_NOT_FOUND, a tie returns the candidates", () => {
    expect(() => selectTabToBind(TABS, { query: "nope" })).toThrow(AtcError);
    const inactive = TABS.map((tab) => ({ ...tab, active: false }));
    const failure = (() => {
      try {
        selectTabToBind(inactive, { query: "localhost" });
      } catch (error) {
        return error as AtcError;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: "AMBIGUOUS_TARGET", details: { matched: 3 } });
    expect((failure?.details.candidates as LiveTab[]).map((t) => t.tabId)).toHaveLength(3);
  });
});

describe("binding through the daemon", () => {
  let home: string;
  let service: DaemonService;
  let live: FakeLiveDriver;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atc-bind-"));
    const paths = resolvePaths({ ATC_HOME: home });
    live = new FakeLiveDriver(TABS.filter((t) => t.source === "macos"));
    const registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0010, 0x0020]) });
    service = new DaemonService({ registry, paths, env: {}, macosDriver: live, driverFactory: (b) => new FakeDriver(b) });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("binds the matching open tab, makes it current, and drives it", async () => {
    expect(await service.handle({ method: "bind", params: { query: "aml-filter" } })).toMatchObject({
      ok: true,
      context: "ctx_0010",
      tabId: "macos:safari:1:1",
      source: "macos",
      current: true,
      reused: false,
    });
    expect(live.bound).toEqual(["macos:safari:1:1"]);
    expect(await service.handle({ method: "inspect", params: {} })).toMatchObject({ ok: true, context: "ctx_0010" });
  });

  it("reuses the existing context when the same tab is bound again", async () => {
    await service.handle({ method: "bind", params: { query: "aml-filter" } });
    expect(await service.handle({ method: "bind", params: { tab: "macos:safari:1:1" } })).toMatchObject({ context: "ctx_0010", reused: true });
    expect(live.bound).toHaveLength(1);
  });

  it("marks the context closed when the live tab goes away", async () => {
    await service.handle({ method: "bind", params: { query: "aml-filter" } });
    live.disconnect(live.sessionIds()[0] ?? "");
    expect(await service.handle({ method: "inspect", params: {} })).toMatchObject({ ok: false, error: "NO_CURRENT_CONTEXT" });
  });

  it("doctor reports what is reachable and what to do next", async () => {
    const report = await service.handle({ method: "doctor", params: {} });
    expect(report).toMatchObject({ ok: true, liveTabs: { extension: 0, macos: 2, managed: 0 } });
    expect(String((report as unknown as { nextSteps: string[] }).nextSteps[0])).toMatch(/atc setup/);
  });
});
