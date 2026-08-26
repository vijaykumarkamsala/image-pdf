"""Command line interface for the benchmark foundation.

Built on stdlib ``argparse``. A CLI framework would be more ergonomic, but every
dependency must be reviewed and recorded (AGENTS.md, Gate A), and five
subcommands do not justify permanently enlarging the licence register.

Exit codes
----------
``0``  success
``1``  internal error (unreadable file, unexpected exception)
``2``  validation or verification failure - the expected way a bad manifest fails
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from ipw.benchmark_runner.fixtures import (
    compute_fixture_hashes,
    fixture_lock_path,
    format_lock,
    verify_fixtures,
)
from ipw.benchmark_runner.ids import manifest_id_of
from ipw.benchmark_runner.licence_register import (
    load_register,
    register_path,
)
from ipw.benchmark_runner.policy import load_policy
from ipw.benchmark_runner.report import build_report, write_report
from ipw.benchmark_runner.schema_export import check_schemas, export_schemas
from ipw.benchmark_runner.validation import ValidationReport, validate_manifest_file
from ipw.benchmark_runner.workspace import TOOL_VERSION, find_repo_root
from ipw.contracts.licence import RunPurpose
from ipw.contracts.operation import ADVERTISED_OPERATIONS
from ipw.contracts.review import ReviewDimension
from ipw.contracts.runtime import InputRef, RunContext
from ipw.contracts.safety import DEFAULT_SAFETY_POLICY, InspectionResult
from ipw.contracts.version import SCHEMA_VERSION
from ipw.processors.inspection import inspect_input

__all__ = ["default_repo_root", "main"]

EXIT_OK = 0
EXIT_INTERNAL_ERROR = 1
EXIT_VALIDATION_FAILED = 2


DEFAULT_REVIEW_DIMENSIONS = (
    "overall_usefulness",
    "natural_appearance",
    "detail_improvement",
    "artifact_level",
)
"""The four dimensions that apply to every operation benchmarked so far.

The other six are material-dependent - identity preservation means nothing on a
product photograph, tiling seams mean nothing on an untiled image - and a
dimension nobody can answer produces noise, not data. Callers add them with
repeated --dimension flags when the corpus warrants it.
"""


def default_repo_root() -> Path:
    """Locate the monorepo root by its ``workspaces.toml`` marker.

    Independent of the working directory, so ``bench`` behaves identically
    wherever it is invoked from - which is what makes reports reproducible.
    """
    return find_repo_root()


# ------------------------------------------------------------------ printing --


def _print_validation_text(report: ValidationReport, stream: object) -> None:
    write = getattr(stream, "write")  # noqa: B009 - keeps the signature stream-agnostic

    def line(text: str = "") -> None:
        write(text + "\n")

    line(f"manifest        : {report.manifest_path}")
    line(f"manifest id     : {report.manifest_id or '-'}")
    line(f"manifest digest : {report.manifest_digest or '-'}")
    line(f"manifest sha256 : {report.manifest_sha256 or '-'}")
    line(f"policy          : {report.policy_name} ({report.policy_digest})")
    line(f"assets          : {report.asset_count}")
    line(f"hashes verified : {'yes' if report.hashes_verified else 'no'}")
    line()

    if report.ok:
        line("RESULT: VALID")
    else:
        line(f"RESULT: INVALID ({len(report.failures)} failure(s))")

    for item in report.failures:
        line()
        line(f"  [{item.code.value}] {item.message}")
        line(f"    category    : {item.category.value}")
        line(f"    pointer     : {item.pointer or '-'}")
        line(f"    retryable   : {'yes' if item.retryable else 'no'}")
        line(f"    next action : {item.next_action.value}")
        if item.remediation:
            line(f"    remediation : {item.remediation}")

    for item in report.warnings:
        line()
        line(f"  WARNING [{item.code.value}] {item.message}")
        line(f"    pointer     : {item.pointer or '-'}")


def _print_inspection(name: str, result: InspectionResult) -> None:
    def line(text: str = "") -> None:
        sys.stdout.write(text + "\n")

    def size(width: int | None, height: int | None) -> str:
        return f"{width}x{height}" if width and height else "-"

    media = result.detected_media_type.value if result.detected_media_type else "-"
    orientation = result.orientation

    line(f"file             : {name}")
    line(f"sha256           : {result.sha256}")
    line(f"decision         : {result.decision.value.upper()}")
    line(f"detected         : {media} ({result.detected_encoding or '-'})")
    line(f"stored size      : {size(result.decoded_width, result.decoded_height)}")
    line(f"display size     : {size(result.display_width, result.display_height)}")
    line(f"channels / depth : {result.decoded_channels or '-'} / {result.decoded_bit_depth or '-'}")
    line(
        f"orientation      : exif={orientation.exif_tag or '-'} "
        f"rotate={orientation.rotate_degrees} mirrored={orientation.mirrored}"
    )
    line(f"compressed bytes : {result.compressed_bytes:,}")
    line(f"decoded pixels   : {result.decoded_pixels:,}")
    line(f"working memory   : {result.estimated_working_memory_bytes:,} bytes (estimated)")
    line(f"expansion ratio  : {result.expansion_ratio:,}x")
    line(
        f"header bytes     : {result.header_bytes_read:,} read; "
        f"pixels decoded: {result.pixels_decoded}"
    )
    line(f"risk flags       : {', '.join(f.value for f in result.risk_flags) or '-'}")

    if result.failure is not None:
        line()
        line(f"  REJECTED [{result.failure.code.value}] {result.failure.message}")
        line(f"    next action : {result.failure.next_action.value}")
        if result.failure.remediation:
            line(f"    remediation : {result.failure.remediation}")
    for item in result.warnings:
        line()
        line(f"  WARNING [{item.code.value}] {item.message}")
    line()


# ------------------------------------------------------------------ commands --


def cmd_validate_manifest(args: argparse.Namespace) -> int:
    policy = load_policy(args.policy)
    if args.no_verify_hashes:
        policy = policy.model_copy(
            update={"verify_local_hashes": False, "verify_local_declared_bytes": False}
        )

    report, _ = validate_manifest_file(
        Path(args.manifest), policy=policy, asset_root=Path(args.asset_root)
    )

    if args.format == "json":
        sys.stdout.write(
            json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True, ensure_ascii=False)
            + "\n"
        )
    else:
        _print_validation_text(report, sys.stdout)

    return EXIT_OK if report.ok else EXIT_VALIDATION_FAILED


def cmd_report(args: argparse.Namespace) -> int:
    policy = load_policy(args.policy)
    manifest_path = Path(args.manifest)
    report, manifest = validate_manifest_file(
        manifest_path, policy=policy, asset_root=Path(args.asset_root)
    )

    if manifest is None or not report.ok:
        sys.stderr.write("manifest validation failed; no report was generated\n")
        _print_validation_text(report, sys.stderr)
        return EXIT_VALIDATION_FAILED

    ctx = RunContext.create(deterministic=args.deterministic)
    register_file = register_path(Path(args.asset_root))
    register = load_register(register_file) if register_file.is_file() else None
    built = build_report(
        manifest,
        report,
        ctx,
        tool_version=TOOL_VERSION,
        register=register,
        purpose=RunPurpose(args.purpose),
    )
    json_path, md_path = write_report(built, Path(args.out))

    sys.stdout.write(f"report id       : {built.report_id}\n")
    sys.stdout.write(f"identity digest : {built.identity_digest}\n")
    sys.stdout.write(f"deterministic   : {'yes' if built.deterministic else 'no'}\n")
    sys.stdout.write(f"written         : {json_path}\n")
    sys.stdout.write(f"                  {md_path}\n")
    return EXIT_OK


def cmd_schema(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root)
    if args.check:
        ok, problems = check_schemas(repo_root)
        for problem in problems:
            sys.stderr.write(f"{problem}\n")
        if ok:
            sys.stdout.write("exported JSON Schema matches the contract models\n")
        return EXIT_OK if ok else EXIT_VALIDATION_FAILED

    written = export_schemas(repo_root)
    for path in written:
        sys.stdout.write(f"wrote {path}\n")
    return EXIT_OK


def cmd_fixtures(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root)
    if args.write:
        hashes = compute_fixture_hashes(repo_root)
        lock = fixture_lock_path(repo_root)
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(format_lock(hashes), encoding="utf-8", newline="\n")
        sys.stdout.write(f"wrote {lock} ({len(hashes)} fixture(s))\n")
        return EXIT_OK

    ok, problems = verify_fixtures(repo_root)
    for problem in problems:
        sys.stderr.write(f"{problem}\n")
    if ok:
        sys.stdout.write("all committed fixtures match their recorded hashes\n")
    return EXIT_OK if ok else EXIT_VALIDATION_FAILED


def cmd_licence(args: argparse.Namespace) -> int:
    """Show the register, or gate it against a purpose."""
    repo_root = Path(args.repo_root)
    register = load_register(register_path(repo_root))
    purpose = RunPurpose(args.purpose)

    if args.action == "list":
        sys.stdout.write(f"{register.document.name} - {len(register)} component(s)\n\n")
        header = f"{'component':<24} {'kind':<11} {'declared':<16} {'effective':<16} flags"
        sys.stdout.write(header + "\n" + "-" * len(header) + "\n")
        for component in register.components():
            effective = register.effective_disposition(component.component_id)
            flags = []
            if component.reference_only:
                flags.append("reference-only")
            gaps = component.supply_chain_gaps()
            if gaps:
                flags.append(f"gate-B:{len(gaps)} gap(s)")
            sys.stdout.write(
                f"{component.component_id:<24} {component.kind.value:<11} "
                f"{component.disposition.value:<16} {effective.value:<16} "
                f"{', '.join(flags) or '-'}\n"
            )
        return EXIT_OK

    # The "check" action: apply the gates for the requested purpose.
    requested = tuple(args.component) if args.component else register.ids()
    blocked: list[str] = []

    sys.stdout.write(f"purpose: {purpose.value}\n\n")
    for component_id in requested:
        decision = register.evaluate(component_id, purpose)
        status = "PERMITTED" if decision.permitted else "BLOCKED"
        sys.stdout.write(
            f"{component_id:<24} {status:<10} {decision.effective_disposition.value:<16} "
            f"[{', '.join(decision.markings) or '-'}]\n"
        )
        if not decision.permitted:
            blocked.append(component_id)
            for item in decision.failures:
                sys.stdout.write(f"    [{item.code.value}] {item.message}\n")
        for item in decision.warnings:
            sys.stdout.write(f"    WARNING [{item.code.value}] {item.message}\n")

    fallback_gaps = register.missing_approved_fallbacks(ADVERTISED_OPERATIONS)
    if fallback_gaps:
        sys.stdout.write(f"\nD-040: {len(fallback_gaps)} operation(s) have no approved fallback\n")
        for gap in fallback_gaps:
            sys.stdout.write(f"    {gap.message}\n")

    sys.stdout.write(f"\n{len(blocked)} of {len(requested)} component(s) blocked\n")
    return EXIT_VALIDATION_FAILED if blocked else EXIT_OK


def cmd_inspect(args: argparse.Namespace) -> int:
    """Inspect real files: signature, header, limits and handling class.

    Parses headers only. No pixel buffer is allocated, so an oversized or
    malicious image is refused before it can consume memory.
    """
    policy = DEFAULT_SAFETY_POLICY
    if args.max_pixels is not None:
        policy = policy.model_copy(
            update={
                "standard_max_pixels": args.max_pixels,
                "professional_max_pixels": args.max_pixels,
                "extreme_max_pixels": args.max_pixels,
            }
        )

    invalid = 0
    for raw_path in args.path:
        path = Path(raw_path)
        if not path.is_file():
            sys.stderr.write(f"not a file: {raw_path}\n")
            invalid += 1
            continue

        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        ref = InputRef(
            asset_id="cli-inspection",
            expected_sha256=digest,
            path=path,
            declared_bytes=path.stat().st_size,
        )
        result = inspect_input(ref, policy=policy)

        if args.format == "json":
            sys.stdout.write(
                json.dumps(
                    result.model_dump(mode="json"),
                    indent=2,
                    sort_keys=True,
                    ensure_ascii=False,
                )
                + "\n"
            )
        else:
            _print_inspection(path.name, result)

        if not result.accepted:
            invalid += 1

    return EXIT_VALIDATION_FAILED if invalid else EXIT_OK


def cmd_ai_baseline(args: argparse.Namespace) -> int:
    """Run the AI adapter and a deterministic resize over the same manifest.

    POC-006 acceptance: results must be compared against a deterministic resize,
    not only against the original.

    torch is imported here rather than at module scope for two reasons: importing
    it costs seconds that `bench validate-manifest` should never pay, and the CLI
    must stay usable on a host where the inference runtime was never installed.
    """
    from ipw.benchmark_runner.comparison import build_comparison, write_comparison

    policy = load_policy(args.policy)
    asset_root = Path(args.asset_root)
    manifest_path = Path(args.manifest)
    report, manifest = validate_manifest_file(manifest_path, policy=policy, asset_root=asset_root)
    if manifest is None or not report.ok:
        sys.stderr.write("manifest validation failed; no comparison was generated\n")
        _print_validation_text(report, sys.stderr)
        return EXIT_VALIDATION_FAILED

    try:
        from ipw.processors.ai_adapters import RealEsrganAdapter
        from ipw.processors.ai_adapters.accelerator import probe_accelerator
    except ImportError as exc:
        sys.stderr.write(
            f"the inference runtime is not available on this host: {exc}\n"
            "Install it, or run this command in the container defined under infra/docker.\n"
        )
        return EXIT_INTERNAL_ERROR

    from ipw.processors.standard import pillow_processor

    adapter = RealEsrganAdapter(scale=args.scale)
    if not adapter.available():
        sys.stderr.write(
            f"pinned weights for x{args.scale} are not installed.\n"
            "Run: python tools/install_model_weights.py\n"
        )
        return EXIT_INTERNAL_ERROR

    register_file = register_path(asset_root)
    register = load_register(register_file) if register_file.is_file() else None

    # Never the deterministic clock here. A pinned clock makes every duration
    # read as zero, and this command exists to measure durations.
    ctx = RunContext.create(deterministic=False)

    comparison = build_comparison(
        ai_processor=adapter,
        control_processor=pillow_processor(),
        manifest=manifest,
        # The content-addressed manifest id, not a raw file digest: the run identity
        # must survive reformatting of the JSON that produced it.
        manifest_digest=manifest_id_of(json.loads(manifest_path.read_text(encoding="utf-8"))),
        policy=policy,
        asset_root=asset_root,
        ctx=ctx,
        scale=args.scale,
        purpose=RunPurpose(args.purpose),
        register=register,
        ai_component_ids=("real-esrgan",),
        control_component_ids=("standard-pillow",),
        accelerator=dict(vars(probe_accelerator())),
    )
    json_path, md_path = write_comparison(comparison, Path(args.out))

    sys.stdout.write(f"scale            : x{comparison.scale}\n")
    sys.stdout.write(f"ai run           : {comparison.ai_run.run_id}\n")
    sys.stdout.write(f"control run      : {comparison.control_run.run_id}\n")
    standing = "eligible" if comparison.eligible_for_commercial_recommendation else "NOT ELIGIBLE"
    sys.stdout.write(f"commercial use   : {standing}\n")
    for row in comparison.rows:
        slower = f"{row.slowdown:.0f}x slower" if row.slowdown else "not comparable"
        sys.stdout.write(f"  {row.asset_id:<32} {row.state:<10} {slower}\n")
    sys.stdout.write(f"written          : {json_path}\n")
    sys.stdout.write(f"                   {md_path}\n")
    return EXIT_OK


def cmd_compare_models(args: argparse.Namespace) -> int:
    """Run every available candidate on one operation and report them side by side.

    POC-007 acceptance: a runtime and quality comparison against Real-ESRGAN and
    the deterministic baseline, with no winner declared from objective metrics.

    The adapters are imported lazily so that `bench validate-manifest` never pays
    for a torch import and the CLI stays usable where the runtime is absent.
    """
    from ipw.benchmark_runner.model_comparison import (
        Candidate,
        build_model_comparison,
        write_model_comparison,
    )
    from ipw.contracts.operation import (
        AiDenoiseSettings,
        DenoiseSettings,
        JpegArtifactRepairSettings,
        Operation,
        ProcessingRoute,
        ProcessingVariant,
        ResizeSettings,
        SuperResolutionSettings,
    )

    policy = load_policy(args.policy)
    asset_root = Path(args.asset_root)
    manifest_path = Path(args.manifest)
    report, manifest = validate_manifest_file(manifest_path, policy=policy, asset_root=asset_root)
    if manifest is None or not report.ok:
        sys.stderr.write("manifest validation failed; no comparison was generated\n")
        _print_validation_text(report, sys.stderr)
        return EXIT_VALIDATION_FAILED

    try:
        from ipw.processors.ai_adapters import RealEsrganAdapter, SwinIrAdapter
        from ipw.processors.ai_adapters.accelerator import probe_accelerator
    except ImportError as exc:
        sys.stderr.write(
            f"the inference runtime is not available on this host: {exc}\n"
            "Install it, or run inside the container defined under infra/docker.\n"
        )
        return EXIT_INTERNAL_ERROR

    from ipw.processors.standard import pillow_processor

    candidates: list[Candidate] = []

    if args.operation == "super_resolution":
        scale = args.scale
        control_settings = ResizeSettings(
            algorithm="lanczos", scale_numerator=scale, scale_denominator=1
        )
        candidates.append(
            Candidate(
                label="deterministic-lanczos",
                processor=pillow_processor(),
                operation=Operation.build(
                    control_settings,
                    ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
                    route=ProcessingRoute.CLOUD_CPU,
                ),
                component_ids=("standard-pillow",),
                is_control=True,
                note="the cheap alternative every model has to beat",
            )
        )
        ai_operation = Operation.build(
            SuperResolutionSettings(scale=scale, mode="natural"),
            ProcessingVariant.AI_NATURAL,
            route=ProcessingRoute.CLOUD_CPU,
        )
        candidates.append(
            Candidate(
                label="real-esrgan",
                processor=RealEsrganAdapter(scale=scale),
                operation=ai_operation,
                component_ids=("real-esrgan",),
            )
        )
        candidates.append(
            Candidate(
                label="swinir",
                processor=SwinIrAdapter(variant_key=f"sr-x{scale}"),
                operation=ai_operation,
                component_ids=("swinir",),
            )
        )

    elif args.operation == "ai_denoise":
        # The deterministic control for AI denoise is the median filter the
        # standard pipeline already ships - the alternative a customer gets today.
        candidates.append(
            Candidate(
                label="deterministic-median",
                processor=pillow_processor(),
                operation=Operation.build(
                    DenoiseSettings(strength_percent=30),
                    ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE,
                    route=ProcessingRoute.CLOUD_CPU,
                ),
                component_ids=("standard-pillow",),
                is_control=True,
                note="median filter: cannot invent detail, and cannot remove much either",
            )
        )
        candidates.append(
            Candidate(
                label="swinir",
                processor=SwinIrAdapter(variant_key="denoise-15"),
                operation=Operation.build(
                    AiDenoiseSettings(noise_sigma=15),
                    ProcessingVariant.AI_NATURAL,
                    route=ProcessingRoute.CLOUD_CPU,
                ),
                component_ids=("swinir",),
            )
        )

    else:  # jpeg_artifact_repair
        candidates.append(
            Candidate(
                label="swinir",
                processor=SwinIrAdapter(variant_key="jpeg-10"),
                operation=Operation.build(
                    JpegArtifactRepairSettings(quality_target=10),
                    ProcessingVariant.AI_TASK_SPECIFIC,
                    route=ProcessingRoute.CLOUD_CPU,
                ),
                component_ids=("swinir",),
            )
        )

    available = [c for c in candidates if getattr(c.processor, "available", lambda: True)()]
    dropped = [c.label for c in candidates if c not in available]
    for label in dropped:
        sys.stdout.write(f"skipping {label}: not available on this host\n")
    if not available:
        sys.stderr.write("no candidate is available on this host\n")
        return EXIT_INTERNAL_ERROR

    register_file = register_path(asset_root)
    register = load_register(register_file) if register_file.is_file() else None

    # Never the deterministic clock: this command exists to measure durations.
    ctx = RunContext.create(deterministic=False)
    out_dir = Path(args.out)

    comparison = build_model_comparison(
        candidates=tuple(available),
        manifest=manifest,
        manifest_digest=manifest_id_of(json.loads(manifest_path.read_text(encoding="utf-8"))),
        policy=policy,
        asset_root=asset_root,
        ctx=ctx,
        purpose=RunPurpose(args.purpose),
        register=register,
        output_root=out_dir / "outputs",
        accelerator=dict(vars(probe_accelerator())),
    )
    json_path, md_path = write_model_comparison(comparison, out_dir)

    sys.stdout.write(f"operation        : {comparison.operation_kind}\n")
    for label in comparison.labels:
        standing = comparison.standing.get(label, {})
        eligible = standing.get("eligible_for_commercial_recommendation")
        sys.stdout.write(
            f"  {label:<24} {standing.get('effective_disposition', '-'):<16} "
            f"commercial: {'eligible' if eligible else 'NOT ELIGIBLE'}\n"
        )
    sys.stdout.write("no winner is declared; see POC-008 for the quality decision\n")
    sys.stdout.write(f"written          : {json_path}\n")
    sys.stdout.write(f"                   {md_path}\n")
    return EXIT_OK


def cmd_review_build(args: argparse.Namespace) -> int:
    """Build a blinded review package from a model-comparison output directory.

    Reads the comparison document written by `compare-models`, which already holds
    each candidate's provenance and licence standing, and turns its retained
    outputs into a package a reviewer can open plus a sealed key they cannot.

    The sealed key is written OUTSIDE the package directory, and the command
    refuses to put it inside. Blinding that depends on someone not opening the
    wrong file in the same folder is not blinding.
    """
    from ipw.benchmark_runner.model_comparison import COMPARISON_JSON_NAME
    from ipw.benchmark_runner.review import (
        Submission,
        build_review_package,
        write_review_package,
    )
    from ipw.contracts.asset import AssetCategory
    from ipw.contracts.operation import OperationKind

    # Checked before anything is read or written. A layout that would unblind
    # every future review is refused on the argument itself, not on the outcome:
    # a key that was written and then moved has already been in the package
    # directory, and "it was only there for a moment" is not a property anyone
    # can verify afterwards.
    out_dir = Path(args.out).resolve()
    key_path = Path(args.sealed_key).resolve()
    if key_path == out_dir or out_dir in key_path.parents:
        sys.stderr.write(
            f"refusing to write the sealed key inside the review package.\n"
            f"  package: {out_dir}\n  key:     {key_path}\n"
            "The key names every item's producer; a reviewer who opens it is no longer "
            "blinded. Choose a path outside the package directory.\n"
        )
        return EXIT_INTERNAL_ERROR

    comparison_dir = Path(args.comparison)
    document_path = comparison_dir / COMPARISON_JSON_NAME
    if not document_path.is_file():
        sys.stderr.write(
            f"no comparison document at {document_path}.\n"
            "Run `bench compare-models --out <dir>` first.\n"
        )
        return EXIT_INTERNAL_ERROR

    document = json.loads(document_path.read_text(encoding="utf-8"))
    operation = OperationKind(document["operation"])
    standing = document.get("licence_standing", {})

    submissions: list[Submission] = []
    for outcome in document["outcomes"]:
        if outcome["state"] != "succeeded" or not outcome.get("sha256"):
            continue
        label = outcome["label"]
        image = comparison_dir / "outputs" / label / f"{outcome['asset_id']}.png"
        if not image.is_file():
            sys.stderr.write(f"skipping {label}/{outcome['asset_id']}: output not retained\n")
            continue
        info = standing.get(label, {})
        submissions.append(
            Submission(
                output_path=image,
                output_sha256=outcome["sha256"],
                result_id=outcome["result_id"],
                run_id=outcome["run_id"],
                asset_id=outcome["asset_id"],
                processor_name=outcome["processor_name"],
                processor_version=outcome["processor_version"],
                weights_sha256=outcome.get("weights_sha256"),
                operation=operation,
                category=AssetCategory.SYNTHETIC_FIXTURE,
                licence_ref=(info.get("component_ids") or [None])[0],
                effective_disposition=info.get("effective_disposition", "unknown"),
                eligible_for_commercial_recommendation=bool(
                    info.get("eligible_for_commercial_recommendation")
                ),
                is_control=bool(outcome.get("is_control")),
            )
        )

    if not submissions:
        sys.stderr.write("no retained outputs to review\n")
        return EXIT_INTERNAL_ERROR

    dimensions = tuple(
        ReviewDimension(name) for name in (args.dimension or DEFAULT_REVIEW_DIMENSIONS)
    )
    ctx = RunContext.create(deterministic=args.deterministic)
    seed = args.seed or f"seed-{ctx.clock.now().isoformat()}"

    package, key = build_review_package(
        submissions=tuple(submissions),
        operation=operation,
        dimensions=dimensions,
        seed=seed,
        created_at=ctx.clock.now().isoformat(),
        output_dir=out_dir,
    )
    package_path, key_written, sheet_path = write_review_package(package, key, out_dir, key_path)

    sys.stdout.write(f"package id       : {package.package_id}\n")
    sys.stdout.write(f"items            : {len(package.items)}\n")
    sys.stdout.write(f"dimensions       : {', '.join(d.value for d in dimensions)}\n")
    sys.stdout.write(f"reviewer opens   : {sheet_path}\n")
    sys.stdout.write(f"                   {package_path}\n")
    sys.stdout.write(f"SEALED, keep away: {key_written}\n")
    if not args.seed:
        sys.stdout.write(
            f"shuffle seed     : {seed}\n"
            "                   (generated; pass --seed to reproduce this package)\n"
        )
    return EXIT_OK


def cmd_review_aggregate(args: argparse.Namespace) -> int:
    """Aggregate reviewer scores into verdicts, and optionally attribute them."""
    from ipw.benchmark_runner.review import (
        SUMMARY_FILE,
        aggregate_reviews,
        attribute,
        load_scores,
    )
    from ipw.contracts.review import ReviewPackage, SealedKey

    package = ReviewPackage.model_validate_json(Path(args.package).read_text(encoding="utf-8"))
    scores = load_scores(Path(args.scores))
    summary = aggregate_reviews(package, scores)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = out_dir / SUMMARY_FILE
    summary_path.write_text(
        json.dumps(summary.model_dump(mode="json"), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    sys.stdout.write(f"package          : {summary.package_id}\n")
    sys.stdout.write(f"items scored     : {len(summary.verdicts)}\n")
    if summary.unscored_labels:
        sys.stdout.write(f"NOT SCORED       : {', '.join(summary.unscored_labels)}\n")
    if summary.unknown_labels:
        sys.stdout.write(f"UNKNOWN LABELS   : {', '.join(summary.unknown_labels)}\n")
    if summary.failed_labels:
        sys.stdout.write(f"CRITICAL FAILURE : {', '.join(summary.failed_labels)}\n")
    if summary.labels_needing_a_third_review:
        sys.stdout.write(f"needs 3rd review : {', '.join(summary.labels_needing_a_third_review)}\n")

    if args.sealed_key:
        key = SealedKey.model_validate_json(Path(args.sealed_key).read_text(encoding="utf-8"))
        attributed = attribute(summary, key)
        attribution_path = out_dir / "review-attribution.json"
        attribution_path.write_text(
            json.dumps(
                {name: record.as_document() for name, record in attributed.items()},
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        sys.stdout.write("\nattributed (sealed key opened):\n")
        for name, record in sorted(attributed.items()):
            standing = (
                "eligible" if record.eligible_for_commercial_recommendation else "NOT ELIGIBLE"
            )
            sys.stdout.write(
                f"  {name:<24} items={len(record.items)} "
                f"critical_failures={len(record.failed_items)} "
                f"commercial={standing}\n"
            )
        sys.stdout.write(f"written          : {attribution_path}\n")

    sys.stdout.write(f"written          : {summary_path}\n")
    return EXIT_OK


def cmd_batch(args: argparse.Namespace) -> int:
    """Run a manifest as a durable batch, or resume one that was interrupted.

    The journal is the run. Every item is committed to disk as it completes, so
    killing this process loses at most the item in flight - and `--resume` picks
    up from what is on disk rather than starting again.
    """
    from ipw.benchmark_runner.batch import JOURNAL_NAME, execute_batch, resume_batch
    from ipw.benchmark_runner.orchestrator import RunPlan
    from ipw.contracts.operation import NoopSettings, Operation, ProcessingVariant
    from ipw.processors.standard import pillow_processor

    policy = load_policy(args.policy)
    asset_root = Path(args.asset_root)
    manifest_path = Path(args.manifest)
    report, manifest = validate_manifest_file(manifest_path, policy=policy, asset_root=asset_root)
    if manifest is None or not report.ok:
        sys.stderr.write("manifest validation failed; no batch was started\n")
        _print_validation_text(report, sys.stderr)
        return EXIT_VALIDATION_FAILED

    register_file = register_path(asset_root)
    register = load_register(register_file) if register_file.is_file() else None

    plan = RunPlan.create(
        processor=pillow_processor(),
        manifest=manifest,
        operation=Operation.build(NoopSettings(), ProcessingVariant.ORIGINAL_CONTROL),
        policy=policy,
        asset_root=asset_root,
        manifest_digest=manifest_id_of(json.loads(manifest_path.read_text(encoding="utf-8"))),
        purpose=RunPurpose(args.purpose),
        component_ids=("standard-pillow",),
        register=register,
        run_label="batch",
    )

    out_dir = Path(args.out)
    journal_path = out_dir / JOURNAL_NAME
    ctx = RunContext.create(deterministic=args.deterministic)

    runner = resume_batch if args.resume else execute_batch
    outcome = runner(plan, ctx, journal_path)

    summary = outcome.run.summary
    sys.stdout.write(f"run id           : {outcome.run.run_id}\n")
    sys.stdout.write(f"journal          : {outcome.journal_path}\n")
    sys.stdout.write(f"processed now    : {outcome.processed}\n")
    if outcome.was_resumed:
        sys.stdout.write(f"reused from disk : {outcome.reused_from_journal}\n")
    sys.stdout.write(
        f"totals           : {summary.total} total, {summary.succeeded} succeeded, "
        f"{summary.failed} failed, {summary.skipped} skipped\n"
    )
    return EXIT_OK


def cmd_batch_status(args: argparse.Namespace) -> int:
    """Report what a journal holds, without running anything.

    The point of a durable batch is that its state can be inspected by a process
    that did not start it - so this reads the journal and nothing else.
    """
    from ipw.benchmark_runner.batch import read_journal

    journal_path = Path(args.journal)
    journal = read_journal(journal_path)

    if not journal.results and not journal.run_id:
        sys.stderr.write(f"no batch journal at {journal_path}\n")
        return EXIT_INTERNAL_ERROR

    states: dict[str, int] = {}
    for result in journal.results.values():
        states[result.state.value] = states.get(result.state.value, 0) + 1

    sys.stdout.write(f"run id           : {journal.run_id or '-'}\n")
    sys.stdout.write(f"started at       : {journal.started_at or '-'}\n")
    sys.stdout.write(f"complete         : {'yes' if journal.complete else 'NO - interrupted'}\n")
    sys.stdout.write(f"items recorded   : {len(journal.results)}\n")
    for state, count in sorted(states.items()):
        sys.stdout.write(f"  {state:<14} {count}\n")
    if journal.truncated_records:
        sys.stdout.write(
            f"truncated records: {journal.truncated_records} "
            "(a process died mid-write; those items will be reprocessed on resume)\n"
        )
    if not journal.complete:
        sys.stdout.write("\nResume with: bench batch --resume ...\n")
    return EXIT_OK


def cmd_version(_: argparse.Namespace) -> int:
    sys.stdout.write(f"ipw-benchmark-runner   {TOOL_VERSION}\n")
    sys.stdout.write(f"benchmark contract     {SCHEMA_VERSION}\n")
    sys.stdout.write(f"repository root        {find_repo_root()}\n")
    return EXIT_OK


# -------------------------------------------------------------------- parser --


def build_parser() -> argparse.ArgumentParser:
    repo_root = default_repo_root()

    parser = argparse.ArgumentParser(
        prog="bench",
        description="Benchmark foundation for the Image & PDF Workspace technical POC. "
        "Validates manifests and generates reports. It integrates no model, no weights "
        "and no external provider.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser(
        "validate-manifest",
        help="validate an asset manifest without processing or decoding any image",
    )
    validate.add_argument("manifest", help="path to the manifest JSON document")
    validate.add_argument(
        "--format", choices=("text", "json"), default="text", help="output format"
    )
    validate.add_argument("--policy", type=Path, default=None, help="validation policy JSON file")
    validate.add_argument(
        "--asset-root",
        default=str(repo_root),
        help="root that manifest relative paths resolve inside (default: repository root)",
    )
    validate.add_argument(
        "--no-verify-hashes",
        action="store_true",
        help="skip SHA-256 and size verification of locally stored assets",
    )
    validate.set_defaults(func=cmd_validate_manifest)

    report = subparsers.add_parser(
        "report", help="generate an example report from validated manifest metadata"
    )
    report.add_argument("--manifest", required=True, help="path to the manifest JSON document")
    report.add_argument("--out", required=True, help="output directory")
    report.add_argument("--policy", type=Path, default=None, help="validation policy JSON file")
    report.add_argument("--asset-root", default=str(repo_root), help="asset resolution root")
    report.add_argument(
        "--purpose",
        choices=[p.value for p in RunPurpose],
        default=RunPurpose.INTERNAL_BENCHMARK.value,
        help="purpose the licence gates are evaluated against (D-038)",
    )
    report.add_argument(
        "--deterministic",
        action="store_true",
        help="pin the clock and omit the observed environment so output is byte-reproducible",
    )
    report.set_defaults(func=cmd_report)

    schema = subparsers.add_parser("schema", help="export or check the JSON Schema artifacts")
    schema.add_argument(
        "action", choices=("export",), help="only 'export' is supported; add --check to verify"
    )
    schema.add_argument(
        "--check",
        action="store_true",
        help="verify the committed schema files match the models instead of writing them",
    )
    schema.add_argument("--repo-root", default=str(repo_root), help="repository root")
    schema.set_defaults(func=cmd_schema)

    fixtures = subparsers.add_parser("fixtures", help="verify or rewrite the fixture hash lock")
    fixtures.add_argument("action", choices=("verify",), help="only 'verify' is supported")
    fixtures.add_argument(
        "--write", action="store_true", help="rewrite the lock from the fixtures on disk"
    )
    fixtures.add_argument("--repo-root", default=str(repo_root), help="repository root")
    fixtures.set_defaults(func=cmd_fixtures)

    licence = subparsers.add_parser(
        "licence", help="inspect the licence register or gate it against a run purpose"
    )
    licence.add_argument("action", choices=("list", "check"))
    licence.add_argument(
        "--purpose",
        choices=[p.value for p in RunPurpose],
        default=RunPurpose.INTERNAL_BENCHMARK.value,
        help="what the run is for; gates bind to this (D-038)",
    )
    licence.add_argument(
        "--component", action="append", help="limit the check to this component (repeatable)"
    )
    licence.add_argument("--repo-root", default=str(repo_root), help="repository root")
    licence.set_defaults(func=cmd_licence)

    inspect = subparsers.add_parser(
        "inspect",
        help="inspect real image files: signature, header, limits and handling class",
    )
    inspect.add_argument("path", nargs="+", help="file(s) to inspect")
    inspect.add_argument("--format", choices=("text", "json"), default="text", help="output format")
    inspect.add_argument(
        "--max-pixels",
        type=int,
        default=None,
        help="override every pixel ceiling, to demonstrate the limit is configurable",
    )
    inspect.set_defaults(func=cmd_inspect)

    ai_baseline = subparsers.add_parser(
        "ai-baseline",
        help="compare the AI adapter against a deterministic resize over one manifest",
    )
    ai_baseline.add_argument("--manifest", required=True, help="path to the manifest document")
    ai_baseline.add_argument("--out", required=True, help="output directory")
    ai_baseline.add_argument(
        "--scale", type=int, default=4, choices=(2, 4), help="native model scale to run"
    )
    ai_baseline.add_argument("--policy", type=Path, default=None, help="validation policy file")
    ai_baseline.add_argument("--asset-root", default=str(repo_root), help="asset resolution root")
    ai_baseline.add_argument(
        "--purpose",
        choices=[p.value for p in RunPurpose],
        default=RunPurpose.INTERNAL_BENCHMARK.value,
        help="purpose the licence gates are evaluated against (D-038)",
    )
    ai_baseline.set_defaults(func=cmd_ai_baseline)

    compare = subparsers.add_parser(
        "compare-models",
        help="compare every available model against the deterministic baseline",
    )
    compare.add_argument("--manifest", required=True, help="path to the manifest document")
    compare.add_argument("--out", required=True, help="output directory")
    compare.add_argument(
        "--operation",
        choices=("super_resolution", "ai_denoise", "jpeg_artifact_repair"),
        default="super_resolution",
        help="which operation to compare the candidates on",
    )
    compare.add_argument(
        "--scale", type=int, default=4, choices=(2, 4), help="scale, for super_resolution"
    )
    compare.add_argument("--policy", type=Path, default=None, help="validation policy file")
    compare.add_argument("--asset-root", default=str(repo_root), help="asset resolution root")
    compare.add_argument(
        "--purpose",
        choices=[p.value for p in RunPurpose],
        default=RunPurpose.INTERNAL_BENCHMARK.value,
        help="purpose the licence gates are evaluated against (D-038)",
    )
    compare.set_defaults(func=cmd_compare_models)

    review_build = subparsers.add_parser(
        "review-build",
        help="build a blinded review package from a model comparison",
    )
    review_build.add_argument(
        "--comparison", required=True, help="directory written by compare-models"
    )
    review_build.add_argument("--out", required=True, help="review package directory")
    review_build.add_argument(
        "--sealed-key",
        required=True,
        help="where to write the sealed key. Must be OUTSIDE the package directory.",
    )
    review_build.add_argument(
        "--dimension",
        action="append",
        default=None,
        choices=[d.value for d in ReviewDimension],
        help="a dimension to score (repeatable). Defaults to the four that apply to "
        "every operation.",
    )
    review_build.add_argument(
        "--seed", default=None, help="shuffle seed; generated from the clock if omitted"
    )
    review_build.add_argument(
        "--deterministic",
        action="store_true",
        help="pin the clock, for reproducing a package exactly",
    )
    review_build.set_defaults(func=cmd_review_build)

    review_aggregate = subparsers.add_parser(
        "review-aggregate", help="aggregate reviewer scores into verdicts"
    )
    review_aggregate.add_argument("--package", required=True, help="review-package.json")
    review_aggregate.add_argument("--scores", required=True, help="scores JSON file")
    review_aggregate.add_argument("--out", required=True, help="output directory")
    review_aggregate.add_argument(
        "--sealed-key",
        default=None,
        help="open the sealed key and attribute verdicts to producers. Only after "
        "scoring is complete.",
    )
    review_aggregate.set_defaults(func=cmd_review_aggregate)

    batch = subparsers.add_parser("batch", help="run a manifest as a durable, resumable batch")
    batch.add_argument("--manifest", required=True, help="path to the manifest document")
    batch.add_argument("--out", required=True, help="directory holding the run journal")
    batch.add_argument(
        "--resume",
        action="store_true",
        help="continue from the journal, processing only what has not settled",
    )
    batch.add_argument("--policy", type=Path, default=None, help="validation policy file")
    batch.add_argument("--asset-root", default=str(repo_root), help="asset resolution root")
    batch.add_argument(
        "--purpose",
        choices=[p.value for p in RunPurpose],
        default=RunPurpose.INTERNAL_BENCHMARK.value,
        help="purpose the licence gates are evaluated against (D-038)",
    )
    batch.add_argument(
        "--deterministic", action="store_true", help="pin the clock for reproducible output"
    )
    batch.set_defaults(func=cmd_batch)

    batch_status = subparsers.add_parser(
        "batch-status", help="report what a batch journal holds, without running anything"
    )
    batch_status.add_argument("--journal", required=True, help="path to run-journal.jsonl")
    batch_status.set_defaults(func=cmd_batch_status)

    version = subparsers.add_parser("version", help="print tool and contract versions")
    version.set_defaults(func=cmd_version)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result: int = args.func(args)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"error: {type(exc).__name__}: {exc}\n")
        return EXIT_INTERNAL_ERROR
    return result


if __name__ == "__main__":  # pragma: no cover - exercised through __main__.py
    raise SystemExit(main())
