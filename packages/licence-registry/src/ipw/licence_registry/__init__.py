"""Production-safe licence and release gate evaluation."""

from __future__ import annotations

from ipw.licence_registry.register import (
    GateDecision,
    LicenceRegister,
    evaluate_assets,
    evaluate_components,
    load_register,
    register_path,
)

__all__ = [
    "GateDecision",
    "LicenceRegister",
    "evaluate_assets",
    "evaluate_components",
    "load_register",
    "register_path",
]
