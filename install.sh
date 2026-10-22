#!/usr/bin/env bash
# One-step install: build atc, put it on your PATH, install the assistant skill,
# register the browser extension's native host, and print a health check.
set -euo pipefail

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "atc supports macOS and Linux only." >&2; exit 1 ;;
esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "==> 1/4 Installing dependencies"
npm install --no-fund --no-audit

echo "==> 2/4 Building"
npm run build

echo "==> 3/4 Putting 'atc' on your PATH"
npm unlink --global agentic-tab-context >/dev/null 2>&1 || true
npm link

echo "==> 4/4 Installing the assistant skill and browser bridge"
node "$REPO_DIR/bin/atc.js" setup
node "$REPO_DIR/bin/atc.js" doctor
