"""Connecting to Postgres, and bringing its schema up to date.

**Why this is here rather than Alembic.** Alembic brings SQLAlchemy, and
SQLAlchemy brings an ORM this codebase does not use and a migration format that
is Python pretending to be SQL. What the project actually needs is: run these
files, in this order, once each, and never twice. That is small enough to read
in one sitting, and a migration runner nobody can read is one nobody dares
touch when a deploy is half-applied at two in the morning.

**Three things a naive runner gets wrong, and this one does not.**

*Two instances starting at once.* Cloud Run runs several containers, and they
boot together after a deploy. Without coordination both see the same pending
migration and both run it; the loser gets "relation already exists" and the
container crash-loops. A session-level advisory lock makes the second one wait
and then find nothing to do, which is the correct outcome and needs no retry
logic anywhere else.

*An already-applied file being edited.* Fixing a typo in 0001 after it has run
everywhere means the database and the repository disagree, silently, forever.
Each applied migration's digest is recorded and re-checked, so the edit is
refused at the next boot with the file named.

*A migration arriving out of order.* Two branches both add 0007; whichever
merges second is applied after a higher number has already run, and the schema
now depends on merge order. Refused, by number.

**What it deliberately does not do.** There is no down-migration. A rollback of
a schema change on a live database is not a script, it is an incident with a
human in it, and generating one automatically mostly produces a file that has
never been executed and will not work when it matters. Roll forward.
"""

from __future__ import annotations

import contextlib
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote, urlparse

__all__ = [
    "ConnectionParams",
    "Migration",
    "MigrationError",
    "connect",
    "discover_migrations",
    "migrate",
    "migrations_directory",
    "parse_database_url",
    "pending_migrations",
]

# A fixed key for the advisory lock. Any constant works so long as every
# instance uses the same one; it is derived from a name rather than typed as a
# magic number so it is obvious what it belongs to and cannot silently collide
# with another lock someone adds later.
ADVISORY_LOCK_KEY = int.from_bytes(
    hashlib.sha256(b"ipw.workspace_api.schema").digest()[:8], "big", signed=True
)

# 0001_initial.sql -> (1, "initial")
_FILENAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

_MIGRATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     integer     PRIMARY KEY,
    name        text        NOT NULL,
    sha256      char(64)    NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
)
"""


class MigrationError(RuntimeError):
    """The schema cannot be brought up to date, and starting anyway is worse."""


@dataclass(frozen=True)
class Migration:
    """One numbered file, with the digest that proves it has not changed."""

    version: int
    name: str
    sql: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.sql.encode("utf-8")).hexdigest()

    @property
    def filename(self) -> str:
        return f"{self.version:04d}_{self.name}.sql"


@dataclass(frozen=True)
class ConnectionParams:
    """What pg8000 needs, separated from the URL so it can be tested.

    ``unix_sock`` rather than ``host`` is how Cloud SQL is reached from Cloud
    Run: the socket is mounted at /cloudsql/PROJECT:REGION:INSTANCE, and there
    is no TCP host to connect to at all.
    """

    user: str
    password: str
    database: str
    host: str | None = None
    port: int = 5432
    unix_sock: str | None = None

    def as_kwargs(self) -> dict[str, Any]:
        common: dict[str, Any] = {
            "user": self.user,
            "password": self.password,
            "database": self.database,
        }
        if self.unix_sock:
            return {**common, "unix_sock": self.unix_sock}
        return {**common, "host": self.host, "port": self.port}


class _Cursor(Protocol):
    def execute(self, operation: str, args: Any = ...) -> Any: ...
    def fetchall(self) -> list[Any]: ...
    def close(self) -> None: ...


class _Connection(Protocol):
    def cursor(self) -> _Cursor: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...


def migrations_directory() -> Path:
    """Where the .sql files live, resolved against this module.

    Not against the working directory: the container starts wherever Cloud Run
    starts it, and a relative path would mean the schema applies on a developer
    machine and not in production.
    """
    return Path(__file__).parent / "migrations"


def parse_database_url(url: str) -> ConnectionParams:
    """Turn a postgresql:// URL into pg8000 arguments.

    pg8000 takes keyword arguments rather than a URL, which is a small mercy:
    it means the parsing is visible here instead of inside a driver, and the
    Cloud SQL socket case can be handled explicitly rather than by hoping the
    driver guesses.

    Percent-decoding matters and is easy to miss. Passwords generated by Cloud
    SQL routinely contain '@', '/' and '+', which must be escaped in a URL; a
    runner that skips the decode authenticates with the wrong password and
    reports it as a credentials problem.
    """
    if not url.strip():
        msg = "no database URL was given"
        raise MigrationError(msg)

    parsed = urlparse(url)
    if parsed.scheme not in ("postgresql", "postgres"):
        msg = f"database URL must start with postgresql://, got {parsed.scheme!r}://"
        raise MigrationError(msg)

    database = unquote(parsed.path).lstrip("/")
    if not database:
        msg = "database URL has no database name"
        raise MigrationError(msg)

    user = unquote(parsed.username or "")
    password = unquote(parsed.password or "")

    # Cloud SQL: ?host=/cloudsql/project:region:instance, with no TCP host.
    socket_path = ""
    if parsed.query:
        for pair in parsed.query.split("&"):
            key, _, value = pair.partition("=")
            if key in ("host", "unix_sock") and value.startswith("%2F"):
                socket_path = unquote(value)
            elif key in ("host", "unix_sock") and value.startswith("/"):
                socket_path = value
    if socket_path:
        # pg8000 wants the socket file, not the directory Postgres conventions
        # name it by. Appending it here keeps the URL in the same form libpq and
        # every other tool accepts.
        if not socket_path.endswith(".s.PGSQL.5432"):
            socket_path = f"{socket_path.rstrip('/')}/.s.PGSQL.5432"
        return ConnectionParams(
            user=user, password=password, database=database, unix_sock=socket_path
        )

    return ConnectionParams(
        user=user,
        password=password,
        database=database,
        host=parsed.hostname or "localhost",
        port=parsed.port or 5432,
    )


def discover_migrations(directory: Path | None = None) -> tuple[Migration, ...]:
    """Read the numbered files, in order, refusing anything ambiguous.

    A file that does not match the naming pattern is an error rather than
    something to skip. A skipped file is a migration somebody believes has run.
    """
    directory = directory or migrations_directory()
    if not directory.is_dir():
        msg = f"no migrations directory at {directory}"
        raise MigrationError(msg)

    found: dict[int, Migration] = {}
    for path in sorted(directory.iterdir()):
        if path.name.startswith(".") or not path.is_file():
            continue
        match = _FILENAME.match(path.name)
        if not match:
            msg = (
                f"{path.name} is not a migration name. Expected NNNN_lower_snake.sql, "
                f"for example 0002_add_sharing.sql. Refusing to guess whether it "
                f"should have run."
            )
            raise MigrationError(msg)

        version, name = int(match.group(1)), match.group(2)
        if version in found:
            msg = (
                f"two migrations are numbered {version:04d}: {found[version].filename} "
                f"and {path.name}. Renumber one - applying them in filesystem order "
                f"would make the schema depend on which branch merged first."
            )
            raise MigrationError(msg)

        # Newline-normalised before hashing, so a file checked out with CRLF on
        # Windows and LF on the Linux runner is the same migration. Without this
        # the digest check fires on every deploy from a different platform.
        sql = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        found[version] = Migration(version=version, name=name, sql=sql)

    return tuple(found[version] for version in sorted(found))


def pending_migrations(
    applied: dict[int, str], available: tuple[Migration, ...]
) -> tuple[Migration, ...]:
    """Which migrations still need to run, having checked the ones that ran.

    ``applied`` maps version to the digest recorded when it was applied. Pure,
    so the interesting failures can be tested without a database.
    """
    pending = []
    highest_applied = max(applied, default=0)

    for migration in available:
        recorded = applied.get(migration.version)
        if recorded is None:
            if migration.version < highest_applied:
                msg = (
                    f"{migration.filename} has never been applied, but migration "
                    f"{highest_applied:04d} already has. Applying it now would build "
                    f"the schema in an order no other environment used. Renumber it "
                    f"above {highest_applied:04d}."
                )
                raise MigrationError(msg)
            pending.append(migration)
        elif recorded != migration.sha256:
            msg = (
                f"{migration.filename} has changed since it was applied "
                f"(recorded {recorded[:12]}..., file is {migration.sha256[:12]}...). "
                f"An applied migration is history and cannot be edited; add a new "
                f"migration that makes the change instead."
            )
            raise MigrationError(msg)

    return tuple(pending)


def migrate(connection: _Connection, directory: Path | None = None) -> tuple[str, ...]:
    """Bring the schema up to date. Returns the filenames actually applied.

    Every migration runs in its own transaction together with the row recording
    it, so a failure half way leaves the schema at the last complete migration
    rather than somewhere between two. Postgres does DDL transactionally, which
    is the reason this can be true at all.
    """
    available = discover_migrations(directory)
    cursor = connection.cursor()
    applied_now: list[str] = []
    try:
        cursor.execute(_MIGRATIONS_TABLE)
        connection.commit()

        # Held until the connection closes. Any other instance booting at the
        # same time blocks here, then finds nothing pending.
        cursor.execute("SELECT pg_advisory_lock(%s)", (ADVISORY_LOCK_KEY,))
        connection.commit()

        cursor.execute("SELECT version, sha256 FROM schema_migrations")
        applied = {int(row[0]): str(row[1]) for row in cursor.fetchall()}

        for migration in pending_migrations(applied, available):
            try:
                # **Passed with no parameters, and that is load-bearing.**
                #
                # pg8000 sends a statement over the simple query protocol only
                # when there are no arguments to bind; with arguments it uses the
                # extended protocol, which accepts exactly one statement per
                # call. A migration file is many statements, so binding anything
                # here - even something harmless-looking - would break every
                # multi-statement migration with a syntax error at the first
                # semicolon. Migrations are files, not templates: if one ever
                # needs a value, it belongs in the SQL as a literal.
                cursor.execute(migration.sql)
                cursor.execute(
                    "INSERT INTO schema_migrations (version, name, sha256) VALUES (%s, %s, %s)",
                    (migration.version, migration.name, migration.sha256),
                )
                connection.commit()
            except Exception as exc:
                connection.rollback()
                msg = f"{migration.filename} failed and was rolled back: {exc}"
                raise MigrationError(msg) from exc
            applied_now.append(migration.filename)
    finally:
        # Releasing is best-effort on purpose. An advisory lock is held by the
        # session, so a connection that has already failed has released it
        # anyway; raising here would replace the real error - the migration that
        # failed - with a secondary one about unlocking, which is the less useful
        # of the two.
        with contextlib.suppress(Exception):
            cursor.execute("SELECT pg_advisory_unlock(%s)", (ADVISORY_LOCK_KEY,))
            connection.commit()
        cursor.close()

    return tuple(applied_now)


def connect(database_url: str) -> Any:
    """Open a connection, importing the driver only when one is actually wanted.

    The import is deferred so that every test which does not touch a database -
    which is nearly all of them - does not pay for it, and so a deployment
    without a database configured fails when it tries to connect rather than at
    import time, with a message about the database rather than about a module.
    """
    import pg8000.dbapi

    params = parse_database_url(database_url)
    return pg8000.dbapi.connect(**params.as_kwargs())
