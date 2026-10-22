/** Restorable capture hooks shared by the extension and macOS page agent. */
globalThis.__atcWatch = {
  checkUpgrade(agent) {
    if (!agent || agent.version === 2) return;
    if (agent.reloadRequired || (agent.store?.watching && typeof agent.unwatch !== "function")) {
      this.disableLegacy(agent);
      throw new Error("ATC_RELOAD_REQUIRED: Reload this tab before binding it again; old capture hooks cannot be safely removed.");
    }
    if (typeof agent.unwatch === "function") agent.unwatch();
  },

  disableLegacy(agent) {
    agent.record = () => {};
    agent.reloadRequired = true;
    if (agent.store) Object.assign(agent.store, { watching: false, console: [], network: [], seq: 0 });
  },

  start(agent) {
    if (agent.store.watching) return { ok: true };
    agent.captureEpoch = (agent.captureEpoch || 0) + 1;
    agent.store.watching = true;
    const hooks = { console: [] };
    agent.captureHooks = hooks;
    this.hookConsole(agent, hooks);
    this.hookFetch(agent, hooks);
    this.hookErrors(agent, hooks);
    return { ok: true };
  },

  stop(agent) {
    agent.store.watching = false;
    agent.captureEpoch = (agent.captureEpoch || 0) + 1;
    this.restore(agent.captureHooks);
    agent.captureHooks = null;
    Object.assign(agent.store, { console: [], network: [], seq: 0 });
    return { ok: true };
  },

  record(agent, kind, entry, epoch) {
    if (!agent.store.watching || epoch !== agent.captureEpoch) return;
    const list = agent.store[kind];
    agent.store.seq += 1;
    list.push({ seq: agent.store.seq, ...entry, at: new Date().toISOString() });
    if (list.length > agent.cap) list.shift();
  },

  hookConsole(agent, hooks) {
    for (const level of ["log", "info", "warn", "error"]) {
      const original = console[level];
      const wrapped = this.wrapConsole(agent, level, original, agent.captureEpoch);
      hooks.console.push({ level, original, wrapped });
      console[level] = wrapped;
    }
  },

  wrapConsole(agent, level, original, epoch) {
    return function (...args) {
      try {
        const text = args.map((value) => globalThis.__atcWatch.consoleText(value)).join(" ");
        globalThis.__atcWatch.record(agent, "console", { type: level === "warn" ? "warning" : level, text, url: location.href }, epoch);
      } catch {
        // Capture must not prevent the page's own console call.
      }
      return original.apply(this, args);
    };
  },

  consoleText(value) {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  },

  hookFetch(agent, hooks) {
    if (typeof fetch !== "function") return;
    const original = fetch;
    const wrapped = this.wrapFetch(agent, original, agent.captureEpoch);
    hooks.fetch = { original, wrapped };
    globalThis.fetch = wrapped;
  },

  wrapFetch(agent, original, epoch) {
    return function (input, init) {
      return globalThis.__atcWatch.fetchCall(agent, original, epoch, this, input, init);
    };
  },

  async fetchCall(agent, original, epoch, receiver, input, init) {
    const url = new URL(typeof input === "string" ? input : (input && input.url) || location.href, location.href).href;
    const method = (init && init.method) || (input && input.method) || "GET";
    try {
      const response = await original.apply(receiver, [input, init]);
      this.record(agent, "network", { method, url, resourceType: "fetch", status: response.status }, epoch);
      return response;
    } catch (error) {
      this.record(agent, "network", { method, url, resourceType: "fetch", failure: String(error) }, epoch);
      throw error;
    }
  },

  hookErrors(agent, hooks) {
    const epoch = agent.captureEpoch;
    hooks.error = (event) => this.record(agent, "console", { type: "pageerror", text: event.message || "error", url: location.href }, epoch);
    addEventListener("error", hooks.error);
  },

  restore(hooks) {
    if (!hooks) return;
    for (const { level, original, wrapped } of hooks.console) {
      if (console[level] === wrapped) console[level] = original;
    }
    if (hooks.fetch && globalThis.fetch === hooks.fetch.wrapped) globalThis.fetch = hooks.fetch.original;
    if (hooks.error) removeEventListener("error", hooks.error);
  },
};
