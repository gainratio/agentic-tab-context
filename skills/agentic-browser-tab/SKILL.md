---
name: agentic-browser-tab
description: >
  Discover and bind to the user's already-open browser tab across Chrome, Safari,
  Firefox, Brave, and Edge without opening a redundant browser window or tab.
  Trigger whenever the user says "look at my browser", "check the open tab",
  "inspect my localhost tab", or asks to test, debug, or interact with a page in their browser.
---

# Agentic Browser Tab (`abt` / `tabctx`)

Use `abt` (or `agentic-browser-tab` / `tabctx`) to find, bind to, inspect, and interact with the browser tab the user **already has open**, or to drive a single sticky multi-browser session across commands.

## Golden Rule: Bind to the Existing Tab First — Never Open a Redundant Browser

When the user says **"look at my browser"**, **"check the open tab"**, or references a page they are viewing (e.g., `localhost`, `aml-filter`, `almamesh`, `edge-reco`, `github`):

1. **Bind directly to the matching open tab** (searches extension-connected tabs, managed Playwright tabs, and live macOS Chrome / Safari / Brave / Edge tabs):
   ```sh
   abt bind --query "localhost"
   ```
   Or bind to whichever tab is currently active/focused in their browser:
   ```sh
   abt bind --active
   ```
   Or list all open tabs first and bind by `tabId`:
   ```sh
   abt tabs
   abt bind --tab <tabId>
   ```
   If multiple tabs match `--query`, `abt bind` fails closed with `"error": "AMBIGUOUS_TARGET"` and returns the matching `candidates` list — pick the exact `tabId` and run `abt bind --tab <tabId>`.

2. **Inspect the bound tab before acting**:
   ```sh
   abt inspect
   ```
   Returns `{ "ok": true, "context": "c1", "url": "...", "title": "...", "aria": "..." }` with a structured ARIA tree of visible headings, links, buttons, textboxes, and comboboxes.

3. **Interact with deterministic visible-only locators**:
   ```sh
   abt click --role button --name "Save"
   abt type --label "Product Name" --value "Acme"
   abt select --label "Environment" --value "Stage"
   abt navigate "http://localhost:3000/settings"
   abt reload
   abt back
   abt forward
   ```
   Supported locators (exactly one required per `click`/`type`/`select`):
   - `--role <role> [--name <accessibleName>]`
   - `--label <text>`
   - `--text <text>`
   - `--placeholder <text>`
   - `--testid <id>`
   - `--selector <css>`
   - Add `--nth <0-based-index>` when multiple visible elements match (`AMBIGUOUS_TARGET`).

4. **Check console logs, network requests, or capture a screenshot**:
   ```sh
   abt console --since 0
   abt network --since 0
   abt screenshot
   ```

5. **Only open a new browser window/tab if no matching tab is open**:
   ```sh
   abt open chrome --use          # or: chromium | firefox | safari | webkit | brave | edge
   abt open firefox --headless --use
   ```

## Diagnostics & Setup

- Check installed browsers, extension bridge status, and live tab count:
  ```sh
  abt doctor
  ```
- Reinstall skills and print browser extension path:
  ```sh
  abt setup
  ```
