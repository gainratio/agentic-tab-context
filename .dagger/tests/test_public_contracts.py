"""Behavioral contracts for Agentic Tab Context's typed Dagger quality and security graph."""

from __future__ import annotations

import asyncio
import inspect
import json
from pathlib import Path
from typing import cast

import dagger
import pytest

import agentic_tab_context.main as main_module
from agentic_tab_context.main import AgenticTabContext

CENTRAL_SHA = "8420264d5560b0817579d9c5323ae3a69ce4558d"
REPOSITORY = "gainratio/agentic-tab-context"
ALLOWED = ("gainratio/agentic-tab-context",)
FOREIGN_REPOSITORIES = (
    "attacker/agentic-tab-context",
    "gainratio/other-repo",
    "gainratio-evil/agentic-tab-context",
    "other-owner/agentic-tab-context",
    "",
)
VALID_SHA = "a" * 40


class RecordingWorkspace:
    """Record the explicit source root selected by the constructor."""

    def __init__(self) -> None:
        self.path = ""
        self.excludes: list[str] = []

    def directory(self, path: str, *, exclude: list[str]) -> dagger.Directory:
        self.path = path
        self.excludes = exclude
        return cast(dagger.Directory, object())


class RecordingSync:
    """Record one forced Dagger boundary and optionally reject it."""

    def __init__(self, name: str, events: list[str], error: ValueError | None = None) -> None:
        self.name = name
        self.events = events
        self.error = error

    async def sync(self) -> None:
        if self.error is not None:
            raise self.error
        self.events.append(self.name)


class RecordingFoundation:
    """Model the exact source-binding and guard boundary."""

    def __init__(
        self, events: list[str], error: ValueError | None = None, repository: str = REPOSITORY
    ) -> None:
        self.events = events
        self.error = error
        self.repository = repository
        self.bound = cast(dagger.Directory, "bound-source")

    def source(
        self, source: dagger.Directory, repository: str, commit_sha: str
    ) -> dagger.Directory:
        assert (source, repository, commit_sha) == ("caller-source", self.repository, VALID_SHA)
        self.events.append("source")
        return self.bound

    def guard(self, source: dagger.Directory, repository: str, commit_sha: str) -> dagger.Container:
        assert (source, repository, commit_sha) == (self.bound, self.repository, VALID_SHA)
        return cast(dagger.Container, RecordingSync("guard", self.events, self.error))


class RecordingDag:
    """Expose only the Foundation client used by the canonical check."""

    def __init__(self, foundation: RecordingFoundation) -> None:
        self.foundation_client = foundation

    def foundation(self) -> RecordingFoundation:
        return self.foundation_client


def test_should_select_an_explicit_typed_workspace_root() -> None:
    workspace = RecordingWorkspace()

    AgenticTabContext.create(cast(dagger.Workspace, workspace))

    assert workspace.path == "/"
    assert ".git" in workspace.excludes
    assert "node_modules" in workspace.excludes


def test_should_exclude_generated_python_gate_state_from_source_binding() -> None:
    workspace = RecordingWorkspace()

    AgenticTabContext.create(cast(dagger.Workspace, workspace))

    assert {
        ".dagger/.mypy_cache",
        ".dagger/.pytest_cache",
        ".dagger/.ruff_cache",
    } <= set(workspace.excludes)


def test_should_require_typed_workspace_when_constructing_graph() -> None:
    signature = inspect.signature(AgenticTabContext.create, eval_str=True)

    workspace = signature.parameters.get("workspace")

    assert workspace is not None
    assert workspace.annotation is dagger.Workspace


def test_should_expose_canonical_gate_boundaries() -> None:
    expected = {
        "ci",
        "quality",
        "e2e",
        "dependency_audit",
        "secret_scan",
        "workflow_security",
    }

    available = {name for name in expected if hasattr(AgenticTabContext, name)}

    assert available == expected


def test_should_pin_node_and_security_images_by_sha256() -> None:
    module = inspect.getmodule(AgenticTabContext)

    assert module is not None
    assert "node:24.16.0-bookworm-slim@sha256:" in module.NODE_IMAGE
    assert "@sha256:" in module.ACTIONLINT_IMAGE
    assert "@sha256:" in module.GITLEAKS_IMAGE


def test_should_scan_snapshot_history_and_both_workflow_extensions() -> None:
    secret_scan = inspect.getsource(AgenticTabContext._secret_scan)
    workflow_security = inspect.getsource(AgenticTabContext._workflow_security)

    assert "GITLEAKS_SNAPSHOT" in secret_scan
    assert "GITLEAKS_HISTORY" in secret_scan
    assert "*.yml" in workflow_security
    assert "*.yaml" in workflow_security


def test_should_install_frozen_dependencies_with_ignore_scripts() -> None:
    implementation = inspect.getsource(AgenticTabContext)
    module = inspect.getmodule(AgenticTabContext)

    assert module is not None
    assert module.INSTALL_COMMAND == ["npm", "ci", "--ignore-scripts"]
    assert '["npm", "run", "gate"]' in implementation


def test_should_pin_foundation_to_the_exact_central_commit() -> None:
    config = json.loads((Path(__file__).parents[2] / "dagger.json").read_text())

    dependencies = config.get("dependencies", [])

    assert dependencies == [
        {
            "name": "foundation",
            "source": f"github.com/gainratio/ci/modules/portfolio-foundation@{CENTRAL_SHA}",
            "pin": CENTRAL_SHA,
        }
    ]


def test_should_require_an_explicit_commit_for_the_canonical_check() -> None:
    signature = inspect.signature(AgenticTabContext.ci)

    assert signature.parameters["commit_sha"].default is inspect.Signature.empty


def test_should_bind_guard_then_run_products_on_the_bound_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    foundation = RecordingFoundation(events)
    atc = AgenticTabContext.__new__(AgenticTabContext)
    atc.source = cast(dagger.Directory, "caller-source")

    async def run_products(source: dagger.Directory, *_identity: object) -> None:
        assert source == foundation.bound
        events.append("product")

    monkeypatch.setattr(main_module, "dag", RecordingDag(foundation))
    monkeypatch.setattr(atc, "_run_ci", run_products)

    result = asyncio.run(atc.ci(VALID_SHA, REPOSITORY))

    assert result == "Agentic Tab Context canonical Dagger gate passed"
    assert events == ["source", "guard", "product"]


def test_should_stop_before_products_when_foundation_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    foundation = RecordingFoundation(events, ValueError("guard rejected"))
    atc = AgenticTabContext.__new__(AgenticTabContext)
    atc.source = cast(dagger.Directory, "caller-source")

    async def run_products(*_arguments: object) -> None:
        events.append("product")

    monkeypatch.setattr(main_module, "dag", RecordingDag(foundation))
    monkeypatch.setattr(atc, "_run_ci", run_products)

    with pytest.raises(ValueError, match="guard rejected"):
        asyncio.run(atc.ci(VALID_SHA, REPOSITORY))
    assert events == ["source"]


@pytest.mark.parametrize("repository", ALLOWED)
def test_should_bind_and_guard_the_runs_own_allowed_repository(
    repository: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    foundation = RecordingFoundation(events, repository=repository)
    atc = AgenticTabContext.__new__(AgenticTabContext)
    atc.source = cast(dagger.Directory, "caller-source")

    async def run_products(*_arguments: object) -> None:
        events.append("product")

    monkeypatch.setattr(main_module, "dag", RecordingDag(foundation))
    monkeypatch.setattr(atc, "_run_ci", run_products)

    asyncio.run(atc.ci(VALID_SHA, repository))

    assert events == ["source", "guard", "product"]


@pytest.mark.parametrize("repository", FOREIGN_REPOSITORIES)
def test_should_refuse_a_foreign_repository_before_foundation_runs(
    repository: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    foundation = RecordingFoundation(events)
    atc = AgenticTabContext.__new__(AgenticTabContext)
    atc.source = cast(dagger.Directory, "caller-source")

    monkeypatch.setattr(main_module, "dag", RecordingDag(foundation))

    with pytest.raises(ValueError, match="repository"):
        asyncio.run(atc.ci(VALID_SHA, repository))
    assert events == []
