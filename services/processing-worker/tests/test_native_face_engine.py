"""Owned synthetic graph/pixel mechanics; not real-face quality or release approval."""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import pyvips
from onnx import TensorProto, helper, numpy_helper
from pydantic import ValidationError

from ipw.contracts.image_quality_face import (
    NativeFaceCandidate,
    NativeFaceCompositionRequest,
    NativeFaceContext,
    NativeFaceRelease,
    NativeFaceReview,
    native_face_candidate_sha256,
)
from ipw.processing_worker import native_face_engine as module
from ipw.processing_worker.native_face_colour import NativeFaceColour, linear_rgb
from ipw.processing_worker.native_face_engine import (
    NativeFaceBundle,
    NativeOnnxFaceEngine,
    verified_face_graph,
)
from ipw.processing_worker.native_face_geometry import (
    TEMPLATE,
    Detection,
    align_face,
    decode_heads,
    detector_tensor,
    detector_windows,
    inverse,
    proposal_coordinates,
    single_face,
)
from ipw.processing_worker.native_face_renderer import (
    NativeFaceRenderCancelledError,
    NativeFaceRenderer,
    NativeFaceRenderError,
    inspect_native_face_png,
    native_face_colour_sha256,
    native_face_pixel_sha256,
)


def heads(*, face_count: int = 1) -> dict[str, np.ndarray[Any, Any]]:
    output = {
        f"{name}_{stride}": np.zeros((1, (640 // stride) ** 2, channels), np.float32)
        for stride in (8, 16, 32)
        for name, channels in (("cls", 1), ("obj", 1), ("bbox", 4), ("kps", 10))
    }
    for number in range(face_count):
        row, column = 40, 40 + number * 25
        index = row * 80 + column
        output["cls_8"][0, index, 0] = 1
        output["obj_8"][0, index, 0] = 1
        output["bbox_8"][0, index] = [0, 0, np.log(200 / 8), np.log(200 / 8)]
        points = (TEMPLATE * 1.25 + [number * 200, 0]) / 8 - [column, row]
        output["kps_8"][0, index] = points.reshape(10)
    return output


def save_graph(path: Path, graph: Any) -> bytes:
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 10
    raw = model.SerializeToString()
    path.write_bytes(raw)
    return raw


def fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    depth: int = 16,
    profile: bool = False,
    face_count: int = 1,
    scale: int = 1,
) -> dict[str, Any]:
    detector_path, model_path = tmp_path / "owned-detector.onnx", tmp_path / "owned-restorer.onnx"
    values = heads(face_count=face_count)
    detector = save_graph(
        detector_path,
        helper.make_graph(
            [helper.make_node("Identity", [f"constant-{name}"], [name]) for name in values],
            "owned-detector",
            [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 640, 640])],
            [
                helper.make_tensor_value_info(name, TensorProto.FLOAT, list(value.shape))
                for name, value in values.items()
            ],
            [numpy_helper.from_array(value, f"constant-{name}") for name, value in values.items()],
        ),
    )
    # Test-only fixed detector replacement; production has no such option or flag.
    monkeypatch.setattr(module, "YUNET_SHA256", hashlib.sha256(detector).hexdigest())
    monkeypatch.setattr(module, "YUNET_BYTES", len(detector))
    model = save_graph(
        model_path,
        helper.make_graph(
            [
                helper.make_node("Mul", ["fidelity", "bias"], ["amount"]),
                helper.make_node("Add", ["image", "amount"], ["biased"]),
                helper.make_node("Clip", ["biased", "lower", "upper"], ["output"]),
            ],
            "owned-restorer",
            [
                helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, 512, 512]),
                helper.make_tensor_value_info("fidelity", TensorProto.FLOAT, []),
            ],
            [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, 512, 512])],
            [
                numpy_helper.from_array(np.array(value, np.float32), name)
                for name, value in (("bias", 0.0008), ("lower", -1), ("upper", 1))
            ],
        ),
    )
    bundle = NativeFaceBundle(
        model_sha256=hashlib.sha256(model).hexdigest(),
        model_bytes=len(model),
        image_input="image",
        fidelity_input="fidelity",
        output="output",
        fidelity_type="tensor(float)",
        fidelity_shape=(),
        python_version=sys.version.split()[0],
        system=platform.system(),
        machine=platform.machine(),
    )
    release = NativeFaceRelease(
        model_id="owned-test-only",
        model_version="1",
        model_sha256=bundle.model_sha256,
        dependency_lock_sha256=bundle.sha256(),
        commercial_rights="approved",
        rights_evidence_id="synthetic-tests-only",
        quality_review="approved",
        quality_evidence_id="synthetic-tests-only",
    )
    current = [release]
    engine = NativeOnnxFaceEngine(
        bundle=bundle,
        detector_path=detector_path,
        model_path=model_path,
        current_release=lambda: current[0],
    )
    dtype, maximum = (np.uint16, 65535) if depth == 16 else (np.uint8, 255)
    pixels = np.full((512, 512, 4), 32017 if depth == 16 else 127, dtype)
    pixels[..., 3] = maximum
    image = pyvips.Image.new_from_memory(
        pixels.tobytes(), 512, 512, 4, "ushort" if depth == 16 else "uchar"
    ).copy(interpretation="rgb16" if depth == 16 else "srgb")
    if profile:
        icc = (
            image.extract_band(0, n=3)
            .icc_import(input_profile="srgb", pcs="xyz")
            .get("icc-profile-data")
        )
        image.set_type(pyvips.GValue.blob_type, "icc-profile-data", icc)
    source_path, base_path = tmp_path / "source.png", tmp_path / "base.png"
    image.pngsave(str(source_path), bitdepth=depth)
    base = image.resize(scale, kernel="nearest") if scale != 1 else image
    # Base alpha includes hidden RGB and fractional alpha, independently of opaque source.
    base_pixels = (
        np.frombuffer(base.write_to_memory(), dtype=dtype)
        .reshape(base.height, base.width, 4)
        .copy()
    )
    base_pixels[300 * scale, 260 * scale, 3] = 0
    base_pixels[301 * scale, 260 * scale, 3] = maximum // 2
    base = pyvips.Image.new_from_memory(
        base_pixels.tobytes(), base.width, base.height, 4, "ushort" if depth == 16 else "uchar"
    ).copy(interpretation=image.interpretation)
    if profile:
        base.set_type(pyvips.GValue.blob_type, "icc-profile-data", image.get("icc-profile-data"))
    base.pngsave(str(base_path), bitdepth=depth)
    context = NativeFaceContext(
        source_sha256=hashlib.sha256(source_path.read_bytes()).hexdigest(),
        base_output_sha256=hashlib.sha256(base_path.read_bytes()).hexdigest(),
        source_width=512,
        source_height=512,
        output_width=base.width,
        output_height=base.height,
        bit_depth=depth,
        colour_authority_sha256=native_face_colour_sha256(base_path),
    )
    return locals()


def propose(case: dict[str, Any], fidelity: int = 8000, cancelled: Any = lambda: False) -> Any:
    return case["engine"].propose(
        source_path=case["source_path"],
        base_path=case["base_path"],
        context=case["context"],
        fidelity_permyriad=fidelity,
        cancelled=cancelled,
    )


@pytest.mark.parametrize(
    ("depth", "profile", "scale"), [(8, False, 1), (16, False, 1), (16, True, 2)]
)
def test_actual_onnx_native_proposal_and_reviewed_png(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, depth: int, profile: bool, scale: int
) -> None:
    case = fixture(tmp_path, monkeypatch, depth=depth, profile=profile, scale=scale)
    try:
        proposal = propose(case)
        region, context = proposal.region, case["context"]
        assert proposal.pixels.dtype == case["base_pixels"].dtype
        assert proposal.alignment.detector_sha256 == module.YUNET_SHA256
        base_region = case["base_pixels"][
            region.y : region.y + region.height, region.x : region.x + region.width
        ]
        assert np.array_equal(proposal.pixels[..., 3], base_region[..., 3])
        assert np.array_equal(
            proposal.pixels[base_region[..., 3] == 0], base_region[base_region[..., 3] == 0]
        )
        # Small synthetic bias is sub-8-bit for native 16-bit; it must not quantize away.
        if depth == 16:
            delta = np.abs(proposal.pixels[..., :3].astype(int) - base_region[..., :3].astype(int))
            assert 0 < delta.max() < 257
            assert np.any(proposal.pixels[..., :3] % 257)
        candidate = NativeFaceCandidate(
            candidate_id="owned-native-proposal",
            context=context,
            model_sha256=case["bundle"].model_sha256,
            dependency_lock_sha256=case["bundle"].sha256(),
            fidelity_permyriad=8000,
            region=region,
            pixels_sha256=native_face_pixel_sha256(proposal.pixels),
            mask_sha256=hashlib.sha256(proposal.mask.tobytes()).hexdigest(),
            alignment=proposal.alignment,
        )
        review = NativeFaceReview(
            source_sha256=context.source_sha256,
            base_output_sha256=context.base_output_sha256,
            candidate_sha256=native_face_candidate_sha256(candidate),
            allow_reconstructed_face_detail=True,
            acknowledged_possible_identity_change=True,
        )
        if depth == 8:
            # The deliberately sub-8-bit model bias may round to a true no-op at 8-bit.
            assert np.array_equal(proposal.pixels[..., :3], base_region[..., :3])
            return
        result = NativeFaceRenderer().compose(
            NativeFaceCompositionRequest(candidate=candidate, review=review),
            release=case["release"],
            source_path=case["source_path"],
            base_path=case["base_path"],
            pixels=proposal.pixels,
            mask=proposal.mask,
            output_path=tmp_path / "reviewed.png",
        )
        image = pyvips.Image.new_from_file(str(result.path))
        decoded = np.frombuffer(image.write_to_memory(), dtype=case["dtype"]).reshape(
            case["base_pixels"].shape
        )
        outside = np.ones(decoded.shape[:2], bool)
        outside[region.y : region.y + region.height, region.x : region.x + region.width] = (
            proposal.mask == 0
        )
        assert np.array_equal(decoded[outside], case["base_pixels"][outside])
        assert np.array_equal(decoded[..., 3], case["base_pixels"][..., 3])
        assert (
            inspect_native_face_png(result.path)[4] == inspect_native_face_png(case["base_path"])[4]
        )
        assert result.changed_pixels > 0
        assert (
            result.evidence["candidate"]["alignment"]
            == candidate.model_dump(mode="json")["alignment"]
        )
        assert hashlib.sha256(case["source_path"].read_bytes()).hexdigest() == context.source_sha256
        assert (
            hashlib.sha256(case["base_path"].read_bytes()).hexdigest() == context.base_output_sha256
        )
    finally:
        case["engine"].clear_source()


def test_decode_detection_alignment_once_for_distinct_fidelity_inferences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = fixture(tmp_path, monkeypatch)
    calls: list[int] = []
    real = module.decode_heads
    monkeypatch.setattr(module, "decode_heads", lambda *args: calls.append(1) or real(*args))
    try:
        first = propose(case, 5000)
        prepared = case["engine"]._prepared  # noqa: SLF001 -- Owned adapter cache assertion.
        second = propose(case, 10000)
        assert case["engine"]._prepared is prepared  # noqa: SLF001 -- No repeated private decode.
        assert calls == [1]
        assert first.alignment == second.alignment
        assert np.any(first.pixels != second.pixels)
        directory = Path(prepared.temporary.name)
    finally:
        case["engine"].clear_source()
    assert not directory.exists()


@pytest.mark.parametrize(
    "field", ["commercial_rights", "quality_review", "rights_evidence_id", "dependency_lock_sha256"]
)
def test_release_failure_precedes_any_session_or_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str
) -> None:
    case = fixture(tmp_path, monkeypatch)
    value = (
        "pending"
        if field.endswith("rights") or field == "quality_review"
        else " "
        if field.endswith("id")
        else "c" * 64
    )
    case["current"][0] = case["release"].model_copy(update={field: value})
    monkeypatch.setattr(
        module, "_session", lambda _: pytest.fail("unapproved session was constructed")
    )
    with pytest.raises(NativeFaceRenderError, match="release"):
        propose(case)
    assert case["engine"]._prepared is None  # noqa: SLF001 -- Rejected input has no private cache.


@pytest.mark.parametrize("when", [1, 5, 10, 14])
def test_cancellation_leaves_no_cached_source_or_private_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, when: int
) -> None:
    case = fixture(tmp_path, monkeypatch)
    calls = 0

    def cancel() -> bool:
        nonlocal calls
        calls += 1
        return calls >= when

    with pytest.raises(NativeFaceRenderCancelledError):
        propose(case, cancelled=cancel)
    assert case["engine"]._prepared is None  # noqa: SLF001 -- Cancellation releases private cache.
    assert (
        hashlib.sha256(case["source_path"].read_bytes()).hexdigest()
        == case["context"].source_sha256
    )


def test_stale_source_invalidates_cached_preparation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = fixture(tmp_path, monkeypatch)
    propose(case)
    directory = Path(case["engine"]._prepared.temporary.name)  # noqa: SLF001 -- Owned scratch only.
    case["source_path"].write_bytes(b"changed-test-only")
    with pytest.raises(NativeFaceRenderError, match="bytes changed"):
        propose(case)
    assert not directory.exists()


@pytest.mark.parametrize(
    "bad", ["nonfinite", "range", "shape", "precision", "revoked", "source-changed"]
)
def test_incompatible_or_revoked_model_output_cannot_leave_a_reviewable_proposal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    case = fixture(tmp_path, monkeypatch)
    propose(case)
    session = case["engine"]._restorer  # noqa: SLF001 -- Wrap owned synthetic inference only.

    class BadSession:
        def run(self, *args: Any) -> list[np.ndarray[Any, Any]]:
            output = session.run(*args)[0]
            if bad == "nonfinite":
                output[0, 0, 0, 0] = np.nan
            elif bad == "range":
                output[0, 0, 0, 0] = 2
            elif bad == "shape":
                output = output[..., :1]
            elif bad == "precision":
                output = output.astype(np.uint8)
            elif bad == "revoked":
                case["current"][0] = None
            else:
                case["source_path"].write_bytes(b"changed-during-owned-inference")
            return [output]

    case["engine"]._restorer = BadSession()  # noqa: SLF001 -- Test-only damaged output/revocation.
    with pytest.raises(NativeFaceRenderError):
        propose(case)
    assert case["engine"]._prepared is None  # noqa: SLF001 -- No private candidate cache survives.


@pytest.mark.parametrize("fidelity", [-1, 10001, True, "8000"])
def test_bad_fidelity_never_constructs_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fidelity: Any
) -> None:
    case = fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(
        module, "_session", lambda _: pytest.fail("invalid fidelity invoked runtime")
    )
    with pytest.raises(NativeFaceRenderError, match="fidelity"):
        propose(case, fidelity)


def test_zero_faces_and_runtime_mismatch_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = fixture(tmp_path, monkeypatch, face_count=0)
    with pytest.raises(NativeFaceRenderError, match="single confident"):
        propose(case)
    changed = case["bundle"].model_copy(update={"python_version": "0.0.0"})
    case["engine"]._bundle = changed  # noqa: SLF001 -- Explicit test-only pin corruption.
    case["current"][0] = case["release"].model_copy(
        update={"dependency_lock_sha256": changed.sha256()}
    )
    with pytest.raises(NativeFaceRenderError, match="execution pins"):
        propose(case)


def test_complete_scan_budget_is_planned_without_huge_allocations() -> None:
    assert detector_windows(512, 512) == ((0, 0, 512, 512),)
    windows = detector_windows(1200, 900)
    assert windows[0] == (0, 0, 1200, 900)
    assert windows[-1] == (560, 260, 640, 640)
    with pytest.raises(NativeFaceRenderError, match="window budget"):
        detector_windows(2**31 - 1, 2**31 - 1)


def test_detector_head_coordinates_nms_and_bad_outputs() -> None:
    found = decode_heads(heads(), (0, 0, 512, 512))
    np.testing.assert_allclose(found[0].landmarks, TEMPLATE, atol=1e-4)
    assert single_face([found[0], found[0]]) == found[0]
    other = Detection((500, 500, 100, 100), TEMPLATE + 500, 1)
    with pytest.raises(NativeFaceRenderError, match="single confident"):
        single_face([found[0], other])
    bad = heads()
    bad["kps_16"][0, 0, 0] = np.nan
    with pytest.raises(NativeFaceRenderError, match="nonfinite"):
        decode_heads(bad, (0, 0, 512, 512))


@pytest.mark.parametrize("rotation", [0, 0.3, -0.8])
def test_similarity_inverse_and_enlarged_comparison_match_source_coordinates(
    rotation: float,
) -> None:
    matrix = np.array([[np.cos(rotation), -np.sin(rotation)], [np.sin(rotation), np.cos(rotation)]])
    points = (TEMPLATE - 256) @ matrix.T * 0.6 + 256
    alignment = align_face(Detection((80, 80, 350, 350), points, 0.99), "a" * 64)
    a, b, tx, ty = inverse(alignment)
    reconstructed = TEMPLATE @ np.array([[a, b], [-b, a]]) + [tx, ty]
    np.testing.assert_allclose(reconstructed, points, atol=1e-5)
    context = NativeFaceContext(
        source_sha256="b" * 64,
        base_output_sha256="c" * 64,
        source_width=512,
        source_height=512,
        output_width=2048,
        output_height=2048,
        bit_depth=16,
        colour_authority_sha256="d" * 64,
    )
    region, u, v, mask = proposal_coordinates(context, alignment)
    a, b, tx, ty = np.array(alignment.similarity_nanounits) / 1e9
    sx, sy = (region.x + 0.5) / 4 - 0.5, (region.y + 0.5) / 4 - 0.5
    assert u[0, 0] == pytest.approx(a * sx - b * sy + tx)
    assert v[0, 0] == pytest.approx(b * sx + a * sy + ty)
    assert mask.dtype == np.uint8
    assert mask.max() == 255
    assert mask.min() == 0


def test_detection_samples_source_pixels_bgr_not_css() -> None:
    pixels = np.full((10, 10, 3), [17, 31, 97], np.uint8)
    tensor = detector_tensor(pixels, (0, 0, 10, 10), lambda value: value.astype(np.float32) / 255)
    np.testing.assert_allclose(tensor[0, :, 300, 300], [97, 31, 17], atol=1e-5)


def test_detector_tile_sampling_does_not_bleed_adjacent_source_content() -> None:
    pixels = np.zeros((8, 16, 3), np.uint8)
    pixels[:, :8, 2] = 255
    pixels[:, 8:, 0] = 255
    tensor = detector_tensor(pixels, (0, 0, 8, 8), lambda value: value.astype(np.float32) / 255)
    np.testing.assert_allclose(tensor[0, :, 300, 639], [255, 0, 0], atol=1e-5)


@pytest.mark.parametrize("profile", [False, True])
def test_zero_delta_exact_native_colour_alpha_and_sub_eight_bit_detail(profile: bool) -> None:
    base = np.full((3, 4, 4), [32117, 27901, 19703, 32123], np.uint16)
    colour = NativeFaceColour(16)
    if profile:
        image = pyvips.Image.new_from_memory(
            base[..., :3].copy().tobytes(), 4, 3, 3, "ushort"
        ).copy(interpretation="rgb16")
        colour = NativeFaceColour(
            16, bytes(image.icc_import(input_profile="srgb", pcs="xyz").get("icc-profile-data"))
        )
    reference = colour.working_rgb(base[..., :3])
    assert np.array_equal(colour.detail_proposal(base, reference, reference), base)
    output = colour.detail_proposal(base, reference, reference + 0.0002)
    assert np.array_equal(output[..., 3], base[..., 3])
    delta = output[..., :3].astype(int) - base[..., :3].astype(int)
    assert 0 < np.abs(delta).max() < 257
    if not profile:
        original_linear, output_linear = (
            linear_rgb(base[..., :3] / 65535),
            linear_rgb(output[..., :3] / 65535),
        )
        np.testing.assert_allclose(
            original_linear / original_linear.sum(axis=2, keepdims=True),
            output_linear / output_linear.sum(axis=2, keepdims=True),
            atol=5e-5,
        )


@pytest.mark.parametrize(
    "declared",
    [
        [(b"cICP", bytes([9, 16, 0, 1]))],
        [(b"mDCV", b"hdr")],
        [(b"gAMA", b"wrong")],
        [(b"sRGB", bytes([9]))],
    ],
)
def test_hdr_unknown_transfer_and_conflicting_colour_fail_closed(
    declared: list[tuple[bytes, bytes]],
) -> None:
    pixels = np.full((2, 2, 3), 32117, np.uint16)
    image = pyvips.Image.new_from_memory(pixels.tobytes(), 2, 2, 3, "ushort").copy(
        interpretation="rgb16"
    )
    with pytest.raises(NativeFaceRenderError):
        NativeFaceColour.from_image(image, declared)


def test_cmyk_is_not_mistaken_for_rgb_with_alpha() -> None:
    image = pyvips.Image.black(2, 2, bands=4).copy(interpretation="cmyk")
    with pytest.raises(NativeFaceRenderError, match="SDR RGB"):
        NativeFaceColour.from_image(image)


def test_graph_digest_external_tensor_and_custom_operator_rejection(tmp_path: Path) -> None:
    path = tmp_path / "graph.onnx"
    value = numpy_helper.from_array(np.zeros(1, np.float32), "value")
    graph = helper.make_graph(
        [helper.make_node("Identity", ["value"], ["output"])],
        "safe",
        [],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1])],
        [value],
    )
    raw = save_graph(path, graph)
    assert verified_face_graph(path, hashlib.sha256(raw).hexdigest(), len(raw)) == raw
    with pytest.raises(NativeFaceRenderError, match="digest"):
        verified_face_graph(path, "e" * 64, len(raw))
    value.data_location = TensorProto.EXTERNAL
    helper.set_model_props(helper.make_model(graph), {})
    graph.initializer[0].CopyFrom(value)
    raw = save_graph(path, graph)
    with pytest.raises(NativeFaceRenderError, match="external"):
        verified_face_graph(path, hashlib.sha256(raw).hexdigest(), len(raw))
    graph.initializer[0].data_location = TensorProto.DEFAULT
    graph.node[0].domain = "custom.owner"
    raw = save_graph(path, graph)
    with pytest.raises(NativeFaceRenderError, match="custom"):
        verified_face_graph(path, hashlib.sha256(raw).hexdigest(), len(raw))


def test_optional_alignment_preserves_old_digest_and_binds_new_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = fixture(tmp_path, monkeypatch)
    proposal = propose(case)
    try:
        candidate = NativeFaceCandidate(
            candidate_id="owned",
            context=case["context"],
            model_sha256=case["bundle"].model_sha256,
            dependency_lock_sha256=case["bundle"].sha256(),
            fidelity_permyriad=8000,
            region=proposal.region,
            pixels_sha256=native_face_pixel_sha256(proposal.pixels),
            mask_sha256=hashlib.sha256(proposal.mask.tobytes()).hexdigest(),
        )
        old = candidate.model_dump(mode="json")
        del old["alignment"]
        expected = hashlib.sha256(
            json.dumps(
                ["ipw-native-face-candidate-v1", old],
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode("ascii")
        ).hexdigest()
        assert native_face_candidate_sha256(candidate) == expected
        aligned = candidate.model_copy(update={"alignment": proposal.alignment})
        assert native_face_candidate_sha256(aligned) != expected
        with pytest.raises(ValidationError, match="landmarks"):
            NativeFaceCandidate.model_validate(
                {
                    **aligned.model_dump(),
                    "alignment": {
                        **proposal.alignment.model_dump(),
                        "source_landmarks_micropixels": [[-1, 2]] * 5,
                    },
                }
            )
    finally:
        case["engine"].clear_source()
