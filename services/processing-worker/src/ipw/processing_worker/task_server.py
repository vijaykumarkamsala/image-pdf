"""Authenticated HTTP task entrypoint for the durable intake worker."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol

from google.auth.transport.requests import Request
from google.oauth2 import id_token

from ipw.processing_worker.durable_intake import (
    DispatchMessage,
    DurableIntakeProcessor,
    WorkerOutcome,
)
from ipw.processing_worker.preview import DurablePreviewProcessor
from ipw.processing_worker.repository import PostgresWorkerRepository
from ipw.storage import GcsWorkerPrivateObjectStore

_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")


class TaskIdentityVerifier(Protocol):
    def verify(self, authorization: str | None) -> None: ...


class DurableJobProcessor(Protocol):
    def process(self, message: DispatchMessage) -> WorkerOutcome: ...


class DurableJobRouter:
    def __init__(
        self,
        repository: PostgresWorkerRepository,
        intake: DurableIntakeProcessor,
        preview: DurablePreviewProcessor,
    ) -> None:
        self._repository = repository
        self._intake = intake
        self._preview = preview

    def process(self, message: DispatchMessage) -> WorkerOutcome:
        kind = self._repository.job_kind(message.job_id)
        if kind == "file_intake_inspection":
            return self._intake.process(message)
        if kind == "preview_generation":
            return self._preview.process(message)
        raise LookupError("processing job kind is not supported")


class GoogleOidcTaskIdentityVerifier:
    def __init__(self, audience: str, service_account_email: str) -> None:
        if not audience.startswith("https://"):
            raise ValueError("worker OIDC audience must be HTTPS")
        if not service_account_email.endswith(".iam.gserviceaccount.com"):
            raise ValueError("worker task identity must be a service account")
        self._audience = audience
        self._service_account_email = service_account_email

    def verify(self, authorization: str | None) -> None:
        if not authorization or not authorization.startswith("Bearer "):
            raise PermissionError("task bearer identity is required")
        claims = id_token.verify_oauth2_token(
            authorization.removeprefix("Bearer ").strip(),
            Request(),
            audience=self._audience,
        )
        if (
            claims.get("email") != self._service_account_email
            or claims.get("email_verified") is not True
        ):
            raise PermissionError("task service account identity is not authorised")
        if claims.get("iss") not in {"https://accounts.google.com", "accounts.google.com"}:
            raise PermissionError("task token issuer is not authorised")


@dataclass(frozen=True)
class TaskResponse:
    status: int
    body: dict[str, str]


class IntakeTaskApplication:
    def __init__(self, verifier: TaskIdentityVerifier, processor: DurableJobProcessor) -> None:
        self._verifier = verifier
        self._processor = processor

    def handle(self, headers: Mapping[str, str], body: bytes) -> TaskResponse:
        try:
            self._verifier.verify(headers.get("authorization"))
        except PermissionError:
            return TaskResponse(401, {"state": "unauthorised"})
        if not headers.get("x-cloudtasks-taskname"):
            return TaskResponse(401, {"state": "task-header-required"})
        if len(body) > 16 * 1024:
            return TaskResponse(413, {"state": "payload-too-large"})
        try:
            value = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return TaskResponse(400, {"state": "invalid-json"})
        if not isinstance(value, dict) or set(value) != {"dispatchId", "jobId", "traceId", "kind"}:
            return TaskResponse(400, {"state": "invalid-envelope"})
        if value.get("kind") != "process_job" or not all(
            isinstance(value.get(key), str) and _ID.fullmatch(value[key])
            for key in ("dispatchId", "jobId", "traceId")
        ):
            return TaskResponse(400, {"state": "invalid-envelope"})
        outcome = self._processor.process(
            DispatchMessage(value["dispatchId"], value["jobId"], value["traceId"])
        )
        if outcome.state == "busy":
            return TaskResponse(409, {"state": "busy", "job_id": outcome.job_id})
        return TaskResponse(200, {"state": outcome.state, "job_id": outcome.job_id})


def build_production_application(env: Mapping[str, str]) -> IntakeTaskApplication:
    required = (
        "IPW_DATABASE_URL",
        "IPW_GCS_BUCKET",
        "IPW_WORKER_OIDC_AUDIENCE",
        "IPW_CLOUD_TASKS_SERVICE_ACCOUNT",
    )
    missing = [name for name in required if not env.get(name)]
    if missing:
        raise RuntimeError("missing production worker configuration: " + ", ".join(missing))
    # Imported here so a production process cannot start until the configured scanner exists.
    from ipw.inspection import production_malware_scanner

    repository = PostgresWorkerRepository.connect(env["IPW_DATABASE_URL"])
    objects = GcsWorkerPrivateObjectStore(env["IPW_GCS_BUCKET"])
    intake = DurableIntakeProcessor(
        repository,
        objects,
        production_malware_scanner(env),
        worker_id=env.get("HOSTNAME", "processing-worker"),
    )
    preview = DurablePreviewProcessor(
        repository,
        objects,
        worker_id=env.get("HOSTNAME", "processing-worker"),
    )
    processor = DurableJobRouter(repository, intake, preview)
    verifier = GoogleOidcTaskIdentityVerifier(
        env["IPW_WORKER_OIDC_AUDIENCE"],
        env["IPW_CLOUD_TASKS_SERVICE_ACCOUNT"],
    )
    return IntakeTaskApplication(verifier, processor)


def main() -> None:
    application = build_production_application(os.environ)
    port = int(os.environ.get("PORT", "8080"))

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/internal/tasks/process-job":
                self.send_error(404)
                return
            size = int(self.headers.get("content-length", "0"))
            payload = self.rfile.read(min(size, 16 * 1024 + 1))
            response = application.handle(
                {key.lower(): value for key, value in self.headers.items()},
                payload,
            )
            encoded = json.dumps(response.body, separators=(",", ":")).encode()
            self.send_response(response.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
