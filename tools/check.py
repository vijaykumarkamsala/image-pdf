"""Run every quality gate with one command.

``make`` is not available on a stock Windows machine, so the task runner is a
stdlib Python script. It runs the same gates as CI, in the same order, and prints
a summary you can paste into a task report.

    python tools/check.py            # run everything
    python tools/check.py --fix      # auto-format, then run everything
    python tools/check.py --list     # show the gates without running them
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


@dataclass(frozen=True)
class Gate:
    name: str
    command: list[str]
    why: str


GATES: tuple[Gate, ...] = (
    Gate(
        "format",
        [PY, "-m", "ruff", "format", "--check", "."],
        "consistent formatting",
    ),
    Gate(
        "lint",
        [PY, "-m", "ruff", "check", "."],
        "correctness, security (S rules) and the determinism ban on ambient clock/random",
    ),
    Gate(
        "types",
        [PY, "-m", "mypy"],
        "the processor Protocol is enforced, not merely documented",
    ),
    Gate(
        "tests",
        [PY, "-m", "pytest"],
        "behaviour, contract conformance and coverage",
    ),
    Gate(
        "fixture-integrity",
        [PY, "-m", "ipw.benchmark_runner", "fixtures", "verify"],
        "originals are unchanged (D-006)",
    ),
    Gate(
        "fixture-reproducibility",
        [PY, "tools/make_fixtures.py", "--check"],
        "the committed fixture is regenerable byte-for-byte",
    ),
    Gate(
        "inspection-fixtures",
        [PY, "tools/make_inspection_fixtures.py", "--check"],
        "the POC-003 signature, bomb and orientation fixtures are byte-reproducible",
    ),
    Gate(
        "ts-contract-drift",
        [PY, "tools/generate_ts_contracts.py", "--check"],
        "the TypeScript contract still matches the JSON Schema",
    ),
    Gate(
        "canonical-vectors",
        [PY, "tools/make_canonical_vectors.py", "--check"],
        "the cross-language canonicalisation vectors are current",
    ),
    Gate(
        "ts-typecheck",
        ["npm", "run", "typecheck", "--silent"],
        "both TypeScript workspaces type-check under strict mode",
    ),
    Gate(
        "ts-tests",
        ["npm", "run", "test", "--silent"],
        "TypeScript agrees with Python on canonical form and identifiers",
    ),
    Gate(
        "goldens",
        [PY, "tools/make_goldens.py", "--check"],
        "POC-004 standard operations still produce byte-identical output (D-046)",
    ),
    Gate(
        "schema-drift",
        [PY, "-m", "ipw.benchmark_runner", "schema", "export", "--check"],
        "exported JSON Schema matches the contract models",
    ),
    Gate(
        "licence-register",
        [PY, "-m", "ipw.benchmark_runner", "licence", "list"],
        "the licence register loads and every disposition resolves",
    ),
    Gate(
        "model-weights",
        [PY, "tools/install_model_weights.py", "--verify"],
        "installed model weights still match their pinned digests (Gate B, D-039)",
    ),
    Gate(
        "example-manifest",
        [
            PY,
            "-m",
            "ipw.benchmark_runner",
            "validate-manifest",
            "data/manifests/example.manifest.json",
        ],
        "the example manifest validates",
    ),
)


def run_gate(gate: Gate, *, verbose: bool) -> tuple[bool, float]:
    started = time.perf_counter()
    # npm ships as a .cmd shim on Windows, which CreateProcess cannot exec
    # directly. Only those gates need a shell.
    needs_shell = gate.command[0] == "npm" and sys.platform == "win32"
    result = subprocess.run(
        subprocess.list2cmdline(gate.command) if needs_shell else gate.command,
        cwd=REPO_ROOT,
        capture_output=not verbose,
        text=True,
        check=False,
        shell=needs_shell,
    )
    elapsed = time.perf_counter() - started
    ok = result.returncode == 0
    if not ok and not verbose:
        sys.stdout.write(result.stdout or "")
        sys.stderr.write(result.stderr or "")
    return ok, elapsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run every POC quality gate.")
    parser.add_argument("--fix", action="store_true", help="run 'ruff format' before checking")
    parser.add_argument("--verbose", action="store_true", help="stream each gate's output")
    parser.add_argument("--list", action="store_true", help="list the gates and exit")
    args = parser.parse_args(argv)

    if args.list:
        for gate in GATES:
            sys.stdout.write(f"{gate.name:<24} {' '.join(gate.command[1:])}\n")
            sys.stdout.write(f"{'':<24} -> {gate.why}\n")
        return 0

    if args.fix:
        sys.stdout.write("== ruff format ==\n")
        subprocess.run([PY, "-m", "ruff", "format", "."], cwd=REPO_ROOT, check=False)
        subprocess.run([PY, "-m", "ruff", "check", "--fix", "."], cwd=REPO_ROOT, check=False)

    results: list[tuple[Gate, bool, float]] = []
    for gate in GATES:
        sys.stdout.write(f"== {gate.name} ==\n")
        sys.stdout.flush()
        ok, elapsed = run_gate(gate, verbose=args.verbose)
        results.append((gate, ok, elapsed))
        sys.stdout.write(f"   {'PASS' if ok else 'FAIL'} ({elapsed:.1f}s)\n")

    sys.stdout.write("\n" + "=" * 60 + "\n")
    for gate, ok, elapsed in results:
        sys.stdout.write(f"{'PASS' if ok else 'FAIL'}  {gate.name:<24} {elapsed:6.1f}s\n")
    failed = [gate.name for gate, ok, _ in results if not ok]
    sys.stdout.write("=" * 60 + "\n")

    if failed:
        sys.stdout.write(f"\n{len(failed)} gate(s) failed: {', '.join(failed)}\n")
        return 1
    sys.stdout.write(f"\nall {len(results)} gates passed\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
