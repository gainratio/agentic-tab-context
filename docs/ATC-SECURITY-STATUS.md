# ATC security status after the 0.5.0 side-panel work

This tracks the findings in [ATC-SECURITY-REVIEW.md](ATC-SECURITY-REVIEW.md). It is deliberately conservative: “partial” means a useful control exists but the full remediation does not.

| Finding | Status | What exists now | Still missing |
|---|---|---|---|
| S-01 user-only share gate | Implemented for extension tabs | The side panel is the share path; unshared extension tabs return `TAB_NOT_SHARED`. Managed tabs opened by `atc open` are separate. `ATC_ALLOW_AGENT_BIND=1` is a test/backward escape hatch. | A consent store for managed tabs and finer-grained grants. |
| S-02 sensitive deny/classification | Implemented | `src/daemon/sensitive.ts`; CLI/agent bind returns `ACTION_BLOCKED_SENSITIVE`; side panel locks sensitive rows and requires confirmation. | A user-maintained domain list. |
| S-03 secret redaction beyond passwords | Partial | Token-like URL params, console/network text, bindings, and `state.json` are redacted; password fields remain redacted. | Complete field-level classification (OTP, card, auth headers, custom labels). |
| S-04 screenshots unredacted | Partial | `atc screenshot --redact` masks password/one-time-code/card fields before capture and removes masks after; pixel-tested. | Default-on capture, canvas/video/cross-origin iframe masks, and a defined unsupported guarantee. |
| S-05 page-content provenance | Partial | Page data remains labelled untrusted in docs; no structural trust marker. | A provenance field in `PageState` and host rendering. |
| S-06 page-world log integrity | Open | Isolated-world inspect/actions; console/network capture is still page-world. | CDP or browser-supported trusted capture. |
| S-07 wrong-tab actions | Partial | Multiple contexts are explicit; `--each` is opt-in and returns per-tab results; `--context`/bindings address a tab. | Fail on unqualified actions when more than one context is open. |
| S-09 arbitrary file upload | Open | Upload still accepts a CLI path. | User-picker/allowlist and per-upload confirmation. |
| S-10 local IPC authentication | Implemented (token) | Per-install `auth-token` (0600); CLI sends it; native host injects it into hello; both sockets reject mismatches with `UNAUTHORIZED`. | A user-approval flow for new clients and peer-identity checks. |
| S-11 extension permission creep | Open | `<all_urls>` + `tabs` + `scripting`; `sidePanel` added. | Optional per-origin host permissions, revoke on unshare. |
| S-12 cross-task contamination | Partial | Contexts can be closed individually; side panel can unshare all visibly. | Workspace IDs/TTL and per-workspace audit. |
| S-13 confirmation/audit | Partial | Sensitive share confirmation; destructive approval is not generalized. | Risk classes and confirmation for submit/send/delete/pay/auth. |
| S-14 version/capability handshake | Implemented | Extension hello carries protocol/version; doctor reports connected protocol and warns on mismatch. | CLI↔daemon version exchange and forced restart. |
| S-15 retention/TTL | Open | Contexts persist in `state.json`. | TTL/prune for contexts, grants, screenshots. |
| S-18 `ATC_EXTENSION_IDS` validation | Open | Allowlist support exists. | Strict ID validation and explicit output. |
| S-19 screenshot output path policy | Open | Absolute path required. | Allowed roots and overwrite protection. |
| S-20 replace/move events | Partial | Service worker registers `onCreated/onRemoved/onMoved/onReplaced`; close is real-browser tested. | Real-browser replace/move regression tests. |
| S-22 effect verification | Partial | Extension actions return `url_changed`/`title_changed`/`no_visible_change`; hidden/disabled produce typed errors. | Condition-based action errors and DOM mutation verification. |
| S-23 frames/shadow roots | Partial | Open shadow roots traversed; hidden targets typed. | Frame tree and explicit `FRAME_UNSUPPORTED`. |
| S-24 log byte caps | Open | Entry-count cap. | Per-entry/total byte caps. |
| S-25 extension socket caps | Open | 64 MiB inbound cap. | Lower caps and connection limits. |

## Verification

- `npm run typecheck`
- `npm test` — 597 tests, including real Chromium extension load, real side panel share/activate/unshare, two-tab share + close, sensitive CLI denial, screenshot pixel redaction.
- `npx vitest run test/unit/craft.test.ts`
- Production AML `/screen` browser pass after the demo-bundle incident.
