"""Compact Real-ESRGAN VGG generator used by the general-x4v3 checkpoint.

Architecture derived from ``realesrgan/archs/srvgg_arch.py`` in the official
Real-ESRGAN repository, copyright Xintao Wang and contributors, BSD-3-Clause.
The registry decorator and BasicSR dependency were removed; layer order,
parameter names, residual nearest-neighbour path and pixel shuffle are retained.
Strict checkpoint loading verifies that this local boundary matches the
published architecture.
"""

from __future__ import annotations

from typing import Any


def compact_srvgg(*, num_conv: int = 32, upscale: int = 4) -> Any:
    """Build the exact network described by ``realesr-general-x4v3`` weights."""
    import torch.nn as nn
    import torch.nn.functional as functional

    class SrVggNetCompact(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.upscale = upscale
            self.body = nn.ModuleList()
            self.body.append(nn.Conv2d(3, 64, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=64))
            for _ in range(num_conv):
                self.body.append(nn.Conv2d(64, 64, 3, 1, 1))
                self.body.append(nn.PReLU(num_parameters=64))
            self.body.append(nn.Conv2d(64, 3 * upscale * upscale, 3, 1, 1))
            self.upsampler = nn.PixelShuffle(upscale)

        def forward(self, value: Any) -> Any:
            output = value
            for layer in self.body:
                output = layer(output)
            output = self.upsampler(output)
            base = functional.interpolate(value, scale_factor=self.upscale, mode="nearest")
            return output + base

    return SrVggNetCompact()
