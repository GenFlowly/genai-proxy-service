"""
Unit tests for graph_tools.providers.safe_client.

Run with `python -m unittest tests.test_safe_client`.

No network is touched: DNS resolution is patched so the address checks can be
exercised against the ranges that matter. The cases below are the destinations
a tool must never reach from inside our network — cloud instance metadata above
all, since reaching it would hand out the process's AWS identity.
"""
import socket
import unittest
from unittest.mock import patch

from graph_tools.providers import safe_client
from graph_tools.providers.safe_client import (
    UnsafeRequestError,
    _is_public_address,
    resolve_public_addresses,
    sanitize_headers,
    validate_url,
)


def _resolves_to(*ips):
    """Patch getaddrinfo to return exactly these addresses."""
    infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]
    return patch.object(socket, "getaddrinfo", return_value=infos)


class AddressClassificationTests(unittest.TestCase):
    def test_public_addresses_are_allowed(self):
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]:
            self.assertTrue(_is_public_address(ip), ip)

    def test_cloud_instance_metadata_is_refused(self):
        # The single most valuable SSRF target from inside a cloud network.
        self.assertFalse(_is_public_address("169.254.169.254"))

    def test_private_ranges_are_refused(self):
        for ip in ["10.0.0.1", "172.16.0.1", "192.168.1.1"]:
            self.assertFalse(_is_public_address(ip), ip)

    def test_loopback_is_refused(self):
        self.assertFalse(_is_public_address("127.0.0.1"))
        self.assertFalse(_is_public_address("::1"))

    def test_link_local_and_unspecified_are_refused(self):
        self.assertFalse(_is_public_address("169.254.1.1"))
        self.assertFalse(_is_public_address("0.0.0.0"))

    def test_ipv6_private_and_multicast_are_refused(self):
        self.assertFalse(_is_public_address("fc00::1"))
        self.assertFalse(_is_public_address("fe80::1"))
        self.assertFalse(_is_public_address("ff02::1"))

    def test_ipv4_mapped_ipv6_is_judged_on_the_address_it_reaches(self):
        # ::ffff:169.254.169.254 would otherwise pass a naive v6 check.
        self.assertFalse(_is_public_address("::ffff:169.254.169.254"))
        self.assertFalse(_is_public_address("::ffff:127.0.0.1"))
        self.assertTrue(_is_public_address("::ffff:1.1.1.1"))

    def test_garbage_is_not_public(self):
        self.assertFalse(_is_public_address("not-an-ip"))


class ResolutionTests(unittest.TestCase):
    def test_public_hostname_resolves(self):
        with _resolves_to("93.184.216.34"):
            self.assertEqual(resolve_public_addresses("example.com", 443), ["93.184.216.34"])

    def test_hostname_pointing_at_a_private_address_is_refused(self):
        with _resolves_to("10.0.0.5"):
            with self.assertRaises(UnsafeRequestError):
                resolve_public_addresses("internal.example.com", 443)

    def test_split_horizon_is_refused_all_or_nothing(self):
        # One public and one private record would otherwise be a coin flip at
        # connection time.
        with _resolves_to("93.184.216.34", "10.0.0.5"):
            with self.assertRaises(UnsafeRequestError):
                resolve_public_addresses("mixed.example.com", 443)

    def test_bare_private_ip_literal_is_refused_without_resolving(self):
        with patch.object(socket, "getaddrinfo", side_effect=AssertionError("should not resolve")):
            with self.assertRaises(UnsafeRequestError):
                resolve_public_addresses("127.0.0.1", 443)

    def test_unresolvable_host_is_refused(self):
        with patch.object(socket, "getaddrinfo", side_effect=socket.gaierror("nope")):
            with self.assertRaises(UnsafeRequestError):
                resolve_public_addresses("nx.example.com", 443)

    def test_empty_host_is_refused(self):
        with self.assertRaises(UnsafeRequestError):
            resolve_public_addresses("", 443)


class UrlValidationTests(unittest.TestCase):
    def test_https_public_host_passes(self):
        with _resolves_to("93.184.216.34"):
            self.assertEqual(validate_url("https://example.com/v1/x"), ("example.com", 443))

    def test_plain_http_is_refused(self):
        # Would put the customer's own API key on the wire in clear text.
        with self.assertRaises(UnsafeRequestError):
            validate_url("http://example.com/x")

    def test_other_schemes_are_refused(self):
        for url in ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"]:
            with self.assertRaises(UnsafeRequestError):
                validate_url(url)

    def test_url_without_a_host_is_refused(self):
        with self.assertRaises(UnsafeRequestError):
            validate_url("https:///nohost")

    def test_metadata_by_ip_literal_is_refused(self):
        with self.assertRaises(UnsafeRequestError):
            validate_url("https://169.254.169.254/latest/meta-data/")

    def test_nonstandard_port_is_carried_through(self):
        with _resolves_to("93.184.216.34"):
            self.assertEqual(validate_url("https://example.com:8443/x")[1], 8443)


class HeaderTests(unittest.TestCase):
    def test_ordinary_headers_survive(self):
        self.assertEqual(
            sanitize_headers({"Authorization": "Bearer x", "Accept": "application/json"}),
            {"Authorization": "Bearer x", "Accept": "application/json"},
        )

    def test_transport_headers_are_dropped(self):
        out = sanitize_headers({"Host": "evil.example.com", "Content-Length": "0", "X-Ok": "1"})
        self.assertEqual(out, {"X-Ok": "1"})

    def test_hop_by_hop_headers_are_dropped(self):
        out = sanitize_headers({"Connection": "close", "Upgrade": "h2c", "X-Ok": "1"})
        self.assertEqual(out, {"X-Ok": "1"})

    def test_dropping_is_case_insensitive(self):
        self.assertEqual(sanitize_headers({"hOsT": "evil"}), {})

    def test_newline_in_a_value_is_refused(self):
        # CRLF in a header value is request splitting.
        with self.assertRaises(UnsafeRequestError):
            sanitize_headers({"X-Thing": "a\r\nX-Injected: 1"})

    def test_newline_in_a_name_is_refused(self):
        with self.assertRaises(UnsafeRequestError):
            sanitize_headers({"X-Thing\r\nX-Injected": "1"})

    def test_none_value_becomes_empty_string(self):
        self.assertEqual(sanitize_headers({"X": None}), {"X": ""})


class MethodTests(unittest.IsolatedAsyncioTestCase):
    async def test_disallowed_method_is_refused_before_any_network_call(self):
        for method in ["TRACE", "CONNECT", "OPTIONS", "HEAD", ""]:
            with self.assertRaises(UnsafeRequestError):
                await safe_client.request(method, "https://example.com/x")

    async def test_unsafe_destination_is_refused_before_any_network_call(self):
        with self.assertRaises(UnsafeRequestError):
            await safe_client.request("GET", "https://169.254.169.254/latest/")


class ConfigurationTests(unittest.TestCase):
    def test_allowed_methods_are_the_expected_set(self):
        self.assertEqual(
            safe_client.ALLOWED_METHODS,
            {"GET", "POST", "PUT", "PATCH", "DELETE"},
        )

    def test_defaults_are_bounded(self):
        self.assertLessEqual(safe_client.DEFAULT_TIMEOUT_SECONDS, 30)
        self.assertLessEqual(safe_client.DEFAULT_MAX_RESPONSE_BYTES, 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
