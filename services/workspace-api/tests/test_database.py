"""The migration runner, and the rules the schema itself has to keep.

None of this needs a Postgres. The runner was written with the I/O in one thin
function and the decisions in pure ones, precisely so the interesting failures -
an edited migration, a renumbered one, a half-applied deploy - can be tested
here rather than discovered on a staging database at the wrong moment.

The one thing these tests cannot check is that the SQL is valid Postgres. That
is what running the migration against a real database does, and it is why
migrations go dev, then staging, then production, in that order.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from ipw.workspace_api.database import (
    ADVISORY_LOCK_KEY,
    ConnectionParams,
    Migration,
    MigrationError,
    discover_migrations,
    migrate,
    migrations_directory,
    parse_database_url,
    pending_migrations,
)


class FakeCursor:
    """Records what was executed, and answers the one query the runner makes."""

    def __init__(self, connection: FakeConnection) -> None:
        self._connection = connection
        self._rows: list[tuple[Any, ...]] = []

    def execute(self, operation: str, args: Any = None) -> None:
        self._connection.statements.append((operation, args))
        if operation in self._connection.fail_on:
            msg = self._connection.fail_on[operation]
            raise RuntimeError(msg)
        if "FROM schema_migrations" in operation:
            self._rows = list(self._connection.applied_rows)

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows

    def close(self) -> None:
        self._connection.cursor_closed = True


class FakeConnection:
    def __init__(self, applied_rows: list[tuple[int, str]] | None = None) -> None:
        self.applied_rows = applied_rows or []
        self.statements: list[tuple[str, Any]] = []
        self.commits = 0
        self.rollbacks = 0
        self.cursor_closed = False
        self.closed = False
        self.fail_on: dict[str, str] = {}

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def close(self) -> None:
        self.closed = True

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def executed(self) -> list[str]:
        return [sql for sql, _ in self.statements]


def _migration_dir(tmp_path: Path, **files: str) -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    for name, body in files.items():
        # test kwargs cannot contain dots, so 0001_initial_sql -> 0001_initial.sql
        # newline="" so a body written with CRLF stays CRLF rather than being
        # translated again by text mode - the line-ending test depends on it.
        (tmp_path / name.replace("_sql", ".sql")).write_text(body, encoding="utf-8", newline="")
    return tmp_path


class TestParsingTheUrl:
    def test_a_plain_tcp_url(self) -> None:
        params = parse_database_url("postgresql://alice:secret@db.internal:5433/workspace")

        assert params == ConnectionParams(
            user="alice",
            password="secret",  # noqa: S106 - a fixture, not a credential
            database="workspace",
            host="db.internal",
            port=5433,
        )

    def test_the_port_defaults_when_absent(self) -> None:
        assert parse_database_url("postgresql://a:b@host/db").port == 5432

    def test_a_percent_encoded_password_is_decoded(self) -> None:
        """Cloud SQL generates passwords containing @, / and +.

        Those must be escaped in a URL. A runner that forgets to decode
        authenticates with the literal '%40' and reports a credentials problem,
        which sends whoever is on call to reset a password that was correct.
        """
        params = parse_database_url("postgresql://user:p%40ss%2Fword@host/db")

        assert params.password == "p@ss/word"  # noqa: S105 - a fixture

    def test_a_cloud_sql_socket_url_has_no_host(self) -> None:
        """How Cloud Run reaches Cloud SQL: a mounted socket, no TCP at all."""
        params = parse_database_url("postgresql://u:p@/db?host=/cloudsql/proj:eu-west1:main")

        assert params.unix_sock == "/cloudsql/proj:eu-west1:main/.s.PGSQL.5432"
        assert "host" not in params.as_kwargs()
        assert "port" not in params.as_kwargs()

    def test_a_percent_encoded_socket_path_is_also_accepted(self) -> None:
        params = parse_database_url("postgresql://u:p@/db?host=%2Fcloudsql%2Fproj:eu:main")

        assert params.unix_sock == "/cloudsql/proj:eu:main/.s.PGSQL.5432"

    def test_a_socket_path_is_not_doubled_if_already_complete(self) -> None:
        url = "postgresql://u:p@/db?host=/cloudsql/proj:eu:main/.s.PGSQL.5432"

        assert parse_database_url(url).unix_sock == "/cloudsql/proj:eu:main/.s.PGSQL.5432"

    @pytest.mark.parametrize(
        ("url", "expected"),
        [
            ("", "no database URL"),
            ("   ", "no database URL"),
            ("mysql://u:p@host/db", "must start with postgresql"),
            ("postgresql://u:p@host/", "no database name"),
            ("postgresql://u:p@host", "no database name"),
        ],
    )
    def test_an_unusable_url_is_refused_with_the_reason(self, url: str, expected: str) -> None:
        with pytest.raises(MigrationError, match=expected):
            parse_database_url(url)


class TestDiscovery:
    def test_the_real_migrations_load(self) -> None:
        found = discover_migrations()

        assert found, "the shipped migrations directory is empty"
        assert found[0].version == 1
        assert [m.version for m in found] == sorted(m.version for m in found)

    def test_files_are_returned_in_numeric_order_not_filesystem_order(self, tmp_path: Path) -> None:
        """Sorting by name works until there are ten of them, then it does not."""
        directory = _migration_dir(
            tmp_path,
            **{
                "0010_tenth_sql": "SELECT 10;",
                "0002_second_sql": "SELECT 2;",
                "0001_first_sql": "SELECT 1;",
            },
        )

        assert [m.version for m in discover_migrations(directory)] == [1, 2, 10]

    def test_the_digest_ignores_line_endings(self, tmp_path: Path) -> None:
        """The same file checked out on Windows and on the Linux runner is the
        same migration. Without normalising, the digest check fires on every
        deploy made from the other platform."""
        lf = _migration_dir(tmp_path / "lf", **{"0001_a_sql": "SELECT 1;\nSELECT 2;\n"})
        crlf = _migration_dir(tmp_path / "crlf", **{"0001_a_sql": "SELECT 1;\r\nSELECT 2;\r\n"})

        assert discover_migrations(lf)[0].sha256 == discover_migrations(crlf)[0].sha256

    def test_a_stray_file_is_an_error_not_something_to_skip(self, tmp_path: Path) -> None:
        """A skipped file is a migration somebody believes has run."""
        directory = _migration_dir(
            tmp_path, **{"0001_fine_sql": "SELECT 1;", "add_index_sql": "SELECT 2;"}
        )

        with pytest.raises(MigrationError, match="not a migration name"):
            discover_migrations(directory)

    def test_two_files_with_the_same_number_are_refused(self, tmp_path: Path) -> None:
        """Two branches both adding 0007 - the schema would depend on merge order."""
        directory = _migration_dir(
            tmp_path, **{"0007_sharing_sql": "SELECT 1;", "0007_billing_sql": "SELECT 2;"}
        )

        with pytest.raises(MigrationError, match="two migrations are numbered 0007"):
            discover_migrations(directory)

    def test_a_missing_directory_says_so(self, tmp_path: Path) -> None:
        with pytest.raises(MigrationError, match="no migrations directory"):
            discover_migrations(tmp_path / "absent")

    def test_dotfiles_are_ignored(self, tmp_path: Path) -> None:
        directory = _migration_dir(tmp_path, **{"0001_a_sql": "SELECT 1;"})
        (directory / ".DS_Store").write_text("junk", encoding="utf-8")

        assert len(discover_migrations(directory)) == 1


class TestWhatIsPending:
    def _available(self) -> tuple[Migration, ...]:
        return (
            Migration(version=1, name="first", sql="SELECT 1;"),
            Migration(version=2, name="second", sql="SELECT 2;"),
        )

    def test_everything_is_pending_on_an_empty_database(self) -> None:
        assert len(pending_migrations({}, self._available())) == 2

    def test_only_the_unapplied_ones_are_pending(self) -> None:
        available = self._available()
        applied = {1: available[0].sha256}

        assert [m.version for m in pending_migrations(applied, available)] == [2]

    def test_nothing_is_pending_when_all_have_run(self) -> None:
        available = self._available()
        applied = {m.version: m.sha256 for m in available}

        assert pending_migrations(applied, available) == ()

    def test_editing_an_applied_migration_is_refused(self) -> None:
        """The database and the repository would otherwise disagree, silently,
        forever - and the disagreement only surfaces on the next fresh deploy,
        which builds a different schema from the same files."""
        available = self._available()
        applied = {1: "0" * 64}

        with pytest.raises(MigrationError, match="has changed since it was applied"):
            pending_migrations(applied, available)

    def test_a_migration_numbered_below_an_applied_one_is_refused(self) -> None:
        """Merging a branch that added 0002 after 0003 already ran everywhere.

        Applying it now builds this environment's schema in an order no other
        environment used, which is exactly the class of difference that makes
        staging stop predicting production.
        """
        available = (
            Migration(version=2, name="late", sql="SELECT 2;"),
            Migration(version=3, name="early", sql="SELECT 3;"),
        )
        applied = {3: available[1].sha256}

        with pytest.raises(MigrationError, match="never been applied"):
            pending_migrations(applied, available)


class TestRunning:
    def test_pending_migrations_are_applied_and_recorded(self, tmp_path: Path) -> None:
        directory = _migration_dir(
            tmp_path,
            **{"0001_first_sql": "CREATE TABLE a ();", "0002_second_sql": "CREATE TABLE b ();"},
        )
        connection = FakeConnection()

        applied = migrate(connection, directory)

        assert applied == ("0001_first.sql", "0002_second.sql")
        executed = connection.executed()
        assert "CREATE TABLE a ();" in executed
        assert "CREATE TABLE b ();" in executed
        assert sum("INSERT INTO schema_migrations" in sql for sql in executed) == 2

    def test_the_bookkeeping_table_is_created_before_it_is_read(self, tmp_path: Path) -> None:
        directory = _migration_dir(tmp_path, **{"0001_first_sql": "SELECT 1;"})
        connection = FakeConnection()

        migrate(connection, directory)

        executed = connection.executed()
        create = next(i for i, s in enumerate(executed) if "CREATE TABLE IF NOT EXISTS" in s)
        read = next(i for i, s in enumerate(executed) if "FROM schema_migrations" in s)
        assert create < read

    def test_the_advisory_lock_is_taken_before_reading_and_released_after(
        self, tmp_path: Path
    ) -> None:
        """Two Cloud Run instances boot together after a deploy. Without the
        lock both see the same pending migration, both run it, and the loser
        crash-loops on 'relation already exists'."""
        directory = _migration_dir(tmp_path, **{"0001_first_sql": "SELECT 1;"})
        connection = FakeConnection()

        migrate(connection, directory)

        executed = connection.executed()
        lock = next(i for i, s in enumerate(executed) if "pg_advisory_lock" in s)
        read = next(i for i, s in enumerate(executed) if "FROM schema_migrations" in s)
        unlock = next(i for i, s in enumerate(executed) if "pg_advisory_unlock" in s)
        assert lock < read < unlock

        keys = [args for sql, args in connection.statements if "advisory" in sql]
        assert keys == [(ADVISORY_LOCK_KEY,), (ADVISORY_LOCK_KEY,)]

    def test_a_second_instance_finds_nothing_to_do(self, tmp_path: Path) -> None:
        directory = _migration_dir(tmp_path, **{"0001_first_sql": "SELECT 1;"})
        already = discover_migrations(directory)[0]
        connection = FakeConnection(applied_rows=[(1, already.sha256)])

        assert migrate(connection, directory) == ()
        assert not any("INSERT INTO schema_migrations" in s for s in connection.executed())

    def test_a_failing_migration_rolls_back_and_names_the_file(self, tmp_path: Path) -> None:
        directory = _migration_dir(
            tmp_path,
            **{"0001_first_sql": "CREATE TABLE a ();", "0002_broken_sql": "NOT VALID SQL;"},
        )
        connection = FakeConnection()
        connection.fail_on = {"NOT VALID SQL;": 'syntax error at or near "NOT"'}

        with pytest.raises(MigrationError, match=r"0002_broken\.sql failed and was rolled back"):
            migrate(connection, directory)

        assert connection.rollbacks == 1

    def test_a_later_migration_does_not_run_after_an_earlier_one_fails(
        self, tmp_path: Path
    ) -> None:
        """Half-applying a deploy is the failure this ordering exists to avoid."""
        directory = _migration_dir(
            tmp_path,
            **{
                "0001_broken_sql": "BREAK;",
                "0002_later_sql": "CREATE TABLE later ();",
            },
        )
        connection = FakeConnection()
        connection.fail_on = {"BREAK;": "boom"}

        with pytest.raises(MigrationError):
            migrate(connection, directory)

        assert "CREATE TABLE later ();" not in connection.executed()

    def test_the_cursor_is_closed_even_when_a_migration_fails(self, tmp_path: Path) -> None:
        directory = _migration_dir(tmp_path, **{"0001_broken_sql": "BREAK;"})
        connection = FakeConnection()
        connection.fail_on = {"BREAK;": "boom"}

        with pytest.raises(MigrationError):
            migrate(connection, directory)

        assert connection.cursor_closed


class TestTheSchemaItself:
    """Rules the migrations have to keep, checked as text.

    These are cheap and they guard decisions that are expensive to reverse once
    a table exists in production with data in it.
    """

    def _sql(self) -> str:
        """The statements, with the commentary stripped.

        Checked against SQL rather than against the whole file, because the
        prose explaining why there is no bytea column contains the word bytea -
        as the first run of this test pointed out.
        """
        statements = []
        for migration in discover_migrations():
            for line in migration.sql.splitlines():
                body = line.split("--", 1)[0]
                if body.strip():
                    statements.append(body)
        return "\n".join(statements).lower()

    def test_no_migration_stores_bytes_in_postgres(self) -> None:
        """The rule the whole design rests on: GCS holds bytes, Postgres holds
        state. A bytea column makes every backup and every replica carry a
        40 MB scan, and it is added by accident far more easily than removed."""
        assert "bytea" not in self._sql()
        assert " blob" not in self._sql()

    def test_every_table_records_when_its_rows_were_created(self) -> None:
        sql = self._sql()
        tables = sql.count("create table ")

        assert sql.count("created_at") >= tables - 1, (
            "a table without created_at cannot answer 'when did this happen', "
            "which is the first question asked of every support ticket"
        )

    def test_timestamps_are_timezone_aware(self) -> None:
        """Three instances in different regions writing naive timestamps produce
        rows that cannot be ordered against each other."""
        sql = self._sql()

        assert "timestamp without time zone" not in sql
        assert "timestamptz" in sql

    def test_the_expected_tables_are_all_present(self) -> None:
        sql = self._sql()

        for table in ("accounts", "assets", "versions", "jobs", "entitlements"):
            assert f"create table {table} (" in sql, f"{table} is missing"

    def test_migrations_directory_is_resolved_against_the_module(self) -> None:
        """Not against the working directory: the container starts wherever
        Cloud Run starts it."""
        directory = migrations_directory()

        assert directory.is_absolute()
        assert directory.is_dir()


class TestStartup:
    """What happens to the service when the schema is not where it should be."""

    def test_without_a_database_the_service_still_starts(self) -> None:
        """Local development has no Postgres, and should not need one to run."""
        from ipw.workspace_api.config import Settings
        from ipw.workspace_api.http import prepare_database

        lines = prepare_database(Settings(database_url=""))

        assert lines == ["  no database configured - nothing will persist"]

    def test_a_migration_failure_stops_the_service_starting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The less obvious half of the design.

        Serving against a half-migrated schema turns one loud failure at boot -
        which Cloud Run reports, leaving the previous revision serving - into a
        scatter of confusing failures at request time on a revision that has
        already taken traffic. So this propagates rather than warning.
        """
        from ipw.workspace_api import http as http_module
        from ipw.workspace_api.config import Settings

        connection = FakeConnection()
        monkeypatch.setattr(http_module, "connect", lambda _url: connection)

        def explode(_connection: Any) -> tuple[str, ...]:
            msg = "0002_broken.sql failed and was rolled back: syntax error"
            raise MigrationError(msg)

        monkeypatch.setattr(http_module, "migrate", explode)

        with pytest.raises(MigrationError, match=r"0002_broken\.sql"):
            http_module.prepare_database(Settings(database_url="postgresql://u:p@h/db"))

    def test_the_connection_is_closed_even_when_migrating_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A container that crash-loops must not leak a connection per attempt;
        Cloud SQL's connection limit is reached surprisingly quickly that way."""
        from ipw.workspace_api import http as http_module
        from ipw.workspace_api.config import Settings

        connection = FakeConnection()
        monkeypatch.setattr(http_module, "connect", lambda _url: connection)

        def explode(_connection: Any) -> tuple[str, ...]:
            raise MigrationError("boom")

        monkeypatch.setattr(http_module, "migrate", explode)

        with pytest.raises(MigrationError):
            http_module.prepare_database(Settings(database_url="postgresql://u:p@h/db"))

        assert connection.closed

    def test_an_up_to_date_schema_is_reported_as_such(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from ipw.workspace_api import http as http_module
        from ipw.workspace_api.config import Settings

        monkeypatch.setattr(http_module, "connect", lambda _url: FakeConnection())
        monkeypatch.setattr(http_module, "migrate", lambda _c: ())

        lines = http_module.prepare_database(Settings(database_url="postgresql://u:p@h/db"))

        assert lines == ["  database schema is up to date"]

    def test_applied_migrations_are_named_in_the_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Which migration ran is the first thing anybody wants from a deploy log."""
        from ipw.workspace_api import http as http_module
        from ipw.workspace_api.config import Settings

        monkeypatch.setattr(http_module, "connect", lambda _url: FakeConnection())
        monkeypatch.setattr(http_module, "migrate", lambda _c: ("0001_initial.sql",))

        lines = http_module.prepare_database(Settings(database_url="postgresql://u:p@h/db"))

        assert lines == ["  applied 1 migration(s): 0001_initial.sql"]
