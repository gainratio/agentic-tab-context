/** Keypress and file-upload actions for the page agent. Kept out of
 * page-agent.js so each source file stays inside the project's size gate. */
globalThis.__atcActions = {
  press(agent, op) {
    const key = this.key(op.key);
    if (key === "") return { ok: false, error: "INVALID_ARGUMENT", message: `unsupported key ${JSON.stringify(String(op.key || ""))}` };
    const active = document.activeElement;
    const target = active && active !== document.body ? active : document.body;
    const init = { key, bubbles: true, cancelable: true };
    const notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", init));
    this.pressDefault(key, target, notPrevented);
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true, matched: 1 };
  },
  key(raw) {
    const value = String(raw || "");
    const allowed = ["Enter", "Escape", "Tab", " ", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    return allowed.includes(value) ? value : "";
  },
  pressDefault(key, target, notPrevented) {
    const button = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
    if (notPrevented && key === "Enter" && button) target.click();
    else if (notPrevented && key === "Enter" && target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
    else if (notPrevented && key === " " && target instanceof HTMLButtonElement) target.click();
    else if (key === "Tab") this.tab(target);
  },
  tab(target) {
    const selector = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    const focusable = [...document.querySelectorAll(selector)].filter((el) => !el.disabled && el.getClientRects().length > 0);
    const next = focusable[(focusable.indexOf(target) + 1) % focusable.length];
    if (next) next.focus();
  },
  upload(agent, op) {
    const picked = agent.pick(op.target, op.label);
    if (!picked.element) return { ok: false, ...picked };
    const el = picked.element;
    if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, error: "ACTION_FAILED", message: "target is not a file input" };
    const transfer = new DataTransfer();
    for (const entry of op.files || []) {
      const bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], entry.name, { type: entry.type || "application/octet-stream" }));
    }
    el.files = transfer.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, matched: 1 };
  },
};
