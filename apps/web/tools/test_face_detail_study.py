"""Focused research-boundary and coordinate tests; no customer pixels or model execution."""

from __future__ import annotations

import hashlib
import socket
import tempfile
import zlib
from pathlib import Path
from unittest.mock import patch

import pytest
from face_detail_study import (
    MODELS,
    TEMPLATE,
    inverse_transform,
    network_denied,
    research_register,
    similarity_transform,
    source_view_mapping,
    verify_model,
)


def test_alignment_identity():
    assert similarity_transform(TEMPLATE) == pytest.approx((1, 0, 0, 0))


def test_alignment_recovers_uniform_rotation_scale_and_translation():
    points = [(2 * x - y + 30, x + 2 * y - 70) for x, y in TEMPLATE]
    a, b, tx, ty = similarity_transform(points)
    for (x, y), (u, v) in zip(points, TEMPLATE, strict=True):
        assert (a * x - b * y + tx, b * x + a * y + ty) == pytest.approx((u, v))


def test_inverse_maps_the_same_source_coordinates():
    forward = (2.5, 0.7, -210, 56)
    a, b, tx, ty = forward
    ia, ib, itx, ic, id_, ity = inverse_transform(forward)
    for x, y in ((0, 0), (600, 1100), (1290, 2796)):
        u, v = a * x - b * y + tx, b * x + a * y + ty
        assert (ia * u + ib * v + itx, ic * u + id_ * v + ity) == pytest.approx((x, y))


def test_invalid_landmarks_do_not_manufacture_alignment():
    for points in ([(0, 0)] * 5, TEMPLATE[:4], [(float("nan"), 1)] * 5):
        with pytest.raises(ValueError, match="landmarks"):
            similarity_transform(points)
    with pytest.raises(ValueError, match="singular"):
        inverse_transform((0, 0, 1, 1))


def test_checksum_failure_blocks_inference():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "unexpected.onnx"
        path.touch()
        with pytest.raises(ValueError, match="artifact"):
            verify_model(path, "codeformer")


@pytest.mark.parametrize("mismatch", ["sha256", "crc32"])
def test_same_size_tampering_and_wrong_publisher_checksum_block_inference(
    tmp_path, monkeypatch, mismatch
):
    content = b"synthetic unit-test artifact, never executed"
    path = tmp_path / "synthetic.onnx"
    path.write_bytes(content)
    facts = {
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "crc32": f"{zlib.crc32(content):08x}",
    }
    facts[mismatch] = "0" * len(facts[mismatch])
    monkeypatch.setitem(MODELS, "synthetic", facts)
    with pytest.raises(ValueError, match="SHA-256 and publisher CRC32"):
        verify_model(path, "synthetic")


def test_original_and_candidate_share_source_coordinates_at_all_zoom_levels():
    transform = (2.5, 0.7, -210, 56)
    crop = (500, 1000, 850, 1350)
    a, b, tx, ty = transform
    for width in (350, 700, 1400):
        ma, mb, mtx, mc, md, mty = source_view_mapping(transform, crop, width)
        for fraction_x, fraction_y in ((0, 0), (0.5, 0.7), (1, 1)):
            vx, vy = fraction_x * width, fraction_y * width
            sx, sy = crop[0] + fraction_x * 350, crop[1] + fraction_y * 350
            assert (ma * vx + mb * vy + mtx, mc * vx + md * vy + mty) == pytest.approx(
                (a * sx - b * sy + tx, b * sx + a * sy + ty)
            )
    with pytest.raises(ValueError, match="nonempty"):
        source_view_mapping(transform, crop, 0)


def test_network_is_denied_not_just_declared_disabled():
    with (
        patch.object(socket, "create_connection", network_denied),
        pytest.raises(RuntimeError, match="disabled"),
    ):
        socket.create_connection(("127.0.0.1", 9))


def test_shared_gate_permits_reference_research_but_blocks_all_commercial_use():
    from ipw.contracts.licence import RunPurpose

    register = research_register()
    for model in MODELS:
        component = f"face-detail-study-{model.replace('_', '-').replace('.', '-')}"
        local = register.evaluate(component, RunPurpose.LOCAL_RESEARCH)
        assert local.permitted, local.model_dump_json()
        assert local.reference_only
        assert not local.eligible_for_commercial_recommendation
        for purpose in (RunPurpose.PRODUCTION, RunPurpose.STAGING, RunPurpose.PUBLIC_DEMO):
            assert not register.evaluate(component, purpose).permitted
