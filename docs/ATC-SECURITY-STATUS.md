# ATC security status after the 0.5.0 side-panel work

This tracks the findings in [ATC-SECURITY-REVIEW.md](ATC-SECURITY-REVIEW.md). It is deliberately conservative: “partial” means a useful control exists but the full remediation does not.

| Finding | Status | What exists now | Still missing |
|---|---|---|---|
| S-01 user-only share gate | Implemented for extension tabs | The side panel is the share path; unshared extension tabs return `TAB_NOT_SHARED`. Managed tabs opened by `atc open` are separate. `ATC_ALLOW_AGENT_BIND=1` is a test/backward escape hatch. | A consent store for managed tabs and finer-grained grants. |
| S-02 sensitive deny/classification | Implemented | `src/daemon/sensitive.ts`; CLI/agent bind returns `ACTION_BLOCKED_SENSITIVE`; side panel locks sensitive rows and requires confirmation. | A user-maintained domain list. |
| S-03 secret redaction beyond passwords | Implemented | Token-like URL params, `Authorization` headers, `Cookie`/`Set-Cookie` values, OTP/CVV/card numbers, `sk-`/`ghp_`/`AIza`/JWT tokens, password/`one-time-code`/`cc-*` controls, bindings, and `state.json` are redacted. | Custom user-defined field label rules. |
| S-04 screenshots unredacted | Partial | `atc screenshot --redact` masks password/one-time-code/card fields before capture and removes masks after; pixel-tested. | Default-on capture, canvas/video/cross-origin iframe masks, and a defined unsupported guarantee. |
| S-05 page-content provenance | Implemented | `PageState` and `inspect` snapshots return `provenance: "untrusted-page"` as an explicit structural trust marker alongside doc guidance. | Host-side delimiter rendering. |
| S-06 page-world log integrity | Open | Isolated-world inspect/actions; console/network capture is still page-world. | CDP or browser-supported trusted capture. |
| S-07 wrong-tab actions | Partial | Multiple contexts are explicit; `--each` is opt-in and returns per-tab results; `--context`/bindings address a tab. | Fail on unqualified actions when more than one context is open. |
| S-09 arbitrary file upload | Implemented | `src/contracts/path-policy.ts` rejects null bytes, `..` traversal, symlink escapes, and sensitive credential/system files (`.ssh`, `.gnupg`, `.aws`, `.env`, `.npmrc`, `.netrc`, `auth-token`, `state.json`, `/etc`, `/System`) with `ACTION_BLOCKED_SENSITIVE` (`E_UNSAFE_PATH`) unless `ATC_ALLOW_SENSITIVE_UPLOAD=1`. | Interactive native file picker and per-upload confirmation UI. |
| S-10 local IPC authentication | Implemented (token) | Per-install `auth-token` (0600); CLI sends it; native host injects it into hello; both sockets reject mismatches with `UNAUTHORIZED`. | A user-approval flow for new clients and peer-identity checks. |
| S-11 extension permission creep | Open | `<all_urls>` + `tabs` + `scripting`; `sidePanel` added. | Optional per-origin host permissions, revoke on unshare. |
| S-12 cross-task contamination | Partial | Contexts can be closed individually; side panel can unshare all visibly. | Workspace IDs/TTL and per-workspace audit. |
| S-13 confirmation/audit | Partial | Sensitive share confirmation; destructive approval is not generalized. | Risk classes and confirmation for submit/send/delete/pay/auth. |
| S-14 version/capability handshake | Implemented | Extension hello carries protocol/version; doctor reports connected protocol and warns on mismatch. | CLI↔daemon version exchange and forced restart. |
| S-15 retention/TTL | Implemented | `ContextRegistry` and `registry-store.ts` prune stale closed contexts past `DEFAULT_CONTEXT_TTL_MS` (24h, configurable via `ATC_CONTEXT_TTL_MS` or `ttlMs`) on reload, creation, and `registry.prune()`. | Screenshot file TTL pruning. |
| S-18 `ATC_EXTENSION_IDS` validation | Implemented | `parseExtensionIds` and `installNativeHost` strictly validate Chrome (`[a-p]{32}`) and Firefox (`addon@domain` / UUID) extension IDs, rejecting malformed values with `INVALID_ARGUMENT`, and `setup`/`doctor` report `allowedIds`. | Dedicated CLI flag replacing env var. |
| S-19 screenshot output path policy | Implemented | `assertSafeScreenshotPath` requires an absolute path and rejects null bytes, `..` traversal segments, and sensitive system/credential directories (`.ssh`, `.gnupg`, `.aws`, `.env`, `/etc`, `/System`) with `INVALID_ARGUMENT` (`E_UNSAFE_PATH`). | Overwrite confirmation flag. |
| S-20 replace/move events | Partial | Service worker registers `onCreated/onRemoved/onMoved/onReplaced`; close is real-browser tested. | Real-browser replace/move regression tests. |
| S-22 effect verification | Partial | Extension actions return `url_changed`/`title_changed`/`no_visible_change`; hidden/disabled produce typed errors. | Condition-based action errors and DOM mutation verification. |
| S-23 frames/shadow roots | Partial | Open shadow roots traversed; hidden targets typed. | Frame tree and explicit `FRAME_UNSUPPORTED`. |
| S-24 log byte caps | Implemented | Console and network capture enforce a 4 KiB per-entry truncation cap and a 256 KiB total buffer byte cap per tab in both `page-agent-watch.js` and `SeqLog` (`src/drivers/playwright/logs.ts`), in addition to the 500-entry cap. | Configurable per-call byte budget. |
| S-25 extension socket caps | Implemented | Inbound frame and extension socket line caps lowered from 64 MiB to 16 MiB (`MAX_INBOUND_FRAME_BYTES`), and concurrent active socket connections are capped in `server.ts` (`MAX_ACTIVE_CONNECTIONS = 64`) and `bridge.ts` (`MAX_EXTENSION_CONNECTIONS = 16`). | Per-client rate limiting. |

## Verification

- `npm run typecheck`
- `npm test` — 637 tests, including real Chromium extension load, real side panel share/activate/unshare, two-tab share + close, sensitive CLI denial, screenshot pixel redaction, and unit tests for S-03, S-05, S-09, S-15, S-18, S-19, S-24, and S-25.
- `npx vitest run test/unit/craft.test.ts`
- Production AML `/screen` browser pass after the demo-bundle incident.
