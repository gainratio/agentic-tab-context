# ATC Workspace Implementation Plan

Status: proposal  
Companion to [ATC-UX-SPEC.md](ATC-UX-SPEC.md) and [ATC-SECURITY-REVIEW.md](ATC-SECURITY-REVIEW.md).

This maps the spec to the current repository and gives a safe, testable sequence. It deliberately keeps the existing single-context CLI behavior working while adding a workspace layer.

## Current state

- `ContextRegistry` stores contexts with one global `current` (`src/daemon/registry.ts`).
- `atc bind` creates/reuses a context and makes it current by default (`src/daemon/binding.ts`).
- Page commands resolve one `context` (`src/daemon/service.ts`, `src/contracts/protocol.ts`).
- The extension reports every open tab and enforces per-tab serialization (`extension/sw/tabs.js`, `src/drivers/extension/driver.ts`).
- `atc bindings` now lists every open context read-only.

There is no workspace object, no tab-addressed action API, and no side panel.

## Target model

```text
Workspace
  id
  createdAt / expiresAt
  tabs: [contextId]
  activeContextId
  consent: { origins, capabilities, expiresAt, maxTabs }
  actionLog
```

- A **context** remains the per-tab browser connection.
- A **workspace** is the user-selected set of contexts and one active target.
- A **consent** grant is user-owned; the agent cannot create or expand it.
- Unqualified actions resolve only when the workspace has exactly one shared context or an explicitly active target is unambiguous. Otherwise fail.

## Phase A — workspace schema (read-only first)

Files:

- `src/contracts/types.ts`: `Workspace`, `WorkspaceSummary`, `ConsentGrant`.
- `src/contracts/protocol.ts`: `workspace.list`, `workspace.get`, `workspace.share`, `workspace.unshare`, `workspace.setActive`.
- `src/daemon/registry-store.ts`: persist `workspace` alongside `current`; migrate old state to a default workspace.
- `src/daemon/registry.ts`: workspace map, add/remove context, set active; no driver calls.
- `src/daemon/workspace.ts` (new): validation, summaries, derived "unqualified action allowed" rule.
- `src/daemon/service.ts`: handlers; keep `list`/`current`/`use` as compatibility aliases.
- `src/cli/argv/commands.ts`, `src/cli/args.ts`: `atc workspace ...` commands.
- Tests: `test/unit/workspace.test.ts`, `test/unit/registry.test.ts`, `test/e2e/cli.test.ts`.

Acceptance:

- Old `state.json` loads with a default workspace containing existing open contexts.
- Removing a context from the workspace does not close the tab.
- Workspace operations never touch a browser driver.
- `atc bind` still works unchanged.

## Phase B — tab-addressed actions

Files:

- `src/contracts/protocol.ts`: page requests accept `context` (existing) and `workspace` + optional `each`.
- `src/daemon/service.ts` / `page-commands.ts`: resolve target(s) from workspace; reject ambiguous unqualified actions when >1 context.
- `src/cli/argv/commands.ts`: `--tab <ctx>` and `--each` for page actions; `--workspace` for selection.
- `src/daemon/server.ts`: per-target queue keys; `--each` returns results array.
- `test/unit/service.test.ts`, `test/unit/workspace.test.ts`, `test/e2e/cli.test.ts`.

Rules:

- `--tab <ctx>` is explicit and always wins.
- `--each` runs each target sequentially or with bounded concurrency; returns per-tab `{context, ok, effect|error}`.
- No target and more than one workspace tab → `TAB_AMBIGUOUS`.
- No target and exactly one tab → use it.
- Existing `--context` remains compatible.

## Phase C — extension side panel

Files:

- `extension/manifest.json`: `side_panel` entry, `sidePanel` permission.
- `extension/sidepanel/index.html`, `sidepanel.css`, `sidepanel.js` (new).
- `extension/sw/tabs.js`: push tab metadata on create/remove/move/replace; include `windowId`.
- `extension/service-worker.js`: handle `sidepanel:list`, `sidepanel:share`, `sidepanel:unshare`, `sidepanel:set-active`, `sidepanel:close-tab`.
- `src/contracts/extension.ts`: message types for workspace/UI sync.
- `test/e2e/sidepanel.test.ts` (new), `test/unit/extension-tabs.test.ts`.

UI uses the approved prototype interaction model, not the CLI. The panel never sends console/network content; it only manages membership and active target.

## Phase D — action reliability and effects

Files:

- `src/contracts/errors.ts`: add `PAGE_NOT_READY`, `SNAPSHOT_STALE`, `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_AMBIGUOUS`, `ACTION_NO_EFFECT`, `CONFIRMATION_REQUIRED`, `ACTION_BLOCKED_SENSITIVE`, `TAB_NOT_SHARED`.
- `extension/page-agent-actions.js`: scroll into view, wait visible/enabled/stable, act, observe URL/title/DOM mutation.
- `src/drivers/page-agent.ts`, `src/daemon/page-commands.ts`: propagate effect, map errors.
- `test/e2e/page-agent.test.ts`, `test/unit/extension-page-agent.test.ts`.

Do not add `eval`. Keep isolated-world inspect/actions.

## Phase E — security gates

Follow the security review order:

1. Version handshake (`S-14`).
2. Secret redaction beyond passwords (`S-03`, `S-04`).
3. Sensitive deny list and consent (`S-01`, `S-02`).
4. Confirmation + sanitized audit (`S-13`).
5. Fail-closed targeting (`S-07`).
6. IPC token and permission narrowing (`S-10`, `S-11`).

The side panel must not ship as the primary workflow until `S-01`/`S-02` are in place.

## Test matrix

| Area | Unit | E2E |
|---|---|---|
| State migration | `registry.test.ts` | `cli.test.ts` |
| Workspace share/unshare/active | `workspace.test.ts` | `cli.test.ts`, `sidepanel.test.ts` |
| Ambiguous tab rejection | `service.test.ts` | `cli.test.ts` |
| `--each` per-tab results | `service.test.ts` | `cli.test.ts` |
| Side panel close/removal | `extension-tabs.test.ts` | `sidepanel.test.ts` |
| Effect/error taxonomy | `page-agent.test.ts` | `page-agent.test.ts` |
| Sensitive deny/consent | `workspace.test.ts` | `cli.test.ts`, `sidepanel.test.ts` |
| Redaction | `page-agent.test.ts` | `extension.test.ts` |

## Backward compatibility

- `state.json` migration is one-way and idempotent.
- `atc list`, `atc current`, `atc use`, `atc bind`, `atc click/type/... --context` keep working.
- New fields are additive; old clients ignore them.
- If the daemon is older than the CLI, return `DAEMON_VERSION_MISMATCH` and print the upgrade command, not `unknown method`.

## Risks

- Workspace state and `registry.current` can drift. Make workspace the source of truth for new APIs and derive `current` as a compatibility view.
- Tab identity changes on replace/move. Reconcile from `tabs.onReplaced`/`onMoved`, not URL matching.
- Multi-tab actions increase blast radius. Require explicit target or `--each`, and keep commit actions confirmation-gated.
- Side panel and chat picker can race. All membership changes go through daemon handlers with revision checks.

## First three PRs

1. Workspace schema + migration + read-only `workspace` commands + tests.
2. Side panel membership UI wired to workspace commands + close/remove events.
3. Tab-addressed actions + effect/error plumbing, behind a feature flag until security gates land.
