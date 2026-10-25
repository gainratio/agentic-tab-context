# Chrome Web Store listing: Agentic Tab Context

> Last updated: 2026-10-22

> [!IMPORTANT]
> **The repository is public (2026-10-24), so the privacy-policy URL below is live.**
> The 1280×800 screenshot is in `store/screenshot-1.png`. After store approval, set
> `ATC_EXTENSION_IDS=<store id>` and run `atc setup`, so the native host also allows the
> store build. The store assigns its own id and ignores the manifest `key`.

## Store listing

**Extension name**
Agentic Tab Context

**Short description**
Lets your coding assistant see and use the browser tab you already have open, instead of opening a new one.

**Detailed description**
Lets your coding assistant (Claude Code, Codex, Antigravity) work in the browser tab you already have open, with your logins, on the page you're looking at, without opening new windows.

What it does
Shows your assistant the list of open tabs so it can find the one you mean
Lets your assistant read the page, click buttons, fill in forms and choose options in that tab
Takes screenshots and reports console errors and failed requests from that tab
One click from the toolbar connects the current tab

How to use it
1. Install the free atc command-line tool (github.com/gainratio/agentic-tab-context) and run "atc setup"
2. Open the page you want help with
3. Ask your assistant to "look at my browser", or click the toolbar icon and choose "Let my assistant use this tab"

Privacy
The extension's own communication is local native messaging to atc; it makes no network requests of its own. Your assistant's use of returned information follows that assistant's settings and terms. Normal website requests still occur. Password controls are redacted from inspection.

**Category**
Developer Tools

**Single purpose**
Connects a developer's open browser tab to their local coding assistant so it can read and operate that tab.

**Primary language**
English

## Graphics and assets

| Asset | Dimensions | Status | File |
|---|---|---|---|
| Store icon | 128×128 PNG | ✅ Ready | `extension/icons/icon-128.png` |
| Screenshot 1 | 1280×800 | ✅ Ready | `store/screenshot-1.png` |

## Permissions justification

| Permission | Type | Justification |
|---|---|---|
| `tabs` | permissions | Reads the title and address of open tabs so the user (or their assistant) can pick which tab to connect. |
| `scripting` | permissions | Reads the visible content of the connected tab and performs the clicks and form entries the user's assistant requests in that tab. |
| `nativeMessaging` | permissions | The only channel to the local atc program on the same computer. No network connection is used. |
| `storage` | permissions | Keeps a random per-profile identifier locally and watched-tab identifiers for the current browser session. Watched tabs do not persist across browser restarts. |
| `alarms` | permissions | Retries the connection to the local atc program every 30 seconds if it isn't installed or running yet. |
| `<all_urls>` | host_permissions | Developers work on local servers (localhost), staging and production sites on any domain; the user chooses which tab to connect. |

## Privacy and data use

**Does the extension collect user data?** It handles web history (tab titles and addresses) and website content, but only to pass them to a program on the user's own computer. Nothing is transmitted off the device.

- [x] Data is not sold to third parties
- [x] Data is not used for purposes unrelated to the extension's single purpose
- [x] Data is not used for creditworthiness or lending

**Privacy policy URL**
https://github.com/gainratio/agentic-tab-context/blob/main/PRIVACY.md (works once the repository is public)

## Developer info

**Publisher**: GainRatio
**Homepage**: https://github.com/gainratio/agentic-tab-context
**Support**: https://github.com/gainratio/agentic-tab-context/issues

## Version history

| Version | Date | Changes | Status |
|---|---|---|---|
| 0.4.0 | 2026-10-25 | `press`, `upload`, `eval`, and `--within` scoped locators; normalized accessible-name fallback; page agent v3 | **Ready to submit** |
| 0.3.0 | 2026-10-22 | Native messaging replaces the localhost port; isolated-world page access; screenshots restore the user's tab | Draft |
