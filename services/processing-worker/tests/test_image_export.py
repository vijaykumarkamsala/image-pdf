from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest
from PIL import Image

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
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot


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
    assert repository.bundle is not None
    assert repository.bundle.data == first.data
    with zipfile.ZipFile(io.BytesIO(first.data)) as archive:
        assert archive.namelist() == ["export.png", "manifest.json"]
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["items"][0]["sha256"] == completed.rendered.sha256
