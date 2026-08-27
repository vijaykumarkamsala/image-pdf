"""The application service (APP-001).

The properties that matter here are not "does resize work" - the processor suites
already answer that - but the ones the *application layer* could get wrong:
whether a standard request can reach a model, whether the interface is told the
truth about availability and licensing, and whether a customer is warned before
something invents detail.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest

from ipw.contracts.operation import FAMILY_OF, OperationFamily, OperationKind
from ipw.workspace_api.catalogue import (
    GROUP_ORDER,
    OPERATION_CATALOGUE,
    Group,
    catalogue_document,
)
from ipw.workspace_api.server import ProcessRequest, WorkspaceService, print_plan


@pytest.fixture(scope="module")
def service() -> WorkspaceService:
    return WorkspaceService()


@pytest.fixture
def png_bytes() -> bytes:
    from PIL import Image

    image = Image.new("RGB", (48, 32))
    pixels = image.load()
    assert pixels is not None
    for y in range(32):
        for x in range(48):
            pixels[x, y] = ((x * 5) % 256, (y * 7) % 256, 90)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------- catalogue --


class TestCatalogue:
    def test_every_advertised_operation_is_offered(self) -> None:
        """A feature the interface never lists is a feature the product lacks."""
        from ipw.contracts.operation import ADVERTISED_OPERATIONS

        offered = {entry.kind for entry in OPERATION_CATALOGUE}
        missing = [k.value for k in ADVERTISED_OPERATIONS if k not in offered]
        assert missing == [], f"advertised but not offered: {missing}"

    def test_ai_is_the_last_group(self) -> None:
        """A customer must choose AI rather than arrive in it."""
        assert GROUP_ORDER[-1] is Group.ENHANCE_WITH_AI

    def test_every_ai_operation_lives_in_the_ai_group(self) -> None:
        for entry in OPERATION_CATALOGUE:
            if FAMILY_OF[entry.kind] is OperationFamily.AI:
                assert entry.group is Group.ENHANCE_WITH_AI, entry.kind

    def test_no_standard_operation_is_in_the_ai_group(self) -> None:
        for entry in OPERATION_CATALOGUE:
            if entry.group is Group.ENHANCE_WITH_AI:
                assert FAMILY_OF[entry.kind] is OperationFamily.AI, entry.kind

    def test_generative_operations_declare_that_they_invent(self) -> None:
        """PRODUCT_REQUIREMENTS section 10 requires the explanation to be nearby.

        The interface reads this flag rather than keeping its own list, so an
        operation added later cannot quietly appear without a warning.
        """
        must_warn = {
            OperationKind.SUPER_RESOLUTION,
            OperationKind.AI_DENOISE,
            OperationKind.JPEG_ARTIFACT_REPAIR,
            OperationKind.FACE_RESTORE,
            OperationKind.DAMAGE_REPAIR,
            OperationKind.COLOURISE,
            OperationKind.BACKGROUND_REPLACE,
        }
        for entry in OPERATION_CATALOGUE:
            if entry.kind in must_warn:
                assert entry.invents_detail, f"{entry.kind.value} does not warn that it invents"

    def test_background_removal_does_not_claim_to_invent(self) -> None:
        """It cuts out; it does not draw. Over-warning is its own dishonesty."""
        entry = next(e for e in OPERATION_CATALOGUE if e.kind is OperationKind.BACKGROUND_REMOVE)
        assert not entry.invents_detail

    def test_slow_operations_say_so(self) -> None:
        """Measured at 250x a deterministic resize; a customer should know first."""
        for entry in OPERATION_CATALOGUE:
            if entry.needs_model:
                assert entry.speed == "slow", entry.kind

    def test_the_document_marks_the_ai_group(self) -> None:
        document = catalogue_document()
        flags = {group["id"]: group["is_ai"] for group in document["groups"]}
        assert flags["enhance_with_ai"] is True
        assert all(value is False for key, value in flags.items() if key != "enhance_with_ai")

    def test_the_document_states_the_default_family(self) -> None:
        assert catalogue_document()["default_family"] == "standard"

    def test_every_operation_has_a_human_summary(self) -> None:
        for entry in OPERATION_CATALOGUE:
            assert entry.label
            assert entry.label[0].isupper()
            assert entry.summary.endswith("."), f"{entry.kind.value} summary is not a sentence"


class TestAvailabilityIsReported:
    def test_model_operations_report_availability(self, service: WorkspaceService) -> None:
        """Offering something the host cannot do fails at the worst moment."""
        status = service.model_availability()
        assert set(status) >= {"super_resolution", "ai_denoise", "jpeg_artifact_repair"}
        for entry in status.values():
            assert isinstance(entry["available"], bool)
            if not entry["available"]:
                assert entry["reason"], "an unavailable operation must say why"

    def test_licence_standing_travels_to_the_interface(self, service: WorkspaceService) -> None:
        """A research-only model must not silently produce customer output."""
        pytest.importorskip("torch")
        status = service.model_availability()
        entry = status["super_resolution"]
        if entry["available"]:
            assert "licence" in entry
            assert entry["licence"]["eligible_for_commercial_use"] is False

    def test_the_catalogue_carries_availability_through(self, service: WorkspaceService) -> None:
        document = service.catalogue()
        ai_group = next(g for g in document["groups"] if g["is_ai"])
        for operation in ai_group["operations"]:
            if operation["needs_model"]:
                assert "available" in operation


# ------------------------------------------------------------------ inspect --


class TestInspect:
    def test_it_reports_the_real_shape(self, service: WorkspaceService, png_bytes: bytes) -> None:
        facts = service.inspect(png_bytes, "probe.png")
        assert facts["accepted"] is True
        assert (facts["width"], facts["height"]) == (48, 32)
        assert facts["decision"] == "standard"

    def test_it_does_not_decode_pixels(self, service: WorkspaceService, png_bytes: bytes) -> None:
        """Header-first, so a decompression bomb is refused cheaply."""
        assert service.inspect(png_bytes, "probe.png")["pixels_decoded"] is False

    def test_a_hostile_file_is_refused_with_a_reason(self, service: WorkspaceService) -> None:
        bomb = Path("data/fixtures/images/decompression-bomb.png")
        if not bomb.is_file():
            pytest.skip("inspection fixtures are not present")
        facts = service.inspect(bomb.read_bytes(), "bomb.png")
        assert facts["accepted"] is False
        assert facts["failure"]["code"] == "SAFETY.DECOMPRESSION_BOMB"
        assert facts["failure"]["message"]

    def test_a_non_image_is_refused(self, service: WorkspaceService) -> None:
        facts = service.inspect(b"this is not an image at all", "notes.png")
        assert facts["accepted"] is False


# ------------------------------------------------------------------ process --


class TestStandardCanNeverBecomeAi:
    """The property the application layer is most able to get wrong."""

    @pytest.mark.parametrize(
        "kind",
        [
            OperationKind.RESIZE,
            OperationKind.CROP,
            OperationKind.ROTATE,
            OperationKind.FLIP,
            OperationKind.ADJUST,
            OperationKind.SHARPEN,
            OperationKind.DENOISE,
            OperationKind.CONVERT,
        ],
    )
    def test_a_standard_request_gets_a_standard_processor(
        self, service: WorkspaceService, kind: OperationKind
    ) -> None:
        from ipw.contracts.operation import NoopSettings

        # A placeholder settings object: the standard branch does not read it,
        # and passing None would depend on that staying true.
        processor = service._processor_for(kind, NoopSettings())  # noqa: SLF001
        assert processor.describe().family is OperationFamily.STANDARD

    def test_a_standard_result_says_no_model_was_used(
        self, service: WorkspaceService, png_bytes: bytes
    ) -> None:
        result = service.process(
            ProcessRequest(
                kind=OperationKind.RESIZE,
                settings={"target_width": 24, "target_height": 16, "preserve_aspect_ratio": False},
                image_bytes=png_bytes,
            )
        )
        assert result["ok"] is True
        assert result["processor"]["used_a_model"] is False
        assert result["processor"]["weights"] is None


class TestProcess:
    def test_a_resize_returns_an_image_and_its_size(
        self, service: WorkspaceService, png_bytes: bytes
    ) -> None:
        result = service.process(
            ProcessRequest(
                kind=OperationKind.RESIZE,
                settings={"target_width": 96, "target_height": 64, "preserve_aspect_ratio": False},
                image_bytes=png_bytes,
            )
        )
        assert (result["width"], result["height"]) == (96, 64)
        assert result["image"].startswith("data:image/")
        assert result["took_ms"] >= 0

    def test_a_failure_comes_back_as_advice(self, service: WorkspaceService) -> None:
        """A customer gets a next step, not a stack trace."""
        result = service.process(
            ProcessRequest(
                kind=OperationKind.RESIZE,
                settings={"target_width": 10, "target_height": 10, "preserve_aspect_ratio": False},
                image_bytes=b"not an image",
            )
        )
        assert result["ok"] is False
        assert result["failure"]["code"]
        assert result["failure"]["next_action"]

    def test_invalid_settings_are_refused_by_the_contract(
        self, service: WorkspaceService, png_bytes: bytes
    ) -> None:
        with pytest.raises(ValueError, match="greater than or equal to 1"):
            service.process(
                ProcessRequest(
                    kind=OperationKind.RESIZE,
                    settings={"target_width": -5},
                    image_bytes=png_bytes,
                )
            )

    def test_an_unsupported_operation_is_refused_clearly(
        self, service: WorkspaceService, png_bytes: bytes
    ) -> None:
        with pytest.raises(ValueError, match="not available in this build"):
            service.process(
                ProcessRequest(kind=OperationKind.COLOURISE, settings={}, image_bytes=png_bytes)
            )

    def test_the_original_bytes_are_never_modified(
        self, service: WorkspaceService, png_bytes: bytes
    ) -> None:
        before = bytes(png_bytes)
        service.process(
            ProcessRequest(
                kind=OperationKind.ROTATE, settings={"degrees": 90}, image_bytes=png_bytes
            )
        )
        assert png_bytes == before


# --------------------------------------------------------------- print plan --


class TestPrintPlan:
    """The question the textile workflow actually starts from."""

    def test_a_large_source_is_ready(self) -> None:
        plan = print_plan(6000, 6000, 18, 300)
        assert plan["verdict"] == "ready"

    def test_a_pinterest_screenshot_cannot_reach_a_print_panel(self) -> None:
        """1 MP to eighteen inches at 300 DPI needs more than 5x. Say so."""
        plan = print_plan(1030, 1030, 18, 300)
        assert plan["verdict"] == "too_small"
        assert "cannot honestly reach" in plan["advice"]
        assert plan["required_scale"] > 5

    def test_the_same_source_is_reachable_at_a_lower_dpi(self) -> None:
        """Dropping to fabric resolution changes the answer, and it should."""
        plan = print_plan(1030, 1030, 18, 150)
        assert plan["verdict"] == "needs_upscale"
        assert "may reconstruct detail" in plan["advice"]

    def test_it_reports_the_pixels_required(self) -> None:
        plan = print_plan(1000, 1000, 10, 300)
        assert plan["required_pixels_on_longest_edge"] == 3000
        assert plan["required_scale"] == 3.0

    def test_a_modest_enlargement_needs_no_model(self) -> None:
        plan = print_plan(2000, 2000, 8, 300)
        assert plan["verdict"] in {"ready", "ok"}
        assert "AI" not in plan["advice"]

    @pytest.mark.parametrize("dpi", [150, 300, 600])
    def test_every_offered_dpi_produces_a_verdict(self, dpi: int) -> None:
        plan = print_plan(1500, 1500, 12, dpi)
        assert plan["verdict"] in {"ready", "ok", "needs_upscale", "too_small"}
        assert plan["advice"]

    def test_a_zero_size_is_refused_rather_than_answered(self) -> None:
        """Originally this asserted a scale of 0, to prove nothing divided by
        zero. Refusing satisfies that intent and one more: an image with no
        pixels has no print plan, and returning one - `required_scale: 0`, as
        though the request were satisfiable - is the same confident nonsense
        that answered "ready" for -3 inches at 0 DPI.
        """
        with pytest.raises(ValueError, match="cannot plan a print"):
            print_plan(0, 0, 10, 300)


def test_the_service_exposes_no_operation_the_contract_rejects(
    service: WorkspaceService,
) -> None:
    """Every catalogue entry must be a real OperationKind, not a string someone typed."""
    document: dict[str, Any] = service.catalogue()
    for group in document["groups"]:
        for operation in group["operations"]:
            assert OperationKind(operation["kind"])


class TestPrintPlanRefusesNonsense:
    """Impossible requests must not come back as confident advice.

    Asked for -3 inches at 0 DPI, this answered "ready - the source already has
    enough pixels for this size": both wrong numbers multiplied to zero, and
    zero pixels are easy to supply. A print shop acting on that reads a
    guarantee where there was only arithmetic.
    """

    def test_zero_dpi_is_refused(self) -> None:
        from ipw.workspace_api.server import print_plan

        with pytest.raises(ValueError, match="DPI must be greater than zero"):
            print_plan(800, 600, 8.0, 0)

    def test_a_negative_printed_size_is_refused(self) -> None:
        from ipw.workspace_api.server import print_plan

        with pytest.raises(ValueError, match="greater than zero inches"):
            print_plan(800, 600, -3.0, 300)

    def test_an_empty_image_is_refused(self) -> None:
        from ipw.workspace_api.server import print_plan

        with pytest.raises(ValueError, match="cannot plan a print"):
            print_plan(0, 600, 8.0, 300)

    def test_a_real_request_still_answers(self) -> None:
        from ipw.workspace_api.server import print_plan

        plan = print_plan(800, 600, 8.0, 300)

        assert plan["verdict"] in {"ready", "needs_upscale", "too_small"}
        assert plan["required_pixels_on_longest_edge"] == 2400
