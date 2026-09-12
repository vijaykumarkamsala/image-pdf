"""Generate the POC-004 golden outputs for every standard operation and engine.

Golden strategy is **exact SHA-256** (D-046), not pixel tolerance. Library
versions are pinned, so any change in output bytes is either a deliberate upgrade
or a regression, and both deserve to fail the build and be looked at. A tolerance
would let a genuine resampling regression through, and detecting exactly that is
what this benchmark exists for.

When a pinned version is bumped, the procedure is deliberate:

1. Bump the version in the workspace ``pyproject.toml`` and the licence register.
2. Run ``python tools/make_goldens.py --check`` and read which operations moved.
3. Regenerate, then **look at the images**, not just the hashes.
4. Record the visual assessment in the task report before committing.

Each engine owns its own goldens. Pillow and libvips implement different
resampling and different encoders, so their bytes will never match - comparing
them is the point of running both, not a defect.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools.image_compatibility import (
    native_downscale_rounding_matches,
    portable_metadata_value,
)

if TYPE_CHECKING:
    from ipw.contracts.operation import AnySettings

# --- the operation matrix -----------------------------------------------------
# Every POC-004 operation, with settings chosen so the effect is visible in a
# 64x64 fixture rather than lost in rounding.


def operation_matrix() -> dict[str, AnySettings]:
    from ipw.contracts.asset import MediaType
    from ipw.contracts.operation import (
        AdjustSettings,
        ConvertSettings,
        CropSettings,
        DenoiseSettings,
        FlipSettings,
        ResizeSettings,
        RotateSettings,
        SharpenSettings,
    )

    return {
        "resize-bicubic-32": ResizeSettings(algorithm="bicubic", target_width=32, target_height=32),
        "resize-lanczos-32": ResizeSettings(algorithm="lanczos", target_width=32, target_height=32),
        "resize-lanczos-128-upscale": ResizeSettings(
            algorithm="lanczos", target_width=128, target_height=128
        ),
        "resize-scale-half": ResizeSettings(
            algorithm="bicubic", scale_numerator=1, scale_denominator=2
        ),
        "crop-centre-32": CropSettings(x=16, y=16, width=32, height=32),
        "rotate-90": RotateSettings(degrees=90),
        "rotate-180": RotateSettings(degrees=180),
        "rotate-270": RotateSettings(degrees=270),
        "flip-horizontal": FlipSettings(axis="horizontal"),
        "flip-vertical": FlipSettings(axis="vertical"),
        "adjust-brighter": AdjustSettings(brightness_percent=20),
        "adjust-contrast": AdjustSettings(contrast_percent=30),
        "adjust-saturation": AdjustSettings(saturation_percent=40),
        "adjust-white-balance-auto": AdjustSettings(white_balance="auto"),
        "sharpen-moderate": SharpenSettings(amount_percent=80, radius_x100=200),
        "denoise-moderate": DenoiseSettings(strength_percent=30),
        "convert-to-jpeg-q90": ConvertSettings(target_media_type=MediaType.JPEG, quality=90),
        "convert-to-png": ConvertSettings(target_media_type=MediaType.PNG, quality=95),
    }


SOURCE = "data/fixtures/images/synthetic-gradient-64.png"
NOISE_SOURCE = "data/fixtures/images/synthetic-noise-64.png"

NOISE_OPERATIONS = frozenset({"sharpen-moderate", "denoise-moderate"})
"""Operations that need genuine high-frequency content to mean anything.

A 3x3 median filter of a linear ramp returns the centre value unchanged, so a
denoise golden taken from the smooth gradient fixture came out byte-identical to
a plain re-encode - it proved nothing. These operations run against the noise
fixture instead, which gives the filter something to remove and something it
must preserve.
"""

NATIVE_DOWNSCALE_OPERATIONS = frozenset(
    {"resize-bicubic-32", "resize-lanczos-32", "resize-scale-half"}
)
"""libvips operations with bounded cross-compiled integer rounding evidence."""


def goldens_dir(repo_root: Path) -> Path:
    return repo_root / "data" / "goldens"


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def _decoded_signature(payload: bytes) -> dict[str, object]:
    """Cross-platform image evidence without claiming encoder-byte identity."""

    from PIL import Image

    with Image.open(io.BytesIO(payload)) as image:
        image.load()
        return {
            "format": image.format,
            "mode": image.mode,
            "size": list(image.size),
            "frames": int(getattr(image, "n_frames", 1)),
            "pixels_sha256": hashlib.sha256(image.tobytes()).hexdigest(),
            "metadata": {
                key: portable_metadata_value(key, value)
                for key, value in sorted(image.info.items())
                if key not in {"duration"}
            },
        }


def _decoded_pixels(payload: bytes) -> bytes:
    from PIL import Image

    with Image.open(io.BytesIO(payload)) as image:
        image.load()
        return image.tobytes()


def _windows_compatible(
    canonical: bytes, candidate: bytes, *, engine_name: str, operation_name: str
) -> tuple[bool, str]:
    canonical_signature = _decoded_signature(canonical)
    candidate_signature = _decoded_signature(candidate)
    if canonical_signature == candidate_signature:
        return True, ""

    canonical_structure = {
        key: value for key, value in canonical_signature.items() if key != "pixels_sha256"
    }
    candidate_structure = {
        key: value for key, value in candidate_signature.items() if key != "pixels_sha256"
    }
    if (
        engine_name == "libvips"
        and operation_name in NATIVE_DOWNSCALE_OPERATIONS
        and canonical_structure == candidate_structure
    ):
        size = canonical_signature["size"]
        assert isinstance(size, list)
        pixel_count = int(size[0]) * int(size[1])
        if native_downscale_rounding_matches(
            _decoded_pixels(canonical), _decoded_pixels(candidate), pixel_count=pixel_count
        ):
            return True, " (bounded native downscale rounding)"
    return False, ""


def generate(repo_root: Path, *, check: bool, compatibility: bool = False) -> int:
    import hashlib as _hashlib

    from ipw.contracts.operation import Operation, ProcessingVariant
    from ipw.contracts.runtime import InputRef, RunContext, workspace
    from ipw.processors.standard import StandardProcessor, pillow_processor, vips_processor

    def make_ref(relative: str, asset_id: str) -> InputRef:
        path = repo_root / relative
        payload = path.read_bytes()
        return InputRef(
            asset_id=asset_id,
            expected_sha256=_hashlib.sha256(payload).hexdigest(),
            path=path,
            declared_bytes=len(payload),
        )

    refs = {
        "smooth": make_ref(SOURCE, "golden-source"),
        "noise": make_ref(NOISE_SOURCE, "golden-source-noise"),
    }

    engines: dict[str, StandardProcessor[Any]] = {
        "pillow": pillow_processor(),
        "libvips": vips_processor(),
    }
    matrix = operation_matrix()
    problems = 0
    skipped: list[str] = []
    manifest: dict[str, dict[str, dict[str, object]]] = {}
    committed_index = goldens_dir(repo_root) / "index.json"
    committed = (
        json.loads(committed_index.read_text(encoding="utf-8"))
        if compatibility and committed_index.is_file()
        else None
    )
    if compatibility and committed is None:
        sys.stderr.write("canonical Linux golden index is missing\n")
        return 1

    for engine_name, processor in engines.items():
        if not processor.engine.available:
            skipped.append(engine_name)
            sys.stdout.write(f"{engine_name}: unavailable on this host, skipped\n")
            continue

        target = goldens_dir(repo_root) / engine_name
        target.mkdir(parents=True, exist_ok=True)
        manifest[engine_name] = {}

        with RunContext.create(temp_root=repo_root / ".tmp-goldens", deterministic=True) as ctx:
            for name, settings in matrix.items():
                operation = Operation.build(
                    settings, ProcessingVariant.STANDARD_SERVER_AUTHORITATIVE
                )
                ref = refs["noise" if name in NOISE_OPERATIONS else "smooth"]
                with workspace(ctx.temp_root, "golden") as ws:
                    outcome = processor.process(ref, operation, settings, ws, ctx)
                    if not outcome.succeeded or outcome.output is None:
                        code = outcome.failure.code.value if outcome.failure else "?"
                        sys.stderr.write(f"{engine_name}/{name}: FAILED {code}\n")
                        problems += 1
                        continue
                    produced = (ws.root / outcome.output.relative_path).read_bytes()

                extension = Path(outcome.output.relative_path).suffix
                path = target / f"{name}{extension}"
                digest = hashlib.sha256(produced).hexdigest()
                manifest[engine_name][name] = {
                    "file": path.relative_to(repo_root).as_posix(),
                    "sha256": digest,
                    "bytes": len(produced),
                    "width": outcome.output.width,
                    "height": outcome.output.height,
                    "media_type": outcome.output.media_type,
                    "source": NOISE_SOURCE if name in NOISE_OPERATIONS else SOURCE,
                }

                if compatibility:
                    assert committed is not None
                    entry = committed.get("engines", {}).get(engine_name, {}).get(name)
                    if not isinstance(entry, dict):
                        sys.stderr.write(f"{engine_name}/{name}: canonical golden missing\n")
                        problems += 1
                        continue
                    canonical_path = repo_root / str(entry.get("file", ""))
                    if not canonical_path.is_file():
                        sys.stderr.write(f"{engine_name}/{name}: canonical golden file missing\n")
                        problems += 1
                        continue
                    compatible, detail = _windows_compatible(
                        canonical_path.read_bytes(),
                        produced,
                        engine_name=engine_name,
                        operation_name=name,
                    )
                    if not compatible:
                        sys.stderr.write(
                            f"{engine_name}/{name}: decoded pixels, dimensions, format or metadata "
                            "differ from the canonical Linux golden\n"
                        )
                        problems += 1
                    else:
                        sys.stdout.write(
                            f"{engine_name}/{name:<28} decoded compatibility PASS{detail}\n"
                        )
                elif check:
                    if not path.is_file():
                        sys.stderr.write(f"{engine_name}/{name}: golden missing\n")
                        problems += 1
                    elif path.read_bytes() != produced:
                        sys.stderr.write(
                            f"{engine_name}/{name}: OUTPUT CHANGED\n"
                            f"    committed {hashlib.sha256(path.read_bytes()).hexdigest()}\n"
                            f"    produced  {digest}\n"
                        )
                        problems += 1
                else:
                    path.write_bytes(produced)
                    sys.stdout.write(
                        f"{engine_name}/{name:<28} {outcome.output.width}x"
                        f"{outcome.output.height} {len(produced):>6} B  {digest[:16]}\n"
                    )

    index = goldens_dir(repo_root) / "index.json"
    document = {
        "sources": {
            SOURCE: refs["smooth"].expected_sha256,
            NOISE_SOURCE: refs["noise"].expected_sha256,
        },
        "note": (
            "Exact-hash goldens (D-046). Each engine has its own set: Pillow and libvips "
            "implement different resampling and encoders, so their bytes differ by design. "
            "Regenerate deliberately on a pinned-version bump and review the visual diff."
        ),
        "engines": manifest,
    }
    if not check and not compatibility:
        index.write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n"
        )

    if skipped:
        sys.stdout.write(
            f"\nskipped engines: {', '.join(skipped)} "
            f"(golden coverage is incomplete on this host)\n"
        )
        if compatibility:
            problems += len(skipped)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate or check POC-004 golden outputs.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify exact canonical bytes")
    mode.add_argument(
        "--compatibility",
        action="store_true",
        help="compare decoded pixels, dimensions, format and metadata without encoded bytes",
    )
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)
    return generate(args.repo_root, check=args.check, compatibility=args.compatibility)


if __name__ == "__main__":
    raise SystemExit(main())
