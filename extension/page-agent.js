/**
 * atc page agent: the single source of in-page logic (inspect, act, console and
 * network capture). The browser extension injects this file with
 * chrome.scripting; the macOS driver evaluates it through Apple Events.
 * It defines `globalThis.__atcAgent` and is safe to inject repeatedly.
 */
globalThis.__atcWatch.checkUpgrade(globalThis.__atcAgent);
globalThis.__atcAgent =
  globalThis.__atcAgent && globalThis.__atcAgent.version === 3
    ? globalThis.__atcAgent
    : {
        version: 3,
        store: globalThis.__atcAgent?.store ?? { console: [], network: [], seq: 0, watching: false },
        pressKeys: ["Enter", "Escape", "Tab", " ", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"],
        cap: 500,

        run(op) {
          if (op.op === "inspect") return this.inspect();
          if (op.op === "act") return this.act(op);
          if (op.op === "press") return this.press(op);
          if (op.op === "watch") return this.watch();
          if (op.op === "unwatch") return this.unwatch();
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
          const byFor = el.id ? el.getRootNode().querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
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
          if (this.password(el)) return [`- textbox ${name} [redacted]`];
          if (role === "textbox") return [`- textbox ${name}${el.value ? `: ${JSON.stringify(el.value)}` : ""}`];
          if (role === "combobox" && el instanceof HTMLSelectElement) {
            const options = [...el.options].map((o) => `  - option ${JSON.stringify(o.label || o.value)}${o.selected ? " [selected]" : ""}`);
            return [`- combobox ${name}:`, ...options];
          }
          if (["heading", "button", "link", "checkbox", "radio"].includes(role) && this.name(el)) return [`- ${role} ${name}`];
          return el.children.length === 0 && this.text(el) ? [`- text: ${this.text(el)}`] : [];
        },
        inspect() {
          const lines = this.elements(document.body).filter((el) => this.visible(el)).flatMap((el) => this.describe(el));
          return { url: location.href, title: document.title, aria: lines.join("\n") };
        },
        elements(root = document) {
          const elements = root ? [...root.querySelectorAll("*")] : [];
          for (const el of [...elements]) {
            if (el.shadowRoot) elements.push(...this.elements(el.shadowRoot));
          }
          return elements;
        },
        candidates(target) {
          const matches = this.matchKind(target, this.elements());
          return target.within === undefined ? matches : this.within(matches, target.within);
        },
        matchKind(target, all) {
          if (target.kind === "selector") return all.filter((el) => el.matches(target.selector));
          if (target.kind === "role") return this.matchRole(target, all);
          if (target.kind === "label") return all.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && this.label(el) === target.label);
          if (target.kind === "text") return all.filter((el) => this.text(el) === target.text);
          const attribute = target.kind === "placeholder" ? "placeholder" : "data-testid";
          return all.filter((el) => el.getAttribute(attribute) === target[target.kind]);
        },
        matchRole(target, all) {
          const byRole = all.filter((el) => this.role(el) === target.role);
          if (target.name === undefined) return byRole;
          const exact = byRole.filter((el) => this.name(el) === target.name);
          return exact.length > 0 ? exact : this.nameFallback(byRole, target.name);
        },
        within(matches, text) {
          const needle = text.toLowerCase();
          const containers = this.elements().filter((el) => this.visible(el) && this.text(el).toLowerCase().includes(needle));
          return matches.filter((el) => containers.some((container) => container !== el && container.contains(el)));
        },
        nameFallback(byRole, wanted) {
          const needle = this.normalizeName(wanted);
          if (needle.length < 6) return [];
          return byRole.filter((el) => this.normalizeName(this.name(el)).includes(needle));
        },
        normalizeName(value) {
          return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
        press(op) {
          const key = this.pressKey(op.key);
          if (key === "") return { ok: false, error: "INVALID_ARGUMENT", message: `unsupported key ${JSON.stringify(String(op.key || ""))}` };
          const active = document.activeElement;
          const target = active && active !== document.body ? active : document.body;
          const init = { key, bubbles: true, cancelable: true };
          const notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", init));
          this.pressDefault(key, target, notPrevented);
          target.dispatchEvent(new KeyboardEvent("keyup", init));
          return { ok: true, matched: 1 };
        },
        pressKey(raw) {
          const key = String(raw || "");
          return this.pressKeys.includes(key) ? key : "";
        },
        pressDefault(key, target, notPrevented) {
          const button = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
          if (notPrevented && key === "Enter" && button) target.click();
          else if (notPrevented && key === "Enter" && target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
          else if (notPrevented && key === " " && target instanceof HTMLButtonElement) target.click();
          else if (key === "Tab") this.pressTab(target);
        },
        pressTab(target) {
          const selector = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
          const focusable = [...document.querySelectorAll(selector)].filter((el) => !el.disabled && el.getClientRects().length > 0);
          const next = focusable[(focusable.indexOf(target) + 1) % focusable.length];
          if (next) next.focus();
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
        password(el) {
          if (!(el instanceof HTMLInputElement)) return false;
          const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
          this.passwords ??= new WeakSet();
          if (el.type === "password" || tokens.some((value) => ["current-password", "new-password"].includes(value))) this.passwords.add(el);
          return this.passwords.has(el);
        },
        watch() {
          return globalThis.__atcWatch.start(this);
        },
        unwatch() {
          return globalThis.__atcWatch.stop(this);
        },
        logs(kind, since) {
          return this.store[kind === "network" ? "network" : "console"].filter((entry) => entry.seq > since);
        },
      };
