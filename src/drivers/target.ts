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
import { AtcError } from "../contracts/errors.js";
import type { Target } from "../contracts/types.js";

type AriaRole = Parameters<Page["getByRole"]>[0];
type SimpleTarget = Exclude<Target, { kind: "role" }>;
const EXACT = { exact: true } as const;

/** Human-readable description of a target for error messages, e.g. `role=button name="Delete" nth=1`. */
export function describeTarget(target: Target): string {
  const base = describeLocatorPart(target);
  return target.nth === undefined ? base : `${base} nth=${target.nth}`;
}

/** The locator value of a non-role target: its field is named after its kind (label.label, text.text, ...). */
function simpleValue(target: SimpleTarget): string {
  return (target as unknown as Record<string, string>)[target.kind] ?? "";
}

function describeLocatorPart(target: Target): string {
  if (target.kind !== "role") return `${target.kind}=${JSON.stringify(simpleValue(target))}`;
  return target.name === undefined ? `role=${target.role}` : `role=${target.role} name=${JSON.stringify(target.name)}`;
}

/**
 * Decide which match to use given the visible match count.
 * Returns `undefined` when there is exactly one match and no `nth`, or the validated `nth` index.
 * Throws TARGET_NOT_FOUND / AMBIGUOUS_TARGET otherwise.
 */
export function chooseIndex(target: Target, matched: number): number | undefined {
  const label = describeTarget(target);
  if (matched === 0) throw new AtcError("TARGET_NOT_FOUND", `No visible element matches ${label}`, { matched: 0 });
  if (target.nth === undefined) {
    if (matched === 1) return undefined;
    throw new AtcError("AMBIGUOUS_TARGET", `${matched} visible elements match ${label}; pass --nth N (0-based) to pick one`, { matched });
  }
  if (isValidNth(target.nth, matched)) return target.nth;
  const message = `nth=${String(target.nth)} is out of range: ${matched} visible element(s) match ${describeLocatorPart(target)}`;
  throw new AtcError("TARGET_NOT_FOUND", message, { matched });
}

/** `nth` must be an integer in [0, matched). */
export function isValidNth(nth: number, matched: number): boolean {
  return Number.isInteger(nth) && nth >= 0 && nth < matched;
}

/** Build the raw (unfiltered) locator for a target. Exact matching everywhere. */
export function buildLocator(page: Page, target: Target): Locator {
  if (target.kind === "role") {
    const role = target.role as AriaRole;
    return target.name === undefined ? page.getByRole(role) : page.getByRole(role, { name: target.name, exact: true });
  }
  if (target.kind === "label") return page.getByLabel(target.label, EXACT);
  if (target.kind === "text") return page.getByText(target.text, EXACT);
  if (target.kind === "placeholder") return page.getByPlaceholder(target.placeholder, EXACT);
  if (target.kind === "testid") return page.getByTestId(target.testid);
  return page.locator(target.selector);
}

/** Resolve a target to exactly one visible element, or throw a typed error. */
export async function resolveTarget(page: Page, target: Target): Promise<Locator> {
  const visible = buildLocator(page, target).filter({ visible: true });
  const index = chooseIndex(target, await visible.count());
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
export function pickOption(options: readonly SelectOptionInfo[], wanted: string): { label: string } | { value: string } | null {
  if (options.some((option) => option.label === wanted)) return { label: wanted };
  if (options.some((option) => option.value === wanted)) return { value: wanted };
  return null;
}
