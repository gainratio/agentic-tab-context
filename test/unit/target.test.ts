import { describe, expect, it } from "vitest";
import { TabCtxError } from "../../src/contracts/errors.js";
import type { Target } from "../../src/contracts/types.js";
import { chooseIndex, describeTarget, isValidNth, pickOption } from "../../src/drivers/target.js";

function caught(fn: () => unknown): TabCtxError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TabCtxError) return error;
    throw error;
  }
  throw new Error("expected a TabCtxError");
}

describe("describeTarget", () => {
  it.each<[Target, string]>([
    [{ kind: "role", role: "button" }, "role=button"],
    [{ kind: "role", role: "button", name: "Delete", nth: 1 }, 'role=button name="Delete" nth=1'],
    [{ kind: "label", label: "Product Name" }, 'label="Product Name"'],
    [{ kind: "text", text: "Saved" }, 'text="Saved"'],
    [{ kind: "placeholder", placeholder: "e.g. Blue Shirt" }, 'placeholder="e.g. Blue Shirt"'],
    [{ kind: "testid", testid: "save-btn", nth: 0 }, 'testid="save-btn" nth=0'],
    [{ kind: "selector", selector: "#save" }, 'selector="#save"'],
  ])("describes %j", (target, expected) => {
    expect(describeTarget(target)).toBe(expected);
  });

  it("quotes values so embedded quotes stay unambiguous", () => {
    expect(describeTarget({ kind: "text", text: 'say "hi"' })).toBe('text="say \\"hi\\""');
  });
});

describe("isValidNth", () => {
  it.each([
    [0, 1, true],
    [1, 2, true],
    [2, 2, false],
    [-1, 2, false],
    [0.5, 2, false],
    [Number.NaN, 2, false],
    [Number.POSITIVE_INFINITY, 2, false],
  ])("nth=%s with %s matches => %s", (nth, matched, expected) => {
    expect(isValidNth(nth, matched)).toBe(expected);
  });
});

describe("chooseIndex", () => {
  const button: Target = { kind: "role", role: "button", name: "Delete" };

  it("returns undefined for a single match without nth", () => {
    expect(chooseIndex(button, 1)).toBeUndefined();
  });

  it("fails with TARGET_NOT_FOUND and matched 0 when nothing matches", () => {
    const error = caught(() => chooseIndex(button, 0));
    expect(error.code).toBe("TARGET_NOT_FOUND");
    expect(error.details).toEqual({ matched: 0 });
    expect(error.message).toContain('role=button name="Delete"');
  });

  it("never auto-picks: several matches without nth is AMBIGUOUS_TARGET", () => {
    const error = caught(() => chooseIndex(button, 2));
    expect(error.code).toBe("AMBIGUOUS_TARGET");
    expect(error.details).toEqual({ matched: 2 });
    expect(error.message).toContain("--nth");
  });

  it("returns a valid nth", () => {
    expect(chooseIndex({ ...button, nth: 1 }, 2)).toBe(1);
    expect(chooseIndex({ ...button, nth: 0 }, 1)).toBe(0);
  });

  it.each([5, 2, -1, 0.5])("rejects out-of-range nth=%s with TARGET_NOT_FOUND", (nth) => {
    const error = caught(() => chooseIndex({ ...button, nth }, 2));
    expect(error.code).toBe("TARGET_NOT_FOUND");
    expect(error.details).toEqual({ matched: 2 });
  });

  it("reports matched 0 even when nth is given and nothing matches", () => {
    const error = caught(() => chooseIndex({ ...button, nth: 0 }, 0));
    expect(error.code).toBe("TARGET_NOT_FOUND");
    expect(error.details).toEqual({ matched: 0 });
  });
});

describe("pickOption", () => {
  const options = [
    { label: "Dev", value: "dev" },
    { label: "Stage", value: "stg" },
    { label: "stg", value: "other" },
  ];

  it("prefers an exact label match", () => {
    expect(pickOption(options, "Stage")).toEqual({ label: "Stage" });
    expect(pickOption(options, "stg")).toEqual({ label: "stg" });
  });

  it("falls back to an exact value match", () => {
    expect(pickOption(options, "dev")).toEqual({ value: "dev" });
  });

  it("returns null when neither label nor value matches", () => {
    expect(pickOption(options, "Prod")).toBeNull();
    expect(pickOption(options, "stage")).toBeNull();
    expect(pickOption([], "Dev")).toBeNull();
  });
});
