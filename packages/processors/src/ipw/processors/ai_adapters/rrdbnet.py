"""RRDBNet: the generator architecture Real-ESRGAN's released weights describe.

Implemented directly rather than by installing the official ``realesrgan``
package, for a reason that is a POC-006 requirement rather than a preference.

**The official package hard-depends on ``gfpgan``** - the face restoration model.
Its dependency list is ``basicsr, facexlib, gfpgan, numpy, opencv-python, Pillow,
torch, torchvision, tqdm``. Installing it would put face reconstruction inside the
executed path of a *general super-resolution* adapter, and POC-006 states plainly:
"Never silently invoke face restoration." A dependency that can reconstruct a face
is not made safe by our not calling it; the only way to guarantee it never runs is
for it not to be there.

Reimplementing also shrinks the executed inference path to ``torch`` and ``numpy``,
which is the whole surface AGENTS.md asks us to inspect. ``basicsr`` is
semi-maintained and does not install on this interpreter in any case.

**Correctness is not asserted, it is checked.** ``load_state_dict`` runs with
``strict=True``, so every parameter name and tensor shape in the official
checkpoint must match this implementation exactly. A wrong architecture cannot
load; it fails loudly rather than producing plausible-looking wrong output.

Architecture from Wang et al., *ESRGAN* (2018) and *Real-ESRGAN* (2021), whose
reference implementation is BSD-3-Clause. The weights are registered and gated
separately - see ``data/licences/register.json``.
"""

from __future__ import annotations

import torch
from torch import Tensor, nn

__all__ = ["RRDB", "RRDBNet", "ResidualDenseBlock", "build_rrdbnet"]

# The residual scaling factor used throughout ESRGAN and Real-ESRGAN. Not a
# tunable: the released weights were trained with it, so changing it changes what
# the checkpoint means.
RESIDUAL_SCALE = 0.2


class ResidualDenseBlock(nn.Module):
    """Five convolutions, each seeing every previous output, with a scaled residual."""

    def __init__(self, features: int = 64, growth: int = 32) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(features, growth, 3, 1, 1)
        self.conv2 = nn.Conv2d(features + growth, growth, 3, 1, 1)
        self.conv3 = nn.Conv2d(features + 2 * growth, growth, 3, 1, 1)
        self.conv4 = nn.Conv2d(features + 3 * growth, growth, 3, 1, 1)
        self.conv5 = nn.Conv2d(features + 4 * growth, features, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: Tensor) -> Tensor:
        # torch types nn.Module.__call__ as returning Any, so every layer output is
        # annotated here rather than allowing Any to spread through the network.
        x1: Tensor = self.lrelu(self.conv1(x))
        x2: Tensor = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3: Tensor = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4: Tensor = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5: Tensor = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * RESIDUAL_SCALE + x


class RRDB(nn.Module):
    """Residual in Residual Dense Block: three dense blocks with an outer residual."""

    def __init__(self, features: int, growth: int = 32) -> None:
        super().__init__()
        self.rdb1 = ResidualDenseBlock(features, growth)
        self.rdb2 = ResidualDenseBlock(features, growth)
        self.rdb3 = ResidualDenseBlock(features, growth)

    def forward(self, x: Tensor) -> Tensor:
        out: Tensor = self.rdb3(self.rdb2(self.rdb1(x)))
        return out * RESIDUAL_SCALE + x


class RRDBNet(nn.Module):
    """The Real-ESRGAN generator.

    ``scale`` is the *native* scale the weights were trained for. A x2 checkpoint
    upscales by two and a x4 checkpoint by four; asking either for a different
    factor means resampling afterwards, which is emphatically not the same thing
    and must never be presented as if it were (benchmark plan §7).

    ``x2`` is implemented by the pixel-unshuffle trick the reference uses: the
    input is folded 2x into the channel dimension so the same two upsampling
    stages produce a net 2x rather than 4x. That is why both checkpoints share one
    architecture and one parameter-name layout.
    """

    def __init__(
        self,
        in_channels: int = 3,
        out_channels: int = 3,
        features: int = 64,
        blocks: int = 23,
        growth: int = 32,
        scale: int = 4,
    ) -> None:
        super().__init__()
        if scale not in {1, 2, 4}:
            msg = f"native scale must be 1, 2 or 4, got {scale}"
            raise ValueError(msg)

        self.scale = scale
        # Channel expansion for the pixel-unshuffle path.
        unshuffled = in_channels * {1: 16, 2: 4, 4: 1}[scale]

        self.conv_first = nn.Conv2d(unshuffled, features, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(features, growth) for _ in range(blocks)])
        self.conv_body = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_hr = nn.Conv2d(features, features, 3, 1, 1)
        self.conv_last = nn.Conv2d(features, out_channels, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x: Tensor) -> Tensor:
        if self.scale == 2:
            feat = _pixel_unshuffle(x, 2)
        elif self.scale == 1:
            feat = _pixel_unshuffle(x, 4)
        else:
            feat = x

        feat = self.conv_first(feat)
        body = self.conv_body(self.body(feat))
        feat = feat + body

        feat = self.lrelu(
            self.conv_up1(torch.nn.functional.interpolate(feat, scale_factor=2, mode="nearest"))
        )
        feat = self.lrelu(
            self.conv_up2(torch.nn.functional.interpolate(feat, scale_factor=2, mode="nearest"))
        )
        out: Tensor = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


def _pixel_unshuffle(x: Tensor, factor: int) -> Tensor:
    """Fold spatial detail into channels: the inverse of pixel shuffle."""
    batch, channels, height, width = x.shape
    if height % factor or width % factor:
        msg = f"height and width must be divisible by {factor}, got {height}x{width}"
        raise ValueError(msg)
    out_channels = channels * factor * factor
    view = x.view(batch, channels, height // factor, factor, width // factor, factor)
    return (
        view.permute(0, 1, 3, 5, 2, 4)
        .reshape(out_channels, -1)
        .view(batch, out_channels, height // factor, width // factor)
    )


def build_rrdbnet(scale: int) -> RRDBNet:
    """The architecture matching the published x2plus and x4plus checkpoints.

    23 blocks, 64 features, growth 32 - the configuration both released
    checkpoints were trained with. Any other configuration will fail to load them,
    which is the intended behaviour.
    """
    return RRDBNet(in_channels=3, out_channels=3, features=64, blocks=23, growth=32, scale=scale)
