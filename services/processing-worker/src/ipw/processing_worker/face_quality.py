"""Durable native face mechanics; no trained model is registered here."""

from __future__ import annotations

import hashlib
import logging
import secrets
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast, runtime_checkable

import numpy as np

from ipw.contracts.image_quality_face import (
    FaceQualityCandidateRequest,
    FaceQualityCompositionIntent,
    FaceQualityObject,
    NativeFaceAlignment,
    NativeFaceCandidate,
    NativeFaceCompositionRequest,
    NativeFaceContext,
    NativeFaceOutput,
    NativeFaceRegion,
    NativeFaceRelease,
    NativeFaceReview,
    StoredNativeFaceCandidate,
    native_face_candidate_sha256,
)
from ipw.processing_worker.durable_intake import DispatchMessage, WorkerOutcome
from ipw.processing_worker.face_quality_repository import (
    NativeFaceLease,
    PostgresFaceQualityWorkerRepository,
)
from ipw.processing_worker.native_face_renderer import (
    NativeFaceRenderCancelledError,
    NativeFaceRenderer,
    NativeFaceRenderError,
    native_face_colour_sha256,
    native_face_pixel_sha256,
)
from ipw.processing_worker.repository import JobBusyError
from ipw.storage import (
    LargeWorkerPrivateObjectStore,
    ObjectZone,
    PreviewPrivateObjectStore,
    PrivateObjectRef,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NativeFaceProposal:
    region: NativeFaceRegion
    pixels: np.ndarray[Any, Any]
    mask: np.ndarray[Any, Any]
    alignment: NativeFaceAlignment | None = None
    frame_alignments: tuple[NativeFaceAlignment, ...] = ()


@runtime_checkable
class NativeFaceSourceLifecycle(Protocol):
    """Release private decode/alignment scratch after success, failure or cancellation."""

    def clear_source(self) -> None: ...


class NativeFaceCandidateEngine(Protocol):
    """A future cleared detector/alignment/model adapter, not a URL or client input."""

    def release(self) -> NativeFaceRelease | None: ...
    def propose(
        self,
        *,
        source_path: Path,
        base_path: Path,
        context: NativeFaceContext,
        fidelity_permyriad: int,
        cancelled: Callable[[], bool],
    ) -> NativeFaceProposal: ...


class TemporalNativeFaceCandidateEngine:
    """Run a cleared still adapter once per logical frame without reusing stale scratch."""

    def __init__(self, engine: NativeFaceCandidateEngine) -> None:
        self._engine = engine

    def release(self) -> NativeFaceRelease | None:
        return self._engine.release()

    def propose(
        self,
        *,
        source_path: Path,
        base_path: Path,
        context: NativeFaceContext,
        fidelity_permyriad: int,
        cancelled: Callable[[], bool],
    ) -> NativeFaceProposal:
        if context.frame_count == 1:
            return self._engine.propose(
                source_path=source_path,
                base_path=base_path,
                context=context,
                fidelity_permyriad=fidelity_permyriad,
                cancelled=cancelled,
            )
        if context.bit_depth != 8:
            raise NativeFaceRenderError("Temporal native face inference requires 8-bit frames")
        try:
            from PIL import Image, UnidentifiedImageError
        except ImportError as error:
            raise NativeFaceRenderError("The temporal image runtime is unavailable") from error

        proposals: list[NativeFaceProposal] = []
        with tempfile.TemporaryDirectory(prefix="ipw-temporal-face-") as temporary:
            directory = Path(temporary)
            try:
                with Image.open(source_path) as source, Image.open(base_path) as base:
                    source_default = bool(source.info.get("default_image", False))
                    base_default = bool(base.info.get("default_image", False))
                    source_profile = source.info.get("icc_profile")
                    base_profile = base.info.get("icc_profile")
                    source_indices = range(int(source_default), int(getattr(source, "n_frames", 1)))
                    base_indices = range(int(base_default), int(getattr(base, "n_frames", 1)))
                    if (
                        len(source_indices) != context.frame_count
                        or len(base_indices) != context.frame_count
                        or source.size != (context.source_width, context.source_height)
                        or base.size != (context.output_width, context.output_height)
                    ):
                        raise NativeFaceRenderError(
                            "Temporal source/base framing changed before face inference"
                        )
                    for frame_index, (source_index, base_index) in enumerate(
                        zip(source_indices, base_indices, strict=True)
                    ):
                        if cancelled():
                            raise NativeFaceRenderCancelledError("Face work cancelled")
                        source.seek(source_index)
                        base.seek(base_index)
                        source_frame = directory / f"source-{frame_index:08d}.png"
                        base_frame = directory / f"base-{frame_index:08d}.png"
                        source.convert("RGBA").save(
                            source_frame,
                            format="PNG",
                            optimize=False,
                            compress_level=1,
                            **({"icc_profile": source_profile} if source_profile else {}),
                        )
                        base.convert("RGBA").save(
                            base_frame,
                            format="PNG",
                            optimize=False,
                            compress_level=1,
                            **({"icc_profile": base_profile} if base_profile else {}),
                        )
                        frame_context = NativeFaceContext(
                            source_width=context.source_width,
                            source_height=context.source_height,
                            output_width=context.output_width,
                            output_height=context.output_height,
                            bit_depth=context.bit_depth,
                            source_sha256=hashlib.sha256(source_frame.read_bytes()).hexdigest(),
                            base_output_sha256=hashlib.sha256(base_frame.read_bytes()).hexdigest(),
                            colour_authority_sha256=native_face_colour_sha256(base_frame),
                            frame_count=1,
                        )
                        try:
                            proposal = self._engine.propose(
                                source_path=source_frame,
                                base_path=base_frame,
                                context=frame_context,
                                fidelity_permyriad=fidelity_permyriad,
                                cancelled=cancelled,
                            )
                        finally:
                            lifecycle = cast(object, self._engine)
                            if isinstance(lifecycle, NativeFaceSourceLifecycle):
                                lifecycle.clear_source()
                        if proposal.alignment is None or proposal.frame_alignments:
                            raise NativeFaceRenderError(
                                "Every temporal face frame requires native alignment evidence"
                            )
                        proposals.append(proposal)
            except (UnidentifiedImageError, OSError, EOFError) as error:
                raise NativeFaceRenderError(
                    "Temporal face source/base could not be decoded safely"
                ) from error
        if len(proposals) != context.frame_count:
            raise NativeFaceRenderError("Temporal face inference returned incomplete frames")
        left = min(item.region.x for item in proposals)
        top = min(item.region.y for item in proposals)
        right = max(item.region.x + item.region.width for item in proposals)
        bottom = max(item.region.y + item.region.height for item in proposals)
        region = NativeFaceRegion(x=left, y=top, width=right - left, height=bottom - top)
        if region.width * region.height * context.frame_count > 16_000_000:
            raise NativeFaceRenderError("Temporal face region exceeds the bounded review budget")
        pixels = np.zeros(
            (context.frame_count, region.height, region.width, 4), dtype=np.uint8
        )
        mask = np.zeros((context.frame_count, region.height, region.width), dtype=np.uint8)
        for frame_index, proposal in enumerate(proposals):
            x = proposal.region.x - left
            y = proposal.region.y - top
            pixels[
                frame_index,
                y : y + proposal.region.height,
                x : x + proposal.region.width,
            ] = proposal.pixels
            mask[
                frame_index,
                y : y + proposal.region.height,
                x : x + proposal.region.width,
            ] = proposal.mask
        return NativeFaceProposal(
            region=region,
            pixels=pixels,
            mask=mask,
            frame_alignments=tuple(cast(NativeFaceAlignment, item.alignment) for item in proposals),
        )


class FaceSliceYieldError(RuntimeError):
    """Resume from committed candidate patches; never publish a partial PNG."""


NATIVE_FACE_REVIEW_MAX_SIDE = 2048


def bounded_native_face_review(
    pixels: np.ndarray[Any, Any],
    mask: np.ndarray[Any, Any],
    *,
    max_side: int = NATIVE_FACE_REVIEW_MAX_SIDE,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]] | None:
    """Create a bounded, non-generative review proxy from exact proposal samples."""
    height, width = mask.shape[-2:]
    if max_side < 1:
        raise ValueError("native face review bound must be positive")
    if max(height, width) <= max_side:
        return None
    scale = min(max_side / width, max_side / height)
    review_width = max(1, min(width, round(width * scale)))
    review_height = max(1, min(height, round(height * scale)))
    x = np.minimum(
        width - 1,
        ((np.arange(review_width, dtype=np.int64) * 2 + 1) * width)
        // (review_width * 2),
    )
    y = np.minimum(
        height - 1,
        ((np.arange(review_height, dtype=np.int64) * 2 + 1) * height)
        // (review_height * 2),
    )
    if mask.ndim == 2:
        return pixels[y[:, None], x[None, :]].copy(), mask[y[:, None], x[None, :]].copy()
    return (
        pixels[:, y[:, None], x[None, :], :].copy(),
        mask[:, y[:, None], x[None, :]].copy(),
    )


def native_face_fidelities(fidelity: int, count: int) -> tuple[int, ...]:
    if not 0 <= fidelity <= 10000 or count not in {2, 3}:
        raise ValueError("invalid native face candidate settings")
    # Keep candidates distinct even at the ends of the fidelity range.
    low = min(max(0, fidelity - 3500), 8000 if count == 3 else 9000)
    high = max(fidelity, low + 1000 * (count - 1))
    return (low, high) if count == 2 else (low, (low + high) // 2, high)


class DurableNativeFaceProcessor:
    def __init__(
        self,
        repository: PostgresFaceQualityWorkerRepository,
        objects: PreviewPrivateObjectStore,
        engine: NativeFaceCandidateEngine | None = None,
        *,
        worker_id: str,
        execution_lock: threading.Lock | None = None,
        max_slice_seconds: float = 8 * 60,
        heartbeat_seconds: float = 20,
    ) -> None:
        self._repository = repository
        self._objects = objects
        self._engine = engine
        self._worker_id = worker_id
        self._execution_lock = execution_lock or threading.Lock()
        self._max_slice_seconds = max_slice_seconds
        self._heartbeat_seconds = heartbeat_seconds

    def _release(self, lease: NativeFaceLease) -> NativeFaceRelease:
        current = self._engine.release() if self._engine else None
        if current is None:
            raise NativeFaceRenderError("Native face model is unregistered")
        current = NativeFaceRelease.model_validate_json(current.model_dump_json())
        if (
            current.commercial_rights != "approved"
            or current.quality_review != "approved"
            or (
                not (current.rights_evidence_id or "").strip()
                or not (current.quality_evidence_id or "").strip()
                or not current.model_id.strip()
                or not current.model_version.strip()
                or current.model_sha256 != lease.release.model_sha256
                or current.dependency_lock_sha256 != lease.release.dependency_lock_sha256
            )
        ):
            raise NativeFaceRenderError("Native face release was revoked or changed")
        return current

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        with self._execution_lock:
            return self._process(message)

    def _process(self, message: DispatchMessage) -> WorkerOutcome:
        try:
            lease = self._repository.claim_face(
                job_id=message.job_id,
                worker_id=self._worker_id,
                lease_token=secrets.token_urlsafe(32),
                trace_id=message.trace_id,
            )
        except JobBusyError:
            return WorkerOutcome("busy", message.job_id)
        if lease is None:
            return WorkerOutcome("already_terminal", message.job_id)
        stop = threading.Event()
        heartbeat_failed = threading.Event()

        def heartbeat() -> None:
            while not stop.wait(self._heartbeat_seconds):
                try:
                    self._repository.heartbeat_face(lease)
                except Exception:  # noqa: BLE001 -- Any heartbeat failure fences the worker.
                    heartbeat_failed.set()
                    return

        thread = threading.Thread(target=heartbeat, daemon=True, name="native-face-heartbeat")
        next_poll = 0.0
        cancelled = False
        deadline = time.monotonic() + self._max_slice_seconds
        made_checkpoint = False
        uncommitted: list[FaceQualityObject] = []

        def check() -> bool:
            nonlocal next_poll, cancelled
            if heartbeat_failed.is_set():
                raise JobBusyError(lease.job_id)
            now = time.monotonic()
            if now >= next_poll:
                cancelled = self._repository.cancelled_face(lease)
                next_poll = now + 0.25
            if cancelled:
                return True
            if now >= deadline:
                raise FaceSliceYieldError("Native face invocation yielded")
            return False

        try:
            self._repository.start_face(lease)
            self._release(lease)
            if check():
                raise NativeFaceRenderCancelledError("Face work cancelled")
            thread.start()
            with tempfile.TemporaryDirectory(prefix="ipw-durable-face-") as temporary:
                directory = Path(temporary)
                source_path = self._materialize(lease.source, directory / "source.bin")
                base_path = self._materialize(lease.base, directory / "base.png")
                context = NativeFaceContext(
                    source_sha256=lease.source.sha256,
                    base_output_sha256=lease.base.sha256,
                    source_width=lease.source_width,
                    source_height=lease.source_height,
                    output_width=lease.output_width,
                    output_height=lease.output_height,
                    bit_depth=lease.bit_depth,
                    colour_authority_sha256=native_face_colour_sha256(base_path),
                    frame_count=lease.output_frame_count,
                )
                stored = self._repository.candidates_face(lease)
                if lease.operation == "candidates":
                    settings = cast(FaceQualityCandidateRequest, lease.intent)
                    fidelities = native_face_fidelities(
                        settings.fidelity_permyriad, settings.candidate_count
                    )
                    for ordinal, fidelity in enumerate(fidelities):
                        self._release(lease)
                        if check():
                            raise NativeFaceRenderCancelledError("Face work cancelled")
                        if ordinal < len(stored):
                            self._verify_candidate(lease, stored[ordinal], context, fidelity)
                            continue
                        candidate_engine: NativeFaceCandidateEngine = cast(
                            NativeFaceCandidateEngine, self._engine
                        )
                        if context.frame_count > 1:
                            candidate_engine = TemporalNativeFaceCandidateEngine(candidate_engine)
                        proposal = candidate_engine.propose(
                            source_path=source_path,
                            base_path=base_path,
                            context=context,
                            fidelity_permyriad=fidelity,
                            cancelled=check,
                        )
                        self._release(lease)
                        if self._repository.cancelled_face(lease):
                            raise NativeFaceRenderCancelledError("Face work cancelled")
                        saved = self._store_proposal(
                            lease, proposal, context, fidelity, ordinal, uncommitted
                        )
                        self._release(lease)
                        if self._repository.cancelled_face(lease):
                            raise NativeFaceRenderCancelledError("Face work cancelled")
                        self._repository.checkpoint_candidate(lease, ordinal, saved)
                        self._committed(
                            uncommitted,
                            saved.pixels,
                            saved.mask,
                            saved.review_pixels,
                            saved.review_mask,
                        )
                        made_checkpoint = True
                    self._release(lease)
                    self._repository.complete_face(lease)
                else:
                    intent = cast(FaceQualityCompositionIntent, lease.intent)
                    selected = next(
                        (
                            item
                            for item in stored
                            if native_face_candidate_sha256(item.candidate)
                            == intent.candidate_sha256
                        ),
                        None,
                    )
                    if selected is None:
                        raise NativeFaceRenderError("Reviewed native candidate is unavailable")
                    pixels, mask = self._verify_candidate(
                        lease, selected, context, selected.candidate.fidelity_permyriad
                    )
                    review = NativeFaceReview(
                        source_sha256=intent.source_sha256,
                        base_output_sha256=intent.base_output_sha256,
                        candidate_sha256=intent.candidate_sha256,
                        allow_reconstructed_face_detail=True,
                        acknowledged_possible_identity_change=True,
                    )
                    request = NativeFaceCompositionRequest(
                        candidate=selected.candidate, review=review
                    )
                    result = NativeFaceRenderer().compose(
                        request,
                        release=self._release(lease),
                        source_path=source_path,
                        base_path=base_path,
                        pixels=pixels,
                        mask=mask,
                        output_path=directory / "reviewed.png",
                        cancelled=check,
                    )
                    self._release(lease)
                    if self._repository.cancelled_face(lease):
                        raise NativeFaceRenderCancelledError("Face work cancelled")
                    ref = PrivateObjectRef(
                        lease.owner_scope,
                        f"derivative/{lease.owner_scope}/face/{lease.face_id}/"
                        f"attempt-{lease.attempt}-{lease.lease_hash[:12]}/{result.sha256}.png",
                        ObjectZone.DERIVATIVE,
                    )
                    if not isinstance(self._objects, LargeWorkerPrivateObjectStore):
                        raise NativeFaceRenderError(
                            "Native face output requires file-streaming storage"
                        )
                    written = self._objects.write_derivative_file(
                        ref,
                        source=result.path,
                        media_type="image/png",
                        sha256=result.sha256,
                        max_bytes=result.byte_size,
                    )
                    stored_output = FaceQualityObject(
                        owner_scope=lease.owner_scope,
                        object_key=ref.object_key,
                        generation=written.generation,
                        sha256=result.sha256,
                        byte_size=result.byte_size,
                    )
                    uncommitted.append(stored_output)
                    self._release(lease)
                    output = NativeFaceOutput(
                        object=stored_output,
                        width=lease.output_width,
                        height=lease.output_height,
                        bit_depth=lease.bit_depth,
                        frame_count=lease.output_frame_count,
                        changed_pixels=result.changed_pixels,
                        evidence=result.evidence,
                    )
                    self._repository.complete_face(lease, output)
                    self._committed(uncommitted, output.object)
            return WorkerOutcome("succeeded", lease.job_id)
        except JobBusyError:
            return WorkerOutcome("busy", lease.job_id)
        except FaceSliceYieldError:
            try:
                if made_checkpoint:
                    self._repository.yield_face(lease)
                    state = "retry_wait"
                else:
                    # A decode/inference/encode that never advances must exhaust
                    # bounded retries, not create endless refunded invocations.
                    state = self._repository.fail_face(
                        lease, code="face-slice-budget-exceeded", retryable=True
                    )
            except JobBusyError:
                return WorkerOutcome("busy", lease.job_id)
            return WorkerOutcome(state, lease.job_id)
        except Exception as error:  # noqa: BLE001 -- Task boundary records content-safe failures.
            is_cancel = isinstance(error, NativeFaceRenderCancelledError)
            retryable = isinstance(error, (OSError, TimeoutError, RuntimeError)) and not is_cancel
            try:
                state = self._repository.fail_face(
                    lease,
                    code="face-worker-temporary-failure"
                    if retryable
                    else "face-input-or-release-rejected",
                    retryable=retryable,
                    cancelled=is_cancel,
                )
            except JobBusyError:
                return WorkerOutcome("busy", lease.job_id)
            return WorkerOutcome(state, lease.job_id)
        finally:
            stop.set()
            if thread.ident is not None:
                thread.join(timeout=35)
            self._discard_uncommitted(uncommitted)
            lifecycle = cast(object, self._engine)
            if isinstance(lifecycle, NativeFaceSourceLifecycle):
                lifecycle.clear_source()

    def _materialize(self, stored: FaceQualityObject, destination: Path) -> Path:
        if not isinstance(self._objects, LargeWorkerPrivateObjectStore):
            raise NativeFaceRenderError(
                "Native face processing requires private file-streaming storage"
            )
        ref = PrivateObjectRef(
            stored.owner_scope, stored.object_key, ObjectZone(stored.object_key.split("/", 1)[0])
        )
        materialized = self._objects.materialize(
            ref, generation=stored.generation, destination=destination, max_bytes=stored.byte_size
        )
        if (
            materialized.sha256 != stored.sha256
            or materialized.byte_size != stored.byte_size
            or materialized.generation != stored.generation
        ):
            raise NativeFaceRenderError("Private native face source/base identity changed")
        return materialized.path

    def _read(self, stored: FaceQualityObject) -> bytes:
        snapshot = self._objects.read(
            PrivateObjectRef(stored.owner_scope, stored.object_key, ObjectZone.DERIVATIVE),
            generation=stored.generation,
            max_bytes=stored.byte_size,
        )
        if (
            snapshot.generation != stored.generation
            or len(snapshot.data) != stored.byte_size
            or hashlib.sha256(snapshot.data).hexdigest() != stored.sha256
        ):
            raise NativeFaceRenderError("Stored native face patch or mask changed")
        return snapshot.data

    def _verify_candidate(
        self,
        lease: NativeFaceLease,
        stored: StoredNativeFaceCandidate,
        context: NativeFaceContext,
        fidelity: int,
    ) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
        candidate = stored.candidate
        if (
            stored.pixels.owner_scope != lease.owner_scope
            or candidate.context != context
            or candidate.fidelity_permyriad != fidelity
            or (
                candidate.model_sha256 != lease.release.model_sha256
                or candidate.dependency_lock_sha256 != lease.release.dependency_lock_sha256
            )
        ):
            raise NativeFaceRenderError(
                "Native face checkpoint belongs to different pixels/settings/model"
            )
        area = candidate.region
        frame_prefix = (context.frame_count,) if context.frame_count > 1 else ()
        pixels = np.frombuffer(
            self._read(stored.pixels), dtype="<u2" if context.bit_depth == 16 else "u1"
        ).reshape(*frame_prefix, area.height, area.width, 4)
        mask = np.frombuffer(self._read(stored.mask), dtype="u1").reshape(
            *frame_prefix, area.height, area.width
        )
        return pixels, mask

    def _store_proposal(
        self,
        lease: NativeFaceLease,
        proposal: NativeFaceProposal,
        context: NativeFaceContext,
        fidelity: int,
        ordinal: int,
        uncommitted: list[FaceQualityObject],
    ) -> StoredNativeFaceCandidate:
        region = proposal.region
        frame_prefix = (context.frame_count,) if context.frame_count > 1 else ()
        if proposal.pixels.dtype != np.dtype("uint16" if context.bit_depth == 16 else "uint8") or (
            proposal.pixels.shape != (*frame_prefix, region.height, region.width, 4)
            or proposal.mask.dtype != np.dtype("uint8")
            or proposal.mask.shape != (*frame_prefix, region.height, region.width)
            or not np.any(proposal.mask)
        ):
            raise NativeFaceRenderError("Native proposal shape, mask or precision is invalid")
        pixels, mask = proposal.pixels.copy(), proposal.mask.copy()
        raw = pixels.astype("<u2" if context.bit_depth == 16 else "u1", copy=False).tobytes()
        mask_raw = mask.tobytes()
        candidate = NativeFaceCandidate(
            candidate_id="cand-"
            + hashlib.sha256(f"{lease.face_id}:{ordinal}".encode()).hexdigest()[:32],
            context=context,
            model_sha256=lease.release.model_sha256,
            dependency_lock_sha256=lease.release.dependency_lock_sha256,
            fidelity_permyriad=fidelity,
            region=region,
            pixels_sha256=native_face_pixel_sha256(pixels),
            mask_sha256=hashlib.sha256(mask_raw).hexdigest(),
            alignment=proposal.alignment,
            frame_alignments=proposal.frame_alignments,
        )
        identity = native_face_candidate_sha256(candidate)

        attempt = f"attempt-{lease.attempt}-{lease.lease_hash[:12]}"

        def write(label: str, data: bytes, digest: str) -> FaceQualityObject:
            ref = PrivateObjectRef(
                lease.owner_scope,
                f"derivative/{lease.owner_scope}/face/{lease.face_id}/{identity}/{attempt}/{label}",
                ObjectZone.DERIVATIVE,
            )
            written = self._objects.write_derivative(
                ref,
                data=data,
                sha256=digest,
                media_type="application/octet-stream",
                max_bytes=len(data),
            )
            stored = FaceQualityObject(
                owner_scope=lease.owner_scope,
                object_key=ref.object_key,
                generation=written.generation,
                sha256=digest,
                byte_size=len(data),
            )
            uncommitted.append(stored)
            return stored

        review = bounded_native_face_review(pixels, mask)
        review_pixels: FaceQualityObject | None = None
        review_mask: FaceQualityObject | None = None
        review_width: int | None = None
        review_height: int | None = None
        if review is not None:
            review_pixel_array, review_mask_array = review
            review_raw = review_pixel_array.astype(
                "<u2" if context.bit_depth == 16 else "u1", copy=False
            ).tobytes()
            review_mask_raw = review_mask_array.astype("u1", copy=False).tobytes()
            review_pixels = write(
                "review-pixels", review_raw, hashlib.sha256(review_raw).hexdigest()
            )
            review_mask = write(
                "review-mask", review_mask_raw, hashlib.sha256(review_mask_raw).hexdigest()
            )
            review_height, review_width = review_mask_array.shape[-2:]

        return StoredNativeFaceCandidate(
            candidate=candidate,
            pixels=write("pixels", raw, candidate.pixels_sha256),
            mask=write("mask", mask_raw, candidate.mask_sha256),
            review_pixels=review_pixels,
            review_mask=review_mask,
            review_width=review_width,
            review_height=review_height,
        )

    @staticmethod
    def _committed(
        uncommitted: list[FaceQualityObject], *objects: FaceQualityObject | None
    ) -> None:
        committed = {(item.object_key, item.generation) for item in objects if item is not None}
        uncommitted[:] = [
            item
            for item in uncommitted
            if (item.object_key, item.generation) not in committed
        ]

    def _discard_uncommitted(self, objects: list[FaceQualityObject]) -> None:
        for item in reversed(objects):
            try:
                self._objects.delete(
                    PrivateObjectRef(item.owner_scope, item.object_key, ObjectZone.DERIVATIVE),
                    generation=item.generation,
                )
            except Exception:  # noqa: BLE001 -- Best-effort unique-attempt orphan cleanup.
                logger.warning(
                    "Uncommitted native face artifact cleanup failed; "
                    "provider lifecycle cleanup is required"
                )
