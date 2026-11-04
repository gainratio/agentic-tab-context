import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureToken, readToken, tokenMatches } from "../../src/contracts/auth.js";
import { resolvePaths } from "../../src/contracts/paths.js";

const homes: string[] = [];

async function tempPaths(): Promise<ReturnType<typeof resolvePaths>> {
  const home = await mkdtemp(join(tmpdir(), "atc-auth-"));
  homes.push(home);
  return resolvePaths({ ATC_HOME: home });
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("IPC auth token", () => {
  it("creates a stable owner-only token on first use", async () => {
    const paths = await tempPaths();
    expect(readToken(paths)).toBeUndefined();
    const token = ensureToken(paths);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readToken(paths)).toBe(token);
    expect(ensureToken(paths)).toBe(token);
    expect((await stat(paths.token)).mode & 0o777).toBe(0o600);
  });

  it("matches only the exact token and leaves tests without a token open", () => {
    expect(tokenMatches(undefined, undefined)).toBe(true);
    expect(tokenMatches("a", "a")).toBe(true);
    expect(tokenMatches("a", "b")).toBe(false);
    expect(tokenMatches("a", undefined)).toBe(false);
  });
});
