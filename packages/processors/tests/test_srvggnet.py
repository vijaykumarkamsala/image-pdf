"""Focused evidence for the compact local image-quality reconstruction model."""

from __future__ import annotations

from pathlib import Path

import pytest
from tools.export_realesrgan_webgpu import WEIGHT

from ipw.processors.ai_adapters.common import checkpoint_state_dict, verify_weight_digest
from ipw.processors.ai_adapters.srvggnet import compact_srvgg

torch = pytest.importorskip("torch", reason="the inference runtime is not installed")

REPOSITORY = Path(__file__).resolve().parents[3]
WEIGHT_PATH = REPOSITORY / ".tools" / "models" / WEIGHT.filename
needs_weight = pytest.mark.skipif(
    not WEIGHT_PATH.is_file(),
    reason="pinned local-research weight is not installed",
)


@needs_weight
def test_compact_checkpoint_loads_strictly_and_reconstructs_pixels() -> None:
    verify_weight_digest(WEIGHT_PATH, WEIGHT)
    model = compact_srvgg(num_conv=32, upscale=4)
    model.load_state_dict(checkpoint_state_dict(WEIGHT_PATH, ("params",)), strict=True)
    model.eval()

    values = torch.linspace(0, 1, 16 * 16, dtype=torch.float32).reshape(1, 1, 16, 16)
    source = torch.cat((values, values.flip(-1), values.flip(-2)), dim=1)
    with torch.inference_mode():
        restored = model(source)
        nearest = torch.nn.functional.interpolate(source, scale_factor=4, mode="nearest")

    assert tuple(restored.shape) == (1, 3, 64, 64)
    assert torch.mean(torch.abs(restored - nearest)).item() > 0.001


def test_webgpu_export_pin_matches_the_governed_installer() -> None:
    source = (REPOSITORY / "tools" / "install_model_weights.py").read_text(encoding="utf-8")
    assert WEIGHT.filename in source
    assert WEIGHT.sha256 in source
    assert str(WEIGHT.bytes_expected) in source.replace("_", "")
