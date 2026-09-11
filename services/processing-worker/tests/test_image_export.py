# ruff: noqa: SLF001, PT011

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from collections.abc import Callable
from copy import deepcopy
from dataclasses import replace
from typing import Any, cast

import pytest
from PIL import Image, ImageChops, ImageFont
from tools.make_recovery_2e_fixtures import cmyk_jpeg, metadata_jpeg

from ipw.inspection import inspect_bytes
from ipw.processing_worker import enhancement_engine
from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.enhancement_engine import (
    CANONICAL_SRGB_PROFILE,
    MAX_PIXELS,
    DeterministicImageEngine,
    ProcessingBudget,
    ProcessingLimits,
    VerifiedRasterAsset,
    _effectively_visible_layers,
    _process_rss_bytes,
    process_peak_rss_bytes,
)
from ipw.processing_worker.image_export import (
    BundleItem,
    DurableExportBundleProcessor,
    DurableImageExportProcessor,
    ExportAssetReference,
    ExportOutputTarget,
    LeasedExportBundleJob,
    LeasedImageExportJob,
    StoredExportBundle,
    StoredExportOutput,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot

# The deterministic engine boundary is intentionally exercised below its public
# render method so every capability and fail-closed branch has direct evidence.


def source_png() -> bytes:
    image = Image.new("RGBA", (24, 16), "#16A36A")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def snapshot() -> dict[str, Any]:
    return {
        "schema_version": "1.18.0",
        "document_id": "document-export",
        "revision": 0,
        "artboards": [
            {
                "artboard_id": "artboard-export",
                "name": "Export",
                "order": 0,
                "width": 120,
                "height": 80,
                "unit": "px",
                "orientation": "landscape",
                "background": {"kind": "solid", "color": "#FFFFFF"},
            }
        ],
        "shared_assets": [
            {
                "shared_asset_id": "asset-raster",
                "kind": "raster",
                "source_version_id": "source-export",
                "object_reference_id": "object-export",
            }
        ],
        "shared_styles": [],
        "masks": [],
        "variants": [],
        "layers": [
            {
                "layer_id": "layer-raster",
                "artboard_id": "artboard-export",
                "parent_layer_id": None,
                "layer_type": "raster_image",
                "name": "Raster",
                "order": 0,
                "visible": True,
                "opacity": 1,
                "blend_mode": "normal",
                "transform": {"x": 8, "y": 8, "width": 70, "height": 50},
                "raster": {
                    "shared_asset_id": "asset-raster",
                    "crop": {"left": 0, "top": 0, "right": 1, "bottom": 1},
                    "adjustments": {},
                },
            },
            {
                "layer_id": "layer-shape",
                "artboard_id": "artboard-export",
                "parent_layer_id": None,
                "layer_type": "shape",
                "name": "Blue rectangle",
                "order": 1,
                "visible": True,
                "opacity": 0.9,
                "blend_mode": "normal",
                "transform": {"x": 58, "y": 24, "width": 50, "height": 36},
                "shape": {
                    "shape": "rectangle",
                    "fill": "#3559E0",
                    "stroke": "#162033",
                    "stroke_width": 2,
                },
            },
        ],
    }


def profile(format_name: str = "png", *, bit_depth: int = 8) -> dict[str, object]:
    return {
        "profile_id": f"profile-{format_name}",
        "name": format_name.upper(),
        "purpose": "web",
        "format": format_name,
        "width": 240,
        "height": 160,
        "fit": "contain",
        "quality": 88 if format_name == "jpeg" else None,
        "lossless": format_name in {"png", "webp", "tiff"},
        "resampling_algorithm": "lanczos",
        "colour_profile": "srgb",
        "bit_depth": bit_depth,
        "alpha_behavior": "flatten" if format_name == "jpeg" else "preserve",
        "background": "#FFFFFF" if format_name == "jpeg" else None,
        "metadata_policy": {
            "preserve_copyright": True,
            "preserve_location": False,
            "remove_embedded_thumbnails": True,
        },
    }


def operations() -> list[dict[str, object]]:
    return [
        {
            "operation_id": "op-crop",
            "kind": "crop",
            "order": 0,
            "enabled": True,
            "parameters": {"left": 0.02, "top": 0.02, "right": 0.98, "bottom": 0.98},
        },
        {
            "operation_id": "op-bright",
            "kind": "exposure_brightness",
            "order": 1,
            "enabled": True,
            "parameters": {"exposure_ev": 0.1, "brightness": 2},
        },
        {
            "operation_id": "op-contrast",
            "kind": "contrast",
            "order": 2,
            "enabled": True,
            "parameters": {"amount": 5},
        },
        {
            "operation_id": "op-tone",
            "kind": "highlights_shadows",
            "order": 3,
            "enabled": True,
            "parameters": {"highlights": -3, "shadows": 4},
        },
        {
            "operation_id": "op-colour",
            "kind": "saturation_vibrance",
            "order": 4,
            "enabled": True,
            "parameters": {"saturation": 3, "vibrance": 4},
        },
        {
            "operation_id": "op-gamma",
            "kind": "gamma",
            "order": 5,
            "enabled": True,
            "parameters": {"gamma": 1.05},
        },
        {
            "operation_id": "op-levels",
            "kind": "levels",
            "order": 6,
            "enabled": True,
            "parameters": {"black": 1, "white": 254, "midpoint": 1},
        },
        {
            "operation_id": "op-sharp",
            "kind": "unsharp_mask",
            "order": 7,
            "enabled": True,
            "parameters": {"radius": 1, "amount": 20, "threshold": 3},
        },
    ]


def verified_asset(data: bytes) -> VerifiedRasterAsset:
    return VerifiedRasterAsset(
        "asset-raster",
        "source-export",
        hashlib.sha256(data).hexdigest(),
        "image/png",
        len(data),
        24,
        16,
        data,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )


def native_profile() -> dict[str, object]:
    value = profile("png")
    value["width"] = None
    value["height"] = None
    return value


def render_native(
    document: dict[str, object],
    *,
    assets: dict[str, VerifiedRasterAsset] | None = None,
) -> tuple[str, Image.Image]:
    rendered = DeterministicImageEngine().render(
        snapshot=document,
        artboard_id="artboard-export",
        assets=assets or {},
        operations=[],
        profile=native_profile(),
    )
    with Image.open(io.BytesIO(rendered.data)) as opened:
        return rendered.sha256, opened.convert("RGBA").copy()


@pytest.mark.parametrize("format_name", ["jpeg", "png", "webp", "tiff"])
def test_engine_encodes_all_approved_formats_deterministically(format_name: str) -> None:
    data = source_png()
    engine = DeterministicImageEngine()
    first = engine.render(
        snapshot=snapshot(),
        artboard_id="artboard-export",
        assets={"asset-raster": verified_asset(data)},
        operations=operations(),
        profile=profile(format_name),
    )
    second = engine.render(
        snapshot=snapshot(),
        artboard_id="artboard-export",
        assets={"asset-raster": verified_asset(data)},
        operations=operations(),
        profile=profile(format_name),
    )
    assert first.data == second.data
    assert first.sha256 == hashlib.sha256(first.data).hexdigest()
    assert first.width == 240
    assert first.height == 160
    with Image.open(io.BytesIO(first.data)) as opened:
        assert opened.size == (240, 160)
        assert 34853 not in opened.getexif()


def test_engine_fails_closed_for_capability_gated_16_bit_output() -> None:
    data = source_png()
    with pytest.raises(ValueError, match="16-bit"):
        DeterministicImageEngine().render(
            snapshot=snapshot(),
            artboard_id="artboard-export",
            assets={"asset-raster": verified_asset(data)},
            operations=[],
            profile=profile("png", bit_depth=16),
        )


def test_engine_executes_transform_colour_and_resampling_operations() -> None:
    engine = DeterministicImageEngine()
    source = Image.new("RGBA", (16, 12), (90, 120, 160, 180))
    transformed = engine._operations(
        source,
        [
            {"kind": "contrast", "order": 1, "enabled": False, "parameters": {"amount": 100}},
            {
                "kind": "rotate",
                "order": 2,
                "enabled": True,
                "parameters": {"degrees": 90, "expand_canvas": True},
            },
            {
                "kind": "flip",
                "order": 3,
                "enabled": True,
                "parameters": {"horizontal": True, "vertical": True},
            },
            {
                "kind": "resize",
                "order": 4,
                "enabled": True,
                "parameters": {
                    "mode": "percent",
                    "width": 50,
                    "height": 50,
                    "algorithm": "bilinear",
                },
            },
            {
                "kind": "white_balance_temperature",
                "order": 5,
                "enabled": True,
                "parameters": {"temperature_kelvin": 8200},
            },
            {"kind": "tint", "order": 6, "enabled": True, "parameters": {"amount": 18}},
            {
                "kind": "curves",
                "order": 7,
                "enabled": True,
                "parameters": {
                    "channel": "red",
                    "points": [
                        {"input": 0, "output": 0},
                        {"input": 0.5, "output": 0.6},
                        {"input": 1, "output": 1},
                    ],
                },
            },
            {
                "kind": "noise_reduction",
                "order": 8,
                "enabled": True,
                "parameters": {"strength": 12},
            },
            {
                "kind": "colour_profile_conversion",
                "order": 9,
                "enabled": True,
                "parameters": {"target_profile": "srgb"},
            },
            {
                "kind": "resampling_scale",
                "order": 10,
                "enabled": True,
                "parameters": {"scale": 2, "algorithm": "nearest"},
            },
            {
                "kind": "grayscale",
                "order": 11,
                "enabled": True,
                "parameters": {"method": "luminance"},
            },
            {
                "kind": "alpha_background",
                "order": 12,
                "enabled": True,
                "parameters": {"behavior": "flatten", "background": "#F0F4F8"},
            },
        ],
    )
    assert transformed.size == (12, 16)
    assert transformed.getchannel("A").getextrema() == (255, 255)
    red, green, blue, _ = cast(tuple[int, int, int, int], transformed.getpixel((3, 3)))
    assert max(red, green, blue) - min(red, green, blue) <= 2


@pytest.mark.parametrize(
    ("parameters", "expected"),
    [
        ({"mode": "pixels", "width": 30, "height": 20, "algorithm": "nearest"}, (30, 20)),
        ({"mode": "percent", "width": 150, "height": 50, "algorithm": "bicubic"}, (24, 6)),
        (
            {
                "mode": "physical",
                "width": 2.54,
                "height": 25.4,
                "physical_unit": "cm",
                "ppi": 10,
                "algorithm": "lanczos",
            },
            (10, 100),
        ),
        (
            {
                "mode": "physical",
                "width": 25.4,
                "height": 25.4,
                "physical_unit": "mm",
                "ppi": 8,
                "algorithm": "bilinear",
            },
            (8, 8),
        ),
    ],
)
def test_engine_resize_modes_are_exact(
    parameters: dict[str, object], expected: tuple[int, int]
) -> None:
    result = DeterministicImageEngine()._resize_operation(
        Image.new("RGBA", (16, 12), "#3559E0"), parameters
    )
    assert result.size == expected


def test_engine_output_sizing_covers_percentage_physical_aspect_and_fit() -> None:
    engine = DeterministicImageEngine()
    image = Image.new("RGBA", (80, 40), (20, 80, 160, 128))
    assert engine._size_output(image, {"percentage": 25}).size == (20, 10)
    assert engine._size_output(
        image,
        {"physical_width": 2, "physical_height": 1, "physical_unit": "in", "ppi": 50},
    ).size == (100, 50)
    assert engine._size_output(image, {"width": 60, "height": None}).size == (60, 30)
    assert engine._size_output(image, {"width": None, "height": 30}).size == (60, 30)
    assert engine._size_output(image, {"width": 35, "height": 35, "fit": "stretch"}).size == (
        35,
        35,
    )
    assert engine._size_output(image, {"width": 35, "height": 35, "fit": "cover"}).size == (35, 35)
    contained = engine._size_output(
        image,
        {
            "width": 35,
            "height": 35,
            "fit": "contain",
            "alpha_behavior": "flatten",
            "background": "#FFFFFF",
        },
    )
    assert contained.size == (35, 35)
    assert contained.getchannel("A").getpixel((0, 0)) == 255


def test_operation_neutral_states_disable_and_order_are_pixel_truthful() -> None:
    engine = DeterministicImageEngine()
    source = Image.new("RGBA", (24, 16))
    for y in range(source.height):
        for x in range(source.width):
            source.putpixel((x, y), (20 + x * 7, 30 + y * 9, 40 + (x + y) * 4, 255))
    neutral = [
        {
            "kind": "crop",
            "order": 0,
            "enabled": True,
            "parameters": {"left": 0, "top": 0, "right": 1, "bottom": 1},
        },
        {
            "kind": "rotate",
            "order": 1,
            "enabled": True,
            "parameters": {"degrees": 0, "expand_canvas": True},
        },
        {
            "kind": "exposure_brightness",
            "order": 2,
            "enabled": True,
            "parameters": {"exposure_ev": 0, "brightness": 0},
        },
        {"kind": "contrast", "order": 3, "enabled": True, "parameters": {"amount": 0}},
        {
            "kind": "highlights_shadows",
            "order": 4,
            "enabled": True,
            "parameters": {"highlights": 0, "shadows": 0},
        },
        {
            "kind": "white_balance_temperature",
            "order": 5,
            "enabled": True,
            "parameters": {"temperature_kelvin": 6500},
        },
        {"kind": "tint", "order": 6, "enabled": True, "parameters": {"amount": 0}},
        {
            "kind": "saturation_vibrance",
            "order": 7,
            "enabled": True,
            "parameters": {"saturation": 0, "vibrance": 0},
        },
        {"kind": "gamma", "order": 8, "enabled": True, "parameters": {"gamma": 1}},
        {
            "kind": "levels",
            "order": 9,
            "enabled": True,
            "parameters": {"black": 0, "white": 255, "midpoint": 1},
        },
        {
            "kind": "curves",
            "order": 10,
            "enabled": True,
            "parameters": {
                "channel": "rgb",
                "points": [{"input": 0, "output": 0}, {"input": 1, "output": 1}],
            },
        },
        {
            "kind": "unsharp_mask",
            "order": 11,
            "enabled": True,
            "parameters": {"radius": 1, "amount": 0, "threshold": 3},
        },
        {
            "kind": "noise_reduction",
            "order": 12,
            "enabled": True,
            "parameters": {"strength": 0, "preserve_edges": 70},
        },
        {
            "kind": "colour_profile_conversion",
            "order": 13,
            "enabled": True,
            "parameters": {"target_profile": "srgb"},
        },
        {
            "kind": "alpha_background",
            "order": 14,
            "enabled": True,
            "parameters": {"behavior": "preserve", "background": None},
        },
    ]
    neutral_difference = ImageChops.difference(source, engine._operations(source, neutral))
    assert neutral_difference.convert("RGB").getbbox() is None
    assert neutral_difference.getchannel("A").getbbox() is None

    disabled = [{"kind": "contrast", "order": 0, "enabled": False, "parameters": {"amount": 100}}]
    disabled_difference = ImageChops.difference(source, engine._operations(source, disabled))
    assert disabled_difference.convert("RGB").getbbox() is None
    assert disabled_difference.getchannel("A").getbbox() is None

    exposure_then_levels = engine._operations(
        source,
        [
            {
                "kind": "exposure_brightness",
                "order": 0,
                "enabled": True,
                "parameters": {"exposure_ev": 0.7, "brightness": 0},
            },
            {
                "kind": "levels",
                "order": 1,
                "enabled": True,
                "parameters": {"black": 24, "white": 220, "midpoint": 1.3},
            },
        ],
    )
    levels_then_exposure = engine._operations(
        source,
        [
            {
                "kind": "levels",
                "order": 0,
                "enabled": True,
                "parameters": {"black": 24, "white": 220, "midpoint": 1.3},
            },
            {
                "kind": "exposure_brightness",
                "order": 1,
                "enabled": True,
                "parameters": {"exposure_ev": 0.7, "brightness": 0},
            },
        ],
    )
    assert (
        ImageChops.difference(exposure_then_levels, levels_then_exposure).convert("RGB").getbbox()
        is not None
    )


def test_crop_presets_and_denoise_edge_preservation_are_executable() -> None:
    engine = DeterministicImageEngine()
    source = Image.new("RGBA", (40, 20), "#3559E0")
    square = engine._crop_operation(
        source,
        {"left": 0, "top": 0, "right": 1, "bottom": 1, "aspect_preset": "1:1"},
    )
    portrait = engine._crop_operation(
        source,
        {"left": 0, "top": 0, "right": 1, "bottom": 1, "aspect_preset": "3:2"},
    )
    assert square.size == (20, 20)
    assert portrait.size == (30, 20)

    noisy = Image.new("RGBA", (9, 9), "#808080")
    noisy.putpixel((4, 4), (255, 0, 0, 255))
    protected = engine._operations(
        noisy,
        [
            {
                "kind": "noise_reduction",
                "order": 0,
                "enabled": True,
                "parameters": {"strength": 80, "preserve_edges": 100},
            }
        ],
    )
    smoothed = engine._operations(
        noisy,
        [
            {
                "kind": "noise_reduction",
                "order": 0,
                "enabled": True,
                "parameters": {"strength": 80, "preserve_edges": 0},
            }
        ],
    )
    assert ImageChops.difference(noisy, protected).convert("RGB").getbbox() is None
    assert smoothed.getpixel((4, 4)) != noisy.getpixel((4, 4))


def tagged_png(mode: str = "RGB") -> bytes:
    image = Image.new(mode, (24, 16), 128 if mode == "L" else (64, 128, 192))
    output = io.BytesIO()
    image.save(output, format="PNG", icc_profile=CANONICAL_SRGB_PROFILE)
    return output.getvalue()


def single_raster_document(width: int = 24, height: int = 16) -> dict[str, Any]:
    document = deepcopy(snapshot())
    document["artboards"][0].update(
        {
            "width": width,
            "height": height,
            "background": {"kind": "transparent", "color": None},
        }
    )
    document["layers"] = [document["layers"][0]]
    document["layers"][0]["transform"] = {
        "x": 0,
        "y": 0,
        "width": width,
        "height": height,
    }
    return document


def test_icc_preserve_srgb_grayscale_and_untagged_paths_are_truthful() -> None:
    engine = DeterministicImageEngine()
    tagged = tagged_png()
    tagged_asset = VerifiedRasterAsset(
        "asset-raster",
        "source-export",
        hashlib.sha256(tagged).hexdigest(),
        "image/png",
        len(tagged),
        24,
        16,
        tagged,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=True,
        colour_model="rgb",
    )
    preserve = native_profile()
    preserve["colour_profile"] = "preserve"
    preserved = engine.render(
        snapshot=single_raster_document(),
        artboard_id="artboard-export",
        assets={"asset-raster": tagged_asset},
        operations=[],
        profile=preserve,
    )
    assert preserved.metadata_evidence["icc_profiles"] == "preserved"
    with Image.open(io.BytesIO(preserved.data)) as opened:
        assert bytes(opened.info["icc_profile"]) == CANONICAL_SRGB_PROFILE

    converted = engine.render(
        snapshot=single_raster_document(),
        artboard_id="artboard-export",
        assets={"asset-raster": tagged_asset},
        operations=[],
        profile=native_profile(),
    )
    assert converted.metadata_evidence["icc_profiles"] == "converted-to-srgb"
    with Image.open(io.BytesIO(converted.data)) as opened:
        assert bytes(opened.info["icc_profile"]) == CANONICAL_SRGB_PROFILE

    gray = tagged_png("L")
    gray_asset = VerifiedRasterAsset(
        "asset-raster",
        "source-export",
        hashlib.sha256(gray).hexdigest(),
        "image/png",
        len(gray),
        24,
        16,
        gray,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=True,
        colour_model="grayscale",
    )
    gray_srgb = engine.render(
        snapshot=single_raster_document(),
        artboard_id="artboard-export",
        assets={"asset-raster": gray_asset},
        operations=[],
        profile=native_profile(),
    )
    assert gray_srgb.metadata_evidence["icc_profiles"] == "converted-to-srgb"
    with pytest.raises(ValueError, match="validated RGB ICC"):
        engine.render(
            snapshot=single_raster_document(),
            artboard_id="artboard-export",
            assets={"asset-raster": gray_asset},
            operations=[],
            profile=preserve,
        )

    untagged = source_png()
    untagged_result = engine.render(
        snapshot=single_raster_document(),
        artboard_id="artboard-export",
        assets={"asset-raster": verified_asset(untagged)},
        operations=[],
        profile=native_profile(),
    )
    assert untagged_result.metadata_evidence["icc_profiles"] == "assumed-srgb-and-tagged"


def test_cmyk_uses_littlecms_and_metadata_disposition_comes_from_output_bytes() -> None:
    engine = DeterministicImageEngine()
    cmyk = cmyk_jpeg()
    cmyk_asset = VerifiedRasterAsset(
        "asset-raster",
        "source-cmyk",
        hashlib.sha256(cmyk).hexdigest(),
        "image/jpeg",
        len(cmyk),
        360,
        240,
        cmyk,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=True,
        colour_model="cmyk",
    )
    converted = engine.render(
        snapshot=single_raster_document(360, 240),
        artboard_id="artboard-export",
        assets={"asset-raster": cmyk_asset},
        operations=[
            {
                "operation_id": "operation-cmyk-conversion",
                "kind": "colour_profile_conversion",
                "order": 0,
                "enabled": True,
                "parameters": {
                    "target_profile": "srgb",
                    "rendering_intent": "relative_colorimetric",
                    "black_point_compensation": False,
                },
            }
        ],
        profile=native_profile(),
    )
    assert converted.metadata_evidence["icc_profiles"] == "converted-to-srgb"
    with Image.open(io.BytesIO(converted.data)) as opened:
        assert opened.mode == "RGBA"
        assert bytes(opened.info["icc_profile"]) == CANONICAL_SRGB_PROFILE
        assert cast(tuple[int, ...], opened.getpixel((100, 100)))[:3] == (222, 91, 148)

    private = metadata_jpeg()
    private_asset = VerifiedRasterAsset(
        "asset-raster",
        "source-private",
        hashlib.sha256(private).hexdigest(),
        "image/jpeg",
        len(private),
        320,
        200,
        private,
        orientation=6,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )
    cleaned = engine.render(
        snapshot=single_raster_document(200, 320),
        artboard_id="artboard-export",
        assets={"asset-raster": private_asset},
        operations=[],
        profile=native_profile(),
    )
    assert cleaned.metadata_verified is True
    assert cleaned.metadata_evidence == {
        "exif": "removed",
        "gps": "removed",
        "orientation": "normalized",
        "xmp": "removed",
        "iptc": "removed",
        "comments": "removed",
        "maker_notes": "removed",
        "private_blocks": "removed",
        "software_device": "removed",
        "embedded_thumbnails": "removed",
        "icc_profiles": "assumed-srgb-and-tagged",
    }
    with Image.open(io.BytesIO(cleaned.data)) as opened:
        assert opened.size == (200, 320)
        assert opened.getexif().get(274, 1) == 1
    inspected_cleaned = inspect_bytes(
        cleaned.data,
        display_name="cleaned.png",
        expected_media_type="image/png",
    )
    assert inspected_cleaned.accepted is True
    assert inspected_cleaned.facts is not None
    assert inspected_cleaned.facts.orientation is None
    assert inspected_cleaned.facts.sensitive_metadata == ()

    webp_profile = profile("webp")
    webp_profile["width"] = None
    webp_profile["height"] = None
    clean_webp = engine.render(
        snapshot=single_raster_document(200, 320),
        artboard_id="artboard-export",
        assets={"asset-raster": private_asset},
        operations=[],
        profile=webp_profile,
    )
    inspected_webp = inspect_bytes(
        clean_webp.data,
        display_name="cleaned.webp",
        expected_media_type="image/webp",
    )
    assert inspected_webp.accepted is True
    assert inspected_webp.facts is not None
    assert inspected_webp.facts.orientation is None
    assert inspected_webp.facts.sensitive_metadata == ()


def test_processing_budget_fails_at_elapsed_and_resident_limits() -> None:
    times = iter((10.0, 10.1, 71.0))
    elapsed = ProcessingBudget(
        ProcessingLimits(max_seconds=60, max_rss_bytes=1024),
        clock=lambda: next(times),
        rss=lambda: 100,
    )
    elapsed.check("first")
    with pytest.raises(TimeoutError, match="60 seconds"):
        elapsed.check("second")

    memory = ProcessingBudget(
        ProcessingLimits(max_seconds=60, max_rss_bytes=1024),
        clock=lambda: 20.0,
        rss=lambda: 1025,
    )
    with pytest.raises(MemoryError, match="0 MiB"):
        memory.check("decode")


def test_process_memory_accounting_is_available_and_monotonic() -> None:
    current = _process_rss_bytes()
    peak = process_peak_rss_bytes()
    assert current > 0
    assert peak >= current


def test_engine_renders_groups_vectors_shapes_transforms_and_blends() -> None:
    document = deepcopy(snapshot())
    document["shared_assets"] = []
    document["layers"] = [
        {
            "layer_id": "group-one",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "group",
            "order": 0,
            "visible": True,
            "opacity": 0.8,
            "blend_mode": "normal",
            "transform": {
                "x": 4,
                "y": 3,
                "width": 60,
                "height": 30,
                "scale_x": 1.2,
                "scale_y": 1,
                "rotation_degrees": 5,
            },
        },
        {
            "layer_id": "group-shape",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-one",
            "layer_type": "shape",
            "order": 0,
            "visible": True,
            "opacity": 0.8,
            "blend_mode": "normal",
            "transform": {
                "x": 2,
                "y": 2,
                "width": 50,
                "height": 20,
                "scale_x": 1,
                "scale_y": 1,
                "rotation_degrees": 5,
                "flip_x": False,
                "flip_y": False,
            },
            "shape": {
                "shape": "rectangle",
                "fill": "#3559E0",
                "stroke": "#162033",
                "stroke_width": 2,
            },
        },
        {
            "layer_id": "ellipse-one",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "shape",
            "order": 1,
            "visible": True,
            "opacity": 1,
            "blend_mode": "multiply",
            "transform": {"x": 20, "y": 18, "width": 40, "height": 30},
            "shape": {
                "shape": "ellipse",
                "fill": "#56C596",
                "stroke": "#162033",
                "stroke_width": 2,
            },
        },
        {
            "layer_id": "vector-one",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "vector_svg",
            "order": 2,
            "visible": True,
            "opacity": 1,
            "blend_mode": "screen",
            "transform": {"x": 48, "y": 28, "width": 50, "height": 36},
            "vector": {
                "path_data": "M 0 0 H 10 V 10 L 0 10 Z",
                "fill": "#3559E0",
                "stroke": "#FFFFFF",
                "stroke_width": 1,
            },
        },
    ]
    rendered = DeterministicImageEngine().render(
        snapshot=document,
        artboard_id="artboard-export",
        assets={},
        operations=[],
        profile=profile("png"),
    )
    with Image.open(io.BytesIO(rendered.data)) as opened:
        assert opened.getbbox() is not None

    engine = DeterministicImageEngine()
    base = Image.new("RGBA", (24, 24), "#607080")
    line = engine._shape_layer(
        {
            "shape": "line",
            "points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}],
            "stroke": "#FFFFFF",
            "stroke_width": 2,
        },
        24,
        24,
    )
    polygon = engine._shape_layer(
        {
            "shape": "polygon",
            "points": [{"x": 0.5, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1}],
            "fill": "#E2B93B",
            "stroke_width": 1,
        },
        24,
        24,
    )
    for mode, item in (("darken", polygon), ("lighten", polygon), ("overlay", line)):
        candidate = base.copy()
        engine._composite(candidate, item, 0, 0, mode)
        assert ImageChops.difference(base, candidate).convert("RGB").getbbox() is not None


def test_internal_quadratic_and_cubic_vector_curves_change_rendered_pixels() -> None:
    engine = DeterministicImageEngine()
    common = {
        "fill": None,
        "stroke": "#3559E0",
        "stroke_width": 4,
    }
    first = engine._vector_layer(
        {**common, "path_data": "M 0 50 Q 40 0 80 50 C 100 80 120 20 150 50"},
        180,
        100,
    )
    second = engine._vector_layer(
        {**common, "path_data": "M 0 50 Q 40 90 80 50 C 100 10 120 90 150 50"},
        180,
        100,
    )
    assert first.getbbox() is not None
    assert second.getbbox() is not None
    assert hashlib.sha256(first.tobytes()).digest() != hashlib.sha256(second.tobytes()).digest()


def nested_group_document() -> dict[str, Any]:
    document = deepcopy(snapshot())
    document["shared_assets"] = []
    document["artboards"][0]["background"] = {"kind": "transparent", "color": None}
    document["layers"] = [
        {
            "layer_id": "group-root",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "group",
            "order": 0,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 8, "y": 7, "width": 70, "height": 48},
        },
        {
            "layer_id": "group-nested",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-root",
            "layer_type": "group",
            "order": 0,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 6, "y": 5, "width": 42, "height": 30},
        },
        {
            "layer_id": "shape-nested",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-nested",
            "layer_type": "shape",
            "order": 0,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 4, "y": 3, "width": 24, "height": 16},
            "shape": {"shape": "rectangle", "fill": "#3559E0", "stroke_width": 0},
        },
    ]
    return document


def test_native_nested_group_geometry_opacity_and_visibility_change_pixels() -> None:
    baseline = nested_group_document()
    baseline_sha, baseline_image = render_native(baseline)
    assert cast(tuple[int, ...], baseline_image.getpixel((19, 16)))[:3] == (53, 89, 224)
    assert cast(tuple[int, ...], baseline_image.getpixel((19, 16)))[3] == 255
    assert cast(tuple[int, ...], baseline_image.getpixel((10, 10)))[3] == 0

    variants: list[dict[str, object]] = []
    translated = deepcopy(baseline)
    translated["layers"][0]["transform"]["x"] = 20
    variants.append(translated)
    scaled = deepcopy(baseline)
    scaled["layers"][1]["transform"]["scale_x"] = 1.4
    scaled["layers"][1]["transform"]["scale_y"] = 1.2
    variants.append(scaled)
    rotated = deepcopy(baseline)
    rotated["layers"][0]["transform"]["rotation_degrees"] = 19
    variants.append(rotated)
    translucent = deepcopy(baseline)
    translucent["layers"][0]["opacity"] = 0.4
    variants.append(translucent)
    hidden = deepcopy(baseline)
    hidden["layers"][0]["visible"] = False
    variants.append(hidden)

    rendered = [render_native(item) for item in variants]
    assert len({baseline_sha, *(digest for digest, _ in rendered)}) == len(rendered) + 1
    assert rendered[3][1].getchannel("A").getextrema()[1] in range(101, 103)
    assert rendered[4][1].getchannel("A").getbbox() is None


def test_native_mask_blend_order_and_artboard_clipping_are_authoritative() -> None:
    data = source_png()
    document = deepcopy(snapshot())
    document["artboards"][0]["background"] = {"kind": "transparent", "color": None}
    document["masks"] = [
        {
            "mask_id": "mask-left-half",
            "artboard_id": "artboard-export",
            "kind": "shape",
            "path_data": "rect(0,0,0.5,1)",
            "enabled": True,
            "inverted": False,
            "feather": 0,
        }
    ]
    raster = document["layers"][0]
    raster["raster"]["mask_ids"] = ["mask-left-half"]
    shape = document["layers"][1]
    shape["transform"] = {"x": 100, "y": 65, "width": 40, "height": 30}
    masked_sha, masked = render_native(document, assets={"asset-raster": verified_asset(data)})
    assert cast(tuple[int, ...], masked.getpixel((15, 20)))[3] > 0
    assert cast(tuple[int, ...], masked.getpixel((70, 20)))[3] == 0
    assert cast(tuple[int, ...], masked.getpixel((119, 79)))[3] > 0

    unmasked = deepcopy(document)
    unmasked["layers"][0]["raster"]["mask_ids"] = []
    unmasked_sha, unmasked_image = render_native(
        unmasked, assets={"asset-raster": verified_asset(data)}
    )
    assert unmasked_sha != masked_sha
    assert cast(tuple[int, ...], unmasked_image.getpixel((70, 20)))[3] > 0

    overlapped = deepcopy(unmasked)
    overlapped["layers"][1]["transform"] = {"x": 20, "y": 18, "width": 50, "height": 36}
    normal_sha, _ = render_native(overlapped, assets={"asset-raster": verified_asset(data)})
    blended = deepcopy(overlapped)
    blended["layers"][1]["blend_mode"] = "multiply"
    multiply_sha, _ = render_native(blended, assets={"asset-raster": verified_asset(data)})
    reordered = deepcopy(overlapped)
    reordered["layers"][0]["order"] = 1
    reordered["layers"][1]["order"] = 0
    reordered_sha, _ = render_native(reordered, assets={"asset-raster": verified_asset(data)})
    assert len({normal_sha, multiply_sha, reordered_sha}) == 3


def test_native_text_shape_raster_group_mask_and_artboard_compose_deterministically() -> None:
    data = source_png()
    document = deepcopy(snapshot())
    document["artboards"][0]["background"] = {"kind": "transparent", "color": None}
    document["masks"] = [
        {
            "mask_id": "mask-raster-left",
            "artboard_id": "artboard-export",
            "kind": "shape",
            "path_data": "rect(0,0,0.5,1)",
            "enabled": True,
            "inverted": False,
            "feather": 0,
        }
    ]
    document["layers"] = [
        {
            "layer_id": "group-composition",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "group",
            "order": 0,
            "visible": True,
            "opacity": 0.8,
            "blend_mode": "normal",
            "transform": {"x": 5, "y": 8, "width": 100, "height": 60},
        },
        {
            "layer_id": "raster-masked",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-composition",
            "layer_type": "raster_image",
            "order": 0,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 0, "y": 0, "width": 70, "height": 40},
            "raster": {
                "shared_asset_id": "asset-raster",
                "crop": {"left": 0, "top": 0, "right": 1, "bottom": 1},
                "mask_ids": ["mask-raster-left"],
                "adjustments": {},
            },
        },
        {
            "layer_id": "shape-over-raster",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-composition",
            "layer_type": "shape",
            "order": 1,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 24, "y": 18, "width": 48, "height": 28},
            "shape": {"shape": "rectangle", "fill": "#E24A3B", "stroke_width": 0},
        },
        {
            "layer_id": "text-standard",
            "artboard_id": "artboard-export",
            "parent_layer_id": None,
            "layer_type": "rich_text",
            "order": 1,
            "visible": True,
            "opacity": 0.7,
            "blend_mode": "normal",
            "transform": {
                "x": 72,
                "y": 4,
                "width": 64,
                "height": 34,
                "rotation_degrees": 12,
            },
            "rich_text": {
                "text": "IPW Text",
                "runs": [],
                "font_family": "IPW Standard",
                "font_size": 18,
                "color": "#162033",
                "text_align": "left",
            },
        },
    ]
    first_sha, first = render_native(document, assets={"asset-raster": verified_asset(data)})
    second_sha, second = render_native(document, assets={"asset-raster": verified_asset(data)})
    assert first_sha == second_sha
    assert first.tobytes() == second.tobytes()
    assert first.size == (120, 80)
    assert cast(tuple[int, ...], first.getpixel((12, 14)))[3] in range(203, 205)
    assert cast(tuple[int, ...], first.getpixel((65, 14)))[3] == 0
    assert cast(tuple[int, ...], first.getpixel((35, 35)))[:3] == (226, 74, 59)
    without_text = deepcopy(document)
    without_text["layers"][-1]["visible"] = False
    without_text_sha, _ = render_native(without_text, assets={"asset-raster": verified_asset(data)})
    assert without_text_sha != first_sha


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"font_family": "Arial"}, "IPW Standard font"),
        ({"runs": [{"start": 0, "end": 3, "style": {"font_weight": "bold"}}]}, "runs"),
        ({"text_align": "justify"}, "alignment"),
        ({"text": "café"}, "glyphs outside"),
        ({"line_height": 1.2}, "typography"),
    ],
)
def test_native_text_fails_closed_for_external_or_advanced_typography(
    override: dict[str, object], message: str
) -> None:
    text: dict[str, object] = {
        "text": "IPW",
        "runs": [],
        "font_family": "IPW Standard",
        "font_size": 18,
        "color": "#162033",
        "text_align": "left",
        **override,
    }
    with pytest.raises(ValueError, match=message):
        DeterministicImageEngine()._text_layer(text, 100, 30)


def test_native_hierarchy_rejects_cross_artboard_parent_cycles_and_duplicate_order() -> None:
    engine = DeterministicImageEngine()
    cross_artboard = nested_group_document()
    cross_artboard["layers"][1]["artboard_id"] = "other-artboard"
    with pytest.raises(ValueError, match="parent is outside"):
        engine.render(
            snapshot=cross_artboard,
            artboard_id="artboard-export",
            assets={},
            operations=[],
            profile=native_profile(),
        )

    cyclic = nested_group_document()
    cyclic["layers"][0]["parent_layer_id"] = "group-nested"
    cyclic["layers"][0]["order"] = 1
    with pytest.raises(ValueError, match="cyclic"):
        engine.render(
            snapshot=cyclic,
            artboard_id="artboard-export",
            assets={},
            operations=[],
            profile=native_profile(),
        )

    duplicate_order = nested_group_document()
    duplicate = deepcopy(duplicate_order["layers"][2])
    duplicate["layer_id"] = "shape-duplicate"
    duplicate_order["layers"].append(duplicate)
    with pytest.raises(ValueError, match="sibling layer order"):
        engine.render(
            snapshot=duplicate_order,
            artboard_id="artboard-export",
            assets={},
            operations=[],
            profile=native_profile(),
        )


def source_jpeg_with_private_metadata() -> bytes:
    exif = Image.Exif()
    exif[274] = 6
    exif[270] = "Customer description"
    exif[33432] = "Customer copyright"
    exif[36867] = "2026:09:02 09:00:00"
    exif[271] = "Camera maker"
    exif[272] = "Camera model"
    gps = exif.get_ifd(34853)
    gps[1] = "N"
    gps[2] = (1.0, 2.0, 3.0)
    output = io.BytesIO()
    Image.new("RGB", (24, 16), "#56C596").save(output, "JPEG", exif=exif)
    return output.getvalue()


def test_engine_removes_gps_and_retains_only_selected_metadata_categories() -> None:
    data = source_jpeg_with_private_metadata()
    asset = VerifiedRasterAsset(
        "asset-raster",
        "source-export",
        hashlib.sha256(data).hexdigest(),
        "image/jpeg",
        len(data),
        24,
        16,
        data,
        orientation=6,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )
    selected = profile("jpeg")
    selected["metadata_policy"] = {
        "preserve_copyright": True,
        "preserve_description": True,
        "preserve_capture_time": True,
        "preserve_camera": True,
        "preserve_location": False,
        "remove_embedded_thumbnails": True,
    }
    rendered = DeterministicImageEngine().render(
        snapshot=snapshot(),
        artboard_id="artboard-export",
        assets={"asset-raster": asset},
        operations=[],
        profile=selected,
    )
    with Image.open(io.BytesIO(rendered.data)) as opened:
        exif = opened.getexif()
        assert exif.get(274, 1) == 1
        assert 274 not in exif
        assert exif[270] == "Customer description"
        assert exif[33432] == "Customer copyright"
        assert exif[36867] == "2026:09:02 09:00:00"
        assert exif[271] == "Camera maker"
        assert exif[272] == "Camera model"
        assert 34853 not in exif


def test_engine_fails_closed_for_invalid_layers_operations_profiles_and_limits() -> None:
    engine = DeterministicImageEngine()
    image = Image.new("RGBA", (8, 8), "#3559E0")
    with pytest.raises(ValueError, match="artboard"):
        engine.render(
            snapshot={}, artboard_id="missing", assets={}, operations=[], profile=profile()
        )
    with pytest.raises(ValueError, match="transform"):
        engine._transform({})
    with pytest.raises(ValueError, match="shape points"):
        engine._shape_layer({"shape": "line", "points": []}, 8, 8)
    with pytest.raises(ValueError, match="shape kind"):
        engine._shape_layer({"shape": "star"}, 8, 8)
    with pytest.raises(ValueError, match="font"):
        engine._text_layer({"text": "blocked", "font_family": "unapproved-font"}, 8, 8)
    with pytest.raises(ValueError, match="external vector"):
        engine._vector_layer({}, 8, 8)
    with pytest.raises(ValueError, match="coordinate"):
        engine._simple_path_points(["M", "1"])
    with pytest.raises(ValueError, match="command"):
        engine._simple_path_points(["Z", "1"])
    with pytest.raises(ValueError, match="operation"):
        engine._operations(image, [{"kind": "not-approved", "enabled": True, "parameters": {}}])
    with pytest.raises(ValueError, match="Display P3"):
        engine._operations(
            image,
            [
                {
                    "kind": "colour_profile_conversion",
                    "enabled": True,
                    "parameters": {"target_profile": "display-p3"},
                }
            ],
        )
    p3 = profile("png")
    p3["colour_profile"] = "display-p3"
    with pytest.raises(ValueError, match="Display P3"):
        engine._encode(image, p3, {}, [])
    unsupported = profile("png")
    unsupported["format"] = "avif"
    with pytest.raises(ValueError, match="encoder"):
        engine._encode(image, unsupported, {}, [])
    with pytest.raises(ValueError, match="dimension"):
        engine._bounded_dimension(50_001)
    with pytest.raises(ValueError, match="pixels"):
        engine._guard_pixels(50_000, 50_000)
    engine._guard_pixels(4_000, 4_000)
    assert MAX_PIXELS == 4_000 * 4_000
    with pytest.raises(ValueError, match="pixels"):
        engine._guard_pixels(4_001, 4_000)
    with pytest.raises(ValueError, match="blend"):
        engine._composite(image.copy(), image.copy(), 0, 0, "unsupported")


def test_engine_rejects_raster_identity_dimension_crop_and_missing_asset() -> None:
    engine = DeterministicImageEngine()
    data = source_png()
    valid = verified_asset(data)
    with pytest.raises(ValueError, match="identity"):
        engine._raster_layer(
            VerifiedRasterAsset(
                "asset-raster",
                "source-export",
                "0" * 64,
                "image/png",
                len(data),
                24,
                16,
                data,
                bit_depth=8,
                frame_count=1,
                has_icc_profile=False,
                colour_model="rgb",
            ),
            {"crop": {}},
            20,
            20,
        )
    with pytest.raises(ValueError, match="dimensions"):
        engine._raster_layer(
            VerifiedRasterAsset(
                "asset-raster",
                "source-export",
                valid.sha256,
                "image/png",
                len(data),
                25,
                16,
                data,
                bit_depth=8,
                frame_count=1,
                has_icc_profile=False,
                colour_model="rgb",
            ),
            {"crop": {}},
            20,
            20,
        )
    with pytest.raises(ValueError, match="positive area"):
        engine._raster_layer(
            valid, {"crop": {"left": 1, "right": 0, "top": 0, "bottom": 1}}, 20, 20
        )
    document = deepcopy(snapshot())
    with pytest.raises(ValueError, match="verified immutable source"):
        engine.render(
            snapshot=document,
            artboard_id="artboard-export",
            assets={},
            operations=[],
            profile=profile(),
        )


def test_native_export_structural_guards_reject_unsupported_documents() -> None:
    engine = DeterministicImageEngine()
    board_id = "artboard-export"

    def layer(
        layer_id: str,
        *,
        kind: str = "shape",
        parent: str | None = None,
        order: int = 0,
        **values: Any,
    ) -> dict[str, Any]:
        return {
            "layer_id": layer_id,
            "artboard_id": board_id,
            "parent_layer_id": parent,
            "layer_type": kind,
            "order": order,
            "visible": True,
            "opacity": 1,
            "blend_mode": "normal",
            "transform": {"x": 0, "y": 0, "width": 10, "height": 10},
            "shape": {"shape": "rectangle", "fill": "#ffffff"},
            **values,
        }

    hidden_parent = layer("hidden", kind="group", visible=False)
    visible_child = layer("child", parent="hidden")
    assert _effectively_visible_layers({"layers": [hidden_parent, visible_child]}, board_id) == []
    with pytest.raises(ValueError, match="cyclic"):
        _effectively_visible_layers({"layers": [layer("self", parent="self")]}, board_id)
    with pytest.raises(ValueError, match="outside"):
        _effectively_visible_layers({"layers": [layer("orphan", parent="missing")]}, board_id)

    with pytest.raises(ValueError, match="contract validation"):
        engine.render(
            snapshot=snapshot(),
            artboard_id=board_id,
            assets={},
            operations=[{"kind": "not-an-operation"}],
            profile=native_profile(),
        )
    with pytest.raises(ValueError, match="artboard is not present"):
        engine.render(
            snapshot={"artboards": [], "layers": []},
            artboard_id=board_id,
            assets={},
            operations=[],
            profile=native_profile(),
        )

    budget = ProcessingBudget(clock=lambda: 0, rss=lambda: 0)
    canvas = Image.new("RGBA", (20, 20))
    colour_settings = engine._colour_settings([], native_profile(), {})
    hidden = layer("hidden-render", visible=False)
    engine._render_layer(
        canvas, hidden, {"hidden-render": hidden}, {}, 1, {}, colour_settings, budget
    )
    unidentified = layer("")
    with pytest.raises(ValueError, match="unidentified"):
        engine._render_layer(
            canvas, unidentified, {"": unidentified}, {}, 1, {}, colour_settings, budget
        )
    unsupported = layer("unsupported", kind="external_object", shape=None)
    with pytest.raises(ValueError, match="no approved"):
        engine._render_layer(
            canvas,
            unsupported,
            {"unsupported": unsupported},
            {},
            1,
            {},
            colour_settings,
            budget,
        )

    transformed, _, _ = engine._transform_item(
        Image.new("RGBA", (4, 3)),
        {
            "flip_x": True,
            "flip_y": True,
            "scale_x": 2,
            "scale_y": 2,
            "rotation_degrees": 0,
        },
        {"opacity": 1},
    )
    assert transformed.size == (8, 6)
    with pytest.raises(ValueError, match="opacity"):
        engine._transform_item(
            Image.new("RGBA", (2, 2)),
            {"scale_x": 1, "scale_y": 1, "rotation_degrees": 0},
            {"opacity": 2},
        )

    structural_cases = (
        {"layers": [layer("")]},
        {"layers": [layer("parent"), layer("child", parent="parent", order=1)]},
        {
            "layers": [
                layer("nonfinite", transform={"x": float("nan"), "y": 0, "width": 1, "height": 1})
            ]
        },
        {"layers": [layer("empty", transform={"x": 0, "y": 0, "width": 0, "height": 1})]},
        {
            "layers": [
                layer("scale", transform={"x": 0, "y": 0, "width": 1, "height": 1, "scale_x": 0})
            ]
        },
        {
            "layers": [
                layer(
                    "skew", transform={"x": 0, "y": 0, "width": 1, "height": 1, "skew_x_degrees": 1}
                )
            ]
        },
        {"layers": [layer("styled", shared_style_ids=["style-external"])]},
        {
            "layers": [
                layer(
                    "vector-external",
                    kind="vector_svg",
                    shape=None,
                    vector={"shared_asset_id": "external"},
                )
            ]
        },
        {
            "layers": [
                layer(
                    "vector-subpaths",
                    kind="vector_svg",
                    shape=None,
                    vector={"path_data": "M 0 0 M 1 1"},
                )
            ]
        },
        {"layers": [], "masks": [{"mask_id": "", "artboard_id": board_id}]},
        {
            "layers": [
                layer(
                    "two-masks",
                    kind="raster_image",
                    shape=None,
                    raster={"shared_asset_id": "asset", "mask_ids": ["one", "two"]},
                )
            ],
            "masks": [
                {"mask_id": "one", "artboard_id": board_id},
                {"mask_id": "two", "artboard_id": board_id},
            ],
        },
        {
            "layers": [
                layer(
                    "missing-mask",
                    kind="raster_image",
                    shape=None,
                    raster={"shared_asset_id": "asset", "mask_ids": ["missing"]},
                )
            ],
            "masks": [],
        },
    )
    for document in structural_cases:
        with pytest.raises(ValueError):
            engine._validate_snapshot(document, board_id)


def test_profile_colour_and_mask_guards_cover_every_supported_boundary() -> None:
    engine = DeterministicImageEngine()
    data = source_png()
    asset = verified_asset(data)
    document = single_raster_document()

    def rejected_profile(**changes: Any) -> None:
        value = native_profile()
        value.update(changes)
        with pytest.raises(ValueError):
            engine._validate_profile(document, "artboard-export", {"asset-raster": asset}, value)

    rejected_profile(format="avif")
    rejected_profile(format="png", lossless=False)
    rejected_profile(format="jpeg", lossless=False, quality=None)
    rejected_profile(format="webp", lossless=True, quality=80)
    rejected_profile(format="webp", physical_width=1)
    rejected_profile(fit="outside")

    preserve_with_native = deepcopy(snapshot())
    with pytest.raises(ValueError, match="one raster source"):
        engine._validate_profile(
            preserve_with_native,
            "artboard-export",
            {"asset-raster": replace(asset, has_icc_profile=True)},
            {**native_profile(), "colour_profile": "preserve"},
        )
    solid_document = deepcopy(snapshot())
    solid_document["layers"] = [solid_document["layers"][0]]
    with pytest.raises(ValueError, match="transparent"):
        engine._validate_profile(
            solid_document,
            "artboard-export",
            {"asset-raster": replace(asset, has_icc_profile=True)},
            {**native_profile(), "colour_profile": "preserve"},
        )

    def conversion(target: str = "srgb", order: int = 0, **parameters: Any) -> dict[str, Any]:
        return {
            "kind": "colour_profile_conversion",
            "order": order,
            "enabled": True,
            "parameters": {"target_profile": target, **parameters},
        }

    colour_cases = (
        ([conversion(), conversion(order=1)], native_profile(), {"one": asset}),
        (
            [
                {"kind": "contrast", "order": 0, "enabled": True, "parameters": {}},
                conversion(order=1),
            ],
            native_profile(),
            {"one": asset},
        ),
        ([conversion("preserve")], native_profile(), {"one": asset}),
        (
            [conversion("display-p3")],
            {**native_profile(), "colour_profile": "display-p3"},
            {"one": asset},
        ),
        (
            [conversion("unknown")],
            {**native_profile(), "colour_profile": "unknown"},
            {"one": asset},
        ),
        (
            [conversion("preserve")],
            {**native_profile(), "colour_profile": "preserve"},
            {"one": asset, "two": replace(asset, shared_asset_id="two")},
        ),
        ([conversion(rendering_intent="unsupported")], native_profile(), {"one": asset}),
    )
    for recipe, output_profile, assets in colour_cases:
        with pytest.raises(ValueError):
            engine._colour_settings(recipe, output_profile, assets)

    image = Image.new("RGBA", (10, 10), "#ffffff")
    raster = {"raster": {"mask_ids": ["mask"]}}
    with pytest.raises(ValueError, match="missing"):
        engine._apply_masks(image, raster, {"masks": []})
    disabled = {"mask_id": "mask", "enabled": False}
    assert engine._apply_masks(image, raster, {"masks": [disabled]}).getbbox() == image.getbbox()
    for mask in (
        {"mask_id": "mask", "kind": "vector", "feather": 0},
        {"mask_id": "mask", "kind": "shape", "feather": 0, "path_data": "M 0 0"},
        {"mask_id": "mask", "kind": "shape", "feather": 0, "path_data": "rect(0,0,2,1)"},
        {"mask_id": "mask", "kind": "shape", "feather": 0, "path_data": "rect(.1,.1,.1,.1)"},
    ):
        with pytest.raises(ValueError):
            engine._apply_masks(Image.new("RGBA", (1, 1), "#ffffff"), raster, {"masks": [mask]})
    masked = engine._apply_masks(
        image,
        raster,
        {
            "masks": [
                {
                    "mask_id": "mask",
                    "kind": "shape",
                    "feather": 0,
                    "path_data": "ellipse(0,0,1,1)",
                    "inverted": True,
                }
            ]
        },
    )
    assert cast(tuple[int, ...], masked.getpixel((5, 5)))[3] == 0


def test_raster_text_shape_vector_and_operation_guards_are_executable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = DeterministicImageEngine()
    data = source_png()
    asset = verified_asset(data)

    with monkeypatch.context() as patch:
        patch.setattr(enhancement_engine, "MAX_COMPRESSED_SOURCE_BYTES", 1)
        with pytest.raises(ValueError, match="byte capacity"):
            engine._raster_layer(asset, {"crop": {}}, 10, 10)
    for changed in (
        {"bit_depth": None},
        {"frame_count": 2},
        {"colour_model": "unknown"},
        {"colour_model": "cmyk", "has_icc_profile": False},
        {"media_type": "image/jpeg"},
        {"colour_model": "indexed"},
        {"has_icc_profile": True},
    ):
        with pytest.raises(ValueError):
            engine._raster_layer(replace(asset, **changed), {"crop": {}}, 10, 10)

    private = metadata_jpeg()
    private_asset = VerifiedRasterAsset(
        "asset-raster",
        "source-private",
        hashlib.sha256(private).hexdigest(),
        "image/jpeg",
        len(private),
        320,
        200,
        private,
        orientation=6,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )
    for orientation in (None, 3):
        with pytest.raises(ValueError, match="orientation"):
            engine._raster_layer(
                replace(private_asset, orientation=orientation), {"crop": {}}, 10, 10
            )

    with pytest.raises(ValueError, match="shape geometry"):
        engine._shape_layer({"shape": "rectangle", "stroke_width": float("nan")}, 10, 10)
    with pytest.raises(ValueError, match="normalized bounds"):
        engine._shape_layer(
            {"shape": "line", "points": [{"x": -1, "y": 0}, {"x": 1, "y": 1}]},
            10,
            10,
        )
    for text in (
        {"text": None},
        {"text": "valid", "font_size": 0},
        {"text": "valid", "color": "blue"},
    ):
        with pytest.raises(ValueError):
            engine._validate_text(text)

    with monkeypatch.context() as patch:
        patch.setattr(ImageFont, "load_default", lambda **_values: object())
        with pytest.raises(RuntimeError, match="TrueType"):
            engine._text_layer({"text": "valid"}, 20, 10)

    for vector in (
        {"path_data": "M 0 0 R 1 1"},
        {"path_data": "M 0 0"},
        {"path_data": "M 0 0 L 1e999 1"},
        {"path_data": "M 0 0 L 1 1", "stroke_width": float("nan")},
    ):
        with pytest.raises(ValueError):
            engine._vector_layer(vector, 10, 10)

    image = Image.new("RGBA", (10, 8), "#ffffff")
    with pytest.raises(ValueError, match="orientation normalization"):
        engine._operations(
            image,
            [{"kind": "orientation_normalize", "parameters": {"source_orientation": 1}}],
        )
    rotated = engine._operations(
        image,
        [{"kind": "rotate", "parameters": {"degrees": 10, "expand_canvas": False}}],
    )
    assert rotated.size == image.size
    with pytest.raises(ValueError, match="axis"):
        engine._operations(image, [{"kind": "flip", "parameters": {}}])
    assert (
        engine._operations(
            image, [{"kind": "flip", "parameters": {"horizontal": True, "vertical": True}}]
        ).size
        == image.size
    )
    assert (
        engine._operations(image, [{"kind": "grayscale", "parameters": {"method": "average"}}]).mode
        == "RGBA"
    )
    with pytest.raises(ValueError, match="grayscale"):
        engine._operations(image, [{"kind": "grayscale", "parameters": {"method": "unsupported"}}])
    with pytest.raises(ValueError, match="edge preservation"):
        engine._operations(
            image,
            [
                {
                    "kind": "noise_reduction",
                    "parameters": {"strength": 10, "preserve_edges": 101},
                }
            ],
        )


class FakeStore:
    def __init__(self, source: bytes) -> None:
        self.values = {"immutable/workspace-export/source": source}

    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        data = self.values[ref.object_key]
        assert len(data) <= max_bytes
        assert hashlib.sha256(data).hexdigest() == generation
        return PrivateObjectSnapshot(ref, generation, "application/octet-stream", data)

    def write_derivative(
        self,
        ref: PrivateObjectRef,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
        max_bytes: int = 16 * 1024 * 1024,
    ) -> PrivateObjectSnapshot:
        assert ref.zone is ObjectZone.DERIVATIVE
        assert len(data) <= max_bytes
        assert hashlib.sha256(data).hexdigest() == sha256
        prior = self.values.setdefault(ref.object_key, data)
        assert prior == data
        return PrivateObjectSnapshot(ref, sha256, media_type, data)

    def delete(self, ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        current = self.values.get(ref.object_key)
        if current is None:
            return
        if generation is not None and hashlib.sha256(current).hexdigest() != generation:
            raise RuntimeError("generation changed")
        del self.values[ref.object_key]


class FakeRepository:
    def __init__(self, lease: LeasedImageExportJob) -> None:
        self.lease = lease
        self.states = {item.output_id: "queued" for item in lease.outputs}
        self.completed: list[StoredExportOutput] = []
        self.bundle_lease: LeasedExportBundleJob | None = None
        self.bundle: StoredExportBundle | None = None

    def claim_image_export(self, **_: object) -> LeasedImageExportJob | None:
        return self.lease

    def start_image_export(self, lease: LeasedImageExportJob) -> None:
        assert lease is self.lease

    def heartbeat_image_export(self, lease: LeasedImageExportJob) -> None:
        assert lease is self.lease

    def cancellation_requested_image_export(self, _lease: LeasedImageExportJob) -> bool:
        return False

    def start_export_output(self, _lease: LeasedImageExportJob, output_id: str) -> None:
        self.states[output_id] = "running"

    def complete_export_output(
        self, _lease: LeasedImageExportJob, stored: StoredExportOutput
    ) -> None:
        self.states[stored.output_id] = "succeeded"
        self.completed.append(stored)

    def fail_export_output(
        self, _lease: LeasedImageExportJob, output_id: str, *, code: str, message: str
    ) -> None:
        assert code
        assert message
        self.states[output_id] = "failed"

    def checkpoint_image_export(
        self, _lease: LeasedImageExportJob, key: str, payload: dict[str, object]
    ) -> None:
        assert key
        assert payload["sha256"]

    def finish_image_export(self, _lease: LeasedImageExportJob) -> str:
        return "partially_completed" if "failed" in self.states.values() else "completed"

    def fail_image_export(
        self, _lease: LeasedImageExportJob, *, code: str, message: str, retryable: bool
    ) -> str:
        raise AssertionError((code, message, retryable))

    def claim_export_bundle(self, **_: object) -> LeasedExportBundleJob | None:
        return self.bundle_lease

    def start_export_bundle(self, lease: LeasedExportBundleJob) -> None:
        assert lease is self.bundle_lease

    def heartbeat_export_bundle(self, lease: LeasedExportBundleJob) -> None:
        assert lease is self.bundle_lease

    def cancellation_requested_export_bundle(self, _lease: LeasedExportBundleJob) -> bool:
        return False

    def complete_export_bundle(
        self, _lease: LeasedExportBundleJob, stored: StoredExportBundle
    ) -> None:
        self.bundle = stored

    def fail_export_bundle(
        self, _lease: LeasedExportBundleJob, *, code: str, message: str, retryable: bool
    ) -> str:
        raise AssertionError((code, message, retryable))


def export_lease(data: bytes) -> LeasedImageExportJob:
    source = ExportAssetReference(
        "asset-raster",
        "source-export",
        "immutable/workspace-export/source",
        hashlib.sha256(data).hexdigest(),
        hashlib.sha256(data).hexdigest(),
        "image/png",
        len(data),
        24,
        16,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )
    return LeasedImageExportJob(
        "job-export",
        "export-request",
        "workspace-export",
        "actor-export",
        "document-export",
        "version-export",
        "recipe-export",
        1,
        [],
        snapshot(),
        (source,),
        (
            ExportOutputTarget("output-png", "artboard-export", "export.png", profile("png")),
            ExportOutputTarget(
                "output-16bit", "artboard-export", "export-16.png", profile("png", bit_depth=16)
            ),
        ),
        "lease-hash",
        "trace-export",
        1,
        3,
    )


def test_durable_export_isolates_output_failure_and_zip_is_reproducible() -> None:
    data = source_png()
    store = FakeStore(data)
    repository = FakeRepository(export_lease(data))
    outcome = DurableImageExportProcessor(repository, store, worker_id="worker-export").process(
        DispatchMessage("dispatch-export", "job-export", "trace-export")
    )
    assert outcome.state == "succeeded"
    assert repository.states == {"output-png": "succeeded", "output-16bit": "failed"}
    completed = repository.completed[0]
    assert completed.object_key.endswith("/output-png/attempt-1-lease-hash/result.png")
    assert "export.png" not in completed.object_key
    repository.bundle_lease = LeasedExportBundleJob(
        "job-bundle",
        "bundle-export",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            BundleItem(
                "output-png",
                "export.png",
                completed.object_key,
                completed.storage_generation,
                completed.rendered.sha256,
                len(completed.rendered.data),
                completed.rendered.media_type,
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "bundle-lease",
        "trace-export",
        1,
        3,
    )
    processor = DurableExportBundleProcessor(repository, store, worker_id="worker-export")
    assert (
        processor.process(DispatchMessage("dispatch-bundle", "job-bundle", "trace-export")).state
        == "succeeded"
    )
    first = repository.bundle
    assert first is not None
    repository.bundle = None
    assert (
        processor.process(DispatchMessage("dispatch-bundle", "job-bundle", "trace-export")).state
        == "succeeded"
    )
    second = cast(StoredExportBundle, repository.bundle)
    assert second.data == first.data
    with zipfile.ZipFile(io.BytesIO(first.data)) as archive:
        assert archive.namelist() == ["export.png", "manifest.json"]
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["items"][0]["sha256"] == completed.rendered.sha256


def test_durable_export_uses_one_budget_before_reads_and_across_all_outputs() -> None:
    class RecordingEngine(DeterministicImageEngine):
        def __init__(self) -> None:
            self.budget_ids: list[int] = []

        def render(self, **values: Any) -> Any:
            self.budget_ids.append(id(values["budget"]))
            return super().render(**values)

    data = source_png()
    repository = FakeRepository(export_lease(data))
    engine = RecordingEngine()
    factory_calls = 0
    stages: list[str] = []

    def budget_factory(checkpoint: Callable[[str], None]) -> ProcessingBudget:
        nonlocal factory_calls
        factory_calls += 1

        def record(stage: str) -> None:
            stages.append(stage)
            checkpoint(stage)

        return ProcessingBudget(clock=lambda: 0.0, rss=lambda: 1, checkpoint=record)

    outcome = DurableImageExportProcessor(
        repository,
        FakeStore(data),
        worker_id="worker-budget",
        engine=engine,
        budget_factory=budget_factory,
    ).process(DispatchMessage("dispatch-export", "job-export", "trace-export"))
    assert outcome.state == "succeeded"
    assert factory_calls == 1
    assert len(engine.budget_ids) == 2
    assert len(set(engine.budget_ids)) == 1
    assert stages.index("source-read-start:asset-raster") < stages.index("validate")
    assert stages.count("job-start") == 1


class OutcomeRepository(FakeRepository):
    def __init__(self, lease: LeasedImageExportJob) -> None:
        super().__init__(lease)
        self.export_cancelled = False
        self.bundle_cancelled = False
        self.export_failure: tuple[str, str, bool] | None = None
        self.bundle_failure: tuple[str, str, bool] | None = None

    def cancellation_requested_image_export(self, _lease: LeasedImageExportJob) -> bool:
        return self.export_cancelled

    def fail_image_export(
        self, _lease: LeasedImageExportJob, *, code: str, message: str, retryable: bool
    ) -> str:
        self.export_failure = (code, message, retryable)
        return (
            "cancelled" if code == "export-cancelled" else "retry_wait" if retryable else "failed"
        )

    def cancellation_requested_export_bundle(self, _lease: LeasedExportBundleJob) -> bool:
        return self.bundle_cancelled

    def fail_export_bundle(
        self, _lease: LeasedExportBundleJob, *, code: str, message: str, retryable: bool
    ) -> str:
        self.bundle_failure = (code, message, retryable)
        return (
            "cancelled" if code == "bundle-cancelled" else "retry_wait" if retryable else "failed"
        )


class BusyRepository(OutcomeRepository):
    def claim_image_export(self, **_: object) -> LeasedImageExportJob | None:
        raise JobBusyError("owned")

    def claim_export_bundle(self, **_: object) -> LeasedExportBundleJob | None:
        raise JobBusyError("owned")


class TerminalRepository(OutcomeRepository):
    def claim_image_export(self, **_: object) -> LeasedImageExportJob | None:
        return None

    def claim_export_bundle(self, **_: object) -> LeasedExportBundleJob | None:
        return None


class IOErrorStore(FakeStore):
    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        raise OSError("temporary private storage failure")


class ChangedStore(FakeStore):
    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        data = self.values[ref.object_key] + b"changed"
        return PrivateObjectSnapshot(ref, generation, "application/octet-stream", data)


class CancelAfterWriteStore(FakeStore):
    def __init__(self, source: bytes, cancel: Callable[[], None]) -> None:
        super().__init__(source)
        self._cancel = cancel

    def write_derivative(
        self,
        ref: PrivateObjectRef,
        *,
        data: bytes,
        media_type: str,
        sha256: str,
        max_bytes: int = 16 * 1024 * 1024,
    ) -> PrivateObjectSnapshot:
        result = super().write_derivative(
            ref,
            data=data,
            media_type=media_type,
            sha256=sha256,
            max_bytes=max_bytes,
        )
        self._cancel()
        return result


def completed_bundle_lease(
    completed: StoredExportOutput, *, filename: str = "export.png"
) -> LeasedExportBundleJob:
    return LeasedExportBundleJob(
        "job-bundle",
        "bundle-export",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            BundleItem(
                "output-png",
                filename,
                completed.object_key,
                completed.storage_generation,
                completed.rendered.sha256,
                len(completed.rendered.data),
                completed.rendered.media_type,
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "bundle-lease",
        "trace-export",
        1,
        3,
    )


def test_durable_processors_report_busy_terminal_cancelled_and_temporary_states() -> None:
    data = source_png()
    message = DispatchMessage("dispatch-export", "job-export", "trace-export")
    busy = BusyRepository(export_lease(data))
    terminal = TerminalRepository(export_lease(data))
    assert (
        DurableImageExportProcessor(busy, FakeStore(data), worker_id="worker")
        .process(message)
        .state
        == "busy"
    )
    assert (
        DurableImageExportProcessor(terminal, FakeStore(data), worker_id="worker")
        .process(message)
        .state
        == "already_terminal"
    )

    cancelled = OutcomeRepository(export_lease(data))
    cancelled.export_cancelled = True
    assert (
        DurableImageExportProcessor(cancelled, FakeStore(data), worker_id="worker")
        .process(message)
        .state
        == "cancelled"
    )
    assert cancelled.export_failure == (
        "export-cancelled",
        "Image export was cancelled",
        False,
    )

    temporary = OutcomeRepository(export_lease(data))
    assert (
        DurableImageExportProcessor(temporary, IOErrorStore(data), worker_id="worker")
        .process(message)
        .state
        == "retry_wait"
    )
    assert temporary.export_failure == (
        "export-temporary-failure",
        "temporary private storage failure",
        True,
    )


def test_durable_export_fails_closed_when_immutable_source_bytes_change() -> None:
    data = source_png()
    repository = OutcomeRepository(export_lease(data))
    changed = ChangedStore(data)
    outcome = DurableImageExportProcessor(repository, changed, worker_id="worker").process(
        DispatchMessage("dispatch-export", "job-export", "trace-export")
    )
    assert outcome.state == "failed"
    assert repository.export_failure is not None
    assert repository.export_failure[0] == "export-source-integrity-failed"
    assert repository.completed == []


def test_cancellation_after_output_write_deletes_unregistered_generation() -> None:
    data = source_png()
    repository = OutcomeRepository(export_lease(data))
    store = CancelAfterWriteStore(
        data,
        lambda: setattr(repository, "export_cancelled", True),
    )
    outcome = DurableImageExportProcessor(repository, store, worker_id="worker").process(
        DispatchMessage("dispatch-export", "job-export", "trace-export")
    )
    assert outcome.state == "cancelled"
    assert repository.completed == []
    assert list(store.values) == ["immutable/workspace-export/source"]


def test_bundle_processor_reports_busy_terminal_cancel_and_validation_failures() -> None:
    data = source_png()
    store = FakeStore(data)
    source_repository = FakeRepository(export_lease(data))
    DurableImageExportProcessor(source_repository, store, worker_id="worker").process(
        DispatchMessage("dispatch-export", "job-export", "trace-export")
    )
    completed = source_repository.completed[0]
    message = DispatchMessage("dispatch-bundle", "job-bundle", "trace-export")

    busy = BusyRepository(export_lease(data))
    busy.bundle_lease = completed_bundle_lease(completed)
    terminal = TerminalRepository(export_lease(data))
    terminal.bundle_lease = completed_bundle_lease(completed)
    assert (
        DurableExportBundleProcessor(busy, store, worker_id="worker").process(message).state
        == "busy"
    )
    assert (
        DurableExportBundleProcessor(terminal, store, worker_id="worker").process(message).state
        == "already_terminal"
    )

    cancelled = OutcomeRepository(export_lease(data))
    cancelled.bundle_lease = completed_bundle_lease(completed)
    cancelled.bundle_cancelled = True
    assert (
        DurableExportBundleProcessor(cancelled, store, worker_id="worker").process(message).state
        == "cancelled"
    )
    assert cancelled.bundle_failure == (
        "bundle-cancelled",
        "ZIP preparation was cancelled",
        False,
    )

    invalid = OutcomeRepository(export_lease(data))
    invalid.bundle_lease = completed_bundle_lease(completed, filename="../escape.png")
    assert (
        DurableExportBundleProcessor(invalid, store, worker_id="worker").process(message).state
        == "failed"
    )
    assert invalid.bundle_failure is not None
    assert invalid.bundle_failure[0] == "bundle-integrity-failed"


def test_bundle_builder_rejects_empty_duplicate_and_changed_sources() -> None:
    data = source_png()
    store = FakeStore(data)
    repository = OutcomeRepository(export_lease(data))
    processor = DurableExportBundleProcessor(repository, store, worker_id="worker")
    empty = LeasedExportBundleJob(
        "job-bundle",
        "bundle",
        "export-request",
        "workspace-export",
        "actor-export",
        (),
        "2026-09-09T00:00:00+00:00",
        "lease",
        "trace",
        1,
        3,
    )
    with pytest.raises(ValueError, match="item count"):
        processor._build(empty)

    item = BundleItem(
        "output-one",
        "same.png",
        "immutable/workspace-export/source",
        hashlib.sha256(data).hexdigest(),
        hashlib.sha256(data).hexdigest(),
        len(data),
        "image/png",
    )
    duplicate = LeasedExportBundleJob(
        "job-bundle",
        "bundle",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            item,
            BundleItem(
                "output-two",
                "SAME.PNG",
                item.object_key,
                item.storage_generation,
                item.sha256,
                item.byte_size,
                item.media_type,
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "lease",
        "trace",
        1,
        3,
    )
    with pytest.raises(ValueError, match="normalization and case folding"):
        processor._build(duplicate)

    changed = LeasedExportBundleJob(
        "job-bundle",
        "bundle",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            BundleItem(
                "output-one",
                "one.png",
                item.object_key,
                item.storage_generation,
                "0" * 64,
                item.byte_size,
                item.media_type,
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "lease",
        "trace",
        1,
        3,
    )
    with pytest.raises(ValueError, match="checksum"):
        processor._build(changed)


@pytest.mark.parametrize(
    "filename",
    [
        "../escape.png",
        "..\\escape.png",
        "/absolute.png",
        "C:drive.png",
        "CON.png",
        "com1.TXT",
        "name.",
        "name ",
        "fraction\u2044slash.png",
        "control\u200bmark.png",
        f"{'e' * 241}.png",
    ],
)
def test_zip_filename_hardening_rejects_platform_and_unicode_hazards(
    filename: str,
) -> None:
    with pytest.raises(ValueError, match="unsafe"):
        DurableExportBundleProcessor._safe_name(filename)


def test_zip_rejects_canonically_equivalent_names_and_high_compression_ratio() -> None:
    data = b"0" * 4096
    store = FakeStore(data)
    digest = hashlib.sha256(data).hexdigest()
    repository = OutcomeRepository(export_lease(source_png()))
    processor = DurableExportBundleProcessor(repository, store, worker_id="worker")
    equivalent = LeasedExportBundleJob(
        "job-bundle",
        "bundle",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            BundleItem(
                "output-one",
                "caf\u00e9.png",
                "immutable/workspace-export/source",
                digest,
                digest,
                len(data),
                "image/png",
            ),
            BundleItem(
                "output-two",
                "cafe\u0301.png",
                "immutable/workspace-export/source",
                digest,
                digest,
                len(data),
                "image/png",
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "lease",
        "trace",
        1,
        3,
    )
    with pytest.raises(ValueError, match="normalization and case folding"):
        processor._build(equivalent)

    ratio = LeasedExportBundleJob(
        "job-bundle",
        "bundle",
        "export-request",
        "workspace-export",
        "actor-export",
        (
            BundleItem(
                "output-one",
                "compressible.bin",
                "immutable/workspace-export/source",
                digest,
                digest,
                len(data),
                "application/octet-stream",
            ),
        ),
        "2026-09-09T00:00:00+00:00",
        "lease",
        "trace",
        1,
        3,
    )
    with pytest.raises(ValueError, match="compression ratio"):
        processor._build(ratio)
