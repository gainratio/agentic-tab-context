# CLAUDE.md — Agentic Tab Context (`atc`)

Canonical agent instructions for `gainratio/agentic-tab-context`.

## Status & Portfolio Pointers

- **Package version:** `0.5.0` (`package.json`, Node `>=22`, MIT)
- **Portfolio hub:** `https://open-source.gainratio.com/agentic-tab-context/`
- **Portfolio engineering standard §8 (WASM):** Not applicable — Node.js CLI/daemon + Manifest V3 WebExtension + Playwright managed-browser driver; zero WASM modules.
- **Portfolio engineering standard §3.1–§3.4:**
  - **§3.1 (Trust gate):** Tested in `test/unit` and `test/e2e` — per-install IPC socket token auth, `0600` permissions, explicit user tab-sharing consent (`TAB_NOT_SHARED`), sensitive upload path refusal (`assertSafeUploadPath`), password-input redaction in DOM inspection and screenshots, and MV3 CSP without `eval`.
  - **§3.2–§3.4:** N/A (no LLM draft structuring, public numeric scores, or generated PDF reports).

## Stack & Layout

- **Language / Toolchain:** TypeScript (`strict`), Node `>=22`, Vitest 4 (`test/unit` + real Chromium `test/e2e`), `playwright-core`, Dagger CI (`.dagger/`).
- **Source tree:**
  - `bin/atc.js` — CLI entrypoint.
  - `src/cli/` — argument parsing, `setup`, and Unix-socket daemon client.
  - `src/contracts/` — protocol schemas, typed `AtcError` codes, path safety policy, and `ATC_HOME` layout.
  - `src/daemon/` — `DaemonService`, `ContextRegistry`, `state.json` persistence, and `atc doctor`.
  - `src/drivers/` — Chrome extension bridge driver, Playwright managed-browser driver, and macOS JXA Safari/Chromium fallback.
  - `src/native/` — Chrome Native Messaging host manifest installer (`com.gainratio.atc.json`).
  - `src/transport/` — line-delimited JSON Unix domain socket server/client.
  - `extension/` — Manifest V3 Chrome extension (service worker, toolbar popup, multi-tab side panel, content page agent).
  - `skills/agentic-tab-context/SKILL.md` — bundled skill installed for Claude Code, Codex, and Antigravity.

## Core Invariants

1. **No network listening ports.** Communication uses local user-only Unix sockets under `ATC_HOME` (`~/.atc`) authenticated by a per-install token and Chrome Native Messaging.
2. **Explicit per-tab user consent.** An agent cannot bind an unshared live browser tab (`TAB_NOT_SHARED`) unless the user shares it in the side panel or popup.
3. **Secret redaction by default.** Password fields are redacted from `atc inspect`, `atc screenshot`, and error output; sensitive local dotfile paths are refused by `atc upload`.
4. **Single-line JSON CLI contract.** Every `atc` command emits one deterministic JSON line (`ok: true` or typed `AtcError` code).

## Quality Gates (Non-Negotiable)

Run `npm run gate` locally (mirrors Dagger CI `dagger call quality sync`):

- **Scar (unshared-tab bind):** Early builds let an agent bind arbitrary open tabs without user confirmation. `binding.test.ts` and `extension-side-panel.test.ts` enforce `TAB_NOT_SHARED` unless shared by the user.
- **Scar (macOS JXA error echoing):** `osascript` echoed `throw new Error("ATC_TAB_GONE")` in command text on unrelated failures, making every JXA error look like a closed tab (`macos.test.ts`). Match structured stderr codes, never echoed source.
- **Scar (Unix socket path length):** macOS/Linux cap Unix domain socket paths near ~104 bytes; `unix-server.ts` fails closed with an actionable `ATC_HOME` message (`server.test.ts`).

## Commands

```sh
npm run build          # compile TypeScript to dist/
npm run typecheck      # strict tsc across src/ and test/
npm run test:unit      # fast unit suite
npm run test:e2e       # real Chromium extension + CLI end-to-end suite
npm run gate           # full local gate: build + typecheck + unit + e2e
```
