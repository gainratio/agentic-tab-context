/**
 * Profile directory validation and lock guards for persistent browser contexts.
 */
import { readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { AtcError } from "../../contracts/errors.js";

/** User-data dirs currently owned by a session in this process (all driver instances). */
const profilesInUse = new Set<string>();

export function validateProfileName(profile: string): string {
  const invalid = profile === "" || profile === "." || profile === ".." || /[/\\\0]/.test(profile);
  if (invalid) {
    throw new AtcError("INVALID_ARGUMENT", "Profile name must be a non-empty name without path separators", {
      profile,
    });
  }
  return profile;
}

export function claimProfile(profileDir: string, profile: string): void {
  if (profilesInUse.has(profileDir)) throw profileInUse(profile);
  profilesInUse.add(profileDir);
}

export function releaseProfile(profileDir: string): void {
  profilesInUse.delete(profileDir);
}

export async function assertNotLockedByOtherProcess(profileDir: string, profile: string): Promise<void> {
  const owner = await readSingletonLock(profileDir);
  if (owner !== null && owner.host === hostname() && isProcessAlive(owner.pid)) {
    throw profileInUse(profile);
  }
}

function profileInUse(profile: string): AtcError {
  return new AtcError(
    "ACTION_FAILED",
    `Profile "${profile}" is already in use by another open context; close it first or use a different --profile`,
    { profile },
  );
}

async function readSingletonLock(profileDir: string): Promise<{ host: string; pid: number } | null> {
  try {
    const link = await readlink(join(profileDir, "SingletonLock"));
    const match = /^(.*)-(\d+)$/.exec(link);
    if (match === null) return null;
    return { host: match[1] ?? "", pid: Number(match[2]) };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
