/**
 * Enforces the repository's size limits in the gate: every function body is at
 * most 15 lines and every source file at most 200 lines (src/ and extension/).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const MAX_FUNCTION_LINES = 15;
const MAX_FILE_LINES = 200;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });
}

function bodyLines(file: ts.SourceFile, node: ts.FunctionLikeDeclaration): number {
  const body = node.body;
  if (body === undefined) return 0;
  const start = file.getLineAndCharacterOfPosition(body.getStart(file)).line;
  const end = file.getLineAndCharacterOfPosition(body.getEnd()).line;
  return ts.isBlock(body) ? Math.max(0, end - start - 1) : end - start + 1;
}

function longFunctions(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && bodyLines(file, node as ts.FunctionLikeDeclaration) > MAX_FUNCTION_LINES) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push(`${relative(ROOT, path)}:${line}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const FILES = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "extension"))];

describe("code size limits", () => {
  it(`keeps every function body within ${MAX_FUNCTION_LINES} lines`, () => {
    expect(FILES.flatMap(longFunctions)).toEqual([]);
  });

  it(`keeps every source file within ${MAX_FILE_LINES} lines`, () => {
    const long = FILES.filter((path) => readFileSync(path, "utf8").split("\n").length > MAX_FILE_LINES);
    expect(long.map((path) => relative(ROOT, path))).toEqual([]);
  });
});
