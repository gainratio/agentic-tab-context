"""Pinned images, source excludes, and commands for the Agentic Tab Context gate."""

from __future__ import annotations

from typing import Final

NODE_IMAGE: Final = (
    "node:24.16.0-bookworm-slim@sha256:"
    "2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"
)
ACTIONLINT_IMAGE: Final = (
    "rhysd/actionlint:1.7.10@sha256:"
    "ef8299f97635c4c30e2298f48f30763ab782a4ad2c95b744649439a039421e36"
)
GITLEAKS_IMAGE: Final = (
    "ghcr.io/gitleaks/gitleaks:v8.29.1@sha256:"
    "aa036a2f4bdfe3cc3c55fa4326308efabb4a6be498c883c864fd1d0d5585438a"
)
ALLOWED_REPOSITORIES: Final = ("gainratio/agentic-tab-context",)
REPOSITORY_URL: Final = "https://github.com/gainratio/agentic-tab-context.git"
SHA_LENGTH: Final = 40
SOURCE_EXCLUDES: Final = [
    ".git",
    ".dagger/.mypy_cache",
    ".dagger/.pytest_cache",
    ".dagger/.ruff_cache",
    ".dagger/.venv",
    ".dagger/sdk",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "**/__pycache__",
    "node_modules",
    "**/node_modules",
    "coverage",
    "dist",
]
INSTALL_COMMAND: Final = ["npm", "ci", "--ignore-scripts"]
GATE_COMMAND: Final = ["npm", "run", "gate"]
PLAYWRIGHT_INSTALL: Final = ["npx", "playwright-core", "install", "--with-deps", "chromium"]
GITLEAKS_SNAPSHOT: Final = [
    "gitleaks",
    "detect",
    "--source",
    "/snapshot",
    "--no-git",
    "--redact",
    "--no-banner",
]
GITLEAKS_HISTORY: Final = [
    "gitleaks",
    "detect",
    "--source",
    "/repo",
    "--log-opts=--all",
    "--redact",
    "--no-banner",
]
