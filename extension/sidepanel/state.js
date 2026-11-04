/**
 * Sensitive-tab classifier for the side panel. Mirrors src/daemon/sensitive.ts
 * and docs/ATC-UX-SPEC.md §8; keep both lists in sync.
 *
 * This file is a classic script on purpose: the panel runs from extension pages
 * and the e2e tests load it directly from file://.
 */
globalThis.ATCState = globalThis.ATCState || {};

const SENSITIVE_DOMAIN_GROUPS = [
  { category: "Mail", domains: ["gmail.com", "mail.google.com", "outlook.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "proton.me", "protonmail.com", "protonmail.ch", "fastmail.com", "mail.yahoo.com"] },
  { category: "Banking", domains: ["chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "capitalone.com", "americanexpress.com", "paypal.com", "venmo.com", "wise.com", "coinbase.com", "dashboard.stripe.com"] },
  { category: "Health", domains: ["mychart.com", "mychart.org"] },
  { category: "Passwords", domains: ["1password.com", "lastpass.com", "bitwarden.com", "dashlane.com", "keepersecurity.com"] },
  { category: "Web Store", domains: ["chromewebstore.google.com", "addons.mozilla.org"] },
];
/** Hostname fragments that name a sensitive category on any domain (e.g. mychart.example.org). */
const SENSITIVE_HOST_FRAGMENTS = [
  { category: "Banking", fragment: "bank" },
  { category: "Health", fragment: "mychart" },
];
/** Path-scoped rules for sites that are only sensitive in their account/payment surface. */
const SENSITIVE_PATHS = [
  { category: "Banking", host: "stripe.com", prefix: "/dashboard" },
  { category: "Banking", host: "stripe.com", prefix: "/payments" },
  { category: "Web Store", host: "chrome.google.com", prefix: "/webstore" },
  { category: "Web Store", host: "microsoftedge.microsoft.com", prefix: "/addons" },
];
const SENSITIVE_DOMAINS = SENSITIVE_DOMAIN_GROUPS.flatMap((group) =>
  group.domains.map((domain) => ({ domain, category: group.category })),
);

function classifierInput(url) {
  return typeof url === "string" ? url.trim() : "";
}
function classifyHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.+$/, "");
}
function matchesDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
function matchesPath(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}
function isHttpProtocol(protocol) {
  return protocol === "http:" || protocol === "https:";
}
function isExtensionProtocol(protocol) {
  return protocol === "chrome-extension:" || protocol === "moz-extension:";
}
function parseUrl(url) {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}
function isAboutBlank(input) {
  return input.toLowerCase() === "about:blank";
}
function isSensitiveHost(host, pathname) {
  if (SENSITIVE_HOST_FRAGMENTS.some((rule) => host.includes(rule.fragment))) return true;
  if (SENSITIVE_DOMAINS.some((rule) => matchesDomain(host, rule.domain))) return true;
  const path = pathname.toLowerCase();
  return SENSITIVE_PATHS.some((rule) => matchesDomain(host, rule.host) && matchesPath(path, rule.prefix));
}
function isSensitiveUrl(url) {
  const input = classifierInput(url);
  if (input === "" || isAboutBlank(input)) return false;
  const parsed = parseUrl(input);
  if (parsed === null) return true;
  if (!isHttpProtocol(parsed.protocol.toLowerCase())) return true;
  const host = classifyHost(parsed.hostname);
  return host === "" || isSensitiveHost(host, parsed.pathname);
}
function isSupportedUrl(url) {
  const parsed = parseUrl(classifierInput(url));
  return parsed !== null && isHttpProtocol(parsed.protocol);
}
function categoryForHost(host, path) {
  const fragment = SENSITIVE_HOST_FRAGMENTS.find((rule) => host.includes(rule.fragment));
  if (fragment !== undefined) return fragment.category;
  const domain = SENSITIVE_DOMAINS.find((rule) => matchesDomain(host, rule.domain));
  if (domain !== undefined) return domain.category;
  const scoped = SENSITIVE_PATHS.find((rule) => matchesDomain(host, rule.host) && matchesPath(path, rule.prefix));
  return scoped === undefined ? "Other" : scoped.category;
}
function sensitiveCategory(url) {
  const parsed = parseUrl(classifierInput(url));
  if (parsed === null) return "Restricted page";
  if (parsed.protocol === "file:") return "Local file";
  if (!isHttpProtocol(parsed.protocol)) return "Browser page";
  return categoryForHost(classifyHost(parsed.hostname), parsed.pathname.toLowerCase());
}
function classifyUrl(url) {
  const supported = isSupportedUrl(url);
  const sensitive = isSensitiveUrl(url);
  return { sensitive, supported, unsupported: !supported, category: sensitive ? sensitiveCategory(url) : null };
}
function hostOfParsed(parsed) {
  if (isHttpProtocol(parsed.protocol)) return classifyHost(parsed.hostname).replace(/^www\./, "");
  if (parsed.protocol === "file:") return "Local file";
  if (isExtensionProtocol(parsed.protocol)) return "Extension page";
  const name = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  return name === "" ? parsed.protocol.replace(/:$/, "") : `${parsed.protocol}//${name}`;
}
function hostOf(url) {
  const input = classifierInput(url);
  if (input === "") return "";
  if (isAboutBlank(input)) return "about:blank";
  const parsed = parseUrl(input);
  return parsed === null ? "" : hostOfParsed(parsed);
}

Object.assign(ATCState, {
  SENSITIVE_DOMAINS,
  SENSITIVE_HOST_FRAGMENTS,
  SENSITIVE_PATHS,
  classifyUrl,
  isSensitiveUrl,
  isSupportedUrl,
  hostOf,
});
