/**
 * Target resolution: turns a contract `Target` into exactly one Playwright Locator.
 *
 * Determinism rules (see docs/SPEC.md):
 * - names / labels / text / placeholders match exactly;
 * - only visible elements count;
 * - zero matches => TARGET_NOT_FOUND, several matches without `nth` => AMBIGUOUS_TARGET;
 * - `nth` is the only way to pick among several matches. Nothing is ever auto-picked.
 */
import type { Locator, Page } from "playwright-core";
import { TabCtxError } from "../contracts/errors.js";
import type { Target } from "../contracts/types.js";

type AriaRole = Parameters<Page["getByRole"]>[0];

/** Human-readable description of a target for error messages, e.g. `role=button name="Delete" nth=1`. */
export function describeTarget(target: Target): string {
  const base = describeLocatorPart(target);
  return target.nth === undefined ? base : `${base} nth=${target.nth}`;
}

function describeLocatorPart(target: Target): string {
  switch (target.kind) {
    case "role":
      return target.name === undefined
        ? `role=${target.role}`
        : `role=${target.role} name=${JSON.stringify(target.name)}`;
    case "label":
      return `label=${JSON.stringify(target.label)}`;
    case "text":
      return `text=${JSON.stringify(target.text)}`;
    case "placeholder":
      return `placeholder=${JSON.stringify(target.placeholder)}`;
    case "testid":
      return `testid=${JSON.stringify(target.testid)}`;
    case "selector":
      return `selector=${JSON.stringify(target.selector)}`;
  }
}

/**
 * Decide which match to use given the visible match count.
 * Returns `undefined` when there is exactly one match and no `nth`, or the validated `nth` index.
 * Throws TARGET_NOT_FOUND / AMBIGUOUS_TARGET otherwise.
 */
export function chooseIndex(target: Target, matched: number): number | undefined {
  const label = describeTarget(target);
  if (matched === 0) {
    throw new TabCtxError("TARGET_NOT_FOUND", `No visible element matches ${label}`, { matched: 0 });
  }
  if (target.nth === undefined) {
    if (matched > 1) {
      throw new TabCtxError(
        "AMBIGUOUS_TARGET",
        `${matched} visible elements match ${label}; pass --nth N (0-based) to pick one`,
        { matched },
      );
    }
    return undefined;
  }
  if (!isValidNth(target.nth, matched)) {
    throw new TabCtxError(
      "TARGET_NOT_FOUND",
      `nth=${String(target.nth)} is out of range: ${matched} visible element(s) match ${describeLocatorPart(target)}`,
      { matched },
    );
  }
  return target.nth;
}

/** `nth` must be an integer in [0, matched). */
export function isValidNth(nth: number, matched: number): boolean {
  return Number.isInteger(nth) && nth >= 0 && nth < matched;
}

/** Build the raw (unfiltered) locator for a target. Exact matching everywhere. */
export function buildLocator(page: Page, target: Target): Locator {
  switch (target.kind) {
    case "role":
      return target.name === undefined
        ? page.getByRole(target.role as AriaRole)
        : page.getByRole(target.role as AriaRole, { name: target.name, exact: true });
    case "label":
      return page.getByLabel(target.label, { exact: true });
    case "text":
      return page.getByText(target.text, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(target.placeholder, { exact: true });
    case "testid":
      return page.getByTestId(target.testid);
    case "selector":
      return page.locator(target.selector);
  }
}

/** Resolve a target to exactly one visible element, or throw a typed error. */
export async function resolveTarget(page: Page, target: Target): Promise<Locator> {
  const visible = buildLocator(page, target).filter({ visible: true });
  const matched = await visible.count();
  const index = chooseIndex(target, matched);
  return index === undefined ? visible : visible.nth(index);
}

export interface SelectOptionInfo {
  label: string;
  value: string;
}

/**
 * Pick how to select `wanted` in a <select>: by label first, then by value.
 * Returns `null` when no option has that label or value.
 */
export function pickOption(
  options: readonly SelectOptionInfo[],
  wanted: string,
): { label: string } | { value: string } | null {
  if (options.some((option) => option.label === wanted)) return { label: wanted };
  if (options.some((option) => option.value === wanted)) return { value: wanted };
  return null;
}
