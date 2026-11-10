# Browser store assets

- `agentic-tab-context-0.5.0.zip` — deterministic Manifest V3 archive built from
  `extension/` via `npm run pack:store` (with the local development `key` stripped).
- `screenshot-1.png` — 1280×800, required Chrome Web Store size. Built from the real
  extension UI and the product's own wording; no invented screenshots.
- Listing copy and permission justifications: [`../CHROMEWEBSTORE.md`](../CHROMEWEBSTORE.md).
- Step-by-step upload checklist: [`SUBMISSION.md`](./SUBMISSION.md).

After Chrome Web Store approval, set `ATC_EXTENSION_IDS=<store id>` and run `atc setup`,
so the native host also allows the store build.
