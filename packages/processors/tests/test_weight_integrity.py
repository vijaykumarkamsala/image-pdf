"""The pinned-checkpoint control, tested without needing a checkpoint.

``verify_weight_digest`` is the thing standing between a tampered or truncated
download and an unpickler. It is a supply-chain control - Gate B in the licence
register - and it had no test, because the only code that called it was the model
loading path, which never runs without weights installed.

That is the wrong reason for a security control to be untested. Nothing here
needs torch or a real 67 MB file: the function takes a path and a spec, so the
spec can describe a handful of bytes.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from ipw.processors.ai_adapters.common import (
    WeightSpec,
    default_weights_dir,
    verify_weight_digest,
)

PAYLOAD = b"not really a checkpoint, but it hashes like one"


def _spec(payload: bytes = PAYLOAD, **overrides: object) -> WeightSpec:
    fields: dict[str, object] = {
        "component_id": "test-weights",
        "filename": "test.pth",
        "release_tag": "v0.0.0",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes_expected": len(payload),
        "source_url": "https://example.invalid/test.pth",
    }
    fields.update(overrides)
    return WeightSpec(**fields)  # type: ignore[arg-type]


def _write(tmp_path: Path, payload: bytes = PAYLOAD) -> Path:
    path = tmp_path / "test.pth"
    path.write_bytes(payload)
    return path


def test_a_matching_file_passes_silently(tmp_path: Path) -> None:
    verify_weight_digest(_write(tmp_path), _spec())


def test_a_truncated_download_is_caught_by_size(tmp_path: Path) -> None:
    """Size is checked first because it is free and catches the common failure."""
    path = _write(tmp_path, PAYLOAD[:10])

    with pytest.raises(RuntimeError, match="size mismatch"):
        verify_weight_digest(path, _spec())


def test_a_tampered_file_of_the_right_size_is_caught_by_digest(tmp_path: Path) -> None:
    """The case size cannot catch, which is the one the digest exists for.

    Same length, different bytes - what a substituted checkpoint would look like
    if somebody bothered to pad it.
    """
    swapped = b"NOT really a checkpoint, but it hashes like one"
    assert len(swapped) == len(PAYLOAD), "the point is that size cannot catch it"
    assert swapped != PAYLOAD

    path = _write(tmp_path, swapped)
    with pytest.raises(RuntimeError, match="digest mismatch"):
        verify_weight_digest(path, _spec())


def test_the_failure_names_the_file_and_both_digests(tmp_path: Path) -> None:
    """A mismatch is either an attack or a corrupt cache, and they are diagnosed
    differently. The message has to carry enough to tell them apart."""
    path = _write(tmp_path, b"x" * len(PAYLOAD))

    with pytest.raises(RuntimeError) as caught:
        verify_weight_digest(path, _spec())

    message = str(caught.value)
    assert "test.pth" in message
    assert hashlib.sha256(PAYLOAD).hexdigest() in message
    assert hashlib.sha256(b"x" * len(PAYLOAD)).hexdigest() in message
    assert "Refusing to load" in message


def test_a_missing_file_raises_rather_than_passing(tmp_path: Path) -> None:
    """An absent file must never be mistaken for a verified one."""
    with pytest.raises(FileNotFoundError):
        verify_weight_digest(tmp_path / "absent.pth", _spec())


def test_verification_reads_in_chunks_so_size_is_not_a_limit(tmp_path: Path) -> None:
    """Real checkpoints are larger than the 1 MB read buffer.

    A digest computed over only the first chunk would pass this test's small
    files and fail silently on every real one.
    """
    payload = bytes(range(256)) * 8192  # 2 MB, spans the buffer
    verify_weight_digest(_write(tmp_path, payload), _spec(payload))


def test_the_weights_directory_is_absolute(tmp_path: Path) -> None:
    """It is resolved against the repository, not the current directory.

    A relative answer would put the cache wherever the process happened to be
    started, which is how the same machine ends up downloading the same
    checkpoint twice.
    """
    assert default_weights_dir().is_absolute()
