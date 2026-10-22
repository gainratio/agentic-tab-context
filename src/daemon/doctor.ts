/**
 * `atc doctor`: one honest picture of what works right now and what to do next.
 */
import type { OkResponse, Paths } from "../contracts/protocol.js";
import type { LiveTab } from "../contracts/types.js";
import type { ExtensionBridge } from "../drivers/extension/bridge.js";
import { detectInstalledBrowsers } from "../drivers/playwright/executables.js";
import { EXTENSION_DIR } from "../native/install.js";

export interface DoctorInput {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  tabs: readonly LiveTab[];
  openContexts: number;
  current: string | null;
  bridge?: ExtensionBridge;
  platform?: NodeJS.Platform;
}

function nextSteps(input: DoctorInput, extensionConnected: boolean): string[] {
  const steps: string[] = [];
  if (!extensionConnected) {
    steps.push(`Install the browser extension: run \`atc setup\`, then load ${EXTENSION_DIR} via chrome://extensions > Developer mode > Load unpacked.`);
  }
  if (!extensionConnected && (input.platform ?? process.platform) === "darwin") {
    steps.push("Without the extension, macOS tabs can be listed and bound, but reading or clicking needs View > Developer > Allow JavaScript from Apple Events.");
  }
  if (input.tabs.length === 0) steps.push("No open tabs found. Open the page you want help with, then run `atc tabs`.");
  return steps;
}

export function doctorReport(input: DoctorInput): OkResponse {
  const extensions = input.bridge?.connected() ?? [];
  const count = (source: LiveTab["source"]): number => input.tabs.filter((tab) => tab.source === source).length;
  return {
    ok: true,
    daemon: { pid: process.pid, home: input.paths.home },
    contexts: { open: input.openContexts, current: input.current },
    liveTabs: { extension: count("extension"), macos: count("macos"), managed: count("managed") },
    extension: { connected: extensions },
    managedBrowsers: detectInstalledBrowsers(input.env.ATC_CHROMIUM_PATH),
    nextSteps: nextSteps(input, extensions.length > 0),
  };
}
