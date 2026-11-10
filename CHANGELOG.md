# Changelog

All notable changes to Agentic Tab Context (`atc`) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Exposed daemon protocol version through `atc ping` and `atc doctor` (#30).
- Added `.env.example`, `CLAUDE.md`, `CHANGELOG.md`, `package.json` keywords, and the developer architecture/configuration section in `README.md`.

### Security
- Implemented Northstar hardening controls across socket authentication, path policy, sensitive-field screenshot redaction, and extension manifest allowlists (#24, #28, #29, #31).
- Required explicit user tab sharing via the side panel or toolbar popup before an agent can bind an extension tab (`TAB_NOT_SHARED`, #28).
- Authenticated both local Unix IPC sockets (`daemon.sock` and `bridge.sock`) with a per-install token (#29).
- Redacted password and secret controls in extension viewport screenshots (#24).
- Enforced thin Dagger CI ingress and removed legacy shell workflows.

### Fixed
- Reported hidden and disabled action targets with typed actionable errors (#23).
- Verified tab identity preservation across create, move, replace, and close lifecycle events (#26, #27).

## [0.5.0] - 2026-11-04

*Note: `package.json` advanced to `0.5.0` in #22; annotated git tag `v0.5.0` was not cut prior to post-0.5.0 security hardening.*

### Added
- Multi-tab Chrome side panel workspace: search open tabs, share/unshare without closing tabs, switch active target, and gate sensitive sites (#19, #20, #22).
- `atc bindings` and `atc use <ctx>` commands backed by a shared daemon/extension context registry (#19).
- Explicit `--each` multi-tab action execution and daemon-extension protocol version handshake (#20, #21).

## [0.4.1] - 2026-10-26

### Changed
- Removed `eval` / dynamic code evaluation from the Manifest V3 browser extension for Chrome Web Store compliance (#18).
- Prepared the 0.4.x Chrome Web Store submission package and updated minor/patch npm dependencies (#10, #17).
