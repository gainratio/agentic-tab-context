import { describe, expect, it } from "vitest";
import { LineSplitter } from "../../src/transport/lines.js";

function observe(maxBytes = 8): { splitter: LineSplitter; lines: string[]; overflows: () => number } {
  const lines: string[] = [];
  let count = 0;
  const splitter = new LineSplitter(maxBytes, { onLine: (line) => lines.push(line), onOverflow: () => { count += 1; } });
  return { splitter, lines, overflows: () => count };
}

describe("LineSplitter byte limits", () => {
  it("rejects an oversized completed line before dispatch", () => {
    const { splitter, lines, overflows } = observe();
    splitter.push("x".repeat(9) + "\n");
    expect(lines).toEqual([]);
    expect(overflows()).toBe(1);
  });

  it("rejects a completed line that exceeds the cap across chunks", () => {
    const { splitter, lines, overflows } = observe();
    splitter.push("x".repeat(8));
    splitter.push("x\n");
    expect(lines).toEqual([]);
    expect(overflows()).toBe(1);
  });

  it("measures UTF-8 bytes and accepts the exact boundary", () => {
    const accepted = observe();
    accepted.splitter.push("é".repeat(4) + "\n");
    expect(accepted.lines).toEqual(["é".repeat(4)]);
    expect(accepted.overflows()).toBe(0);
    const rejected = observe();
    rejected.splitter.push("é".repeat(5) + "\n");
    expect(rejected.lines).toEqual([]);
    expect(rejected.overflows()).toBe(1);
  });

  it("fails closed after overflow instead of interpreting the remaining stream as commands", () => {
    const { splitter, lines, overflows } = observe();
    splitter.push("x".repeat(9));
    splitter.push("\nclose\n");
    splitter.push("x".repeat(9));
    expect(lines).toEqual([]);
    expect(overflows()).toBe(1);
  });
});
