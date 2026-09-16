"""Focused real-pixel refinement checks on synthetic, rights-free inputs."""

import numpy as np
import pytest
from face_detail_refine import refine_face_pixels
from PIL import Image


def fixture():
    pixels = np.zeros((32, 32, 3), dtype=np.uint8)
    pixels[:, :16] = [35, 40, 45]
    pixels[:, 16:] = [95, 90, 85]
    return Image.fromarray(pixels)


def test_zero_amount_returns_exact_original_candidate_pixels():
    image = fixture()
    assert np.array_equal(refine_face_pixels(image, image, 0), np.asarray(image))


def test_refinement_changes_real_pixels_without_mutating_either_input():
    image = fixture()
    before = np.asarray(image).copy()
    output = refine_face_pixels(image, image)
    assert not np.array_equal(output, before)
    assert np.array_equal(np.asarray(image), before)
    assert output.shape == before.shape
    assert output.dtype == np.uint8
    assert np.max(np.abs(output.astype(float) - before)) <= 8


def test_shadow_detail_is_lifted_without_crushing_or_clipping():
    ramp = np.repeat(np.arange(256, dtype=np.uint8)[None, :, None], 3, axis=2)
    image = Image.fromarray(ramp)
    output = refine_face_pixels(image, image)
    assert output[0, 45, 0] > 45
    assert np.count_nonzero(output == 0) <= np.count_nonzero(ramp == 0)
    assert np.count_nonzero(output == 255) <= np.count_nonzero(ramp == 255)
    assert np.all(np.diff(output[0, :, 0].astype(int)) >= 0)


def test_neutral_colours_remain_neutral():
    image = Image.new("RGB", (32, 32), (90, 90, 90))
    output = refine_face_pixels(image, image)
    assert np.array_equal(output[..., 0], output[..., 1])
    assert np.array_equal(output[..., 1], output[..., 2])


@pytest.mark.parametrize("amount", [-0.1, 1.1, float("nan")])
def test_invalid_strength_cannot_process_pixels(amount):
    image = fixture()
    with pytest.raises(ValueError, match="amount"):
        refine_face_pixels(image, image, amount)
