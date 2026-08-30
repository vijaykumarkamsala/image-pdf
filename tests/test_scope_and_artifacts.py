"""Scope guards, fixture integrity, schema export and the CLI.

Acceptance criteria 6, 7 and 8. The scope guards in ``TestNoModelIntegration``
are the mechanical form of "No model, weight or external provider is integrated":
they fail if a later change quietly adds an inference dependency or commits a
weight file.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tomllib
from pathlib import Path

import jsonschema
import pytest

from ipw.benchmark_runner.cli import main
from ipw.benchmark_runner.environment import (
    RUNTIME_DEPENDENCIES,
    dependency_versions,
    probe_environment,
)
from ipw.benchmark_runner.fixtures import (
    compute_fixture_hashes,
    fixture_lock_path,
    format_lock,
    parse_lock,
    verify_fixtures,
)
from ipw.benchmark_runner.schema_export import SCHEMA_EXPORTS, check_schemas, schemas_dir

# Directories that are gitignored build or tooling output, not committed content.
# .tools holds the libvips DLLs; node_modules and public/dist are npm and tsc
# output. Scanning them would measure other people's code, not ours.
NOT_GENERATED_FILES = {
    ".coverage",
    "coverage.xml",
}
"""Generated files that sit at the repository root rather than inside a directory.

The large-file scan skips *directories* by name, which cannot exclude a bare file
like the coverage database pytest-cov writes beside the tests. Listing them is
less clever than consulting .gitignore and much more legible - and there is no Git
repository to consult yet in any case.
"""

NOT_COMMITTED = {
    ".venv",
    ".git",
    ".tools",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
}

FORBIDDEN_WEIGHT_SUFFIXES = {
    ".pth",
    ".pt",
    ".ckpt",
    ".safetensors",
    ".onnx",
    ".tflite",
    ".gguf",
    ".bin",
}

FORBIDDEN_IMPORT_NAMES = {
    "torchvision",
    "basicsr",
    "facexlib",
    "gfpgan",
    "realesrgan",
    "codeformer",
    "rembg",
    "onnxruntime",
    "cv2",
    "opencv-python",
    "tensorflow",
    "transformers",
    "diffusers",
    "huggingface_hub",
    "openai",
    "boto3",
    "requests",
    "httpx",
}
"""Libraries that may not be declared or imported anywhere in the monorepo.

``torch`` left this set at POC-006 and ``numpy`` with it; both are now confined
instead - see ``CONFINED_IMPORT_NAMES``. The rest have not softened.

``gfpgan``, ``facexlib`` and ``basicsr`` are listed for a specific reason rather
than for tidiness. The official ``realesrgan`` distribution hard-depends on all
three, and ``gfpgan`` is a face-restoration model. POC-006 requires that face
restoration is never silently invoked; the durable way to guarantee that is for
no face model to be installable, which is what this assertion holds in place.
"""

CONFINED_IMPORT_NAMES = {"torch"}
"""The inference runtime, allowed only inside the AI adapter package.

The benchmark compares a standard path against an AI path. If a tensor runtime
leaked into the standard processor, the comparison would be measuring two variants
of the same thing. Confinement is what keeps the two families genuinely separate,
so it is asserted rather than assumed.

``numpy`` left this set at POC-007. It is array arithmetic, not an inference
runtime, and the metrics package needs it to compute PSNR and SSIM - which is
measurement rather than processing of either family. Keeping it confined would
have meant either implementing SSIM in pure Python or pretending the metrics
belonged to the AI adapters; neither is true. ``numpy`` remains an approved
dependency with a recorded licence, and is still barred from the standard
baseline by ``STANDARD_BASELINE_BANNED`` below.
"""

STANDARD_BASELINE_BANNED = CONFINED_IMPORT_NAMES | {"numpy"}
"""What the deterministic baseline may never import, whatever else is allowed.

The standard processor is the control every AI model is measured against. It has
to stay a plain imaging pipeline, or the control stops being one.
"""

AI_ADAPTER_PACKAGE = ("packages", "processors", "src", "ipw", "processors", "ai_adapters")

VENDOR_DIRECTORY = "vendor"
"""Third-party source copied in verbatim, under its own licence.

Exempt from the guards about how *we* write code - naming, formatting, module
layout - because it was not written here and reformatting it would destroy the
diff against upstream that makes the copy verifiable. Not exempt from the import
guards: vendored code that pulled in a forbidden dependency would be exactly as
dangerous as ours doing it.
"""

METRICS_PACKAGE = ("packages", "metrics")

# The vector package is the third and, so far, last place numpy is allowed.
#
# Tracing is mask arithmetic over every pixel: which cells face an empty
# neighbour, where the transitions are, how the histogram splits. Measured on a
# 1500x1500 mask, the numpy form takes 23 ms and the pure-Python equivalent
# 725 ms - 32x - which at four megapixels is about 1.3 seconds per colour layer,
# so roughly ten seconds for an eight-colour logo instead of a third of one.
#
# numpy is already a hard dependency of this project, so this widens no supply
# chain; what it widens is the rule, and the rule is what stops that happening
# by habit. Each further entry here should have to earn it the same way.
VECTOR_PACKAGE = ("packages", "vector")


def _dependency_name(spec: str) -> str:
    """Strip version constraints from a PEP 508 requirement string."""
    for separator in (">", "<", "=", "!", "~", "[", ";", " "):
        spec = spec.split(separator)[0]
    return spec.strip().lower()


def _workspace_dependencies(repo_root: Path) -> dict[str, set[str]]:
    """Third-party dependencies declared by each Python workspace.

    Internal ``ipw-*`` packages are excluded: they are this repository, not a
    supply-chain entry.
    """
    manifest = tomllib.loads((repo_root / "workspaces.toml").read_text(encoding="utf-8"))
    result: dict[str, set[str]] = {}
    for workspace in manifest["workspace"]:
        if workspace["language"] != "python":
            continue
        config_path = repo_root / workspace["path"] / "pyproject.toml"
        if not config_path.is_file():
            continue  # placeholder workspace, no package yet
        project = tomllib.loads(config_path.read_text(encoding="utf-8"))["project"]
        declared = list(project.get("dependencies", []))
        for extra in project.get("optional-dependencies", {}).values():
            declared.extend(extra)
        result[workspace["name"]] = {
            name
            for name in (_dependency_name(spec) for spec in declared)
            if not name.startswith("ipw-")
        }
    return result


# The complete third-party runtime surface of the monorepo. Every entry must have
# an approved licence disposition in data/licences/register.json.
#
#   pydantic  POC-001  the contract layer
#   Pillow    POC-004  primary decoder for the deterministic baseline (D-045)
#   pyvips    POC-004  libvips binding, the performance comparator (D-045)
#   torch     POC-006  inference runtime for the AI adapter (CPU build)
#   numpy     POC-006  the array hand-off between Pillow and torch; also the
#                      arithmetic behind PSNR and SSIM from POC-007
#   cryptography
#             APP-007  protection for resumable-session authorization at rest.
#   google-cloud-storage
#             Recovery 2B official ADC-backed private object client.
#   google-auth
#             Recovery 2B authenticated Cloud Tasks request verification.
#   pg8000    APP-008  the PostgreSQL driver, in pure Python. Preferred over
#                      psycopg and psycopg2, which are LGPL-3.0 and would put a
#                      copyleft component in the runtime path of every request.
#                      It arrives with four transitive packages - scramp,
#                      asn1crypto, python-dateutil, six - which are recorded in
#                      the licence register but do not appear here, because this
#                      constant tracks what a workspace *declares*.
#
# Growing this set is a deliberate act: add the dependency to a workspace
# pyproject.toml, record its licence with real evidence, and update this constant
# in the same change. If this assertion fails, a dependency arrived without that.
APPROVED_RUNTIME_DEPENDENCIES = {
    "pydantic",
    "pillow",
    "pyvips",
    "torch",
    "numpy",
    "cryptography",
    "google-auth",
    "google-cloud-storage",
    "pg8000",
}


class TestNoModelIntegration:
    def test_runtime_dependencies_are_exactly_the_approved_set(self, repo_root: Path) -> None:
        per_workspace = _workspace_dependencies(repo_root)
        combined: set[str] = set().union(*per_workspace.values())
        detail = {name: sorted(deps) for name, deps in per_workspace.items()}
        assert combined == APPROVED_RUNTIME_DEPENDENCIES, (
            f"the runtime dependency register changed to {sorted(combined)}; the approved set is "
            f"{sorted(APPROVED_RUNTIME_DEPENDENCIES)}. Adding a dependency requires an approved "
            f"task and a licence disposition record. Per workspace: {detail}"
        )

    def test_every_runtime_dependency_has_an_approved_licence(self, repo_root: Path) -> None:
        """A dependency may not execute without a recorded, approved disposition."""
        from ipw.contracts.licence import Disposition
        from ipw.licence_registry import load_release_register

        register = load_release_register(repo_root)
        for name in sorted(APPROVED_RUNTIME_DEPENDENCIES):
            component = register.get(name)
            assert component is not None, f"{name} is a runtime dependency but is not registered"
            assert component.disposition is Disposition.APPROVED, (
                f"{name} resolves to {component.disposition.value}, not approved"
            )
            assert component.evidence, f"{name} is approved with no recorded evidence"
            assert component.supply_chain_gaps() == (), (
                f"{name} fails Gate B: {component.supply_chain_gaps()}"
            )

    def test_dependency_direction_is_respected(self, repo_root: Path) -> None:
        """Contracts stays pure; only processors carries the imaging libraries."""
        per_workspace = _workspace_dependencies(repo_root)
        assert per_workspace["ipw-contracts"] == {"pydantic"}, (
            "ipw-contracts must stay dependency-light: the browser lab consumes its "
            "generated schema, and every dependency here is one the schema drags along"
        )
        assert per_workspace["ipw-processors"] == {"pillow", "pyvips", "torch", "numpy"}, (
            "the imaging and inference libraries belong to the processor workspace and nowhere else"
        )
        assert per_workspace["ipw-benchmark-runner"] == set(), (
            "the runner orchestrates; it must never import a decoder directly"
        )

    def test_no_unapproved_inference_library_is_declared(self, repo_root: Path) -> None:
        combined: set[str] = set().union(*_workspace_dependencies(repo_root).values())
        combined |= {
            _dependency_name(line)
            for line in (repo_root / "requirements-dev.txt")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.strip() and not line.startswith("#")
        }
        offenders = sorted(combined & FORBIDDEN_IMPORT_NAMES)
        assert offenders == [], (
            f"{offenders} must not be declared anywhere in the monorepo. torch and numpy "
            "are the only approved inference-adjacent dependencies (POC-006) and are "
            "confined to the AI adapter package."
        )

    def test_no_model_weight_file_exists_in_the_tree(self, repo_root: Path) -> None:
        skip = NOT_COMMITTED
        offenders = [
            path.relative_to(repo_root).as_posix()
            for path in repo_root.rglob("*")
            if path.is_file()
            and path.suffix.lower() in FORBIDDEN_WEIGHT_SUFFIXES
            and not any(part in skip for part in path.parts)
        ]
        assert offenders == [], f"model weight files must never be committed: {offenders}"

    @staticmethod
    def _imported_names(path: Path) -> set[str]:
        import ast

        names: set[str] = set()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names.add((node.module or "").split(".")[0])
        return names

    @staticmethod
    def _source_files(repo_root: Path) -> list[Path]:
        sources: list[Path] = []
        for workspace in ("packages", "services", "apps", "tools"):
            sources.extend(sorted((repo_root / workspace).rglob("*.py")))
        return sources

    def test_no_source_module_imports_a_forbidden_library(self, repo_root: Path) -> None:
        offenders = [
            f"{path.relative_to(repo_root).as_posix()}: {name}"
            for path in self._source_files(repo_root)
            for name in sorted(self._imported_names(path) & FORBIDDEN_IMPORT_NAMES)
        ]
        assert offenders == [], f"forbidden libraries must not be imported: {offenders}"

    def test_the_inference_runtime_is_confined_to_the_ai_adapters(self, repo_root: Path) -> None:
        """torch may exist in the repository, but not in the shipped standard path.

        Without this, "standard versus AI" could quietly become "AI versus AI"
        and every comparison in the benchmark would lose its meaning.

        Scoped to ``src`` trees since POC-007. A test for an AI adapter
        self-evidently imports torch, and forbidding that would only teach people
        to smuggle it in behind an alias. The rule is about what the product
        executes, so it is asserted where the product lives.
        """
        offenders = [
            f"{path.relative_to(repo_root).as_posix()}: {name}"
            for path in self._source_files(repo_root)
            if "src" in path.parts
            for name in sorted(self._imported_names(path) & CONFINED_IMPORT_NAMES)
            if AI_ADAPTER_PACKAGE[-1] not in path.parts
        ]
        assert offenders == [], (
            f"the inference runtime escaped the AI adapter package: {offenders}. "
            f"Only modules under {'/'.join(AI_ADAPTER_PACKAGE)} may import "
            f"{sorted(CONFINED_IMPORT_NAMES)}."
        )

    def test_the_standard_baseline_imports_no_tensor_runtime(self, repo_root: Path) -> None:
        """The control must stay a plain imaging pipeline, numpy included."""
        standard = repo_root / "packages" / "processors" / "src" / "ipw" / "processors" / "standard"
        for path in sorted(standard.rglob("*.py")):
            leaked = self._imported_names(path) & (
                STANDARD_BASELINE_BANNED | FORBIDDEN_IMPORT_NAMES
            )
            assert leaked == set(), f"{path.name} imports {sorted(leaked)}"

    def test_numpy_is_confined_to_three_packages(self, repo_root: Path) -> None:
        """Approved in three places, and still not a licence to spread.

        Each entry is a considered decision with a measurement behind it, not a
        precedent. The point of the test is that adding a fourth has to be an
        argument someone makes rather than an import someone writes.
        """
        allowed = (AI_ADAPTER_PACKAGE[-1], METRICS_PACKAGE[-1], VECTOR_PACKAGE[-1])
        offenders = [
            path.relative_to(repo_root).as_posix()
            for path in self._source_files(repo_root)
            if "src" in path.parts
            and "numpy" in self._imported_names(path)
            and not any(part in allowed for part in path.parts)
        ]
        assert offenders == [], (
            f"numpy escaped the AI adapters and the metrics package: {offenders}"
        )

    def test_the_ai_adapter_package_holds_only_approved_modules(self, repo_root: Path) -> None:
        """POC-006 adds exactly one adapter and the architecture it needs."""
        adapters = repo_root.joinpath(*AI_ADAPTER_PACKAGE)
        modules = sorted(module.name for module in adapters.glob("*.py"))
        assert modules == [
            "__init__.py",
            "accelerator.py",
            "common.py",
            "real_esrgan.py",
            "rrdbnet.py",
            "swinir.py",
        ], (
            f"unexpected modules in the AI adapter package: {modules}. Each additional "
            "adapter is a separate POC task with its own licence review."
        )

    def test_vendored_source_is_attributed(self, repo_root: Path) -> None:
        """Nothing may be copied in without saying where it came from.

        Vendoring third-party source is permitted (D-056) and is sometimes the
        honest choice - reimplementing 867 lines of transformer risks a silent
        numerical error that a strict state-dict load cannot catch. What is not
        permitted is copying it in unattributed, which turns a licensed copy into
        an unlicensed one and a verifiable file into an unverifiable one.
        """
        vendor = repo_root.joinpath(*AI_ADAPTER_PACKAGE, VENDOR_DIRECTORY)
        if not vendor.is_dir():
            return
        for module in sorted(vendor.glob("*.py")):
            if module.name == "__init__.py":
                continue
            source = module.read_text(encoding="utf-8")
            for required in ("VENDORED THIRD-PARTY SOURCE", "Upstream :", "Commit   :", "SHA-256"):
                assert required in source, (
                    f"{module.name} is vendored without a {required!r} line. Every copied "
                    "file must name its origin, its pinned commit and its digest."
                )
            assert "MODIFICATIONS MADE" in source, (
                f"{module.name} does not state its modifications, which Apache-2.0 "
                "section 4(b) requires of a changed file"
            )

    def test_vendored_source_imports_nothing_forbidden(self, repo_root: Path) -> None:
        """The formatting exemption is not an import exemption."""
        vendor = repo_root.joinpath(*AI_ADAPTER_PACKAGE, VENDOR_DIRECTORY)
        if not vendor.is_dir():
            return
        for module in sorted(vendor.rglob("*.py")):
            leaked = self._imported_names(module) & FORBIDDEN_IMPORT_NAMES
            assert leaked == set(), f"vendored {module.name} imports {sorted(leaked)}"

    def test_only_expected_files_are_vendored(self, repo_root: Path) -> None:
        vendor = repo_root.joinpath(*AI_ADAPTER_PACKAGE, VENDOR_DIRECTORY)
        if not vendor.is_dir():
            return
        names = sorted(module.name for module in vendor.glob("*.py"))
        assert names == ["__init__.py", "network_swinir.py"], (
            f"unexpected vendored files: {names}. Each copy is a separate licence "
            "decision with its own review."
        )

    def test_no_face_restoration_module_exists(self, repo_root: Path) -> None:
        """The POC-006 rule, checked structurally rather than trusted."""
        adapters = repo_root.joinpath(*AI_ADAPTER_PACKAGE)
        for path in sorted(adapters.rglob("*.py")):
            source = path.read_text(encoding="utf-8").lower()
            for banned in ("gfpganer", "facerestorehelper", "from gfpgan", "import gfpgan"):
                assert banned not in source, f"{path.name} references face restoration: {banned}"

    @staticmethod
    def _is_ignored(repo_root: Path, relative: str) -> bool:
        """Whether .gitignore excludes this path.

        The scan below is about what would be *committed*, so it has to consult
        the ignore rules. Walking the working tree and flagging anything large
        answers a different question, and answers it wrongly on any machine that
        has a real corpus - which is exactly what data/corpus exists to hold.
        """
        import fnmatch

        rules = [
            line.strip()
            for line in (repo_root / ".gitignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        name = relative.rsplit("/", 1)[-1]
        ignored = False
        for rule in rules:
            negated = rule.startswith("!")
            pattern = rule[1:] if negated else rule
            matched = (
                fnmatch.fnmatch(relative, pattern)
                or fnmatch.fnmatch(name, pattern)
                or (pattern.endswith("/") and relative.startswith(pattern))
                or fnmatch.fnmatch(relative, pattern.rstrip("/") + "/*")
            )
            if matched:
                ignored = not negated
        return ignored

    def test_no_committed_file_is_unexpectedly_large(self, repo_root: Path) -> None:
        """AGENTS.md: do not commit large benchmark assets to Git."""
        limit = 256 * 1024
        # .tools holds the gitignored libvips DLLs installed by tools/install_libvips.py.
        # They are a local native toolchain, never committed content.
        skip = NOT_COMMITTED
        offenders = [
            (path.relative_to(repo_root).as_posix(), path.stat().st_size)
            for path in repo_root.rglob("*")
            if path.is_file()
            and not any(part in skip for part in path.parts)
            and path.name not in NOT_GENERATED_FILES
            and path.stat().st_size > limit
            and not self._is_ignored(repo_root, path.relative_to(repo_root).as_posix())
        ]
        assert offenders == [], f"files above {limit} bytes should not be committed: {offenders}"

    def test_the_large_file_guard_still_catches_a_tracked_file(self, repo_root: Path) -> None:
        """Otherwise the ignore-awareness above could hide everything.

        A guard that learned to skip things must be shown still to catch one, or
        the fix for a false positive quietly becomes a false negative.
        """
        assert not self._is_ignored(repo_root, "packages/contracts/src/ipw/contracts/asset.py")
        assert self._is_ignored(repo_root, "data/corpus/anything/photo.jpeg")


class TestFixtureIntegrity:
    def test_committed_fixtures_match_the_lock(self, repo_root: Path) -> None:
        ok, problems = verify_fixtures(repo_root)
        assert ok, f"fixture integrity failed: {problems}"

    def test_the_lock_covers_every_fixture(self, repo_root: Path) -> None:
        on_disk = compute_fixture_hashes(repo_root)
        recorded = parse_lock(fixture_lock_path(repo_root).read_text(encoding="utf-8"))
        assert set(on_disk) == set(recorded)
        assert on_disk

    def test_the_fixture_is_byte_reproducible(self, repo_root: Path) -> None:
        """The committed PNG must be regenerable byte-for-byte from its generator."""
        result = subprocess.run(
            [sys.executable, "tools/make_fixtures.py", "--check"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "reproducible" in result.stdout

    def test_a_tampered_fixture_is_detected(self, tmp_path: Path) -> None:
        images = tmp_path / "data" / "fixtures" / "images"
        images.mkdir(parents=True)
        (images / "a.png").write_bytes(b"original")
        lock = fixture_lock_path(tmp_path)
        lock.write_text(format_lock(compute_fixture_hashes(tmp_path)), encoding="utf-8")
        assert verify_fixtures(tmp_path)[0]

        (images / "a.png").write_bytes(b"tampered")
        ok, problems = verify_fixtures(tmp_path)
        assert not ok
        assert any("bytes changed" in problem for problem in problems)

    def test_a_missing_lock_is_reported(self, tmp_path: Path) -> None:
        ok, problems = verify_fixtures(tmp_path)
        assert not ok
        assert any("lock not found" in problem for problem in problems)

    def test_a_malformed_lock_line_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="malformed"):
            parse_lock("not-a-valid-line\n")


class TestSchemaExport:
    def test_committed_schemas_match_the_models(self, repo_root: Path) -> None:
        ok, problems = check_schemas(repo_root)
        assert ok, f"schema drift detected: {problems}"

    def test_every_required_contract_family_is_exported(self) -> None:
        required = {
            "asset-manifest",
            "operation",
            "processor-identity",
            "licence-disposition",
            "inspection-result",
            "benchmark-run",
            "asset-result",
            "measurement",
            "normalized-failure",
        }
        assert required <= set(SCHEMA_EXPORTS), (
            "POC-001 requires versioned schemas for all nine contract families"
        )

    def test_exported_schemas_are_valid_json_schema(self, repo_root: Path) -> None:
        for path in sorted(schemas_dir(repo_root).glob("*.schema.json")):
            document = json.loads(path.read_text(encoding="utf-8"))
            jsonschema.Draft202012Validator.check_schema(document)

    def test_the_example_manifest_validates_against_the_exported_schema(
        self, repo_root: Path, example_manifest_path: Path
    ) -> None:
        """The round trip a non-Python consumer (POC-005) will actually perform."""
        schema = json.loads(
            (schemas_dir(repo_root) / "asset-manifest.schema.json").read_text(encoding="utf-8")
        )
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator(schema).validate(document)

    def test_the_golden_report_validates_against_the_exported_schema(self, repo_root: Path) -> None:
        schema = json.loads(
            (schemas_dir(repo_root) / "benchmark-report.schema.json").read_text(encoding="utf-8")
        )
        document = json.loads(
            (repo_root / "data" / "reports" / "example" / "report.json").read_text(encoding="utf-8")
        )
        jsonschema.Draft202012Validator(schema).validate(document)

    def test_a_bad_manifest_is_rejected_by_the_exported_schema(
        self, repo_root: Path, example_manifest_path: Path
    ) -> None:
        schema = json.loads(
            (schemas_dir(repo_root) / "asset-manifest.schema.json").read_text(encoding="utf-8")
        )
        document = json.loads(example_manifest_path.read_text(encoding="utf-8"))
        document["assets"][0]["declared_width"] = -5
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.Draft202012Validator(schema).validate(document)


class TestEnvironmentProbe:
    def test_probe_records_runtime_and_hardware(self) -> None:
        record = probe_environment()
        assert record.python_version
        assert record.python_implementation
        assert record.os_name != "unknown"
        assert record.hardware.logical_cpus >= 1

    def test_gpu_fields_are_empty_in_poc_001(self) -> None:
        record = probe_environment()
        assert record.hardware.gpu_name is None
        assert record.hardware.gpu_vram_bytes is None

    def test_dependency_versions_cover_the_register(self) -> None:
        versions = dependency_versions()
        assert set(versions) == set(RUNTIME_DEPENDENCIES)
        assert set(RUNTIME_DEPENDENCIES) <= APPROVED_RUNTIME_DEPENDENCIES
        assert all(value != "not-installed" for value in versions.values())


class TestCli:
    def test_validate_example_manifest_exits_zero(
        self, example_manifest_path: Path, repo_root: Path
    ) -> None:
        assert (
            main(
                [
                    "validate-manifest",
                    str(example_manifest_path),
                    "--asset-root",
                    str(repo_root),
                ]
            )
            == 0
        )

    def test_invalid_manifest_exits_two(self, invalid_manifest_dir: Path, repo_root: Path) -> None:
        assert (
            main(
                [
                    "validate-manifest",
                    str(invalid_manifest_dir / "hash-mismatch.json"),
                    "--asset-root",
                    str(repo_root),
                ]
            )
            == 2
        )

    def test_json_output_is_machine_readable(
        self,
        invalid_manifest_dir: Path,
        repo_root: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        code = main(
            [
                "validate-manifest",
                str(invalid_manifest_dir / "missing-provenance.json"),
                "--format",
                "json",
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == 2
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is False
        assert payload["failures"][0]["code"] == "MANIFEST.MISSING_PROVENANCE"
        assert payload["failures"][0]["pointer"] == "/assets/0/provenance"

    def test_no_verify_hashes_flag_relaxes_verification(
        self, invalid_manifest_dir: Path, repo_root: Path
    ) -> None:
        assert (
            main(
                [
                    "validate-manifest",
                    str(invalid_manifest_dir / "hash-mismatch.json"),
                    "--asset-root",
                    str(repo_root),
                    "--no-verify-hashes",
                ]
            )
            == 0
        )

    def test_report_command_writes_both_artifacts(
        self, example_manifest_path: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        code = main(
            [
                "report",
                "--manifest",
                str(example_manifest_path),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
                "--deterministic",
            ]
        )
        assert code == 0
        assert (tmp_path / "out" / "report.json").is_file()
        assert (tmp_path / "out" / "report.md").is_file()

    def test_report_refuses_an_invalid_manifest(
        self, invalid_manifest_dir: Path, repo_root: Path, tmp_path: Path
    ) -> None:
        code = main(
            [
                "report",
                "--manifest",
                str(invalid_manifest_dir / "missing-provenance.json"),
                "--out",
                str(tmp_path / "out"),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == 2
        assert not (tmp_path / "out" / "report.json").exists()

    def test_schema_check_passes(self, repo_root: Path) -> None:
        assert main(["schema", "export", "--check", "--repo-root", str(repo_root)]) == 0

    def test_schema_check_fails_on_an_empty_directory(self, tmp_path: Path) -> None:
        assert main(["schema", "export", "--check", "--repo-root", str(tmp_path)]) == 2

    def test_fixtures_verify_passes(self, repo_root: Path) -> None:
        assert main(["fixtures", "verify", "--repo-root", str(repo_root)]) == 0

    def test_version_reports_the_contract_version(self, capsys: pytest.CaptureFixture[str]) -> None:
        assert main(["version"]) == 0
        out = capsys.readouterr().out
        assert "benchmark contract" in out

    def test_internal_errors_exit_one(self, tmp_path: Path, repo_root: Path) -> None:
        bad_policy = tmp_path / "policy.json"
        bad_policy.write_text("{not json", encoding="utf-8")
        code = main(
            [
                "validate-manifest",
                str(repo_root / "data" / "manifests" / "example.manifest.json"),
                "--policy",
                str(bad_policy),
                "--asset-root",
                str(repo_root),
            ]
        )
        assert code == 1

    def test_module_entry_point_runs(self, repo_root: Path) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "ipw.benchmark_runner", "version"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0
        assert "ipw-benchmark-runner" in result.stdout


class TestDocumentedStructure:
    @pytest.mark.parametrize(
        "relative",
        [
            "apps/browser-lab",
            "data/fixtures",
            "data/manifests",
            "data/reports",
            "docs",
            "infra/docker",
            "packages/contracts/src/ipw/contracts",
            "packages/contracts-ts",
            "packages/metrics",
            "packages/processors/src/ipw/processors/ai_adapters",
            "packages/processors/src/ipw/processors/standard",
            "packages/schemas/v1",
            "services/benchmark-runner/src/ipw/benchmark_runner",
            "tests",
            "tools",
        ],
    )
    def test_required_directory_exists(self, repo_root: Path, relative: str) -> None:
        assert (repo_root / relative).is_dir(), f"missing approved directory: {relative}"

    def test_approved_documents_are_untouched(self, repo_root: Path) -> None:
        """POC-001 adds code; it must not edit the approved product documents."""
        expected = {
            "MASTER_PRODUCT_BLUEPRINT.md",
            "PRODUCT_REQUIREMENTS.md",
            "USER_FLOWS_AND_EDGE_CASES.md",
            "PRODUCT_DECISION_LOG.md",
            "TECHNICAL_POC_AND_MODEL_BENCHMARK_PLAN.md",
            "POC_TASKS.md",
            "POC_EXECUTION_PROMPT.md",
        }
        present = {p.name for p in (repo_root / "docs").glob("*.md")}
        assert expected <= present
