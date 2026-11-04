import type { ActionResult } from "../contracts/types.js";
import { actionEffect, type LocationSnapshot } from "./action-effect.js";

/** Attach a best-effort effect to a successful action without changing failures. */
export async function observedAction(
  run: () => Promise<ActionResult>,
  before: () => LocationSnapshot | undefined,
  after: () => Promise<LocationSnapshot | null>,
): Promise<ActionResult> {
  const result = await run();
  const previous = before();
  const next = await after();
  if (previous === undefined || next === null) return { ...result, effect: "unknown" };
  return { ...result, effect: actionEffect(previous, next) };
}
