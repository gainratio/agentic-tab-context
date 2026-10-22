---
name: agentic-tab-context
description: >
  Discover and bind to the user's already-open browser tab across Chrome, Safari,
  Firefox, Brave, and Edge without opening a redundant browser window or tab.
  Trigger whenever the user says "look at my browser", "check the open tab",
  "inspect my localhost tab", or asks to test, debug, or interact with a page in their browser.
---

# Agentic Tab Context (`atc` / `abt` / `tabctx`)

Use `atc` (or `agentic-tab-context` / `abt` / `tabctx`) to find, bind to, inspect, and interact with the browser tab the user **already has open**, or to drive a single sticky multi-browser session across commands.

## Golden Rule: Bind to the Existing Tab First — Never Open a Redundant Browser

When the user says **"look at my browser"**, **"check the open tab"**, or references a page they are viewing (e.g., `localhost`, `aml-filter`, `almamesh`, `edge-reco`, `github`):

1. **Bind directly to the matching open tab** (searches extension-connected tabs, managed Playwright tabs, and live macOS Chrome / Safari / Brave / Edge tabs):
   ```sh
   atc bind --query "localhost"
   ```
   Or bind to whichever tab is currently active/focused in their browser:
   ```sh
   atc bind --active
   ```
   Or list all open tabs first and bind by `tabId`:
   ```sh
   atc tabs
   atc bind --tab <tabId>
   ```
   If multiple tabs match `--query`, `atc bind` fails closed with `"error": "AMBIGUOUS_TARGET"` and returns the matching `candidates` list — pick the exact `tabId` and run `atc bind --tab <tabId>`.

2. **Inspect the bound tab before acting**:
   ```sh
   atc inspect
   ```
   Returns `{ "ok": true, "context": "ctx_...", "url": "...", "title": "...", "aria": "..." }` with a structured ARIA tree of visible headings, links, buttons, textboxes, and comboboxes.

3. **Interact with deterministic visible-only locators**:
   ```sh
   atc click --role button --name "Save"
   atc type --label "Product Name" --value "Acme"
   atc select --label "Environment" --value "Stage"
   atc goto "http://localhost:3000/settings"
   atc reload
   atc back
   atc forward
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
   atc console --since 0
   atc network --since 0
   atc screenshot
   ```

5. **Only open a new browser window/tab if no matching tab is open**:
   ```sh
   atc open chrome --use          # or: chromium | firefox | safari | webkit | brave | edge
   atc open firefox --headless --use
   ```

## Diagnostics & Setup

- Check installed browsers, extension bridge status, and live tab count:
  ```sh
  atc doctor
  ```
- Reinstall skills and print browser extension path:
  ```sh
  atc setup
  ```
