# ATC side panel ↔ daemon contract (phase 1)

This is the message contract for the real side panel. It is additive to the existing native-messaging protocol.

## Extension → daemon

```ts
| { type: "bindings"; id: number }
| { type: "share"; id: number; tabId: number }
| { type: "unshare"; id: number; context: string }
| { type: "activate"; id: number; context: string }
```

`id` is a positive integer chosen by the extension; each request gets exactly one response.

## Daemon → extension

```ts
| { type: "bindings"; id: number; ok: boolean; current: string | null; bindings: BindingView[]; message?: string }
| { type: "shared"; id: number; ok: boolean; context?: string; message?: string }
| { type: "unshared"; id: number; ok: boolean; context?: string; message?: string }
| { type: "activated"; id: number; ok: boolean; context?: string; message?: string }
```

## Semantics

- **bindings**: read-only snapshot of every open context. Shape matches `atc bindings`.
- **share**: user-initiated bind of a tab. Creates/reuses a context but does **not** change the active context. Sensitive URLs are allowed only through this user-initiated path.
- **unshare**: closes the context connection; the browser tab remains open.
- **activate**: makes an existing context current. It does not bind or navigate.
- A tab that closes in the browser closes its context through the existing `tabs` reconciliation and disappears from the next `bindings` response.
- `share`/`activate` operate on the extension's own tab ids/contexts; reject unknown ids.

## Security constraints

- The CLI/agent path (`atc bind`) rejects sensitive origins with `ACTION_BLOCKED_SENSITIVE`.
- Only the extension UI path (`share`) may share a sensitive origin, and the UI must show a lock and require explicit confirmation.
- `bindings` never includes page content, only tab identity and title/url.
- New message types are parsed strictly; malformed messages are dropped.
