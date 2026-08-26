"""Refusing to serve commercially on components that are not cleared for it.

Gate A of the licence register asks one question: may this be used in a
commercial product? The register answers it per component, and the answer is
recorded rather than assumed. This module is what makes that answer *bind*.

**Why weights and not code.** The runtime dependencies are already guarded - a
test asserts the declared set matches the approved set, and CI fails if a
dependency arrives without a disposition. Model weights are not covered by that,
because they are not pip packages: they arrive by download, into a directory,
often onto one machine and not another. A container image built with weights
baked in would serve them to paying customers with nothing having checked.

**Why it refuses rather than warns, in production only.** A warning in a log is
not a control; the whole point of recording a disposition is that something acts
on it. But refusing everywhere would stop a developer evaluating a model they are
entitled to evaluate under D-038, which permits local evaluation with results
marked. Production is where the commercial question is live, so production is
where the answer is enforced.

The refusal names the component and its disposition, because "licence check
failed" sends somebody to read code, and "real-esrgan-weights-x4plus is
`unknown`" sends them to the register where the answer belongs.
"""

from __future__ import annotations

from pathlib import Path

__all__ = ["LicenceError", "enforce_licences", "unapproved_installed_weights"]


class LicenceError(RuntimeError):
    """A component that is not cleared for commercial use is installed here."""


def _pinned_weight_files() -> dict[str, str]:
    """Filename to component id, taken from the adapters' own pinned specs.

    Read from the adapters rather than restated here: a second copy of this
    mapping would be wrong the first time somebody pins a new checkpoint, and
    wrong in the direction that lets an uncleared model through.
    """
    from ipw.processors.ai_adapters.real_esrgan import PINNED_WEIGHTS
    from ipw.processors.ai_adapters.swinir import SWINIR_VARIANTS

    mapping = {spec.filename: spec.component_id for spec in PINNED_WEIGHTS.values()}
    mapping.update(
        {variant.spec.filename: variant.spec.component_id for variant in SWINIR_VARIANTS.values()}
    )
    return mapping


def unapproved_installed_weights(
    register: object, weights_dir: Path | None = None
) -> list[tuple[str, str]]:
    """Which installed checkpoints are not approved. Returns (component, disposition).

    Only files that are actually present count. A pinned specification for a
    model nobody downloaded is a plan, not a licence exposure.
    """
    from ipw.processors.ai_adapters.common import default_weights_dir

    directory = weights_dir or default_weights_dir()
    if not directory.is_dir():
        return []

    found: list[tuple[str, str]] = []
    for filename, component_id in sorted(_pinned_weight_files().items()):
        if not (directory / filename).is_file():
            continue
        component = register.get(component_id)  # type: ignore[attr-defined]
        disposition = (
            "not recorded at all"
            if component is None
            else str(getattr(component.disposition, "value", component.disposition))
        )
        if disposition != "approved":
            found.append((component_id, disposition))
    return found


def enforce_licences(
    settings: object, register: object | None = None, weights_dir: Path | None = None
) -> list[str]:
    """Check what is installed against the register. Returns lines to print.

    Raises in production; elsewhere it reports, because a developer is allowed to
    evaluate a model locally (D-038) and being unable to start the service would
    make that impossible rather than merely marked.
    """
    if register is None:
        from ipw.benchmark_runner.licence_register import load_register, register_path
        from ipw.benchmark_runner.workspace import find_repo_root

        try:
            register = load_register(register_path(find_repo_root()))
        except (OSError, ValueError) as exc:
            # A container without the register is a container that cannot answer
            # the question. In production that is itself the failure.
            if getattr(settings, "is_production", False):
                msg = f"the licence register could not be read, so nothing can be cleared: {exc}"
                raise LicenceError(msg) from exc
            return [f"  licence register unavailable ({exc}); nothing was checked"]

    blocked = unapproved_installed_weights(register, weights_dir)
    if not blocked:
        return ["  every installed model is cleared for commercial use"]

    detail = "; ".join(f"{component} is {disposition}" for component, disposition in blocked)
    if getattr(settings, "is_production", False):
        msg = (
            f"refusing to start: {len(blocked)} installed model(s) are not approved for "
            f"commercial use - {detail}. Either remove the weights from this image or "
            f"resolve the disposition in data/licences/register.json. Serving them to "
            f"customers is the thing the register exists to prevent."
        )
        raise LicenceError(msg)

    return [
        f"  WARNING: {len(blocked)} installed model(s) are not cleared for commercial use",
        f"  {detail}",
        "  permitted here for evaluation (D-038); production will refuse to start",
    ]
