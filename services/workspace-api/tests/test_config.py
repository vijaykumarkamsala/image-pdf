"""Configuration, and the refusal that matters.

This service has no authentication. That is not an oversight - it is where the
build has reached - but it means a process listening beyond loopback is an image
processor anyone who can reach it may run at your expense.

Cloud Run forces the question rather than allowing it to be deferred: its proxy
connects from outside the container, so a container bound to 127.0.0.1 accepts
nothing and looks like a broken deploy. That is exactly the moment somebody
types 0.0.0.0 to make the error go away. These tests pin the refusal, so the
decision has to be made in the open.
"""

# ruff: noqa: S104 - every "0.0.0.0" below is the input being refused, not a bind.
# Flagging them here would mean the tests that prove the guard works cannot be
# written, which inverts the rule.

from __future__ import annotations

from pathlib import Path

import pytest

from ipw.workspace_api.config import ENVIRONMENTS, Settings, load_dotenv, load_settings


class TestDefaults:
    def test_nothing_set_means_localhost(self) -> None:
        settings = load_settings({})
        assert settings.host == "127.0.0.1"
        assert settings.port == 8770
        assert settings.environment == "local"
        assert settings.binds_publicly is False

    def test_a_bare_default_raises_no_warnings(self) -> None:
        assert load_settings({}).warnings() == []


class TestTheBindGuard:
    @pytest.mark.parametrize("host", ["0.0.0.0", "::", "10.0.0.4", "example.internal"])
    def test_binding_beyond_loopback_is_refused_without_acknowledgement(self, host: str) -> None:
        with pytest.raises(ValueError, match="no authentication"):
            load_settings({"IPW_HOST": host})

    def test_the_refusal_says_what_to_do_about_it(self) -> None:
        """An error that only says no sends somebody to read the source."""
        with pytest.raises(ValueError, match="IPW_ALLOW_PUBLIC_BIND"):
            load_settings({"IPW_HOST": "0.0.0.0"})

        with pytest.raises(ValueError, match="no-allow-unauthenticated"):
            load_settings({"IPW_HOST": "0.0.0.0"})

    def test_an_explicit_acknowledgement_is_honoured(self) -> None:
        settings = load_settings({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": "1"})
        assert settings.host == "0.0.0.0"
        assert settings.binds_publicly is True

    @pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
    def test_the_usual_ways_of_writing_yes_all_work(self, value: str) -> None:
        assert load_settings({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": value})

    @pytest.mark.parametrize("value", ["0", "false", "no", "", "maybe"])
    def test_anything_else_is_not_consent(self, value: str) -> None:
        with pytest.raises(ValueError, match="refusing to bind"):
            load_settings({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": value})

    @pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
    def test_loopback_never_needs_permission(self, host: str) -> None:
        assert load_settings({"IPW_HOST": host}).binds_publicly is False

    def test_a_public_bind_always_carries_the_warning(self) -> None:
        """Consent is not the same as safety. It must still say what it did."""
        settings = load_settings({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": "1"})
        assert any("NO AUTHENTICATION" in warning for warning in settings.warnings())


class TestPort:
    def test_cloud_run_sets_its_own_port_variable(self) -> None:
        assert load_settings({"PORT": "8080"}).port == 8080

    def test_the_platform_variable_wins_over_ours(self) -> None:
        """The platform's variable is the one the platform actually connects to."""
        assert load_settings({"PORT": "8080", "IPW_PORT": "9999"}).port == 8080

    def test_our_own_name_works_when_the_platform_sets_nothing(self) -> None:
        assert load_settings({"IPW_PORT": "9000"}).port == 9000

    @pytest.mark.parametrize("value", ["nonsense", "0", "70000", "-1"])
    def test_an_unusable_port_is_refused_rather_than_defaulted(self, value: str) -> None:
        """Silently falling back would bind a port nobody is connecting to,
        which reads as a hung deploy rather than a configuration mistake."""
        with pytest.raises(ValueError, match="PORT"):
            load_settings({"PORT": value})

    def test_an_empty_port_variable_falls_through_to_the_default(self) -> None:
        assert load_settings({"PORT": ""}).port == 8770


class TestEnvironments:
    @pytest.mark.parametrize("name", ENVIRONMENTS)
    def test_each_known_environment_is_accepted(self, name: str) -> None:
        assert load_settings({"IPW_ENV": name}).environment == name

    def test_an_unknown_environment_is_flagged_not_rejected(self) -> None:
        """A typo should be visible without stopping a deploy that may be urgent."""
        settings = load_settings({"IPW_ENV": "prodution"})
        assert any("Unknown environment" in warning for warning in settings.warnings())

    def test_production_says_when_it_has_no_database(self) -> None:
        settings = load_settings({"IPW_ENV": "production"})
        assert any("nothing will persist" in warning for warning in settings.warnings())

    def test_production_says_when_it_has_no_bucket(self) -> None:
        settings = load_settings({"IPW_ENV": "production"})
        assert any("nowhere to live" in warning for warning in settings.warnings())

    def test_a_fully_configured_production_is_quiet_apart_from_the_bind(self) -> None:
        settings = load_settings(
            {
                "IPW_ENV": "production",
                "IPW_HOST": "0.0.0.0",
                "IPW_ALLOW_PUBLIC_BIND": "1",
                "IPW_BUCKET": "ipw-prod",
                "IPW_DATABASE_URL": "postgresql://u:p@h:5432/db",
            }
        )
        assert len(settings.warnings()) == 1
        assert "NO AUTHENTICATION" in settings.warnings()[0]

    def test_each_environment_gets_its_own_bucket(self) -> None:
        """Three buckets, one per environment, so staging can never write into
        production's objects."""
        for name, bucket in (("dev", "ipw-dev"), ("staging", "ipw-staging")):
            settings = load_settings({"IPW_ENV": name, "IPW_BUCKET": bucket})
            assert settings.bucket == bucket


class TestSettingsShape:
    def test_settings_are_frozen(self) -> None:
        """Configuration read once at startup should not drift while running."""
        settings = Settings()
        with pytest.raises(Exception, match="cannot assign"):
            settings.host = "0.0.0.0"  # type: ignore[misc]


class TestStartupBanner:
    """What the service announces before it accepts anything.

    A deployment that is quietly listening to the world should say so on its
    first lines of output, not in a setting somebody has to go and read.
    """

    @staticmethod
    def _banner(env: dict[str, str], port: int = 8080) -> list[str]:
        from pathlib import Path

        from ipw.workspace_api.http import startup_banner

        return startup_banner(Path("/srv/apps/workspace"), load_settings(env), port)

    def test_it_names_the_environment(self) -> None:
        """Which environment you are looking at is the first thing to know."""
        assert "[staging]" in self._banner({"IPW_ENV": "staging"})[0]

    def test_a_local_run_says_nothing_alarming(self) -> None:
        lines = self._banner({})
        assert not any("WARNING" in line for line in lines)

    def test_a_public_bind_announces_itself(self) -> None:
        lines = self._banner({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": "1"})
        assert any("NO AUTHENTICATION" in line for line in lines)

    def test_a_wildcard_is_shown_as_a_usable_address_and_as_itself(self) -> None:
        """Nobody can type 0.0.0.0 into a browser, so the link shows loopback -
        but the real bind is printed too, so the convenience hides nothing."""
        lines = self._banner({"IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": "1"})
        assert "http://127.0.0.1:8080/" in lines[0]
        assert any("listening on 0.0.0.0:8080" in line for line in lines)

    def test_a_misconfigured_production_lists_every_problem(self) -> None:
        lines = self._banner(
            {"IPW_ENV": "production", "IPW_HOST": "0.0.0.0", "IPW_ALLOW_PUBLIC_BIND": "1"}
        )
        warnings = [line for line in lines if "WARNING" in line]
        assert len(warnings) == 3, warnings

    def test_the_port_shown_is_the_one_actually_bound(self) -> None:
        """Cloud Run picks the port; printing the requested one would mislead
        anybody debugging a deploy that landed somewhere else."""
        assert ":51234/" in self._banner({}, port=51234)[0]


class TestDotenv:
    """A `.env` is a local convenience, and must never outrank a real variable."""

    @staticmethod
    def _write(tmp_path: Path, text: str) -> Path:
        path = tmp_path / ".env"
        path.write_text(text, encoding="utf-8")
        return path

    def test_a_missing_file_is_not_an_error(self, tmp_path: Path) -> None:
        assert load_dotenv(tmp_path / "absent.env") == {}

    def test_it_reads_plain_pairs(self, tmp_path: Path) -> None:
        path = self._write(tmp_path, "IPW_ENV=dev\nIPW_BUCKET=my-bucket\n")
        assert load_dotenv(path) == {"IPW_ENV": "dev", "IPW_BUCKET": "my-bucket"}

    def test_comments_and_blank_lines_are_skipped(self, tmp_path: Path) -> None:
        path = self._write(tmp_path, "# a note\n\nIPW_ENV=dev\n\n# another\n")
        assert load_dotenv(path) == {"IPW_ENV": "dev"}

    def test_quotes_are_stripped_but_nothing_is_interpreted(self, tmp_path: Path) -> None:
        """A config file that evaluates things is a config file that surprises."""
        path = self._write(tmp_path, 'A="spaced value"\nB=$NOT_SUBSTITUTED\n')
        assert load_dotenv(path) == {"A": "spaced value", "B": "$NOT_SUBSTITUTED"}

    def test_a_malformed_line_is_ignored_rather_than_fatal(self, tmp_path: Path) -> None:
        """One bad line should not stop a service starting."""
        path = self._write(tmp_path, "GOOD=yes\nMALFORMED\nALSO_GOOD=yes\n")
        assert load_dotenv(path) == {"GOOD": "yes", "ALSO_GOOD": "yes"}

    def test_a_password_containing_an_equals_sign_survives(self, tmp_path: Path) -> None:
        """Splitting on every `=` would silently truncate a database password."""
        path = self._write(tmp_path, "IPW_DATABASE_URL=postgresql://u:p==w@h:5432/db\n")
        assert load_dotenv(path)["IPW_DATABASE_URL"] == "postgresql://u:p==w@h:5432/db"

    def test_the_real_environment_wins_over_the_file(self, tmp_path: Path) -> None:
        """A file on disk quietly overriding a deliberately set variable is how an
        afternoon disappears."""
        from_file = load_dotenv(self._write(tmp_path, "IPW_ENV=dev\n"))
        merged = {**from_file, "IPW_ENV": "production"}
        assert load_settings(merged).environment == "production"


class TestShapeChecks:
    """Typos that would otherwise surface as a connection error.

    A stray quote at the end of a database URL makes the database name read as
    `mydb"`, and Postgres answers with an authentication or does-not-exist error
    that says nothing about the real cause. This happened on the first real
    configuration, which is why these exist.
    """

    def test_a_trailing_quote_is_named_precisely(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": 'postgresql://u:p@h:5432/db"'})
        problems = " ".join(settings.warnings())
        assert "stray quote" in problems
        assert "IPW_DATABASE_URL" in problems

    def test_a_trailing_apostrophe_too(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": "postgresql://u:p@h:5432/db'"})
        assert any("stray quote" in warning for warning in settings.warnings())

    def test_a_correct_url_is_quiet(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": "postgresql://u:p@h:5432/db"})
        assert settings.warnings() == []

    def test_the_postgres_scheme_alias_is_accepted(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": "postgres://u:p@h:5432/db"})
        assert settings.warnings() == []

    def test_another_database_is_reported(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": "mysql://u:p@h/db"})
        assert any("postgresql://" in warning for warning in settings.warnings())

    def test_a_url_with_no_host_is_reported(self) -> None:
        settings = load_settings({"IPW_DATABASE_URL": "postgresql://justadatabase"})
        assert any("incomplete" in warning for warning in settings.warnings())

    def test_a_password_containing_an_at_sign_is_not_mistaken_for_a_problem(self) -> None:
        """Passwords contain @ and : more often than anything else does."""
        settings = load_settings({"IPW_DATABASE_URL": "postgresql://u:p@ss@h:5432/db"})
        assert settings.warnings() == []

    def test_a_bucket_written_as_a_url_is_reported(self) -> None:
        settings = load_settings({"IPW_BUCKET": "gs://my-bucket"})
        assert any("bare bucket name" in warning for warning in settings.warnings())

    def test_a_bucket_with_a_path_is_reported(self) -> None:
        settings = load_settings({"IPW_BUCKET": "my-bucket/uploads"})
        assert any("no path" in warning for warning in settings.warnings())

    def test_a_plain_bucket_name_is_quiet(self) -> None:
        settings = load_settings({"IPW_BUCKET": "yearshift-image-pdf-dev"})
        assert settings.warnings() == []

    def test_nothing_configured_reports_nothing(self) -> None:
        """Absent is not the same as wrong. Local development sets neither."""
        assert load_settings({}).warnings() == []
