# Agentic Tab Context (`atc` / `abt` / `tabctx`) — Specification

Agentic Tab Context (`atc`, aliased as `agentic-tab-context`, `abt`, and `tabctx`) is a deterministic, browser-agnostic CLI, local daemon, and Manifest V3 WebExtension that gives coding assistants a **persistent, sticky browser tab** — binding directly to the tab the user already has open rather than launching redundant browser windows.

## Core Principles
- **Bind first, never open a redundant browser.** `atc bind` discovers open tabs across the WebExtension bridge (`127.0.0.1:43919`), macOS native browsers (`osascript` JXA), and managed Playwright contexts, binding to the matching tab in place.
- **Sticky context.** A context (`ctx_<hex>`) lives in the background daemon until `atc close` or until its tab/browser closes.
- **Deterministic, never guess.** Ambiguous tab queries or DOM locators fail closed with `AMBIGUOUS_TARGET` and the match count/candidates; missing targets fail with `TARGET_NOT_FOUND`. `--tab <tabId>` (for `bind`) and `--nth N` (for DOM actions) are explicit escape hatches.
- **JSON only.** Every command prints **exactly one line** of compact JSON on `stdout`; exit code is `0` iff `"ok": true`.
- **Zero credentials.** Humans authenticate in their own browser window; `atc` never stores or echoes credentials and redacts typed values from error responses.

## Architecture
1. **CLI (`src/cli/`)**: Strict, zero-dependency argument parser (`args.ts`), one-step skill/extension installer (`setup.ts`), and auto-starting Unix socket client (`client.ts`).
2. **Daemon (`src/daemon/`)**: Manages the sticky `ContextRegistry` (`registry.ts`), live tab aggregator & deterministic selector (`tabs.ts`), per-context serialized request router (`server.ts`), and command handlers (`service.ts`).
3. **Drivers (`src/drivers/`)**:
   - `ExtensionDriver` + `ExtensionBridge` (`src/drivers/extension/`): Drives tabs in any browser running the Manifest V3 WebExtension (`extension/`) over `http://127.0.0.1:43919`.
   - `MacosTabDriver` (`src/drivers/macos/`): Zero-config live tab discovery and binding for macOS Chrome, Safari, Brave, and Edge via JXA.
   - `PlaywrightDriver` (`src/drivers/playwright/`): Cross-browser persistent context driver supporting `chromium`, `chrome`, `brave`, `edge`, `firefox`, `safari`, and `webkit`.
