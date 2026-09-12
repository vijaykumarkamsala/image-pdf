from __future__ import annotations

import hashlib
import io
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, ImageCms
from pypdf import PdfReader

from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.enhancement_engine import VerifiedRasterAsset
from ipw.processing_worker.image_export import ExportAssetReference
from ipw.processing_worker.pdf_export import (
    DurablePdfExportProcessor,
    LeasedPdfExportJob,
    ScreenPdfRenderer,
    StoredPdfExport,
    safe_pdf_filename,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PrivateObjectRef, PrivateObjectSnapshot

ROOT = Path(__file__).parents[3]
FONT = ROOT / "apps" / "web" / "public" / "fonts" / "ipw-standard.ttf"


def source() -> VerifiedRasterAsset:
    output = io.BytesIO()
    Image.new("RGB", (400, 200), (20, 90, 180)).save(output, format="PNG")
    data = output.getvalue()
    return VerifiedRasterAsset(
        shared_asset_id="shared-asset-image",
        source_version_id="source-version-image",
        sha256=hashlib.sha256(data).hexdigest(),
        media_type="image/png",
        byte_size=len(data),
        width=400,
        height=200,
        data=data,
        orientation=1,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )


def profiled_source() -> VerifiedRasterAsset:
    output = io.BytesIO()
    profile_bytes = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    Image.new("RGB", (400, 200), (20, 90, 180)).save(
        output,
        format="PNG",
        icc_profile=profile_bytes,
    )
    data = output.getvalue()
    return replace(
        source(),
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        has_icc_profile=True,
    )


def transparent_source() -> VerifiedRasterAsset:
    output = io.BytesIO()
    Image.new("RGBA", (400, 200), (20, 90, 180, 128)).save(output, format="PNG")
    data = output.getvalue()
    return replace(
        source(),
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
    )


def snapshot() -> dict[str, Any]:
    pages = [
        {
            "artboard_id": "page-image",
            "name": "Page 1",
            "order": 0,
            "width": 595.2756,
            "height": 841.8898,
            "unit": "pt",
            "background": {"kind": "solid", "color": "#ffffff"},
        },
        {
            "artboard_id": "page-text",
            "name": "Page 2",
            "order": 1,
            "width": 595.2756,
            "height": 841.8898,
            "unit": "pt",
            "background": {"kind": "solid", "color": "#f6f7fb"},
        },
    ]
    transform = {
        "x": 40,
        "y": 60,
        "width": 515.2756,
        "height": 257.6378,
        "rotation_degrees": 0,
        "scale_x": 1,
        "scale_y": 1,
        "skew_x_degrees": 0,
        "skew_y_degrees": 0,
        "flip_x": False,
        "flip_y": False,
    }
    return {
        "document_id": "document-pdf",
        "revision": 0,
        "artboards": pages,
        "layers": [
            {
                "layer_id": "layer-image",
                "artboard_id": "page-image",
                "parent_layer_id": None,
                "layer_type": "raster_image",
                "name": "Image",
                "order": 0,
                "visible": True,
                "transform": transform,
                "raster": {
                    "shared_asset_id": "shared-asset-image",
                    "crop": {"left": 0, "top": 0, "right": 1, "bottom": 1},
                },
            },
            {
                "layer_id": "layer-title",
                "artboard_id": "page-text",
                "parent_layer_id": None,
                "layer_type": "rich_text",
                "name": "Title",
                "order": 0,
                "visible": True,
                "transform": {**transform, "width": 300, "height": 60},
                "rich_text": {
                    "text": "Hello Screen PDF",
                    "font_family": "IPW Standard",
                    "font_size": 24,
                    "color": "#14213d",
                    "runs": [],
                },
            },
        ],
        "shared_assets": [
            {
                "shared_asset_id": "shared-asset-image",
                "kind": "raster",
                "source_version_id": "source-version-image",
            }
        ],
        "pdf_settings": {
            "title": "Product brief",
            "language": "en",
            "subject": None,
            "pages": [
                {"artboard_id": "page-image", "label": "1"},
                {"artboard_id": "page-text", "label": "2"},
            ],
        },
    }


def profile() -> dict[str, object]:
    return {
        "profile_id": "screen",
        "profile_version": "1.0.0",
        "tagged_pdf": False,
        "archival_conformance": None,
        "colour_space": "srgb",
        "image_quality": 90,
        "metadata_policy": "safe",
    }


def lease(asset: VerifiedRasterAsset | None = None) -> LeasedPdfExportJob:
    selected = asset or source()
    reference = ExportAssetReference(
        shared_asset_id=selected.shared_asset_id,
        source_version_id=selected.source_version_id,
        object_key="immutable/workspace-pdf/source.png",
        storage_generation="17",
        sha256=selected.sha256,
        media_type=selected.media_type,
        byte_size=selected.byte_size,
        width=selected.width,
        height=selected.height,
        orientation=selected.orientation,
        bit_depth=selected.bit_depth,
        frame_count=selected.frame_count,
        has_icc_profile=selected.has_icc_profile,
        colour_model=selected.colour_model,
    )
    return LeasedPdfExportJob(
        job_id="job-pdf",
        pdf_export_request_id="pdf-export-request",
        workspace_id="workspace-pdf",
        actor_id="actor-pdf",
        document_id="document-pdf",
        document_version_id="document-version-pdf",
        document_name="Customer / brief",
        snapshot_sha256="a" * 64,
        profile=profile(),
        preflight={"state": "ready"},
        snapshot=snapshot(),
        assets=(reference,),
        lease_token_hash="b" * 64,
        trace_id="trace-pdf",
        attempt=1,
        max_attempts=3,
    )


class PdfRepository:
    def __init__(self, selected: LeasedPdfExportJob) -> None:
        self.lease = selected
        self.terminal = False
        self.cancel = False
        self.busy = False
        self.complete_busy = False
        self.started = False
        self.stored: StoredPdfExport | None = None
        self.failures: list[tuple[str, bool]] = []

    def claim_pdf_export(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> LeasedPdfExportJob | None:
        assert job_id == self.lease.job_id
        assert worker_id
        assert lease_token
        assert trace_id
        if self.busy:
            raise JobBusyError("busy")
        return None if self.terminal else self.lease

    def start_pdf_export(self, selected: LeasedPdfExportJob) -> None:
        assert selected is self.lease
        self.started = True

    def heartbeat_pdf_export(self, selected: LeasedPdfExportJob) -> None:
        assert selected is self.lease

    def cancellation_requested_pdf_export(self, selected: LeasedPdfExportJob) -> bool:
        assert selected is self.lease
        return self.cancel

    def complete_pdf_export(self, selected: LeasedPdfExportJob, stored: StoredPdfExport) -> None:
        assert selected is self.lease
        if self.complete_busy:
            raise JobBusyError("lease changed")
        self.stored = stored
        self.terminal = True

    def fail_pdf_export(
        self,
        selected: LeasedPdfExportJob,
        *,
        code: str,
        message: str,
        retryable: bool,
    ) -> str:
        assert selected is self.lease
        assert message
        self.failures.append((code, retryable))
        self.terminal = not retryable
        if code == "pdf-export-cancelled":
            return "cancelled"
        return "retry_wait" if retryable else "failed"


class PdfObjects:
    def __init__(self, data: bytes, read_error: OSError | None = None) -> None:
        self.data = data
        self.read_error = read_error
        self.deleted: list[tuple[PrivateObjectRef, str | None]] = []

    def read(
        self, ref: PrivateObjectRef, *, generation: str, max_bytes: int
    ) -> PrivateObjectSnapshot:
        if self.read_error:
            raise self.read_error
        assert ref.zone is ObjectZone.IMMUTABLE
        assert generation == "17"
        assert len(self.data) <= max_bytes
        return PrivateObjectSnapshot(ref, generation, "image/png", self.data)

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
        assert media_type == "application/pdf"
        assert hashlib.sha256(data).hexdigest() == sha256
        assert len(data) <= max_bytes
        return PrivateObjectSnapshot(ref, "23", media_type, data)

    def delete(self, ref: PrivateObjectRef, *, generation: str | None = None) -> None:
        self.deleted.append((ref, generation))


def processor(repository: PdfRepository, objects: PdfObjects) -> DurablePdfExportProcessor:
    return DurablePdfExportProcessor(
        repository,
        objects,
        worker_id="worker-pdf",
        font_path=FONT,
    )


def test_screen_renderer_emits_valid_pages_text_and_pinned_identity() -> None:
    rendered = ScreenPdfRenderer(FONT).render(
        snapshot=snapshot(),
        profile=profile(),
        assets={"shared-asset-image": source()},
    )
    reader = PdfReader(io.BytesIO(rendered.data), strict=True)
    assert rendered.page_count == 2
    assert len(reader.pages) == 2
    assert float(reader.pages[0].mediabox.width) == pytest.approx(595.2756, abs=0.01)
    assert "Hello Screen PDF" in reader.pages[1].extract_text()
    assert rendered.renderer["licence_component_ids"] == [
        "reportlab",
        "pypdf",
        "pillow",
        "aileron-ipw-standard",
    ]
    assert rendered.sha256 == hashlib.sha256(rendered.data).hexdigest()
    repeated = ScreenPdfRenderer(FONT).render(
        snapshot=snapshot(),
        profile=profile(),
        assets={"shared-asset-image": source()},
    )
    assert repeated.data == rendered.data


def test_screen_renderer_converts_verified_embedded_colour_profiles_to_srgb() -> None:
    profiled = profiled_source()
    rendered = ScreenPdfRenderer(FONT).render(
        snapshot=snapshot(),
        profile=profile(),
        assets={"shared-asset-image": profiled},
    )
    assert rendered.data.startswith(b"%PDF-")
    with pytest.raises(ValueError, match="profile no longer matches verified facts"):
        ScreenPdfRenderer(FONT).render(
            snapshot=snapshot(),
            profile=profile(),
            assets={"shared-asset-image": replace(profiled, has_icc_profile=False)},
        )


def test_screen_renderer_preserves_transparency_after_a_bounded_crop() -> None:
    document = snapshot()
    document["layers"][0]["raster"]["crop"] = {
        "left": 0.25,
        "top": 0.25,
        "right": 0.75,
        "bottom": 0.75,
    }
    rendered = ScreenPdfRenderer(FONT).render(
        snapshot=document,
        profile=profile(),
        assets={"shared-asset-image": transparent_source()},
    )
    assert rendered.data.startswith(b"%PDF-")


def test_screen_renderer_rejects_claims_outside_screen_profile() -> None:
    altered = profile()
    altered["tagged_pdf"] = True
    with pytest.raises(ValueError, match="tagged or archival"):
        ScreenPdfRenderer(FONT).render(
            snapshot=snapshot(),
            profile=altered,
            assets={"shared-asset-image": source()},
        )


@pytest.mark.parametrize(
    ("case", "message"),
    [
        ("page-count", "invalid page count"),
        ("page-order", "page order is not contiguous"),
        ("page-map", "page settings do not match"),
        ("page-unit", "page dimensions are invalid"),
        ("group", "layer unavailable"),
        ("opacity", "unsupported layer appearance"),
        ("linked-style", "unsupported layer appearance"),
        ("adjustment", "unsupported raster processing"),
        ("shape", "unsupported shape"),
        ("font", "unsupported typography"),
        ("missing-asset", "unavailable verified raster source"),
    ],
)
def test_screen_renderer_revalidates_immutable_snapshot_state(case: str, message: str) -> None:
    document = snapshot()
    layer = document["layers"][0]
    if case == "page-count":
        document["artboards"] = []
    elif case == "page-order":
        document["artboards"][1]["order"] = 3
    elif case == "page-map":
        document["pdf_settings"]["pages"] = []
    elif case == "page-unit":
        document["artboards"][0]["unit"] = "px"
    elif case == "group":
        layer["layer_type"] = "group"
        layer["group"] = {"child_layer_ids": []}
        layer.pop("raster")
    elif case == "opacity":
        layer["opacity"] = 0.5
    elif case == "linked-style":
        layer["shared_style_ids"] = ["style-linked"]
    elif case == "adjustment":
        layer["raster"]["adjustments"] = {"brightness": 1}
    elif case == "shape":
        layer["layer_type"] = "shape"
        layer["shape"] = {"shape": "ellipse", "corner_radius": 0, "fill": "#ffffff"}
        layer.pop("raster")
    elif case == "font":
        text = document["layers"][1]["rich_text"]
        text["font_family"] = "Unapproved"
    elif case == "missing-asset":
        layer["raster"]["shared_asset_id"] = "shared-asset-missing"

    with pytest.raises(ValueError, match=message):
        ScreenPdfRenderer(FONT).render(
            snapshot=document,
            profile=profile(),
            assets={"shared-asset-image": source()},
        )


@pytest.mark.parametrize(
    ("selected", "message"),
    [
        (replace(source(), sha256="0" * 64), "source bytes no longer match"),
        (replace(source(), media_type="image/jpeg"), "format no longer matches"),
        (replace(source(), width=401), "dimensions no longer match"),
        (replace(source(), frame_count=2), "single-frame source"),
        (replace(source(), bit_depth=16), "8-bit source"),
        (replace(source(), colour_model="cmyk"), "colour model is not enabled"),
    ],
)
def test_screen_renderer_rechecks_decoded_source_facts(
    selected: VerifiedRasterAsset, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        ScreenPdfRenderer(FONT).render(
            snapshot=snapshot(),
            profile=profile(),
            assets={"shared-asset-image": selected},
        )


@pytest.mark.parametrize("alignment", ["center", "right"])
def test_screen_renderer_draws_supported_shapes_transforms_and_text_alignment(
    alignment: str,
) -> None:
    document = snapshot()
    image_layer = document["layers"][0]
    image_layer["transform"]["rotation_degrees"] = 15
    image_layer["transform"]["flip_x"] = True
    image_layer["transform"]["flip_y"] = True
    text_layer = document["layers"][1]
    text_layer["rich_text"]["text"] = "Aligned\ntext"
    text_layer["rich_text"]["text_align"] = alignment
    document["layers"].append(
        {
            "layer_id": "layer-shape",
            "artboard_id": "page-text",
            "parent_layer_id": None,
            "layer_type": "shape",
            "name": "Rule",
            "order": 1,
            "visible": True,
            "transform": {
                "x": 40,
                "y": 150,
                "width": 200,
                "height": 20,
                "rotation_degrees": 0,
                "scale_x": 1,
                "scale_y": 1,
                "skew_x_degrees": 0,
                "skew_y_degrees": 0,
                "flip_x": False,
                "flip_y": False,
            },
            "shape": {
                "shape": "rectangle",
                "fill": "#3559e0",
                "stroke": "#14213d",
                "stroke_width": 2,
                "corner_radius": 0,
            },
        }
    )

    rendered = ScreenPdfRenderer(FONT).render(
        snapshot=document,
        profile=profile(),
        assets={"shared-asset-image": source()},
    )
    assert rendered.data.startswith(b"%PDF-")


def test_screen_renderer_refuses_unapproved_dependency_or_font_identity(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("ipw.processing_worker.pdf_export.reportlab.Version", "different")
    with pytest.raises(RuntimeError, match="dependencies do not match"):
        ScreenPdfRenderer(FONT)
    monkeypatch.setattr("ipw.processing_worker.pdf_export.reportlab.Version", "5.0.1")
    unapproved = tmp_path / "unapproved.ttf"
    unapproved.write_bytes(b"not-the-standard-font")
    with pytest.raises(RuntimeError, match="font does not match"):
        ScreenPdfRenderer(unapproved)


def test_durable_pdf_export_publishes_once_and_redelivery_is_terminal() -> None:
    selected = lease()
    repository = PdfRepository(selected)
    objects = PdfObjects(source().data)
    worker = processor(repository, objects)
    message = DispatchMessage("dispatch-pdf", selected.job_id, selected.trace_id)

    assert worker.process(message) == WorkerOutcome("succeeded", selected.job_id)
    assert repository.started
    assert repository.stored is not None
    assert repository.stored.filename == "Customer _ brief.pdf"
    assert repository.stored.rendered.data.startswith(b"%PDF-")
    assert worker.process(message) == WorkerOutcome("already_terminal", selected.job_id)
    assert objects.deleted == []


def test_durable_pdf_export_honours_cancellation_before_source_read() -> None:
    selected = lease()
    repository = PdfRepository(selected)
    repository.cancel = True
    objects = PdfObjects(source().data)
    message = DispatchMessage("dispatch-pdf", selected.job_id, selected.trace_id)

    assert processor(repository, objects).process(message) == WorkerOutcome(
        "cancelled", selected.job_id
    )
    assert repository.failures == [("pdf-export-cancelled", False)]


@pytest.mark.parametrize(
    ("objects", "expected_state", "expected_failure"),
    [
        (PdfObjects(b"changed"), "failed", ("pdf-export-validation-failed", False)),
        (
            PdfObjects(source().data, OSError("storage temporarily unavailable")),
            "retry_wait",
            ("pdf-export-temporary-failure", True),
        ),
    ],
)
def test_durable_pdf_export_classifies_source_failures(
    objects: PdfObjects,
    expected_state: str,
    expected_failure: tuple[str, bool],
) -> None:
    selected = lease()
    repository = PdfRepository(selected)
    outcome = processor(repository, objects).process(
        DispatchMessage("dispatch-pdf", selected.job_id, selected.trace_id)
    )

    assert outcome == WorkerOutcome(expected_state, selected.job_id)
    assert repository.failures == [expected_failure]


def test_durable_pdf_export_removes_uncommitted_output_if_lease_changes() -> None:
    selected = lease()
    repository = PdfRepository(selected)
    repository.complete_busy = True
    objects = PdfObjects(source().data)

    assert processor(repository, objects).process(
        DispatchMessage("dispatch-pdf", selected.job_id, selected.trace_id)
    ) == WorkerOutcome("busy", selected.job_id)
    assert len(objects.deleted) == 1
    assert objects.deleted[0][1] == "23"


def test_durable_pdf_export_reports_a_busy_claim_without_starting() -> None:
    selected = lease()
    repository = PdfRepository(selected)
    repository.busy = True

    assert processor(repository, PdfObjects(source().data)).process(
        DispatchMessage("dispatch-pdf", selected.job_id, selected.trace_id)
    ) == WorkerOutcome("busy", selected.job_id)
    assert not repository.started


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Customer / brief", "Customer _ brief.pdf"),
        ("report.pdf", "report.pdf"),
        ("...", "document.pdf"),
    ],
)
def test_pdf_filename_is_safe(value: str, expected: str) -> None:
    assert safe_pdf_filename(value) == expected
