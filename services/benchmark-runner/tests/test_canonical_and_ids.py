"""Canonicalisation and deterministic identifiers."""

from __future__ import annotations

import pytest

from ipw.benchmark_runner.canonical import (
    CanonicalisationError,
    canonical_json,
    canonical_text,
)
from ipw.benchmark_runner.ids import (
    ID_BODY_LENGTH,
    digest_hex,
    digest_id,
    identity_document,
    manifest_id_of,
    result_id_of,
    run_id_of,
)
from ipw.contracts.common import SAFE_INT_MAX


class TestCanonicalisation:
    def test_key_order_does_not_affect_output(self) -> None:
        assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})

    def test_output_is_compact_utf8(self) -> None:
        assert canonical_json({"a": 1, "b": [1, 2]}) == b'{"a":1,"b":[1,2]}'

    def test_non_ascii_values_are_preserved_not_escaped(self) -> None:
        assert canonical_json({"name": "café"}) == '{"name":"café"}'.encode()

    def test_unicode_is_nfc_normalised(self) -> None:
        composed = "é"  # é as one code point
        decomposed = "é"  # e + combining acute
        assert canonical_json({"a": composed}) == canonical_json({"a": decomposed})

    def test_tuples_and_lists_canonicalise_identically(self) -> None:
        assert canonical_json({"a": (1, 2)}) == canonical_json({"a": [1, 2]})

    @pytest.mark.parametrize("value", [1.5, 0.0, -3.25, float("inf")])
    def test_floats_are_rejected(self, value: float) -> None:
        with pytest.raises(CanonicalisationError, match="float"):
            canonical_json({"metric": value})

    def test_out_of_range_integers_are_rejected(self) -> None:
        with pytest.raises(CanonicalisationError, match="exactly-representable"):
            canonical_json({"n": SAFE_INT_MAX + 1})

    def test_non_ascii_keys_are_rejected(self) -> None:
        with pytest.raises(CanonicalisationError, match="ASCII"):
            canonical_json({"clé": 1})

    def test_non_string_keys_are_rejected(self) -> None:
        with pytest.raises(CanonicalisationError, match="must be strings"):
            canonical_json({1: "a"})

    def test_unsupported_types_are_rejected(self) -> None:
        with pytest.raises(CanonicalisationError, match="unsupported type"):
            canonical_json({"when": object()})

    def test_booleans_are_not_treated_as_integers(self) -> None:
        assert canonical_text({"a": True}) == '{"a":true}'
        assert canonical_text({"a": 1}) == '{"a":1}'

    def test_error_message_points_at_the_offending_path(self) -> None:
        with pytest.raises(CanonicalisationError, match=r"/outer/inner"):
            canonical_json({"outer": {"inner": 1.5}})


class TestIdentityDocuments:
    def test_domain_separation_prevents_cross_kind_collisions(self) -> None:
        payload = {"identity": {"value": 1}}
        assert digest_id("run", payload) != digest_id("result", payload)

    def test_reserved_keys_are_rejected(self) -> None:
        with pytest.raises(ValueError, match="reserved keys"):
            identity_document("run", {"_id_kind": "spoofed"})

    def test_unknown_kind_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="unknown identity kind"):
            digest_id("not-a-kind", {"a": 1})

    def test_identity_document_carries_kind_and_version(self) -> None:
        doc = identity_document("run", {"a": 1})
        assert doc["_id_kind"] == "run"
        assert doc["_schema_version"]

    def test_digest_hex_is_full_sha256(self) -> None:
        assert len(digest_hex({"a": 1}, "run")) == 64


class TestIdentifierFormat:
    @pytest.mark.parametrize(
        ("kind", "prefix"),
        [("run", "run_"), ("result", "res_"), ("report", "rep_"), ("manifest", "mfst_")],
    )
    def test_prefix_and_length(self, kind: str, prefix: str) -> None:
        identifier = digest_id(kind, {"a": 1})
        assert identifier.startswith(prefix)
        assert len(identifier) == len(prefix) + ID_BODY_LENGTH

    def test_alphabet_is_lowercase_base32(self) -> None:
        body = digest_id("run", {"a": 1}).split("_", 1)[1]
        assert set(body) <= set("abcdefghijklmnopqrstuvwxyz234567")

    def test_identical_input_gives_identical_id(self) -> None:
        assert digest_id("run", {"a": 1, "b": [1, 2]}) == digest_id("run", {"b": [1, 2], "a": 1})

    def test_different_input_gives_different_id(self) -> None:
        assert digest_id("run", {"a": 1}) != digest_id("run", {"a": 2})


class TestConvenienceHelpers:
    def test_helpers_are_stable_and_distinct(self) -> None:
        payload = {"x": 1}
        ids = {
            manifest_id_of(payload),
            run_id_of(payload),
            result_id_of(payload),
        }
        assert len(ids) == 3, "each helper must produce a distinct identifier namespace"
        assert manifest_id_of(payload) == manifest_id_of({"x": 1})
