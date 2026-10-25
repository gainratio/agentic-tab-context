# Chrome Web Store submission — 0.4.0

1. Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
2. **New item** → upload `agentic-tab-context-0.4.0.zip`.
3. Paste the listing copy and permission justifications from
   [`../CHROMEWEBSTORE.md`](../CHROMEWEBSTORE.md).
4. Upload `screenshot-1.png` (1280×800) as screenshot 1.
5. Privacy policy URL: `https://github.com/gainratio/agentic-tab-context/blob/main/PRIVACY.md`.
6. Category: Developer Tools. Language: English.
7. Submit for review. The store assigns its own extension id and ignores the
   manifest `key`.
8. After approval, run:

   ```sh
   ATC_EXTENSION_IDS=<store id> atc setup
   ```

   so the native host allows the store build.

Do not include the local `key` in the store build; it is only for the unpacked
development copy. The zip is built from `extension/` as-is.
