"""Converting between PIL images and tensors, and unpickling a checkpoint safely.

These need torch but no model weights, which is why they belong here rather than
with the adapter tests: torch is a declared dependency and installs on every
runner, while the checkpoints are a 67 MB download that CI is forbidden to make.
Until now the only thing exercising them was an adapter run with real weights,
so on any machine without those they were untested - including every CI job.

The round trip matters more than it looks. It sits on both sides of every
inference call, so an error here is an error in the output of every AI operation,
attributed to the model rather than to the eight lines that framed it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ipw.processors.ai_adapters.common import (
    checkpoint_state_dict,
    from_tensor,
    load_torch,
    to_tensor,
)

torch = load_torch()
needs_torch = pytest.mark.skipif(torch is None, reason="torch is not installed on this host")

pytestmark = needs_torch


def _image(width: int = 4, height: int = 3, colour: tuple[int, int, int] = (10, 200, 30)) -> Any:
    from PIL import Image

    return Image.new("RGB", (width, height), colour)


class TestToTensor:
    def test_the_shape_is_batch_channels_height_width(self) -> None:
        """The order every torch vision model expects, and the one a naive
        conversion from a PIL image gets wrong: PIL gives HxWxC."""
        tensor = to_tensor(_image(width=7, height=5))

        assert tuple(tensor.shape) == (1, 3, 5, 7)

    def test_values_are_scaled_into_zero_to_one(self) -> None:
        tensor = to_tensor(_image(colour=(0, 255, 128)))

        assert float(tensor.min()) == 0.0
        assert float(tensor.max()) == 1.0

    def test_the_channels_are_not_transposed(self) -> None:
        """A red image must not come back blue. Channel-order bugs survive every
        shape assertion and only show up when somebody looks at a picture."""
        tensor = to_tensor(_image(colour=(255, 0, 0)))

        assert float(tensor[0, 0].mean()) == pytest.approx(1.0)
        assert float(tensor[0, 1].mean()) == pytest.approx(0.0)
        assert float(tensor[0, 2].mean()) == pytest.approx(0.0)

    def test_the_tensor_owns_its_memory(self) -> None:
        """numpy.asarray on a PIL image yields a read-only view; a tensor sharing
        that buffer warns and aliases the image it came from."""
        image = _image()
        tensor = to_tensor(image)

        tensor.add_(0.5)  # would raise or corrupt the image if the buffer were shared
        assert to_tensor(image).max() <= 1.0


class TestFromTensor:
    def test_a_round_trip_returns_the_original_pixels(self) -> None:
        """The property the whole pair exists for. Every AI result passes through
        both directions, so drift here is attributed to the model."""
        original = _image(width=5, height=4, colour=(17, 200, 3))

        # tobytes rather than getdata: the same comparison, through an API
        # that is not deprecated out from under this test in Pillow 14.
        assert from_tensor(to_tensor(original)).tobytes() == original.tobytes()

    def test_the_size_survives(self) -> None:
        assert from_tensor(to_tensor(_image(width=9, height=2))).size == (9, 2)

    def test_values_outside_the_range_are_clamped_not_wrapped(self) -> None:
        """A model can return values slightly outside 0..1. Wrapping turns a
        highlight into a black pixel, which is a far more visible failure than
        the clipping it replaces."""
        tensor = to_tensor(_image(colour=(255, 255, 255)))

        bright = from_tensor(tensor.mul(1.5))
        dark = from_tensor(tensor.sub(2.0))

        assert bright.getpixel((0, 0)) == (255, 255, 255)
        assert dark.getpixel((0, 0)) == (0, 0, 0)

    def test_the_result_is_an_rgb_image(self) -> None:
        assert from_tensor(to_tensor(_image())).mode == "RGB"


class TestCheckpointLoading:
    """Unpickling is restricted to tensors. A .pth is a pickle, and unrestricted
    loading executes whatever the file says - the difference between loading data
    and running a stranger's program."""

    def _save(self, tmp_path: Path, payload: object) -> Path:
        path = tmp_path / "checkpoint.pth"
        torch.save(payload, path)  # type: ignore[union-attr]
        return path

    def test_the_preferred_key_is_unwrapped(self, tmp_path: Path) -> None:
        weights = {"layer.weight": torch.zeros(2)}  # type: ignore[union-attr]
        path = self._save(tmp_path, {"params_ema": weights, "params": {"other": torch.ones(1)}})  # type: ignore[union-attr]

        assert set(checkpoint_state_dict(path)) == {"layer.weight"}

    def test_the_preference_order_is_honoured(self, tmp_path: Path) -> None:
        """SwinIR's realSR weights use params_ema and its denoise weights use
        params. Guessing would load a model that is valid, loadable, and not the
        one that was published."""
        path = self._save(
            tmp_path,
            {"params": {"a": torch.zeros(1)}, "params_ema": {"b": torch.zeros(1)}},  # type: ignore[union-attr]
        )

        assert set(checkpoint_state_dict(path, ("params", "params_ema"))) == {"a"}
        assert set(checkpoint_state_dict(path, ("params_ema", "params"))) == {"b"}

    def test_a_bare_state_dict_is_returned_as_is(self, tmp_path: Path) -> None:
        """Some published files have no wrapper at all."""
        path = self._save(tmp_path, {"layer.weight": torch.zeros(2)})  # type: ignore[union-attr]

        assert set(checkpoint_state_dict(path)) == {"layer.weight"}

    def test_a_checkpoint_that_is_not_a_mapping_is_passed_through(self, tmp_path: Path) -> None:
        path = self._save(tmp_path, torch.ones(3))  # type: ignore[union-attr]

        assert checkpoint_state_dict(path).shape == (3,)
