import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/contracts/paths.js";
import type { BrowserDriver, BrowserSession, LiveTab } from "../../src/contracts/types.js";
import { KeepAliveTracker, isAuthScreenUrl, isLoginRedirect } from "../../src/daemon/keepalive.js";
import { ContextRegistry } from "../../src/daemon/registry.js";
import { DaemonService } from "../../src/daemon/service.js";
import { FakeDriver, sequenceRandom } from "../helpers/fake-driver.js";

class LiveCapableDriver extends FakeDriver {
  constructor(private readonly tabs: readonly LiveTab[]) {
    super("chrome");
  }
  listTabs(): Promise<LiveTab[]> {
    return Promise.resolve([...this.tabs]);
  }
  async bindTab(tabId: string): Promise<BrowserSession> {
    const tab = this.tabs.find((entry) => entry.tabId === tabId);
    const session = await this.open({ profile: "live", headless: false });
    if (tab !== undefined) await this.navigate(session, tab.url);
    return session;
  }
}

describe("auth redirect classifier", () => {
  it.each([
    ["https://login.microsoftonline.com/common/oauth2/v2.0/authorize", true],
    ["https://accounts.google.com/v3/signin/identifier", true],
    ["https://acme.okta.com/app/UserHome", true],
    ["https://auth0.com/u/login", true],
    ["https://sso.internal.example/saml", true],
    ["https://app.example.com/login", true],
    ["https://app.example.com/auth/sign-in?returnTo=/home", true],
    ["https://app.example.com/dashboard", false],
    ["https://docs.stripe.com/api/authentication", false],
    ["about:blank", false],
  ])("classifies %s as authScreen=%s", (url, expected) => {
    expect(isAuthScreenUrl(url)).toBe(expected);
  });

  it("flags redirects from an app page onto an auth screen, not initial auth tabs", () => {
    expect(isLoginRedirect("https://app.example.com/dashboard", "https://acme.okta.com/login")).toBe(true);
    expect(isLoginRedirect("https://acme.okta.com/login", "https://acme.okta.com/login/step2")).toBe(false);
    expect(isLoginRedirect("https://app.example.com/dashboard", "https://app.example.com/settings")).toBe(false);
  });
});

describe("KeepAliveTracker", () => {
  it("tracks enabled state, marks background login redirects expired, and recovers on re-auth", () => {
    const tracker = new KeepAliveTracker();
    tracker.enable("ctx_1", "https://app.example.com/orders");
    expect({ keepAlive: tracker.isEnabled("ctx_1"), sessionExpired: tracker.isExpired("ctx_1") }).toEqual({
      keepAlive: true,
      sessionExpired: false,
    });

    tracker.observeUrl("ctx_1", "https://sso.example.com/login");
    expect({ keepAlive: tracker.isEnabled("ctx_1"), sessionExpired: tracker.isExpired("ctx_1") }).toEqual({
      keepAlive: true,
      sessionExpired: true,
    });

    tracker.observeUrl("ctx_1", "https://app.example.com/orders");
    expect({ keepAlive: tracker.isEnabled("ctx_1"), sessionExpired: tracker.isExpired("ctx_1") }).toEqual({
      keepAlive: true,
      sessionExpired: false,
    });

    tracker.recordIntentionalUrl("ctx_1", "https://app.example.com/login");
    expect({ keepAlive: tracker.isEnabled("ctx_1"), sessionExpired: tracker.isExpired("ctx_1") }).toEqual({
      keepAlive: true,
      sessionExpired: false,
    });

    tracker.disable("ctx_1");
    expect({ keepAlive: tracker.isEnabled("ctx_1"), sessionExpired: tracker.isExpired("ctx_1") }).toEqual({
      keepAlive: false,
      sessionExpired: false,
    });
  });
});

describe("keep-alive through DaemonService", () => {
  let home: string;
  let driver: LiveCapableDriver;
  let service: DaemonService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atc-keepalive-"));
    const paths = resolvePaths({ ATC_HOME: home });
    const tabs: LiveTab[] = [
      { tabId: "macos:chrome:1:1", browser: "chrome", source: "macos", url: "https://app.example.com/work", title: "Work", active: true },
    ];
    driver = new LiveCapableDriver(tabs);
    const registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0101, 0x0202]) });
    service = new DaemonService({ registry, paths, env: {}, macosDriver: driver, driverFactory: () => driver });
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("enables keep-alive on bind --keep-alive and toggles via keepalive on/off/status", async () => {
    const bound = await service.handle({ method: "bind", params: { query: "Work", keepAlive: true } });
    expect(bound).toMatchObject({ ok: true, context: "ctx_0101", keepAlive: true });
    const [sessionId] = driver.sessionIds();
    expect(driver.state(sessionId ?? "").keepAlive).toBe(true);

    expect(await service.handle({ method: "keepalive", params: { mode: "status" } })).toEqual({
      ok: true,
      context: "ctx_0101",
      keepAlive: true,
      sessionExpired: false,
    });
    expect(await service.handle({ method: "bindings", params: {} })).toMatchObject({
      ok: true,
      bindings: [{ context: "ctx_0101", keepAlive: true }],
    });

    expect(await service.handle({ method: "keepalive", params: { mode: "off" } })).toEqual({
      ok: true,
      context: "ctx_0101",
      keepAlive: false,
      sessionExpired: false,
    });
    expect(driver.state(sessionId ?? "").keepAlive).toBe(false);

    expect(await service.handle({ method: "keepalive", params: {} })).toEqual({
      ok: true,
      context: "ctx_0101",
      keepAlive: false,
      sessionExpired: false,
    });
    expect(await service.handle({ method: "keepalive", params: { mode: "on" } })).toEqual({
      ok: true,
      context: "ctx_0101",
      keepAlive: true,
      sessionExpired: false,
    });
    expect(driver.state(sessionId ?? "").keepAlive).toBe(true);
  });

  it("fails closed with SESSION_EXPIRED on mutating actions after a background SSO redirect", async () => {
    await service.handle({ method: "open", params: { browser: "chromium" } });
    await service.handle({ method: "goto", params: { url: "https://app.example.com/home" } });
    await service.handle({ method: "keepalive", params: { mode: "on" } });

    const [sessionId] = driver.sessionIds();
    await driver.navigate({ sessionId: sessionId ?? "" }, "https://login.microsoftonline.com/common/oauth2/authorize");

    const blocked = await service.handle({ method: "click", params: { target: { kind: "role", role: "button", name: "Save" } } });
    expect(blocked).toMatchObject({ ok: false, error: "SESSION_EXPIRED" });

    expect(await service.handle({ method: "bindings", params: {} })).toMatchObject({
      ok: true,
      bindings: [{ context: "ctx_0101", keepAlive: true, sessionExpired: true }],
    });

    await driver.navigate({ sessionId: sessionId ?? "" }, "https://app.example.com/home");
    const recovered = await service.handle({ method: "click", params: { target: { kind: "role", role: "button", name: "Save" } } });
    expect(recovered).toMatchObject({ ok: true, context: "ctx_0101" });
  });

  it("returns UNSUPPORTED_ACTION when the underlying driver does not implement setKeepAlive", async () => {
    const bare = new FakeDriver("chromium") as unknown as Record<string, unknown>;
    bare.setKeepAlive = undefined;
    const paths = resolvePaths({ ATC_HOME: home });
    const registry = new ContextRegistry({ statePath: paths.state, random: sequenceRandom([0x0303]) });
    const svc = new DaemonService({
      registry,
      paths,
      env: {},
      driverFactory: () => bare as unknown as BrowserDriver,
    });
    await svc.handle({ method: "open", params: { browser: "chromium" } });
    const res = await svc.handle({ method: "keepalive", params: { mode: "on" } });
    expect(res).toMatchObject({ ok: false, error: "UNSUPPORTED_ACTION" });
  });
});
