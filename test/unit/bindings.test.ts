/**
 * `atc bindings`: the daemon lists every open context from the registry,
 * including contexts that are not current, without touching a browser driver.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { Paths, Request, Response } from "../../src/contracts/protocol.js";
import type { BindingView } from "../../src/contracts/types.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { sequenceRandom } from "../helpers/fake-driver.js";

let home: string;
let paths: Paths;
let registry: ContextRegistry;
let service: DaemonService;
let ids: { extension: string; managed: string; macos: string };

interface Listed {
  current: string | null;
  bindings: BindingView[];
}

function call(request: unknown): Promise<Response> {
  return service.handle(request as Request);
}

/** A service whose driver factory fails if listing ever reaches a browser. */
function serviceFor(target: ContextRegistry): DaemonService {
  return new DaemonService({
    registry: target,
    paths,
    env: {},
    driverFactory: () => {
      throw new Error("atc bindings must not need a browser driver");
    },
  });
}

async function list(params: Record<string, unknown> = {}): Promise<Listed> {
  const response = await call({ method: "bindings", params });
  if (!response.ok) throw new Error(`bindings failed: ${response.message}`);
  return { current: response.current as string | null, bindings: response.bindings as BindingView[] };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "atc-bindings-"));
  paths = resolvePaths({ ATC_HOME: home });
  registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0101, 0x0202, 0x0303]) });
  service = serviceFor(registry);

  const extension = registry.create(
    {
      browser: "chrome",
      profile: "live",
      source: "extension",
      tabId: "ext:chrome-0a1b2c3d:101",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { sessionId: "extension-session" },
  );
  registry.updateLocation(extension.id, { url: "https://docs.example.com/start", title: "Getting Started" });

  const managed = registry.create(
    { browser: "chromium", profile: "default", createdAt: "2026-01-02T00:00:00.000Z" },
    { sessionId: "managed-session" },
  );
  registry.updateLocation(managed.id, { url: "about:blank", title: "" });

  const macos = registry.create(
    {
      browser: "safari",
      profile: "live",
      source: "macos",
      tabId: "macos:safari:1:1",
      createdAt: "2026-01-03T00:00:00.000Z",
    },
    { sessionId: "macos-session" },
  );
  registry.updateLocation(macos.id, { url: "https://mail.example.net/inbox", title: "Inbox" });

  registry.setCurrent(extension.id);
  ids = { extension: extension.id, managed: managed.id, macos: macos.id };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("bindings", () => {
  it("returns ok with an empty list when no context is open", async () => {
    const empty = new ContextRegistry({ statePath: join(home, "empty-state.json") });
    expect(await serviceFor(empty).handle({ method: "bindings", params: {} })).toEqual({
      ok: true,
      current: null,
      bindings: [],
    });
  });

  it("lists every open context in registry order and marks the current one", async () => {
    expect(await list()).toStrictEqual({
      current: ids.extension,
      bindings: [
        {
          context: ids.extension,
          tabId: "ext:chrome-0a1b2c3d:101",
          browser: "chrome",
          source: "extension",
          url: "https://docs.example.com/start",
          title: "Getting Started",
          current: true,
        },
        {
          context: ids.managed,
          tabId: null,
          browser: "chromium",
          source: null,
          url: "about:blank",
          title: "",
          current: false,
        },
        {
          context: ids.macos,
          tabId: "macos:safari:1:1",
          browser: "safari",
          source: "macos",
          url: "https://mail.example.net/inbox",
          title: "Inbox",
          current: false,
        },
      ],
    });
  });

  it("filters case-insensitively by title, url, and hostname, never by tabId or context", async () => {
    const contexts = async (query: string): Promise<string[]> => (await list({ query })).bindings.map((binding) => binding.context);

    expect(await contexts("getting started")).toEqual([ids.extension]);
    expect(await contexts("INBOX")).toEqual([ids.macos]);
    expect(await contexts("docs.example.com")).toEqual([ids.extension]);
    expect(await contexts("about:blank")).toEqual([ids.managed]);
    expect(await contexts("example")).toEqual([ids.extension, ids.macos]);
    expect(await contexts("safari")).toEqual([]);
  });

  it("filters by browser, combines filters, and keeps current when the filter excludes it", async () => {
    expect((await list({ browser: "chrome" })).bindings.map((binding) => binding.context)).toEqual([ids.extension]);
    expect((await list({ browser: "safari" })).bindings.map((binding) => binding.context)).toEqual([ids.macos]);
    expect((await list({ browser: "firefox" })).bindings).toEqual([]);

    const combined = await list({ browser: "safari", query: "mail" });
    expect(combined.current).toBe(ids.extension);
    expect(combined.bindings.map((binding) => binding.context)).toEqual([ids.macos]);

    expect(await list({ query: "no such page" })).toEqual({ current: ids.extension, bindings: [] });
  });

  it("excludes closed contexts and reports a null current without hiding the rest", async () => {
    registry.markClosed(ids.managed);
    expect((await list()).bindings.map((binding) => binding.context)).toEqual([ids.extension, ids.macos]);

    registry.markClosed(ids.extension);
    const afterCurrentCloses = await list();
    expect(afterCurrentCloses.current).toBeNull();
    expect(afterCurrentCloses.bindings).toEqual([expect.objectContaining({ context: ids.macos, current: false })]);

    registry.setCurrent(null);
    expect((await list()).bindings.map((binding) => binding.current)).toEqual([false]);
  });

  it("validates query and browser params", async () => {
    expect(await call({ method: "bindings", params: { query: 1 } })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(await call({ method: "bindings", params: { browser: "netscape" } })).toMatchObject({
      ok: false,
      error: "INVALID_ARGUMENT",
    });
    expect(await call({ method: "bindings", params: { browser: 42 } })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
    expect(await call({ method: "bindings", params: [] })).toMatchObject({ ok: false, error: "INVALID_ARGUMENT" });
  });

  it("is not pinned to the current context by request routing", () => {
    expect(service.route({ method: "bindings", params: {} })).toEqual({ key: null, request: { method: "bindings", params: {} } });
  });
});
