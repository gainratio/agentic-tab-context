/**
 * Who this extension instance is: a stable random id per browser profile, and
 * which browser it is running in.
 */

export async function instanceId() {
  const { atcInstance } = await chrome.storage.local.get("atcInstance");
  if (typeof atcInstance === "string") return atcInstance;
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const fresh = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ atcInstance: fresh });
  return fresh;
}

export function browserName() {
  if (navigator.userAgent.includes("Firefox/")) return "firefox";
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const names = brands.map((b) => b.brand);
  if (names.includes("Brave")) return "brave";
  if (names.includes("Microsoft Edge")) return "edge";
  if (names.includes("Google Chrome")) return "chrome";
  return "chromium";
}
