"""The session network guard, tested in both directions.

The guard in conftest.py stops a test quietly downloading a model, a weight file
or a result from a provider - any of which would make a benchmark reproducible
only on the machine that ran it. It was previously unverified, which is an
awkward position for a safety net: nothing would have noticed if it stopped
catching anything.

It allows loopback, so a test can start a server and drive its real routes. That
exception needs pinning as firmly as the ban itself, because "allow localhost"
is one careless edit away from "allow everything".
"""

from __future__ import annotations

import socket

import pytest

pytest.importorskip("pytest")

from conftest import NetworkAccessDuringTestsError, _is_loopback


class TestWhatCountsAsLoopback:
    @pytest.mark.parametrize(
        "address",
        [("127.0.0.1", 80), ("127.0.0.53", 5353), ("::1", 443), ("localhost", 8000)],
    )
    def test_loopback_is_recognised(self, address: tuple[str, int]) -> None:
        assert _is_loopback(address) is True

    @pytest.mark.parametrize(
        "address",
        [
            ("huggingface.co", 443),
            ("8.8.8.8", 53),
            ("192.168.1.10", 80),
            ("10.0.0.1", 80),
            ("0.0.0.0", 80),  # noqa: S104 - test data, not a bind: this must NOT count
            # The near-misses matter most: these are what a careless check lets
            # through. "127.0.0.1.evil.com" is a hostname, not loopback.
            ("127.0.0.1.evil.example", 443),
            ("2127.0.0.1", 443),
        ],
    )
    def test_everything_else_is_not(self, address: tuple[str, int]) -> None:
        assert _is_loopback(address) is False

    def test_a_bare_hostname_is_not_loopback(self) -> None:
        assert _is_loopback("example.com") is False
        assert _is_loopback(None) is False


class TestTheGuardIsLive:
    """The fixture is session-scoped and autouse, so it is already installed."""

    def test_reaching_off_this_machine_is_refused(self) -> None:
        with pytest.raises(NetworkAccessDuringTestsError, match="forbidden"):
            socket.create_connection(("example.com", 80), timeout=1)

    def test_a_raw_socket_connect_is_refused_too(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with pytest.raises(NetworkAccessDuringTestsError):
                sock.connect(("93.184.216.34", 80))
        finally:
            sock.close()

    def test_loopback_still_works_so_the_http_layer_can_be_tested(self) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        try:
            client = socket.create_connection(listener.getsockname(), timeout=5)
            client.close()
        finally:
            listener.close()
