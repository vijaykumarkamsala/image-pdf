"""Shared constrained types used across the benchmark contract.

Determinism rule enforced here
------------------------------
No field that can feed an identity digest may be a floating point number.
Floats are the single largest source of cross-platform digest drift (formatting,
rounding and ordering all vary). The contract therefore models:

* durations as integer **nanoseconds**,
* sizes as integer **bytes**,
* money as a **decimal string**,
* ratios/percentages as integers.

Observed quality metrics (PSNR, SSIM, LPIPS) are permitted to be floats when
they arrive in POC-004/POC-007, but they live in observation records and are
excluded from every identity document.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# --------------------------------------------------------------------- types --

Sha256Hex = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{64}$"),
    Field(description="Lower-case hexadecimal SHA-256 digest."),
]

AssetId = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z0-9][a-z0-9._-]{2,63}$"),
    Field(description="Stable, human-readable asset identifier, unique within a manifest."),
]

SlugId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9._-]{2,63}$")]

DigestId = Annotated[
    str,
    StringConstraints(pattern=r"^(run|res|rep|mfst|pol|rt|ast)_[a-z2-7]{32}$"),
    Field(description="Content-addressed identifier produced by ipw.benchmark_runner.ids."),
]

DecimalStr = Annotated[
    str,
    StringConstraints(pattern=r"^-?\d+(\.\d+)?$"),
    Field(description="Exact decimal value carried as a string to avoid float drift."),
]

CurrencyCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]

RelativePosixPath = Annotated[
    str,
    # Only the cheap structural rule lives here: non-empty and not rooted. The full
    # traversal defence (backslashes, drive letters, UNC, '..', symlinks, escape from
    # the asset root) is in ipw.benchmark_runner.validation.resolve_asset_path, so a
    # hostile path produces a precise MANIFEST.INVALID_PATH failure with remediation
    # rather than a generic schema error.
    StringConstraints(pattern=r"^[^/]", min_length=1, max_length=1024),
    Field(description="POSIX-style path relative to the configured asset root."),
]

NonEmptyStr = Annotated[
    str, StringConstraints(min_length=1, max_length=2048, strip_whitespace=True)
]

Percent = Annotated[int, Field(ge=0, le=100)]
SignedPercent = Annotated[int, Field(ge=-100, le=100)]
NonNegInt = Annotated[int, Field(ge=0)]
PositiveInt = Annotated[int, Field(ge=1)]

# JavaScript's Number is exact only to 2**53-1. The browser lab (POC-005) must be
# able to reproduce identity digests, so integers in the contract stay inside the
# range both languages represent exactly.
SAFE_INT_MAX = 2**53 - 1
SAFE_INT_MIN = -(2**53) + 1
SafeInt = Annotated[int, Field(ge=SAFE_INT_MIN, le=SAFE_INT_MAX)]


# -------------------------------------------------------------------- models --


class ContractModel(BaseModel):
    """Base class for every serialisable contract model.

    ``extra="forbid"`` makes a mistyped field an error rather than a silently
    dropped value - important because a dropped field would change an identity
    digest without anybody noticing. ``frozen=True`` keeps contract documents
    immutable once constructed.
    """

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        validate_assignment=True,
        use_enum_values=False,
        ser_json_timedelta="float",
    )
