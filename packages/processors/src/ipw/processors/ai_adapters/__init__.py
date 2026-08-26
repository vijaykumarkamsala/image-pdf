"""Licence-approved AI model adapters.

Every adapter here passes through the POC-002 gates before it can execute: a
recorded disposition with real evidence (Gate A), and a pinned version with a
verified weight digest and no inference-time network access (Gate B, D-039). The
Gate B controls themselves live in :mod:`~ipw.processors.ai_adapters.common`, in
one copy, so they cannot apply to one model and quietly not the other.

**Both candidates are permitted for research purposes only, and for the same
reason.** Real-ESRGAN states no weight licence at all; SwinIR's code chain is
genuinely clean (Apache-2.0 over MIT over MIT, with a patent grant). Neither
helps, because every published checkpoint of both is trained on DIV2K-derived
data, which its publisher releases for "academic research purpose only". Under
D-038 that permits ``local_research`` and ``internal_benchmark`` with results
marked, and blocks ``public_demo``, ``staging`` and ``production``.

That is the POC-007 finding stated plainly: **the restriction is upstream of the
model, so changing models does not change it.** The gates enforce this; it is not
a note anyone has to remember.

``standard`` operations never route here, and no face-restoration model exists in
this package or in the environment - see
:mod:`~ipw.processors.ai_adapters.rrdbnet` for why the official Real-ESRGAN
package is not used.
"""

from __future__ import annotations

from ipw.processors.ai_adapters.common import (
    WeightSpec,
    no_network,
)
from ipw.processors.ai_adapters.real_esrgan import (
    PINNED_WEIGHTS,
    RealEsrganAdapter,
)
from ipw.processors.ai_adapters.rrdbnet import RRDB, ResidualDenseBlock, RRDBNet, build_rrdbnet
from ipw.processors.ai_adapters.swinir import (
    SWINIR_VARIANTS,
    SwinIrAdapter,
    SwinIrVariant,
    variant_for,
)

__all__ = [
    "PINNED_WEIGHTS",
    "RRDB",
    "SWINIR_VARIANTS",
    "RRDBNet",
    "RealEsrganAdapter",
    "ResidualDenseBlock",
    "SwinIrAdapter",
    "SwinIrVariant",
    "WeightSpec",
    "build_rrdbnet",
    "no_network",
    "variant_for",
]
