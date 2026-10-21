/**
 * Self-contained browser DOM/ARIA evaluation scripts shared by the WebExtension
 * driver and the macOS live-tab driver.
 */
import type { Target } from "../contracts/types.js";
import { describeTarget } from "./target.js";

const PRELUDE = `
(() => {
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
        try { pushC(level === "warn" ? "warning" : level, args.map((a) => String(a)).join(" ")); } catch {}
        return orig.apply(this, args);
      };
    }
    window.addEventListener("error", (e) => pushC("pageerror", e.message || "error"));
    if (typeof window.fetch === "function") {
      const origFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? new URL(input, location.href).href : (input && input.url) || location.href;
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
})();
`;

const HELPERS = `
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
  if (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "button", "submit"].includes(el.type))) return "textbox";
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
  if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return (el.value || "").trim();
  return (el.textContent || "").replace(/\\s+/g, " ").trim();
}
`;

export const INSPECT_SCRIPT_BODY = `${PRELUDE}\n${HELPERS}`;
export const ACTION_SCRIPT_BODY = `${PRELUDE}\n${HELPERS}`;
export const LOGS_SCRIPT_BODY = PRELUDE;

export function buildInspectExpression(): string {
  return `(() => {
    ${PRELUDE}
    ${HELPERS}
    const lines = [];
    for (const el of document.body ? document.body.querySelectorAll("*") : []) {
      if (!isVisible(el)) continue;
      const role = implicitRole(el);
      const name = accessibleName(el);
      if (role === "heading" && name) lines.push("- heading " + JSON.stringify(name));
      else if (role === "button" && name) lines.push("- button " + JSON.stringify(name));
      else if (role === "link" && name) lines.push("- link " + JSON.stringify(name));
      else if (role === "textbox") lines.push("- textbox " + JSON.stringify(name) + (el.value ? ": " + JSON.stringify(el.value) : ""));
      else if (role === "combobox" && el instanceof HTMLSelectElement) {
        lines.push("- combobox " + JSON.stringify(name) + ":");
        for (const opt of el.options) {
          lines.push("  - option " + JSON.stringify(opt.label || opt.value) + (opt.selected ? " [selected]" : ""));
        }
      } else if (el.children.length === 0 && name) {
        lines.push("- text: " + name);
      }
    }
    return JSON.stringify({ url: location.href, title: document.title, aria: lines.join("\\n") });
  })()`;
}

export function buildActionExpression(action: "click" | "type" | "select", target: Target, value?: string): string {
  const payload = JSON.stringify({ action, target, value, label: describeTarget(target) });
  return `(() => {
    ${PRELUDE}
    ${HELPERS}
    const { action, target, value, label } = ${payload};
    const all = Array.from(document.querySelectorAll("*")).filter(isVisible);
    let matches = [];
    if (target.kind === "role") {
      matches = all.filter((el) => implicitRole(el) === target.role && (target.name === undefined || accessibleName(el) === target.name));
    } else if (target.kind === "label") {
      matches = all.filter((el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && labelForControl(el) === target.label);
    } else if (target.kind === "text") {
      matches = all.filter((el) => (el.textContent || "").replace(/\\s+/g, " ").trim() === target.text);
    } else if (target.kind === "placeholder") {
      matches = all.filter((el) => el.getAttribute("placeholder") === target.placeholder);
    } else if (target.kind === "testid") {
      matches = all.filter((el) => el.getAttribute("data-testid") === target.testid);
    } else if (target.kind === "selector") {
      matches = Array.from(document.querySelectorAll(target.selector)).filter(isVisible);
    }
    const count = matches.length;
    if (count === 0) return JSON.stringify({ ok: false, error: "TARGET_NOT_FOUND", message: "No visible element matches " + label, matched: 0 });
    if (target.nth === undefined && count > 1) {
      return JSON.stringify({ ok: false, error: "AMBIGUOUS_TARGET", message: count + " visible elements match " + label + "; pass --nth N (0-based) to pick one", matched: count });
    }
    const idx = target.nth ?? 0;
    if (idx < 0 || idx >= count) {
      return JSON.stringify({ ok: false, error: "TARGET_NOT_FOUND", message: "nth=" + idx + " is out of range (" + count + " matched)", matched: count });
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
        return JSON.stringify({ ok: false, error: "ACTION_FAILED", message: "Target " + label + " is not a <select> element" });
      }
      const opt = Array.from(chosen.options).find((o) => o.label === value) || Array.from(chosen.options).find((o) => o.value === value);
      if (!opt) {
        return JSON.stringify({ ok: false, error: "TARGET_NOT_FOUND", message: "No option matching label or value", matched: 0 });
      }
      chosen.value = opt.value;
      chosen.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return JSON.stringify({ ok: true, matched: 1 });
  })()`;
}

export function buildLogsExpression(kind: "console" | "network", sinceSeq: number): string {
  const key = kind === "console" ? "cItems" : "nItems";
  return `(() => {
    ${PRELUDE}
    const items = (window.__abt_logs && window.__abt_logs[${JSON.stringify(key)}]) || [];
    return JSON.stringify(items.filter((item) => item.seq > ${Number(sinceSeq)}));
  })()`;
}
