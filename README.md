# tabctx — a persistent, sticky browser context for coding assistants

`tabctx` (TabContext) is a small, browser-agnostic CLI that gives coding assistants a **persistent
browser tab/session**. The assistant creates a context once (`tabctx open chromium` → `ctx_7f21`) and
keeps operating on it across separate shell commands. The human establishes identity (logs in, MFA, SSO,
passkeys) in that same visible browser; the agent establishes navigation; TabContext preserves the
context in between. Every command prints exactly one JSON object, and tabctx never handles credentials.

## Install and build

Requires Node.js 22 or newer.

```sh
npm install
npm run build
npm link        # puts `tabctx` on your PATH
```

Chromium is driven through `playwright-core`, which does not download browsers. Point
`TABCTX_CHROMIUM_PATH` at a Chromium/Chrome executable if Playwright cannot find one.

## Core workflow

```sh
tabctx open chromium --use                 # {"ok":true,"context":"ctx_7f21",...}  headed window appears
tabctx goto https://app.example.com/login  # {"ok":true,"url":"...","title":"Sign in"}

# The human now signs in by hand in that window (password, MFA, SSO, passkey).
# tabctx never sees or types credentials.

tabctx goto /settings/billing              # relative URLs resolve against the current page
tabctx inspect                             # {"ok":true,"url":...,"title":...,"aria":"<ARIA snapshot>"}
tabctx type --label "Company name" --value "Acme"
tabctx select --label "Plan" --value "Pro"
tabctx click --role button --name "Save"
tabctx console --since 0                   # {"ok":true,"entries":[...],"next":17}
tabctx network --since 0                   # look for failed requests / 4xx / 5xx
tabctx reload
tabctx inspect                             # verify the change stuck
tabctx close                               # when done; the login stays in the profile
```

Because the session lives in a background daemon, each line above can be a separate process (or a
separate assistant turn) and the tab, its history and its form state are still there.

## Command reference

| Command | Result |
|---|---|
| `tabctx open <browser> [--profile P] [--headless] [--use]` | `{ok, context, ...}` — `browser` is one of `chromium`, `chrome`, `safari`, `firefox` |
| `tabctx list` | `{ok, contexts: [...], current}` |
| `tabctx use <ctx>` | `{ok, context}` — make `<ctx>` the current context |
| `tabctx current` | `{ok, context}` (or `NO_CURRENT_CONTEXT`) |
| `tabctx close [ctx]` | `{ok, context}` — closes `<ctx>`, or the current context |
| `tabctx goto <url>` | `{ok, url, title}` — relative URLs resolve against the current page |
| `tabctx back` / `forward` / `reload` | `{ok, url, title}` |
| `tabctx inspect` | `{ok, url, title, aria}` — ARIA snapshot (YAML) of the page |
| `tabctx screenshot [--out F] [--full-page]` | `{ok, path, bytes}` — default path under `$TABCTX_HOME/screenshots` |
| `tabctx console [--since N]` | `{ok, entries, next}` — pass `--since <next>` to get only newer entries |
| `tabctx network [--since N]` | `{ok, entries, next}` |
| `tabctx click <target>` | `{ok, matched: 1}` |
| `tabctx type <target> --value V` | `{ok, matched: 1}` |
| `tabctx select <target> --value V` | `{ok, matched: 1}` |
| `tabctx shutdown` | stops the background daemon (`{ok, running: false}` if none was running) |
| `tabctx help` / `--help` / `-h` | `{ok, usage: [...]}` |

Every page command (`goto` through `select`, plus `close`) accepts `--context C` (short: `-c C`) to
target a specific context instead of the current one. Context IDs always look like `ctx_<hex>`.

Argument rules (the parser is strict and never guesses):

- Both `--flag value` and `--flag=value` work. Use `--flag=value` for values that start with `--`.
- `--` ends flag parsing; everything after it is positional (e.g. `tabctx goto -- -odd-path`).
- Unknown commands or flags, duplicate flags, missing values, extra positionals, bad integers and
  unknown browsers fail with `INVALID_ARGUMENT` before anything is sent to the daemon.
- `--profile` must match `^[A-Za-z0-9_-]{1,64}$` (default profile: `default`).

## Targets and determinism

`click`, `type` and `select` need exactly one locator:

| Flag | Matches |
|---|---|
| `--role R [--name N]` | elements with ARIA role `R` (and accessible name `N`) |
| `--label L` | form controls labelled `L` |
| `--text T` | elements whose text is `T` |
| `--placeholder P` | inputs with placeholder `P` |
| `--testid ID` | elements with that test id |
| `--selector CSS` | a raw CSS selector |

plus optional `--nth N` (0-based, non-negative integer). `--name` is only valid with `--role`. Zero or
several locator flags is `INVALID_ARGUMENT`.

tabctx never guesses:

- Names, labels and text match **exactly**, and only **visible** elements count.
- More than one match fails with `AMBIGUOUS_TARGET` and the match count, e.g.
  `{"ok":false,"error":"AMBIGUOUS_TARGET","message":"...","matched":2}`.
- No match fails with `TARGET_NOT_FOUND`.
- `--nth N` is the explicit escape hatch: pick the N-th of the visible exact matches.

## Output and exit codes

- Every invocation prints **exactly one line** of compact JSON on stdout and nothing else.
- Exit code is `0` iff the object has `"ok": true`, otherwise `1`.
- Failures look like `{"ok":false,"error":"<CODE>","message":"...", ...details}`, where `<CODE>` is one
  of: `INVALID_ARGUMENT`, `UNSUPPORTED_BROWSER`, `CONTEXT_NOT_FOUND`, `CONTEXT_CLOSED`,
  `NO_CURRENT_CONTEXT`, `TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `NAVIGATION_FAILED`, `ACTION_FAILED`,
  `TIMEOUT`, `DAEMON_UNAVAILABLE`, `INTERNAL`.
- The CLI waits up to 120 s for a daemon reply (`TIMEOUT` after that).

## The daemon

The first command that needs it starts a detached background daemon (`node dist/daemon/main.js`)
listening on `$TABCTX_HOME/daemon.sock`; the CLI waits up to 10 s for it to answer `ping`, otherwise it
fails with `DAEMON_UNAVAILABLE` and points at the daemon log. `tabctx shutdown` stops it (and never
starts one). The daemon owns the context registry, the current-context pointer and the browser
processes; the CLI is a thin client that sends one NDJSON request and prints the one response.

## Environment variables

| Variable | Effect |
|---|---|
| `TABCTX_HOME` | State directory (default `~/.tabctx`). Separate homes give fully separate daemons. |
| `TABCTX_HEADLESS` | `1` makes `open` headless by default (`--headless` always forces headless). |
| `TABCTX_CHROMIUM_PATH` | Chromium/Chrome executable to launch. |

`TABCTX_HEADLESS` and `TABCTX_CHROMIUM_PATH` are read by the daemon, so they take effect when the daemon
starts; run `tabctx shutdown` after changing them.

## Files under `TABCTX_HOME`

| Path | Contents |
|---|---|
| `daemon.sock` | Unix socket the CLI talks to (mode `0600`) |
| `daemon.log` | Daemon log (JSON lines) |
| `state.json` | Registry snapshot: contexts and the current context |
| `profiles/<name>/` | Browser user-data directory per profile (cookies, logins) |
| `screenshots/` | Default screenshot output directory |

## Security notes

- The daemon listens only on a local Unix socket, created with mode `0600` inside a `0700` directory.
  There is no TCP listener.
- tabctx never asks for, stores or types credentials. Humans log in themselves in the visible window.
- Profiles **persist logins on disk**: anything in `~/.tabctx/profiles` (or `$TABCTX_HOME/profiles`) is
  as sensitive as the browser sessions it holds. Do not commit, share or back it up casually; delete a
  profile directory to forget its logins.
- `inspect`, `console`, `network` and screenshots can expose whatever the page shows. Treat their output
  like the page itself.

## Browser support

| Browser | Status |
|---|---|
| `chromium`, `chrome` | Supported. Playwright `launchPersistentContext` with one user-data dir per profile, headed by default so the human can log in. |
| `safari` | Planned; returns `UNSUPPORTED_BROWSER`. Safari's WebDriver runs in an isolated automation window that locks out manual input, which conflicts with "the human logs in manually"; that must be solved before Safari ships. |
| `firefox` | Planned; returns `UNSUPPORTED_BROWSER`. |

## Non-goals

tabctx is **not** an agent, an MCP server, a browser, a workflow engine, an auth/credential manager or
an RPA platform. It keeps one browser context alive between commands and reports on it in
deterministic JSON; deciding what to do next is the assistant's job.

## Development

```sh
npm run typecheck
npm run test:unit
npm run test:e2e     # needs a Chromium executable (TABCTX_CHROMIUM_PATH)
```
