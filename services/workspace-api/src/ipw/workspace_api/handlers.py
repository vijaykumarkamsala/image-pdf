"""What a worker actually does with a job.

These are the bridge between the queue and the processing engine: a job payload
names an uploaded object and an operation, a handler fetches the bytes, runs the
work, and returns a summary. Deliberately thin - all the real behaviour lives in
`WorkspaceService`, which the synchronous routes use too, so a file processed
through the queue and the same file processed through `/api/process` go down the
same path and cannot drift.

**A result is a reference, never a payload.** Handlers pass ``always_store=True``
so the output is written to Cloud Storage and the job records its object name.
The alternative - a base64 data URL in the job row - would put the file in
Postgres, which the schema refuses (D-079), and would be useless to anyone
holding the job id rather than the row.

**Failure is checked, not assumed.** `WorkspaceService.process` reports a refused
file by *returning* ``{"ok": False}``, not by raising. An earlier version of the
batch screen took that for success and put a file of random bytes in the archive
(D-076). A handler that does not check `ok` would mark a job succeeded with no
output at all, which is the same bug with a longer delay before anyone notices.
"""

from __future__ import annotations

from typing import Any, Protocol

from ipw.contracts.operation import OperationKind
from ipw.workspace_api.jobs import Job
from ipw.workspace_api.server import ProcessRequest

__all__ = ["PROCESS_KIND", "JobError", "build_handlers", "process_job"]

# The single job kind this module handles. One kind carrying the operation in
# its payload, rather than a kind per operation, because a worker's kind list is
# about *capability* - can this deployment run image work at all - and every one
# of these needs exactly the same things installed.
PROCESS_KIND = "process"


class Engine(Protocol):
    """The part of WorkspaceService a handler needs.

    Narrow on purpose. A handler fetches an object and runs an operation; it
    has no business with the twenty other methods the service exposes, and
    saying so here is what lets a test supply a stand-in without pretending
    it is the whole service.
    """

    def fetch_object(self, object_name: str) -> bytes: ...

    def process(self, request: ProcessRequest, *, always_store: bool = False) -> dict[str, Any]: ...


class JobError(RuntimeError):
    """The job cannot be completed. Carries the reason the queue should record."""


def process_job(service: Engine, job: Job) -> dict[str, Any]:
    """Run one operation against one uploaded object.

    Expects a payload of::

        {"operation": "resize", "object": "uploads/…", "filename": "scan.jpg",
         "settings": {...}}

    ``object`` rather than inline bytes: a job row is not where a 40 MB scan
    belongs, and the upload is already in the bucket by the time anything is
    queued.
    """
    payload = job.payload
    operation = str(payload.get("operation", "")).strip()
    object_name = str(payload.get("object", "")).strip()

    if not operation:
        msg = "the job payload has no operation"
        raise JobError(msg)
    if not object_name:
        msg = "the job payload has no object to work on"
        raise JobError(msg)

    try:
        kind = OperationKind(operation)
    except ValueError as exc:
        known = ", ".join(sorted(k.value for k in OperationKind))
        msg = f"{operation!r} is not an operation this service knows. Known kinds: {known}"
        raise JobError(msg) from exc

    try:
        data = service.fetch_object(object_name)
    except ValueError as exc:
        # The upload expired, or was never there. Worth its own message: it is
        # not a processing failure and retrying will not fix it.
        msg = f"cannot start: {exc}"
        raise JobError(msg) from exc

    filename = str(payload.get("filename") or "upload")
    settings = payload.get("settings") or {}
    if not isinstance(settings, dict):
        msg = f"settings must be an object, got {type(settings).__name__}"
        raise JobError(msg)

    result = service.process(
        ProcessRequest(kind=kind, settings=settings, image_bytes=data, filename=filename),
        always_store=True,
    )

    if not result.get("ok"):
        failure = result.get("failure") or {}
        msg = failure.get("message") or "processing failed without saying why"
        code = failure.get("code")
        raise JobError(f"{code}: {msg}" if code else msg)

    # A summary, not the file. Everything here is small, and `object` is what
    # makes the output retrievable once the worker that made it is gone.
    return {
        "object": result.get("object"),
        "bytes": result.get("bytes"),
        "sha256": result.get("sha256"),
        "media_type": result.get("media_type"),
        "width": result.get("width"),
        "height": result.get("height"),
        "operation": operation,
        "source_object": object_name,
        "took_ms": result.get("took_ms"),
        "processor": result.get("processor"),
    }


def build_handlers(service: Engine) -> dict[str, Any]:
    """The handler table a worker is constructed with.

    A function rather than a module-level dict because a handler needs the
    service, and a service needs its configuration - which is not known at
    import time and differs between a test and a container.
    """
    return {PROCESS_KIND: lambda job: process_job(service, job)}
