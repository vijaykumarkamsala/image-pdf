"""Benchmark runner: validation, identifiers, reporting and orchestration.

Depends only on :mod:`ipw.contracts`. It never imports a model, an inference
runtime or a vendor SDK - all of those live behind adapters in
``packages/processors/ai_adapters/`` from POC-006 onward.
"""

from __future__ import annotations

from ipw.benchmark_runner.canonical import canonical_json, canonical_text
from ipw.benchmark_runner.conformance import assert_processor_conforms
from ipw.benchmark_runner.ids import digest_id, report_id_of, result_id_of, run_id_of
from ipw.benchmark_runner.orchestrator import Ledger, RunPlan, execute_run, retry_failed
from ipw.benchmark_runner.policy import DEFAULT_POLICY, ValidationPolicy
from ipw.benchmark_runner.report import build_report, render_markdown, write_report
from ipw.benchmark_runner.validation import ValidationReport, validate_manifest_file

__all__ = [
    "DEFAULT_POLICY",
    "Ledger",
    "RunPlan",
    "ValidationPolicy",
    "ValidationReport",
    "assert_processor_conforms",
    "build_report",
    "canonical_json",
    "canonical_text",
    "digest_id",
    "execute_run",
    "render_markdown",
    "report_id_of",
    "result_id_of",
    "retry_failed",
    "run_id_of",
    "validate_manifest_file",
    "write_report",
]
