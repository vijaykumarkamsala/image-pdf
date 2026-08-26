"""The lexer and the predictors: the level at which a PDF is just bytes.

Everything above this layer assumes objects parse correctly. A string escape
handled wrongly does not raise - it silently returns different text, and the
error surfaces as a watermark reading "DRAFTn" or a title with a bracket
missing. Predictors are the same: a wrong row filter produces a cross-reference
table full of plausible, wrong offsets.

These are cheap to test and expensive to debug from the symptom, which is the
argument for testing them directly rather than through a document.
"""

from __future__ import annotations

import zlib

import pytest

from ipw.pdf import reader as reader_module
from ipw.pdf.objects import Name
from ipw.pdf.reader import PdfReader, PdfSyntaxError, decode_stream

_Lexer = reader_module._Lexer  # noqa: SLF001 - module-private by design, tested here


def parse(source: bytes) -> object:
    return _Lexer(source, 0).parse()


class TestLiterals:
    @pytest.mark.parametrize(
        ("source", "expected"),
        [
            (b"true", True),
            (b"false", False),
            (b"null", None),
            (b"42", 42),
            (b"-17", -17),
            (b"+8", 8),
            (b"3.5", 3.5),
            (b"-0.25", -0.25),
            (b".5", 0.5),
        ],
    )
    def test_scalars(self, source: bytes, expected: object) -> None:
        assert parse(source) == expected

    def test_a_name(self) -> None:
        value = parse(b"/DeviceRGB")
        assert isinstance(value, Name)
        assert value.value == "DeviceRGB"

    def test_a_name_with_hex_escapes(self) -> None:
        """`#20` is a space. Producers use this for names with awkward characters."""
        value = parse(b"/Two#20Words")
        assert isinstance(value, Name)
        assert value.value == "Two Words"

    def test_a_reference(self) -> None:
        from ipw.pdf.objects import Reference

        value = parse(b"12 0 R")
        assert isinstance(value, Reference)
        assert value.number == 12

    def test_a_number_that_is_not_quite_a_number_does_not_crash(self) -> None:
        """Producers emit things like `--5` and `4.` A reader must not die on them."""
        assert isinstance(parse(b"4."), (int, float))


class TestStrings:
    @pytest.mark.parametrize(
        ("source", "expected"),
        [
            (b"(plain)", "plain"),
            (b"(nested (parentheses) work)", "nested (parentheses) work"),
            (rb"(escaped \( and \))", "escaped ( and )"),
            (rb"(a backslash \\ here)", "a backslash \\ here"),
            (rb"(newline\nand tab\t)", "newline\nand tab\t"),
            (rb"(return\r backspace\b formfeed\f)", "return\r backspace\x08 formfeed\x0c"),
            (rb"(octal \101\102\103)", "octal ABC"),
            (rb"(short octal \0)", "short octal \x00"),
        ],
    )
    def test_literal_strings(self, source: bytes, expected: str) -> None:
        """A wrong escape does not raise; it silently returns different text.

        That is why each one is pinned: the symptom is a watermark reading
        "DRAFTn", noticed by a customer rather than a test.
        """
        assert parse(source) == expected

    def test_a_backslash_before_a_newline_continues_the_line(self) -> None:
        assert parse(b"(one\\\ntwo)") == "onetwo"

    def test_hex_strings(self) -> None:
        assert parse(b"<48656C6C6F>") == "Hello"

    def test_a_hex_string_with_an_odd_digit_count_is_padded(self) -> None:
        # <414> means <4140>, per the specification.
        assert parse(b"<414>") == "A@"

    def test_an_unterminated_string_returns_what_it_read(self) -> None:
        """Consistent with the rest of the reader: recover, never refuse outright.

        A file truncated mid-string is damaged, and the honest response is the
        text that survived rather than an exception that loses the other four
        hundred objects too. The case where this actually matters - a document
        so damaged that nothing useful comes out - is caught at the page level,
        where `pages()` reports damage rather than returning an empty document.
        """
        assert parse(b"(never closed") == "never closed"


class TestContainers:
    def test_an_array(self) -> None:
        assert parse(b"[1 2 3]") == [1, 2, 3]

    def test_a_nested_array(self) -> None:
        assert parse(b"[1 [2 [3]] 4]") == [1, [2, [3]], 4]

    def test_a_dictionary(self) -> None:
        value = parse(b"<< /A 1 /B (two) >>")
        assert isinstance(value, dict)
        assert value["A"] == 1
        assert value["B"] == "two"

    def test_an_empty_dictionary(self) -> None:
        assert parse(b"<< >>") == {}

    def test_an_unterminated_array_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError, match="unterminated"):
            parse(b"[1 2 3")

    def test_an_unterminated_dictionary_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError):
            parse(b"<< /A 1")

    def test_a_stray_closing_bracket_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError, match="unexpected"):
            parse(b"]")

    def test_nothing_at_all_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError, match="end of file"):
            parse(b"   ")

    def test_a_token_that_means_nothing_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError, match="cannot parse"):
            parse(b"@@@")


class TestComments:
    def test_a_comment_is_skipped(self) -> None:
        assert parse(b"% this is a comment\n42") == 42

    def test_a_comment_inside_an_array_is_skipped(self) -> None:
        assert parse(b"[1 % two\n 3]") == [1, 3]

    def test_a_comment_at_the_very_end_does_not_hang(self) -> None:
        with pytest.raises(PdfSyntaxError):
            parse(b"% a comment and nothing else")


class TestPredictorRows:
    """The four PNG row filters. Each is a different arithmetic mistake waiting."""

    @staticmethod
    def _decode(tagged: bytes, columns: int, colors: int = 1) -> bytes:
        return decode_stream(
            {
                "Filter": Name("FlateDecode"),
                "DecodeParms": {"Predictor": 15, "Columns": columns, "Colors": colors},
            },
            zlib.compress(tagged),
        )

    def test_none(self) -> None:
        assert self._decode(b"\x00\x0a\x14\x1e", 3) == b"\x0a\x14\x1e"

    def test_sub_adds_the_pixel_to_its_left(self) -> None:
        # 10, then +10, then +10 -> 10, 20, 30
        assert self._decode(b"\x01\x0a\x0a\x0a", 3) == b"\x0a\x14\x1e"

    def test_up_adds_the_pixel_above(self) -> None:
        first = b"\x00\x0a\x14\x1e"
        second = b"\x02\x01\x01\x01"  # each +1 on the row above
        assert self._decode(first + second, 3) == b"\x0a\x14\x1e\x0b\x15\x1f"

    def test_average_uses_left_and_above(self) -> None:
        first = b"\x00\x04\x08\x0c"
        second = b"\x03\x00\x00\x00"  # 0 + floor((left + up) / 2)
        decoded = self._decode(first + second, 3)
        assert decoded[:3] == b"\x04\x08\x0c"
        # row2[0] = 0 + (0 + 4)//2 = 2; row2[1] = 0 + (2 + 8)//2 = 5
        assert decoded[3] == 2
        assert decoded[4] == 5

    def test_paeth_picks_the_nearest_predictor(self) -> None:
        first = b"\x00\x04\x08\x0c"
        second = b"\x04\x00\x00\x00"
        decoded = self._decode(first + second, 3)
        assert decoded[:3] == b"\x04\x08\x0c"
        # With a zero delta, Paeth reproduces the row above exactly.
        assert decoded[3:] == b"\x04\x08\x0c"

    def test_a_truncated_final_row_is_padded_rather_than_dropped(self) -> None:
        """Truncated streams are common; losing the row entirely is worse."""
        decoded = self._decode(b"\x00\x0a\x14\x1e\x00\x0a", 3)
        assert len(decoded) == 6
        assert decoded[3] == 0x0A


class TestDamagedStreams:
    def test_a_stream_with_trailing_rubbish_still_inflates(self) -> None:
        """Some producers append bytes after the deflate stream ends.

        Failing the whole document for one damaged object would be the wrong
        trade: the rest of the file is perfectly good.
        """
        payload = zlib.compress(b"the real content") + b"garbage at the end"
        assert decode_stream({"Filter": Name("FlateDecode")}, payload) == b"the real content"

    def test_a_stream_that_is_not_deflate_at_all_is_reported(self) -> None:
        with pytest.raises(PdfSyntaxError, match="inflate"):
            decode_stream({"Filter": Name("FlateDecode")}, b"not compressed at all")

    def test_a_reference_chain_that_loops_gives_up_rather_than_hanging(self) -> None:
        """A file can point object 1 at object 2 and object 2 back at object 1."""
        body = (
            b"%PDF-1.4\n"
            b"1 0 obj\n2 0 R\nendobj\n"
            b"2 0 obj\n1 0 R\nendobj\n"
            b"3 0 obj\n<< /Type /Catalog /Pages 4 0 R >>\nendobj\n"
            b"4 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj\n"
            b"5 0 obj\n<< /Type /Page /Parent 4 0 R /MediaBox [0 0 10 10] >>\nendobj\n"
            b"trailer\n<< /Root 3 0 R >>\n%%EOF\n"
        )
        reader = PdfReader.from_bytes(body)
        from ipw.pdf.objects import Reference

        # It must return, with anything at all, rather than recurse forever.
        reader.resolve(Reference(1))
