"""
Unit tests for graph.tool_credentials (stdlib unittest + mock — no new deps,
runnable with `python -m unittest tests.test_tool_credentials`).

These mock boto3 DynamoDB + KMS so the resolver's logic (base64 + KMS decrypt,
JSON blob shape, per-run caching, missing-credential handling, and the
secrets_accessor wrapper) is verified without any live AWS.

The invariant under test throughout: a MISSING credential is not an error —
it yields {} so the calling tool can degrade gracefully — while a FETCH or
DECRYPT failure does raise, because that is a real fault.
"""
import base64
import json
import unittest
from unittest.mock import MagicMock, patch

import graph.tool_credentials as tool_credentials
from graph.tool_credentials import ToolCredentialResolver, secrets_accessor


def _fake_clients(stored_by_key: dict[tuple[str, str], dict]):
    """(ddb_resource, kms_client) mocks backed by an in-memory store keyed by
    (customerId, toolType) -> values dict. Stored ciphertext is base64 of the
    JSON text and the fake KMS reverses that, so the real base64 + json.loads
    path is exercised."""
    calls = {"get_item": 0, "decrypt": 0}

    def get_item(Key):
        calls["get_item"] += 1
        values = stored_by_key.get((Key["customerId"], Key["toolType"]))
        if values is None:
            return {}
        blob = base64.b64encode(json.dumps(values).encode("utf-8")).decode("utf-8")
        return {"Item": {"credentials": blob, "authType": "api_key"}}

    table = MagicMock()
    table.get_item.side_effect = get_item
    ddb = MagicMock()
    ddb.Table.return_value = table

    def decrypt(CiphertextBlob):
        calls["decrypt"] += 1
        return {"Plaintext": CiphertextBlob}

    kms = MagicMock()
    kms.decrypt.side_effect = decrypt
    return ddb, kms, calls


class ToolCredentialResolverTests(unittest.TestCase):
    def test_returns_decrypted_values(self):
        ddb, kms, _ = _fake_clients({("cust-1", "WEB_SEARCH"): {"api_key": "tvly-abc"}})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(
            resolver.credentials("cust-1", "WEB_SEARCH"), {"api_key": "tvly-abc"}
        )

    def test_multi_field_blob_survives_round_trip(self):
        stored = {"username": "svc", "password": "p@ss", "host": "db.internal"}
        ddb, kms, _ = _fake_clients({("cust-1", "DATABASE_QUERY"): stored})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(resolver.credentials("cust-1", "DATABASE_QUERY"), stored)

    def test_missing_row_yields_empty_map_not_an_error(self):
        ddb, kms, _ = _fake_clients({})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(resolver.credentials("cust-1", "WEB_SEARCH"), {})

    def test_row_without_credentials_attribute_yields_empty_map(self):
        table = MagicMock()
        table.get_item.return_value = {"Item": {"authType": "api_key"}}
        ddb = MagicMock()
        ddb.Table.return_value = table
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=MagicMock())

        self.assertEqual(resolver.credentials("cust-1", "WEB_SEARCH"), {})

    def test_non_object_blob_is_rejected_rather_than_returned(self):
        # A blob that decrypts to a JSON scalar would otherwise flow into a
        # tool as something without .get().
        blob = base64.b64encode(json.dumps("just-a-string").encode()).decode()
        table = MagicMock()
        table.get_item.return_value = {"Item": {"credentials": blob}}
        ddb = MagicMock()
        ddb.Table.return_value = table
        kms = MagicMock()
        kms.decrypt.side_effect = lambda CiphertextBlob: {"Plaintext": CiphertextBlob}
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(resolver.credentials("cust-1", "WEB_SEARCH"), {})

    def test_hits_are_cached_for_the_resolver_lifetime(self):
        ddb, kms, calls = _fake_clients({("cust-1", "WEB_SEARCH"): {"api_key": "k"}})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        for _ in range(3):
            resolver.credentials("cust-1", "WEB_SEARCH")

        self.assertEqual(calls["get_item"], 1)
        self.assertEqual(calls["decrypt"], 1)

    def test_misses_are_cached_too(self):
        ddb, kms, calls = _fake_clients({})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        resolver.credentials("cust-1", "WEB_SEARCH")
        resolver.credentials("cust-1", "WEB_SEARCH")

        self.assertEqual(calls["get_item"], 1)

    def test_cache_is_scoped_per_customer(self):
        ddb, kms, _ = _fake_clients({
            ("cust-1", "WEB_SEARCH"): {"api_key": "one"},
            ("cust-2", "WEB_SEARCH"): {"api_key": "two"},
        })
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(resolver.credentials("cust-1", "WEB_SEARCH")["api_key"], "one")
        self.assertEqual(resolver.credentials("cust-2", "WEB_SEARCH")["api_key"], "two")

    def test_blank_inputs_short_circuit_without_touching_aws(self):
        ddb, kms, calls = _fake_clients({})
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(resolver.credentials("", "WEB_SEARCH"), {})
        self.assertEqual(resolver.credentials("cust-1", ""), {})
        self.assertEqual(calls["get_item"], 0)

    def test_fetch_failure_raises(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError("ddb down")
        ddb = MagicMock()
        ddb.Table.return_value = table
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=MagicMock())

        with self.assertRaises(RuntimeError):
            resolver.credentials("cust-1", "WEB_SEARCH")

    def test_decrypt_failure_raises(self):
        blob = base64.b64encode(b'{"api_key": "k"}').decode()
        table = MagicMock()
        table.get_item.return_value = {"Item": {"credentials": blob}}
        ddb = MagicMock()
        ddb.Table.return_value = table
        kms = MagicMock()
        kms.decrypt.side_effect = RuntimeError("kms denied")
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        with self.assertRaises(RuntimeError):
            resolver.credentials("cust-1", "WEB_SEARCH")


class ResolveManyTests(unittest.TestCase):
    def test_resolve_returns_a_map_keyed_by_ref(self):
        ddb, kms, _ = _fake_clients({
            ("cust-1", "WEB_SEARCH"): {"api_key": "k1"},
            ("cust-1", "EMAIL"): {"token": "k2"},
        })
        resolver = ToolCredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        out = resolver.resolve("cust-1", ["WEB_SEARCH", "EMAIL", "CALENDAR"])

        self.assertEqual(out["WEB_SEARCH"], {"api_key": "k1"})
        self.assertEqual(out["EMAIL"], {"token": "k2"})
        self.assertEqual(out["CALENDAR"], {})

    def test_module_helper_uses_shared_clients(self):
        with patch.object(tool_credentials, "make_resolver") as make:
            make.return_value.resolve.return_value = {"WEB_SEARCH": {"api_key": "k"}}
            out = tool_credentials.resolve_tool_credentials("cust-1", {"WEB_SEARCH"})

        self.assertEqual(out, {"WEB_SEARCH": {"api_key": "k"}})


class SecretsAccessorTests(unittest.TestCase):
    """The accessor is a pure lookup over an already-resolved map — tools must
    never be able to trigger I/O from inside run()."""

    def test_returns_values_for_a_known_ref(self):
        secrets = secrets_accessor({"WEB_SEARCH": {"api_key": "k"}})
        self.assertEqual(secrets("WEB_SEARCH"), {"api_key": "k"})

    def test_unknown_ref_yields_empty_map(self):
        secrets = secrets_accessor({"WEB_SEARCH": {"api_key": "k"}})
        self.assertEqual(secrets("EMAIL"), {})

    def test_none_ref_yields_empty_map(self):
        secrets = secrets_accessor({})
        self.assertEqual(secrets(None), {})

    def test_null_stored_value_yields_empty_map(self):
        secrets = secrets_accessor({"WEB_SEARCH": None})
        self.assertEqual(secrets("WEB_SEARCH"), {})


if __name__ == "__main__":
    unittest.main()
