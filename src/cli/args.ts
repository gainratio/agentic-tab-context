/**
 * Strict, dependency-free argv parser for the atc CLI. It never guesses: any
 * unknown, duplicated, missing or malformed argument is INVALID_ARGUMENT.
 */
import { COMMANDS } from "./argv/commands.js";
import { type ParseResult, invalid } from "./argv/grammar.js";
import { HELP_TOKENS, HelpSignal, checkPositionalCount, tokenize } from "./argv/tokenize.js";

export type { ParseResult } from "./argv/grammar.js";

export function parseArgs(argv: readonly string[]): ParseResult {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || HELP_TOKENS.has(command)) {
    if (rest.length > 0) invalid(`help: unexpected argument "${rest[0] ?? ""}"`);
    return { help: true };
  }
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (spec === undefined) invalid(`unknown command "${command}"; run "atc help" for usage`);
  try {
    const parsed = tokenize(command, rest, spec);
    checkPositionalCount(parsed, spec);
    return spec.build(parsed);
  } catch (error) {
    if (error instanceof HelpSignal) return { help: true };
    throw error;
  }
}

export const USAGE: readonly string[] = [
  "atc bind [query] [--query Q] [--url U] [--title T] [--browser B] [--tab ID] [--active] [--use]   bind to an already-open tab",
  "atc tabs [--browser B] [--query Q]   list all open tabs across Chrome, Safari, Firefox, Brave, Edge, and Extension",
  "atc open <browser> [--profile P] [--headless] [--use]   browser: chromium | chrome | brave | edge | firefox | safari | webkit | extension",
  "atc list",
  "atc use <ctx>",
  "atc current",
  "atc close [ctx] [--context C]",
  "atc goto <url> [--context C]   relative URLs resolve against the current page",
  "atc back | forward | reload [--context C]",
  "atc inspect [--context C]",
  "atc screenshot [--out F] [--full-page] [--context C]",
  "atc console [--since N] [--context C]",
  "atc network [--since N] [--context C]",
  "atc click <target> [--context C]",
  "atc type <target> --value V [--context C]",
  "atc select <target> --value V [--context C]",
  "atc setup   install the agentic-tab-context skill for Claude Code, Codex, and Antigravity",
  "atc doctor   check browser executables, live tabs, extension bridge, and daemon status",
  "atc shutdown   stop the background daemon",
  "atc help",
  "target: exactly one of --role R [--name N] | --label L | --text T | --placeholder P | --testid ID | --selector CSS, plus optional --nth N (0-based)",
  "matching is exact and visible-only; ambiguity fails with AMBIGUOUS_TARGET, absence with TARGET_NOT_FOUND",
  "flags accept --flag value or --flag=value; -c is short for --context; -- ends flag parsing",
  "output: exactly one JSON object on stdout; exit code 0 iff ok is true",
];
