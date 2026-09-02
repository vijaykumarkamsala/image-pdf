# ruff: noqa: SLF001

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from copy import deepcopy
from typing import cast

import pytest
from PIL import Image, ImageChops

from ipw.processing_worker.durable_intake import DispatchMessage
from ipw.processing_worker.enhancement_engine import (
    DeterministicImageEngine,
    VerifiedRasterAsset,
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


def snapshot() -> dict[str, object]:
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
        "quality": 88,
        "lossless": format_name == "webp",
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
    )


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
            {"kind": "orientation_normalize", "order": 0, "enabled": True, "parameters": {}},
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


def test_engine_renders_groups_text_vectors_shapes_transforms_and_blends() -> None:
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
            "transform": {"x": 4, "y": 3, "width": 1, "height": 1},
        },
        {
            "layer_id": "text-one",
            "artboard_id": "artboard-export",
            "parent_layer_id": "group-one",
            "layer_type": "rich_text",
            "order": 0,
            "visible": True,
            "opacity": 0.8,
            "blend_mode": "normal",
            "transform": {
                "x": 2,
                "y": 2,
                "width": 50,
                "height": 20,
                "scale_x": 1.2,
                "scale_y": 1,
                "rotation_degrees": 5,
                "flip_x": True,
                "flip_y": True,
            },
            "rich_text": {
                "text": "Verified export",
                "font_family": "system-ui",
                "font_size": 12,
                "text_align": "justify",
                "color": "#162033",
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
        assert exif[274] == 1
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
        engine._text_layer({"font_family": "unapproved-font"}, 8, 8)
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
    with pytest.raises(ValueError, match="blend"):
        engine._composite(image.copy(), image.copy(), 0, 0, "unsupported")


def test_engine_rejects_raster_identity_dimension_crop_and_missing_asset() -> None:
    engine = DeterministicImageEngine()
    data = source_png()
    valid = verified_asset(data)
    with pytest.raises(ValueError, match="identity"):
        engine._raster_layer(
            VerifiedRasterAsset(
                "asset-raster", "source-export", "0" * 64, "image/png", len(data), 24, 16, data
            ),
            {"crop": {}},
            20,
            20,
        )
    with pytest.raises(ValueError, match="dimensions"):
        engine._raster_layer(
            VerifiedRasterAsset(
                "asset-raster", "source-export", valid.sha256, "image/png", len(data), 25, 16, data
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
    assert completed.object_key.endswith("/output-png/result.png")
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
    with pytest.raises(ValueError, match="not unique"):
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
