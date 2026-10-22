import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "../../src/cli/setup.js";
import { resolvePaths } from "../../src/contracts/paths.js";
import { browserHostDirs, installNativeHost } from "../../src/native/install.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("supported installation platforms", () => {
  it.each(["win32", "freebsd", "aix"] as const)("rejects %s instead of using Linux registration paths", (platform) => {
    expect(() => browserHostDirs("/unused", platform)).toThrow(/macOS and Linux/);
  });

  it("rejects unsupported native installation before creating files", () => {
    const root = mkdtempSync(join(tmpdir(), "atc-install-guard-"));
    roots.push(root);
    const paths = resolvePaths({ ATC_HOME: join(root, "atc") });
    expect(() => installNativeHost({ paths, home: join(root, "home"), platform: "win32", extraExtensionIds: [] }))
      .toThrow(/macOS and Linux/);
    expect(existsSync(paths.home)).toBe(false);
  });

  it("setup leaves no partial installation on an unsupported platform", () => {
    const root = mkdtempSync(join(tmpdir(), "atc-setup-guard-"));
    roots.push(root);
    const userHome = join(root, "home");
    expect(() => runSetup({ HOME: userHome, ATC_HOME: join(root, "atc") }, "win32")).toThrow(/macOS and Linux/);
    expect(existsSync(userHome)).toBe(false);
    expect(existsSync(join(root, "atc"))).toBe(false);
  });
});
