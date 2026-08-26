"""Processor adapters.

Every processor - standard, AI or external provider - implements the single
contract in :mod:`ipw.contracts.processor` and is wrapped by the guards in
:mod:`ipw.processors.base`. Benchmark orchestration never imports a
model-specific module.

``inspection/``   signature, header and safety inspection (POC-003)
``standard/``     deterministic server baselines (POC-004)
``ai_adapters/``  licence-approved, pinned model adapters (POC-006 onward)
``fake/``         non-production reference implementation and test double
"""

from __future__ import annotations

from ipw.processors.base import (
    guarded_estimate,
    guarded_inspect,
    guarded_process,
    guarded_supports,
)
from ipw.processors.inspection import inspect_input

__all__ = [
    "guarded_estimate",
    "guarded_inspect",
    "guarded_process",
    "guarded_supports",
    "inspect_input",
]
