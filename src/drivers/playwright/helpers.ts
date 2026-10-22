/**
 * Action helpers, error mapping, and navigation settling for PlaywrightDriver.
 */
import { errors, type Locator, type Page } from "playwright-core";
import { AtcError, type ErrorCode } from "../../contracts/errors.js";
import type { Target } from "../../contracts/types.js";
import { describeTarget, pickOption, type SelectOptionInfo } from "../target.js";

export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;
const ERROR_PAGE_SETTLE_MS = 2_000;

export interface FailureContext {
  action: string;
  code: ErrorCode;
  details?: Record<string, unknown>;
  secret?: string;
}

export interface DisconnectableState {
  disconnected: boolean;
  closing?: Promise<void>;
  readonly disconnectCallbacks: Array<() => void>;
}

export function fireDisconnect(state: DisconnectableState): void {
  if (state.disconnected) return;
  state.disconnected = true;
  for (const callback of state.disconnectCallbacks.splice(0)) {
    try {
      callback();
    } catch {
      // Listener errors must not break shutdown.
    }
  }
}

export async function selectOption(locator: Locator, target: Target, value: string): Promise<void> {
  const options = await readSelectOptions(locator);
  if (options === null) {
    throw new AtcError("ACTION_FAILED", `Target ${describeTarget(target)} is not a <select> element`);
  }
  const choice = pickOption(options, value);
  if (choice === null) {
    throw new AtcError(
      "TARGET_NOT_FOUND",
      `The <select> matched by ${describeTarget(target)} has no option with that label or value`,
      { matched: 0 },
    );
  }
  await locator.selectOption(choice, { timeout: ACTION_TIMEOUT_MS });
}

function readSelectOptions(locator: Locator): Promise<SelectOptionInfo[] | null> {
  return locator.evaluate((element) =>
    element instanceof HTMLSelectElement
      ? Array.from(element.options, (option) => ({ label: option.label, value: option.value }))
      : null,
  );
}

export async function navigation(
  state: DisconnectableState,
  page: Page,
  failure: FailureContext,
  run: () => Promise<unknown>,
): Promise<void> {
  await guard(state, failure, async () => {
    try {
      await run();
    } catch (error) {
      await settleErrorPage(page, error);
      throw error;
    }
  });
}

async function settleErrorPage(page: Page, error: unknown): Promise<void> {
  if (!/net::ERR_(?!ABORTED)/.test(firstLine(error))) return;
  try {
    if (!page.url().startsWith("chrome-error:")) {
      await page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: ERROR_PAGE_SETTLE_MS,
      });
    }
    await page.waitForLoadState("load", { timeout: ERROR_PAGE_SETTLE_MS });
  } catch {
    // Best-effort error-page settle.
  }
}

export function navFailure(action: string, url: string): FailureContext {
  return { action, code: "NAVIGATION_FAILED", details: { url } };
}

export async function guard<T>(
  state: DisconnectableState,
  failure: FailureContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (state.closing !== undefined && !(error instanceof AtcError)) {
      throw new AtcError("CONTEXT_CLOSED", `Cannot ${failure.action}: the browser context closed`);
    }
    throw toAtcError(error, failure);
  }
}

export function toAtcError(error: unknown, failure: FailureContext): AtcError {
  if (error instanceof AtcError) return error;
  const reason = scrub(firstLine(error), failure.secret);
  const details = failure.details ?? {};
  if (error instanceof errors.TimeoutError) {
    return new AtcError("TIMEOUT", `Timed out trying to ${failure.action}: ${reason}`, details);
  }
  if (/has been closed/i.test(reason)) {
    return new AtcError("CONTEXT_CLOSED", `Cannot ${failure.action}: the browser context closed`, details);
  }
  return new AtcError(failure.code, `Failed to ${failure.action}: ${reason}`, details);
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n")[0] ?? "").trim();
}

function scrub(text: string, secret: string | undefined): string {
  if (secret === undefined || secret === "") return text;
  return text.split(secret).join("[redacted]");
}
