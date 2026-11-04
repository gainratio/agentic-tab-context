/**
 * Sensitive-tab classifier: the default-deny list from the UX spec. These
 * cases are deliberately conservative; false positives are preferable to
 * silently binding mail, money, health, credentials, files, or browser internals.
 */
import { describe, expect, it } from "vitest";
import { isSensitiveUrl } from "../../src/daemon/sensitive.js";

describe("isSensitiveUrl", () => {
  it.each([
    ["gmail", "https://gmail.com/mail/u/0/#inbox"],
    ["google mail", "https://mail.google.com/mail/u/0/"],
    ["outlook", "https://outlook.live.com/mail/0/"],
    ["outlook office", "https://outlook.office.com/mail/"],
    ["proton", "https://proton.me/mail"],
    ["proton mail host", "https://mail.proton.me/u/0/inbox"],
    ["chase", "https://www.chase.com/"],
    ["chase secure host", "https://secure.chase.com/web/auth"],
    ["bank host token", "https://mybank.example.org/accounts"],
    ["bank of america", "https://www.bankofamerica.com/"],
    ["stripe dashboard", "https://dashboard.stripe.com/payments"],
    ["stripe dashboard path", "https://stripe.com/dashboard"],
    ["mychart host token", "https://mychart.example.org/"],
    ["mychart domain", "https://www.mychart.org/"],
    ["1password", "https://my.1password.com/"],
    ["lastpass", "https://lastpass.com/"],
    ["bitwarden", "https://vault.bitwarden.com/"],
    ["chrome web store", "https://chromewebstore.google.com/detail/example"],
    ["legacy chrome web store", "https://chrome.google.com/webstore/detail/example"],
    ["firefox add-ons", "https://addons.mozilla.org/en-US/firefox/"],
    ["chrome internal", "chrome://settings"],
    ["edge internal", "edge://settings"],
    ["browser about page", "about:preferences"],
    ["local file", "file:///Users/me/Documents/taxes.pdf"],
    ["data url", "data:text/html,<p>x</p>"],
    ["view-source", "view-source:https://example.com"],
    ["malformed url", "not a url at all"],
  ])("blocks %s", (_label, url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each([
    ["plain site", "https://example.com/docs"],
    ["site with a mail-ish path", "https://docs.example.com/mail/setup"],
    ["site with a bank-ish path", "https://example.com/bank"],
    ["github", "https://github.com/gainratio/agentic-tab-context"],
    ["local development", "http://localhost:3000/app"],
    ["loopback ip", "http://127.0.0.1:8080/"],
    ["blank tab", "about:blank"],
    ["empty url", ""],
    ["lookalike domain", "https://notgmail.com/"],
    ["domain suffix attack", "https://mail.google.com.evil.example/"],
    ["gmail as a subdomain of evil", "https://gmail.com.evil.example/"],
    ["stripe marketing page", "https://stripe.com/pricing"],
    ["chrome non-store path", "https://chrome.google.com/other"],
  ])("allows %s", (_label, url) => {
    expect(isSensitiveUrl(url)).toBe(false);
  });

  it("normalizes case, trailing dots, and ports", () => {
    expect(isSensitiveUrl("HTTPS://MAIL.GOOGLE.COM/mail")).toBe(true);
    expect(isSensitiveUrl("https://mail.google.com.:443/mail")).toBe(true);
    expect(isSensitiveUrl("https://gmail.com:8443/")).toBe(true);
  });

  it("does not match a sensitive domain that merely appears in the path", () => {
    expect(isSensitiveUrl("https://example.com/redirect?to=https://mail.google.com/")).toBe(false);
  });
});
