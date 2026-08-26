"""Reading the words on a scanned page.

The engine is Tesseract, chosen for provenance rather than accuracy: its models
are trained on synthetic renderings of fonts rather than on scraped documents, so
the failure behind O-013 - permissive code sitting on research-only training
data - does not arise by construction. It is registered as `review_required`
(D-038), which permits local evaluation with results marked and blocks a
commercial recommendation until a real licence review exists.

**It is called as a subprocess, not through a wrapper library.** `pytesseract`
would be one more permanent licence-register entry to buy something this module
does in forty lines: run the binary, read its TSV, map the boxes. The binary
itself is the dependency either way, and it is the one that actually needs
pinning.

**What can be recognised, and what cannot.** A page is readable here when it
holds a full-page image - which is exactly what a scan is. A page of vector
artwork has no pixels of words to read, and rendering one to find out would need
the interpreter this package deliberately does not have. `coverage()` in
`textlayer.py` says which pages are which before any of this runs.

**The binary is not assumed to exist.** `availability()` reports its absence the
same way the AI operations report a missing runtime: as a fact about this host,
with the reason, rather than as a crash at the moment a customer clicks.
"""

from __future__ import annotations

import csv
import io
import shutil
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ipw.pdf.content import Matrix, apply, image_placements
from ipw.pdf.reader import PdfReader, RawStream
from ipw.pdf.textlayer import Word

__all__ = ["TesseractEngine", "availability", "locate", "recognise"]

# Tesseract's TSV columns, in the order it writes them.
_LEFT, _TOP, _WIDTH, _HEIGHT, _CONF, _TEXT = "left", "top", "width", "height", "conf", "text"

# Below this the engine is guessing. Keeping a guess would put a wrong word into
# a searchable layer, where it is worse than a gap: a search for it would land on
# a page that does not contain it.
MIN_CONFIDENCE = 40.0

# The name looked for on PATH when no other is given.
DEFAULT_BINARY = "tesseract"


@dataclass(frozen=True)
class TesseractEngine:
    """Tesseract, called as a subprocess."""

    language: str = "eng"
    binary: str = DEFAULT_BINARY
    timeout_seconds: int = 120

    def read_image(self, data: bytes) -> list[tuple[str, float, float, float, float, float]]:
        """Words in one image, as (text, left, top, width, height, confidence).

        Coordinates are image pixels with y running down, which is what the
        engine reports and what the caller then maps onto the page.
        """
        found: list[tuple[str, float, float, float, float, float]] = []

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "page.png"
            source.write_bytes(data)
            result = subprocess.run(  # noqa: S603 - fixed argv, no shell, path we wrote
                [
                    locate(self.binary) or self.binary,
                    str(source),
                    "stdout",
                    "-l",
                    self.language,
                    "tsv",
                ],
                capture_output=True,
                timeout=self.timeout_seconds,
                check=False,
            )

        if result.returncode != 0:
            message = result.stderr.decode("utf-8", "replace").strip()
            msg = f"the recogniser failed: {message[:200]}"
            raise RuntimeError(msg)

        reader = csv.DictReader(
            io.StringIO(result.stdout.decode("utf-8", "replace")),
            delimiter="\t",
            quoting=csv.QUOTE_NONE,
        )
        for row in reader:
            text = (row.get(_TEXT) or "").strip()
            if not text:
                continue
            try:
                confidence = float(row.get(_CONF) or -1)
                left = float(row[_LEFT])
                top = float(row[_TOP])
                width = float(row[_WIDTH])
                height = float(row[_HEIGHT])
            except (TypeError, ValueError, KeyError):
                continue
            if confidence < MIN_CONFIDENCE:
                continue
            found.append((text, left, top, width, height, confidence))
        return found


# Where installers put the binary when it is not on PATH.
#
# A fresh install is routinely absent from an already-running process's PATH -
# Windows updates the system environment, and existing shells keep the old one.
# Reporting "not installed" then is a wrong diagnosis that sends someone to
# reinstall software they already have, so the usual locations are checked too.
_LIKELY_PATHS = (
    "C:/Program Files/Tesseract-OCR/tesseract.exe",
    "C:/Program Files (x86)/Tesseract-OCR/tesseract.exe",
    "/usr/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/opt/homebrew/bin/tesseract",
)


def locate(binary: str = DEFAULT_BINARY) -> str | None:
    """The recogniser's path, from PATH or from where installers put it.

    The fallback applies only to the default name. Someone who names a specific
    binary - a different build, a wrapper, a version pinned for a comparison -
    must get that one or nothing: quietly running whatever happens to live in
    Program Files instead would produce results attributed to the wrong engine,
    which is worse than a clear failure and is exactly the sort of thing a
    benchmark cannot detect afterwards.
    """
    found = shutil.which(binary)
    if found:
        return found
    if binary != DEFAULT_BINARY:
        return None
    for candidate in _LIKELY_PATHS:
        if Path(candidate).is_file():
            return candidate
    return None


def availability(engine: TesseractEngine | None = None) -> dict[str, Any]:
    """Whether recognition can run here, and if not, why not.

    Reported rather than assumed, for the same reason the AI operations report
    their runtime: an interface that offers something the host cannot do
    produces a failure at the worst possible moment, and one that hides it
    produces a customer who thinks the product lacks a feature it has.
    """
    chosen = engine or TesseractEngine()
    path = locate(chosen.binary)
    if path is None:
        return {
            "available": False,
            "reason": (
                "the Tesseract recogniser is not installed on this machine. Everything else "
                "works without it; scanned pages simply cannot be read into text until it is "
                "present."
            ),
            "binary": None,
            "version": None,
        }

    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [path, "--version"], capture_output=True, timeout=20, check=False
        )
        version = result.stdout.decode("utf-8", "replace").splitlines()[0].strip()
    except (OSError, subprocess.SubprocessError, IndexError):
        version = "unknown"

    return {
        "available": True,
        "reason": "",
        "binary": path,
        "version": version,
        "licence_note": (
            "Tesseract is recorded in the licence register as review_required: it may be used "
            "here and its output marked, and it must not be relied on commercially until the "
            "licence and the training data of its language files have actually been reviewed."
        ),
    }


def recognise(
    reader: PdfReader,
    *,
    engine: TesseractEngine | None = None,
    pages: list[int] | None = None,
) -> tuple[dict[int, list[Word]], dict[str, Any]]:
    """Read the scanned pages of a document into positioned words.

    Only pages holding a full-page image are attempted. A page of vector artwork
    has no pixels of words on it, and one that already carries real text does not
    need this - recognising it would be slower and less accurate than the text
    that is already there.
    """
    chosen = engine or TesseractEngine()
    status = availability(chosen)
    if not status["available"]:
        raise RuntimeError(status["reason"])

    from PIL import Image

    every = reader.pages()
    wanted = set(pages) if pages else set(range(1, len(every) + 1))
    for number in sorted(wanted):
        if not 1 <= number <= len(every):
            msg = f"page {number} does not exist; this document has {len(every)} page(s)"
            raise ValueError(msg)

    words_by_page: dict[int, list[Word]] = {}
    skipped: list[int] = []
    low_confidence = 0

    for index, page in enumerate(every):
        number = index + 1
        if number not in wanted:
            continue

        placements = image_placements(reader, page.dictionary)
        biggest = _largest(placements)
        if biggest is None:
            skipped.append(number)
            continue

        stream, ctm = biggest
        try:
            picture = Image.open(io.BytesIO(stream.decoded()))
            picture.load()
        except Exception:  # noqa: BLE001 - an unreadable image is skipped, not fatal
            skipped.append(number)
            continue

        buffer = io.BytesIO()
        picture.convert("RGB").save(buffer, format="PNG")
        raw = chosen.read_image(buffer.getvalue())

        words: list[Word] = []
        for text, left, top, width, height, confidence in raw:
            box = _to_page(left, top, width, height, picture.width, picture.height, ctm)
            if box is None:
                continue
            words.append(Word(text, *box, confidence=confidence / 100.0))
            if confidence < 70.0:
                low_confidence += 1

        if words:
            words_by_page[number] = words
        else:
            skipped.append(number)

    total = sum(len(words) for words in words_by_page.values())
    return words_by_page, {
        "engine": "tesseract",
        "version": status.get("version"),
        "language": chosen.language,
        "pages_read": sorted(words_by_page),
        "pages_skipped": skipped,
        "words": total,
        "low_confidence_words": low_confidence,
        "note": _note(total, sorted(words_by_page), skipped, low_confidence),
    }


def _largest(
    placements: Mapping[str, tuple[RawStream, Matrix]],
) -> tuple[RawStream, Matrix] | None:
    """The image covering most of the page - the scan, if there is one.

    A page can carry a logo and a signature as well as its scan. Taking the
    largest placement rather than the first avoids recognising a letterhead and
    calling it the document.
    """
    best = None
    best_area = 0.0
    for stream, ctm in placements.values():
        area = abs(ctm[0] or ctm[2] or 0.0) * abs(ctm[3] or ctm[1] or 0.0)
        if area > best_area:
            best, best_area = (stream, ctm), area
    return best


def _to_page(
    left: float,
    top: float,
    width: float,
    height: float,
    image_width: int,
    image_height: int,
    ctm: Matrix,
) -> tuple[float, float, float, float] | None:
    """A box in image pixels to a box in page points.

    The image occupies the unit square under the matrix in force where it was
    drawn, so a pixel maps through (x/width, 1 - y/height) and then through that
    matrix. Doing it any other way - assuming the image fills the page, say -
    puts every recognised word in the wrong place on any document whose scan is
    inset, rotated or placed at a margin.
    """
    if image_width <= 0 or image_height <= 0:
        return None

    u0 = left / image_width
    u1 = (left + width) / image_width
    v0 = 1.0 - (top + height) / image_height
    v1 = 1.0 - top / image_height

    corners = [
        apply(ctm, u0, v0),
        apply(ctm, u1, v0),
        apply(ctm, u1, v1),
        apply(ctm, u0, v1),
    ]
    xs = [x for x, _ in corners]
    ys = [y for _, y in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _note(total: int, read: list[int], skipped: list[int], low: int) -> str:
    if not total:
        return (
            "Nothing was recognised. If these pages are vector artwork rather than scans, "
            "there are no pixels of words to read - which is not a failure, only the wrong "
            "tool for this document."
        )

    parts = [f"{total} word(s) read from {len(read)} page(s)."]
    if skipped:
        shown = ", ".join(str(page) for page in skipped[:8])
        parts.append(
            f"Page(s) {shown} were skipped: they hold no full-page image, so there is nothing "
            "to read."
        )
    if low:
        parts.append(
            f"{low} word(s) came back below 70% confidence. Recognition is a guess on poor "
            "scans, and a wrong word in a searchable layer is worse than a gap - check those "
            "before relying on a search."
        )
    parts.append(
        "Recorded as review_required in the licence register: usable here, not yet cleared "
        "for commercial reliance."
    )
    return " ".join(parts)
