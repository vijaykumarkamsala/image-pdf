"""Private, offline face-model evaluation. Never imported by the web runtime.

No download, pickle loading, production approval or automatic identity verdict.
Manual landmarks are a research input, not a shipped face detector.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import math
import socket
import sys
import tempfile
import zlib
from pathlib import Path
from time import perf_counter
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
TEMPLATE = (
    (192.98138, 239.94708),
    (318.90277, 240.19360),
    (256.63416, 314.01935),
    (201.26117, 371.41043),
    (313.08905, 371.15118),
)
MODELS = {
    "codeformer": {
        "sha256": "21710e7ab61c82683576c428e9c1b6fe1ed419586b7b39e394c3449c294b550f",
        "crc32": "1456f3ab",
        "bytes": 376951650,
        "terms": "https://github.com/sczhou/CodeFormer/blob/master/LICENSE",
        "disposition": "non_commercial",
    },
    "gfpgan_1.4": {
        "sha256": "accc4757b26bdb89b32b4d3500d4f79c9dff97c1dd7c7104bf9dcb95e3311385",
        "crc32": "5a6c6364",
        "bytes": 340299087,
        "terms": "https://github.com/TencentARC/GFPGAN/blob/master/LICENSE",
        "disposition": "review_required",
    },
}


def similarity_transform(source, target=TEMPLATE):
    """Least-squares uniform scale/rotation/translation; never shear or stretch a face."""
    if (
        len(source) != 5
        or len(target) != 5
        or any(
            len(point) != 2 or not all(math.isfinite(value) for value in point)
            for point in (*source, *target)
        )
    ):
        raise ValueError("Five finite eye/nose/mouth landmarks are required.")
    sx, sy = (sum(point[i] for point in source) / 5 for i in range(2))
    tx, ty = (sum(point[i] for point in target) / 5 for i in range(2))
    pairs = [
        (x - sx, y - sy, u - tx, v - ty) for (x, y), (u, v) in zip(source, target, strict=True)
    ]
    denominator = sum(x * x + y * y for x, y, _, _ in pairs)
    if denominator < 1e-12:
        raise ValueError("Coincident landmarks cannot align a face.")
    a = sum(x * u + y * v for x, y, u, v in pairs) / denominator
    b = sum(x * v - y * u for x, y, u, v in pairs) / denominator
    if a * a + b * b < 1e-12:
        raise ValueError("The face alignment is singular.")
    return a, b, tx - a * sx + b * sy, ty - b * sx - a * sy


def inverse_transform(transform):
    a, b, tx, ty = transform
    denominator = a * a + b * b
    if denominator < 1e-12:
        raise ValueError("The face alignment is singular.")
    return (
        a / denominator,
        b / denominator,
        (-a * tx - b * ty) / denominator,
        -b / denominator,
        a / denominator,
        (b * tx - a * ty) / denominator,
    )


def source_view_mapping(transform, crop, width):
    """Map identical source coordinates into the aligned model, not its output framing."""
    if width <= 0 or len(crop) != 4 or crop[2] <= crop[0] or crop[3] <= crop[1]:
        raise ValueError("A nonempty comparison rectangle and positive width are required.")
    a, b, tx, ty = transform
    source_per_pixel = (crop[2] - crop[0]) / width
    return (
        a * source_per_pixel,
        -b * source_per_pixel,
        tx + a * crop[0] - b * crop[1],
        b * source_per_pixel,
        a * source_per_pixel,
        ty + b * crop[0] + a * crop[1],
    )


def verify_model(path, model):
    expected = MODELS[model]
    if path.stat().st_size != expected["bytes"]:
        raise ValueError("Incomplete or unexpected model artifact.")
    digest = hashlib.sha256()
    crc = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
    if digest.hexdigest() != expected["sha256"] or f"{crc:08x}" != expected["crc32"]:
        raise ValueError("The model does not match its pinned SHA-256 and publisher CRC32.")


def research_register():
    """Extend, never rewrite, the shared register for this internal study only."""
    from ipw.licence_registry.register import LicenceRegister, RegisterDocument, load_register

    base = load_register(ROOT / "data/licences/register.json")
    additions = []
    dependencies = {
        "packaging": ("26.3", "Apache-2.0 OR BSD-2-Clause", ()),
        "protobuf": ("7.36.0", "BSD-3-Clause", ()),
        "sympy": ("1.14.0", "BSD-3-Clause AND MIT", ("mpmath",)),
        "mpmath": ("1.3.0", "BSD-3-Clause", ()),
        "ml-dtypes": ("0.6.0", "Apache-2.0 AND MPL-2.0", ("numpy",)),
        "onnx-graph-reader": (
            "1.22.0",
            "Apache-2.0 AND BSD-3-Clause",
            ("protobuf", "numpy", "typing-extensions", "ml-dtypes"),
        ),
    }
    for name, (version, terms, dependencies_of_component) in dependencies.items():
        if name in base:
            continue
        distribution = "onnx" if name == "onnx-graph-reader" else name
        additions.append(
            {
                "component_id": name,
                "display_name": name,
                "kind": "dependency",
                "disposition": "review_required",
                "pinned_version": version,
                "official_source": f"https://pypi.org/project/{distribution}/{version}/",
                "licence_id": terms,
                "depends_on": dependencies_of_component,
                "network_disabled_at_inference": True,
                "reviewed_on": "2026-09-16",
                "reviewed_by": "image-quality-face-detail-private-study",
                "evidence": "Installed metadata and shipped licence text inspected "
                "for the pinned artifact. "
                "Commercial notice/distribution review remains pending; this record permits "
                "marked local research only, not a production release.",
            }
        )
    additions.append(
        {
            "component_id": "face-detail-ffhq-training-terms",
            "display_name": "FFHQ training terms",
            "kind": "dataset",
            "disposition": "review_required",
            "reference_only": True,
            "official_source": "https://github.com/NVlabs/ffhq-dataset#licenses",
            "evidence": "Official FFHQ terms describe mixed individual image rights, including "
            "non-commercial images. No dataset images are loaded in this study. "
            "The consequences for commercial pretrained-weight use remain unapproved; "
            "training-data restrictions are not assumed to automatically prohibit inference.",
        }
    )
    for model, facts in MODELS.items():
        component_id = f"face-detail-study-{model.replace('_', '-').replace('.', '-')}"
        weight_id = f"{component_id}-weights"
        additions.extend(
            [
                {
                    "component_id": weight_id,
                    "display_name": f"{model} ONNX reference weights",
                    "kind": "weights",
                    "disposition": facts["disposition"],
                    "reference_only": True,
                    "official_source": f"https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/{model}.onnx",
                    "pinned_version": f"models-3.0.0/{model}",
                    "weights_sha256": facts["sha256"],
                    "weight_format": "onnx",
                    "network_disabled_at_inference": True,
                    "depends_on": ["face-detail-ffhq-training-terms"],
                    "licence_text_url": facts["terms"],
                    "reviewed_on": "2026-09-16",
                    "reviewed_by": "image-quality-face-detail-private-study",
                    "evidence": "ONNX conversion publisher release, exact size, "
                    "SHA-256 and publisher CRC32 "
                    "recorded. Upstream terms inspected separately from the converter. "
                    "CodeFormer is non-commercial; GFPGAN lists third-party exceptions. "
                    "Neither artifact is cleared for commercial distribution.",
                },
                {
                    "component_id": component_id,
                    "display_name": f"{model} private evaluation",
                    "kind": "service",
                    "disposition": "review_required",
                    "reference_only": True,
                    "official_source": "this repository: apps/web/tools/face_detail_study.py",
                    "pinned_version": "1.0.0",
                    "network_disabled_at_inference": True,
                    "depends_on": [
                        weight_id,
                        "onnxruntime-python",
                        "pillow",
                        "numpy",
                        "onnx-graph-reader",
                    ],
                    "evidence": "Private offline evaluation only. "
                    "Not registered in the editor runtime.",
                },
            ]
        )
    register = LicenceRegister(
        RegisterDocument.model_validate(
            {
                "name": "image-quality-face-detail-private-study",
                "components": [component.model_dump() for component in base.document.components]
                + additions,
            }
        )
    )
    aliases = {
        "pillow": "Pillow",
        "onnxruntime-python": "onnxruntime",
        "onnx-graph-reader": "onnx",
        "flatbuffers-python": "flatbuffers",
        "typing-extensions": "typing_extensions",
        "ml-dtypes": "ml_dtypes",
    }
    for model in MODELS:
        for member in register.closure(
            f"face-detail-study-{model.replace('_', '-').replace('.', '-')}"
        )[0]:
            record = register.get(member)
            if record and record.kind.value in ("dependency", "code"):
                actual = importlib.metadata.version(aliases.get(member, member))
                if actual != record.pinned_version:
                    raise ValueError(f"{member} does not match the reviewed runtime pin.")
    return register


def network_denied(*_args, **_kwargs):
    raise RuntimeError("Network is disabled during private face inference.")


def inspect_onnx(path):
    import onnx

    model = onnx.load(str(path), load_external_data=False)

    def inspect_graph(graph):
        tensors = list(graph.initializer)
        for node in graph.node:
            if node.domain not in ("", "ai.onnx", "com.microsoft"):
                raise ValueError("Unreviewed custom model operators are not permitted.")
            for attribute in node.attribute:
                tensors.extend(attribute.tensors)
                if attribute.HasField("t"):
                    tensors.append(attribute.t)
                if attribute.HasField("g"):
                    inspect_graph(attribute.g)
                for subgraph in attribute.graphs:
                    inspect_graph(subgraph)
        if any(
            tensor.external_data or tensor.data_location == onnx.TensorProto.EXTERNAL
            for tensor in tensors
        ):
            raise ValueError("External model files are not permitted.")

    inspect_graph(model.graph)
    if model.functions:
        raise ValueError("Unreviewed model-local functions are not permitted.")
    del model
    gc.collect()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--landmarks", type=float, nargs=10, required=True)
    parser.add_argument("--crop", type=int, nargs=4, required=True)
    parser.add_argument("--models", nargs="+", choices=list(MODELS), default=list(MODELS))
    parser.add_argument("--private-input-approved", action="store_true", required=True)
    args = parser.parse_args()
    source_path = args.source.resolve()
    if not source_path.is_relative_to(ROOT):
        raise ValueError("This study only reads explicitly approved repository-local input.")
    from ipw.contracts.licence import RunPurpose

    register = research_register()
    gates = {}
    for model in args.models:
        component = f"face-detail-study-{model.replace('_', '-').replace('.', '-')}"
        gate = register.evaluate(component, RunPurpose.LOCAL_RESEARCH)
        if not gate.permitted:
            raise ValueError(gate.model_dump_json())
        gates[model] = gate.model_dump(mode="json")
        verify_model(ROOT / f".tools/models/{model}.onnx", model)
    # Third-party inference/graph-reader imports occur only after shared supply-chain gating.
    import numpy as np
    import onnxruntime as ort
    from PIL import Image, ImageDraw, ImageFilter, ImageOps, PngImagePlugin

    with source_path.open("rb") as stream:
        before = hashlib.file_digest(stream, "sha256").hexdigest()
    with Image.open(source_path) as original:
        if original.format not in ("PNG", "JPEG", "WEBP") or getattr(original, "n_frames", 1) != 1:
            raise ValueError("The private study requires one decoded JPEG, PNG or WebP still.")
        source = ImageOps.exif_transpose(original).convert("RGB")
    crop = tuple(args.crop)
    if not (0 <= crop[0] < crop[2] <= source.width and 0 <= crop[1] < crop[3] <= source.height):
        raise ValueError("Comparison crop must fit the oriented original.")
    landmarks = list(zip(args.landmarks[::2], args.landmarks[1::2], strict=True))
    if any(not (0 <= x < source.width and 0 <= y < source.height) for x, y in landmarks):
        raise ValueError("Landmarks must be source-image coordinates.")
    transform = similarity_transform(landmarks)
    aligned = source.transform(
        (512, 512), Image.Transform.AFFINE, inverse_transform(transform), Image.Resampling.BICUBIC
    )
    tensor = (np.asarray(aligned, dtype=np.float32) / 127.5 - 1).transpose(2, 0, 1)[None].copy()
    private_root = ROOT / ".tools/private-validation"
    private_root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="face-detail-study-", dir=private_root))
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text(
        "ipw-private-study",
        "LOCAL RESEARCH ONLY; plausible identity changes; not production cleared",
    )
    views = [("Original aligned source", aligned)]
    timings = {}
    with (
        patch.object(socket.socket, "connect", network_denied),
        patch.object(socket.socket, "connect_ex", network_denied),
        patch.object(socket, "create_connection", network_denied),
        patch.object(socket, "getaddrinfo", network_denied),
    ):
        for model in args.models:
            inspect_onnx(ROOT / f".tools/models/{model}.onnx")
            options = ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            session = ort.InferenceSession(
                str(ROOT / f".tools/models/{model}.onnx"),
                options,
                providers=["CPUExecutionProvider"],
            )
            inputs = session.get_inputs()
            image_input = next((item for item in inputs if item.shape == [1, 3, 512, 512]), None)
            if image_input is None:
                raise ValueError("The pinned model has an unexpected image-input contract.")
            for fidelity in (0.5, 0.8, 1.0) if model == "codeformer" else (None,):
                feeds = {image_input.name: tensor}
                for item in inputs:
                    if item.name != image_input.name:
                        if fidelity is None or item.type not in ("tensor(float)", "tensor(double)"):
                            raise ValueError(
                                "The pinned model has an unexpected fidelity-input contract."
                            )
                        feeds[item.name] = np.full(
                            item.shape or (),
                            fidelity,
                            dtype=np.float64 if item.type == "tensor(double)" else np.float32,
                        )
                started = perf_counter()
                result = session.run([session.get_outputs()[0].name], feeds)[0]
                if result.shape != (1, 3, 512, 512) or not np.isfinite(result).all():
                    raise ValueError("The face model returned invalid pixels.")
                pixels = (
                    np.clip((result[0].transpose(1, 2, 0) + 1) * 127.5, 0, 255)
                    .round()
                    .astype(np.uint8)
                )
                label = f"{model}" + (f" fidelity {fidelity}" if fidelity is not None else "")
                timings[label] = perf_counter() - started
                view = Image.fromarray(pixels)
                views.append((label, view))
                view.save(output / f"{label.replace(' ', '-')}.png", pnginfo=metadata)
                print(f"{label}: {timings[label]:.1f}s", flush=True)
            del session
            gc.collect()
    aligned.save(output / "original-aligned.png", pnginfo=metadata)
    comparison = Image.new("RGB", (512 * len(views), 560), "white")
    draw = ImageDraw.Draw(comparison)
    for index, (label, view) in enumerate(views):
        comparison.paste(view, (512 * index, 48))
        draw.text((512 * index + 12, 10), label, fill="black")
        draw.text((512 * index + 12, 26), "Local research; compare identity", fill="black")
    comparison.save(output / "comparison-aligned.png", pnginfo=metadata)
    # Same physical source rectangle for every candidate. No larger-output framing advantage.
    width = 512
    height = round((crop[3] - crop[1]) * width / (crop[2] - crop[0]))
    reference = source.crop(crop).resize((width, height), Image.Resampling.LANCZOS)
    mapping = source_view_mapping(transform, crop, width)
    mask = Image.new("L", (512, 512), 0)
    ImageDraw.Draw(mask).ellipse((102, 128, 410, 478), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(12)).transform(
        (width, height), Image.Transform.AFFINE, mapping, Image.Resampling.BICUBIC
    )
    source_comparison = Image.new("RGB", (width * len(views), height + 48), "white")
    draw = ImageDraw.Draw(source_comparison)
    rendered_views = []
    for index, (label, view) in enumerate(views):
        rendered = (
            reference
            if index == 0
            else Image.composite(
                view.transform(
                    (width, height), Image.Transform.AFFINE, mapping, Image.Resampling.BICUBIC
                ),
                reference,
                mask,
            )
        )
        source_comparison.paste(rendered, (width * index, 48))
        draw.text(
            (width * index + 12, 10),
            "Original source pixels" if index == 0 else label,
            fill="black",
        )
        draw.text(
            (width * index + 12, 26), "Same source coordinates; research mask only", fill="black"
        )
        rendered.save(output / f"source-view-{index}.png", pnginfo=metadata)
        rendered_views.append((label, rendered))
    source_comparison.save(output / "comparison-source-coordinates.png", pnginfo=metadata)
    # A narrower review image avoids shrinking every face to fit all fidelity settings.
    shortlist = [
        (label, view)
        for label, view in rendered_views
        if label in ("Original aligned source", "codeformer fidelity 1.0", "gfpgan_1.4")
    ]
    review = Image.new("RGB", (width * len(shortlist), height + 48), "white")
    draw = ImageDraw.Draw(review)
    for index, (label, view) in enumerate(shortlist):
        review.paste(view, (width * index, 48))
        draw.text(
            (width * index + 12, 10),
            "Original source pixels" if index == 0 else label,
            fill="black",
        )
        draw.text((width * index + 12, 26), "Research only; review identity", fill="black")
    review.save(output / "comparison-shortlist.png", pnginfo=metadata)
    with source_path.open("rb") as stream:
        after = hashlib.file_digest(stream, "sha256").hexdigest()
    if before != after:
        raise ValueError("The immutable original changed during the study.")
    output_hashes = {}
    for path in sorted(output.glob("*.png")):
        with path.open("rb") as stream:
            output_hashes[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    (output / "private-study.json").write_text(
        json.dumps(
            {
                "purpose": "local_research",
                "sourceSha256": before,
                "originalUnchanged": True,
                "productionApproved": False,
                "manualAlignmentOnly": True,
                "releaseGates": gates,
                "modelArtifacts": {model: MODELS[model] for model in args.models},
                "pythonVersion": sys.version,
                "runtimePins": {
                    item: importlib.metadata.version(item)
                    for item in (
                        "onnxruntime",
                        "onnx",
                        "Pillow",
                        "numpy",
                        "protobuf",
                        "packaging",
                        "sympy",
                        "mpmath",
                        "flatbuffers",
                        "typing_extensions",
                        "ml_dtypes",
                    )
                },
                "executionProvider": "CPUExecutionProvider",
                "intraOpThreads": 4,
                "interOpThreads": 1,
                "sourceDimensions": source.size,
                "sourceCrop": crop,
                "sourceLandmarks": landmarks,
                "alignmentTemplate": TEMPLATE,
                "transform": transform,
                "timingsSeconds": timings,
                "outputSha256": output_hashes,
                "limitations": [
                    "Plausible detail is not recovered ground truth.",
                    "Manual landmarks are not a production detector.",
                    "Ellipse feathering is not a semantic face parser.",
                    "No commercial release clearance.",
                    "Python socket denial and pinned graph inspection are not an OS sandbox.",
                    "16-bit source is decoded to 8-bit RGB for this private model study.",
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(output.relative_to(ROOT), flush=True)


if __name__ == "__main__":
    main()
