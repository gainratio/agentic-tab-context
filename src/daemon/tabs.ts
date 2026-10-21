/**
 * Live tab discovery, filtering, and deterministic selection for `tabs` and `bind`.
 */
import { TabCtxError } from "../contracts/errors.js";
import type { BindOptions, BrowserDriver, BrowserName, LiveTab } from "../contracts/types.js";
import type { ContextRegistry } from "./registry.js";

export interface TabCollectorDeps {
  registry: ContextRegistry;
  drivers: ReadonlyMap<BrowserName, BrowserDriver>;
  extensionDriver?: BrowserDriver;
  macosDriver?: BrowserDriver;
}

export async function collectAllTabs(deps: TabCollectorDeps): Promise<LiveTab[]> {
  const extTabs = (await deps.extensionDriver?.listTabs?.().catch(() => [])) ?? [];
  const extBrowsers = new Set(extTabs.map((t) => t.browser));
  const managedTabs = await collectManagedTabs(deps.registry, deps.drivers);
  const macosTabs = ((await deps.macosDriver?.listTabs?.().catch(() => [])) ?? []).filter(
    (t) => !extBrowsers.has(t.browser),
  );
  return attachContextIds(deps.registry, [...extTabs, ...managedTabs, ...macosTabs]);
}

async function collectManagedTabs(
  registry: ContextRegistry,
  drivers: ReadonlyMap<BrowserName, BrowserDriver>,
): Promise<LiveTab[]> {
  const out: LiveTab[] = [];
  const seenDrivers = new Set<BrowserDriver>();
  for (const driver of drivers.values()) {
    if (seenDrivers.has(driver)) continue;
    seenDrivers.add(driver);
    if (driver.listTabs !== undefined) {
      out.push(...(await driver.listTabs().catch(() => [])));
    }
  }
  if (out.length === 0) {
    for (const ctx of registry.list()) {
      if (ctx.status !== "open" || ctx.source === "extension" || ctx.source === "macos") continue;
      out.push({
        tabId: ctx.tabId ?? `managed:${ctx.browser}:${ctx.id}:0`,
        browser: ctx.browser,
        source: "managed",
        url: ctx.url ?? "about:blank",
        title: ctx.title ?? "",
        active: registry.current === ctx.id,
        context: ctx.id,
      });
    }
  }
  return out;
}

function attachContextIds(registry: ContextRegistry, tabs: LiveTab[]): LiveTab[] {
  const open = registry.list().filter((c) => c.status === "open");
  return tabs.map((tab) => {
    if (tab.context !== undefined) return tab;
    const match = open.find((c) => c.tabId === tab.tabId || (c.source === undefined && c.url === tab.url && c.browser === tab.browser));
    return match === undefined ? tab : { ...tab, context: match.id };
  });
}

export function filterTabs(tabs: readonly LiveTab[], filter: BindOptions): LiveTab[] {
  return tabs.filter((tab) => matchesFilter(tab, filter));
}

function matchesFilter(tab: LiveTab, filter: BindOptions): boolean {
  if (filter.tab !== undefined && tab.tabId !== filter.tab) return false;
  if (filter.browser !== undefined && tab.browser !== filter.browser) return false;
  if (filter.active === true && !tab.active) return false;
  if (filter.url !== undefined && !includesIgnoreCase(tab.url, filter.url)) return false;
  if (filter.title !== undefined && !includesIgnoreCase(tab.title, filter.title)) return false;
  if (filter.query !== undefined) {
    const q = filter.query;
    if (!includesIgnoreCase(tab.url, q) && !includesIgnoreCase(tab.title, q)) return false;
  }
  return true;
}

function includesIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Deterministic selection for `bind`:
 * 1. Exact 1 filtered candidate => pick it.
 * 2. Exact URL or title match among candidates => pick it if unique.
 * 3. Active tab among candidates (preferring extension > managed > macos) => pick it if unique.
 * 4. Otherwise fail with AMBIGUOUS_TARGET and return `candidates` so the caller never guesses.
 */
export function selectTabToBind(tabs: readonly LiveTab[], filter: BindOptions): LiveTab {
  const candidates = filterTabs(tabs, filter);
  if (candidates.length === 0) {
    throw new TabCtxError("TARGET_NOT_FOUND", "No open browser tab matches the requested filter", { matched: 0 });
  }
  if (candidates.length === 1 && candidates[0] !== undefined) return candidates[0];

  const exact = pickUniqueExactMatch(candidates, filter);
  if (exact !== undefined) return exact;

  const active = pickUniqueActiveMatch(candidates);
  if (active !== undefined) return active;

  throw new TabCtxError(
    "AMBIGUOUS_TARGET",
    `${candidates.length} open browser tabs match; pass --tab <tabId> (from 'abt tabs') to pick one`,
    { matched: candidates.length, candidates },
  );
}

function pickUniqueExactMatch(candidates: readonly LiveTab[], filter: BindOptions): LiveTab | undefined {
  const needle = (filter.query ?? filter.url ?? filter.title ?? "").toLowerCase();
  if (needle === "") return undefined;
  const exact = candidates.filter((t) => t.url.toLowerCase() === needle || t.title.toLowerCase() === needle);
  return exact.length === 1 ? exact[0] : undefined;
}

function pickUniqueActiveMatch(candidates: readonly LiveTab[]): LiveTab | undefined {
  const active = candidates.filter((t) => t.active);
  if (active.length === 1) return active[0];
  for (const source of ["extension", "managed", "macos"] as const) {
    const bySource = active.filter((t) => t.source === source);
    if (bySource.length === 1) return bySource[0];
  }
  return undefined;
}
