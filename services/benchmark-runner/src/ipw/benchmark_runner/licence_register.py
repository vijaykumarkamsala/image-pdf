"""Compatibility wrapper for the production-safe licence registry package."""

from __future__ import annotations

from ipw.licence_registry.register import (
    GateDecision,
    LicenceRegister,
    RegisterDocument,
    evaluate_assets,
    evaluate_components,
    load_register,
    register_path,
)

__all__ = [
    "GateDecision",
    "LicenceRegister",
    "RegisterDocument",
    "evaluate_assets",
    "evaluate_components",
    "load_register",
    "register_path",
]
