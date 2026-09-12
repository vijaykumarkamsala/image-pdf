import io

from PIL import Image
from tools.image_compatibility import (
    native_downscale_rounding_matches,
    portable_metadata_value,
)
from tools.make_goldens import _windows_compatible
from tools.make_recovery_2e_fixtures import _canonical_srgb_profile


def test_generated_srgb_profile_pins_the_canonical_platform_header() -> None:
    profile = _canonical_srgb_profile()

    assert profile[36:40] == b"acsp"
    assert profile[40:44] == b"APPL"


def test_icc_platform_signature_is_not_treated_as_image_metadata_drift() -> None:
    linux_profile = bytearray(64)
    linux_profile[36:40] = b"acsp"
    linux_profile[40:44] = b"APPL"
    windows_profile = bytearray(linux_profile)
    windows_profile[40:44] = b"MSFT"

    assert portable_metadata_value("icc_profile", bytes(linux_profile)) == portable_metadata_value(
        "icc_profile", bytes(windows_profile)
    )

    changed_profile = bytearray(windows_profile)
    changed_profile[45] = 1
    assert portable_metadata_value("icc_profile", bytes(linux_profile)) != portable_metadata_value(
        "icc_profile", bytes(changed_profile)
    )


def test_native_downscale_rounding_rule_is_strictly_bounded() -> None:
    canonical = bytes([10, 20, 30, 40, 50, 60])

    assert native_downscale_rounding_matches(
        canonical, bytes([11, 20, 29, 40, 50, 60]), pixel_count=2
    )
    assert not native_downscale_rounding_matches(
        canonical, bytes([13, 20, 30, 40, 50, 60]), pixel_count=2
    )
    assert not native_downscale_rounding_matches(
        canonical, bytes([12, 21, 30, 40, 50, 60]), pixel_count=2
    )


def test_native_rounding_rule_is_limited_to_named_libvips_downscales() -> None:
    def png(red: int) -> bytes:
        output = io.BytesIO()
        Image.new("RGB", (1, 1), (red, 20, 30)).save(output, "PNG")
        return output.getvalue()

    canonical = png(10)
    candidate = png(11)

    assert _windows_compatible(
        canonical,
        candidate,
        engine_name="libvips",
        operation_name="resize-bicubic-32",
    )[0]
    assert not _windows_compatible(
        canonical,
        candidate,
        engine_name="libvips",
        operation_name="resize-lanczos-128-upscale",
    )[0]
    assert not _windows_compatible(
        canonical,
        candidate,
        engine_name="pillow",
        operation_name="resize-bicubic-32",
    )[0]
