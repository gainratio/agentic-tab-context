import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { AtcError } from "../../src/contracts/errors.js";

const CTX = "ctx_7f21";

const HAPPY: ReadonlyArray<readonly [string, string[], unknown]> = [
  ["open minimal", ["open", "chromium"], { method: "open", params: { browser: "chromium" } }],
  [
    "open all flags",
    ["open", "chrome", "--profile", "work", "--headless", "--use"],
    { method: "open", params: { browser: "chrome", profile: "work", headless: true, use: true } },
  ],
  ["open flags first", ["open", "--use", "chromium"], { method: "open", params: { browser: "chromium", use: true } }],
  ["open --profile=", ["open", "chromium", "--profile=a_B-1"], { method: "open", params: { browser: "chromium", profile: "a_B-1" } }],
  ["open safari parses", ["open", "safari"], { method: "open", params: { browser: "safari" } }],
  ["open firefox parses", ["open", "firefox"], { method: "open", params: { browser: "firefox" } }],
  ["open brave parses", ["open", "brave"], { method: "open", params: { browser: "brave" } }],
  ["open edge parses", ["open", "edge"], { method: "open", params: { browser: "edge" } }],
  ["open webkit parses", ["open", "webkit"], { method: "open", params: { browser: "webkit" } }],
  ["open extension parses", ["open", "extension"], { method: "open", params: { browser: "extension" } }],
  ["tabs", ["tabs"], { method: "tabs", params: {} }],
  ["tabs filtered", ["tabs", "--query", "localhost", "--browser", "chrome", "--active"], { method: "tabs", params: { query: "localhost", browser: "chrome", active: true } }],
  ["bind query", ["bind", "--query", "aml-filter"], { method: "bind", params: { query: "aml-filter" } }],
  ["bind positional query", ["bind", "localhost:5181"], { method: "bind", params: { query: "localhost:5181" } }],
  ["bind tab id", ["bind", "--tab", "macos:chrome:1:2", "--use"], { method: "bind", params: { tab: "macos:chrome:1:2", use: true } }],
  ["bind url and title", ["bind", "--url", "localhost", "--title", "Dashboard", "-b", "safari", "-a"], { method: "bind", params: { url: "localhost", title: "Dashboard", browser: "safari", active: true } }],
  ["doctor", ["doctor"], { method: "doctor", params: {} }],
  ["setup", ["setup"], { setup: true }],
  ["list", ["list"], { method: "list", params: {} }],
  ["use", ["use", CTX], { method: "use", params: { context: CTX } }],
  ["current", ["current"], { method: "current", params: {} }],
  ["close current", ["close"], { method: "close", params: {} }],
  ["close positional", ["close", CTX], { method: "close", params: { context: CTX } }],
  ["close --context", ["close", "--context", CTX], { method: "close", params: { context: CTX } }],
  ["goto", ["goto", "https://example.com/a?b=c"], { method: "goto", params: { url: "https://example.com/a?b=c" } }],
  ["goto relative", ["goto", "/pricing.html"], { method: "goto", params: { url: "/pricing.html" } }],
  ["goto --context before url", ["goto", "--context", CTX, "/app.html"], { method: "goto", params: { context: CTX, url: "/app.html" } }],
  ["goto -c alias", ["goto", "/x", "-c", CTX], { method: "goto", params: { context: CTX, url: "/x" } }],
  ["goto -c= alias", ["goto", "/x", `-c=${CTX}`], { method: "goto", params: { context: CTX, url: "/x" } }],
  ["goto --context=", ["goto", `--context=${CTX}`, "/x"], { method: "goto", params: { context: CTX, url: "/x" } }],
  ["goto after --", ["goto", "--", "-weird"], { method: "goto", params: { url: "-weird" } }],
  ["back", ["back"], { method: "back", params: {} }],
  ["forward", ["forward", "-c", CTX], { method: "forward", params: { context: CTX } }],
  ["reload", ["reload"], { method: "reload", params: {} }],
  ["inspect", ["inspect", "--context", CTX], { method: "inspect", params: { context: CTX } }],
  ["screenshot", ["screenshot"], { method: "screenshot", params: {} }],
  [
    "screenshot all flags",
    ["screenshot", "--out", "/tmp/a.png", "--full-page", "-c", CTX],
    { method: "screenshot", params: { context: CTX, out: "/tmp/a.png", fullPage: true } },
  ],
  [
    "screenshot relative out resolves against the caller's cwd",
    ["screenshot", "--out", "shots/a.png"],
    { method: "screenshot", params: { out: resolve("shots/a.png") } },
  ],
  ["console", ["console"], { method: "console", params: {} }],
  ["console --since", ["console", "--since", "12"], { method: "console", params: { since: 12 } }],
  ["console --since 0", ["console", "--since=0"], { method: "console", params: { since: 0 } }],
  ["network --since", ["network", "--since", "3", "-c", CTX], { method: "network", params: { context: CTX, since: 3 } }],
  ["click role", ["click", "--role", "button"], { method: "click", params: { target: { kind: "role", role: "button" } } }],
  [
    "click role+name+nth",
    ["click", "--role", "button", "--name", "Delete", "--nth", "1"],
    { method: "click", params: { target: { kind: "role", role: "button", name: "Delete", nth: 1 } } },
  ],
  ["click label", ["click", "--label", "Email"], { method: "click", params: { target: { kind: "label", label: "Email" } } }],
  ["click text", ["click", "--text=Sign in"], { method: "click", params: { target: { kind: "text", text: "Sign in" } } }],
  [
    "click placeholder",
    ["click", "--placeholder", "Search…"],
    { method: "click", params: { target: { kind: "placeholder", placeholder: "Search…" } } },
  ],
  ["click testid", ["click", "--testid", "save-btn"], { method: "click", params: { target: { kind: "testid", testid: "save-btn" } } }],
  [
    "click selector with = in value",
    ["click", "--selector=a[href='/x']", "--nth=0", "-c", CTX],
    { method: "click", params: { context: CTX, target: { kind: "selector", selector: "a[href='/x']", nth: 0 } } },
  ],
  [
    "click within a row",
    ["click", "--role", "button", "--name", "Delete", "--within", "almamesh-bot-fix"],
    { method: "click", params: { target: { kind: "role", role: "button", name: "Delete", within: "almamesh-bot-fix" } } },
  ],
  [
    "upload",
    ["upload", "--label", "Resume", "/tmp/resume.pdf"],
    { method: "upload", params: { target: { kind: "label", label: "Resume" }, file: "/tmp/resume.pdf" } },
  ],
  ["press Enter", ["press", "Enter"], { method: "press", params: { key: "Enter" } }],
  ["press Space", ["press", "Space"], { method: "press", params: { key: " " } }],
  ["press with context", ["press", "Escape", "-c", CTX], { method: "press", params: { context: CTX, key: "Escape" } }],
  [
    "type",
    ["type", "--label", "Product Name", "--value", "Blue Shirt"],
    { method: "type", params: { target: { kind: "label", label: "Product Name" }, value: "Blue Shirt" } },
  ],
  [
    "type empty value",
    ["type", "--label", "Q", "--value="],
    { method: "type", params: { target: { kind: "label", label: "Q" }, value: "" } },
  ],
  [
    "type dash value",
    ["type", "--label", "Amount", "--value", "-5"],
    { method: "type", params: { target: { kind: "label", label: "Amount" }, value: "-5" } },
  ],
  [
    "type value starting with --",
    ["type", "--label", "Q", "--value=--x"],
    { method: "type", params: { target: { kind: "label", label: "Q" }, value: "--x" } },
  ],
  [
    "select",
    ["select", "--label", "Environment", "--value", "Stage", "--context", CTX],
    { method: "select", params: { context: CTX, target: { kind: "label", label: "Environment" }, value: "Stage" } },
  ],
  ["shutdown", ["shutdown"], { method: "shutdown", params: {} }],
  ["help", ["help"], { help: true }],
  ["--help", ["--help"], { help: true }],
  ["-h", ["-h"], { help: true }],
  ["no arguments", [], { help: true }],
  ["command --help", ["goto", "--help"], { help: true }],
  ["command -h", ["click", "-h"], { help: true }],
];

describe("parseArgs happy paths", () => {
  it.each(HAPPY)("%s", (_label, argv, expected) => {
    expect(parseArgs(argv)).toStrictEqual(expected);
  });
});

const INVALID: ReadonlyArray<readonly [string, string[], RegExp]> = [
  ["unknown command", ["frobnicate"], /unknown command "frobnicate"/],
  ["ping is not a CLI command", ["ping"], /unknown command "ping"/],
  ["help with extra args", ["help", "goto"], /help: unexpected argument "goto"/],
  ["unknown flag", ["list", "--verbose"], /list: unknown flag --verbose/],
  ["flag from another command", ["goto", "/x", "--full-page"], /goto: unknown flag --full-page/],
  ["context flag on list", ["list", "--context", CTX], /list: unknown flag --context/],
  ["context flag on use", ["use", CTX, "-c", CTX], /use: unknown flag -c/],
  ["unknown short flag", ["back", "-x"], /back: unknown flag -x/],
  ["prototype short flag", ["back", "-__proto__"], /unknown flag/],
  ["prototype long flag", ["back", "--constructor"], /unknown flag --constructor/],
  ["missing value at end", ["goto", "/x", "--context"], /--context requires a value/],
  ["missing value before flag", ["click", "--role", "--name", "x"], /--role requires a value/],
  ["missing value before -c", ["click", "--label", "-c", CTX], /--label requires a value/],
  ["boolean with value", ["open", "chromium", "--headless=true"], /--headless does not take a value/],
  ["duplicate flag", ["open", "chromium", "--use", "--use"], /duplicate flag --use/],
  ["duplicate via alias", ["goto", "/x", "--context", CTX, "-c", CTX], /duplicate flag --context/],
  ["duplicate value flag", ["click", "--text", "a", "--text", "b"], /duplicate flag --text/],
  ["extra positional", ["list", "extra"], /list: unexpected argument "extra"/],
  ["extra positional goto", ["goto", "/a", "/b"], /goto: unexpected argument "\/b"/],
  ["positional on click", ["click", "Save"], /click: unexpected argument "Save"/],
  ["open missing browser", ["open"], /open: missing required <browser>/],
  ["open unknown browser", ["open", "netscape"], /open: unknown browser "netscape"/],
  ["open browser is case-sensitive", ["open", "Chromium"], /unknown browser "Chromium"/],
  ["open empty profile", ["open", "chromium", "--profile="], /--profile must not be empty/],
  ["open dotted profile", ["open", "chromium", "--profile", "a.b"], /--profile must match/],
  ["open long profile", ["open", "chromium", "--profile", "p".repeat(65)], /--profile must match/],
  ["open traversal profile", ["open", "chromium", "--profile", "../etc"], /--profile must match/],
  ["use missing ctx", ["use"], /use: missing required <ctx>/],
  ["use bad ctx", ["use", "7f21"], /use: <ctx> must look like ctx_<hex>/],
  ["use short ctx", ["use", "ctx_7f2"], /<ctx> must look like/],
  ["use uppercase ctx", ["use", "ctx_7F21"], /<ctx> must look like/],
  ["close bad ctx", ["close", "ctx_zzzz"], /close: <ctx> must look like/],
  ["close both forms", ["close", CTX, "--context", CTX], /either positionally or with --context/],
  ["bad --context", ["back", "--context", "foo"], /back: --context must look like/],
  ["goto missing url", ["goto"], /goto: missing required <url>/],
  ["goto empty url", ["goto", ""], /goto: missing required <url>/],
  ["screenshot empty out", ["screenshot", "--out="], /--out must not be empty/],
  ["since negative", ["console", "--since", "-1"], /--since must be a non-negative integer, got "-1"/],
  ["since float", ["console", "--since", "1.5"], /--since must be a non-negative integer/],
  ["since leading zero", ["network", "--since", "01"], /--since must be a non-negative integer/],
  ["since non-numeric", ["network", "--since", "abc"], /--since must be a non-negative integer/],
  ["since unsafe", ["network", "--since", "99999999999999999999"], /--since must be a non-negative integer/],
  ["since empty", ["network", "--since="], /--since must be a non-negative integer/],
  ["click no target", ["click"], /click: a target is required/],
  ["click only nth", ["click", "--nth", "0"], /click: a target is required/],
  ["click two locators", ["click", "--role", "button", "--text", "Save"], /exactly one locator flag, got --role, --text/],
  ["click three locators", ["click", "--label", "a", "--testid", "b", "--selector", "c"], /exactly one locator flag/],
  ["name without role", ["click", "--label", "Email", "--name", "x"], /--name is only valid together with --role/],
  ["name alone", ["click", "--name", "x"], /a target is required/],
  ["nth negative", ["click", "--role", "button", "--nth", "-1"], /--nth must be a non-negative integer/],
  ["nth non-integer", ["click", "--role", "button", "--nth", "x"], /--nth must be a non-negative integer/],
  ["empty locator", ["click", "--text="], /--text must not be empty/],
  ["empty name", ["click", "--role", "button", "--name="], /--name must not be empty/],
  ["type missing value", ["type", "--label", "Q"], /type: missing required --value/],
  ["select missing value", ["select", "--label", "Env"], /select: missing required --value/],
  ["type missing target", ["type", "--value", "x"], /type: a target is required/],
  ["value on click", ["click", "--role", "button", "--value", "x"], /click: unknown flag --value/],
];

describe("parseArgs rejects malformed input with INVALID_ARGUMENT", () => {
  it.each(INVALID)("%s", (_label, argv, message) => {
    let thrown: unknown;
    try {
      parseArgs(argv);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AtcError);
    const error = thrown as AtcError;
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toMatch(message);
  });
});
