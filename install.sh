#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

echo "==> 1/4 Installing dependencies..."
npm install --no-fund --no-audit

echo "==> 2/4 Building agentic-tab-context (atc)..."
npm run build

echo "==> 3/4 Linking 'atc', 'agentic-tab-context', 'abt', and 'tabctx' CLIs globally..."
npm link --force

echo "==> 4/4 Installing coding assistant skills (Claude Code, Codex, Antigravity, Agents) & running doctor..."
node "$REPO_DIR/bin/atc.js" setup
node "$REPO_DIR/bin/atc.js" doctor
