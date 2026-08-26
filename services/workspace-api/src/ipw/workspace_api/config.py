"""Where the service reads its settings, and the one thing it refuses to assume.

**One image, three deployments.** Everything here comes from the environment, so
dev, staging and production run the byte-identical container and differ only in
what is passed to it. Building a separate image per environment means staging
tests something production will never run, which is how "it worked in staging"
happens.

**Binding off localhost is an explicit act.** The interface has no
authentication - that is not an oversight, it is where the build has reached -
so a service reachable from the internet is an image processor anybody can use
at your expense. The default stays loopback, and opening it requires saying so
out loud in the environment *and* naming the environment it is for.

Cloud Run makes this unavoidable: its proxy connects from outside the
container's loopback, so a container that binds 127.0.0.1 accepts nothing and
looks like a broken deploy. That is exactly the moment somebody reaches for
`0.0.0.0` without thinking about who else can reach it, which is why the flag
below exists and why it logs what it is doing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

__all__ = ["ENVIRONMENTS", "Settings", "load_settings"]

ENVIRONMENTS = ("local", "dev", "staging", "production")

LOOPBACK = ("127.0.0.1", "::1", "localhost")


@dataclass(frozen=True)
class Settings:
    """Everything the service needs to know about where it is running."""

    environment: str = "local"
    host: str = "127.0.0.1"
    port: int = 8770

    bucket: str = ""
    """The environment's own GCS bucket. Each environment has its own, so a
    staging run can never write into production's objects."""

    database_url: str = ""
    """Postgres connection string, from Secret Manager rather than the image."""

    public_bind_acknowledged: bool = False
    """Set by IPW_ALLOW_PUBLIC_BIND. Required before binding off loopback."""

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def binds_publicly(self) -> bool:
        return self.host not in LOOPBACK

    def warnings(self) -> list[str]:
        """Everything about this configuration that somebody should know.

        Returned rather than logged so a health endpoint can show the same list
        the startup banner prints - a deployment that is wrong should be visible
        from outside, not only in a log nobody opened.
        """
        notes: list[str] = []

        if self.binds_publicly:
            notes.append(
                "This service is reachable beyond localhost and has NO AUTHENTICATION. "
                "Anyone who can reach it can run image and document processing at your "
                "expense. Keep it behind Cloud Run IAM (deploy with "
                "--no-allow-unauthenticated) until sign-in exists."
            )
        if self.is_production and not self.database_url:
            notes.append("Production has no database configured; nothing will persist.")
        if self.is_production and not self.bucket:
            notes.append(
                "Production has no bucket configured; uploads and results have nowhere to live."
            )
        if self.environment not in ENVIRONMENTS:
            notes.append(
                f"Unknown environment {self.environment!r}; expected one of {list(ENVIRONMENTS)}."
            )
        return notes


def load_settings(source: dict[str, str] | None = None) -> Settings:
    """Read the settings from the environment.

    `PORT` is read without a prefix because Cloud Run sets exactly that name and
    will not be told otherwise. Everything else is prefixed, so a variable meant
    for this service cannot be set by accident.
    """
    env = source if source is not None else dict(os.environ)

    host = env.get("IPW_HOST", "127.0.0.1").strip() or "127.0.0.1"
    acknowledged = _truthy(env.get("IPW_ALLOW_PUBLIC_BIND", ""))

    if host not in LOOPBACK and not acknowledged:
        msg = (
            f"refusing to bind {host!r}: this service has no authentication, so binding "
            "beyond localhost exposes it to anyone who can reach it. Set "
            "IPW_ALLOW_PUBLIC_BIND=1 to say that is intended - and on Cloud Run, deploy "
            "with --no-allow-unauthenticated until sign-in exists."
        )
        raise ValueError(msg)

    return Settings(
        environment=env.get("IPW_ENV", "local").strip().lower() or "local",
        host=host,
        port=_port(env),
        bucket=env.get("IPW_BUCKET", "").strip(),
        database_url=env.get("IPW_DATABASE_URL", "").strip(),
        public_bind_acknowledged=acknowledged,
    )


def _port(env: dict[str, str]) -> int:
    """The port to listen on: Cloud Run's PORT, else ours, else the default."""
    for name in ("PORT", "IPW_PORT"):
        raw = env.get(name, "").strip()
        if not raw:
            continue
        try:
            value = int(raw)
        except ValueError:
            msg = f"{name}={raw!r} is not a port number"
            raise ValueError(msg) from None
        if not 1 <= value <= 65535:
            msg = f"{name}={value} is not a usable port"
            raise ValueError(msg)
        return value
    return 8770


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")
