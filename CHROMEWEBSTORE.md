# Chrome Web Store Listing — Agentic Browser Tab (abt)

> Last Updated: 2026-10-21

## Store Listing

**Extension Name**
Agentic Browser Tab (abt)

**Short Description**
Bind your already-open browser tabs to coding assistants (Claude Code, Codex, Antigravity) without opening new windows or tabs.

**Detailed Description**
Connect your coding assistant directly to the browser tab you already have open — no more redundant browser launches, duplicate tabs, or lost login sessions.

Key Features
Discover every open tab across your browser windows by title, URL, or active focus
Bind your coding assistant to a single tab with one click from the toolbar popup or one terminal command
Inspect visible headings, buttons, links, form controls, and text directly in your existing tab
Click buttons, fill inputs, select options, capture screenshots, and read console or network errors in place
Keep all communication strictly on your machine over localhost (127.0.0.1)

How to Use
1. Install the `agentic-browser-tab` CLI (`abt`) on your machine and run `abt setup`
2. Open any web page or localhost app you are working on in your browser
3. Click "Bind Active Tab to Coding Assistant" in the extension popup or ask your coding assistant to "look at my browser" (`abt bind --active` or `abt bind --query "localhost"`)
4. Your coding assistant can now inspect, interact with, and debug the exact tab you are viewing

Privacy & Security
All tab metadata and page interactions stay strictly on your local computer via `http://127.0.0.1:43919`. Nothing is ever sent to external servers, cloud services, or third parties.

Support & Feedback
Report issues or request features at https://github.com/hseshadr/tabcontext/issues

**Category**
Developer Tools

**Single Purpose**
Bridges a developer's open browser tabs to their local CLI coding assistant (`abt`) so the assistant can inspect and interact with the active tab in place.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `extension/icons/icon-128.png` |
| Toolbar Icon (48) | 48×48 PNG | ✅ Ready | `extension/icons/icon-48.png` |
| Toolbar Icon (16) | 16×16 PNG | ✅ Ready | `extension/icons/icon-16.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | Required to read the title, URL, and active state of open tabs so the developer can find and bind the exact tab they are looking at via `abt tabs` and `abt bind`. |
| `scripting` | permissions | Required to read the accessibility snapshot (`abt inspect`) and perform user-requested clicks, form fills, and console/network log inspection on the bound tab. |
| `storage` | permissions | Required to persist local daemon connection state across background service worker restarts. |
| `alarms` | permissions | Required to periodically keep the open tab list synchronized with the local `abt` daemon on `127.0.0.1:43919`. |
| `<all_urls>` | host_permissions | Required because developers inspect and test local web servers (`localhost`, `127.0.0.1`), staging environments, and arbitrary production URLs across any domain. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All communication occurs exclusively over loopback (`http://127.0.0.1:43919`) between the browser extension and the user's own local `abt` CLI daemon running on the same computer. Zero data is transmitted off-device.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**
https://github.com/hseshadr/tabcontext/blob/main/CHROMEWEBSTORE.md#privacy--data-use

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name**
Harish Seshadri

**Homepage URL**
https://github.com/hseshadr/tabcontext

**Support URL / Email**
https://github.com/hseshadr/tabcontext/issues

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-10-21 | Initial Manifest V3 release supporting live tab discovery, one-click active tab binding, accessibility tree inspection, and DOM actions over localhost bridge. | Draft |
