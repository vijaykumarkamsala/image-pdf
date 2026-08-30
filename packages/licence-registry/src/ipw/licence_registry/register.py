"""Licence register: load records, resolve inheritance, apply the gates.

Three gates run here, and they are deliberately independent:

**Gate B — supply chain (D-039).** Applies at *every* purpose level, including
``local_research``. Missing official source, unpinned version, unrecorded weight
hash or enabled inference-time network all block execution outright. This is not
about commerce: loading a pickled checkpoint is arbitrary code execution on a
developer machine, and the risk is identical before and after shipping.

**Gate A — commercial (D-038).** Applies only to ``public_demo``, ``staging`` and
``production``. Research purposes proceed with the disposition recorded as a
marking on the result, so a reference-only run can never be mistaken for a
production recommendation.

**Rights — corpus.** An asset may forbid public display even when the model is
fully approved. Checked against the same purpose axis.

Dependency inheritance runs before all three: a component is never more
permissive than the least permissive component it executes. A permissively
licensed wrapper does not launder a restrictive weight.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import Field

from ipw.contracts.common import ContractModel, NonEmptyStr, SlugId
from ipw.contracts.failure import (
    FailureCategory,
    FailureCode,
    NextAction,
    NormalizedFailure,
    Severity,
    failure,
)
from ipw.contracts.licence import (
    COMMERCIAL_PURPOSES,
    Disposition,
    GateDecision,
    LicenceDisposition,
    RunPurpose,
    is_permitted,
    least_permissive,
)
from ipw.contracts.manifest import AssetManifest
from ipw.contracts.operation import OperationKind

__all__ = [
    "GateDecision",
    "LicenceRegister",
    "evaluate_assets",
    "evaluate_components",
    "load_register",
    "load_release_register",
    "production_provider_register_path",
    "register_path",
]


def register_path(repo_root: Path) -> Path:
    return repo_root / "data" / "licences" / "register.json"


def production_provider_register_path(repo_root: Path) -> Path:
    return repo_root / "data" / "licences" / "production-providers.json"


class RegisterDocument(ContractModel):
    """The on-disk licence register."""

    schema_version: str = "1.0.0"
    name: NonEmptyStr = "licence-register"
    description: str | None = None
    components: tuple[LicenceDisposition, ...] = ()
    approved_fallback: dict[OperationKind, SlugId] = Field(default_factory=dict)
    """D-040: the ``approved`` candidate retained for each advertised operation.

    An operation absent from this map has no approved fallback, which
    :func:`missing_approved_fallbacks` reports rather than hides."""


class LicenceRegister:
    """Indexed licence records with transitive dependency resolution."""

    def __init__(self, document: RegisterDocument) -> None:
        self.document = document
        self._by_id: dict[str, LicenceDisposition] = {
            component.component_id: component for component in document.components
        }

    # ------------------------------------------------------------ lookup --

    def __contains__(self, component_id: str) -> bool:
        return component_id in self._by_id

    def __len__(self) -> int:
        return len(self._by_id)

    def get(self, component_id: str) -> LicenceDisposition | None:
        return self._by_id.get(component_id)

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_id))

    def components(self) -> tuple[LicenceDisposition, ...]:
        return tuple(self._by_id[key] for key in sorted(self._by_id))

    # ------------------------------------------------------- inheritance --

    def _find_cycle(self, component_id: str) -> list[str] | None:
        """Depth-first search for a dependency cycle, returning the offending path.

        Tracked with an explicit recursion stack rather than a visited set: a
        component legitimately appears twice in a diamond dependency (two parents
        sharing a child), and only a repeat *within the current path* is a cycle.
        """
        path: list[str] = []
        on_path: set[str] = set()
        finished: set[str] = set()

        def visit(current: str) -> list[str] | None:
            if current in on_path:
                start = path.index(current)
                return [*path[start:], current]
            if current in finished:
                return None

            path.append(current)
            on_path.add(current)
            component = self._by_id.get(current)
            for dependency in component.depends_on if component else ():
                cycle = visit(dependency)
                if cycle is not None:
                    return cycle
            path.pop()
            on_path.discard(current)
            finished.add(current)
            return None

        return visit(component_id)

    def closure(self, component_id: str) -> tuple[tuple[str, ...], NormalizedFailure | None]:
        """Return ``component_id`` plus every component it transitively executes.

        A dependency cycle is a register authoring error, not a runtime
        condition, so it is reported rather than silently absorbed.
        """
        cycle = self._find_cycle(component_id)
        if cycle is not None:
            return (), failure(
                FailureCode.LICENCE_DEPENDENCY_CYCLE,
                FailureCategory.INVALID_INPUT,
                f"dependency cycle: {' -> '.join(cycle)}",
                next_action=NextAction.CONTACT_SUPPORT,
                remediation="Break the cycle in data/licences/register.json. Inheritance "
                "cannot resolve while a component transitively depends on itself.",
                component_id=component_id,
                cycle_length=len(cycle) - 1,
            )

        members: list[str] = []
        queue = [component_id]
        while queue:
            current = queue.pop(0)
            if current in members:
                continue
            members.append(current)
            component = self._by_id.get(current)
            if component is not None:
                queue.extend(component.depends_on)

        return tuple(members), None

    def effective_disposition(self, component_id: str) -> Disposition:
        """The least permissive disposition across the component and its dependencies."""
        members, cycle = self.closure(component_id)
        if cycle is not None:
            return Disposition.BLOCKED
        dispositions = [
            self._by_id[member].disposition for member in members if member in self._by_id
        ]
        if len(dispositions) != len(members):
            # An unregistered dependency is unknown, and unknown is never assumed benign.
            dispositions.append(Disposition.UNKNOWN)
        return least_permissive(dispositions)

    # ------------------------------------------------------------- gates --

    def evaluate(self, component_id: str, purpose: RunPurpose) -> GateDecision:
        """Apply Gate B then Gate A to one component."""
        failures: list[NormalizedFailure] = []
        warnings: list[NormalizedFailure] = []
        markings: list[str] = []

        component = self._by_id.get(component_id)
        if component is None:
            return GateDecision(
                purpose=purpose,
                permitted=False,
                effective_disposition=Disposition.UNKNOWN,
                failures=(
                    failure(
                        FailureCode.LICENCE_COMPONENT_NOT_REGISTERED,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{component_id} is not in the licence register",
                        next_action=NextAction.CONTACT_SUPPORT,
                        remediation="Add a record to data/licences/register.json before use.",
                        component_id=component_id,
                    ),
                ),
            )

        members, cycle = self.closure(component_id)
        if cycle is not None:
            return GateDecision(
                purpose=purpose,
                permitted=False,
                effective_disposition=Disposition.BLOCKED,
                failures=(cycle,),
            )

        for member in members:
            if member not in self._by_id:
                failures.append(
                    failure(
                        FailureCode.LICENCE_DEPENDENCY_NOT_REGISTERED,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{component_id} executes {member}, which is not registered",
                        next_action=NextAction.CONTACT_SUPPORT,
                        remediation="A wrapper licence never covers an unregistered dependency.",
                        component_id=component_id,
                        dependency=member,
                    )
                )

        # -- Gate B: supply chain. Applies at every purpose level (D-039). --
        for member in members:
            registered = self._by_id.get(member)
            if registered is None:
                continue
            for gap in registered.supply_chain_gaps():
                failures.append(
                    failure(
                        FailureCode.LICENCE_SUPPLY_CHAIN_INCOMPLETE,
                        FailureCategory.SAFETY_LIMIT,
                        f"{member}: {gap}",
                        next_action=NextAction.CONTACT_SUPPORT,
                        remediation="Gate B (D-039) applies to local research too: loading an "
                        "unverified checkpoint is arbitrary code execution.",
                        component_id=member,
                        requested_by=component_id,
                    )
                )

        effective = self.effective_disposition(component_id)
        reference_only = any(self._by_id[m].reference_only for m in members if m in self._by_id)

        markings.append(f"disposition:{effective.value}")
        if reference_only:
            markings.append("reference-only")

        # -- Gate A: commercial. Applies to commercial purposes only (D-038). --
        if effective is Disposition.BLOCKED:
            failures.append(
                failure(
                    FailureCode.LICENCE_BLOCKED,
                    FailureCategory.ENTITLEMENT_REQUIRED,
                    f"{component_id} resolves to a blocked disposition and may not be executed "
                    f"for any purpose",
                    next_action=NextAction.CONTACT_SUPPORT,
                    component_id=component_id,
                )
            )
        elif purpose in COMMERCIAL_PURPOSES:
            if reference_only:
                failures.append(
                    failure(
                        FailureCode.LICENCE_REFERENCE_ONLY,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{component_id} is reference-only and may never be used for "
                        f"{purpose.value}",
                        next_action=NextAction.ALTERNATE_ROUTE,
                        remediation="Use an approved candidate, or obtain written commercial "
                        "permission and record it.",
                        component_id=component_id,
                        purpose=purpose.value,
                    )
                )
            if not is_permitted(effective, purpose):
                code = (
                    FailureCode.LICENCE_UNKNOWN_DISPOSITION
                    if effective is Disposition.UNKNOWN
                    else FailureCode.LICENCE_NOT_APPROVED
                )
                failures.append(
                    failure(
                        code,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{component_id} resolves to '{effective.value}', which does not permit "
                        f"{purpose.value}",
                        next_action=NextAction.ALTERNATE_ROUTE,
                        remediation="Commercial clearance is required for public demo, staging "
                        "and production (D-038).",
                        component_id=component_id,
                        purpose=purpose.value,
                        effective_disposition=effective.value,
                    )
                )
        else:
            # Research purposes proceed, but never silently.
            if effective is not Disposition.APPROVED:
                warnings.append(
                    failure(
                        FailureCode.LICENCE_NOT_APPROVED,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{component_id} resolves to '{effective.value}'. Permitted for "
                        f"{purpose.value}, but results are marked and can never appear as a "
                        f"commercial recommendation.",
                        severity=Severity.WARNING,
                        next_action=NextAction.NONE,
                        component_id=component_id,
                        effective_disposition=effective.value,
                    )
                )

        return GateDecision(
            purpose=purpose,
            permitted=not failures,
            effective_disposition=effective,
            reference_only=reference_only,
            markings=tuple(sorted(set(markings))),
            failures=tuple(failures),
            warnings=tuple(warnings),
        )

    # ------------------------------------------------------------ D-040 --

    def missing_approved_fallbacks(
        self, operations: tuple[OperationKind, ...]
    ) -> tuple[NormalizedFailure, ...]:
        """Operations with no ``approved`` candidate retained (D-040).

        Reported, never hidden: a silently missing fallback is exactly how a
        licence negotiation turns into a rescue instead of an upgrade.
        """
        found: list[NormalizedFailure] = []
        for operation in operations:
            component_id = self.document.approved_fallback.get(operation)
            registered = self._by_id.get(component_id) if component_id else None
            if registered is None or not registered.is_commercially_eligible:
                found.append(
                    failure(
                        FailureCode.LICENCE_NO_APPROVED_FALLBACK,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"operation '{operation.value}' has no approved fallback candidate",
                        severity=Severity.WARNING,
                        next_action=NextAction.CONTACT_SUPPORT,
                        remediation="D-040: every advertised Release 1 operation must retain at "
                        "least one approved candidate, so a licence negotiation is an upgrade "
                        "rather than a rescue.",
                        operation=operation.value,
                    )
                )
        return tuple(found)


def load_register(path: Path) -> LicenceRegister:
    """Load and validate the register document."""
    document = RegisterDocument.model_validate(json.loads(path.read_text(encoding="utf-8")))
    return LicenceRegister(document)


def load_release_register(repo_root: Path) -> LicenceRegister:
    """Compose historical and production-provider evidence for release gates."""
    historical = load_register(register_path(repo_root)).document
    providers = load_register(production_provider_register_path(repo_root)).document
    components = historical.components + providers.components
    component_ids = [component.component_id for component in components]
    if len(component_ids) != len(set(component_ids)):
        raise ValueError("licence component ids must be unique across release registers")
    return LicenceRegister(
        RegisterDocument(
            name="production-release-licence-register",
            description="Historical component and production provider release evidence.",
            components=components,
            approved_fallback=historical.approved_fallback,
        )
    )


# ------------------------------------------------------------- evaluation --


def evaluate_components(
    register: LicenceRegister, component_ids: tuple[str, ...], purpose: RunPurpose
) -> GateDecision:
    """Combine per-component decisions into one decision for a run."""
    decisions = [register.evaluate(component_id, purpose) for component_id in component_ids]
    if not decisions:
        return GateDecision(
            purpose=purpose, permitted=True, effective_disposition=Disposition.APPROVED
        )

    return GateDecision(
        purpose=purpose,
        permitted=all(d.permitted for d in decisions),
        effective_disposition=least_permissive([d.effective_disposition for d in decisions]),
        reference_only=any(d.reference_only for d in decisions),
        markings=tuple(sorted({mark for d in decisions for mark in d.markings})),
        failures=tuple(f for d in decisions for f in d.failures),
        warnings=tuple(w for d in decisions for w in d.warnings),
    )


def evaluate_assets(manifest: AssetManifest, purpose: RunPurpose) -> GateDecision:
    """Rights gate for the corpus.

    An asset can forbid public display even when the model is fully approved, so
    this runs independently of the licence register.
    """
    failures: list[NormalizedFailure] = []
    warnings: list[NormalizedFailure] = []

    for index, entry in enumerate(manifest.assets):
        pointer = f"/assets/{index}"
        provenance = entry.provenance
        if provenance is None:
            failures.append(
                failure(
                    FailureCode.RIGHTS_PROVENANCE_MISSING,
                    FailureCategory.ENTITLEMENT_REQUIRED,
                    f"{entry.asset_id} has no provenance record and may not be used",
                    pointer=f"{pointer}/provenance",
                    next_action=NextAction.CONTACT_SUPPORT,
                    asset_id=entry.asset_id,
                )
            )
            continue

        if not provenance.permitted_benchmark_use:
            failures.append(
                failure(
                    FailureCode.RIGHTS_BENCHMARK_USE_NOT_PERMITTED,
                    FailureCategory.ENTITLEMENT_REQUIRED,
                    f"{entry.asset_id} is not permitted for benchmark use",
                    pointer=f"{pointer}/provenance/permitted_benchmark_use",
                    next_action=NextAction.CONTACT_SUPPORT,
                    asset_id=entry.asset_id,
                )
            )

        if purpose is RunPurpose.PUBLIC_DEMO and not provenance.public_demo_permitted:
            failures.append(
                failure(
                    FailureCode.RIGHTS_PUBLIC_DEMO_NOT_PERMITTED,
                    FailureCategory.ENTITLEMENT_REQUIRED,
                    f"{entry.asset_id} may not appear in a public demo",
                    pointer=f"{pointer}/provenance/public_demo_permitted",
                    next_action=NextAction.ALTERNATE_ROUTE,
                    remediation="Select assets whose provenance permits public display.",
                    asset_id=entry.asset_id,
                )
            )

        if provenance.contains_sensitive_information:
            if purpose in COMMERCIAL_PURPOSES:
                failures.append(
                    failure(
                        FailureCode.RIGHTS_SENSITIVE_CONTENT,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{entry.asset_id} contains sensitive information and may not be used "
                        f"for {purpose.value}",
                        pointer=f"{pointer}/provenance/contains_sensitive_information",
                        next_action=NextAction.ALTERNATE_ROUTE,
                        asset_id=entry.asset_id,
                    )
                )
            else:
                warnings.append(
                    failure(
                        FailureCode.RIGHTS_SENSITIVE_CONTENT,
                        FailureCategory.ENTITLEMENT_REQUIRED,
                        f"{entry.asset_id} contains sensitive information; handle under "
                        f"restricted review",
                        pointer=f"{pointer}/provenance/contains_sensitive_information",
                        severity=Severity.WARNING,
                        next_action=NextAction.NONE,
                        asset_id=entry.asset_id,
                    )
                )

    return GateDecision(
        purpose=purpose,
        permitted=not failures,
        effective_disposition=Disposition.APPROVED if not failures else Disposition.BLOCKED,
        failures=tuple(failures),
        warnings=tuple(warnings),
    )
