import { describe, expect, it } from "vitest";
import { redactText, redactUrl, redactValue } from "../../src/daemon/redaction.js";

describe("redaction", () => {
  it("redacts token-like query values but keeps routing", () => {
    const url = redactUrl("https://example.com/callback?code=abc123&token=deadbeef&page=2&q=hello");
    expect(url).toContain("https://example.com/callback");
    expect(url).toContain("page=2");
    expect(url).toContain("q=hello");
    expect(url).not.toContain("abc123");
    expect(url).not.toContain("deadbeef");
  });

  it("redacts userinfo", () => {
    const url = redactUrl("https://user:pass@example.com/private");
    expect(url).not.toContain("user");
    expect(url).not.toContain("pass");
    expect(url).toContain("example.com/private");
  });

  it("redacts bearer, API-key, and JWT shapes in text", () => {
    const text = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345 and sk-abcdefghijklmnopqrstuvwxyz");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("Bearer [redacted]");
  });

  it("recursively redacts URLs and strings", () => {
    const value = redactValue({
      url: "https://example.com/?token=secret",
      nested: [{ text: "token=sk-abcdefghijklmnopqrstuvwxyz" }],
      count: 2,
    });
    expect(value.url).not.toContain("secret");
    expect(value.nested[0]?.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(value.count).toBe(2);
  });

  it("leaves non-secret values intact", () => {
    expect(redactUrl("https://example.com/docs?page=2")).toBe("https://example.com/docs?page=2");
    expect(redactText("a normal sentence")).toBe("a normal sentence");
  });

  it("redacts Authorization headers, Cookie/Set-Cookie headers, OTP/CVV, card numbers, and AIza/ghp tokens (S-03)", () => {
    const headers = redactText(
      "Authorization: Bearer tok_secret_123456\nCookie: sid=abc123xyz; theme=dark\nSet-Cookie: session=topsecret; HttpOnly",
    );
    expect(headers).toContain("Authorization: Bearer [redacted]");
    expect(headers).toContain("Cookie: [redacted]");
    expect(headers).toContain("Set-Cookie: [redacted]");
    expect(headers).not.toContain("tok_secret_123456");
    expect(headers).not.toContain("sid=abc123xyz");
    expect(headers).not.toContain("topsecret");

    const secrets = redactText(
      "OTP: 482910, cvv=842, card 4532-0151-1283-0366, ghp_1234567890abcdefghijklmnop, AIzaSyDaGmW1234567890abcdefghijk",
    );
    expect(secrets).not.toContain("482910");
    expect(secrets).not.toContain("842");
    expect(secrets).not.toContain("4532-0151-1283-0366");
    expect(secrets).not.toContain("ghp_1234567890abcdefghijklmnop");
    expect(secrets).not.toContain("AIzaSyDaGmW1234567890abcdefghijk");
  });
});
