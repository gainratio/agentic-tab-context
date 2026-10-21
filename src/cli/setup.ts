/**
 * `abt setup`: installs the agentic-browser-tab skill into Claude Code, Codex,
 * Antigravity, and Universal Agent Skills directories, and reports browser/extension readiness.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OkResponse } from "../contracts/protocol.js";
import { detectInstalledBrowsers } from "../drivers/playwright/executables.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function extensionDirPath(): string {
  return join(PACKAGE_ROOT, "extension");
}

export function skillSourcePath(): string {
  return join(PACKAGE_ROOT, "skills", "agentic-browser-tab", "SKILL.md");
}

export function skillTargetPaths(userHome: string): string[] {
  return [
    join(userHome, ".claude", "skills", "agentic-browser-tab", "SKILL.md"),
    join(userHome, ".codex", "skills", "agentic-browser-tab", "SKILL.md"),
    join(userHome, ".gemini", "antigravity", "skills", "agentic-browser-tab", "SKILL.md"),
    join(userHome, ".agents", "skills", "agentic-browser-tab", "SKILL.md"),
  ];
}

export function runSetup(env: NodeJS.ProcessEnv = process.env): OkResponse {
  const userHome = env.HOME ?? homedir();
  const content = readSkillContent();
  const installedSkills: string[] = [];
  for (const target of skillTargetPaths(userHome)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    installedSkills.push(target);
  }
  return {
    ok: true,
    cli: "abt",
    installedSkills,
    extensionPath: extensionDirPath(),
    browsers: detectInstalledBrowsers(env.ABT_BROWSER_PATH ?? env.TABCTX_CHROMIUM_PATH),
  };
}

function readSkillContent(): string {
  const path = skillSourcePath();
  if (existsSync(path)) return readFileSync(path, "utf8");
  return DEFAULT_SKILL_MARKDOWN;
}

const DEFAULT_SKILL_MARKDOWN = `---
name: agentic-browser-tab
description: >
  Discover and bind to the user's already-open browser tab across Chrome, Safari,
  Firefox, Brave, and Edge without opening a redundant browser window or tab.
  Trigger whenever the user says "look at my browser", "check the open tab",
  "inspect my localhost tab", or asks to test/interact with a page in their browser.
---

# Agentic Browser Tab (\`abt\` / \`tabctx\`)

Use \`abt\` (or \`tabctx\`) to inspect and interact with the browser tab the user **already has open**, or to keep one sticky browser context across commands.

## Golden Rule: Never Open a Redundant Browser or Tab First

When the user says **"look at my browser"** (or names a site/tab like \`localhost\`, \`aml-filter\`, \`pricing\`):
1. **Find and bind to the existing tab first**:
   \`\`\`sh
   abt bind --query "localhost"   # or: abt bind --active
   \`\`\`
   To see all open tabs across Chrome, Safari, Firefox, Brave, and Edge before binding:
   \`\`\`sh
   abt tabs
   abt bind --tab <tabId>
   \`\`\`
2. **Inspect and act on the bound tab**:
   \`\`\`sh
   abt inspect
   abt click --role button --name "Save"
   abt type --label "Product Name" --value "Acme"
   abt select --label "Environment" --value "Stage"
   abt console --since 0
   abt network --since 0
   abt screenshot
   \`\`\`
3. **Only open a new browser context if no matching tab is open**:
   \`\`\`sh
   abt open chrome --use          # or: chromium | firefox | safari | brave | edge
   \`\`\`
`;
