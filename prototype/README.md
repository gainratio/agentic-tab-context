# ATC side-panel prototype

A self-contained, interactive prototype of the proposed ATC side panel. No browser APIs, daemon, build step, or external assets are used; all tab data is simulated.

## Run

Open `prototype/index.html` directly in a browser, or serve the folder:

```sh
python3 -m http.server 4173 --directory prototype
```

## What to try

- Search tabs with the box, or press `Cmd/Ctrl+K`.
- Filter with All / Shared / Sensitive / This window.
- Click a row to make it the active target.
- Select one or more unshared rows, choose **Share selected**, review the confirmation sheet, and confirm.
- Unlock a sensitive tab and confirm the amber warning.
- Close a tab with the row's × and watch it leave the list with a toast.
- Use the chat-side picker to choose a tab; watch the context chips update.
- Inspect the success and `ACTION_NO_EFFECT` cards; Retry, Inspect, and Take over update the card.

## Practical notes

- Shared state is in memory and resets on reload.
- The prototype exists to settle interaction and visual decisions before the real side panel and daemon workspace land.
- Implementation plan: [`../docs/ATC-UX-SPEC.md`](../docs/ATC-UX-SPEC.md).
- Security boundaries that must survive the port: [`../docs/ATC-SECURITY-REVIEW.md`](../docs/ATC-SECURITY-REVIEW.md).
