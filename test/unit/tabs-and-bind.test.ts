import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetup } from "../../src/cli/setup.js";
import { TabCtxError } from "../../src/contracts/errors.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { LiveTab } from "../../src/contracts/types.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { filterTabs, selectTabToBind } from "../../src/daemon/tabs.js";
import { buildActionExpression, buildInspectExpression, buildLogsExpression } from "../../src/drivers/dom-script.js";
import { ExtensionBridge } from "../../src/drivers/extension/bridge.js";
import { ExtensionDriver } from "../../src/drivers/extension/driver.js";
import { MacosTabDriver, listMacosTabs } from "../../src/drivers/macos/driver.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

const SAMPLE_TABS: readonly LiveTab[] = [
  {
    tabId: "ext:chrome:101",
    browser: "chrome",
    source: "extension",
    url: "http://localhost:5181/",
    title: "EdgeReco — Local-First Recommendations",
    active: true,
  },
  {
    tabId: "macos:safari:1:1",
    browser: "safari",
    source: "macos",
    url: "http://localhost:5182/screen",
    title: "AML-Filter — Sanctions Screening",
    active: true,
  },
  {
    tabId: "macos:safari:1:2",
    browser: "safari",
    source: "macos",
    url: "http://localhost:5183/",
    title: "AlmaMesh — Knowledge Graph",
    active: false,
  },
];

describe("filterTabs & selectTabToBind", () => {
  it("filters by query, url, title, browser, active, and tabId", () => {
    expect(filterTabs(SAMPLE_TABS, { query: "aml-filter" })).toHaveLength(1);
    expect(filterTabs(SAMPLE_TABS, { browser: "safari" })).toHaveLength(2);
    expect(filterTabs(SAMPLE_TABS, { browser: "safari", active: true })).toHaveLength(1);
    expect(filterTabs(SAMPLE_TABS, { url: "5183" })).toHaveLength(1);
    expect(filterTabs(SAMPLE_TABS, { title: "EdgeReco" })).toHaveLength(1);
    expect(filterTabs(SAMPLE_TABS, { tab: "macos:safari:1:2" })).toHaveLength(1);
  });

  it("selects a unique match or prefers extension active tab when multiple match", () => {
    expect(selectTabToBind(SAMPLE_TABS, { query: "AlmaMesh" }).tabId).toBe("macos:safari:1:2");
    expect(selectTabToBind(SAMPLE_TABS, { query: "localhost" }).tabId).toBe("ext:chrome:101");
  });

  it("throws TARGET_NOT_FOUND when no tab matches and AMBIGUOUS_TARGET when non-unique", () => {
    expect(() => selectTabToBind(SAMPLE_TABS, { query: "nonexistent" })).toThrowError(TabCtxError);
    const inactiveTabs: LiveTab[] = SAMPLE_TABS.map((t) => ({ ...t, active: false }));
    try {
      selectTabToBind(inactiveTabs, { query: "localhost" });
      expect.unreachable();
    } catch (error) {
      const err = error as TabCtxError;
      expect(err.code).toBe("AMBIGUOUS_TARGET");
      expect(err.details.matched).toBe(3);
    }
  });
});

describe("ExtensionBridge & ExtensionDriver", () => {
  it("syncs tabs, dispatches commands over long-poll, and drives bound extension tabs", async () => {
    const bridge = new ExtensionBridge();
    const port = await bridge.start(0);
    expect(port).toBeGreaterThan(0);

    try {
      const syncRes = await fetch(`http://127.0.0.1:${port}/bridge/tabs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          browser: "chrome",
          tabs: [{ id: 42, url: "http://localhost:3000/app", title: "My App", active: true }],
        }),
      });
      expect(syncRes.status).toBe(200);
      expect(bridge.isConnected()).toBe(true);
      expect(bridge.listTabs()).toEqual([
        {
          tabId: "ext:chrome:42",
          browser: "chrome",
          source: "extension",
          url: "http://localhost:3000/app",
          title: "My App",
          active: true,
        },
      ]);

      const driver = new ExtensionDriver(bridge);
      const session = await driver.bindTab("ext:chrome:42");

      // Simulate extension polling in background
      const pollPromise = (async () => {
        const res = await fetch(`http://127.0.0.1:${port}/bridge/poll`);
        const body = (await res.json()) as { command: { id: number; action: string } };
        await fetch(`http://127.0.0.1:${port}/bridge/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: body.command.id,
            ok: true,
            result: JSON.stringify({ url: "http://localhost:3000/app", title: "My App", aria: '- button "Save"' }),
          }),
        });
      })();

      const inspected = await driver.inspect(session);
      await pollPromise;
      expect(inspected).toEqual({ url: "http://localhost:3000/app", title: "My App", aria: '- button "Save"' });

      await driver.close(session);
    } finally {
      await bridge.close();
    }
  });
});

describe("MacosTabDriver & DaemonService bind/tabs", () => {
  it("discovers and binds macOS tabs through DaemonService and reuses existing bound context", async () => {
    const home = mkdtempSync(join(tmpdir(), "abt-macos-test-"));
    try {
      const paths = resolvePaths({ ABT_HOME: home });
      const registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0010, 0x0020]) });
      const fakeJxa = async (script: string): Promise<string> => {
        if (script.includes("Object.entries(map)")) {
          return JSON.stringify([
            {
              tabId: "macos:chrome:1:2",
              browser: "chrome",
              source: "macos",
              url: "http://localhost:5182/screen",
              title: "AML-Filter",
              active: true,
            },
          ]);
        }
        if (script.includes("JSON.stringify({ url, title })")) {
          return JSON.stringify({ url: "http://localhost:5182/screen", title: "AML-Filter" });
        }
        return JSON.stringify({
          url: "http://localhost:5182/screen",
          title: "AML-Filter",
          aria: '- heading "Sanctions Screening"',
        });
      };

      const macosTabs = await listMacosTabs(fakeJxa);
      expect(macosTabs).toHaveLength(1);

      const macosDriver = new MacosTabDriver(fakeJxa);
      const service = new DaemonService({
        registry,
        paths,
        macosDriver,
        driverFactory: (b) => new FakeDriver(b),
      });

      const tabsRes = await service.handle({ method: "tabs", params: {} });
      expect(tabsRes).toMatchObject({ ok: true, tabs: [{ tabId: "macos:chrome:1:2", title: "AML-Filter" }] });

      const bindRes = await service.handle({ method: "bind", params: { query: "aml-filter" } });
      expect(bindRes).toMatchObject({
        ok: true,
        context: "ctx_0010",
        tabId: "macos:chrome:1:2",
        browser: "chrome",
        source: "macos",
        current: true,
      });

      // Re-binding the same tab reuses ctx_0010 instead of creating a duplicate context
      const rebindRes = await service.handle({ method: "bind", params: { tab: "macos:chrome:1:2" } });
      expect(rebindRes).toMatchObject({ ok: true, context: "ctx_0010", reused: true });

      const inspectRes = await service.handle({ method: "inspect", params: {} });
      expect(inspectRes).toMatchObject({
        ok: true,
        context: "ctx_0010",
        aria: '- heading "Sanctions Screening"',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("dom-script & setup", () => {
  it("builds self-contained inspect, action, and logs expressions", () => {
    expect(buildInspectExpression()).toContain("implicitRole");
    expect(buildActionExpression("click", { kind: "role", role: "button", name: "Save" })).toContain("AMBIGUOUS_TARGET");
    expect(buildLogsExpression("console", 0)).toContain("__abt_logs");
  });

  it("runSetup installs SKILL.md into all 4 assistant skill directories", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "abt-setup-home-"));
    try {
      const res = runSetup({ HOME: fakeHome });
      expect(res.ok).toBe(true);
      expect((res.installedSkills as string[]).length).toBe(4);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
