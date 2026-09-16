"""Continuous SDR face-detail correction anchored to native base colour.

An sRGB neural model is not an HDR or wide-gamut authority. Its bounded luminance
proposal can inform a native ICC base; it cannot repaint that base's chroma.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Any

import numpy as np
import pyvips

from ipw.processing_worker.native_face_renderer import NativeFaceRenderError

RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
XYZ_TO_RGB = np.linalg.inv(RGB_TO_XYZ)
SRGB_CHRM = struct.pack(">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)


def linear_rgb(rgb: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    rgb = np.asarray(rgb, dtype=np.float64)
    return np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)


def encoded_rgb(rgb: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    rgb = np.clip(rgb, 0, 1)
    return np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * rgb ** (1 / 2.4) - 0.055)


@dataclass(frozen=True)
class NativeFaceColour:
    bit_depth: int
    profile: bytes | None = None

    @classmethod
    def from_image(
        cls, image: Any, colours: list[tuple[bytes, bytes]] | None = None
    ) -> NativeFaceColour:
        if (
            image.format not in {"uchar", "ushort"}
            or image.bands not in {3, 4}
            or image.interpretation not in {"srgb", "rgb", "rgb16"}
        ):
            raise NativeFaceRenderError("Native face colour requires full-channel 8/16-bit SDR RGB")
        declared = dict(colours or [])
        profile = (
            bytes(image.get("icc-profile-data")) if image.get_typeof("icc-profile-data") else None
        )
        if profile and (
            len(profile) < 128
            or len(profile) > 16 * 1024 * 1024
            or profile[16:20] != b"RGB "
            or profile[36:40] != b"acsp"
        ):
            raise NativeFaceRenderError("Native face ICC authority is not a bounded RGB profile")
        if b"mDCV" in declared or b"cLLI" in declared:
            raise NativeFaceRenderError("HDR face inference needs a separately qualified HDR model")
        if b"cICP" in declared and (profile or declared[b"cICP"] != bytes([1, 13, 0, 1])):
            raise NativeFaceRenderError(
                "This transfer/primaries combination is not qualified for face inference"
            )
        if b"sRGB" in declared and (
            len(declared[b"sRGB"]) != 1 or declared[b"sRGB"][0] > 3 or profile
        ):
            raise NativeFaceRenderError("Native face colour declarations conflict")
        if b"iCCP" in declared and profile is None:
            raise NativeFaceRenderError("Native face embedded colour profile could not be decoded")
        if not profile and (
            (b"gAMA" in declared and declared[b"gAMA"] != struct.pack(">I", 45455))
            or (b"cHRM" in declared and declared[b"cHRM"] != SRGB_CHRM)
        ):
            raise NativeFaceRenderError(
                "Untagged non-sRGB face colour needs an explicit colour adapter"
            )
        return cls(16 if image.format == "ushort" else 8, profile)

    def _image(self, pixels: np.ndarray[Any, Any]) -> Any:
        height, width = pixels.shape[:2]
        image = pyvips.Image.new_from_memory(
            np.ascontiguousarray(pixels).tobytes(),
            width,
            height,
            3,
            "ushort" if self.bit_depth == 16 else "uchar",
        ).copy(interpretation="rgb16" if self.bit_depth == 16 else "srgb")
        if self.profile:
            image.set_type(pyvips.GValue.blob_type, "icc-profile-data", self.profile)
        return image

    def xyz(self, pixels: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        expected = np.dtype("uint16" if self.bit_depth == 16 else "uint8")
        if pixels.dtype != expected or pixels.ndim != 3 or pixels.shape[2] != 3:
            raise NativeFaceRenderError("Native colour samples changed precision or layout")
        if not self.profile:
            return linear_rgb(pixels / (65535 if self.bit_depth == 16 else 255)) @ RGB_TO_XYZ.T
        imported = self._image(pixels).icc_import(embedded=True, pcs="xyz")
        return (
            np.frombuffer(imported.write_to_memory(), dtype=np.float32)
            .reshape(pixels.shape)
            .astype(np.float64)
            / 100
        )

    def working_rgb(self, pixels: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        return encoded_rgb(self.xyz(pixels) @ XYZ_TO_RGB.T).astype(np.float32)

    def _native(self, xyz: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
        maximum = 65535 if self.bit_depth == 16 else 255
        dtype = np.uint16 if self.bit_depth == 16 else np.uint8
        if not self.profile:
            return np.rint(encoded_rgb(xyz @ XYZ_TO_RGB.T) * maximum).astype(dtype)
        height, width = xyz.shape[:2]
        image = pyvips.Image.new_from_memory(
            np.ascontiguousarray(xyz * 100, dtype=np.float32).tobytes(), width, height, 3, "float"
        ).copy(interpretation="xyz")
        image.set_type(pyvips.GValue.blob_type, "icc-profile-data", self.profile)
        exported = image.icc_export(pcs="xyz", depth=self.bit_depth)
        return np.frombuffer(exported.write_to_memory(), dtype=dtype).reshape(xyz.shape).copy()

    def detail_proposal(
        self,
        base: np.ndarray[Any, Any],
        reference: np.ndarray[Any, Any],
        restored: np.ndarray[Any, Any],
    ) -> np.ndarray[Any, Any]:
        if (
            reference.shape != (*base.shape[:2], 3)
            or restored.shape != reference.shape
            or not np.all(np.isfinite(reference))
            or not np.all(np.isfinite(restored))
        ):
            raise NativeFaceRenderError("Native face detail fields are incompatible")
        xyz = self.xyz(base[..., :3])
        delta = (linear_rgb(restored) - linear_rgb(reference)) @ RGB_TO_XYZ[1]
        delta = np.clip(delta, -0.06, 0.06)
        luminance = xyz[..., 1]
        target = np.clip(luminance + delta, 0, 1)
        scale = np.divide(target, luminance, out=np.ones_like(target), where=luminance > 1e-6)
        # Bounded relative lift prevents aggressive contrast in deep shadows.
        scale = np.clip(scale, 0.8, 1.2)
        rgb = self._native(xyz * scale[..., None])
        maximum = 65535 if self.bit_depth == 16 else 255
        new_clip = np.any(
            ((rgb == 0) & (base[..., :3] > 0)) | ((rgb == maximum) & (base[..., :3] < maximum)),
            axis=2,
        )
        unchanged = (np.abs(delta) < 1e-12) | (luminance <= 1e-6) | new_clip
        rgb[unchanged] = base[..., :3][unchanged]
        result = base.copy()
        result[..., :3] = rgb
        return result
