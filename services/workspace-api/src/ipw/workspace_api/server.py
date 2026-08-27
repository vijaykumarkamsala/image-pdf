"""The local workspace API: the application talking to the real processors.

Built on ``http.server`` from the standard library. A web framework would be more
comfortable and would also be a permanent licence-register entry (Gate A), and
this needs six routes. Zero new dependencies is not austerity here - it is the
same discipline that has kept the runtime surface at five packages through eight
POC tasks.

**Everything a customer sees goes through the same processors the benchmark
measures.** No separate "app" implementation of resize, no second denoise. If the
benchmark says libvips uses a seventeenth of Pillow's memory, that is the resize
the customer gets, because it is the same call. A parallel implementation would
make every measurement in ``data/reports`` a statement about code nobody runs.

**Standard is the default and AI is never implicit.** ``/api/process`` will not
route a standard operation to a model: the contract makes that structurally
impossible (``FAMILY_OF`` fixes each operation's family and ``Operation.build``
derives it), and this layer adds nothing that could work around it. An AI
operation additionally reports its licence standing, so a research-only model
cannot quietly produce a customer-facing result.

    python tools/serve_workspace.py
"""

from __future__ import annotations

import base64
import hashlib
import tempfile
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from ipw.benchmark_runner.licence_register import load_register, register_path
from ipw.benchmark_runner.workspace import find_repo_root
from ipw.contracts.licence import RunPurpose
from ipw.contracts.operation import (
    AdjustSettings,
    AiDenoiseSettings,
    AnySettings,
    ConvertSettings,
    CropSettings,
    DenoiseSettings,
    FlipSettings,
    JpegArtifactRepairSettings,
    Operation,
    OperationFamily,
    OperationKind,
    ProcessingRoute,
    ProcessingVariant,
    ResizeSettings,
    RotateSettings,
    SharpenSettings,
    SuperResolutionSettings,
)
from ipw.contracts.processor import Processor
from ipw.contracts.runtime import InputRef, RunContext, workspace
from ipw.processors.base import guarded_process
from ipw.processors.inspection import inspect_input
from ipw.processors.standard import pillow_processor
from ipw.workspace_api.catalogue import catalogue_document

__all__ = ["ProcessRequest", "WorkspaceService", "print_plan"]


@dataclass(frozen=True)
class ProcessRequest:
    """One edit, as the interface asks for it."""

    kind: OperationKind
    settings: dict[str, Any]
    image_bytes: bytes
    filename: str = "upload"


# Standard settings are built from a plain mapping. Each entry validates through
# the contract, so a malformed request fails at the boundary with a normalised
# message rather than somewhere inside an imaging library.
_STANDARD_BUILDERS: dict[OperationKind, type[AnySettings]] = {
    OperationKind.RESIZE: ResizeSettings,
    OperationKind.CROP: CropSettings,
    OperationKind.ROTATE: RotateSettings,
    OperationKind.FLIP: FlipSettings,
    OperationKind.ADJUST: AdjustSettings,
    OperationKind.SHARPEN: SharpenSettings,
    OperationKind.DENOISE: DenoiseSettings,
    OperationKind.CONVERT: ConvertSettings,
}

_AI_BUILDERS: dict[OperationKind, type[AnySettings]] = {
    OperationKind.SUPER_RESOLUTION: SuperResolutionSettings,
    OperationKind.AI_DENOISE: AiDenoiseSettings,
    OperationKind.JPEG_ARTIFACT_REPAIR: JpegArtifactRepairSettings,
}


def _readable_size(value: int) -> str:
    """Bytes in the unit a person would use for that magnitude.

    A four-page contract is not "0.0 MB". Formatting every size in megabytes
    makes small documents read as nothing at all, in exactly the sentences that
    exist to tell somebody what changed.
    """
    if value < 1_000:
        return f"{value} bytes"
    if value < 1_000_000:
        return f"{value / 1_000:.0f} KB"
    return f"{value / 1_000_000:.1f} MB"


def print_plan(width: int, height: int, target_inches: float, dpi: int) -> dict[str, Any]:
    """What it would take to print this image at a given size, told honestly.

    The textile and print-shop workflow starts from inches and DPI, not pixels: a
    customer knows the panel is eighteen inches wide long before they know how
    many pixels that is. Answering in their units - and saying plainly when the
    source cannot support the request - is the difference between a tool and a
    disappointment at the printer.

    Floats are used here and nowhere else in the pipeline. This is advice for a
    person, not a benchmark observation, and it never reaches an identity digest.
    """
    # **Nonsense in must not produce confident advice out.**
    #
    # Asked for -3 inches at 0 DPI, this used to answer "ready - the source
    # already has enough pixels for this size", because both wrong numbers
    # multiplied to zero and zero pixels are easy to supply. A print shop acting
    # on that reads a guarantee where there was only arithmetic.
    if width <= 0 or height <= 0:
        msg = f"cannot plan a print for a {width}x{height} image"
        raise ValueError(msg)
    if target_inches <= 0:
        msg = f"the printed size must be greater than zero inches, got {target_inches:g}"
        raise ValueError(msg)
    if dpi <= 0:
        msg = f"DPI must be greater than zero, got {dpi}"
        raise ValueError(msg)

    longest = max(width, height)
    needed = round(target_inches * dpi)
    scale = needed / longest if longest else 0.0

    if scale <= 1.0:
        verdict, advice = "ready", "The source already has enough pixels for this size."
    elif scale <= 1.5:
        verdict, advice = "ok", "A plain resize will cover this with no visible softness."
    elif scale <= 4.0:
        verdict, advice = (
            "needs_upscale",
            "A plain resize will look soft. AI upscaling can reach this, and may "
            "reconstruct detail that was not in the original.",
        )
    else:
        verdict, advice = (
            "too_small",
            f"This source cannot honestly reach {target_inches:g} inches at {dpi} DPI - "
            f"it would need {scale:.1f}x. Print smaller, print at a lower DPI, or start "
            "from a larger original.",
        )

    return {
        "source_pixels": {"width": width, "height": height},
        "target_inches": target_inches,
        "dpi": dpi,
        "required_pixels_on_longest_edge": needed,
        "required_scale": round(scale, 2),
        "current_inches_at_dpi": round(longest / dpi, 2) if dpi else 0,
        "verdict": verdict,
        "advice": advice,
    }


class WorkspaceService:
    """Everything the routes need, with no HTTP in it.

    Separated from the request handler so the behaviour can be tested without a
    socket - and so a real server, when one exists, reuses this rather than
    reimplementing it.
    """

    def __init__(self, repo_root: Path | None = None) -> None:
        self.repo_root = repo_root or find_repo_root()
        self._storage: Any = None
        # Threaded server, so the cache is touched from several requests at once.
        self._object_cache: OrderedDict[str, bytes] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._base_url = ""
        self._register = None
        register_file = register_path(self.repo_root)
        if register_file.is_file():
            self._register = load_register(register_file)

    # ------------------------------------------------------------- catalogue --

    def catalogue(self) -> dict[str, Any]:
        document = catalogue_document()
        available = self.model_availability()
        for group in document["groups"]:
            for entry in group["operations"]:
                if entry["needs_model"]:
                    entry.update(available.get(entry["kind"], {"available": False}))
        return document

    def model_availability(self) -> dict[str, dict[str, Any]]:
        """Which AI operations can actually run here, and under what standing.

        Reported rather than assumed. An interface that offers an operation the
        host cannot perform produces a failure at the worst possible moment; one
        that hides it produces a customer who thinks the product lacks a feature
        it has.
        """
        status: dict[str, dict[str, Any]] = {}
        try:
            from ipw.processors.ai_adapters import RealEsrganAdapter, SwinIrAdapter
        except ImportError:
            for kind in _AI_BUILDERS:
                status[kind.value] = {
                    "available": False,
                    "reason": "the inference runtime is not installed on this host",
                }
            return status

        probes: dict[OperationKind, Processor] = {
            OperationKind.SUPER_RESOLUTION: RealEsrganAdapter(scale=4),
            OperationKind.AI_DENOISE: SwinIrAdapter(variant_key="denoise-15"),
            OperationKind.JPEG_ARTIFACT_REPAIR: SwinIrAdapter(variant_key="jpeg-10"),
        }
        for kind, processor in probes.items():
            ready = bool(getattr(processor, "available", lambda: False)())
            entry: dict[str, Any] = {
                "available": ready,
                "reason": "" if ready else "model weights are not installed",
            }
            licence_ref = processor.describe().licence_ref
            if self._register and licence_ref:
                decision = self._register.evaluate(licence_ref, RunPurpose.INTERNAL_BENCHMARK)
                entry["licence"] = {
                    "component": licence_ref,
                    "disposition": decision.effective_disposition.value,
                    "eligible_for_commercial_use": (
                        decision.eligible_for_commercial_recommendation
                    ),
                }
            status[kind.value] = entry
        return status

    # --------------------------------------------------------------- inspect --

    def inspect(self, payload: bytes, filename: str) -> dict[str, Any]:
        """Header-first inspection, exactly as the benchmark does it."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / (Path(filename).name or "upload")
            path.write_bytes(payload)
            ref = InputRef(
                asset_id="workspace-upload",
                expected_sha256=hashlib.sha256(payload).hexdigest(),
                path=path,
                declared_bytes=len(payload),
            )
            result = inspect_input(ref)

        return {
            "accepted": result.accepted,
            "decision": result.decision.value,
            "requires_professional_path": result.requires_professional_path,
            "media_type": result.detected_media_type.value if result.detected_media_type else None,
            "width": result.decoded_width,
            "height": result.decoded_height,
            "display_width": result.display_width,
            "display_height": result.display_height,
            "channels": result.decoded_channels,
            "bit_depth": result.decoded_bit_depth,
            "bytes": result.compressed_bytes,
            "megapixels": round((result.decoded_pixels or 0) / 1_000_000, 2),
            "risk_flags": [flag.value for flag in result.risk_flags],
            "warnings": [w.message for w in result.warnings],
            "failure": (
                {
                    "code": result.failure.code.value,
                    "message": result.failure.message,
                    "remediation": result.failure.remediation,
                }
                if result.failure
                else None
            ),
            "sha256": result.sha256,
            "pixels_decoded": result.pixels_decoded,
            # Every other route answers `ok`. Leaving it out here meant anybody
            # writing `if (result.ok)` against the API read a successful
            # inspection as a failure - a papercut that costs an hour the first
            # time somebody hits it, and nothing to avoid.
            "ok": result.failure is None,
        }

    # --------------------------------------------------------------- process --

    def _build_settings(self, kind: OperationKind, raw: dict[str, Any]) -> AnySettings:
        builder = _STANDARD_BUILDERS.get(kind) or _AI_BUILDERS.get(kind)
        if builder is None:
            msg = f"{kind.value} is not available in this build"
            raise ValueError(msg)

        try:
            return builder(**raw)
        except PydanticValidationError as exc:
            # **Translate, do not forward.** pydantic's own text is a multi-line
            # report naming the model class, the error type and a URL - useful
            # when reading a stack trace, unreadable in a toast, and it leaks an
            # internal class name to anyone calling the API. What the caller
            # needs is which setting was wrong and what this operation accepts.
            # `kind` is the discriminator the contract uses to tell settings
            # types apart. Listing it invites somebody to send it, which is a
            # different error, so the advice stays to what a caller may choose.
            accepted = (
                ", ".join(sorted(field for field in builder.model_fields if field != "kind"))
                or "no settings"
            )
            problems = []
            for error in exc.errors():
                field = ".".join(str(part) for part in error.get("loc", ())) or "settings"
                problems.append(f"{field}: {error.get('msg', 'is not valid')}")
            detail = "; ".join(problems)
            msg = f"{kind.value} settings are not valid - {detail}. Accepts: {accepted}"
            raise ValueError(msg) from exc

    def _processor_for(self, kind: OperationKind, settings: AnySettings) -> Processor:
        if FAMILY_OF_IS_STANDARD(kind):
            return pillow_processor()

        from ipw.processors.ai_adapters import RealEsrganAdapter, SwinIrAdapter

        if kind is OperationKind.SUPER_RESOLUTION:
            scale = getattr(settings, "scale", 4)
            return RealEsrganAdapter(scale=scale)
        if kind is OperationKind.AI_DENOISE:
            return SwinIrAdapter(variant_key="denoise-15")
        if kind is OperationKind.JPEG_ARTIFACT_REPAIR:
            return SwinIrAdapter(variant_key="jpeg-10")

        msg = f"{kind.value} has no adapter in this build yet"
        raise ValueError(msg)

    def process(self, request: ProcessRequest, *, always_store: bool = False) -> dict[str, Any]:
        """Run one edit and return the result inline.

        The variant is derived from the operation's family, never chosen by the
        caller. An interface cannot ask for a standard operation and receive AI
        processing, because the family is fixed by the contract.
        """
        settings = self._build_settings(request.kind, request.settings)
        family = OperationFamily.AI if request.kind in _AI_BUILDERS else OperationFamily.STANDARD
        variant = (
            ProcessingVariant.AI_NATURAL
            if family is OperationFamily.AI
            else ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE
        )
        operation = Operation.build(settings, variant, route=ProcessingRoute.CLOUD_CPU)
        processor = self._processor_for(request.kind, settings)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / (Path(request.filename).name or "upload")
            source.write_bytes(request.image_bytes)
            ref = InputRef(
                asset_id="workspace-upload",
                expected_sha256=hashlib.sha256(request.image_bytes).hexdigest(),
                path=source,
                declared_bytes=len(request.image_bytes),
            )
            ctx = RunContext.create(temp_root=root / "tmp", deterministic=False)
            with workspace(ctx.temp_root, "edit") as ws:
                outcome = guarded_process(processor, ref, operation, settings, ws, ctx)
                payload = (
                    (ws.root / outcome.output.relative_path).read_bytes()
                    if outcome.succeeded and outcome.output
                    else b""
                )

        if not outcome.succeeded or outcome.output is None:
            failure = outcome.failure
            return {
                "ok": False,
                "failure": {
                    "code": failure.code.value if failure else "PROCESSOR.INTERNAL_ERROR",
                    "message": failure.message if failure else "processing failed",
                    "remediation": failure.remediation if failure else None,
                    "next_action": failure.next_action.value if failure else "contact_support",
                },
            }

        identity = processor.describe()
        measurement = outcome.measurement
        return {
            "ok": True,
            **self.deliver(
                payload,
                request.filename,
                outcome.output.media_type,
                always_store=always_store,
            ),
            "width": outcome.output.width,
            "height": outcome.output.height,
            "media_type": outcome.output.media_type,
            "sha256": outcome.output.sha256,
            "is_preview": outcome.output.is_preview,
            "processor": {
                "name": identity.name,
                "family": identity.family.value,
                "used_a_model": identity.family is OperationFamily.AI,
                "weights": identity.weights.name if identity.weights else None,
            },
            "took_ms": round(measurement.timing.total_ns / 1_000_000),
            "tiling": measurement.tiling.model_dump(mode="json") if measurement.tiling else None,
            "notes": outcome.notes,
        }

    # ---------------------------------------------------------- uploading ----

    def storage(self) -> Any:
        """Where files live for this deployment.

        Built once and kept, because a bucket-backed store holds parsed
        credentials and rebuilding it per request would re-read the key file
        every time.
        """
        if self._storage is None:
            from ipw.workspace_api.config import load_settings
            from ipw.workspace_api.storage import build_storage

            settings = load_settings()
            self._storage = build_storage(
                settings.bucket,
                self.repo_root / "data" / "local-storage",
                base_url=self._base_url or f"http://{settings.host}:{settings.port}",
                # Production must not quietly write customer output to a
                # container filesystem that vanishes on the next deploy.
                require_bucket=settings.is_production,
            )
        return self._storage

    def set_base_url(self, base_url: str) -> None:
        """Tell the service the address it is actually reachable at.

        Local upload URLs point back at this process, so they have to name the
        port it *bound*, not the one it was configured with. Those differ
        whenever the port is chosen at run time - a test on an ephemeral port,
        or Cloud Run setting PORT - and the symptom is a signed URL that quietly
        addresses whatever else happens to be listening on the default port.
        """
        self._base_url = base_url.rstrip("/")
        # Rebuilt on next use, because a local store has the old address baked in.
        self._storage = None

    def deliver(
        self, data: bytes, filename: str, media_type: str, *, always_store: bool = False
    ) -> dict[str, Any]:
        """How a finished file goes back to the browser.

        Small results stay inline. A thumbnail is a few kilobytes, and sending it
        as a data URL is one round trip instead of three - the browser can paint
        it immediately rather than waiting on a second request.

        Large ones go to the bucket and come back as a link. Base64 costs a third
        more bytes than the file, so an upscaled design sheet inline is both a
        slow response and, past a certain size, one the platform will not carry
        at all. The threshold is where that stops being a fair trade rather than
        a hard limit, so behaviour degrades gradually instead of failing at a
        cliff.
        """
        import base64 as _b64

        # `always_store` is for results that outlive the request that made them.
        # A queued job's result is written to a jsonb column and read back
        # minutes later by a different process: an inline data URL there would
        # put the file itself in Postgres, which is the one thing the schema
        # refuses (D-079), and would be unreadable to anyone holding only the
        # job id. A reference works for both.
        if not always_store and len(data) <= INLINE_RESULT_LIMIT:
            return {
                "image": f"data:{media_type};base64," + _b64.b64encode(data).decode("ascii"),
                "bytes": len(data),
                "delivery": "inline",
            }

        from ipw.workspace_api.storage import gcs_object_name

        store = self.storage()
        name = gcs_object_name(filename, prefix="results")
        store.write(name, data, media_type)
        return {
            "object": name,
            "download_url": store.signed_download(name),
            "bytes": len(data),
            "delivery": "stored",
            "note": (
                f"{len(data) / 1_000_000:.1f} MB is too large to send inline, so it was "
                "written to storage. The link above downloads it directly."
            ),
        }

    def sign_upload(self, filename: str, content_type: str) -> dict[str, Any]:
        """Hand back a URL the browser can PUT a file to, directly.

        This is the whole point of the storage work: a hundred-megabyte image
        goes straight to the bucket, and the API is told only where it landed.
        Nothing large travels through here as base64, so the request size limit
        stops being the thing that caps the professional tier.
        """
        from ipw.workspace_api.storage import gcs_object_name

        if not filename.strip():
            msg = "a filename is required"
            raise ValueError(msg)

        kind = (content_type or "").strip() or "application/octet-stream"
        if not _is_allowed_upload_type(kind):
            msg = (
                f"{kind} is not a type this workspace accepts. "
                "Images (JPEG, PNG) and PDF are supported."
            )
            raise ValueError(msg)

        store = self.storage()
        signed = store.signed_upload(gcs_object_name(filename), kind)
        return {
            "ok": True,
            "url": signed.url,
            "method": signed.method,
            "object": signed.object_name,
            "headers": signed.headers,
            "expires_in": signed.expires_in,
            "note": (
                "PUT the file to this URL with exactly these headers, then send the object "
                "name back - not the file."
            ),
        }

    def fetch_object(self, object_name: str) -> bytes:
        """Read an uploaded object, for the processors to work on.

        **Kept in memory once fetched.** Somebody applying four operations to one
        document should not pay to download it four times: measured on a 20.9 MB
        file, the fetch took 15.1 seconds and the split it fed took 0.15. That
        ratio is worst on a slow connection and never zero, because an object
        store is always a network away.

        The cache is bounded and least-recently-used, so a long session cannot
        grow without limit, and it is keyed by object name - which is unique per
        upload, so an entry can never be stale.
        """
        if not object_name.strip():
            msg = "an object name is required"
            raise ValueError(msg)

        with self._cache_lock:
            cached = self._object_cache.get(object_name)
            if cached is not None:
                self._object_cache.move_to_end(object_name)
                return cached

        try:
            payload = bytes(self.storage().read(object_name))
        except FileNotFoundError as exc:
            msg = f"no uploaded file called {object_name!r} was found"
            raise ValueError(msg) from exc

        self._remember(object_name, payload)
        return payload

    def _remember(self, object_name: str, payload: bytes) -> None:
        """Hold an object, evicting the least recently used to stay in budget.

        Anything larger than the whole budget is not cached at all rather than
        emptying the cache to hold one file nothing else can share it with.
        """
        if len(payload) > OBJECT_CACHE_BYTES:
            return

        with self._cache_lock:
            self._object_cache[object_name] = payload
            self._object_cache.move_to_end(object_name)
            held = sum(len(value) for value in self._object_cache.values())
            while held > OBJECT_CACHE_BYTES and len(self._object_cache) > 1:
                _, evicted = self._object_cache.popitem(last=False)
                held -= len(evicted)

    # ----------------------------------------------------------------- batch --

    def batch_process(
        self,
        items: list[dict[str, Any]],
        kind: OperationKind,
        settings: dict[str, Any],
    ) -> dict[str, Any]:
        """Apply one configuration to many images, isolating every failure.

        **One bad file must not cost the other forty-nine.** A batch that stops
        at the first corrupt upload wastes everything queued behind it and gives
        the customer no way to tell which file was the problem. So each item is
        processed inside its own guard and carries its own status, and the batch
        always returns a full account: what succeeded, what did not, and why.

        Per-item settings override the shared configuration, which is what
        section 13 means by "override settings for individual images" - one
        photograph in a set of fifty may need a different crop without the other
        forty-nine being re-run.
        """
        if not items:
            msg = "no images were given"
            raise ValueError(msg)
        if len(items) > MAX_BATCH_ITEMS:
            msg = (
                f"a batch takes up to {MAX_BATCH_ITEMS} images at a time; "
                f"{len(items)} were given. Split it into smaller runs."
            )
            raise ValueError(msg)

        results: list[dict[str, Any]] = []
        for index, item in enumerate(items):
            filename = str(item.get("filename") or f"image-{index + 1}")
            merged = {**settings, **(item.get("settings") or {})}

            try:
                payload = _decode_data_url(str(item.get("image", "")))
                outcome = self.process(
                    ProcessRequest(
                        kind=kind,
                        settings=merged,
                        image_bytes=payload,
                        filename=filename,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - isolation is the whole point
                # The failure is recorded against its own item rather than
                # raised, so the rest of the batch still runs and the customer
                # can retry exactly the ones that failed.
                results.append(
                    {
                        "index": index,
                        "filename": filename,
                        "status": "failed",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )
                continue

            # `process` reports a refused file by returning `ok: false` rather
            # than raising - a corrupt upload is the caller's problem, not an
            # exception. Treating "did not raise" as success marked a file of
            # random bytes as completed and put it in the download, which is a
            # worse failure than the one it was hiding.
            if not outcome.get("ok", False):
                failure = outcome.get("failure") or {}
                results.append(
                    {
                        "index": index,
                        "filename": filename,
                        "status": "failed",
                        "error": failure.get("message") or "this file could not be processed",
                        "remediation": failure.get("remediation", ""),
                    }
                )
                continue

            results.append(
                {
                    "index": index,
                    "filename": filename,
                    "status": "completed",
                    **outcome,
                }
            )

        completed = [item for item in results if item["status"] == "completed"]
        failed = [item for item in results if item["status"] == "failed"]

        return {
            "ok": True,
            "operation": kind.value,
            "total": len(results),
            "completed": len(completed),
            "failed": len(failed),
            "results": results,
            "failed_indexes": [item["index"] for item in failed],
            "note": _batch_note(len(completed), len(failed)),
        }

    def batch_pdf(
        self,
        items: list[dict[str, Any]],
        operation: str,
        settings: dict[str, Any],
    ) -> dict[str, Any]:
        """Apply one document operation to many PDFs, isolating every failure.

        This is the shape the work actually arrives in. A disclosure bundle is a
        folder, not a file: sixty scans that all need to be under the portal's
        limit, or a name that has to come out of every one of them. Doing that a
        document at a time is where things get missed - not through any technical
        failure, but because file forty-one was the one nobody re-checked.

        The result mirrors :meth:`batch_process` exactly, so the interface has
        one batch screen rather than two that drift apart.
        """
        if not items:
            msg = "no documents were given"
            raise ValueError(msg)
        if len(items) > MAX_BATCH_ITEMS:
            msg = (
                f"a batch takes up to {MAX_BATCH_ITEMS} documents at a time; "
                f"{len(items)} were given. Split it into smaller runs."
            )
            raise ValueError(msg)

        results: list[dict[str, Any]] = []
        # Numbering is the one operation whose state crosses documents: the count
        # has to continue, or a bundle has sixty page ones.
        running_number = int(settings.get("start", 1) or 1)

        for index, item in enumerate(items):
            filename = str(item.get("filename") or f"document-{index + 1}.pdf")
            merged = {**settings, **(item.get("settings") or {})}
            if operation == "number":
                merged["start"] = running_number

            try:
                payload = _decode_data_url(str(item.get("pdf", "")))
                outcome = self._one_document(operation, payload, filename, merged)
                if operation == "number" and outcome.get("ok"):
                    running_number = int(outcome.get("next_number", running_number))
            except Exception as exc:  # noqa: BLE001 - isolation is the whole point
                results.append(
                    {
                        "index": index,
                        "filename": filename,
                        "status": "failed",
                        "error": f"{type(exc).__name__}: {exc}".replace("ValueError: ", ""),
                    }
                )
                continue

            if not outcome.get("ok", False):
                results.append(
                    {
                        "index": index,
                        "filename": filename,
                        "status": "failed",
                        "error": outcome.get("error") or "this document could not be processed",
                    }
                )
                continue

            results.append({"index": index, "filename": filename, "status": "completed", **outcome})

        completed = [item for item in results if item["status"] == "completed"]
        failed = [item for item in results if item["status"] == "failed"]

        return {
            "ok": True,
            "operation": operation,
            "total": len(results),
            "completed": len(completed),
            "failed": len(failed),
            "results": results,
            "failed_indexes": [item["index"] for item in failed],
            "note": _batch_note(len(completed), len(failed), noun="document"),
        }

    def _one_document(
        self, operation: str, payload: bytes, filename: str, settings: dict[str, Any]
    ) -> dict[str, Any]:
        """One document, one operation. Every branch returns the same shape."""
        if operation == "compress":
            target = settings.get("target_mb")
            return self.pdf_compress(
                payload,
                target_mb=None if target in (None, "") else float(target),
                max_dpi=int(settings.get("max_dpi", 200) or 200),
                quality=int(settings.get("quality", 82) or 82),
            )

        if operation == "redact":
            phrases = [
                str(phrase) for phrase in (settings.get("phrases") or []) if str(phrase).strip()
            ]
            if not phrases:
                msg = "give the words to remove"
                raise ValueError(msg)
            return self.pdf_redact(
                payload,
                phrases=phrases,
                ignore_case=bool(settings.get("ignore_case", True)),
            )

        if operation == "ocr":
            return self.pdf_ocr(payload, language=str(settings.get("language", "eng") or "eng"))

        if operation in ("stamp", "rotate"):
            return self.pdf_edit(
                operation,
                [(payload, filename)],
                degrees=int(settings.get("degrees", 90) or 90),
                text=str(settings.get("text", "")),
            )

        if operation == "number":
            return self.pdf_number(
                payload,
                prefix=str(settings.get("prefix", "")),
                start=int(settings.get("start", 1) or 1),
                digits=int(settings.get("digits", 6) or 0),
                position=str(settings.get("position", "bottom-right")),
                size=float(settings.get("size", 9) or 9),
            )

        if operation == "searchable_check":
            return self.pdf_coverage(payload)

        msg = (
            f"unknown document operation {operation!r}; expected compress, redact, ocr, "
            "stamp, rotate, number or searchable_check"
        )
        raise ValueError(msg)

    def batch_zip(self, entries: list[dict[str, Any]]) -> dict[str, Any]:
        """Bundle finished results into one archive.

        Downloading fifty files one at a time is not a workflow. Names are made
        unique inside the archive because a batch drawn from several folders can
        easily contain two files called `scan.jpg`, and a ZIP that silently keeps
        one of them loses work without saying so.
        """
        import io
        import zipfile

        if not entries:
            msg = "there is nothing to download yet"
            raise ValueError(msg)

        buffer = io.BytesIO()
        used: set[str] = set()
        written = 0

        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for index, entry in enumerate(entries):
                raw = str(entry.get("image") or entry.get("pdf") or "")
                if not raw:
                    continue
                try:
                    payload = _decode_data_url(raw)
                except ValueError:
                    continue

                name = _unique_name(str(entry.get("filename") or f"file-{index + 1}"), used)
                used.add(name)
                archive.writestr(name, payload)
                written += 1

        if not written:
            msg = "none of those items had anything to save"
            raise ValueError(msg)

        data = buffer.getvalue()
        return {
            "ok": True,
            "zip": "data:application/zip;base64," + base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "files": written,
        }

    # ------------------------------------------------------------------- pdf --

    def to_pdf(
        self,
        images: list[tuple[bytes, str]],
        *,
        page_size: str | None = None,
        orientation: str = "portrait",
        margin_mm: float = 0.0,
        title: str = "",
        page_numbers: bool = False,
    ) -> dict[str, Any]:
        """Assemble images into a PDF and report what it will print like.

        A JPEG is embedded byte-for-byte, so putting a design into a PDF costs it
        nothing. The effective DPI of every page comes back with the file, because
        that is the number that decides whether the result is worth printing and
        it cannot be known until the placement is chosen.
        """
        import base64 as _base64

        from ipw.pdf import PAGE_SIZES, Fit, Orientation, PdfDocument

        if not images:
            msg = "a PDF needs at least one image"
            raise ValueError(msg)
        if page_size is not None and page_size not in PAGE_SIZES:
            msg = f"unknown page size {page_size!r}; available: {sorted(PAGE_SIZES)}"
            raise ValueError(msg)

        margin_pt = margin_mm * 72.0 / 25.4
        document = PdfDocument(title=title or "Image & PDF Workspace")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pages: list[dict[str, Any]] = []
            for index, (payload, filename) in enumerate(images):
                source = root / f"{index:03d}-{Path(filename).name or 'image'}"
                source.write_bytes(payload)
                page = document.add_image_page(
                    source,
                    size=page_size,
                    orientation=Orientation(orientation) if page_size else None,
                    margin=margin_pt,
                    fit=Fit.CONTAIN,
                )
                dpi = page.dpi_of_images()[0]
                pages.append(
                    {
                        "filename": Path(filename).name,
                        "page_label": page.size.label,
                        "width_inches": round(page.size.inches[0], 2),
                        "height_inches": round(page.size.inches[1], 2),
                        "effective_dpi": dpi,
                        "re_encoded": page.images[0].image.reencoded,
                        # 150 is the usual floor for fabric and large format; 300
                        # for fine detail. Below 150 a print is visibly soft, and
                        # saying so here is cheaper than saying it after the run.
                        "print_quality": (
                            "fine" if dpi >= 300 else "acceptable" if dpi >= 150 else "soft"
                        ),
                    }
                )

            if page_numbers:
                document.add_page_numbers(skip_first=False)
            payload_bytes = document.render()

        worst = min((page["effective_dpi"] for page in pages), default=0)
        return {
            "ok": True,
            "pdf": "data:application/pdf;base64,"
            + _base64.b64encode(payload_bytes).decode("ascii"),
            "bytes": len(payload_bytes),
            "page_count": len(pages),
            "pages": pages,
            "lowest_dpi": worst,
            "advice": (
                "Every page has enough resolution for fine printing."
                if worst >= 300
                else "Good enough for fabric and large format, not for fine detail."
                if worst >= 150
                else f"The weakest page is only {worst} DPI at this size. Print smaller, "
                "or upscale the source first."
            ),
            "quality_note": (
                "JPEG sources were embedded unchanged - putting them in a PDF cost no quality."
                if not any(page["re_encoded"] for page in pages)
                else "Some sources were re-packed losslessly because PDF cannot carry "
                "their format directly. No pixels were lost."
            ),
        }

    # ------------------------------------------------- existing PDFs --------

    def pdf_thumbnails(self, payload: bytes, edge: int = 240) -> dict[str, Any]:
        """Small previews for pages that hold one full-page image.

        A page whose artwork is vector cannot be previewed without a renderer,
        and this service does not have one. A page that is a scan *is* an image,
        and showing it is honest - so those pages get a picture and the rest get
        a card stating their measured size.

        The downsizing is the point. Handing the browser the images at their
        original resolution would work perfectly on a two-page document and send
        several hundred megabytes for a hundred-page scan, which is the kind of
        problem that only appears once someone has real work to do.

        Whether an image *is* the page is judged here rather than in the browser,
        because the page dimensions are known here. A logo shown as a page
        preview would be a confident lie about what prints.
        """
        import io

        from PIL import Image

        from ipw.pdf.edit import extract_images
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        pages = reader.describe()["pages"]
        thumbnails: dict[str, str] = {}
        skipped = 0

        for image in extract_images(reader, minimum_pixels=160_000):
            page = pages[image.page_number - 1] if image.page_number <= len(pages) else None
            if page is None or str(image.page_number) in thumbnails:
                continue

            page_aspect = page["width_inches"] / max(page["height_inches"], 0.01)
            image_aspect = image.width / max(image.height, 1)
            if abs(page_aspect - image_aspect) / page_aspect > 0.06:
                # Placed artwork, not the page itself.
                skipped += 1
                continue

            try:
                opened = Image.open(io.BytesIO(image.data))
                opened.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                picture = opened if opened.mode in ("RGB", "L") else opened.convert("RGB")
                buffer = io.BytesIO()
                picture.save(buffer, format="JPEG", quality=72, optimize=True)
            except (OSError, ValueError):
                # A preview is a convenience. One that cannot be built is not an
                # error worth failing the whole request over.
                continue

            thumbnails[str(image.page_number)] = "data:image/jpeg;base64," + base64.b64encode(
                buffer.getvalue()
            ).decode("ascii")

        return {
            "ok": True,
            "thumbnails": thumbnails,
            "page_count": len(pages),
            "bytes": sum(len(value) for value in thumbnails.values()),
            "note": _thumbnail_note(len(thumbnails), len(pages)),
        }

    @staticmethod
    def _document_extras(reader: Any) -> list[str]:
        """Things in this document that a page operation has to think about."""
        names = {
            "Outlines": "bookmarks",
            "AcroForm": "fill-in form fields",
            "Names": "named destinations",
            "PageLabels": "custom page numbering",
            "OCProperties": "layers",
        }
        return [label for key, label in names.items() if key in reader.catalog]

    def pdf_inspect(self, payload: bytes, filename: str) -> dict[str, Any]:
        """Open a PDF the customer already has, and say what can be done to it.

        The capability report is the point. Section 19 allows editing existing
        content "only when technically supported, with honest limitations", and
        a customer should learn where the boundary is from the screen rather
        than by trying something and watching it fail. Merge, split, reorder,
        rotate and stamp work on any file; rewriting someone else's typeset text
        or Illustrator artwork does not, and saying so up front is the honest
        version of a feature list.
        """
        from ipw.pdf.edit import capabilities
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            return {"ok": False, "error": str(exc), "filename": Path(filename).name}

        described = reader.describe()
        caps = capabilities(reader)
        return {
            "ok": True,
            "filename": Path(filename).name,
            "bytes": len(payload),
            "document": described,
            "capabilities": caps,
            "summary": _pdf_summary(described, caps),
            "has_private_data": _has_private_data(reader),
            "extras": self._document_extras(reader),
        }

    def pdf_edit(
        self,
        operation: str,
        documents: list[tuple[bytes, str]],
        *,
        pages: list[int] | None = None,
        order: list[int] | None = None,
        degrees: int = 0,
        text: str = "",
        title: str = "",
        keep_private_data: bool = False,
    ) -> dict[str, Any]:
        """Apply one page-level operation and hand back the new file.

        Page numbers arrive one-based because that is what the customer sees;
        they are converted once, here, so no caller has to remember which
        convention it is holding.
        """
        from ipw.pdf.edit import (
            extract_images,
            merge,
            overlay_on_pages,
            reorder,
            rotate_pages,
            select_pages,
        )
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        if not documents:
            msg = "no PDF was provided"
            raise ValueError(msg)

        try:
            readers = [PdfReader.from_bytes(data) for data, _ in documents]
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        first = readers[0]
        total = len(first.pages())
        selected = _one_based(pages, total, "pages") if pages else list(range(total))

        if operation == "merge":
            if len(readers) < 2:
                msg = "merging needs at least two PDFs"
                raise ValueError(msg)
            result = merge(readers, title, keep_private_data=keep_private_data)
        elif operation == "split":
            result = select_pages(first, selected, title, keep_private_data=keep_private_data)
        elif operation == "delete_pages":
            keep = [index for index in range(total) if index not in set(selected)]
            if not keep:
                msg = "that would delete every page"
                raise ValueError(msg)
            result = select_pages(first, keep, title, keep_private_data=keep_private_data)
        elif operation == "reorder":
            result = reorder(
                first, _one_based(order, total, "order"), title, keep_private_data=keep_private_data
            )
        elif operation == "rotate":
            result = rotate_pages(
                first, degrees, selected, title, keep_private_data=keep_private_data
            )
        elif operation == "stamp":
            if not text.strip():
                msg = "a stamp needs some text"
                raise ValueError(msg)
            result = overlay_on_pages(
                first,
                _stamp_stream(text, first, selected),
                selected,
                title,
                keep_private_data=keep_private_data,
            )
        elif operation == "extract_images":
            wanted = {index + 1 for index in selected}
            found = [i for i in extract_images(first) if i.page_number in wanted]
            return {
                "ok": True,
                "operation": operation,
                "images": [
                    {
                        "image": f"data:image/{image.suffix.lstrip('.')};base64,"
                        + base64.b64encode(image.data).decode("ascii"),
                        "width": image.width,
                        "height": image.height,
                        "page_number": image.page_number,
                        "bytes": len(image.data),
                        "original_quality": not image.reencoded,
                    }
                    for image in found
                ],
                "count": len(found),
                "note": (
                    "No embedded images were found. The artwork on these pages is "
                    "vector, which has no pixels to pull out."
                    if not found
                    else f"{len(found)} image(s) recovered at their original quality."
                ),
            }
        else:
            msg = f"unknown PDF operation {operation!r}"
            raise ValueError(msg)

        after = PdfReader.from_bytes(result)
        return {
            "ok": True,
            "operation": operation,
            "pdf": "data:application/pdf;base64," + base64.b64encode(result).decode("ascii"),
            "bytes": len(result),
            "page_count": len(after.pages()),
            "document": after.describe(),
            "note": _pdf_change_note(
                operation,
                sum(len(data) for data, _ in documents),
                len(result),
                keep_private_data=keep_private_data,
                had_private_data=any(_has_private_data(r) for r in readers),
            ),
        }

    def pdf_ocr(
        self,
        payload: bytes,
        *,
        pages: list[int] | None = None,
        language: str = "eng",
    ) -> dict[str, Any]:
        """Read the scanned pages and hand back a searchable copy.

        Recognition and the text layer are one step here because separately they
        are useless: words without a layer cannot be searched, and a layer needs
        words. What comes back looks identical to what went in and can now be
        searched, selected, copied from and redacted by phrase.
        """
        from ipw.pdf.ocr import TesseractEngine, availability, recognise
        from ipw.pdf.reader import PdfReader, PdfSyntaxError
        from ipw.pdf.textlayer import add_text_layer, coverage

        engine = TesseractEngine(language=language or "eng")
        status = availability(engine)
        if not status["available"]:
            return {"ok": False, "available": False, "error": status["reason"]}

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        before = coverage(reader)
        words, report = recognise(reader, engine=engine, pages=pages)

        if not words:
            return {
                "ok": True,
                "available": True,
                "words": 0,
                "changed": False,
                "coverage_before": before,
                "note": report["note"],
            }

        data, layer = add_text_layer(PdfReader.from_bytes(payload), words)
        after = coverage(PdfReader.from_bytes(data))

        return {
            "ok": True,
            "available": True,
            "pdf": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "changed": True,
            "words": report["words"],
            "low_confidence_words": report["low_confidence_words"],
            "pages_read": report["pages_read"],
            "pages_skipped": report["pages_skipped"],
            "engine": report["engine"],
            "engine_version": report["version"],
            "coverage_before": before,
            "coverage_after": after,
            "note": f"{report['note']} {layer['note']}",
            "licence_note": status.get("licence_note", ""),
        }

    def ocr_availability(self) -> dict[str, Any]:
        """Whether recognition can run on this host."""
        from ipw.pdf.ocr import availability

        return {"ok": True, **availability()}

    def pdf_number(
        self,
        payload: bytes,
        *,
        prefix: str = "",
        start: int = 1,
        digits: int = 6,
        position: str = "bottom-right",
        size: float = 9.0,
    ) -> dict[str, Any]:
        """Mark every page with its own number, and say where the count reached.

        `next_number` is the part that matters. A bundle is sixty files that a
        court or a client refers to as one thing, so the count has to carry from
        one document into the next - otherwise there are sixty page 412s and a
        citation means nothing.
        """
        from ipw.pdf.numbering import POSITIONS, Numbering, number_pages
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        if position not in POSITIONS:
            msg = f"unknown position {position!r}; available: {sorted(POSITIONS)}"
            raise ValueError(msg)

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        data, report = number_pages(
            reader,
            Numbering(
                prefix=str(prefix),
                start=max(0, int(start)),
                digits=max(0, min(int(digits), 12)),
                position=position,
                size=max(4.0, min(float(size), 48.0)),
            ),
        )
        after = PdfReader.from_bytes(data)
        return {
            "ok": True,
            "pdf": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "page_count": len(after.pages()),
            **report,
        }

    def pdf_coverage(self, payload: bytes) -> dict[str, Any]:
        """Whether this document can be searched, and which pages cannot.

        The question behind every "why did the search find nothing?" A bundle of
        real text and scans answers searches from half of itself and silently
        ignores the rest, which is worse than not searching at all - a lawyer who
        greps a disclosure bundle for a name and gets no hits will believe the
        name is not there.
        """
        from ipw.pdf.reader import PdfReader, PdfSyntaxError
        from ipw.pdf.textlayer import coverage

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        report = coverage(reader)
        return {"ok": True, **report}

    # ---------------------------------------------------------- compress ----

    def pdf_compress(
        self,
        payload: bytes,
        *,
        target_mb: float | None = None,
        max_dpi: int = 200,
        quality: int = 82,
        keep_private_data: bool = False,
    ) -> dict[str, Any]:
        """Make a document smaller, to a size limit if one is given.

        A target is the useful form of this request. Nobody wants "medium
        quality"; they want the file under whatever their portal, court filing
        system or mail server will accept, at the best quality that fits.
        """
        from ipw.pdf.compress import compress, compress_to_target
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        if target_mb is not None:
            if target_mb <= 0:
                msg = "the size limit must be greater than zero"
                raise ValueError(msg)
            data, report = compress_to_target(
                reader, int(target_mb * 1_000_000), keep_private_data=keep_private_data
            )
        else:
            data, report = compress(
                reader,
                max_dpi=max(20, min(int(max_dpi), 1200)),
                quality=max(20, min(int(quality), 95)),
                keep_private_data=keep_private_data,
            )

        # **Never hand back something bigger than what arrived.**
        #
        # Rebuilding a document costs bytes - a fresh cross-reference table, and
        # object streams that a small file cannot amortise - so a PDF that is
        # already lean, or has no images to recompress, comes out larger than it
        # went in. Measured on a four-page text-only contract: 1,773 bytes in,
        # 1,862 out, reported as a success with `reached_target: true`.
        #
        # Somebody who asks to compress a file and receives a larger one has
        # been failed twice: once by the result and once by being told it worked.
        # The honest answer is the original file and a note saying why, which is
        # what every compressor a customer has used before does.
        grew = len(data) >= len(payload)
        if grew:
            data = payload
            extra_notes = [
                "This file was already as small as it goes - compressing it produced "
                "a larger file, so the original was kept."
            ]
        else:
            extra_notes = []

        after = PdfReader.from_bytes(data)
        saved = max(0, len(payload) - len(data))
        return {
            "ok": True,
            "pdf": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "original_bytes": len(payload),
            "saved_bytes": saved,
            "already_minimal": grew,
            "percent_smaller": round(saved / len(payload) * 100, 1) if payload else 0.0,
            "page_count": len(after.pages()),
            "images_touched": report.images_touched,
            "images_left_alone": report.images_left_alone,
            "dpi_before": report.lowest_dpi_before,
            "dpi_after": report.lowest_dpi_after,
            "dpi_limit": report.dpi_limit,
            "quality": report.quality,
            "attempts": report.attempts,
            "reached_target": report.reached_target and not grew,
            "target_bytes": report.target_bytes,
            "notes": extra_notes + list(report.notes),
            "note": " ".join(extra_notes + list(report.notes)),
        }

    # ------------------------------------------------------------ redact ----

    def pdf_search(
        self, payload: bytes, phrase: str, *, ignore_case: bool = True
    ) -> dict[str, Any]:
        """Where a phrase appears, before anything is removed.

        Redaction is irreversible by design, so a customer should be able to see
        what will be covered first. This answers "how many, and on which pages"
        without changing the file.
        """
        from ipw.pdf.content import find_text
        from ipw.pdf.reader import PdfReader, PdfSyntaxError

        if not phrase.strip():
            msg = "type the words you want to find"
            raise ValueError(msg)

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        hits: list[dict[str, Any]] = []
        for index, page in enumerate(reader.pages()):
            for left, bottom, right, top in find_text(
                reader, page.dictionary, phrase, ignore_case=ignore_case
            ):
                hits.append(
                    {
                        "page": index + 1,
                        "left": round(left, 2),
                        "bottom": round(bottom, 2),
                        "right": round(right, 2),
                        "top": round(top, 2),
                    }
                )

        pages_hit = sorted({hit["page"] for hit in hits})
        return {
            "ok": True,
            "phrase": phrase,
            "count": len(hits),
            "pages": pages_hit,
            "hits": hits[:500],
            "note": (
                f"Found {len(hits)} time(s) on {len(pages_hit)} page(s)."
                if hits
                else "Not found. If this document is a scan, its words are pixels rather "
                "than text - draw a box over the area instead, which removes the pixels."
            ),
        }

    def pdf_redact(
        self,
        payload: bytes,
        *,
        phrases: list[str] | None = None,
        areas: list[dict[str, Any]] | None = None,
        pages: list[int] | None = None,
        ignore_case: bool = True,
    ) -> dict[str, Any]:
        """Remove text and pixels, then read the result back and prove it.

        The verification is not decoration. A redaction that is asserted rather
        than checked is exactly how documents get published with the names still
        in them, and this is the only step that turns the promise into a fact
        about the bytes being returned.
        """
        from ipw.pdf.reader import PdfReader, PdfSyntaxError
        from ipw.pdf.redact import Redaction, redact, redact_phrases, verify

        try:
            reader = PdfReader.from_bytes(payload)
        except PdfSyntaxError as exc:
            raise ValueError(str(exc)) from exc

        wanted = [phrase for phrase in (phrases or []) if phrase.strip()]
        boxes = [
            Redaction(
                page=int(area.get("page", 1)),
                left=float(area.get("left", 0)),
                bottom=float(area.get("bottom", 0)),
                right=float(area.get("right", 0)),
                top=float(area.get("top", 0)),
            )
            for area in (areas or [])
            if isinstance(area, dict)
        ]

        if not wanted and not boxes:
            msg = "give either some words to remove or an area to cover"
            raise ValueError(msg)

        if wanted:
            data, report, found = redact_phrases(
                reader, wanted, pages=pages, ignore_case=ignore_case
            )
            if boxes:
                # Both were asked for: apply the drawn areas to the result of the
                # phrase pass, so neither is lost.
                data, extra = redact(PdfReader.from_bytes(data), boxes)
                report.characters_removed += extra.characters_removed
                report.images_painted += extra.images_painted
                report.annotations_removed += extra.annotations_removed
                found = [*found, *boxes]
        else:
            data, report = redact(reader, boxes)
            found = boxes

        survivors = verify(data, wanted) if wanted else []
        after = PdfReader.from_bytes(data)

        return {
            "ok": True,
            "pdf": "data:application/pdf;base64," + base64.b64encode(data).decode("ascii"),
            "bytes": len(data),
            "page_count": len(after.pages()),
            "areas_redacted": len(found),
            "characters_removed": report.characters_removed,
            "images_painted": report.images_painted,
            "annotations_removed": report.annotations_removed,
            "still_present": survivors,
            "verified": not survivors,
            "pages_with_drawn_artwork": report.pages_with_vector_art,
            "note": _redaction_note(report, len(found), survivors),
        }

    # ---------------------------------------------------------- vectorise ----

    def vectorise(
        self,
        payload: bytes,
        filename: str,
        *,
        mode: str = "flat_colour",
        colours: int = 8,
        detail: float = 1.0,
        smoothness: float = 25.0,
        despeckle: int = 8,
        threshold: int | None = None,
        keep_background: bool = False,
        clean: int = 0,
        also_pdf: bool = False,
        page_size: str | None = None,
    ) -> dict[str, Any]:
        """Trace a picture into shapes, and say honestly how well it went.

        Offered as SVG always and as PDF on request. SVG is what every cutter,
        plotter, engraver and design program reads; PDF is what a print shop
        asks for. Both are generated from the same fitted geometry, so a proof
        viewed in one describes the file sent in the other.
        """
        import io

        from PIL import Image, UnidentifiedImageError

        from ipw.vector import Settings
        from ipw.vector import vectorise as trace_image

        try:
            image = Image.open(io.BytesIO(payload))
            image.load()
        except (UnidentifiedImageError, OSError) as exc:
            msg = f"that file could not be read as an image: {exc}"
            raise ValueError(msg) from exc

        if mode not in ("line_art", "flat_colour", "photographic"):
            msg = f"unknown mode {mode!r}; expected line_art, flat_colour or photographic"
            raise ValueError(msg)

        result = trace_image(
            image,
            Settings(
                mode=mode,
                colours=max(2, min(int(colours), 64)),
                detail=max(0.1, min(float(detail), 10.0)),
                smoothness=max(0.0, min(float(smoothness), 90.0)),
                despeckle=max(0, min(int(despeckle), 10_000)),
                threshold=threshold,
                keep_background=bool(keep_background),
                clean=max(0, min(int(clean), 5)),
            ),
        )

        response: dict[str, Any] = {
            "ok": True,
            "filename": Path(filename).name,
            "svg": "data:image/svg+xml;base64,"
            + base64.b64encode(result.svg.encode("utf-8")).decode("ascii"),
            "svg_text": result.svg,
            "report": result.report,
            "advice": _vector_advice(result.report, len(payload)),
        }
        if also_pdf:
            response["pdf"] = "data:application/pdf;base64," + base64.b64encode(
                _vector_pdf(result, page_size)
            ).decode("ascii")
        return response


def FAMILY_OF_IS_STANDARD(kind: OperationKind) -> bool:  # noqa: N802 - reads as a predicate
    """Whether the contract places this operation in the standard family."""
    from ipw.contracts.operation import FAMILY_OF

    return FAMILY_OF[kind] is OperationFamily.STANDARD


def _one_based(numbers: list[int] | None, total: int, label: str) -> list[int]:
    """Convert what the customer typed into indices, or explain what is wrong."""
    if not numbers:
        msg = f"no {label} were given"
        raise ValueError(msg)
    out: list[int] = []
    for number in numbers:
        if not 1 <= number <= total:
            msg = f"page {number} does not exist; this document has {total} page(s)"
            raise ValueError(msg)
        out.append(number - 1)
    return out


def _stamp_stream(text: str, reader: Any, pages: list[int]) -> bytes:
    """A centred grey watermark, sized so it actually lands on the page.

    Sizing this by eye is how a watermark ends up hanging off the left edge: a
    first attempt here scaled the font from the page's shorter side and put
    "SAMPLE" at 501pt on a 1288pt-wide page, needing 1563pt of glyphs and
    starting at x=-197. Page counts all still matched, which is why the bug is
    worth naming - nothing that counted pages could have caught it.

    So the size is derived from the width the text must fit into, using the same
    estimator the rest of the package uses for centring. One estimator means one
    place to be wrong, rather than two that disagree.

    One content stream serves every stamped page, so it is sized from the
    narrowest: a stamp that fits the smallest page fits all of them, while one
    sized to the largest would run off the rest.
    """
    from ipw.pdf.document import StandardFont, text_width

    described = reader.describe()["pages"]
    chosen = [described[index] for index in pages if 0 <= index < len(described)] or described
    width = min(page["width_inches"] * 72 for page in chosen)
    height = min(page["height_inches"] * 72 for page in chosen)

    # The stamp spans 70% of the page: wide enough to read across the artwork,
    # with a margin that survives the estimator being a few percent out.
    # The size is purely proportional, with no absolute floor. An earlier
    # version clamped it at 12pt "so it stays readable", which on a 200pt page
    # forced forty characters into 250pt of glyphs and pushed the stamp off both
    # edges - an absolute minimum applied to a relative problem. A stamp that is
    # 70% of its page is equally readable on every page, which is the whole
    # point of measuring in points.
    target = width * 0.70
    unit = text_width(text, 1.0, StandardFont.HELVETICA) or 1.0
    size = min(target / unit, height * 0.5)
    x = (width - text_width(text, size, StandardFont.HELVETICA)) / 2
    y = height * 0.45

    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    # A light grey reads as a watermark on white and needs no ExtGState, which
    # keeps the stamp safe to drop onto a page whose resource dictionary we did
    # not write and must not modify.
    return (
        f"q 0.75 0.75 0.75 rg BT /Helvetica {size:.1f} Tf "
        f"1 0 0 1 {x:.1f} {y:.1f} Tm ({escaped}) Tj ET Q"
    ).encode("latin-1", "replace")


def _pdf_summary(described: dict[str, Any], caps: dict[str, Any]) -> str:
    count = described["page_count"]
    size = described["pages"][0]["label"] if described["pages"] else "unknown size"
    shape = (
        f"{count} page(s), {size}"
        if described.get("uniform_size")
        else f"{count} page(s), mixed sizes"
    )
    if caps["extractable_images"]:
        shape += f", {caps['extractable_images']} embedded image(s)"
    if not caps["has_text"] and not caps["extractable_images"]:
        shape += ". The artwork is vector, so it stays perfectly sharp at any print size"
    return shape + "."


def _pdf_change_note(
    operation: str,
    before: int,
    after: int,
    *,
    keep_private_data: bool = False,
    had_private_data: bool = False,
) -> str:
    """Say what happened to the file, and be careful about why.

    A file that comes back a third of the size invites the question "what did
    you throw away?", and the answer belongs in front of the customer. But it
    has to be the *right* answer: after a split, the file is smaller because
    twenty-three pages are gone, and blaming that on the discarded working copy
    would be a confident lie. So the two causes are stated separately, and the
    working-copy sentence only appears when there was one to discard.
    """
    parts: list[str] = []
    if operation in {"split", "delete_pages"}:
        parts.append("Only the pages you kept were carried over, at their original quality.")
    elif operation == "merge":
        parts.append("Pages were copied, not re-rendered, so nothing lost quality.")
    elif operation == "stamp":
        parts.append("The stamp sits over the page as its own layer; the artwork is untouched.")
    else:
        parts.append("Nothing was re-rendered, so quality is unchanged.")

    if before:
        parts.append(f"{_readable_size(after)}, from {_readable_size(before)}.")

    if had_private_data and not keep_private_data:
        parts.append(
            "Some of that is the design program's private working copy, which was left "
            'out - what prints is identical. Tick "keep the original editable data" if '
            "you need to reopen this in Illustrator with live objects."
        )
    elif had_private_data:
        parts.append(
            "The original editable data was kept, so this stays large but reopens in "
            "Illustrator exactly as it did before."
        )
    return " ".join(parts)


def _has_private_data(reader: Any) -> bool:
    """Did the producer leave a working copy behind for us to drop?"""
    return any(key in page.dictionary for page in reader.pages() for key in ("PieceInfo", "Thumb"))


def _thumbnail_note(shown: int, total: int) -> str:
    """Say which pages got a picture, and why the others did not."""
    if shown == 0:
        return (
            "These pages are vector artwork, so their measured sizes are shown instead "
            "of previews. Drawing a preview would mean guessing at fonts and colour, and "
            "a preview that differs from the print is worse than none."
        )
    if shown == total:
        return f"All {total} pages are scans, so each one is shown as it will print."
    return (
        f"{shown} of {total} pages are scans and are shown. The other {total - shown} "
        "are vector artwork, which has no picture to show without guessing at how it "
        "will print."
    )


def _vector_pdf(result: Any, page_size: str | None) -> bytes:
    """Put traced shapes on a PDF page as real vector paths.

    Not a picture of the shapes - the paths themselves, so the file stays
    resolution-free all the way to the imagesetter. A print shop that opens this
    can scale it to any sheet without coming back to ask for the artwork again,
    which is the entire reason a customer wanted it vectorised.
    """
    from ipw.pdf import PAGE_SIZES
    from ipw.pdf.objects import Name, PdfWriter, Stream

    if page_size and page_size not in PAGE_SIZES:
        msg = f"unknown page size {page_size!r}; available: {sorted(PAGE_SIZES)}"
        raise ValueError(msg)

    if page_size:
        size = PAGE_SIZES[page_size]
        width_pt, height_pt = float(size.width), float(size.height)
        margin = 18.0
        scale = min(
            (width_pt - 2 * margin) / result.width,
            (height_pt - 2 * margin) / result.height,
        )
    else:
        # With no page size given the page becomes the artwork's own size, so
        # nothing is cropped and no white band is invented around it. A page
        # size can always be chosen later; a crop cannot be undone.
        scale = 1.0
        width_pt, height_pt = float(result.width), float(result.height)

    drawn_width = result.width * scale
    drawn_height = result.height * scale
    operators = result.pdf_operators(drawn_height, scale)

    # The operators are written with the artwork's own top-left at the origin of
    # a box its own size, so placing it on a larger page is one translation
    # rather than an adjustment to every coordinate in the file.
    offset_x = (width_pt - drawn_width) / 2.0
    offset_y = (height_pt - drawn_height) / 2.0
    placed = f"q 1 0 0 1 {offset_x:.3f} {offset_y:.3f} cm\n".encode("ascii") + operators + b"\nQ"

    writer = PdfWriter()
    catalog, tree = writer.reserve(), writer.reserve()
    contents = writer.add(Stream({}, placed))
    page = writer.add(
        {
            "Type": Name("Page"),
            "Parent": tree,
            "MediaBox": [0, 0, round(width_pt, 3), round(height_pt, 3)],
            "Resources": {},
            "Contents": contents,
        }
    )
    writer.put(tree, {"Type": Name("Pages"), "Kids": [page], "Count": 1})
    writer.put(catalog, {"Type": Name("Catalog"), "Pages": tree})
    return writer.build(catalog, {"Producer": "Image & PDF Workspace"})


def _vector_advice(report: dict[str, Any], source_bytes: int) -> str:
    """One sentence a person can act on, in front of the numbers."""
    traced = report["svg_bytes"]
    comparison = f"{traced / 1024:.0f} KB traced against {source_bytes / 1024:.0f} KB of pixels"
    if traced > source_bytes:
        comparison += (
            " - larger, which is normal for a detailed drawing and buys something the "
            "pixels could not offer at any size."
        )
    else:
        comparison += " - smaller, and no longer tied to a size at all."
    return f"{report['suitability']} {comparison}"


def _redaction_note(report: Any, areas: int, survivors: list[str]) -> str:
    """Say plainly what happened, including anything that could not be removed."""
    if not areas:
        return (
            "Nothing matched, so nothing was removed and the document is unchanged. "
            "If this is a scan, the words are pixels rather than text - draw a box "
            "over the area instead."
        )

    parts = [
        f"{areas} area(s) removed: {report.characters_removed} character(s) deleted from the "
        "text, not covered over."
    ]
    if report.images_painted:
        parts.append(
            f"{report.images_painted} image(s) had the pixels underneath overwritten, which is "
            "what actually hides anything on a scanned page."
        )
    if report.annotations_removed:
        parts.append(
            f"{report.annotations_removed} comment(s) or form field(s) overlapping the area were "
            "removed too - they carry their own text, separate from the page."
        )
    if survivors:
        parts.append(
            "WARNING: reading the result back still finds "
            + ", ".join(repr(phrase) for phrase in survivors)
            + ". Do not treat this file as redacted."
        )
    else:
        parts.append("Checked by reading the finished file back: the words are gone.")

    if report.pages_with_vector_art:
        pages = ", ".join(str(page) for page in report.pages_with_vector_art[:8])
        parts.append(
            f"Page(s) {pages} contain drawn artwork - a signature or a chart plotted as lines. "
            "Drawn artwork is covered by the black box but not deleted, so check those pages "
            "before releasing the file."
        )
    return " ".join(parts)


MAX_BATCH_ITEMS = 50
"""PRODUCT_REQUIREMENTS section 13: up to fifty images per batch.

A ceiling rather than a target. Fifty full-resolution images held in memory at
once is already a great deal, and the honest answer to a larger job is to split
it - not to accept it and fail somewhere in the middle.
"""


def _decode_data_url(value: str) -> bytes:
    """Accept a data URL or bare base64, and refuse anything else clearly."""
    import base64 as _base64
    import binascii

    if not value:
        msg = "no image was supplied"
        raise ValueError(msg)
    if value.startswith("data:"):
        _, _, value = value.partition(",")
    try:
        return _base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        msg = "that image is not valid base64"
        raise ValueError(msg) from None


def _unique_name(name: str, used: set[str]) -> str:
    """A name no other entry in the archive already has."""
    clean = Path(name).name or "file"
    if clean not in used:
        return clean

    stem = Path(clean).stem
    suffix = Path(clean).suffix
    counter = 2
    while f"{stem}-{counter}{suffix}" in used:
        counter += 1
    return f"{stem}-{counter}{suffix}"


def _batch_note(completed: int, failed: int, noun: str = "image") -> str:
    """What happened, with the failures never buried.

    The noun is a parameter because a batch of PDFs reporting "5 image(s)
    processed" is a small wrongness that tells the reader the message was
    written for something else and not thought about for their case.
    """
    if not failed:
        return f"All {completed} {noun}(s) processed."
    if not completed:
        return (
            f"All {failed} {noun}(s) failed. Nothing was produced - check the first error "
            "below, because they are usually the same problem."
        )
    return (
        f"{completed} {noun}(s) processed, {failed} failed. The failures are listed with "
        "their reasons and can be retried on their own - the successful ones do not need "
        "re-running."
    )


# What a browser is allowed to put in the bucket.
#
# Checked before a URL is signed rather than after the upload: a signed URL is a
# capability, and handing one out for a type this workspace cannot process means
# paying to store something nobody can use.

# Below this a result rides back in the response; above it, it goes to storage
# and the response carries a link.
#
# One megabyte is where base64's third-again overhead stops being worth avoiding
# a round trip. It is deliberately well under any platform request limit, so the
# behaviour changes gradually as files grow rather than failing at a cliff.
INLINE_RESULT_LIMIT = 1_000_000

# How much uploaded material to keep in memory across requests.
#
# Sized against the ceiling a batch already implies - fifty images at the
# professional tier is far more than this, so the cache helps the common case
# of several operations on one document without pretending it can hold a whole
# batch. Cloud Run instances are memory-limited; this is a budget, not a store.
OBJECT_CACHE_BYTES = 256_000_000

ALLOWED_UPLOAD_TYPES = frozenset({"image/jpeg", "image/png", "application/pdf"})


def _is_allowed_upload_type(content_type: str) -> bool:
    return content_type.split(";")[0].strip().lower() in ALLOWED_UPLOAD_TYPES
