/**
 * Side-panel messages arrive from the browser and are untrusted: ids, tab ids,
 * and contexts are validated strictly, unknown fields are dropped, and
 * anything malformed never reaches the daemon.
 */
import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "../../src/drivers/extension/messages.js";

function parse(value: unknown): unknown {
  return parseExtensionMessage(JSON.stringify(value));
}

describe("side-panel message parsing", () => {
  it.each([
    ["bindings", { type: "bindings", id: 1 }, { type: "bindings", id: 1 }],
    ["share", { type: "share", id: 2, tabId: 7 }, { type: "share", id: 2, tabId: 7 }],
    ["unshare", { type: "unshare", id: 3, context: "ctx_ab12" }, { type: "unshare", id: 3, context: "ctx_ab12" }],
    ["activate", { type: "activate", id: 4, context: "ctx_cd34" }, { type: "activate", id: 4, context: "ctx_cd34" }],
  ])("accepts a well-formed %s request", (_label, input, expected) => {
    expect(parse(input)).toStrictEqual(expected);
  });

  it("ignores unknown fields instead of echoing them", () => {
    expect(parse({ type: "share", id: 2, tabId: 7, url: "https://mail.google.com", title: "Inbox", active: true })).toStrictEqual({
      type: "share",
      id: 2,
      tabId: 7,
    });
    expect(parse({ type: "activate", id: 4, context: "ctx_cd34", extra: { nested: true } })).toStrictEqual({
      type: "activate",
      id: 4,
      context: "ctx_cd34",
    });
  });

  it.each([
    ["zero request id", { type: "bindings", id: 0 }],
    ["negative request id", { type: "bindings", id: -1 }],
    ["fractional request id", { type: "bindings", id: 1.5 }],
    ["string request id", { type: "bindings", id: "1" }],
    ["unsafe request id", { type: "bindings", id: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing request id", { type: "bindings" }],
    ["zero tab id", { type: "share", id: 1, tabId: 0 }],
    ["negative tab id", { type: "share", id: 1, tabId: -7 }],
    ["fractional tab id", { type: "share", id: 1, tabId: 7.5 }],
    ["string tab id", { type: "share", id: 1, tabId: "7" }],
    ["missing tab id", { type: "share", id: 1 }],
    ["empty context", { type: "unshare", id: 1, context: "" }],
    ["whitespace context", { type: "unshare", id: 1, context: "   " }],
    ["non-string context", { type: "activate", id: 1, context: 7 }],
    ["missing context", { type: "activate", id: 1 }],
    ["pin with a zero tab id", { type: "pin", id: 1, tabId: 0 }],
    ["pin with a zero id", { type: "pin", id: 0, tabId: 7 }],
  ])("drops %s", (_label, input) => {
    expect(parse(input)).toBeUndefined();
  });

  it.each([
    ["unknown type", { type: "share-all", id: 1 }],
    ["missing type", { id: 1 }],
    ["non-string type", { type: 1, id: 1 }],
    ["array payload", []],
    ["null payload", null],
  ])("drops %s", (_label, input) => {
    expect(parse(input)).toBeUndefined();
  });

  it("drops invalid JSON without throwing", () => {
    expect(parseExtensionMessage("{")).toBeUndefined();
    expect(parseExtensionMessage("")).toBeUndefined();
    expect(parseExtensionMessage("null")).toBeUndefined();
  });

  it("keeps the existing hello, tabs, result, and pin shapes working", () => {
    expect(parse({ type: "hello", browser: "chrome", instance: "0a1b2c3d" })).toStrictEqual({
      type: "hello",
      browser: "chrome",
      instance: "0a1b2c3d",
    });
    expect(parse({ type: "result", id: 0, ok: true })).toStrictEqual({ type: "result", id: 0, ok: true, result: undefined });
    expect(parse({ type: "pin", id: 1, tabId: 7 })).toStrictEqual({ type: "pin", id: 1, tabId: 7 });
  });

  it("carries protocol and extension version on hello without breaking old clients", () => {
    expect(parse({ type: "hello", browser: "chrome", instance: "0a1b2c3d", protocol: 2, version: "0.4.1" })).toStrictEqual({
      type: "hello",
      browser: "chrome",
      instance: "0a1b2c3d",
      protocol: 2,
      version: "0.4.1",
    });
    expect(parse({ type: "hello", browser: "chrome", instance: "0a1b2c3d", protocol: -1 })).toStrictEqual({
      type: "hello",
      browser: "chrome",
      instance: "0a1b2c3d",
    });
  });
});
