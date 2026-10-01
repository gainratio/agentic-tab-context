# TabContext (`tabctx`) — spec

TabContext is a small, browser-agnostic CLI that gives coding assistants a **persistent browser
tab/session**. The assistant creates a context once (`tabctx open chromium` → `ctx_7f21`) and keeps
operating on it across commands. The human establishes identity (logs in, MFA, SSO, passkeys) in that
same visible browser; the agent establishes navigation; TabContext preserves context. tabctx never
handles credentials.

## Core principles
- **Sticky context.** A context lives until `tabctx close` or until its browser disappears.
- **Optional current context.** `tabctx use ctx_7f21` makes later commands target it implicitly.
- **Deterministic, never guess.** Ambiguous targets fail with `AMBIGUOUS_TARGET` and the match count;
  missing targets fail with `TARGET_NOT_FOUND`. `--nth N` is the explicit escape hatch.
- **JSON only.** Every command prints exactly one JSON object on stdout; exit code 0 iff `"ok": true`.
- **Browser-native IDs stay internal.** Only `ctx_*` IDs cross the CLI boundary.
- **Not** an agent, MCP server, browser, workflow engine, auth manager, or RPA platform.

## Architecture
`assistant --shell--> tabctx CLI --unix socket NDJSON--> daemon (context registry, sticky state,
driver management) --> BrowserDriver (chromium now; safari/firefox later) --> persistent browser`.

The CLI auto-starts the daemon on first use. Contracts live in `src/contracts/`.

## Commands (MVP)
| Command | Result |
|---|---|
| `tabctx open <browser> [--profile P] [--headless] [--use]` | `{ok, context}` |
| `tabctx list` | `{ok, contexts: [...], current}` |
| `tabctx use <ctx>` / `tabctx current` | `{ok, context}` |
| `tabctx close [ctx]` | `{ok, context}` |
| `tabctx goto [--context C] <url>` (relative URLs resolve against the current page) | `{ok, url, title}` |
| `tabctx back|forward|reload` | `{ok, url, title}` |
| `tabctx inspect` | `{ok, url, title, aria}` |
| `tabctx screenshot [--out F] [--full-page]` | `{ok, path, bytes}` |
| `tabctx click <target>` | `{ok, matched: 1}` |
| `tabctx type <target> --value V` / `tabctx select <target> --value V` | `{ok, matched: 1}` |
| `tabctx console [--since N]` / `tabctx network [--since N]` | `{ok, entries, next}` |

Targets: `--role R [--name N]`, `--label L`, `--text T`, `--placeholder P`, `--testid ID`,
`--selector CSS`, each with optional `--nth N` (0-based). Names/labels/text match **exactly**, and only
**visible** elements count.

## Browser support
- **Chromium** (MVP): Playwright `launchPersistentContext` with a per-profile user-data dir, headed by
  default so the human can log in. `TABCTX_CHROMIUM_PATH` overrides the executable.
- **Safari / Firefox**: return `UNSUPPORTED_BROWSER` for now. Safari's WebDriver runs in an isolated
  automation window that locks out manual input, which conflicts with "human logs in manually"; this
  must be solved before Safari ships.
