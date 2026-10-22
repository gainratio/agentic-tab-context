/**
 * Strict argv tokenizer: flags (long, short alias, --flag=value), positionals, `--`, and help.
 */
import { type CommandSpec, FLAG_KINDS, type FlagName, type Parsed, SHORT_ALIASES, invalid } from "./grammar.js";

export const HELP_TOKENS = new Set(["--help", "-h"]);
export class HelpSignal {}

export interface FlagToken {
  flag: FlagName;
  inline: string | undefined;
  spelling: string;
}

export function isFlagLike(token: string): boolean {
  return token.startsWith("-") && token.length > 1;
}

export function splitFlag(command: string, token: string, allowed: readonly FlagName[]): FlagToken {
  const eq = token.indexOf("=");
  const spelling = eq === -1 ? token : token.slice(0, eq);
  const inline = eq === -1 ? undefined : token.slice(eq + 1);
  const short = spelling.slice(1);
  const name = spelling.startsWith("--")
    ? spelling.slice(2)
    : Object.hasOwn(SHORT_ALIASES, short)
      ? SHORT_ALIASES[short]
      : undefined;
  if (name === undefined || !Object.hasOwn(FLAG_KINDS, name) || !allowed.includes(name as FlagName)) {
    invalid(`${command}: unknown flag ${spelling}`);
  }
  return { flag: name as FlagName, inline, spelling };
}

export function takeValue(command: string, token: FlagToken, next: string | undefined): string {
  if (token.inline !== undefined) return token.inline;
  if (
    next === undefined ||
    next.startsWith("--") ||
    next === "-c" ||
    next === "-q" ||
    next === "-b" ||
    next === "-a" ||
    HELP_TOKENS.has(next)
  ) {
    invalid(`${command}: ${token.spelling} requires a value (use ${token.spelling}=VALUE for values starting with "--")`);
  }
  return next;
}

export function recordFlag(parsed: Parsed, token: FlagToken, next: string | undefined): number {
  if (parsed.values.has(token.flag) || parsed.booleans.has(token.flag)) {
    invalid(`${parsed.command}: duplicate flag --${token.flag}`);
  }
  if (FLAG_KINDS[token.flag] === "boolean") {
    if (token.inline !== undefined) invalid(`${parsed.command}: ${token.spelling} does not take a value`);
    parsed.booleans.add(token.flag);
    return 0;
  }
  parsed.values.set(token.flag, takeValue(parsed.command, token, next));
  return token.inline === undefined ? 1 : 0;
}

export function tokenize(command: string, args: readonly string[], spec: CommandSpec): Parsed {
  const parsed: Parsed = { command, positionals: [], values: new Map(), booleans: new Set() };
  let onlyPositionals = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (onlyPositionals || !isFlagLike(token)) {
      parsed.positionals.push(token);
    } else if (token === "--") {
      onlyPositionals = true;
    } else if (HELP_TOKENS.has(token)) {
      throw new HelpSignal();
    } else {
      i += recordFlag(parsed, splitFlag(command, token, spec.flags), args[i + 1]);
    }
  }
  return parsed;
}

export function checkPositionalCount(parsed: Parsed, spec: CommandSpec): void {
  const max = spec.positionals.length;
  if (parsed.positionals.length > max) {
    const extra = parsed.positionals[max] ?? "";
    invalid(`${parsed.command}: unexpected argument "${extra}"`);
  }
}
