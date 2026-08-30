"""Production storage boundary.

The package defines the shape of storage access without connecting to a real
object store. Provider implementations arrive in a later recovery stage.
"""

from __future__ import annotations

from ipw.storage.boundary import ObjectReader, ObjectWriter, StoredObject

__all__ = ["ObjectReader", "ObjectWriter", "StoredObject"]

