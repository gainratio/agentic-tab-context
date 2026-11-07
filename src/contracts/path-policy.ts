/**
 * Path-safety policies for daemon file operations (`screenshot` and `upload`).
 * Rejects null bytes, `..` traversal segments, symlink escapes, and sensitive
 * system or credential directories/files unless explicitly permitted.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { AtcError } from "./errors.js";

const SENSITIVE_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".git",
  ".atc",
]);

const SENSITIVE_SYSTEM_PREFIXES: readonly string[] = [
  "/etc",
  "/private/etc",
  "/System",
  "/bin",
  "/sbin",
  "/usr",
  "/proc",
  "/sys",
  "/dev",
];

const SENSITIVE_FILENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "auth-token",
  "state.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "credentials",
]);

/** Validate a caller-supplied screenshot output path (S-19). */
export function assertSafeScreenshotPath(outPath: string): string {
  assertBasicPath(outPath, "screenshot output path");
  if (!isAbsolute(outPath)) {
    throw new AtcError("INVALID_ARGUMENT", "out must be an absolute path", { reason: "E_UNSAFE_PATH" });
  }
  const normalized = resolve(outPath);
  if (isRestrictedPath(normalized) || isRestrictedRealParent(normalized)) {
    throw new AtcError("INVALID_ARGUMENT", "screenshot path points to a restricted directory or credential file", {
      reason: "E_UNSAFE_PATH",
    });
  }
  return normalized;
}

/** Validate a local file path before uploading it into a page (S-09). */
export function assertSafeUploadPath(filePath: string, env: NodeJS.ProcessEnv = process.env): string {
  assertBasicPath(filePath, "upload file path");
  const normalized = resolve(filePath);
  if (env.ATC_ALLOW_SENSITIVE_UPLOAD === "1") return normalized;
  if (isRestrictedPath(filePath) || isRestrictedPath(normalized)) {
    throw new AtcError("ACTION_BLOCKED_SENSITIVE", "upload of sensitive credential or system file is blocked", {
      reason: "E_UNSAFE_PATH",
    });
  }
  assertNoSymlinkOrRealEscape(normalized);
  return normalized;
}

function assertBasicPath(raw: string, label: string): void {
  if (raw.trim() === "" || raw.includes("\0")) {
    throw new AtcError("INVALID_ARGUMENT", `${label} must be a non-empty path without null bytes`, { reason: "E_UNSAFE_PATH" });
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new AtcError("INVALID_ARGUMENT", `${label} must not contain '..' traversal segments`, { reason: "E_UNSAFE_PATH" });
  }
}

function isRestrictedPath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  if (SENSITIVE_SYSTEM_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((seg) => SENSITIVE_SEGMENTS.has(seg.toLowerCase()))) return true;
  const base = basename(normalized).toLowerCase();
  return SENSITIVE_FILENAMES.has(base) || base.startsWith(".env.");
}

function isRestrictedRealParent(targetPath: string): boolean {
  const parent = existingRealPath(dirname(targetPath));
  return parent !== undefined && isRestrictedPath(parent);
}

function assertNoSymlinkOrRealEscape(normalized: string): void {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(normalized).isSymbolicLink();
  } catch {
    return;
  }
  const real = existingRealPath(normalized);
  const parentReal = existingRealPath(dirname(normalized));
  if (real === undefined || isRestrictedPath(real) || (isSymlink && parentReal !== undefined && !isWithinDir(real, parentReal))) {
    throw new AtcError("ACTION_BLOCKED_SENSITIVE", "upload path escapes directory or targets a sensitive file via symlink", {
      reason: "E_UNSAFE_PATH",
    });
  }
}

function existingRealPath(target: string): string | undefined {
  try {
    return realpathSync(target);
  } catch {
    return undefined;
  }
}

function isWithinDir(childPath: string, dirPath: string): boolean {
  return childPath === dirPath || childPath.startsWith(`${dirPath}/`);
}
