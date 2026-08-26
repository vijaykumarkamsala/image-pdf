"""The commercial-use control, tested against a stand-in register.

The register itself changes as dispositions get resolved, so asserting against
the real one would make these tests a record of today's licence state rather
than of the rule. What is being tested is the rule: an uncleared model that is
actually installed stops production starting, and says which model and why.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from ipw.workspace_api.licence_guard import (
    LicenceError,
    enforce_licences,
    unapproved_installed_weights,
)

# A real filename from the pinned specs, so the mapping under test is exercised
# rather than a name invented here.
KNOWN_WEIGHT = "RealESRGAN_x4plus.pth"
KNOWN_COMPONENT = "real-esrgan-weights-x4plus"


@dataclass
class FakeComponent:
    disposition: str


class FakeRegister:
    def __init__(self, dispositions: dict[str, str]) -> None:
        self._dispositions = dispositions

    def get(self, component_id: str) -> FakeComponent | None:
        value = self._dispositions.get(component_id)
        return None if value is None else FakeComponent(disposition=value)


@dataclass
class FakeSettings:
    is_production: bool = False


def _weights(tmp_path: Path, *filenames: str) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    for name in filenames:
        (tmp_path / name).write_bytes(b"not really a checkpoint")
    return tmp_path


class TestWhatCounts:
    def test_an_installed_unapproved_model_is_reported(self, tmp_path: Path) -> None:
        register = FakeRegister({KNOWN_COMPONENT: "unknown"})

        found = unapproved_installed_weights(register, _weights(tmp_path, KNOWN_WEIGHT))

        assert found == [(KNOWN_COMPONENT, "unknown")]

    def test_an_approved_model_is_not_reported(self, tmp_path: Path) -> None:
        register = FakeRegister({KNOWN_COMPONENT: "approved"})

        assert unapproved_installed_weights(register, _weights(tmp_path, KNOWN_WEIGHT)) == []

    def test_a_model_that_is_not_installed_is_not_an_exposure(self, tmp_path: Path) -> None:
        """A pinned specification for a checkpoint nobody downloaded is a plan,
        not a licence problem."""
        register = FakeRegister({KNOWN_COMPONENT: "non_commercial"})

        assert unapproved_installed_weights(register, _weights(tmp_path)) == []

    def test_a_model_missing_from_the_register_is_treated_as_uncleared(
        self, tmp_path: Path
    ) -> None:
        """Absence of a record is not evidence of permission - it is the case the
        register exists to make impossible, so it must not read as approved."""
        found = unapproved_installed_weights(FakeRegister({}), _weights(tmp_path, KNOWN_WEIGHT))

        assert found == [(KNOWN_COMPONENT, "not recorded at all")]

    def test_no_weights_directory_at_all_is_fine(self, tmp_path: Path) -> None:
        register = FakeRegister({KNOWN_COMPONENT: "unknown"})

        assert unapproved_installed_weights(register, tmp_path / "absent") == []


class TestEnforcement:
    def test_production_refuses_to_start(self, tmp_path: Path) -> None:
        register = FakeRegister({KNOWN_COMPONENT: "unknown"})

        with pytest.raises(LicenceError, match="refusing to start"):
            enforce_licences(
                FakeSettings(is_production=True), register, _weights(tmp_path, KNOWN_WEIGHT)
            )

    def test_the_refusal_names_the_component_and_its_disposition(self, tmp_path: Path) -> None:
        """'Licence check failed' sends somebody to read code. Naming the
        component sends them to the register, where the answer belongs."""
        register = FakeRegister({KNOWN_COMPONENT: "non_commercial"})

        with pytest.raises(LicenceError) as caught:
            enforce_licences(
                FakeSettings(is_production=True), register, _weights(tmp_path, KNOWN_WEIGHT)
            )

        message = str(caught.value)
        assert KNOWN_COMPONENT in message
        assert "non_commercial" in message
        assert "register.json" in message

    def test_development_reports_rather_than_refusing(self, tmp_path: Path) -> None:
        """D-038 permits local evaluation with results marked. Refusing here
        would make that impossible rather than merely marked."""
        register = FakeRegister({KNOWN_COMPONENT: "unknown"})

        lines = enforce_licences(FakeSettings(), register, _weights(tmp_path, KNOWN_WEIGHT))

        assert any("WARNING" in line for line in lines)
        assert any(KNOWN_COMPONENT in line for line in lines)
        assert any("production will refuse" in line for line in lines)

    def test_a_clean_install_says_so(self, tmp_path: Path) -> None:
        register = FakeRegister({KNOWN_COMPONENT: "approved"})

        lines = enforce_licences(
            FakeSettings(is_production=True), register, _weights(tmp_path, KNOWN_WEIGHT)
        )

        assert lines == ["  every installed model is cleared for commercial use"]

    def test_production_refuses_when_the_register_cannot_be_read(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A container that cannot answer the question has not answered it."""
        import ipw.benchmark_runner.licence_register as register_module

        def unreadable(_path: Path) -> object:
            msg = "no register in this image"
            raise OSError(msg)

        monkeypatch.setattr(register_module, "load_register", unreadable)

        with pytest.raises(LicenceError, match="could not be read"):
            enforce_licences(FakeSettings(is_production=True), None, tmp_path)

    def test_development_carries_on_without_a_register(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import ipw.benchmark_runner.licence_register as register_module

        def unreadable(_path: Path) -> object:
            msg = "no register here"
            raise OSError(msg)

        monkeypatch.setattr(register_module, "load_register", unreadable)

        lines = enforce_licences(FakeSettings(), None, tmp_path)

        assert any("nothing was checked" in line for line in lines)
