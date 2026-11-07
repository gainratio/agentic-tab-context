import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeScreenshotPath, assertSafeUploadPath } from "../../src/contracts/path-policy.js";
import { uploadOp } from "../../src/drivers/page-agent.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atc-path-policy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("S-19 screenshot output path policy", () => {
  it("accepts a safe absolute path inside a normal directory", () => {
    const target = join(dir, "shots", "out.png");
    expect(assertSafeScreenshotPath(target)).toBe(target);
  });

  it("rejects relative paths, empty strings, and null bytes with E_UNSAFE_PATH", () => {
    expect(() => assertSafeScreenshotPath("relative/out.png")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
    expect(() => assertSafeScreenshotPath("   ")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
    expect(() => assertSafeScreenshotPath("/tmp/bad\0shot.png")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
  });

  it("rejects '..' traversal segments", () => {
    expect(() => assertSafeScreenshotPath(`${dir}/../escape.png`)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
  });

  it.each([
    "/etc/passwd",
    "/private/etc/hosts",
    "/System/Library/shot.png",
    "/Users/alice/.ssh/authorized_keys",
    "/Users/alice/.gnupg/secring.gpg",
    "/Users/alice/.aws/credentials",
    "/Users/alice/app/.env",
    "/Users/alice/app/.env.production",
    "/Users/alice/.npmrc",
    "/Users/alice/.netrc",
    "/Users/alice/.atc/auth-token",
    "/Users/alice/.atc/state.json",
  ])("rejects sensitive system or credential output path: %s", (unsafePath) => {
    expect(() => assertSafeScreenshotPath(unsafePath)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
  });
});

describe("S-09 upload file path policy", () => {
  it("allows uploading a benign regular file", () => {
    const resume = join(dir, "resume.txt");
    writeFileSync(resume, "hello world", "utf8");
    const op = uploadOp({ kind: "label", label: "Resume" }, resume, {});
    expect(op).toMatchObject({ op: "upload", files: [{ name: "resume.txt", type: "text/plain" }] });
  });

  it("rejects null bytes and '..' traversal segments in upload paths", () => {
    expect(() => assertSafeUploadPath("/tmp/bad\0.txt", {})).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
    expect(() => assertSafeUploadPath(`${dir}/../escape.txt`, {})).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", details: { reason: "E_UNSAFE_PATH" } }),
    );
  });

  it.each([
    "/Users/alice/.ssh/id_rsa",
    "/Users/alice/.gnupg/private.key",
    "/Users/alice/.aws/credentials",
    "/Users/alice/project/.env",
    "/Users/alice/project/.env.local",
    "/Users/alice/.npmrc",
    "/Users/alice/.netrc",
    "/Users/alice/.atc/auth-token",
    "/Users/alice/.atc/state.json",
    "/etc/passwd",
  ])("rejects sensitive credential file upload: %s", (sensitivePath) => {
    expect(() => assertSafeUploadPath(sensitivePath, {})).toThrow(
      expect.objectContaining({ code: "ACTION_BLOCKED_SENSITIVE", details: { reason: "E_UNSAFE_PATH" } }),
    );
  });

  it("rejects symlink escapes out of the parent directory or to sensitive targets", () => {
    const outside = mkdtempSync(join(tmpdir(), "atc-outside-"));
    try {
      const secretFile = join(outside, "secret.txt");
      writeFileSync(secretFile, "secret-contents", "utf8");
      const linkPath = join(dir, "innocent.txt");
      symlinkSync(secretFile, linkPath);
      expect(() => uploadOp({ kind: "label", label: "Resume" }, linkPath, {})).toThrow(
        expect.objectContaining({ code: "ACTION_BLOCKED_SENSITIVE", details: { reason: "E_UNSAFE_PATH" } }),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("permits sensitive upload only when ATC_ALLOW_SENSITIVE_UPLOAD=1 is explicitly set", () => {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "PUBLIC_FIXTURE=1", "utf8");
    expect(() => uploadOp({ kind: "label", label: "Env" }, envFile, {})).toThrow(
      expect.objectContaining({ code: "ACTION_BLOCKED_SENSITIVE" }),
    );
    expect(uploadOp({ kind: "label", label: "Env" }, envFile, { ATC_ALLOW_SENSITIVE_UPLOAD: "1" })).toMatchObject({
      op: "upload",
      files: [{ name: ".env" }],
    });
  });
});
