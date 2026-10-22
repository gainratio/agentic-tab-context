"""Agentic Tab Context's complete quality, browser E2E, and security graph."""

from __future__ import annotations

from typing import Self

import dagger
from dagger import check, dag, field, function, object_type

from .constants import (
    ACTIONLINT_IMAGE,
    ALLOWED_REPOSITORIES,
    GATE_COMMAND,
    GITLEAKS_HISTORY,
    GITLEAKS_IMAGE,
    GITLEAKS_SNAPSHOT,
    INSTALL_COMMAND,
    NODE_IMAGE,
    PLAYWRIGHT_INSTALL,
    REPOSITORY_URL,
    SHA_LENGTH,
    SOURCE_EXCLUDES,
)


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
        """Run build, strict typecheck, unit tests, and real-Chromium E2E (incl. extension)."""
        return self._quality(self.source)

    def _quality(self, source: dagger.Directory) -> dagger.Container:
        return self._playwright(source).with_exec(GATE_COMMAND)

    @function
    def dependency_audit(self) -> dagger.Container:
        """Audit the exact npm lockfile without suppressions."""
        return self._dependency_audit(self.source)

    def _dependency_audit(self, source: dagger.Directory) -> dagger.Container:
        command = ["npm", "audit", "--audit-level=moderate"]
        return self._dependencies(source).with_exec(command)

    @function
    def secret_scan(
        self, commit_sha: str = "", git_auth_header: dagger.Secret | None = None
    ) -> dagger.Container:
        """Scan the typed snapshot and, given a commit, its complete history."""
        return self._secret_scan(self.source, commit_sha, git_auth_header)

    def _secret_scan(
        self, source: dagger.Directory, commit_sha: str, header: dagger.Secret | None
    ) -> dagger.Container:
        scan = self._gitleaks().with_directory("/snapshot", source)
        scan = scan.with_exec(["sh", "-ceu", 'test -n "$(find /snapshot -type f -print -quit)"'])
        scan = scan.with_exec(GITLEAKS_SNAPSHOT)
        if not commit_sha:
            return scan
        history = self._history(commit_sha, header)
        return scan.with_directory("/repo", history).with_exec(GITLEAKS_HISTORY)

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
    async def ci(
        self,
        commit_sha: str,
        repository: str,
        git_auth_header: dagger.Secret | None = None,
    ) -> str:
        """Guard the exact caller source, then run the full gate. Private repos pass a header."""
        self._require_repository(repository)
        source = await self._verified_source(commit_sha, repository, git_auth_header)
        await self._run_ci(source, commit_sha, git_auth_header)
        return "Agentic Tab Context canonical Dagger gate passed"

    async def _verified_source(
        self, commit_sha: str, repository: str, header: dagger.Secret | None
    ) -> dagger.Directory:
        """Bind and guard one exact caller snapshot before product evaluation."""
        self._require_sha(commit_sha)
        foundation = dag.foundation()
        bound = foundation.source(self.source, repository, commit_sha, http_auth_header=header)
        await foundation.guard(bound, repository, commit_sha, http_auth_header=header).sync()
        return bound

    async def _run_ci(
        self, source: dagger.Directory, commit_sha: str, header: dagger.Secret | None
    ) -> None:
        await self._quality(source).sync()
        await self._dependency_audit(source).sync()
        await self._secret_scan(source, commit_sha, header).sync()
        await self._workflow_security(source).sync()

    def _playwright(self, source: dagger.Directory) -> dagger.Container:
        installed = self._dependencies(source).with_user("0:0").with_exec(PLAYWRIGHT_INSTALL)
        installed = installed.with_exec(["chown", "-R", "65532:65532", "/opt/pw-browsers"])
        return installed.with_user("65532:65532")

    def _dependencies(self, source: dagger.Directory) -> dagger.Container:
        return self._node(source).with_exec(INSTALL_COMMAND)

    def _node(self, source: dagger.Directory) -> dagger.Container:
        base = dag.container().from_(NODE_IMAGE).with_directory("/src", source, owner="65532:65532")
        base = base.with_workdir("/src").with_env_variable("HOME", "/opt/home")
        base = base.with_env_variable("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")
        base = base.with_env_variable("npm_config_cache", "/opt/npm-cache")
        cache = dag.cache_volume("atc-npm-cache")
        base = base.with_mounted_cache("/opt/npm-cache", cache, owner="65532:65532")
        base = base.with_exec(["mkdir", "-p", "/opt/home", "/opt/pw-browsers"])
        base = base.with_exec(["chown", "-R", "65532:65532", "/opt/home", "/opt/pw-browsers"])
        return base.with_user("65532:65532")

    @staticmethod
    def _history(commit_sha: str, header: dagger.Secret | None) -> dagger.Directory:
        AgenticTabContext._require_sha(commit_sha)
        repo = dag.git(REPOSITORY_URL, http_auth_header=header)
        return repo.commit(commit_sha).tree(depth=0, include_tags=True)

    @staticmethod
    def _actionlint() -> dagger.Container:
        return dag.container().from_(ACTIONLINT_IMAGE).with_entrypoint([]).with_workdir("/repo")

    @staticmethod
    def _gitleaks() -> dagger.Container:
        return dag.container().from_(GITLEAKS_IMAGE).with_entrypoint([])

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
