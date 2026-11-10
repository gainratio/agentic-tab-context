/**
 * Verifies that `store/agentic-tab-context-<version>.zip` is up to date with `extension/`,
 * omits the unpacked development `key`, and satisfies Chrome Web Store Manifest V3 invariants.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStoreZip, readZipEntries } from "../../scripts/pack-store.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const STORE_DIR = join(ROOT, "store");
const SOURCE_MANIFEST = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8")) as {
  version: string;
  key?: string;
};
const EXPECTED_ZIP = `agentic-tab-context-${SOURCE_MANIFEST.version}.zip`;

describe("Chrome Web Store package", () => {
  it("keeps only the current version zip in store/ and matches buildStoreZip byte-for-byte", () => {
    const zips = readdirSync(STORE_DIR).filter((name) => name.endsWith(".zip"));
    expect(zips).toEqual([EXPECTED_ZIP]);
    const committed = readFileSync(join(STORE_DIR, EXPECTED_ZIP));
    expect(Buffer.compare(committed, buildStoreZip(ROOT))).toBe(0);
  });

  it("strips the development key while preserving local unpacked key on disk", () => {
    expect(typeof SOURCE_MANIFEST.key).toBe("string");
    const entries = readZipEntries(readFileSync(join(STORE_DIR, EXPECTED_ZIP)));
    const packaged = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as Record<string, unknown>;
    expect(packaged.key).toBeUndefined();
    expect(packaged.manifest_version).toBe(3);
    expect(packaged.version).toBe(SOURCE_MANIFEST.version);
    expect((packaged.description as string).length).toBeLessThanOrEqual(132);
  });

  it("bundles icons, popup, side panel, and service worker with zero dev artifacts", () => {
    const entries = readZipEntries(readFileSync(join(STORE_DIR, EXPECTED_ZIP)));
    for (const required of [
      "icons/icon-16.png",
      "icons/icon-48.png",
      "icons/icon-128.png",
      "popup/popup.html",
      "sidepanel/index.html",
      "service-worker.js",
    ]) {
      expect(entries.has(required), `missing ${required}`).toBe(true);
    }
    const forbidden = [...entries.keys()].filter((k) => /(\.DS_Store|Thumbs\.db|\.map$|\.test\.)/.test(k));
    expect(forbidden).toEqual([]);
  });
});
