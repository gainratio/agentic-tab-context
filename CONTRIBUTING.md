# Contributing

Thanks for taking a look. This is a small, security-sensitive tool; the rules are short.

## Development setup

You need Node.js 22 or newer, npm, and a Chromium browser.

```sh
git clone https://github.com/gainratio/agentic-tab-context.git
cd agentic-tab-context
npm ci
npm run gate            # build, type-check, unit tests, and the browser e2e suite
npm run test:unit       # faster loop
```

The CI gate also runs inside Dagger:

```sh
dagger call quality sync
```

Load `extension/` as an unpacked extension at `chrome://extensions` and run
`./install.sh` once to register the native host and the assistant skill.

## Pull requests

- Keep the change focused; one concern per PR.
- Add or update a test for behavior changes. A bug fix needs a regression test.
- Do not add a browser permission, a host permission, a network call, or a new native
  message type without explaining the user-visible need in the PR. The extension's
  permissions are part of its privacy promise.
- Run `npm run gate` before opening the PR.
- Describe the security and privacy impact in the PR body, even when it is "none".

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the MIT license in
[LICENSE](LICENSE).
