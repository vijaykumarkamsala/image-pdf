from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from PIL import Image, PngImagePlugin
from pydantic import ValidationError

from ipw.contracts.image_quality_face import (
    NativeFaceAlignment,
    NativeFaceCandidate,
    NativeFaceCompositionRequest,
    NativeFaceContext,
    NativeFaceRegion,
    NativeFaceRelease,
    NativeFaceReview,
    native_face_candidate_sha256,
)
from ipw.processing_worker import native_face_renderer as module
from ipw.processing_worker.face_quality import (
    NativeFaceProposal,
    TemporalNativeFaceCandidateEngine,
)
from ipw.processing_worker.native_face_renderer import (
    NativeFaceRenderCancelledError,
    NativeFaceRenderer,
    NativeFaceRenderError,
    _hash_file,
    _png_authority,
    native_face_colour_sha256,
    native_face_pixel_sha256,
)


def fixture(tmp_path: Path, *, depth: int = 8, bands: int = 4, width: int = 18) -> dict[str, Any]:
    import pyvips

    dtype = np.uint16 if depth == 16 else np.uint8
    base = np.full((12, width, bands), 63 if depth == 8 else 16_123, dtype=dtype)
    base[..., 1] += np.arange(width, dtype=dtype)[None, :]
    if bands == 4:
        base[..., 3] = 255 if depth == 8 else 65535
        base[4, 5, 3] = 0
        base[5, 6, 3] = 127 if depth == 8 else 32_123
    base_path = tmp_path / "base.png"
    pyvips.Image.new_from_memory(
        memoryview(base), width, 12, bands, "ushort" if depth == 16 else "uchar"
    ).copy(interpretation="rgb16" if depth == 16 else "srgb").pngsave(
        str(base_path), bitdepth=depth
    )
    source_path = tmp_path / "original.png"
    source_path.write_bytes(base_path.read_bytes())
    pixels = np.full((4, 5, 4), 110 if depth == 8 else 28_234, dtype=dtype)
    mask = np.full((4, 5), 255, dtype=np.uint8)
    mask[0, 0] = 0
    mask[2, 2] = 128
    context = NativeFaceContext(
        source_sha256=_hash_file(source_path),
        base_output_sha256=_hash_file(base_path),
        source_width=width,
        source_height=12,
        output_width=width,
        output_height=12,
        bit_depth=depth,
        colour_authority_sha256=native_face_colour_sha256(base_path),
    )
    candidate = NativeFaceCandidate(
        candidate_id="test-owned-face",
        context=context,
        model_sha256="a" * 64,
        dependency_lock_sha256="b" * 64,
        fidelity_permyriad=8000,
        region=NativeFaceRegion(x=4, y=3, width=5, height=4),
        pixels_sha256=native_face_pixel_sha256(pixels),
        mask_sha256=hashlib.sha256(mask.tobytes()).hexdigest(),
    )
    review = NativeFaceReview(
        source_sha256=context.source_sha256,
        base_output_sha256=context.base_output_sha256,
        candidate_sha256=native_face_candidate_sha256(candidate),
        allow_reconstructed_face_detail=True,
        acknowledged_possible_identity_change=True,
    )
    release = NativeFaceRelease(
        model_id="owned-synthetic-test-not-production",
        model_version="1",
        model_sha256=candidate.model_sha256,
        dependency_lock_sha256=candidate.dependency_lock_sha256,
        commercial_rights="approved",
        rights_evidence_id="test-only",
        quality_review="approved",
        quality_evidence_id="test-only",
    )
    return {
        "request": NativeFaceCompositionRequest(candidate=candidate, review=review),
        "release": release,
        "source_path": source_path,
        "base_path": base_path,
        "pixels": pixels,
        "mask": mask,
        "output_path": tmp_path / "reviewed.png",
    }


def decoded(path: Path) -> np.ndarray[Any, Any]:
    import pyvips

    image = pyvips.Image.new_from_file(str(path))
    return (
        np.frombuffer(
            image.write_to_memory(), dtype=np.uint16 if image.format == "ushort" else np.uint8
        )
        .reshape(image.height, image.width, image.bands)
        .copy()
    )


def refresh_request(incoming: dict[str, Any]) -> None:
    context = incoming["request"].candidate.context.model_copy(
        update={
            "source_sha256": _hash_file(incoming["source_path"]),
            "base_output_sha256": _hash_file(incoming["base_path"]),
            "colour_authority_sha256": native_face_colour_sha256(incoming["base_path"]),
        }
    )
    candidate = incoming["request"].candidate.model_copy(update={"context": context})
    review = incoming["request"].review.model_copy(
        update={
            "source_sha256": context.source_sha256,
            "base_output_sha256": context.base_output_sha256,
            "candidate_sha256": native_face_candidate_sha256(candidate),
        }
    )
    incoming["request"] = NativeFaceCompositionRequest(candidate=candidate, review=review)


@pytest.mark.parametrize(("depth", "bands"), [(8, 3), (8, 4), (16, 3), (16, 4)])
def test_real_png_keeps_native_precision_alpha_outside_pixels_and_reviewed_bytes(
    tmp_path: Path, depth: int, bands: int
) -> None:
    incoming = fixture(tmp_path, depth=depth, bands=bands)
    original_bytes, base_bytes = (
        incoming["source_path"].read_bytes(),
        incoming["base_path"].read_bytes(),
    )
    before = decoded(incoming["base_path"])
    pixels_before, mask_before = incoming["pixels"].copy(), incoming["mask"].copy()
    result = NativeFaceRenderer().compose(**incoming)
    after = decoded(result.path)
    assert after.shape == before.shape
    assert after.dtype == before.dtype
    outside = np.ones(before.shape[:2], dtype=bool)
    outside[3:7, 4:9] = False
    assert np.array_equal(after[outside], before[outside])
    assert np.array_equal(after[3, 4], before[3, 4])  # Zero reconstruction mask.
    if bands == 4:
        assert np.array_equal(after[..., 3], before[..., 3])
        assert np.array_equal(after[4, 5], before[4, 5])  # Preserve hidden RGB too.
    assert np.any(after[..., :3] != before[..., :3])
    assert result.changed_pixels == np.count_nonzero(
        np.any(after[..., :3] != before[..., :3], axis=2)
    )
    weight = 128
    expected = (
        before[5, 6, :3].astype(np.uint32) * (255 - weight)
        + pixels_before[2, 2, :3].astype(np.uint32) * weight
        + 127
    ) // 255
    assert np.array_equal(after[5, 6, :3], expected)
    assert result.sha256 == _hash_file(result.path)
    assert result.byte_size == result.path.stat().st_size
    assert incoming["source_path"].read_bytes() == original_bytes
    assert incoming["base_path"].read_bytes() == base_bytes
    assert np.array_equal(incoming["pixels"], pixels_before)
    assert np.array_equal(incoming["mask"], mask_before)
    with Image.open(result.path) as opened:
        assert json.loads(opened.info["ipw-provenance"]) == result.evidence
        assert result.evidence["kind"] == "explicit-face-recreate"
        assert result.evidence["review"]["acknowledged_possible_identity_change"] is True


@pytest.mark.parametrize("depth", [8, 16])
def test_icc_hdr_primaries_chunks_stay_exact_while_private_text_is_removed(
    tmp_path: Path, depth: int
) -> None:
    from ipw.processing_worker.enhancement_engine import CANONICAL_SRGB_PROFILE
    from ipw.processing_worker.image_quality_model import _inject_png_colour_chunks

    incoming = fixture(tmp_path, depth=depth)
    if depth == 8:
        with Image.open(incoming["base_path"]) as image:
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("private-note", "private test metadata that must not be copied")
            image.save(
                tmp_path / "tagged.png", pnginfo=metadata, icc_profile=CANONICAL_SRGB_PROFILE
            )
    else:
        import pyvips

        profile_path = tmp_path / "test.icc"
        profile_path.write_bytes(CANONICAL_SRGB_PROFILE)
        pyvips.Image.new_from_file(str(incoming["base_path"])).pngsave(
            str(tmp_path / "tagged.png"), bitdepth=16, profile=str(profile_path)
        )
    # Synthetic signalling tests exact transport, not calibrated HDR image quality.
    _inject_png_colour_chunks(
        tmp_path / "tagged.png",
        [(b"cICP", bytes((9, 16, 0, 1))), (b"mDCV", bytes(range(24))), (b"cLLI", bytes(range(8)))],
    )
    incoming["base_path"] = tmp_path / "tagged.png"
    refresh_request(incoming)
    colours_before = _png_authority(incoming["base_path"])[4]
    result = NativeFaceRenderer().compose(**incoming)
    assert _png_authority(result.path)[4] == colours_before
    assert (
        native_face_colour_sha256(result.path)
        == incoming["request"].candidate.context.colour_authority_sha256
    )
    with Image.open(result.path) as opened:
        assert opened.info["icc_profile"] == CANONICAL_SRGB_PROFILE
        assert "private-note" not in opened.info


@pytest.mark.parametrize(
    ("field", "changed"),
    [
        ("commercial_rights", "pending"),
        ("quality_review", "rejected"),
        ("rights_evidence_id", None),
        ("quality_evidence_id", None),
        ("model_sha256", "c" * 64),
        ("dependency_lock_sha256", "d" * 64),
    ],
)
def test_uncleared_or_wrong_release_fails_before_decoding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, changed: Any
) -> None:
    incoming = fixture(tmp_path)
    incoming["release"] = incoming["release"].model_copy(update={field: changed})
    monkeypatch.setattr(
        module, "_png_authority", lambda _path: pytest.fail("uncleared release reached decode")
    )
    with pytest.raises(NativeFaceRenderError):
        NativeFaceRenderer().compose(**incoming)
    assert not incoming["output_path"].exists()


@pytest.mark.parametrize("depth", [8, 16])
def test_bounded_encoder_handles_rows_wider_than_one_buffer_without_pixel_drift(
    tmp_path: Path, depth: int
) -> None:
    incoming = fixture(tmp_path, depth=depth, width=6001)
    before = decoded(incoming["base_path"])
    result = NativeFaceRenderer().compose(**incoming)
    after = decoded(result.path)
    assert after.shape == before.shape
    assert np.array_equal(after[:, 9:], before[:, 9:])
    assert np.array_equal(after[:, :4], before[:, :4])


def test_exclusive_publication_preserves_a_file_created_during_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    incoming = fixture(tmp_path)

    def competing_output(_source: Path, target: Path) -> None:
        target.write_bytes(b"new user output")
        raise FileExistsError("competing publication")

    monkeypatch.setattr(module.os, "link", competing_output)
    with pytest.raises(NativeFaceRenderError, match="overwritten"):
        NativeFaceRenderer().compose(**incoming)
    assert incoming["output_path"].read_bytes() == b"new user output"
    assert not list(tmp_path.glob("ipw-native-face-*"))


@pytest.mark.parametrize("changed", ["pixels", "mask", "source_path", "base_path"])
def test_changed_pixels_mask_source_or_base_fail_closed(tmp_path: Path, changed: str) -> None:
    incoming = fixture(tmp_path)
    if changed in {"pixels", "mask"}:
        incoming[changed].flat[0] ^= 1
    else:
        incoming[changed].write_bytes(incoming[changed].read_bytes() + b"changed")
    with pytest.raises(NativeFaceRenderError, match="digest"):
        NativeFaceRenderer().compose(**incoming)
    assert not incoming["output_path"].exists()


def test_stale_review_and_unvalidated_constructs_are_rejected(tmp_path: Path) -> None:
    incoming = fixture(tmp_path)
    stale = incoming["request"].review.model_copy(update={"candidate_sha256": "e" * 64})
    incoming["request"] = incoming["request"].model_copy(update={"review": stale})
    with pytest.raises(ValidationError, match="stale"):
        NativeFaceRenderer().compose(**incoming)


def test_cancel_mid_render_removes_only_owned_scratch_and_publishes_nothing(tmp_path: Path) -> None:
    incoming = fixture(tmp_path)
    source_bytes, base_bytes = (
        incoming["source_path"].read_bytes(),
        incoming["base_path"].read_bytes(),
    )
    calls = 0

    def cancelled() -> bool:
        nonlocal calls
        calls += 1
        return calls >= 5

    with pytest.raises(NativeFaceRenderCancelledError):
        NativeFaceRenderer().compose(**incoming, cancelled=cancelled)
    assert not incoming["output_path"].exists()
    assert not list(tmp_path.glob("ipw-native-face-*"))
    assert incoming["source_path"].read_bytes() == source_bytes
    assert incoming["base_path"].read_bytes() == base_bytes


def test_existing_output_is_never_overwritten(tmp_path: Path) -> None:
    incoming = fixture(tmp_path)
    incoming["output_path"].write_bytes(b"existing user output")
    with pytest.raises(NativeFaceRenderError, match="overwritten"):
        NativeFaceRenderer().compose(**incoming)
    assert incoming["output_path"].read_bytes() == b"existing user output"


def test_cancel_during_final_digest_does_not_publish_a_finished_png(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    incoming = fixture(tmp_path)
    cancel_requested = False

    def digest(path: Path) -> str:
        nonlocal cancel_requested
        value = _hash_file(path)
        if path.name == "reviewed.png":
            cancel_requested = True
        return value

    monkeypatch.setattr(module, "_hash_file", digest)
    with pytest.raises(NativeFaceRenderCancelledError):
        NativeFaceRenderer().compose(**incoming, cancelled=lambda: cancel_requested)
    assert not incoming["output_path"].exists()
    assert not list(tmp_path.glob("ipw-native-face-*"))


def test_noop_and_storage_exhaustion_do_not_produce_derivatives(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    incoming = fixture(tmp_path)
    incoming["mask"][:] = 0
    candidate = incoming["request"].candidate.model_copy(
        update={"mask_sha256": hashlib.sha256(incoming["mask"].tobytes()).hexdigest()}
    )
    review = incoming["request"].review.model_copy(
        update={"candidate_sha256": native_face_candidate_sha256(candidate)}
    )
    incoming["request"] = NativeFaceCompositionRequest(candidate=candidate, review=review)
    with pytest.raises(NativeFaceRenderError, match="no pixel correction"):
        NativeFaceRenderer().compose(**incoming)
    monkeypatch.setattr(module.shutil, "disk_usage", lambda _path: SimpleNamespace(free=0))
    with pytest.raises(NativeFaceRenderError, match="storage"):
        NativeFaceRenderer().compose(**incoming)
    assert not incoming["output_path"].exists()


def test_apng_is_rejected_instead_of_flattened(tmp_path: Path) -> None:
    incoming = fixture(tmp_path)
    first = Image.new("RGBA", (18, 12), (30, 40, 50, 128))
    first.save(
        tmp_path / "animated.png",
        save_all=True,
        append_images=[Image.new("RGBA", (18, 12), (80, 90, 100, 255))],
        duration=[80, 100],
    )
    incoming["base_path"] = tmp_path / "animated.png"
    context = incoming["request"].candidate.context.model_copy(
        update={"base_output_sha256": _hash_file(incoming["base_path"])}
    )
    candidate = incoming["request"].candidate.model_copy(update={"context": context})
    review = incoming["request"].review.model_copy(
        update={
            "base_output_sha256": context.base_output_sha256,
            "candidate_sha256": native_face_candidate_sha256(candidate),
        }
    )
    incoming["request"] = NativeFaceCompositionRequest(candidate=candidate, review=review)
    with pytest.raises(NativeFaceRenderError, match="Animated"):
        NativeFaceRenderer().compose(**incoming)
    assert not incoming["output_path"].exists()


def test_reviewed_temporal_candidate_preserves_frames_timing_and_outside_pixels(
    tmp_path: Path,
) -> None:
    frames = [
        Image.new("RGBA", (18, 12), (30, 40, 50, 255)),
        Image.new("RGBA", (18, 12), (80, 90, 100, 255)),
    ]
    for index, frame in enumerate(frames):
        frame.putpixel((1, 1), (10 + index, 20 + index, 30 + index, 0))
    base_path = tmp_path / "base.apng"
    frames[0].save(
        base_path,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=[80, 120],
        loop=2,
        disposal=0,
        blend=0,
        optimize=False,
    )
    source_path = tmp_path / "source.apng"
    source_path.write_bytes(base_path.read_bytes())
    pixels = np.zeros((2, 4, 5, 4), dtype=np.uint8)
    pixels[0, ..., :3] = (140, 80, 60)
    pixels[1, ..., :3] = (60, 150, 90)
    pixels[..., 3] = 255
    mask = np.full((2, 4, 5), 255, dtype=np.uint8)
    mask[:, 0, 0] = 0
    alignment = NativeFaceAlignment(
        detector_sha256="d" * 64,
        confidence_permyriad=9000,
        source_landmarks_micropixels=(
            (1_000_000, 1_000_000),
            (2_000_000, 1_000_000),
            (1_500_000, 2_000_000),
            (1_000_000, 3_000_000),
            (2_000_000, 3_000_000),
        ),
        similarity_nanounits=(1_000_000_000, 0, 0, 0),
        reprojection_error_millipixels=10,
    )
    context = NativeFaceContext(
        source_sha256=_hash_file(source_path),
        base_output_sha256=_hash_file(base_path),
        source_width=18,
        source_height=12,
        output_width=18,
        output_height=12,
        bit_depth=8,
        colour_authority_sha256=native_face_colour_sha256(base_path),
        frame_count=2,
    )
    candidate = NativeFaceCandidate(
        candidate_id="temporal-owned-face",
        context=context,
        model_sha256="a" * 64,
        dependency_lock_sha256="b" * 64,
        fidelity_permyriad=8000,
        region=NativeFaceRegion(x=4, y=3, width=5, height=4),
        pixels_sha256=native_face_pixel_sha256(pixels),
        mask_sha256=hashlib.sha256(mask.tobytes()).hexdigest(),
        frame_alignments=(alignment, alignment),
    )
    request = NativeFaceCompositionRequest(
        candidate=candidate,
        review=NativeFaceReview(
            source_sha256=context.source_sha256,
            base_output_sha256=context.base_output_sha256,
            candidate_sha256=native_face_candidate_sha256(candidate),
            allow_reconstructed_face_detail=True,
            acknowledged_possible_identity_change=True,
        ),
    )
    output_path = tmp_path / "reviewed.apng"
    result = NativeFaceRenderer().compose(
        request,
        release=NativeFaceRelease(
            model_id="owned-temporal-test",
            model_version="1",
            model_sha256=candidate.model_sha256,
            dependency_lock_sha256=candidate.dependency_lock_sha256,
            commercial_rights="approved",
            rights_evidence_id="test-only",
            quality_review="approved",
            quality_evidence_id="test-only",
        ),
        source_path=source_path,
        base_path=base_path,
        pixels=pixels,
        mask=mask,
        output_path=output_path,
    )
    assert result.evidence["frame_count"] == 2
    assert result.evidence["animation_policy"] == "all-frames-reviewed-no-flattening"
    with Image.open(base_path) as original, Image.open(output_path) as rendered:
        assert rendered.n_frames == original.n_frames == 2
        assert rendered.info["loop"] == original.info["loop"] == 2
        for index, duration in enumerate((80, 120)):
            original.seek(index)
            rendered.seek(index)
            assert rendered.info["duration"] == duration
            before = np.asarray(original.convert("RGBA"))
            after = np.asarray(rendered.convert("RGBA"))
            assert np.array_equal(after[:3], before[:3])
            assert np.array_equal(after[:, :4], before[:, :4])
            assert np.array_equal(after[..., 3], before[..., 3])
            assert not np.array_equal(after[4:7, 5:8, :3], before[4:7, 5:8, :3])


def test_temporal_candidate_adapter_infers_each_frame_and_unions_motion(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source.webp"
    base_path = tmp_path / "base.apng"
    source_frames = [
        Image.new("RGBA", (9, 7), (20, 30, 40, 255)),
        Image.new("RGBA", (9, 7), (50, 60, 70, 255)),
    ]
    source_frames[0].save(
        source_path,
        format="WEBP",
        save_all=True,
        append_images=source_frames[1:],
        duration=[70, 110],
        loop=0,
        lossless=True,
    )
    source_frames[0].save(
        base_path,
        format="PNG",
        save_all=True,
        append_images=source_frames[1:],
        duration=[70, 110],
        loop=0,
        disposal=0,
        blend=0,
    )
    alignment = NativeFaceAlignment(
        detector_sha256="d" * 64,
        confidence_permyriad=9000,
        source_landmarks_micropixels=(
            (1_000_000, 1_000_000),
            (2_000_000, 1_000_000),
            (1_500_000, 2_000_000),
            (1_000_000, 3_000_000),
            (2_000_000, 3_000_000),
        ),
        similarity_nanounits=(1_000_000_000, 0, 0, 0),
        reprojection_error_millipixels=10,
    )

    class StillEngine:
        calls = 0
        clears = 0

        def release(self) -> NativeFaceRelease | None:
            return None

        def clear_source(self) -> None:
            self.clears += 1

        def propose(self, **kwargs: Any) -> NativeFaceProposal:
            assert kwargs["context"].frame_count == 1
            with Image.open(kwargs["source_path"]) as source, Image.open(
                kwargs["base_path"]
            ) as base:
                assert source.n_frames == base.n_frames == 1
            offset = self.calls
            self.calls += 1
            return NativeFaceProposal(
                region=NativeFaceRegion(x=1 + offset, y=2, width=3, height=2),
                pixels=np.full((2, 3, 4), 90 + offset, dtype=np.uint8),
                mask=np.full((2, 3), 255, dtype=np.uint8),
                alignment=alignment,
            )

    still = StillEngine()
    context = NativeFaceContext(
        source_sha256=_hash_file(source_path),
        base_output_sha256=_hash_file(base_path),
        source_width=9,
        source_height=7,
        output_width=9,
        output_height=7,
        bit_depth=8,
        colour_authority_sha256=native_face_colour_sha256(base_path),
        frame_count=2,
    )
    proposal = TemporalNativeFaceCandidateEngine(still).propose(
        source_path=source_path,
        base_path=base_path,
        context=context,
        fidelity_permyriad=8000,
        cancelled=lambda: False,
    )
    assert still.calls == still.clears == 2
    assert proposal.region == NativeFaceRegion(x=1, y=2, width=4, height=2)
    assert proposal.pixels.shape == (2, 2, 4, 4)
    assert proposal.mask.shape == (2, 2, 4)
    assert len(proposal.frame_alignments) == 2
    assert np.all(proposal.mask[0, :, :3] == 255)
    assert np.all(proposal.mask[0, :, 3] == 0)
    assert np.all(proposal.mask[1, :, 0] == 0)
    assert np.all(proposal.mask[1, :, 1:] == 255)
