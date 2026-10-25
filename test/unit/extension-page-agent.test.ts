import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class Input {
  readonly tagName = "INPUT";
  type = "password";
  readonly value = "PASSWORD_SENTINEL";
  readonly id = "";
  readonly children: unknown[] = [];
  getAttribute(name: string) { return name === "type" ? this.type : name === "aria-label" ? "Password" : null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
}

interface Agent {
  version: number;
  store: { watching: boolean; console: unknown[]; network: unknown[] };
  run(op: Record<string, unknown>): { aria?: string; ok?: boolean } & unknown[];
}

function agentHarness() {
  const source = ["page-agent-watch.js", "page-agent-actions.js", "page-agent.js"].map((name) => readFileSync(join(import.meta.dirname, "../../extension", name), "utf8")).join("\n");
  const listeners = new Set<unknown>();
  const input = new Input();
  const originalCalls: unknown[][] = [];
  const originalLog = (...args: unknown[]) => { originalCalls.push(args); };
  const originalFetch = async () => ({ status: 200 });
  const context = vm.createContext({
    URL, Element: Input, HTMLInputElement: Input, HTMLSelectElement: class {}, CSS: { escape: (value: string) => value },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    document: { title: "Login", body: { querySelectorAll: () => [input] }, querySelector: () => null },
    location: { href: "https://example.test/" }, fetch: originalFetch,
    console: { log: originalLog, info: originalLog, warn: originalLog, error: originalLog },
    addEventListener: (_name: string, fn: unknown) => listeners.add(fn), removeEventListener: (_name: string, fn: unknown) => listeners.delete(fn),
  });
  vm.runInContext(source, context);
  return { context, source, input, listeners, originalLog, originalCalls, originalFetch, agent: context.__atcAgent as Agent };
}

describe("shared page agent privacy and capture lifetime", () => {
  it("omits the existing value of a password input", () => {
    const h = agentHarness();
    const result = h.agent.run({ op: "inspect" });
    expect(result.aria).toContain("Password");
    expect(result.aria).not.toContain("PASSWORD_SENTINEL");
  });

  it("keeps an observed password redacted after the same input is revealed", () => {
    const h = agentHarness();
    expect(h.agent.run({ op: "inspect" }).aria).not.toContain("PASSWORD_SENTINEL");
    h.input.type = "text";
    vm.runInContext(h.source, h.context);
    expect(h.agent.run({ op: "inspect" }).aria).not.toContain("PASSWORD_SENTINEL");
  });

  it("stops capture, restores hooks and clears buffers on unwatch", () => {
    const h = agentHarness();
    h.agent.run({ op: "watch" });
    vm.runInContext('console.log("bound")', h.context);
    expect(h.agent.store.console).toHaveLength(1);
    expect(h.agent.run({ op: "unwatch" })).toEqual({ ok: true });
    expect(h.context.console.log).toBe(h.originalLog);
    expect(h.context.fetch).toBe(h.originalFetch);
    expect(h.listeners.size).toBe(0);
    vm.runInContext('console.log("unbound")', h.context);
    expect(h.agent.run({ op: "logs", kind: "console", since: 0 })).toEqual([]);
    expect(h.agent.store.watching).toBe(false);
  });

  it("does not duplicate logs if the page wrapped a previous capture hook", () => {
    const h = agentHarness();
    h.agent.run({ op: "watch" });
    vm.runInContext('const previous = console.log; console.log = (...args) => previous(...args);', h.context);
    h.agent.run({ op: "unwatch" });
    h.agent.run({ op: "watch" });
    vm.runInContext('console.log("new binding")', h.context);
    expect(h.agent.store.console).toHaveLength(1);
  });

  it("preserves console calls whose arguments cannot be converted to strings", () => {
    const h = agentHarness();
    h.agent.run({ op: "watch" });
    expect(() => vm.runInContext('console.log(Object.create(null))', h.context)).not.toThrow();
    expect(h.originalCalls).toHaveLength(1);
    expect(Object.getPrototypeOf(h.originalCalls[0]?.[0])).toBeNull();
    expect(h.agent.store.console).toHaveLength(1);
  });

  it("ignores a fetch started by an earlier binding after rewatch", async () => {
    const h = agentHarness();
    let release!: () => void;
    h.context.fetch = () => new Promise((resolve) => { release = () => resolve({ status: 200 }); });
    h.agent.run({ op: "watch" });
    const pending = vm.runInContext('fetch("/old-binding")', h.context) as Promise<unknown>;
    h.agent.run({ op: "unwatch" });
    h.agent.run({ op: "watch" });
    release();
    await pending;
    expect(h.agent.store.network).toEqual([]);
  });

  it("requires reload when legacy capture hooks cannot be safely removed", () => {
    const h = agentHarness();
    const prior = { version: 1, store: { watching: true, console: ["old"], network: ["old"] }, record() {}, run() {} };
    h.context.__atcAgent = prior;
    expect(() => vm.runInContext(h.source, h.context)).toThrow(/ATC_RELOAD_REQUIRED/);
    expect(prior.store.console).toEqual([]);
    expect(prior.store.network).toEqual([]);
    expect(() => vm.runInContext(h.source, h.context)).toThrow(/ATC_RELOAD_REQUIRED/);
  });
});
