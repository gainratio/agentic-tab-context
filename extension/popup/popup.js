document.addEventListener("DOMContentLoaded", async () => {
  const statusDot = document.getElementById("status-dot");
  const statusBadge = document.getElementById("status-badge");
  const tabTitle = document.getElementById("tab-title");
  const tabUrl = document.getElementById("tab-url");
  const bindBtn = document.getElementById("bind-btn");
  const feedback = document.getElementById("feedback");

  async function refreshStatus() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "abt:status" });
      if (response && response.connected) {
        statusDot.classList.add("connected");
        statusBadge.textContent = `Daemon Ready (${response.count} tabs)`;
      } else {
        statusDot.classList.remove("connected");
        statusBadge.textContent = "Run `abt tabs` to start daemon";
      }
      if (response && response.activeTab) {
        tabTitle.textContent = response.activeTab.title || "Untitled";
        tabUrl.textContent = response.activeTab.url || "";
      }
    } catch {
      statusBadge.textContent = "Offline";
    }
  }

  bindBtn.addEventListener("click", async () => {
    bindBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "abt:bind-active" });
      feedback.hidden = false;
      if (res && res.ok) {
        feedback.textContent = res.context
          ? `Bound active tab as context ${res.context} (${res.tabId})`
          : `Synced ${res.tabId} — run 'abt bind --active'`;
      } else {
        feedback.textContent = (res && res.error) || "Run `abt bind --active` in your terminal to start the daemon.";
      }
      await refreshStatus();
    } finally {
      bindBtn.disabled = false;
    }
  });

  await refreshStatus();
});
