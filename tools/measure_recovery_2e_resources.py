"""Measure the bounded Recovery 2E high-resolution export in a fresh process.

The input is a committed, rights-cleared geometric fixture. The command emits
machine-readable evidence and does not write image bytes or access providers.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

from ipw.processing_worker.enhancement_engine import (
    MAX_COMPRESSED_SOURCE_BYTES,
    MAX_DIMENSION,
    MAX_OUTPUT_BYTES,
    MAX_PIXELS,
    MAX_PROCESS_RSS_BYTES,
    MAX_PROCESS_SECONDS,
    DeterministicImageEngine,
    VerifiedRasterAsset,
    process_peak_rss_bytes,
)


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    source_path = root / "data/fixtures/images/recovery2e/bounded-high-resolution-3200x2600.png"
    source = source_path.read_bytes()
    source_sha256 = hashlib.sha256(source).hexdigest()
    snapshot = {
        "artboards": [
            {
                "artboard_id": "artboard-resource-probe",
                "name": "Bounded high resolution",
                "order": 0,
                "width": 3200,
                "height": 2600,
                "unit": "px",
                "orientation": "landscape",
                "background": {"kind": "transparent", "color": None},
            }
        ],
        "shared_assets": [
            {
                "shared_asset_id": "asset-resource-probe",
                "kind": "raster",
                "source_version_id": "source-resource-probe",
                "asset_original_id": "original-resource-probe",
            }
        ],
        "masks": [],
        "layers": [
            {
                "layer_id": "layer-resource-probe",
                "artboard_id": "artboard-resource-probe",
                "parent_layer_id": None,
                "layer_type": "raster_image",
                "name": "Bounded source",
                "order": 0,
                "visible": True,
                "locked": False,
                "opacity": 1,
                "blend_mode": "normal",
                "transform": {
                    "x": 0,
                    "y": 0,
                    "width": 3200,
                    "height": 2600,
                    "rotation_degrees": 0,
                    "scale_x": 1,
                    "scale_y": 1,
                    "skew_x_degrees": 0,
                    "skew_y_degrees": 0,
                    "flip_x": False,
                    "flip_y": False,
                },
                "raster": {
                    "shared_asset_id": "asset-resource-probe",
                    "crop": {"left": 0, "top": 0, "right": 1, "bottom": 1},
                    "adjustments": {},
                    "mask_ids": [],
                },
            }
        ],
    }
    asset = VerifiedRasterAsset(
        shared_asset_id="asset-resource-probe",
        source_version_id="source-resource-probe",
        sha256=source_sha256,
        media_type="image/png",
        byte_size=len(source),
        width=3200,
        height=2600,
        data=source,
        orientation=None,
        bit_depth=8,
        frame_count=1,
        has_icc_profile=False,
        colour_model="rgb",
    )
    profile = {
        "profile_id": "profile-resource-probe",
        "name": "Bounded PNG",
        "purpose": "custom",
        "format": "png",
        "width": 3200,
        "height": 2600,
        "fit": "contain",
        "lossless": True,
        "resampling_algorithm": "lanczos",
        "colour_profile": "srgb",
        "bit_depth": 8,
        "alpha_behavior": "preserve",
        "metadata_policy": {},
        "collision_behavior": "fail",
    }
    started = time.monotonic()
    rendered = DeterministicImageEngine().render(
        snapshot=snapshot,
        artboard_id="artboard-resource-probe",
        assets={"asset-resource-probe": asset},
        operations=[],
        profile=profile,
    )
    elapsed = time.monotonic() - started
    peak = process_peak_rss_bytes()
    if peak > MAX_PROCESS_RSS_BYTES or elapsed > MAX_PROCESS_SECONDS:
        raise RuntimeError("measured execution exceeded the configured process budget")
    print(
        json.dumps(
            {
                "fixture": source_path.relative_to(root).as_posix(),
                "source_sha256": source_sha256,
                "source_bytes": len(source),
                "source_dimensions": [3200, 2600],
                "decoded_pixels": 3200 * 2600,
                "output_sha256": rendered.sha256,
                "output_bytes": len(rendered.data),
                "output_dimensions": [rendered.width, rendered.height],
                "elapsed_seconds": round(elapsed, 3),
                "peak_process_rss_bytes": peak,
                "peak_process_rss_mib": round(peak / (1024 * 1024), 1),
                "limits": {
                    "compressed_source_bytes": MAX_COMPRESSED_SOURCE_BYTES,
                    "decoded_pixels": MAX_PIXELS,
                    "dimension": MAX_DIMENSION,
                    "output_bytes": MAX_OUTPUT_BYTES,
                    "process_rss_bytes": MAX_PROCESS_RSS_BYTES,
                    "elapsed_seconds": MAX_PROCESS_SECONDS,
                    "worker_concurrency": 1,
                },
                "pid": os.getpid(),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
