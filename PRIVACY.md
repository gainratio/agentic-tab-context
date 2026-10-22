# Privacy policy: Agentic Tab Context

_Last updated: 2026-10-22_

Agentic Tab Context ("the extension") connects your browser to the `atc` program running on your own computer, so your coding assistant can work in a tab you choose.

## What the extension accesses

- **Your open tabs' titles and addresses**, so `atc` can show them and you can pick one.
- **The content of a tab you or your assistant bind**, only while bound, to read the page, click, type, take screenshots, and read that tab's console and network activity.

## Where it goes

- **Only to `atc` on the same computer**, over the browser's native messaging channel. The extension opens no network connections and makes no web requests of its own.
- Nothing is sent to us or to any third party. There is no analytics, tracking or advertising.
- What your coding assistant does with information you let it read is governed by that assistant's own terms.

## What is stored

- A random identifier for this browser profile is kept in local extension storage. Watched tab identifiers use session storage and do not survive a browser restart.
- No page content is persisted to extension storage. While bound, the page keeps bounded in-memory console and network buffers (up to 500 entries per kind). Unwatch, closing the atc context, or navigation clears these buffers and stops that capture session.
- Password control values are omitted from inspection. Other returned page content and logs can contain sensitive information. The local atc program may retain requested screenshots and managed-browser profiles under `ATC_HOME`; removing the extension does not delete those files.

## Your control

- Remove the extension at any time from your browser's extensions page.
- Run `atc shutdown` to stop the local program.

## Contact

https://github.com/gainratio/agentic-tab-context/issues
