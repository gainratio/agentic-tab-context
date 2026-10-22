import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../helpers/cli.js";

it("the local package archive contains a runnable CLI and browser bridge", () => {
  const directory = mkdtempSync(join(tmpdir(), "atc-package-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      { cwd: ROOT, encoding: "utf8" })) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", join(directory, packed[0]!.filename), "-C", directory]);
    const root = join(directory, "package");
    for (const file of ["dist/cli/main.js", "dist/daemon/main.js", "dist/native/main.js", "extension/page-agent.js"]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
    const help = JSON.parse(execFileSync(process.execPath, [join(root, "bin/atc.js"), "--help"], { encoding: "utf8" })) as { ok: boolean };
    expect(help.ok).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
