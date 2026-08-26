"""Machinery every torch-backed adapter needs, extracted once.

POC-006 wrote this inline in the Real-ESRGAN adapter because there was one
adapter and no way to tell which parts were general. POC-007 added a second and
the answer became visible: weight pinning, digest verification, restricted
unpickling, the network guard and the tensor conversions are the same for any
model, while the architecture, its configuration and its tiling strategy are not.

The split matters beyond tidiness. These are the **Gate B controls** (D-039). One
copy that every adapter uses is a control; two copies that drift are a control
that silently stops applying to the newer model, which is precisely when nobody
is looking.
"""

from __future__ import annotations

import contextlib
import hashlib
import socket
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from torch import Tensor

__all__ = [
    "WeightSpec",
    "checkpoint_state_dict",
    "default_weights_dir",
    "from_tensor",
    "load_torch",
    "no_network",
    "to_tensor",
    "verify_weight_digest",
]


@dataclass(frozen=True)
class WeightSpec:
    """One pinned checkpoint: where it came from, and what it must hash to."""

    component_id: str
    filename: str
    release_tag: str
    sha256: str
    bytes_expected: int
    source_url: str


def load_torch() -> Any | None:
    """Import torch, or return None when the runtime is unavailable.

    Returning None rather than raising lets a host without the inference runtime
    still load the adapter, describe it, and report ``PROCESSOR.UNAVAILABLE``
    through the normal failure path - which is how a benchmark should behave when
    a candidate cannot execute somewhere.
    """
    try:
        import torch
    except ImportError:
        return None
    return torch


def default_weights_dir() -> Path:
    """The gitignored ``.tools/models`` directory beside ``workspaces.toml``."""
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "workspaces.toml").is_file():
            return candidate / ".tools" / "models"
    return Path(".tools/models")


@contextlib.contextmanager
def no_network() -> Iterator[None]:
    """Refuse network access for the duration of the block.

    Gate B: "network access disabled during inference unless explicitly
    required". Enforced by replacing the socket constructors rather than asserted
    in a comment - a model that attempted a connection here raises, which is the
    only way to know it never does.
    """
    originals = (socket.socket.connect, socket.socket.connect_ex, socket.create_connection)

    def blocked(*_args: object, **_kwargs: object) -> None:
        msg = "network access is disabled during inference (Gate B, D-039)"
        raise OSError(msg)

    socket.socket.connect = blocked  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked  # type: ignore[assignment]
    socket.create_connection = blocked  # type: ignore[assignment]
    try:
        yield
    finally:
        socket.socket.connect, socket.socket.connect_ex, socket.create_connection = originals  # type: ignore[method-assign]


def verify_weight_digest(path: Path, spec: WeightSpec) -> None:
    """Check size then digest, and refuse to go further on either mismatch.

    Size first because it is free and catches a truncated download before hashing
    a hundred megabytes. Digest second because it is the one that actually
    matters. Both raise, and the caller normalises the failure at the processor
    boundary.

    This runs **before** the file is opened by the unpickler. Verifying after
    loading would be verifying that the code which already ran was the code we
    expected, which is not a control.
    """
    actual_bytes = path.stat().st_size
    if actual_bytes != spec.bytes_expected:
        msg = (
            f"weight size mismatch for {spec.filename}: expected {spec.bytes_expected:,} "
            f"bytes, found {actual_bytes:,}. Refusing to load."
        )
        raise RuntimeError(msg)

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != spec.sha256:
        msg = (
            f"weight digest mismatch for {spec.filename}: expected {spec.sha256}, "
            f"found {actual}. Refusing to load."
        )
        raise RuntimeError(msg)


def checkpoint_state_dict(
    path: Path, preferred_keys: tuple[str, ...] = ("params_ema", "params")
) -> Any:
    """Load a ``.pth`` with unpickling restricted to tensors, and unwrap it.

    ``weights_only=True`` is the whole point. A ``.pth`` is a Python pickle, and
    unrestricted unpickling executes arbitrary code from the file; restricting
    reconstruction to tensors is the difference between loading data and running
    a stranger's program.

    Published checkpoints disagree about their top-level key - Real-ESRGAN uses
    ``params_ema``, SwinIR's realSR weights use ``params_ema`` and its denoise
    weights use ``params``, and some files are a bare state dict. The preference
    order is passed in by the caller rather than guessed, because loading the
    wrong key would produce a model that is valid, loadable and not the one
    published.
    """
    torch = load_torch()
    if torch is None:
        msg = "torch is not installed"
        raise RuntimeError(msg)

    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, dict):
        return checkpoint
    for key in preferred_keys:
        if key in checkpoint:
            return checkpoint[key]
    return checkpoint


def to_tensor(image: Any) -> Tensor:
    """PIL RGB image -> 1x3xHxW float tensor in 0..1."""
    import numpy
    import torch

    # numpy.asarray on a PIL image yields a read-only view; torch warns, and the
    # tensor would share memory with it. Copy so the tensor owns its buffer.
    array = numpy.array(image, dtype=numpy.uint8, copy=True)
    return torch.from_numpy(array).permute(2, 0, 1).float().div(255.0).unsqueeze(0)


def from_tensor(tensor: Tensor) -> Any:
    """1x3xHxW float tensor -> PIL RGB image, clamped and rounded once."""
    import torch
    from PIL import Image

    array = tensor.squeeze(0).clamp(0, 1).mul(255).round().to(torch.uint8)
    array = array.permute(1, 2, 0).contiguous()
    return Image.frombytes("RGB", (array.shape[1], array.shape[0]), array.numpy().tobytes())
