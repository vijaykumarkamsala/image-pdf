"""Generate TypeScript contract types from the exported JSON Schema.

The contract flows in one direction and only one direction::

    packages/contracts        Python, hand-written    <- the source of truth
            |  bench schema export
            v
    packages/schemas/v1       JSON Schema, generated  <- language-neutral
            |  this script
            v
    packages/contracts-ts     TypeScript, generated

Written in Python rather than Node deliberately. The generator belongs beside the
source of truth, and doing it here means the TypeScript workspace needs no codegen
dependency at all - its only dev dependency is the compiler.

The generated file is committed and drift-checked, so a change to a pydantic model
that is not regenerated fails the build rather than surfacing during POC-005
integration.

    python tools/generate_ts_contracts.py
    python tools/generate_ts_contracts.py --check
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HEADER = """// GENERATED FILE - DO NOT EDIT.
//
// Produced by tools/generate_ts_contracts.py from packages/schemas/v1/*.json,
// which are themselves generated from the pydantic models in packages/contracts.
//
// The Python models are the single source of truth. Editing this file by hand
// creates exactly the drift the generation step exists to prevent: the browser
// lab and the benchmark runner would silently disagree about a field name, and
// the disagreement would surface as a fake measurement discrepancy.
//
// Regenerate with:  python tools/generate_ts_contracts.py
// Verify with:      python tools/generate_ts_contracts.py --check
"""

# Schema roots worth exposing as named types. The rest arrive as $defs.
ROOTS = (
    "asset-manifest",
    "benchmark-run",
    "asset-result",
    "measurement",
    "normalized-failure",
    "operation",
    "processor-identity",
    "inspection-result",
    "estimate",
    "process-outcome",
    "benchmark-report",
    "licence-disposition",
)


def repo_root_from_here() -> Path:
    return Path(__file__).resolve().parents[1]


def schemas_dir(repo_root: Path) -> Path:
    return repo_root / "packages" / "schemas" / "v1"


def target_path(repo_root: Path) -> Path:
    return repo_root / "packages" / "contracts-ts" / "src" / "generated" / "contracts.ts"


def _quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _doc(node: dict[str, Any], indent: str) -> list[str]:
    """Carry the Python docstring across as a TSDoc comment."""
    description = node.get("description")
    if not description:
        return []
    lines = [line.rstrip() for line in str(description).strip().splitlines()]
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    out = [f"{indent}/**"]
    out.extend(f"{indent} * {line}" if line else f"{indent} *" for line in lines)
    out.append(f"{indent} */")
    return out


def _type_of(node: dict[str, Any]) -> str:
    """Render one JSON Schema node as a TypeScript type expression."""
    if "$ref" in node:
        return str(node["$ref"]).rsplit("/", 1)[-1]

    if "const" in node:
        value = node["const"]
        if isinstance(value, str):
            return _quote(value)
        if isinstance(value, bool):
            return "true" if value else "false"
        return json.dumps(value)

    if "enum" in node:
        return " | ".join(_quote(v) if isinstance(v, str) else json.dumps(v) for v in node["enum"])

    for key in ("anyOf", "oneOf"):
        if key in node:
            parts = [_type_of(option) for option in node[key]]
            # Collapse the pydantic `T | None` shape into `T | null`.
            unique = list(dict.fromkeys(parts))
            return " | ".join(unique)

    if "allOf" in node and len(node["allOf"]) == 1:
        return _type_of(node["allOf"][0])

    schema_type = node.get("type")

    if schema_type == "array":
        items = node.get("items")
        if isinstance(items, dict):
            inner = _type_of(items)
            return f"({inner})[]" if "|" in inner else f"{inner}[]"
        if isinstance(items, list):  # tuple form
            return "[" + ", ".join(_type_of(i) for i in items) + "]"
        return "unknown[]"

    if schema_type == "object":
        additional = node.get("additionalProperties")
        if isinstance(additional, dict):
            key_type = "string"
            names = node.get("propertyNames")
            if isinstance(names, dict) and ("enum" in names or "$ref" in names):
                key_type = _type_of(names)
            return f"Partial<Record<{key_type}, {_type_of(additional)}>>"
        if "properties" not in node:
            return "Record<string, unknown>"

    return {
        "string": "string",
        "integer": "number",
        "number": "number",
        "boolean": "boolean",
        "null": "null",
    }.get(str(schema_type), "unknown")


def _render_object(name: str, node: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    lines.extend(_doc(node, ""))
    lines.append(f"export interface {name} {{")

    required = set(node.get("required", []))
    for field, spec in node.get("properties", {}).items():
        lines.extend(_doc(spec, "  "))
        optional = "" if field in required else "?"
        lines.append(f"  {field}{optional}: {_type_of(spec)};")
    lines.append("}")
    return lines


def _render_enum(name: str, node: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    lines.extend(_doc(node, ""))
    values = " | ".join(_quote(str(v)) for v in node["enum"])
    lines.append(f"export type {name} = {values};")
    # A runtime array, so the browser lab can validate a value it received.
    members = ", ".join(_quote(str(v)) for v in node["enum"])
    lines.append(f"export const {name}Values: readonly {name}[] = [{members}] as const;")
    return lines


def _render(name: str, node: dict[str, Any]) -> list[str]:
    if "enum" in node and node.get("type") == "string":
        return _render_enum(name, node)
    if node.get("type") == "object" or "properties" in node:
        return _render_object(name, node)
    return [*_doc(node, ""), f"export type {name} = {_type_of(node)};"]


def generate(repo_root: Path) -> str:
    from ipw.contracts.version import SCHEMA_VERSION

    definitions: dict[str, dict[str, Any]] = {}
    roots: dict[str, dict[str, Any]] = {}

    for stem in ROOTS:
        path = schemas_dir(repo_root) / f"{stem}.schema.json"
        if not path.is_file():
            sys.stderr.write(f"missing schema: {path.name}\n")
            continue
        document = json.loads(path.read_text(encoding="utf-8"))
        for def_name, def_node in document.get("$defs", {}).items():
            definitions.setdefault(def_name, def_node)
        title = document.get("title") or stem.replace("-", " ").title().replace(" ", "")
        roots.setdefault(title, document)

    blocks: list[str] = [HEADER]

    # The contract version is emitted rather than hand-written on the TypeScript
    # side. It used to be a literal in ids.ts, which meant a Python version bump
    # left the browser lab silently on the old value - and since the version feeds
    # every identifier digest, the two languages would produce different ids for
    # identical documents while both looked correct. POC-006 hit exactly that.
    blocks.append(
        "// --------------------------------------------------------------- version --\n"
        "\n/** The contract version. Mirrors ipw.contracts.version.SCHEMA_VERSION. */\n"
        f'export const SCHEMA_VERSION = "{SCHEMA_VERSION}";\n'
    )

    blocks.append(
        "\n// ---------------------------------------------------------------- shared --\n"
    )
    for name in sorted(definitions):
        blocks.append("\n".join(_render(name, definitions[name])) + "\n")

    blocks.append(
        "\n// ----------------------------------------------------------- root types --\n"
    )
    for name in sorted(roots):
        if name in definitions:
            continue
        blocks.append("\n".join(_render(name, roots[name])) + "\n")

    return "\n".join(blocks)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate TypeScript contract types.")
    parser.add_argument("--check", action="store_true", help="verify without writing")
    parser.add_argument("--repo-root", type=Path, default=repo_root_from_here())
    args = parser.parse_args(argv)

    rendered = generate(args.repo_root)
    target = target_path(args.repo_root)

    if args.check:
        if not target.is_file():
            sys.stderr.write(f"generated contracts missing: {target}\n")
            return 1
        if target.read_text(encoding="utf-8") != rendered:
            sys.stderr.write(
                "TypeScript contracts are out of date with the JSON Schema.\n"
                "Run: python tools/generate_ts_contracts.py\n"
            )
            return 1
        types = rendered.count("export interface ") + rendered.count("export type ")
        sys.stdout.write(f"TypeScript contracts match the schema ({types} types)\n")
        return 0

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(rendered, encoding="utf-8", newline="\n")
    interfaces = rendered.count("export interface ")
    aliases = rendered.count("export type ")
    sys.stdout.write(
        f"wrote {target.relative_to(args.repo_root).as_posix()}: "
        f"{interfaces} interfaces, {aliases} type aliases\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
