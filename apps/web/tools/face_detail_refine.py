"""Refine hash-verified private study pixels, without rerunning or distributing a model."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

from face_detail_study import MODELS, ROOT, research_register, source_view_mapping


def refine_face_pixels(source, restored, amount=1.0):
    """Bounded luminance lift/detail and source-chroma anchoring, never viewer effects."""
    import numpy as np
    from PIL import ImageFilter

    if source.mode != "RGB" or restored.mode != "RGB" or source.size != restored.size:
        raise ValueError("Matching decoded RGB pixels are required.")
    if not 0 <= amount <= 1:
        raise ValueError("Refinement amount must be between zero and one.")
    reference = np.asarray(source, dtype=np.float32)
    pixels = np.asarray(restored, dtype=np.float32)
    if amount == 0:
        return pixels.astype(np.uint8).copy()
    weights = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    y = pixels @ weights
    fine = np.asarray(restored.filter(ImageFilter.GaussianBlur(1.2)), dtype=np.float32)
    broad = np.asarray(restored.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    source_broad = np.asarray(source.filter(ImageFilter.GaussianBlur(12)), dtype=np.float32)
    broad_y = broad @ weights
    source_y = source_broad @ weights
    fine_residual = y - fine @ weights
    # Soft thresholds avoid sharpening quiet skin/grain. No deconvolution/extra inference.
    fine_detail = np.sign(fine_residual) * np.maximum(np.abs(fine_residual) - 1.5, 0)
    local = np.clip((y - broad_y) * 0.10, -2.0, 2.0)
    texture = np.clip(fine_detail * 0.12, -1.0, 1.0)
    shadow_lift = 255 * (np.maximum(y, 0) / 255) ** 0.96 - y
    source_tone = np.clip((source_y - broad_y) * 0.15, -2, 2)
    delta_y = amount * np.clip(local + texture + shadow_lift + source_tone, -3, 5)
    source_chroma = source_broad - source_y[..., None]
    model_chroma = broad - broad_y[..., None]
    chroma_delta = amount * np.clip((source_chroma - model_chroma) * 0.4, -3, 3)
    delta = delta_y[..., None] + chroma_delta
    # Scale the whole RGB change together to available headroom instead of clipping channels.
    upper = np.where(pixels == 255, 255, 254)
    lower = np.where(pixels == 0, 0, 1)
    positive = np.where(delta > 0, (upper - pixels) / np.maximum(delta, 1e-6), np.inf)
    negative = np.where(delta < 0, (pixels - lower) / np.maximum(-delta, 1e-6), np.inf)
    trust = np.minimum(1, np.minimum(positive, negative).min(axis=2))
    output = np.rint(pixels + delta * trust[..., None]).astype(np.uint8)
    assert reference.shape == output.shape
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--private-input-approved", action="store_true", required=True)
    args = parser.parse_args()
    study = args.study.resolve()
    private_root = ROOT / ".tools/private-validation"
    if not study.is_relative_to(private_root) or not study.is_dir():
        raise ValueError("Only an explicitly approved private study can be refined.")
    manifest = json.loads((study / "private-study.json").read_text(encoding="utf-8"))
    if manifest["purpose"] != "local_research" or manifest["productionApproved"] is not False:
        raise ValueError("Refinement cannot clear production model rights.")
    from ipw.contracts.licence import RunPurpose

    gate = research_register().evaluate("face-detail-study-codeformer", RunPurpose.LOCAL_RESEARCH)
    if not gate.permitted:
        raise ValueError(gate.model_dump_json())
    if manifest["modelArtifacts"]["codeformer"]["sha256"] != MODELS["codeformer"]["sha256"]:
        raise ValueError("The private study has an unexpected model pin.")
    required = ("original-aligned.png", "codeformer-fidelity-1.0.png", "source-view-0.png")
    for name in required:
        path = study / name
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != manifest["outputSha256"][name]:
                raise ValueError("The private study pixels no longer match their provenance.")
    # No model or network access. These are exact decoded study pixels, not screenshots.
    from PIL import Image, ImageDraw, ImageFilter, PngImagePlugin

    source = Image.open(study / required[0]).convert("RGB")
    restored = Image.open(study / required[1]).convert("RGB")
    original_view = Image.open(study / required[2]).convert("RGB")
    output = Path(tempfile.mkdtemp(prefix="face-detail-refinement-", dir=private_root))
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text(
        "ipw-private-study", "LOCAL RESEARCH ONLY; reconstructed face; identity unverified"
    )
    mapping = source_view_mapping(
        manifest["transform"], manifest["sourceCrop"], original_view.width
    )
    mask = Image.new("L", source.size, 0)
    ImageDraw.Draw(mask).ellipse((102, 128, 410, 478), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(12)).transform(
        original_view.size, Image.Transform.AFFINE, mapping, Image.Resampling.BICUBIC
    )
    views = [("Original", original_view)]
    for name, amount in (("AI candidate, unrefined", 0), ("AI candidate, tonal refinement", 1)):
        pixels = refine_face_pixels(source, restored, amount)
        candidate = Image.fromarray(pixels)
        candidate.save(output / f"candidate-{amount}.png", pnginfo=metadata)
        region = candidate.transform(
            original_view.size, Image.Transform.AFFINE, mapping, Image.Resampling.BICUBIC
        )
        views.append((name, Image.composite(region, original_view, mask)))
    width, height = original_view.size
    comparison = Image.new("RGB", (width * len(views), height + 48), "white")
    draw = ImageDraw.Draw(comparison)
    for index, (name, view) in enumerate(views):
        comparison.paste(view, (index * width, 48))
        draw.text((index * width + 12, 10), name, fill="black")
        draw.text(
            (index * width + 12, 26),
            "Same coordinates; research/identity review required",
            fill="black",
        )
        view.save(output / f"source-view-{index}.png", pnginfo=metadata)
    comparison.save(output / "comparison.png", pnginfo=metadata)
    hashes = {}
    for path in output.glob("*.png"):
        with path.open("rb") as stream:
            hashes[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    (output / "private-refinement.json").write_text(
        json.dumps(
            {
                "purpose": "local_research",
                "productionApproved": False,
                "sourceSha256": manifest["sourceSha256"],
                "modelSha256": MODELS["codeformer"]["sha256"],
                "inputCandidateSha256": manifest["outputSha256"][required[1]],
                "recipe": "bounded-face-tone-chroma-v1",
                "outputSha256": hashes,
                "limitations": [
                    "No extra ground-truth detail recovered.",
                    "Identity still unverified.",
                    "Manual alignment/mask; no commercial clearance.",
                    "8-bit sRGB study only.",
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
