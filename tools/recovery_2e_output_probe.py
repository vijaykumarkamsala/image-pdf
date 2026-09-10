"""Inspect registered Recovery 2E derivative bytes and PostgreSQL evidence."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
from typing import Any, cast
from urllib.parse import unquote, urlparse

import pg8000.dbapi
from PIL import Image

from ipw.inspection import inspect_bytes
from ipw.storage import LocalWorkerPrivateObjectStore, ObjectZone, PrivateObjectRef


def connect(database_url: str) -> Any:
    parsed = urlparse(database_url)
    return pg8000.dbapi.connect(
        user=unquote(parsed.username or ""),
        password=unquote(parsed.password or ""),
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=unquote(parsed.path.lstrip("/")),
        timeout=30,
    )


def inspect_output(
    connection: Any,
    objects: LocalWorkerPrivateObjectStore,
    workspace_id: str,
    output_id: str,
) -> dict[str, Any]:
    cursor = connection.cursor()
    try:
        cursor.execute(
            """SELECT output.filename,output.state,output.sha256,output.byte_size,
                      output.width,output.height,output.media_type,
                      output.metadata_verified,output.metadata_evidence,
                      object.object_key,object.storage_generation,object.sha256,
                      object.byte_size,provenance.output_sha256,
                      provenance.metadata_verified,provenance.metadata_evidence,
                      provenance.source_version_ids,request.state,
                      NOT EXISTS(
                        SELECT 1 FROM usage_events usage
                        WHERE usage.workspace_id=request.workspace_id
                          AND (usage.customer_amount <> 0 OR usage.credit_debit <> 0)
                      ) AS zero_charge
               FROM image_export_outputs output
               JOIN image_export_requests request
                 ON request.export_request_id=output.export_request_id
               JOIN object_references object
                 ON object.object_reference_id=output.object_reference_id
                AND object.workspace_id=request.workspace_id
               JOIN export_provenance provenance ON provenance.output_id=output.output_id
               WHERE request.workspace_id=%s AND output.output_id=%s""",
            (workspace_id, output_id),
        )
        row = cursor.fetchone()
        if row is None:
            raise RuntimeError(f"registered output evidence is missing: {output_id}")
        (
            filename,
            output_state,
            output_sha256,
            output_size,
            output_width,
            output_height,
            media_type,
            metadata_verified,
            metadata_evidence,
            object_key,
            generation,
            object_sha256,
            object_size,
            provenance_sha256,
            provenance_metadata_verified,
            provenance_metadata_evidence,
            source_version_ids,
            request_state,
            zero_charge,
        ) = row
        if output_state != "succeeded" or request_state not in {"completed", "partially_completed"}:
            raise RuntimeError(f"output is not deliverable: {output_id}")
        snapshot = objects.read(
            PrivateObjectRef(str(workspace_id), str(object_key), ObjectZone.DERIVATIVE),
            generation=str(generation),
            max_bytes=128 * 1024 * 1024,
        )
        digest = hashlib.sha256(snapshot.data).hexdigest()
        if not (digest == str(output_sha256) == str(object_sha256) == str(provenance_sha256)):
            raise RuntimeError(f"checksum evidence disagrees for output: {output_id}")
        if len(snapshot.data) != int(output_size) or len(snapshot.data) != int(object_size):
            raise RuntimeError(f"byte-count evidence disagrees for output: {output_id}")
        inspection = inspect_bytes(
            snapshot.data,
            display_name=str(filename),
            expected_media_type=str(media_type),
        )
        if not inspection.accepted or inspection.facts is None:
            raise RuntimeError(f"completed output did not pass byte inspection: {output_id}")
        facts = inspection.facts
        if facts.width != int(output_width) or facts.height != int(output_height):
            raise RuntimeError(f"decoded dimensions disagree for output: {output_id}")
        evidence = cast(dict[str, str], metadata_evidence)
        retained_categories = {
            category
            for category in facts.sensitive_metadata
            if category
            in {
                "exif",
                "gps",
                "xmp",
                "iptc",
                "comments",
                "maker_notes",
                "software_device",
                "embedded_thumbnails",
            }
        }
        unexplained = {
            category
            for category in retained_categories
            if evidence.get(category) != "preserved-approved-fields"
        }
        if unexplained or facts.orientation is not None:
            raise RuntimeError(
                f"completed output metadata disagrees with evidence: {output_id}: "
                f"{sorted(unexplained)}"
            )
        with Image.open(io.BytesIO(snapshot.data)) as opened:
            opened.load()
            rgb = opened.convert("RGB")
            extrema = cast(
                tuple[tuple[int, int], tuple[int, int], tuple[int, int]],
                rgb.getextrema(),
            )
            icc = opened.info.get("icc_profile")
            return {
                "output_id": output_id,
                "filename": str(filename),
                "state": str(output_state),
                "request_state": str(request_state),
                "zero_charge": bool(zero_charge),
                "format": str(opened.format),
                "mode": str(opened.mode),
                "width": opened.width,
                "height": opened.height,
                "sha256": digest,
                "byte_size": len(snapshot.data),
                "storage_generation": str(generation),
                "generation_verified": snapshot.generation == str(generation),
                "pixel_extrema": [list(item) for item in extrema],
                "has_non_uniform_pixels": any(low != high for low, high in extrema),
                "has_icc_profile": bool(icc),
                "icc_sha256": hashlib.sha256(bytes(icc)).hexdigest() if icc else None,
                "orientation": facts.orientation,
                "sensitive_metadata": sorted(facts.sensitive_metadata),
                "metadata_verified": bool(metadata_verified),
                "provenance_metadata_verified": bool(provenance_metadata_verified),
                "metadata_evidence": metadata_evidence,
                "metadata_evidence_matches_provenance": (
                    metadata_evidence == provenance_metadata_evidence
                ),
                "source_version_ids": source_version_ids,
            }
    finally:
        cursor.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace_id")
    parser.add_argument("output_ids", nargs="+")
    args = parser.parse_args()
    database_url = os.environ.get("IPW_TEST_DATABASE_URL")
    storage_root = os.environ.get("IPW_LOCAL_STORAGE_ROOT")
    if not database_url or not storage_root:
        raise RuntimeError("IPW_TEST_DATABASE_URL and IPW_LOCAL_STORAGE_ROOT are required")
    connection = connect(database_url)
    try:
        objects = LocalWorkerPrivateObjectStore(Path(storage_root))
        print(
            json.dumps(
                [
                    inspect_output(connection, objects, args.workspace_id, output_id)
                    for output_id in args.output_ids
                ],
                sort_keys=True,
            )
        )
    finally:
        connection.close()


if __name__ == "__main__":
    main()
