# Browser store submission — 0.5.1

1. Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
2. **New item** (or **Package → Upload new package** on the existing item) → upload `agentic-tab-context-0.5.1.zip` (rebuilt reproducibly via `npm run pack:store`).
3. Paste the listing copy and permission justifications from
   [`../CHROMEWEBSTORE.md`](../CHROMEWEBSTORE.md).
4. Upload `screenshot-1.png` (1280×800) as screenshot 1.
5. Privacy policy URL: `https://github.com/gainratio/agentic-tab-context/blob/main/PRIVACY.md`.
6. Category: Developer Tools. Language: English.
7. Submit for review. The store assigns its own extension id.
8. *(Optional — Firefox Add-ons)* Upload the same `agentic-tab-context-0.5.1.zip` on
   [addons.mozilla.org](https://addons.mozilla.org/developers/) (`browser_specific_settings.gecko`
   is already declared in `manifest.json` as `agentic-tab-context@gainratio`, Firefox ≥ 128).
9. The published Chrome Web Store ID (`bdjnjipgnacnpgomkcbabgabejmjkllb`) is included in
   `atc setup`'s default native-host allowlist alongside local unpacked builds. Use
   `ATC_EXTENSION_IDS=<custom id> atc setup` only if you also need to authorize a separate fork or unlisted build.

`npm run pack:store` builds `store/agentic-tab-context-0.5.1.zip` deterministically from `extension/`
with the local unpacked `key` removed (Chrome Web Store rejects initial uploads containing `key`),
and `test/unit/store-package.test.ts` enforces zero drift in CI.
