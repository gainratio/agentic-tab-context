# Chrome Web Store listing: Agentic Tab Context

> Last updated: 2026-11-10

> [!IMPORTANT]
> **Submission archive**: `store/agentic-tab-context-0.5.0.zip` (rebuilt deterministically via `npm run pack:store` with the unpacked-dev `key` stripped).
> The 1280×800 screenshot is in `store/screenshot-1.png`. After store approval, set
> `ATC_EXTENSION_IDS=<store id>` and run `atc setup`, so the native host also allows the
> store build. The store assigns its own id.

## Store listing

**Extension name**
Agentic Tab Context

**Short description**
Lets your coding assistant see and use the browser tab you already have open, instead of opening a new one.

**Detailed description**
Lets your coding assistant (Claude Code, Codex, Antigravity) work in the browser tab you already have open, with your logins, on the page you're looking at, without opening new windows.

What it does
- Share one or more open tabs from the toolbar popup or the Shared Tabs side panel
- Lets your assistant read the page, click buttons, fill in forms, and choose options in shared tabs
- Prompts before sharing sensitive sites (such as banking, email, or cloud consoles) and lets you stop sharing at any time without closing the tab
- Takes viewport screenshots (with password fields masked) and reports console errors and failed requests from shared tabs

How to use it
1. Install the free `atc` command-line tool (`github.com/gainratio/agentic-tab-context`) and run `atc setup`
2. Open the page you want help with and click the toolbar icon (or open the Shared Tabs side panel) to share that tab
3. Ask your assistant to "look at my browser"

Privacy
The extension communicates directly with the `atc` program running on your own computer; it makes no network requests of its own. Your assistant's use of returned page content follows that assistant's settings and terms. Normal website requests still occur. Password controls are masked during inspection and screenshots.

**Category**
Developer Tools

**Single purpose**
Connects a developer's explicitly shared browser tabs to their local coding assistant so it can read and operate those tabs.

**Primary language**
English

## Graphics and assets

| Asset | Dimensions | Status | File |
|---|---|---|---|
| Package ZIP | Manifest V3 (`0.5.0`, no `key`) | ✅ Ready | `store/agentic-tab-context-0.5.0.zip` |
| Store icon | 128×128 PNG | ✅ Ready | `extension/icons/icon-128.png` |
| Screenshot 1 | 1280×800 | ✅ Ready | `store/screenshot-1.png` |

## Permissions justification

| Permission | Type | Justification |
|---|---|---|
| `tabs` | permissions | Reads the title and address of open tabs so the user can choose which tab to share in the popup or side panel. |
| `scripting` | permissions | Reads the visible content of explicitly shared tabs and performs the clicks and form entries the user's assistant requests in those tabs. |
| `nativeMessaging` | permissions | The only channel to the local `atc` program on the same computer. No network connection is used by the extension. |
| `storage` | permissions | Keeps a random per-profile identifier locally and shared-tab identifiers for the current browser session. Shared tabs do not persist across browser restarts. |
| `alarms` | permissions | Retries the connection to the local `atc` program every 30 seconds if it isn't installed or running yet. |
| `sidePanel` | permissions | Hosts the Shared Tabs side panel where the user searches, shares, switches, and unshares tabs. |
| `<all_urls>` | host_permissions | Developers work on local servers (`localhost`), staging, and production sites on any domain; the extension only inspects or acts on tabs the user explicitly shares. |

## Privacy and data use

**Does the extension collect user data?** It handles web history (tab titles and addresses) and website content on user-shared tabs solely to pass them to the `atc` program on the user's own computer. Nothing is transmitted off the device by the extension.

- [x] Data is not sold to third parties
- [x] Data is not used for purposes unrelated to the extension's single purpose
- [x] Data is not used for creditworthiness or lending

**Privacy policy URL**
https://github.com/gainratio/agentic-tab-context/blob/main/PRIVACY.md

## Developer info

**Publisher**: GainRatio
**Homepage**: https://github.com/gainratio/agentic-tab-context
**Support**: https://github.com/gainratio/agentic-tab-context/issues

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.5.0 | 2026-11-10 | Multi-tab side panel, explicit tab-sharing consent, sensitive-tab gate, password-masked screenshots, protocol handshake, URL/log redaction | **Ready to submit** |
| 0.4.1 | 2026-10-26 | Removes `eval` from the extension so the store build contains no remote-code execution; `press`, `upload`, and `--within` remain | Superseded |
| 0.4.0 | 2026-10-25 | `press`, `upload`, `eval`, and `--within` scoped locators; normalized accessible-name fallback; page agent v3 | Superseded |
| 0.3.0 | 2026-10-22 | Native messaging replaces the localhost port; isolated-world page access; screenshots restore the user's tab | Draft |
