/**
 * atc page agent: the single source of in-page logic (inspect, act, console and
 * network capture). The browser extension injects this file with
 * chrome.scripting; the macOS driver evaluates it through Apple Events.
 * It defines `globalThis.__atcAgent` and is safe to inject repeatedly.
 */
globalThis.__atcAgent =
  globalThis.__atcAgent && globalThis.__atcAgent.version === 1
    ? globalThis.__atcAgent
    : {
        version: 1,
        store: { console: [], network: [], seq: 0, watching: false },
        cap: 500,

        run(op) {
          if (op.op === "inspect") return this.inspect();
          if (op.op === "act") return this.act(op);
          if (op.op === "watch") return this.watch();
          if (op.op === "logs") return this.logs(op.kind, op.since);
          return { ok: false, error: "INVALID_ARGUMENT", message: "unknown page operation" };
        },

        visible(el) {
          if (!(el instanceof Element) || el.closest("[hidden], [aria-hidden='true']")) return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        },

        role(el) {
          const explicit = el.getAttribute("role");
          if (explicit) return explicit;
          const tag = el.tagName.toLowerCase();
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type))) return "button";
          if (tag === "a" && el.hasAttribute("href")) return "link";
          if (tag === "select") return "combobox";
          if (tag === "input" && (type === "checkbox" || type === "radio")) return type;
          if (tag === "textarea" || tag === "input") return "textbox";
          return /^h[1-6]$/.test(tag) ? "heading" : "";
        },

        label(el) {
          const aria = el.getAttribute("aria-label");
          if (aria) return aria.trim();
          const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
          if (byFor) return (byFor.textContent || "").trim();
          const wrapping = el.closest("label");
          if (!wrapping) return "";
          const clone = wrapping.cloneNode(true);
          for (const control of clone.querySelectorAll("input,select,textarea,button")) control.remove();
          return (clone.textContent || "").trim();
        },

        name(el) {
          const label = this.label(el);
          if (label) return label;
          if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return el.value.trim();
          return this.text(el);
        },

        text(el) {
          return (el.textContent || "").replace(/\s+/g, " ").trim();
        },

        describe(el) {
          const role = this.role(el);
          const name = JSON.stringify(this.name(el));
          if (role === "textbox") return [`- textbox ${name}${el.value ? `: ${JSON.stringify(el.value)}` : ""}`];
          if (role === "combobox" && el instanceof HTMLSelectElement) {
            const options = [...el.options].map((o) => `  - option ${JSON.stringify(o.label || o.value)}${o.selected ? " [selected]" : ""}`);
            return [`- combobox ${name}:`, ...options];
          }
          if (["heading", "button", "link", "checkbox", "radio"].includes(role) && this.name(el)) return [`- ${role} ${name}`];
          return el.children.length === 0 && this.text(el) ? [`- text: ${this.text(el)}`] : [];
        },

        inspect() {
          const elements = document.body ? [...document.body.querySelectorAll("*")] : [];
          const lines = elements.filter((el) => this.visible(el)).flatMap((el) => this.describe(el));
          return { url: location.href, title: document.title, aria: lines.join("\n") };
        },

        candidates(target) {
          if (target.kind === "selector") return [...document.querySelectorAll(target.selector)];
          const all = [...document.querySelectorAll("*")];
          if (target.kind === "role") {
            return all.filter((el) => this.role(el) === target.role && (target.name === undefined || this.name(el) === target.name));
          }
          if (target.kind === "label") return all.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && this.label(el) === target.label);
          if (target.kind === "text") return all.filter((el) => this.text(el) === target.text);
          const attribute = target.kind === "placeholder" ? "placeholder" : "data-testid";
          return all.filter((el) => el.getAttribute(attribute) === target[target.kind]);
        },

        pick(target, label) {
          const matches = this.candidates(target).filter((el) => this.visible(el));
          const count = matches.length;
          if (count === 0) return { error: "TARGET_NOT_FOUND", message: `no visible element matches ${label}`, matched: 0 };
          if (target.nth === undefined && count > 1) {
            return { error: "AMBIGUOUS_TARGET", message: `${count} visible elements match ${label}; pass --nth N (0-based)`, matched: count };
          }
          const index = target.nth ?? 0;
          if (index >= count) return { error: "TARGET_NOT_FOUND", message: `nth=${index} is out of range (${count} matched)`, matched: count };
          return { element: matches[index] };
        },

        act(op) {
          const picked = this.pick(op.target, op.label);
          if (!picked.element) return { ok: false, ...picked };
          const el = picked.element;
          if (op.action === "click") el.click();
          if (op.action === "type") this.fill(el, op.value);
          if (op.action === "select") return this.choose(el, op.value, op.label);
          return { ok: true, matched: 1 };
        },

        fill(el, value) {
          el.focus();
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },

        choose(el, value, label) {
          if (!(el instanceof HTMLSelectElement)) return { ok: false, error: "ACTION_FAILED", message: `${label} is not a <select>` };
          const options = [...el.options];
          const option = options.find((o) => o.label === value) || options.find((o) => o.value === value);
          if (!option) return { ok: false, error: "TARGET_NOT_FOUND", message: `${label} has no option matching the value`, matched: 0 };
          el.value = option.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, matched: 1 };
        },

        record(kind, entry) {
          const list = this.store[kind];
          this.store.seq += 1;
          list.push({ seq: this.store.seq, ...entry, at: new Date().toISOString() });
          if (list.length > this.cap) list.shift();
        },

        watch() {
          if (this.store.watching) return { ok: true };
          this.store.watching = true;
          this.hookConsole();
          this.hookFetch();
          addEventListener("error", (e) => this.record("console", { type: "pageerror", text: e.message || "error", url: location.href }));
          return { ok: true };
        },

        hookConsole() {
          const agent = this;
          for (const level of ["log", "info", "warn", "error"]) {
            const original = console[level];
            console[level] = function (...args) {
              agent.record("console", { type: level === "warn" ? "warning" : level, text: args.map(String).join(" "), url: location.href });
              return original.apply(this, args);
            };
          }
        },

        hookFetch() {
          if (typeof fetch !== "function") return;
          const agent = this;
          const original = fetch;
          globalThis.fetch = async function (input, init) {
            const url = new URL(typeof input === "string" ? input : (input && input.url) || location.href, location.href).href;
            const method = (init && init.method) || "GET";
            try {
              const response = await original.apply(this, [input, init]);
              agent.record("network", { method, url, resourceType: "fetch", status: response.status });
              return response;
            } catch (error) {
              agent.record("network", { method, url, resourceType: "fetch", failure: String(error) });
              throw error;
            }
          };
        },

        logs(kind, since) {
          this.watch();
          return this.store[kind === "network" ? "network" : "console"].filter((entry) => entry.seq > since);
        },
      };
