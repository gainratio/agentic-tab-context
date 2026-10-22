"""Agentic Tab Context's complete quality, browser E2E, and security graph."""

from __future__ import annotations

from typing import Final, Self

import dagger
from dagger import check, dag, field, function, object_type

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
REPOSITORY: Final = "gainratio/agentic-tab-context"
REPOSITORY_URL: Final = f"https://github.com/{REPOSITORY}.git"
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
    ".tabctx",
]
INSTALL_COMMAND: Final = ["npm", "ci", "--ignore-scripts"]
PLAYWRIGHT_INSTALL: Final = [
    "npx",
    "playwright-core",
    "install",
    "--with-deps",
    "chromium",
]
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


@object_type
class AgenticTabContext:
    """Run the same typed Agentic Tab Context gate locally and on GitHub."""

    source: dagger.Directory = field()

    @classmethod
    def create(cls, workspace: dagger.Workspace) -> Self:
        """Construct the graph from an explicit typed workspace snapshot."""
        instance = cls.__new__(cls)
        instance.source = workspace.directory("/", exclude=SOURCE_EXCLUDES)
        return instance

    @function
    def quality(self) -> dagger.Container:
        """Run build, strict TypeScript typecheck, unit tests, and Chromium E2E tests."""
        return self._quality(self.source)

    def _quality(self, source: dagger.Directory) -> dagger.Container:
        return self._playwright(source).with_exec(["npm", "run", "gate"])

    @function
    def e2e(self) -> dagger.Container:
        """Run the real headless Chromium CLI and driver end-to-end suite."""
        return (
            self._playwright(self.source)
            .with_exec(["npm", "run", "build"])
            .with_exec(["npm", "run", "test:e2e"])
        )

    @function
    def dependency_audit(self) -> dagger.Container:
        """Audit the exact npm lockfile without suppressions."""
        return self._dependency_audit(self.source)

    def _dependency_audit(self, source: dagger.Directory) -> dagger.Container:
        command = ["npm", "audit", "--audit-level=moderate"]
        return self._dependencies(source).with_exec(command)

    @function
    def secret_scan(self, commit_sha: str = "") -> dagger.Container:
        """Scan the typed snapshot and complete canonical history."""
        return self._secret_scan(self.source, commit_sha)

    def _secret_scan(self, source: dagger.Directory, commit_sha: str = "") -> dagger.Container:
        scan = self._gitleaks().with_directory("/snapshot", source)
        scan = scan.with_exec(["sh", "-ceu", self._nonempty_snapshot()])
        scan = scan.with_exec(GITLEAKS_SNAPSHOT)
        if commit_sha:
            history = self._history(commit_sha)
            return scan.with_directory("/repo", history).with_exec(GITLEAKS_HISTORY)
        return scan

    @function
    def workflow_security(self) -> dagger.Container:
        """Validate every GitHub ingress workflow with pinned actionlint."""
        return self._workflow_security(self.source)

    def _workflow_security(self, source: dagger.Directory) -> dagger.Container:
        workflows = source.directory(".github/workflows")
        command = (
            "find .github/workflows -type f "
            "\\( -name '*.yml' -o -name '*.yaml' \\) -exec actionlint {} +"
        )
        return (
            self._actionlint()
            .with_directory("/repo/.github/workflows", workflows)
            .with_exec(["sh", "-ceu", command])
        )

    @function
    @check
    async def ci(self, commit_sha: str, repository: str) -> str:
        """Guard the exact caller source before the canonical product gate."""
        self._require_repository(repository)
        source = await self._verified_source(self.source, commit_sha, repository)
        await self._run_ci(source, commit_sha)
        return "Agentic Tab Context canonical Dagger gate passed"

    async def _verified_source(
        self, source: dagger.Directory, commit_sha: str, repository: str
    ) -> dagger.Directory:
        """Bind and guard one exact caller snapshot before product evaluation."""
        self._require_sha(commit_sha)
        foundation = dag.foundation()
        bound = foundation.source(source, repository, commit_sha)
        await foundation.guard(bound, repository, commit_sha).sync()
        return bound

    async def _run_ci(self, source: dagger.Directory, commit_sha: str = "") -> None:
        await self._quality(source).sync()
        await self._dependency_audit(source).sync()
        await self._secret_scan(source, commit_sha).sync()
        await self._workflow_security(source).sync()

    def _playwright(self, source: dagger.Directory) -> dagger.Container:
        installed = self._dependencies(source).with_user("0:0")
        installed = installed.with_exec(PLAYWRIGHT_INSTALL)
        return installed.with_exec(["chown", "-R", "65532:65532", "/opt/pw-browsers"]).with_user(
            "65532:65532"
        )

    def _dependencies(self, source: dagger.Directory) -> dagger.Container:
        return self._node(source).with_exec(INSTALL_COMMAND)

    def _node(self, source: dagger.Directory) -> dagger.Container:
        base = (
            dag.container()
            .from_(NODE_IMAGE)
            .with_directory("/src", source, owner="65532:65532")
            .with_workdir("/src")
        )
        base = base.with_env_variable("HOME", "/opt/home")
        base = base.with_env_variable("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
        base = base.with_env_variable("npm_config_cache", "/opt/npm-cache")
        base = base.with_mounted_cache(
            "/opt/npm-cache", dag.cache_volume("atc-npm-cache"), owner="65532:65532"
        )
        base = base.with_exec(["mkdir", "-p", "/opt/home", "/opt/pw-browsers"])
        base = base.with_exec(["chown", "-R", "65532:65532", "/opt/home", "/opt/pw-browsers"])
        return base.with_user("65532:65532")

    @staticmethod
    def _history(commit_sha: str) -> dagger.Directory:
        AgenticTabContext._require_sha(commit_sha)
        return dag.git(REPOSITORY_URL).commit(commit_sha).tree(depth=0, include_tags=True)

    @staticmethod
    def _actionlint() -> dagger.Container:
        return dag.container().from_(ACTIONLINT_IMAGE).with_entrypoint([]).with_workdir("/repo")

    @staticmethod
    def _gitleaks() -> dagger.Container:
        return dag.container().from_(GITLEAKS_IMAGE).with_entrypoint([])

    @staticmethod
    def _nonempty_snapshot() -> str:
        return 'test -n "$(find /snapshot -type f -print -quit)"'

    @staticmethod
    def _require_repository(repository: str) -> None:
        if repository not in ALLOWED_REPOSITORIES:
            raise ValueError(f"repository must be one of {', '.join(ALLOWED_REPOSITORIES)}")

    @staticmethod
    def _require_sha(commit_sha: str) -> None:
        valid_length = len(commit_sha) == SHA_LENGTH
        valid = valid_length and all(char in "0123456789abcdef" for char in commit_sha)
        if not valid:
            raise ValueError("commit_sha must be a lowercase 40-character Git SHA")
