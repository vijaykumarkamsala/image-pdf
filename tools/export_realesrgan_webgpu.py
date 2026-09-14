"""Export the verified general-x4v3 checkpoint for local browser WebGPU.

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
        "https://github.com/xinntao/Real-ESRGAN/releases/download/"
        "v0.2.5.0/realesr-general-x4v3.pth"
    ),
)
DEFAULT_TILE_SIZE = 128


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Export general-x4v3 to static ONNX.")
    parser.add_argument("--purpose", required=True, choices=("local_research",))
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    args = parser.parse_args()
    if args.tile_size < 32:
        parser.error("tile size must be at least 32 pixels")

    import onnx
    import torch

    repository = Path(__file__).resolve().parents[1]
    weight_path = repository / ".tools" / "models" / WEIGHT.filename
    verify_weight_digest(weight_path, WEIGHT)
    state = checkpoint_state_dict(weight_path, ("params",))
    model = compact_srvgg(num_conv=32, upscale=4)
    model.load_state_dict(state, strict=True)
    model.eval()

    output = weight_path.with_name(
        f"realesr-general-x4v3-tile{args.tile_size}-{WEIGHT.sha256[:12]}.onnx"
    )
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
    for key, value in (
        ("ipw.purpose", args.purpose),
        ("ipw.variant", "realesr-general-x4v3"),
        ("ipw.tile_size", str(args.tile_size)),
        ("ipw.source_weight_sha256", WEIGHT.sha256),
    ):
        item = artifact.metadata_props.add()
        item.key = key
        item.value = value
    onnx.save(artifact, output)
    print(f"exported={output}")
    print(f"bytes={output.stat().st_size}")
    print(f"sha256={digest(output)}")


if __name__ == "__main__":
    main()
