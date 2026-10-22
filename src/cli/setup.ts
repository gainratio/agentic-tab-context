/**
 * `atc setup`: installs the agentic-tab-context skill for Claude Code, Codex
 * and Antigravity, and registers the browser extension's native host.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePaths } from "../contracts/paths.js";
import type { OkResponse } from "../contracts/protocol.js";
import { PACKAGE_ROOT } from "../drivers/page-agent.js";
import { EXTENSION_DIR, extensionIdFromKey, extensionManifest, installNativeHost } from "../native/install.js";

const SKILL_NAME = "agentic-tab-context";
const SKILL_SOURCE = join(PACKAGE_ROOT, "skills", SKILL_NAME, "SKILL.md");

/** User-level skill folders each assistant reads (Codex and Antigravity per their docs). */
export function skillTargetPaths(userHome: string): string[] {
  return [
    join(userHome, ".claude", "skills", SKILL_NAME, "SKILL.md"),
    join(userHome, ".agents", "skills", SKILL_NAME, "SKILL.md"),
    join(userHome, ".gemini", "config", "skills", SKILL_NAME, "SKILL.md"),
  ];
}

function installSkills(userHome: string): string[] {
  const content = readFileSync(SKILL_SOURCE, "utf8");
  return skillTargetPaths(userHome).map((target) => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return target;
  });
}

export function runSetup(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): OkResponse {
  const home = env.HOME ?? homedir();
  const extraExtensionIds = (env.ATC_EXTENSION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const nativeHostManifests = installNativeHost({ paths: resolvePaths(env), home, platform, extraExtensionIds });
  return {
    ok: true,
    installedSkills: installSkills(home),
    nativeHostManifests,
    extension: { folder: EXTENSION_DIR, id: extensionIdFromKey(extensionManifest().key) },
    next: "Load the extension folder via chrome://extensions > Developer mode > Load unpacked, then run `atc tabs`.",
  };
}
