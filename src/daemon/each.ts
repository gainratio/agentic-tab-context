import type { Method, Request, Response } from "../contracts/protocol.js";
import { isRecord } from "./params.js";
import type { ContextRegistry } from "./registry.js";

const EACH_METHODS: ReadonlySet<Method> = new Set<Method>(["click", "type", "select", "press", "upload"]);

export function isEachRequest(raw: unknown): raw is { method: Method; params: Record<string, unknown> } {
  if (!isRecord(raw) || typeof raw.method !== "string" || !EACH_METHODS.has(raw.method as Method)) return false;
  return isRecord(raw.params) && raw.params.each === true;
}

/** Run one explicit action against every open context, returning per-tab results. */
export async function eachResponse(
  registry: ContextRegistry,
  req: { method: Method; params: Record<string, unknown> },
  run: (request: Request) => Promise<Response>,
): Promise<Response> {
  const results: Array<Record<string, unknown>> = [];
  for (const ctx of registry.list().filter((item) => item.status === "open")) {
    const response = await run({ ...req, params: { ...req.params, context: ctx.id, each: false } } as Request);
    results.push({ context: ctx.id, ...response });
  }
  return { ok: true, results };
}
