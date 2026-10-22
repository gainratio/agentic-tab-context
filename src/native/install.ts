/**
 * Registers the native messaging host with every installed browser so the atc
 * extension (and only it) can reach the local daemon.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_HOST_NAME } from "../contracts/extension.js";
import type { Paths } from "../contracts/protocol.js";
import { PACKAGE_ROOT } from "../drivers/page-agent.js";

export const EXTENSION_DIR = join(PACKAGE_ROOT, "extension");
const HOST_ENTRY = join(PACKAGE_ROOT, "dist", "native", "main.js");
const ID_ALPHABET_OFFSET = "a".charCodeAt(0);

interface BrowserHostDir {
  browser: string;
  /** The browser's own user-data folder; we only register if it exists. */
  profileRoot: string;
  /** Where that browser looks for native host manifests. */
  hostDir: string;
  firefox: boolean;
}

/** Chrome's extension id: SHA-256 of the DER public key, first 16 bytes, hex digits mapped 0-f -> a-p. */
export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(ID_ALPHABET_OFFSET + Number.parseInt(digit, 16))).join("");
}

export function extensionManifest(): { key: string; geckoId: string } {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8")) as {
    key: string;
    browser_specific_settings: { gecko: { id: string } };
  };
  return { key: manifest.key, geckoId: manifest.browser_specific_settings.gecko.id };
}

function chromium(browser: string, profileRoot: string): BrowserHostDir {
  return { browser, profileRoot, hostDir: join(profileRoot, "NativeMessagingHosts"), firefox: false };
}

export function browserHostDirs(home: string, platform: NodeJS.Platform): BrowserHostDir[] {
  return platform === "darwin" ? macHostDirs(home) : linuxHostDirs(home);
}

function macHostDirs(home: string): BrowserHostDir[] {
  const support = join(home, "Library", "Application Support");
  const firefox = join(support, "Mozilla");
  return [
    chromium("chrome", join(support, "Google", "Chrome")),
    chromium("chromium", join(support, "Chromium")),
    chromium("brave", join(support, "BraveSoftware", "Brave-Browser")),
    chromium("edge", join(support, "Microsoft Edge")),
    { browser: "firefox", profileRoot: firefox, hostDir: join(firefox, "NativeMessagingHosts"), firefox: true },
  ];
}

function linuxHostDirs(home: string): BrowserHostDir[] {
  const config = join(home, ".config");
  const firefox = join(home, ".mozilla");
  return [
    chromium("chrome", join(config, "google-chrome")),
    chromium("chromium", join(config, "chromium")),
    chromium("brave", join(config, "BraveSoftware", "Brave-Browser")),
    chromium("edge", join(config, "microsoft-edge")),
    { browser: "firefox", profileRoot: firefox, hostDir: join(firefox, "native-messaging-hosts"), firefox: true },
  ];
}

/** The JSON each browser reads to find and authorize the host. */
export function hostManifest(launcher: string, firefox: boolean, extensionIds: readonly string[], geckoId: string): object {
  const base = { name: NATIVE_HOST_NAME, description: "Agentic Tab Context bridge", path: launcher, type: "stdio" };
  return firefox
    ? { ...base, allowed_extensions: [geckoId] }
    : { ...base, allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`) };
}

/** Browsers start hosts with a minimal PATH, so pin the exact node binary and ATC_HOME. */
export function writeLauncher(paths: Paths, nodePath: string = process.execPath): void {
  mkdirSync(dirname(paths.nativeHost), { recursive: true, mode: 0o700 });
  const script = `#!/bin/sh\nATC_HOME=${shellQuote(paths.home)} exec ${shellQuote(nodePath)} ${shellQuote(HOST_ENTRY)} "$@"\n`;
  writeFileSync(paths.nativeHost, script, { mode: 0o700 });
  chmodSync(paths.nativeHost, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface HostInstallOptions {
  paths: Paths;
  home: string;
  platform: NodeJS.Platform;
  /** Extra Chrome extension ids to allow, e.g. the Chrome Web Store build's id. */
  extraExtensionIds: readonly string[];
}

/** Write the launcher and register it with every browser whose profile folder exists. Returns the manifests written. */
export function installNativeHost(options: HostInstallOptions): string[] {
  writeLauncher(options.paths);
  const { key, geckoId } = extensionManifest();
  const ids = [extensionIdFromKey(key), ...options.extraExtensionIds];
  const installed: string[] = [];
  for (const dir of browserHostDirs(options.home, options.platform).filter((d) => existsSync(d.profileRoot))) {
    const target = join(dir.hostDir, `${NATIVE_HOST_NAME}.json`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(hostManifest(options.paths.nativeHost, dir.firefox, ids, geckoId), null, 2)}\n`);
    installed.push(target);
  }
  return installed;
}
