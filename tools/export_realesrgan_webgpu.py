"""Export a verified general-x4v3 DNI blend for local browser WebGPU.

The generated ONNX file stays in gitignored ``.tools/models``. The upstream
checkpoint has no stated weight licence and is therefore local-research-only;
it must not be committed, redistributed, or deployed for commercial use.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from ipw.processors.ai_adapters.common import (
    WeightSpec,
    checkpoint_state_dict,
    verify_weight_digest,
)
from ipw.processors.ai_adapters.srvggnet import compact_srvgg

WEIGHT = WeightSpec(
    component_id="real-esrgan-weights-general-x4v3",
    filename="realesr-general-x4v3.pth",
    release_tag="v0.2.5.0",
    sha256="8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292",
    bytes_expected=4_885_111,
    source_url=(
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth"
    ),
)
WEAK_DENOISE_WEIGHT = WeightSpec(
    component_id="real-esrgan-weights-general-wdn-x4v3",
    filename="realesr-general-wdn-x4v3.pth",
    release_tag="v0.2.5.0",
    sha256="1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca",
    bytes_expected=4_885_111,
    source_url=(
        "https://github.com/xinntao/Real-ESRGAN/releases/download/"
        "v0.2.5.0/realesr-general-wdn-x4v3.pth"
    ),
)
DEFAULT_TILE_SIZE = 128
DEFAULT_DENOISE_STRENGTH = 0.5


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Export general-x4v3 DNI blend to static ONNX.")
    parser.add_argument("--purpose", required=True, choices=("local_research",))
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument(
        "--denoise-strength",
        type=float,
        default=DEFAULT_DENOISE_STRENGTH,
        help="official DNI mix: 0 keeps most source noise, 1 applies strongest denoising",
    )
    args = parser.parse_args()
    if args.tile_size < 32:
        parser.error("tile size must be at least 32 pixels")
    if not 0 <= args.denoise_strength <= 1:
        parser.error("denoise strength must be between 0 and 1")

    import onnx
    import torch

    repository = Path(__file__).resolve().parents[1]
    weight_path = repository / ".tools" / "models" / WEIGHT.filename
    weak_weight_path = repository / ".tools" / "models" / WEAK_DENOISE_WEIGHT.filename
    verify_weight_digest(weight_path, WEIGHT)
    verify_weight_digest(weak_weight_path, WEAK_DENOISE_WEIGHT)
    strong_state = checkpoint_state_dict(weight_path, ("params",))
    weak_state = checkpoint_state_dict(weak_weight_path, ("params",))
    if strong_state.keys() != weak_state.keys():
        raise RuntimeError("strong and weak-denoise checkpoints have different parameter sets")
    blended_state = {
        key: weak_state[key].lerp(strong_state[key], args.denoise_strength) for key in strong_state
    }
    denoise_percent = round(args.denoise_strength * 100)
    strong_output = weight_path.with_name(
        f"realesr-general-x4v3-tile{args.tile_size}-{WEIGHT.sha256[:12]}.onnx"
    )
    blended_output = weight_path.with_name(
        "realesr-general-x4v3-"
        f"dni{denoise_percent}-tile{args.tile_size}-"
        f"{WEIGHT.sha256[:12]}-{WEAK_DENOISE_WEIGHT.sha256[:12]}.onnx"
    )

    def export_variant(
        state: dict[str, torch.Tensor],
        output: Path,
        denoise_strength: float,
    ) -> None:
        model = compact_srvgg(num_conv=32, upscale=4)
        model.load_state_dict(state, strict=True)
        model.eval()
        example = torch.zeros(1, 3, args.tile_size, args.tile_size, dtype=torch.float32)
        with torch.inference_mode():
            torch.onnx.export(
                model,
                (example,),
                output,
                input_names=("input",),
                output_names=("output",),
                opset_version=18,
                dynamo=True,
                external_data=False,
                optimize=True,
            )
        artifact = onnx.load(output, load_external_data=False)
        onnx.checker.check_model(artifact)
        metadata = (
            (
                ("ipw.purpose", args.purpose),
                ("ipw.variant", "realesr-general-x4v3"),
                ("ipw.denoise_strength", str(denoise_strength)),
                ("ipw.tile_size", str(args.tile_size)),
                ("ipw.source_weight_sha256", WEIGHT.sha256),
                ("ipw.weak_denoise_weight_sha256", WEAK_DENOISE_WEIGHT.sha256),
            )
            if denoise_strength != 1.0
            else (
                ("ipw.purpose", args.purpose),
                ("ipw.variant", "realesr-general-x4v3"),
                ("ipw.tile_size", str(args.tile_size)),
                ("ipw.source_weight_sha256", WEIGHT.sha256),
            )
        )
        for key, value in metadata:
            item = artifact.metadata_props.add()
            item.key = key
            item.value = value
        onnx.save(artifact, output)
        print(f"exported={output}")
        print(f"bytes={output.stat().st_size}")
        print(f"sha256={digest(output)}")

    # Both are runtime dependencies: illustrations retain the accepted strong
    # checkpoint while photographs use the official natural-denoise DNI blend.
    export_variant(strong_state, strong_output, 1.0)
    export_variant(blended_state, blended_output, args.denoise_strength)


if __name__ == "__main__":
    main()
