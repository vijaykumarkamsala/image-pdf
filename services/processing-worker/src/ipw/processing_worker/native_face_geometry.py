"""Bounded YuNet geometry in immutable source-image coordinates.

Head decoding follows OpenCV 4.12 face_detect.cpp. No person is chosen silently.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from ipw.contracts.image_quality_face import (
    NativeFaceAlignment,
    NativeFaceContext,
    NativeFaceRegion,
)
from ipw.processing_worker.native_face_renderer import NativeFaceRenderError

TEMPLATE = np.array(
    [
        [192.98138, 239.94708],
        [318.90277, 240.19360],
        [256.63416, 314.01935],
        [201.26117, 371.41043],
        [313.08905, 371.15118],
    ],
    dtype=np.float64,
)


@dataclass(frozen=True)
class Detection:
    box: tuple[float, float, float, float]
    landmarks: np.ndarray[Any, Any]
    confidence: float


def detector_windows(width: int, height: int, *, limit: int = 128) -> tuple[tuple[int, ...], ...]:
    if width < 1 or height < 1 or not 1 <= limit <= 128:
        raise NativeFaceRenderError("Invalid native detector scan budget")
    overview = (0, 0, width, height)
    if width <= 640 and height <= 640:
        return (overview,)

    def starts(size: int) -> list[int]:
        # Count before allocating positions; huge images must not allocate huge lists.
        if math.ceil(max(0, size - 640) / 512) + 1 > limit:
            raise NativeFaceRenderError("Complete native face scan exceeds the window budget")
        return sorted({*range(0, max(1, size - 640), 512), max(0, size - 640)})

    xs, ys = starts(width), starts(height)
    if 1 + len(xs) * len(ys) > limit:
        raise NativeFaceRenderError("Complete native face scan exceeds the window budget")
    tiles = [(x, y, min(640, width - x), min(640, height - y)) for y in ys for x in xs]
    return tuple(dict.fromkeys([overview, *tiles]))


def sample_rgb(
    native: np.ndarray[Any, Any],
    x: np.ndarray[Any, Any],
    y: np.ndarray[Any, Any],
    to_working: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]],
) -> np.ndarray[Any, Any]:
    """Bilinear sampling of working float RGB; never quantize to an 8-bit intermediary."""
    x, y = np.clip(x, 0, native.shape[1] - 1), np.clip(y, 0, native.shape[0] - 1)
    left, top = np.floor(x).astype(int), np.floor(y).astype(int)
    right, bottom = (
        np.minimum(left + 1, native.shape[1] - 1),
        np.minimum(top + 1, native.shape[0] - 1),
    )
    fx, fy = (x - left)[..., None], (y - top)[..., None]
    a, b = to_working(native[top, left, :3]), to_working(native[top, right, :3])
    c, d = to_working(native[bottom, left, :3]), to_working(native[bottom, right, :3])
    return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy).astype(np.float32)


def detector_tensor(
    native: np.ndarray[Any, Any],
    window: tuple[int, ...],
    to_working: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]],
) -> np.ndarray[Any, Any]:
    ox, oy, width, height = window
    scale = min(640 / width, 640 / height)
    yy, xx = np.mgrid[:640, :640]
    sampled = sample_rgb(
        native,
        np.clip(ox + (xx + 0.5) / scale - 0.5, ox, ox + width - 1),
        np.clip(oy + (yy + 0.5) / scale - 0.5, oy, oy + height - 1),
        to_working,
    )
    sampled[((xx + 0.5) > width * scale) | ((yy + 0.5) > height * scale)] = 0
    return np.ascontiguousarray(sampled[..., ::-1].transpose(2, 0, 1)[None] * 255, dtype=np.float32)


def decode_heads(
    heads: Mapping[str, np.ndarray[Any, Any]], window: tuple[int, ...]
) -> list[Detection]:
    ox, oy, width, height = window
    scale = min(640 / width, 640 / height)
    found = []
    for stride in (8, 16, 32):
        grid = 640 // stride
        values = {}
        for name, channels in (("cls", 1), ("obj", 1), ("bbox", 4), ("kps", 10)):
            value = heads.get(f"{name}_{stride}")
            if (
                value is None
                or value.dtype != np.float32
                or value.shape != (1, grid * grid, channels)
                or not np.all(np.isfinite(value))
            ):
                raise NativeFaceRenderError("Native detector output is incompatible or nonfinite")
            values[name] = value[0]
        scores = np.sqrt(np.clip(values["cls"][:, 0], 0, 1) * np.clip(values["obj"][:, 0], 0, 1))
        for index in np.flatnonzero(scores >= 0.85):
            row, column = divmod(int(index), grid)
            offsets = values["bbox"][index]
            if np.any(np.abs(offsets[2:]) > 20):
                continue
            w, h = np.exp(offsets[2:].astype(np.float64)) * stride / scale
            cx, cy = (
                (column + float(offsets[0])) * stride / scale + ox,
                (row + float(offsets[1])) * stride / scale + oy,
            )
            points = values["kps"][index].reshape(5, 2).astype(np.float64)
            points = (points + np.array([column, row])) * stride / scale + np.array([ox, oy])
            if (
                min(w, h) < 24
                or w > width * 2
                or h > height * 2
                or np.any(points < [ox, oy])
                or np.any(points >= [ox + width, oy + height])
            ):
                continue
            found.append(
                Detection(
                    (cx - w / 2, cy - h / 2, float(w), float(h)), points, float(scores[index])
                )
            )
    # Dense/conflicting predictions are uncertainty, not an invitation to quadratic NMS.
    if len(found) > 512:
        raise NativeFaceRenderError("Native face detector returned too many possible regions")
    return found


def single_face(detections: list[Detection]) -> Detection:
    if len(detections) > 4096:
        raise NativeFaceRenderError("Native face detections exceed the bounded review budget")
    kept: list[Detection] = []
    for detection in sorted(detections, key=lambda item: item.confidence, reverse=True):
        x, y, w, h = detection.box
        duplicate = False
        for previous in kept:
            px, py, pw, ph = previous.box
            intersection = max(0, min(x + w, px + pw) - max(x, px)) * max(
                0, min(y + h, py + ph) - max(y, py)
            )
            if intersection / max(1e-12, w * h + pw * ph - intersection) > 0.3:
                duplicate = True
                break
        if not duplicate:
            kept.append(detection)
    if len(kept) != 1:
        raise NativeFaceRenderError(
            "No single confident face; multiple-face selection is not supported"
        )
    return kept[0]


def align_face(detection: Detection, detector_sha256: str) -> NativeFaceAlignment:
    points = np.rint(detection.landmarks * 1_000_000).astype(np.int64) / 1_000_000
    if not np.all(np.isfinite(points)) or np.linalg.norm(points[1] - points[0]) < 8:
        raise NativeFaceRenderError(
            "Face landmarks are uncertain or too small for native alignment"
        )
    source_mean, target_mean = points.mean(axis=0), TEMPLATE.mean(axis=0)
    source, target = points - source_mean, TEMPLATE - target_mean
    denominator = float(np.sum(source * source))
    if denominator < 1e-12:
        raise NativeFaceRenderError("Face landmarks are degenerate")
    a = float(np.sum(source * target) / denominator)
    b = float(np.sum(source[:, 0] * target[:, 1] - source[:, 1] * target[:, 0]) / denominator)
    tx, ty = target_mean - [
        a * source_mean[0] - b * source_mean[1],
        b * source_mean[0] + a * source_mean[1],
    ]
    fixed = tuple(round(float(value) * 1_000_000_000) for value in (a, b, tx, ty))
    a, b, tx, ty = np.array(fixed, dtype=np.float64) / 1_000_000_000
    mapped = points @ np.array([[a, b], [-b, a]]) + [tx, ty]
    error = math.sqrt(float(np.mean(np.sum((mapped - TEMPLATE) ** 2, axis=1))))
    if error > 24 or a * a + b * b < 1e-12:
        raise NativeFaceRenderError("Face landmarks do not form a reliable similarity alignment")
    return NativeFaceAlignment.model_validate(
        {
            "detector_sha256": detector_sha256,
            "confidence_permyriad": round(detection.confidence * 10000),
            "source_landmarks_micropixels": np.rint(points * 1_000_000).astype(np.int64).tolist(),
            "similarity_nanounits": fixed,
            "reprojection_error_millipixels": round(error * 1000),
        }
    )


def inverse(alignment: NativeFaceAlignment) -> tuple[float, float, float, float]:
    a, b, tx, ty = np.array(alignment.similarity_nanounits, dtype=np.float64) / 1_000_000_000
    denominator = a * a + b * b
    return (
        float(a / denominator),
        float(-b / denominator),
        float((-a * tx - b * ty) / denominator),
        float((b * tx - a * ty) / denominator),
    )


def aligned_rgb(
    native: np.ndarray[Any, Any],
    alignment: NativeFaceAlignment,
    to_working: Callable[[np.ndarray[Any, Any]], np.ndarray[Any, Any]],
) -> np.ndarray[Any, Any]:
    a, b, tx, ty = inverse(alignment)
    yy, xx = np.mgrid[:512, :512]
    return sample_rgb(native, a * xx - b * yy + tx, b * xx + a * yy + ty, to_working)


def proposal_coordinates(
    context: NativeFaceContext, alignment: NativeFaceAlignment
) -> tuple[NativeFaceRegion, np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    a, b, tx, ty = inverse(alignment)
    scale = context.output_width / context.source_width
    cx, cy = a * 256 - b * 309 + tx, b * 256 + a * 309 + ty
    rx, ry = math.hypot(a * 148, b * 168), math.hypot(b * 148, a * 168)
    left, top = (
        max(0, math.floor((cx - rx + 0.5) * scale - 0.5)),
        max(0, math.floor((cy - ry + 0.5) * scale - 0.5)),
    )
    right, bottom = (
        min(context.output_width, math.ceil((cx + rx + 0.5) * scale + 0.5)),
        min(context.output_height, math.ceil((cy + ry + 0.5) * scale + 0.5)),
    )
    if right <= left or bottom <= top:
        raise NativeFaceRenderError("Aligned face lies outside the native output")
    region = NativeFaceRegion(x=left, y=top, width=right - left, height=bottom - top)
    yy, xx = np.mgrid[top:bottom, left:right]
    source_x, source_y = (xx + 0.5) / scale - 0.5, (yy + 0.5) / scale - 0.5
    a, b, tx, ty = np.array(alignment.similarity_nanounits, dtype=np.float64) / 1_000_000_000
    u, v = a * source_x - b * source_y + tx, b * source_x + a * source_y + ty
    radius = np.sqrt(((u - 256) / 148) ** 2 + ((v - 309) / 168) ** 2)
    t = np.clip((1 - radius) / 0.08, 0, 1)
    mask = np.rint(t * t * (3 - 2 * t) * 255).astype(np.uint8)
    return region, u, v, mask
