"""Ask the inference runtime what hardware it can actually see.

POC-006 requires cold/warm timing, **RAM/VRAM** and output metrics. There is no
GPU on the development machine, so every VRAM figure here is empty - but empty
because the runtime was asked and answered "none", not because a constant was
typed into a field. The difference matters the first time this runs on a GPU
host: a hardcoded ``None`` would keep reporting no VRAM while the model happily
consumed several gigabytes of it, and nobody would notice until a capacity plan
was built on the wrong number.

This module lives in the AI adapter package because it is the only place allowed
to import torch (asserted by ``tests/test_scope_and_artifacts.py``). The
benchmark runner consumes the result as plain data, so the standard baseline
never acquires a tensor runtime just to describe its environment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = ["AcceleratorInfo", "peak_vram_bytes", "probe_accelerator", "reset_peak_vram"]


@dataclass(frozen=True)
class AcceleratorInfo:
    """What the runtime reports about the available accelerator."""

    available: bool
    backend: str
    device_name: str | None = None
    total_vram_bytes: int | None = None
    driver_version: str | None = None
    device_count: int = 0
    notes: str = ""


def _torch() -> Any | None:
    try:
        import torch
    except ImportError:
        return None
    return torch


def probe_accelerator() -> AcceleratorInfo:
    """Describe the accelerator, or say plainly that there is none."""
    torch = _torch()
    if torch is None:
        return AcceleratorInfo(
            available=False,
            backend="none",
            notes="the inference runtime is not installed on this host",
        )

    if torch.cuda.is_available():
        index = torch.cuda.current_device()
        properties = torch.cuda.get_device_properties(index)
        return AcceleratorInfo(
            available=True,
            backend="cuda",
            device_name=torch.cuda.get_device_name(index),
            total_vram_bytes=int(properties.total_memory),
            driver_version=torch.version.cuda,
            device_count=torch.cuda.device_count(),
            notes=(
                "CUDA build. The bundled NVIDIA runtime libraries carry their own licence "
                "terms and require a disposition record before any run beyond local "
                "research (see the torch entry in data/licences/register.json)."
            ),
        )

    backend = getattr(torch.backends, "mps", None)
    if backend is not None and backend.is_available():
        return AcceleratorInfo(
            available=True,
            backend="mps",
            device_name="Apple Metal",
            notes="Metal reports no total-VRAM figure; memory is shared with the host.",
        )

    return AcceleratorInfo(
        available=False,
        backend="cpu",
        notes=(
            f"torch {torch.__version__} sees no accelerator; inference runs on "
            f"{torch.get_num_threads()} CPU threads."
        ),
    )


def reset_peak_vram() -> None:
    """Clear the runtime's peak-VRAM counter before a measured call."""
    torch = _torch()
    if torch is not None and torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def peak_vram_bytes() -> int | None:
    """Peak VRAM since the last reset, or ``None`` when there is no accelerator.

    ``None`` means "not measurable here" and must never be rendered as zero; a
    zero would claim the model used no video memory, which is a different and
    much more flattering statement.
    """
    torch = _torch()
    if torch is None or not torch.cuda.is_available():
        return None
    return int(torch.cuda.max_memory_allocated())
