/**
 * Conservative sensitive-tab classifier (docs/ATC-UX-SPEC.md §8).
 *
 * The agent/CLI path must never bind a tab that can expose mail, money,
 * health data, credentials, local files, browser internals, or an extension
 * store. The extension side panel may still share such a tab after an
 * explicit, user-initiated action (see `shareFromExtension`).
 *
 * This list is intentionally small and deterministic. It is a floor, not a
 * proof of safety: err on the side of blocking when a URL cannot be parsed.
 */

/** Registrable domains whose every subdomain is sensitive. */
const SENSITIVE_DOMAINS: readonly string[] = [
  // Webmail
  "gmail.com",
  "mail.google.com",
  "outlook.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "fastmail.com",
  "mail.yahoo.com",
  // Banking and payments
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "citibank.com",
  "capitalone.com",
  "americanexpress.com",
  "paypal.com",
  "venmo.com",
  "wise.com",
  "coinbase.com",
  "dashboard.stripe.com",
  // Health
  "mychart.com",
  "mychart.org",
  // Password managers
  "1password.com",
  "lastpass.com",
  "bitwarden.com",
  "dashlane.com",
  "keepersecurity.com",
  // Extension stores
  "chromewebstore.google.com",
  "addons.mozilla.org",
];

/** Hostname fragments that name a sensitive category on any domain (e.g. mychart.example.org). */
const SENSITIVE_HOST_FRAGMENTS: readonly string[] = ["bank", "mychart"];

/** Path-scoped rules for sites that are only sensitive in their account/payment surface. */
const SENSITIVE_PATHS: ReadonlyArray<{ host: string; prefix: string }> = [
  { host: "stripe.com", prefix: "/dashboard" },
  { host: "stripe.com", prefix: "/payments" },
  { host: "chrome.google.com", prefix: "/webstore" },
  { host: "microsoftedge.microsoft.com", prefix: "/addons" },
];

/**
 * True when a URL belongs to a category the agent may not bind on its own.
 * Empty strings are treated as not sensitive; anything unparseable is blocked.
 */
export function isSensitiveUrl(url: string): boolean {
  const input = url.trim();
  if (input === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return true;
  }
  if (isAboutBlank(input)) return false;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return true;
  return isSensitiveHost(parsed);
}

function isSensitiveHost(parsed: URL): boolean {
  const host = normalizeHost(parsed.hostname);
  if (host === "") return true;
  if (SENSITIVE_HOST_FRAGMENTS.some((fragment) => host.includes(fragment))) return true;
  if (SENSITIVE_DOMAINS.some((domain) => matchesDomain(host, domain))) return true;
  const path = parsed.pathname.toLowerCase();
  return SENSITIVE_PATHS.some((rule) => matchesDomain(host, rule.host) && matchesPath(path, rule.prefix));
}

function isAboutBlank(input: string): boolean {
  return input.toLowerCase() === "about:blank";
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
