/**
 * Keep-alive badge, row toggle button, and optimistic daemon mutation for
 * explicitly shared tabs in the side panel.
 */
globalThis.ATCUI = globalThis.ATCUI || {};

ATCUI.keepAliveBadge = function keepAliveBadge() {
  return ATCUI.makeBadge("badge-keepalive", "pulse", "Keep alive");
};

ATCUI.expiredBadge = function expiredBadge() {
  return ATCUI.makeBadge("badge-expired", "warning", "Sign-in needed");
};

ATCUI.keepAliveButton = function keepAliveButton(row) {
  const on = row.keepAlive === true;
  const label = on ? `Stop keeping ${row.title} alive` : `Keep ${row.title} session alive`;
  const title = on ? "Keep alive is on (click to turn off)" : "Keep tab awake and session alive while shared";
  const button = ATCUI.iconButton(row, "keepaliveTab", "keepalive", () => label, title, "pulse");
  button.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) button.classList.add("is-on");
  return button;
};

ATCUI.setSnapshotKeepAlive = function setSnapshotKeepAlive(context, enabled) {
  ATCUI.state.snapshot = {
    ...ATCUI.state.snapshot,
    bindings: ATCUI.state.snapshot.bindings.map((binding) =>
      binding.context === context ? { ...binding, keepAlive: enabled, ...(enabled ? { sessionExpired: false } : {}) } : binding,
    ),
  };
  ATCUI.renderAll();
};

ATCUI.keepAliveFailed = function keepAliveFailed(row, previous, reply) {
  ATCUI.state.snapshot = previous;
  ATCUI.renderAll();
  ATCUI.showToast(`Could not update keep-alive for “${row.title}”: ${reply.message || "atc did not respond."}`);
};

ATCUI.keepAliveSucceeded = async function keepAliveSucceeded(row, enabled) {
  const msg = enabled ? `Keeping “${row.title}” alive while shared.` : `Stopped keep-alive for “${row.title}”.`;
  ATCUI.showToast(msg);
  ATCUI.announce(msg);
  await ATCUI.refreshBindings();
  ATCUI.focusRow(row.id, "keepalive");
};

ATCUI.toggleKeepAlive = async function toggleKeepAlive(row) {
  if (row === null || !row.shared || typeof row.context !== "string") return;
  if (!ATCUI.canTalkToDaemon() || ATCUI.state.busy) return;
  const enabled = row.keepAlive !== true;
  const previous = ATCUI.state.snapshot;
  ATCUI.state.busy = true;
  ATCUI.setSnapshotKeepAlive(row.context, enabled);
  const reply = await ATCUI.sendOutcome("atc:keepalive", { context: row.context, enabled });
  ATCUI.state.busy = false;
  if (!reply.ok) return ATCUI.keepAliveFailed(row, previous, reply);
  await ATCUI.keepAliveSucceeded(row, enabled);
};
