"""Job handlers: the bridge between the queue and the processing engine.

The cases worth testing are the ones where a job should *not* be marked done -
a missing object, an operation nobody implements, a processor that refused the
file. The last one is the dangerous one, because the engine reports a refusal by
returning rather than raising, and a handler that does not look would record a
success with no output.
"""

from __future__ import annotations

from typing import Any

import pytest

from ipw.workspace_api.handlers import PROCESS_KIND, JobError, build_handlers, process_job
from ipw.workspace_api.jobs import Job


class FakeService:
    """Stands in for WorkspaceService with the two methods a handler uses."""

    def __init__(
        self,
        *,
        objects: dict[str, bytes] | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        self.objects = objects if objects is not None else {"uploads/a.jpg": b"bytes"}
        self.result = result if result is not None else _ok_result()
        self.process_calls: list[Any] = []
        self.always_store_flags: list[bool] = []

    def fetch_object(self, object_name: str) -> bytes:
        if object_name not in self.objects:
            msg = f"no uploaded file called {object_name!r} was found"
            raise ValueError(msg)
        return self.objects[object_name]

    def process(self, request: Any, *, always_store: bool = False) -> dict[str, Any]:
        self.process_calls.append(request)
        self.always_store_flags.append(always_store)
        return self.result


def _ok_result(**overrides: Any) -> dict[str, Any]:
    result = {
        "ok": True,
        "object": "results/out.jpg",
        "bytes": 2048,
        "sha256": "a" * 64,
        "media_type": "image/jpeg",
        "width": 100,
        "height": 50,
        "took_ms": 12,
        "processor": {"name": "standard-pillow"},
        "delivery": "stored",
    }
    result.update(overrides)
    return result


def _job(**payload: Any) -> Job:
    base: dict[str, Any] = {
        "operation": "resize",
        "object": "uploads/a.jpg",
        "filename": "a.jpg",
        "settings": {"width": 100},
    }
    base.update(payload)
    return Job(id=1, kind=PROCESS_KIND, payload=base, attempts=1, max_attempts=3)


class TestTheHappyPath:
    def test_it_returns_a_reference_not_a_file(self) -> None:
        """The summary goes into a jsonb column and is read back by a different
        process minutes later. A data URL there would be the file in Postgres."""
        summary = process_job(FakeService(), _job())

        assert summary["object"] == "results/out.jpg"
        assert summary["bytes"] == 2048
        assert "image" not in summary
        assert not any(isinstance(value, bytes) for value in summary.values())

    def test_it_forces_the_output_to_storage(self) -> None:
        """Without this the engine would inline anything under a megabyte, and
        the job row would carry base64 of the result."""
        service = FakeService()

        process_job(service, _job())

        assert service.always_store_flags == [True]

    def test_the_summary_records_where_the_work_came_from(self) -> None:
        """Answering 'what produced this file' should not need the job payload
        as well as its result."""
        summary = process_job(FakeService(), _job())

        assert summary["source_object"] == "uploads/a.jpg"
        assert summary["operation"] == "resize"

    def test_the_settings_reach_the_engine(self) -> None:
        service = FakeService()

        process_job(service, _job(settings={"width": 640}))

        assert service.process_calls[0].settings == {"width": 640}

    def test_a_missing_filename_does_not_stop_the_job(self) -> None:
        service = FakeService()

        process_job(service, _job(filename=None))

        assert service.process_calls[0].filename == "upload"


class TestWhenItShouldRefuse:
    def test_a_refused_file_is_a_failure_not_a_success(self) -> None:
        """The engine reports a refusal by *returning* ok: False, not by
        raising. An earlier version of the batch screen took that for success
        and put a file of random bytes in the archive (D-076)."""
        service = FakeService(
            result={
                "ok": False,
                "failure": {"code": "PROCESSOR.DECODE_FAILED", "message": "not an image"},
            }
        )

        with pytest.raises(JobError, match=r"PROCESSOR\.DECODE_FAILED: not an image"):
            process_job(service, _job())

    def test_a_refusal_with_no_message_still_fails_loudly(self) -> None:
        service = FakeService(result={"ok": False})

        with pytest.raises(JobError, match="without saying why"):
            process_job(service, _job())

    def test_a_missing_object_says_so_plainly(self) -> None:
        """Not a processing failure, and retrying will not fix it."""
        with pytest.raises(JobError, match="cannot start"):
            process_job(FakeService(), _job(object="uploads/gone.jpg"))

    def test_an_unknown_operation_lists_the_known_ones(self) -> None:
        with pytest.raises(JobError, match="is not an operation this service knows"):
            process_job(FakeService(), _job(operation="teleport"))

    @pytest.mark.parametrize("missing", ["operation", "object"])
    def test_an_incomplete_payload_is_refused(self, missing: str) -> None:
        with pytest.raises(JobError, match=f"has no {missing}"):
            process_job(FakeService(), _job(**{missing: ""}))

    def test_settings_that_are_not_an_object_are_refused(self) -> None:
        """A list here would reach the contract layer and fail somewhere less
        obvious."""
        with pytest.raises(JobError, match="settings must be an object"):
            process_job(FakeService(), _job(settings=[1, 2, 3]))

    def test_nothing_is_processed_when_the_payload_is_bad(self) -> None:
        service = FakeService()

        with pytest.raises(JobError):
            process_job(service, _job(operation=""))

        assert service.process_calls == []


class TestTheHandlerTable:
    def test_it_registers_the_process_kind(self) -> None:
        handlers = build_handlers(FakeService())

        assert set(handlers) == {PROCESS_KIND}

    def test_the_registered_handler_runs_the_job(self) -> None:
        service = FakeService()
        handler = build_handlers(service)[PROCESS_KIND]

        assert handler(_job())["object"] == "results/out.jpg"
