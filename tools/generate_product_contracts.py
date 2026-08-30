"""Export and drift-check Product V2 schemas and TypeScript types."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tools.generate_ts_contracts import _render
else:
    from generate_ts_contracts import _render

from ipw.contracts.product_kernel import PRODUCT_SCHEMA_EXPORTS
from ipw.contracts.version import PRODUCT_SCHEMA_MAJOR, PRODUCT_SCHEMA_VERSION

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = REPO_ROOT / "packages" / "schemas" / PRODUCT_SCHEMA_MAJOR
TS_TARGET = REPO_ROOT / "packages" / "contracts-ts" / "src" / "generated" / "product.ts"

HEADER = """// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_product_contracts.py from the Product V2
// product-kernel models in packages/contracts.
//
// Regenerate with:  python tools/generate_product_contracts.py
// Verify with:      python tools/generate_product_contracts.py --check
"""


def schema_json(model: type[Any], name: str) -> str:
    schema = model.model_json_schema(mode="serialization")
    schema["$id"] = (
        f"https://image-pdf-workspace.packages/schemas/{PRODUCT_SCHEMA_MAJOR}/{name}.schema.json"
    )
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    return json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def expected_schemas() -> dict[Path, str]:
    return {
        SCHEMA_DIR / f"{name}.schema.json": schema_json(model, name)
        for name, model in sorted(PRODUCT_SCHEMA_EXPORTS.items())
    }


def typescript() -> str:
    definitions: dict[str, dict[str, Any]] = {}
    roots: dict[str, dict[str, Any]] = {}
    for name, model in sorted(PRODUCT_SCHEMA_EXPORTS.items()):
        document = model.model_json_schema(mode="serialization")
        for def_name, node in document.get("$defs", {}).items():
            definitions.setdefault(def_name, node)
        roots.setdefault(str(document.get("title") or name), document)

    blocks = [HEADER]
    blocks.append(
        "/** Production product-kernel contract version. */\n"
        f'export const PRODUCT_SCHEMA_VERSION = "{PRODUCT_SCHEMA_VERSION}";\n'
    )
    for name in sorted(definitions):
        blocks.append("\n".join(_render(name, definitions[name])) + "\n")
    for name in sorted(roots):
        if name not in definitions:
            blocks.append("\n".join(_render(name, roots[name])) + "\n")
    return "\n".join(blocks)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    expected = expected_schemas()
    expected[TS_TARGET] = typescript()

    if args.check:
        problems = [
            path.relative_to(REPO_ROOT).as_posix()
            for path, body in expected.items()
            if not path.is_file() or path.read_text(encoding="utf-8") != body
        ]
        actual = set(SCHEMA_DIR.glob("*.schema.json")) if SCHEMA_DIR.is_dir() else set()
        problems.extend(
            path.relative_to(REPO_ROOT).as_posix() for path in sorted(actual - set(expected))
        )
        if problems:
            sys.stderr.write("product contract drift: " + ", ".join(problems) + "\n")
            return 1
        sys.stdout.write(f"product schemas and TypeScript match ({len(expected) - 1} schemas)\n")
        return 0

    for path, body in expected.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8", newline="\n")
    sys.stdout.write(f"wrote {len(expected) - 1} product schemas and generated TypeScript\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
