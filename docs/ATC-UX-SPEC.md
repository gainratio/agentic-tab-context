# ATC UX + Reliability Spec (draft)

Status: proposal  
Scope: browser extension, daemon, CLI, agent-host integration  
Goal: make ATC usable by non-developers and reliable enough for real multi-tab work.

Security audit against this spec: [ATC-SECURITY-REVIEW.md](ATC-SECURITY-REVIEW.md).  
Interactive prototype: [prototype/index.html](../prototype/index.html).

## 1. Problem

Today ATC binds one tab per context. Users and agents must rebind constantly, cannot see what is shared, and can act on the wrong tab after navigation or a context switch. Action failures are opaque: a click may match but do nothing, a page may be stuck loading, or an element may be offscreen, with no diagnostic.

The CLI is a developer tool. Most users will interact through a browser side panel and an in-chat tab picker.

## 2. Goals

- No CLI required for normal use.
- A visible, searchable workspace of shared tabs.
- Safe multi-tab context for read/inspect workflows.
- Explicit target selection for actions; never guess between tabs.
- Every action returns a verifiable effect or an actionable error.
- Tab close/move/navigation is reflected immediately.
- Sensitive tabs are excluded by default.
- Read-only code/debug context: DOM, React component hint, console, network, source location.
- One state model shared by extension UI, CLI, and agent host.

## 3. Non-goals

- Arbitrary JavaScript execution in the page (`eval`).
- Silent "share every tab".
- Agent-initiated permission or scope expansion.
- Editing source code through the browser extension.
- Cross-browser feature parity for Safari in v1.

## 4. Users

| User | Need |
|---|---|
| End user | Ask an assistant to work with a few open tabs without configuring tools |
| Developer | Debug selectors, actions, network, and component state |
| Agent | Clear tab/element targets, effect reports, and safe recovery |

## 5. UX principles

1. Say **Share**, not bind.
2. Show what is shared; make revoking one click.
3. Ambiguity becomes a picker, not a guess.
4. Actions are visible: highlight, result, retry.
5. Sensitive is locked, not hidden.
6. No spinner theatre; local state updates instantly.
7. Errors say what happened and what to do next.

## 6. Core UX

### 6.1 Side panel — Shared tabs

- Search across title, hostname, URL, window.
- Filter: All / Shared / Sensitive / This window.
- Row: favicon, title, hostname, badges: Shared, Active, Needs access, Sensitive, Unsupported.
- Click row = focus tab; radio/indicator = make active target.
- Closing a browser tab removes it with a toast.
- Actions: Share selected, Share current, Share matching, Clear all.

### 6.2 First run

- Explain in one sentence.
- `Share this tab` and `Choose tabs`.
- No account or token setup in the UI.

### 6.3 Share confirmation

- Single tab: inline, no modal.
- Multiple: modal listing every tab and domain.
- Sensitive domains excluded and named.
- Confirm button states the exact count.

### 6.4 Chat-side tab picker

When several tabs match an intent, the host UI shows candidate rows with title + hostname. User selects one or more; workspace updates; agent resumes.

### 6.5 Action feedback

- Brief highlight on target before click.
- Action card: tab, action, element, URL/DOM effect, duration.
- Failure: reason + Retry / Inspect / Take over.
- Risk actions (submit, send, delete, pay, auth) require confirmation.

### 6.6 Debug view (read-only)

Per-tab summary:

- framework and build type
- component path and source location when available
- console errors
- failed requests
- props/state keys only; values redacted
- last action correlation

No page script execution. No source dumping.

## 7. Functional requirements

### Workspace

- Multiple shared tabs per workspace.
- Stable key: browser + windowId + tabId.
- One active tab per workspace.
- Workspace expires or is cleared by user.
- Events: `tabs.onRemoved`, `onReplaced`, `onMoved`, `onUpdated` reconcile state.

### Actions

- `inspect --tab <id>` and `click/type --tab <id>`.
- Unqualified action fails if >1 tab shared.
- `--each` is explicit and returns per-tab results.
- Locator priority: stable element ID, role+name, label, text fallback.
- Scroll into view, wait for visible/enabled/stable, act, verify effect.

### Effects and errors

Every action returns one of:

- URL changed
- title changed
- DOM changed
- navigation started
- no effect (`ACTION_NO_EFFECT`)

Error codes include: `TAB_CLOSED`, `TAB_NOT_SHARED`, `PERMISSION_MISSING`, `PAGE_NOT_READY`, `SNAPSHOT_STALE`, `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_AMBIGUOUS`, `FRAME_UNSUPPORTED`, `ACTION_BLOCKED_SENSITIVE`, `CONFIRMATION_REQUIRED`.

### Inspection

- Offscreen and open-shadow-root content inspectable.
- Cross-origin iframes/closed shadow roots marked unsupported.
- `inspect --all` returns per-tab summaries with char budgets, not merged DOM.
- `wait-for`, `scroll`, `press`, `frames` supported.

### Version compatibility

The CLI, daemon, native host, and extension must exchange their package/extension
versions on connect.

- `atc doctor` reports all four versions and fails closed on an incompatible major.
- `atc help` and command behavior must come from the running daemon's version, not
  only the installed CLI shim.
- A documented command must never return `unknown method` because the installed
  CLI or daemon is older than the skill/docs.
- Version mismatch errors must tell the user the exact upgrade command.

## 8. Security model

### Scope

- Only the user can add tabs or permissions.
- Agent API cannot call `share_all` or change the consent envelope.
- Optional host permissions per origin; `tabs` only for listing.
- Sensitive default deny: mail, banking, health, insurance, password managers, `chrome://`, Web Store, file URLs.

### Data

- Redact password/secret fields, authorization headers, cookies, token-like props/state/URL params.
- Screenshot redaction at capture time.
- Page snapshots are untrusted data with provenance; they never change permissions.
- No page content persisted after task; metadata TTL.

### Local IPC

- Daemon binds `127.0.0.1`.
- Per-install bearer token.
- Extension ID allowlist and `Origin` checks.
- No wildcard CORS.
- New client requires user approval.

### Risky actions

- Action risk classes: read, navigate, input, commit.
- Commit actions require explicit confirmation.
- Credentials and 2FA remain user-only.
- Audit log is sanitized and user-visible.

## 9. Architecture

```
Browser extension (side panel + content scripts)
        │  authenticated local IPC
        ▼
Workspace daemon ─── CLI (debug)
        │
        ├── agent host adapter (chat picker, action cards)
        └── diagnostics (DOM/a11y, console, network, framework hint)
```

Single source of truth: daemon workspace state. UI, CLI, and host are clients.

## 10. Phases

### Phase 1 — Workspace + side panel

- Tab list/search/select, share current/selected, active target.
- Close/move reconciliation.
- No CLI dependency.

### Phase 2 — Reliable actions

- Tab-addressed actions, stable element IDs.
- Wait/scroll/press/frames.
- Effect reports and error taxonomy.

### Phase 3 — Chat integration

- Candidate picker when ambiguous.
- Context chips in chat.
- Action cards and confirmations.

### Phase 4 — Security hardening

- Sensitive deny list, consent envelope, redaction.
- Local IPC authentication and audit log.

### Phase 5 — Debug/code context

- Console/network/action correlation.
- React component path and redacted props/state.
- Source-map location; no eval.

## 11. Acceptance criteria

- A non-developer can share a tab and complete a task without opening a terminal.
- With 2+ shared tabs, no action executes without an explicit target.
- Closing a tab removes it from the UI and later actions return `TAB_CLOSED`.
- 100% of actions return an effect or a specific error.
- Sensitive tabs are never shared silently.
- Agent cannot expand its own tab or permission scope.
- No secrets appear in ARIA snapshots, screenshots, logs, or diagnostics.
- `inspect --all` does not exceed the configured context budget.

## 12. Metrics

- Time to first shared tab < 5s.
- Wrong-tab actions = 0.
- Action result coverage = 100%.
- Multi-tab tasks completed without CLI > 95%.
- Users can state what is shared > 90% (usability test).

## 13. Open questions

- Should workspaces persist across browser restart?
- Maximum shared tabs per workspace before UI warns?
- Which host apps ship the chat picker in v1?
- Source-map access: local build only, or user-supplied map server?
- Do we expose a compact "diagnostics bundle" export for bug reports?
