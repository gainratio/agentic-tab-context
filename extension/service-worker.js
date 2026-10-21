/**
 * Agentic Browser Tab — Manifest V3 Service Worker.
 * Syncs open browser tabs to the local `abt` daemon (127.0.0.1:43919) and
 * executes inspect, click, type, select, screenshot, and console/network queries
 * inside the user's already-open tab with zero eval() and zero global state.
 */

const BRIDGE_BASE = "http://127.0.0.1:43919";
const SYNC_ALARM = "abt-sync-tabs";

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.25 });
  await syncTabs();
  void ensurePollLoop();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.25 });
  await syncTabs();
  void ensurePollLoop();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_ALARM) {
    await syncTabs();
    void ensurePollLoop();
  }
});

chrome.tabs.onActivated.addListener(async () => {
  await syncTabs();
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    await syncTabs();
  }
});

chrome.tabs.onRemoved.addListener(async () => {
  await syncTabs();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === "abt:status") {
        const synced = await syncTabs();
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        sendResponse({ ok: true, connected: synced.ok, activeTab: activeTab ?? null, count: synced.count ?? 0 });
        return;
      }
      if (message?.type === "abt:bind-active") {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!activeTab || typeof activeTab.id !== "number") {
          sendResponse({ ok: false, error: "No active tab found" });
          return;
        }
        const synced = await syncTabs(activeTab.id);
        await chrome.action.setBadgeText({ text: "ON", tabId: activeTab.id });
        await chrome.action.setBadgeBackgroundColor({ color: "#10B981", tabId: activeTab.id });
        sendResponse({ ok: synced.ok, tabId: `ext:${ detectBrowserName() }:${ activeTab.id }`, context: synced.context });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
  return true;
});

function detectBrowserName() {
  const ua = navigator.userAgent || "";
  if (ua.includes("Edg/")) return "edge";
  if (ua.includes("Firefox/")) return "firefox";
  if (ua.includes("Safari/") && !ua.includes("Chrome/")) return "safari";
  return "chrome";
}

async function syncTabs(pinTabId) {
  try {
    const rawTabs = await chrome.tabs.query({});
    const browser = detectBrowserName();
    const tabs = rawTabs
      .filter((t) => typeof t.id === "number" && t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
      .map((t) => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        active: Boolean(t.active),
      }));
    const response = await fetch(`${BRIDGE_BASE}/bridge/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser, tabs, ...(typeof pinTabId === "number" ? { pinTabId } : {}) }),
    });
    if (!response.ok) {
      await chrome.storage.local.set({ abtConnected: false });
      return { ok: false, count: tabs.length };
    }
    const data = await response.json();
    await chrome.storage.local.set({ abtConnected: true, abtTabCount: tabs.length, abtLastSync: Date.now() });
    return { ok: true, count: tabs.length, context: data.context };
  } catch {
    await chrome.storage.local.set({ abtConnected: false });
    return { ok: false, count: 0 };
  }
}

async function ensurePollLoop() {
  const { abtPolling = false, abtPollStartedAt = 0 } = await chrome.storage.local.get(["abtPolling", "abtPollStartedAt"]);
  if (abtPolling && Date.now() - abtPollStartedAt < 20_000) return;
  await chrome.storage.local.set({ abtPolling: true, abtPollStartedAt: Date.now() });
  try {
    for (let i = 0; i < 6; i++) {
      await chrome.storage.local.set({ abtPollStartedAt: Date.now() });
      const res = await fetch(`${BRIDGE_BASE}/bridge/poll`);
      if (!res.ok) break;
      const body = await res.json();
      if (body && body.command) {
        await handleBridgeCommand(body.command);
      }
    }
  } catch {
    // Daemon is not running yet; alarm or tab event will retry.
  } finally {
    await chrome.storage.local.set({ abtPolling: false });
  }
}

async function handleBridgeCommand(cmd) {
  let outcome;
  try {
    const result = await executeTabCommand(cmd);
    outcome = { id: cmd.id, ok: true, result };
  } catch (error) {
    const errObj = error && typeof error === "object" ? error : {};
    outcome = {
      id: cmd.id,
      ok: false,
      error: errObj.code || "ACTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
      details: errObj.details || {},
    };
  }
  try {
    await fetch(`${BRIDGE_BASE}/bridge/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outcome),
    });
  } catch {
    // Ignore transient disconnect
  }
}

async function executeTabCommand(cmd) {
  const tabId = Number(cmd.tabId);
  const action = cmd.action;
  const payload = cmd.payload || {};

  if (action === "navigate") {
    await chrome.tabs.update(tabId, { url: String(payload.url || "about:blank") });
    return { ok: true };
  }
  if (action === "reload") {
    await chrome.tabs.reload(tabId);
    return { ok: true };
  }
  if (action === "back") {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => history.back(),
    });
    return { ok: true };
  }
  if (action === "forward") {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => history.forward(),
    });
    return { ok: true };
  }
  if (action === "location") {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || "", title: tab.title || "" };
  }
  if (action === "screenshot") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }
  if (action === "eval") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: runInPageDomOperation,
      args: [payload],
    });
    return result;
  }
  throw new Error(`Unsupported command action: ${action}`);
}

function runInPageDomOperation(payload) {
  if (!window.__abt_logs) {
    const cap = 500;
    const cItems = [];
    const nItems = [];
    let cSeq = 1;
    let nSeq = 1;
    const pushC = (type, text) => {
      cItems.push({ seq: cSeq++, type, text: String(text), url: location.href, at: new Date().toISOString() });
      if (cItems.length > cap) cItems.shift();
    };
    const pushN = (entry) => {
      nItems.push({ seq: nSeq++, ...entry, at: new Date().toISOString() });
      if (nItems.length > cap) nItems.shift();
    };
    for (const level of ["log", "warn", "error", "info"]) {
      const orig = console[level];
      console[level] = function (...args) {
        try {
          pushC(level === "warn" ? "warning" : level, args.map((a) => String(a)).join(" "));
        } catch {}
        return orig.apply(this, args);
      };
    }
    window.addEventListener("error", (e) => pushC("pageerror", e.message || "error"));
    if (typeof window.fetch === "function") {
      const origFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url =
          typeof input === "string" ? new URL(input, location.href).href : (input && input.url) || location.href;
        const method = (init && init.method) || "GET";
        try {
          const res = await origFetch.apply(this, arguments);
          pushN({ method, url, resourceType: "fetch", status: res.status });
          return res;
        } catch (err) {
          pushN({ method, url, resourceType: "fetch", failure: String(err) });
          throw err;
        }
      };
    }
    window.__abt_logs = { cItems, nItems };
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest("[hidden], [aria-hidden='true']")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function implicitRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(el.type))) return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "button", "submit"].includes(el.type)))
      return "textbox";
    if (tag === "input" && el.type === "checkbox") return "checkbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    return "";
  }
  function labelForControl(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.id) {
      const lbl = document.querySelector("label[for=" + JSON.stringify(el.id) + "]");
      if (lbl) return (lbl.textContent || "").trim();
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      for (const c of clone.querySelectorAll("input,select,textarea,button")) c.remove();
      return (clone.textContent || "").trim();
    }
    return "";
  }
  function accessibleName(el) {
    const lbl = labelForControl(el);
    if (lbl) return lbl;
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type))
      return (el.value || "").trim();
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  if (payload.op === "logs") {
    const key = payload.kind === "console" ? "cItems" : "nItems";
    const items = (window.__abt_logs && window.__abt_logs[key]) || [];
    return JSON.stringify(items.filter((item) => item.seq > Number(payload.sinceSeq || 0)));
  }

  if (payload.op === "act") {
    const { action, target, value, label } = payload;
    const all = Array.from(document.querySelectorAll("*")).filter(isVisible);
    let matches = [];
    if (target.kind === "role") {
      matches = all.filter(
        (el) => implicitRole(el) === target.role && (target.name === undefined || accessibleName(el) === target.name),
      );
    } else if (target.kind === "label") {
      matches = all.filter(
        (el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && labelForControl(el) === target.label,
      );
    } else if (target.kind === "text") {
      matches = all.filter((el) => (el.textContent || "").replace(/\s+/g, " ").trim() === target.text);
    } else if (target.kind === "placeholder") {
      matches = all.filter((el) => el.getAttribute("placeholder") === target.placeholder);
    } else if (target.kind === "testid") {
      matches = all.filter((el) => el.getAttribute("data-testid") === target.testid);
    } else if (target.kind === "selector") {
      matches = Array.from(document.querySelectorAll(target.selector)).filter(isVisible);
    }
    const count = matches.length;
    if (count === 0)
      return JSON.stringify({
        ok: false,
        error: "TARGET_NOT_FOUND",
        message: "No visible element matches " + label,
        matched: 0,
      });
    if (target.nth === undefined && count > 1) {
      return JSON.stringify({
        ok: false,
        error: "AMBIGUOUS_TARGET",
        message: count + " visible elements match " + label + "; pass --nth N (0-based) to pick one",
        matched: count,
      });
    }
    const idx = target.nth ?? 0;
    if (idx < 0 || idx >= count) {
      return JSON.stringify({
        ok: false,
        error: "TARGET_NOT_FOUND",
        message: "nth=" + idx + " is out of range (" + count + " matched)",
        matched: count,
      });
    }
    const chosen = matches[idx];
    if (action === "click") {
      chosen.click();
    } else if (action === "type") {
      chosen.focus();
      chosen.value = value;
      chosen.dispatchEvent(new Event("input", { bubbles: true }));
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (action === "select") {
      if (!(chosen instanceof HTMLSelectElement)) {
        return JSON.stringify({
          ok: false,
          error: "ACTION_FAILED",
          message: "Target " + label + " is not a <select> element",
        });
      }
      const opt =
        Array.from(chosen.options).find((o) => o.label === value) ||
        Array.from(chosen.options).find((o) => o.value === value);
      if (!opt) {
        return JSON.stringify({
          ok: false,
          error: "TARGET_NOT_FOUND",
          message: "No option matching label or value",
          matched: 0,
        });
      }
      chosen.value = opt.value;
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return JSON.stringify({ ok: true, matched: 1 });
  }

  const lines = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (!isVisible(el)) continue;
    const role = implicitRole(el);
    const name = accessibleName(el);
    if (role === "heading" && name) lines.push("- heading " + JSON.stringify(name));
    else if (role === "button" && name) lines.push("- button " + JSON.stringify(name));
    else if (role === "link" && name) lines.push("- link " + JSON.stringify(name));
    else if (role === "textbox")
      lines.push("- textbox " + JSON.stringify(name) + (el.value ? ": " + JSON.stringify(el.value) : ""));
    else if (role === "combobox" && el instanceof HTMLSelectElement) {
      lines.push("- combobox " + JSON.stringify(name) + ":");
      for (const opt of el.options) {
        lines.push("  - option " + JSON.stringify(opt.label || opt.value) + (opt.selected ? " [selected]" : ""));
      }
    } else if (el.children.length === 0 && name) {
      lines.push("- text: " + name);
    }
  }
  return JSON.stringify({ url: location.href, title: document.title, aria: lines.join("\n") });
}
