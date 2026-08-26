"""Vendored third-party source, kept apart from code written here.

One rule, and it is the reason this package exists as its own directory: **nothing
in here is edited.** Files are copied verbatim from a pinned upstream commit,
carry their own licence notices, and are excluded from this repository's
formatter and type checker so the diff against upstream stays readable.

Editing a file here silently would make the attribution false and the
verification meaningless. If a change is genuinely needed, it belongs in the
adapter that wraps this code, not in the copy.

Current contents:

``network_swinir.py``
    SwinIR's Swin Transformer architecture, Apache-2.0, pinned at commit
    6545850fbf8df298df73d81f3e8cba638787c8bd. See D-056 and ADR-0006.
"""

from __future__ import annotations

__all__: list[str] = []
