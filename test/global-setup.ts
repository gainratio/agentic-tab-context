/** Build once before any test runs, so parallel e2e files never race on dist/. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: join(import.meta.dirname, ".."), stdio: "ignore" });
}
