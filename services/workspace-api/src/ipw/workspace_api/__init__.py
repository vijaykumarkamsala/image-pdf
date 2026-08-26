"""The application service: the workspace UI talking to the real processors.

Everything a customer sees goes through the same processors the benchmark
measures. There is no second implementation of resize, and no app-only denoise -
which is what keeps every figure in ``data/reports`` a statement about the code
that actually runs.
"""

from __future__ import annotations

from ipw.workspace_api.catalogue import OPERATION_CATALOGUE, catalogue_document
from ipw.workspace_api.server import ProcessRequest, WorkspaceService, print_plan

__all__ = [
    "OPERATION_CATALOGUE",
    "ProcessRequest",
    "WorkspaceService",
    "catalogue_document",
    "print_plan",
]
