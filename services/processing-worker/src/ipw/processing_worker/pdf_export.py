"""Pinned native Screen PDF renderer and durable worker orchestration."""

from __future__ import annotations

import hashlib
import io
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import pypdf
import reportlab  # type: ignore[import-untyped]
from PIL import Image, ImageCms, ImageOps
from pypdf import PdfReader
from reportlab.lib.utils import ImageReader  # type: ignore[import-untyped]
from reportlab.pdfbase import pdfmetrics  # type: ignore[import-untyped]
from reportlab.pdfbase.ttfonts import TTFont  # type: ignore[import-untyped]
from reportlab.pdfgen import canvas  # type: ignore[import-untyped]

from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.enhancement_engine import ProcessingBudget, VerifiedRasterAsset
from ipw.processing_worker.image_export import ExportAssetReference
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import ObjectZone, PreviewPrivateObjectStore, PrivateObjectRef

PDF_RENDERER_NAME = "ipw-reportlab-screen-pdf"
PDF_RENDERER_VERSION = "1.0.0"
PDF_PROFILE_VERSION = "1.0.0"
MAX_PDF_BYTES = 256 * 1024 * 1024
MAX_PAGES = 50
MAX_PAGE_POINTS = 14_400
MAX_SOURCE_BYTES = 128 * 1024 * 1024
STANDARD_FONT_NAME = "IPWStandard"
STANDARD_FONT_SHA256 = "69853909b940023570964e29cffe30da95aea8de3627736b5cd15ab30143169f"


class PdfCanvas(Protocol):
    def setFillColorRGB(self, red: float, green: float, blue: float) -> None: ...  # noqa: N802
    def setStrokeColorRGB(self, red: float, green: float, blue: float) -> None: ...  # noqa: N802
    def setLineWidth(self, width: float) -> None: ...  # noqa: N802
    def setFont(self, name: str, size: float) -> None: ...  # noqa: N802
    def beginPath(self) -> Any: ...  # noqa: N802
    def clipPath(self, path: Any, *, stroke: int, fill: int) -> None: ...  # noqa: N802
    def rect(
        self, x: float, y: float, width: float, height: float, *, stroke: int, fill: int
    ) -> None: ...
    def drawString(self, x: float, y: float, text: str) -> None: ...  # noqa: N802
    def drawImage(  # noqa: N802
        self,
        image: Any,
        x: float,
        y: float,
        *,
        width: float,
        height: float,
        mask: str,
    ) -> None: ...
    def saveState(self) -> None: ...  # noqa: N802
    def restoreState(self) -> None: ...  # noqa: N802
    def translate(self, x: float, y: float) -> None: ...
    def rotate(self, degrees: float) -> None: ...
    def scale(self, x: float, y: float) -> None: ...


@dataclass(frozen=True)
class RenderedPdf:
    data: bytes = field(repr=False)
    sha256: str
    page_count: int
    renderer: dict[str, Any]


@dataclass(frozen=True)
class LeasedPdfExportJob:
    job_id: str
    pdf_export_request_id: str
    workspace_id: str
    actor_id: str
    document_id: str
    document_version_id: str
    document_name: str
    snapshot_sha256: str
    profile: dict[str, Any]
    preflight: dict[str, Any]
    snapshot: dict[str, Any]
    assets: tuple[ExportAssetReference, ...]
    lease_token_hash: str
    trace_id: str
    attempt: int
    max_attempts: int


@dataclass(frozen=True)
class StoredPdfExport:
    object_key: str
    storage_generation: str
    filename: str
    rendered: RenderedPdf


class PdfExportJobRepository(Protocol):
    def claim_pdf_export(
        self, *, job_id: str, worker_id: str, lease_token: str, trace_id: str
    ) -> LeasedPdfExportJob | None: ...
    def start_pdf_export(self, lease: LeasedPdfExportJob) -> None: ...
    def heartbeat_pdf_export(self, lease: LeasedPdfExportJob) -> None: ...
    def cancellation_requested_pdf_export(self, lease: LeasedPdfExportJob) -> bool: ...
    def complete_pdf_export(self, lease: LeasedPdfExportJob, stored: StoredPdfExport) -> None: ...
    def fail_pdf_export(
        self, lease: LeasedPdfExportJob, *, code: str, message: str, retryable: bool
    ) -> str: ...


class ScreenPdfRenderer:
    """Render one reviewed native snapshot into the release-gated Screen PDF profile."""

    def __init__(self, font_path: Path) -> None:
        if reportlab.Version != "5.0.1" or pypdf.__version__ != "6.18.1":
            raise RuntimeError(
                "Screen PDF renderer dependencies do not match the approved versions"
            )
        self._font_path = font_path.resolve(strict=True)
        digest = hashlib.sha256(self._font_path.read_bytes()).hexdigest()
        if digest != STANDARD_FONT_SHA256:
            raise RuntimeError("IPW Standard font does not match the pinned renderer identity")
        if STANDARD_FONT_NAME not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(STANDARD_FONT_NAME, str(self._font_path)))

    def render(
        self,
        *,
        snapshot: dict[str, Any],
        profile: dict[str, Any],
        assets: dict[str, VerifiedRasterAsset],
        budget: ProcessingBudget | None = None,
    ) -> RenderedPdf:
        active_budget = budget or ProcessingBudget()
        pages = sorted(snapshot.get("artboards", []), key=lambda item: int(item.get("order", 0)))
        self._validate(snapshot, profile, pages, assets)
        output = io.BytesIO()
        first = pages[0]
        document_settings = snapshot["pdf_settings"]
        renderer = canvas.Canvas(
            output,
            pagesize=(float(first["width"]), float(first["height"])),
            pageCompression=1,
            invariant=1,
        )
        renderer.setTitle(str(document_settings["title"]))
        renderer.setAuthor("Intelligent Visual Production Workspace")
        renderer.setSubject(str(document_settings.get("subject") or "Screen PDF"))
        renderer.setCreator(PDF_RENDERER_NAME)
        for page in pages:
            active_budget.check(f"pdf-page:{page['artboard_id']}")
            page_width = float(page["width"])
            page_height = float(page["height"])
            renderer.setPageSize((page_width, page_height))
            background = page.get("background") or {}
            if background.get("kind", "solid") != "transparent":
                renderer.setFillColorRGB(*self._colour(str(background.get("color", "#ffffff"))))
                renderer.rect(0, 0, page_width, page_height, stroke=0, fill=1)
            layers = sorted(
                (
                    item
                    for item in snapshot.get("layers", [])
                    if item.get("artboard_id") == page["artboard_id"]
                    and item.get("visible", True)
                    and item.get("parent_layer_id") is None
                ),
                key=lambda item: (int(item.get("order", 0)), str(item.get("layer_id", ""))),
            )
            for layer in layers:
                active_budget.check(f"pdf-layer:{layer.get('layer_id', 'unknown')}")
                self._draw_layer(renderer, layer, page_height, assets)
            renderer.showPage()
        renderer.save()
        data = output.getvalue()
        if not data or len(data) > MAX_PDF_BYTES:
            raise MemoryError("Screen PDF exceeds the 256 MiB output limit")
        self._validate_output(data, pages)
        return RenderedPdf(
            data=data,
            sha256=hashlib.sha256(data).hexdigest(),
            page_count=len(pages),
            renderer={
                "name": PDF_RENDERER_NAME,
                "version": PDF_RENDERER_VERSION,
                "licence_component_ids": ["reportlab", "pypdf", "pillow", "aileron-ipw-standard"],
                "standard_font_sha256": STANDARD_FONT_SHA256,
            },
        )

    def _draw_layer(
        self,
        target: PdfCanvas,
        layer: dict[str, Any],
        page_height: float,
        assets: dict[str, VerifiedRasterAsset],
    ) -> None:
        transform = layer["transform"]
        width = float(transform["width"]) * float(transform.get("scale_x", 1))
        height = float(transform["height"]) * float(transform.get("scale_y", 1))
        target.saveState()
        target.translate(float(transform["x"]), page_height - float(transform["y"]))
        target.rotate(-float(transform.get("rotation_degrees", 0)))
        if transform.get("flip_x"):
            target.translate(width, 0)
            target.scale(-1, 1)
        if transform.get("flip_y"):
            target.translate(0, -height)
            target.scale(1, -1)
        kind = str(layer["layer_type"])
        if kind == "raster_image":
            raster = layer["raster"]
            source = assets[str(raster["shared_asset_id"])]
            image = self._raster_image(source, raster)
            target.drawImage(
                ImageReader(image), 0, -height, width=width, height=height, mask="auto"
            )
        elif kind == "shape":
            shape = layer["shape"]
            fill = shape.get("fill")
            stroke = shape.get("stroke")
            if fill:
                target.setFillColorRGB(*self._colour(str(fill)))
            if stroke:
                target.setStrokeColorRGB(*self._colour(str(stroke)))
                target.setLineWidth(float(shape.get("stroke_width", 1)))
            target.rect(0, -height, width, height, stroke=int(bool(stroke)), fill=int(bool(fill)))
        elif kind == "rich_text":
            content = layer["rich_text"]
            font_size = float(content.get("font_size", 16))
            line_height = 1.16 * font_size
            target.setFillColorRGB(*self._colour(str(content.get("color", "#000000"))))
            target.setFont(STANDARD_FONT_NAME, font_size)
            clip = target.beginPath()
            clip.rect(0, -height, width, height)
            target.clipPath(clip, stroke=0, fill=0)
            baseline = -font_size
            alignment = str(content.get("text_align", "left"))
            for line in str(content.get("text", "")).splitlines() or [""]:
                line_width = pdfmetrics.stringWidth(line, STANDARD_FONT_NAME, font_size)
                if alignment == "left":
                    horizontal = 0
                elif alignment == "center":
                    horizontal = (width - line_width) / 2
                else:
                    horizontal = width - line_width
                target.drawString(horizontal, baseline, line)
                baseline -= line_height
        else:
            raise ValueError(f"unsupported Screen PDF layer type: {kind}")
        target.restoreState()

    @staticmethod
    def _raster_image(source: VerifiedRasterAsset, content: dict[str, Any]) -> Image.Image:
        if (
            len(source.data) != source.byte_size
            or hashlib.sha256(source.data).hexdigest() != source.sha256
        ):
            raise ValueError("immutable PDF source bytes no longer match verified facts")
        with Image.open(io.BytesIO(source.data)) as opened:
            opened.seek(0)
            expected_format = {
                "image/jpeg": "JPEG",
                "image/png": "PNG",
                "image/webp": "WEBP",
                "image/tiff": "TIFF",
            }.get(source.media_type)
            if opened.format != expected_format:
                raise ValueError("decoded PDF source format no longer matches verified facts")
            if opened.size != (source.width, source.height):
                raise ValueError("decoded PDF source dimensions no longer match verified facts")
            if int(getattr(opened, "n_frames", 1)) != source.frame_count or source.frame_count != 1:
                raise ValueError("Screen PDF requires a verified single-frame source")
            if source.bit_depth is None or source.bit_depth > 8:
                raise ValueError("Screen PDF requires a verified 8-bit source")
            if source.colour_model not in {"grayscale", "rgb", "indexed"}:
                raise ValueError("Screen PDF source colour model is not enabled")
            profile = opened.info.get("icc_profile")
            if bool(profile) != source.has_icc_profile:
                raise ValueError("decoded PDF source profile no longer matches verified facts")
            if profile and not isinstance(profile, bytes):
                raise ValueError("decoded PDF source colour profile is malformed")
            if isinstance(profile, bytes) and len(profile) > 4 * 1024 * 1024:
                raise ValueError("PDF source colour profile exceeds the safe processing limit")
            decoded = ImageOps.exif_transpose(opened)
            decoded.load()
            crop = content.get("crop") or {}
            left = round(float(crop.get("left", 0)) * decoded.width)
            top = round(float(crop.get("top", 0)) * decoded.height)
            right = round(float(crop.get("right", 1)) * decoded.width)
            bottom = round(float(crop.get("bottom", 1)) * decoded.height)
            if not (0 <= left < right <= decoded.width and 0 <= top < bottom <= decoded.height):
                raise ValueError("PDF image crop is outside the verified source")
            decoded = decoded.crop((left, top, right, bottom))
            alpha = decoded.getchannel("A") if "A" in decoded.getbands() else None
            if isinstance(profile, bytes):
                converted = ImageCms.profileToProfile(
                    decoded.convert("RGB"),
                    ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                    ImageCms.createProfile("sRGB"),
                    outputMode="RGB",
                )
                if converted is None:
                    raise ValueError("PDF source colour conversion did not produce an image")
                decoded = converted
            else:
                decoded = decoded.convert("RGB")
            if alpha is not None:
                decoded.putalpha(alpha)
            return decoded

    @staticmethod
    def _colour(value: str) -> tuple[float, float, float]:
        if len(value) != 7 or not value.startswith("#"):
            raise ValueError("Screen PDF colours must use six-digit hexadecimal values")
        try:
            channels = (
                int(value[1:3], 16) / 255,
                int(value[3:5], 16) / 255,
                int(value[5:7], 16) / 255,
            )
        except ValueError as error:
            raise ValueError("Screen PDF colour is invalid") from error
        return channels

    @staticmethod
    def _validate(
        snapshot: dict[str, Any],
        profile: dict[str, Any],
        pages: list[dict[str, Any]],
        assets: dict[str, VerifiedRasterAsset],
    ) -> None:
        if (
            profile.get("profile_id") != "screen"
            or profile.get("profile_version") != PDF_PROFILE_VERSION
        ):
            raise ValueError("PDF output profile is not supported by this renderer")
        if (
            profile.get("tagged_pdf") is not False
            or profile.get("archival_conformance") is not None
        ):
            raise ValueError("Screen PDF cannot claim tagged or archival conformance")
        if not snapshot.get("pdf_settings") or not 1 <= len(pages) <= MAX_PAGES:
            raise ValueError("native PDF snapshot has an invalid page count")
        orders = [int(page.get("order", -1)) for page in pages]
        if orders != list(range(len(pages))):
            raise ValueError("native PDF page order is not contiguous")
        page_ids = [str(page["artboard_id"]) for page in pages]
        settings_ids = [
            str(item["artboard_id"]) for item in snapshot["pdf_settings"].get("pages", [])
        ]
        if page_ids != settings_ids:
            raise ValueError("native PDF page settings do not match the immutable snapshot")
        for page in pages:
            if page.get("unit") != "pt" or not (
                0 < float(page["width"]) <= MAX_PAGE_POINTS
                and 0 < float(page["height"]) <= MAX_PAGE_POINTS
            ):
                raise ValueError("native PDF page dimensions are invalid")
        for layer in snapshot.get("layers", []):
            if not layer.get("visible", True):
                continue
            if layer.get("parent_layer_id") is not None:
                continue
            if layer.get("layer_type") not in {"raster_image", "shape", "rich_text"}:
                raise ValueError("native PDF contains a layer unavailable in Screen PDF")
            transform = layer.get("transform") or {}
            if (
                layer.get("blend_mode", "normal") != "normal"
                or float(layer.get("opacity", 1)) != 1
                or float(transform.get("skew_x_degrees", 0)) != 0
                or float(transform.get("skew_y_degrees", 0)) != 0
                or bool(layer.get("shared_style_ids"))
            ):
                raise ValueError("native PDF contains unsupported layer appearance")
            if layer.get("layer_type") == "raster_image":
                raster = layer.get("raster") or {}
                if raster.get("mask_ids") or any(
                    value != 0
                    for key, value in (raster.get("adjustments") or {}).items()
                    if key != "schema_version"
                ):
                    raise ValueError("native PDF contains unsupported raster processing")
            if layer.get("layer_type") == "shape":
                shape = layer.get("shape") or {}
                if shape.get("shape") != "rectangle" or float(shape.get("corner_radius", 0)) != 0:
                    raise ValueError("native PDF contains an unsupported shape")
            if layer.get("layer_type") == "rich_text":
                text = layer.get("rich_text") or {}
                content = text.get("text")
                if (
                    set(text)
                    - {
                        "schema_version",
                        "text",
                        "runs",
                        "font_family",
                        "font_size",
                        "color",
                        "text_align",
                    }
                    or text.get("font_family") != "IPW Standard"
                    or text.get("runs") not in (None, [], ())
                    or text.get("text_align", "left") not in {"left", "center", "right"}
                    or not isinstance(content, str)
                    or any(
                        character not in "\t\n\r" and not " " <= character <= "~"
                        for character in content
                    )
                ):
                    raise ValueError("native PDF contains unsupported typography")
        used = {
            str((layer.get("raster") or {}).get("shared_asset_id"))
            for layer in snapshot.get("layers", [])
            if layer.get("visible", True)
            and layer.get("parent_layer_id") is None
            and layer.get("layer_type") == "raster_image"
        }
        if used - assets.keys():
            raise ValueError("native PDF references an unavailable verified raster source")

    @staticmethod
    def _validate_output(data: bytes, pages: list[dict[str, Any]]) -> None:
        if not data.startswith(b"%PDF-") or b"%%EOF" not in data[-1024:]:
            raise ValueError("renderer did not produce a complete PDF")
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted or len(reader.pages) != len(pages):
            raise ValueError("rendered PDF structure does not match the reviewed document")
        root = reader.root_object
        if any(key in root for key in ("/OpenAction", "/AA", "/AcroForm")):
            raise ValueError("rendered Screen PDF contains prohibited active content")
        names = root.get("/Names")
        if names and "/EmbeddedFiles" in names:
            raise ValueError("rendered Screen PDF contains prohibited embedded files")
        for rendered, expected in zip(reader.pages, pages, strict=True):
            width = float(rendered.mediabox.width)
            height = float(rendered.mediabox.height)
            if (
                abs(width - float(expected["width"])) > 0.01
                or abs(height - float(expected["height"])) > 0.01
            ):
                raise ValueError("rendered PDF page dimensions differ from the reviewed snapshot")


class PdfExportCancelledError(RuntimeError):
    pass


class DurablePdfExportProcessor:
    def __init__(
        self,
        repository: PdfExportJobRepository,
        objects: PreviewPrivateObjectStore,
        *,
        worker_id: str,
        font_path: Path,
        renderer: ScreenPdfRenderer | None = None,
        execution_lock: threading.Lock | None = None,
        budget_factory: Callable[[Callable[[str], None]], ProcessingBudget] | None = None,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._worker_id = worker_id
        self._renderer = renderer or ScreenPdfRenderer(font_path)
        self._execution_lock = execution_lock or threading.Lock()
        self._budget_factory = budget_factory or (
            lambda checkpoint: ProcessingBudget(checkpoint=checkpoint)
        )

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        with self._execution_lock:
            return self._process_locked(message)

    def _process_locked(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_pdf_export(
                job_id=message.job_id,
                worker_id=self._worker_id,
                lease_token=secrets.token_urlsafe(32),
                trace_id=message.trace_id,
            )
        except JobBusyError:
            return WorkerOutcome("busy", message.job_id)
        if lease is None:
            return WorkerOutcome("already_terminal", message.job_id)
        try:
            budget = self._budget_factory(lambda _stage: self._cancel_guard(lease))
            self._repository.start_pdf_export(lease)
            assets = self._read_assets(lease, budget)
            rendered = self._renderer.render(
                snapshot=lease.snapshot,
                profile=lease.profile,
                assets=assets,
                budget=budget,
            )
            self._cancel_guard(lease)
            filename = safe_pdf_filename(lease.document_name)
            key = (
                f"derivative/{lease.workspace_id}/pdf-exports/{lease.pdf_export_request_id}/"
                f"attempt-{lease.attempt}-{lease.lease_token_hash[:12]}/result.pdf"
            )
            stored_snapshot = self._objects.write_derivative(
                PrivateObjectRef(lease.workspace_id, key, ObjectZone.DERIVATIVE),
                data=rendered.data,
                media_type="application/pdf",
                sha256=rendered.sha256,
                max_bytes=MAX_PDF_BYTES,
            )
            stored = StoredPdfExport(key, stored_snapshot.generation, filename, rendered)
            try:
                self._cancel_guard(lease)
                self._repository.complete_pdf_export(lease, stored)
            except Exception:
                self._objects.delete(
                    PrivateObjectRef(lease.workspace_id, key, ObjectZone.DERIVATIVE),
                    generation=stored_snapshot.generation,
                )
                raise
            return WorkerOutcome("succeeded", lease.job_id)
        except PdfExportCancelledError:
            state = self._repository.fail_pdf_export(
                lease,
                code="pdf-export-cancelled",
                message="PDF export was cancelled",
                retryable=False,
            )
            return WorkerOutcome(state, lease.job_id)
        except JobBusyError:
            return WorkerOutcome("busy", lease.job_id)
        except (ConnectionError, OSError) as error:
            state = self._repository.fail_pdf_export(
                lease, code="pdf-export-temporary-failure", message=str(error), retryable=True
            )
            return WorkerOutcome(state, lease.job_id)
        except (
            Image.DecompressionBombError,
            ImageCms.PyCMSError,
            MemoryError,
            TimeoutError,
            ValueError,
            RuntimeError,
        ) as error:
            state = self._repository.fail_pdf_export(
                lease, code="pdf-export-validation-failed", message=str(error), retryable=False
            )
            return WorkerOutcome(state, lease.job_id)

    def _read_assets(
        self, lease: LeasedPdfExportJob, budget: ProcessingBudget
    ) -> dict[str, VerifiedRasterAsset]:
        result: dict[str, VerifiedRasterAsset] = {}
        total = 0
        for source in lease.assets:
            budget.check(f"pdf-source:{source.shared_asset_id}")
            total += source.byte_size
            if total > MAX_SOURCE_BYTES:
                raise MemoryError("PDF source selection exceeds the 128 MiB compressed-input limit")
            snapshot = self._objects.read(
                PrivateObjectRef(lease.workspace_id, source.object_key, ObjectZone.IMMUTABLE),
                generation=source.storage_generation,
                max_bytes=source.byte_size,
            )
            if (
                len(snapshot.data) != source.byte_size
                or hashlib.sha256(snapshot.data).hexdigest() != source.sha256
            ):
                raise ValueError("immutable PDF source no longer matches verified facts")
            result[source.shared_asset_id] = VerifiedRasterAsset(
                shared_asset_id=source.shared_asset_id,
                source_version_id=source.source_version_id,
                sha256=source.sha256,
                media_type=source.media_type,
                byte_size=source.byte_size,
                width=source.width,
                height=source.height,
                data=snapshot.data,
                orientation=source.orientation,
                bit_depth=source.bit_depth,
                frame_count=source.frame_count,
                has_icc_profile=source.has_icc_profile,
                colour_model=source.colour_model,
            )
        return result

    def _cancel_guard(self, lease: LeasedPdfExportJob) -> None:
        self._repository.heartbeat_pdf_export(lease)
        if self._repository.cancellation_requested_pdf_export(lease):
            raise PdfExportCancelledError("PDF export was cancelled")


def safe_pdf_filename(name: str) -> str:
    cleaned = "".join(
        character if character.isalnum() or character in " ._-" else "_" for character in name
    )
    cleaned = cleaned.strip(" .")[:220] or "document"
    if cleaned.casefold().endswith(".pdf"):
        cleaned = cleaned[:-4].rstrip(" .") or "document"
    return f"{cleaned}.pdf"
