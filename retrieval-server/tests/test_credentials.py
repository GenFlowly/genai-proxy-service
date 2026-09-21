"""
Unit tests for graph.credentials.CredentialResolver (stdlib unittest + mock — no
new deps, runnable with `python -m unittest tests.test_credentials`).

The retrieval-server has no pytest harness today; these mock boto3 DynamoDB + KMS
so the resolver's logic (vendor-key mapping, base64+KMS decrypt, dict shape,
per-run caching, missing-key handling) is verified without any live AWS.
"""
import base64
import unittest
from unittest.mock import MagicMock

from graph.credentials import CredentialResolver, stored_vendor_key


def _fake_clients(stored_plaintext_by_key: dict[tuple[str, str], str]):
    """Build (ddb_resource, kms_client) mocks backed by an in-memory store keyed
    by (customerId, aiVendor) → plaintext api key. The stored ciphertext is just
    base64(plaintext) and the fake KMS reverses that, so we exercise the real
    base64 + decrypt call shape without real crypto."""
    table = MagicMock()

    def get_item(Key):
        pt = stored_plaintext_by_key.get((Key["customerId"], Key["aiVendor"]))
        if pt is None:
            return {}
        return {"Item": {"apiKey": base64.b64encode(pt.encode()).decode()}}

    table.get_item.side_effect = get_item
    ddb = MagicMock()
    ddb.Table.return_value = table

    kms = MagicMock()
    kms.decrypt.side_effect = lambda CiphertextBlob: {"Plaintext": CiphertextBlob}  # b64decode already reversed it
    return ddb, kms, table


class StoredVendorKeyTest(unittest.TestCase):
    def test_legacy_providers_map_to_uppercase_names(self):
        self.assertEqual(stored_vendor_key("openai"), "OPENAI")
        self.assertEqual(stored_vendor_key("anthropic"), "CLAUDE")
        self.assertEqual(stored_vendor_key("gemini"), "GEMINI")

    def test_mapping_is_case_insensitive_on_input(self):
        self.assertEqual(stored_vendor_key("Anthropic"), "CLAUDE")
        self.assertEqual(stored_vendor_key("OpenAI"), "OPENAI")

    def test_byok_providers_pass_through_lowercased(self):
        self.assertEqual(stored_vendor_key("groq"), "groq")
        self.assertEqual(stored_vendor_key("together_ai"), "together_ai")
        self.assertEqual(stored_vendor_key("XAI"), "xai")


class CredentialResolverTest(unittest.TestCase):
    def test_resolves_anthropic_key_and_shape(self):
        ddb, kms, table = _fake_clients({("cust-1", "CLAUDE"): "sk-ant-real"})
        r = CredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        creds = r.credentials("cust-1", "anthropic")

        self.assertEqual(creds, {"anthropic_api_key": "sk-ant-real"})
        # queried the right item (SK mapped anthropic -> CLAUDE)
        table.get_item.assert_called_once_with(Key={"customerId": "cust-1", "aiVendor": "CLAUDE"})
        # KMS got the base64-decoded ciphertext, not the raw stored string
        (_, kwargs) = kms.decrypt.call_args
        self.assertEqual(kwargs["CiphertextBlob"], b"sk-ant-real")

    def test_byok_provider_uses_lowercase_sk_and_key(self):
        ddb, kms, table = _fake_clients({("cust-1", "groq"): "gsk-real"})
        r = CredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        creds = r.credentials("cust-1", "groq")

        self.assertEqual(creds, {"groq_api_key": "gsk-real"})
        table.get_item.assert_called_once_with(Key={"customerId": "cust-1", "aiVendor": "groq"})

    def test_missing_key_returns_empty_dict(self):
        ddb, kms, _ = _fake_clients({})  # nothing stored
        r = CredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        self.assertEqual(r.credentials("cust-1", "openai"), {})
        self.assertIsNone(r.api_key("cust-1", "openai"))
        kms.decrypt.assert_not_called()

    def test_per_run_cache_hits_ddb_once_across_nodes(self):
        ddb, kms, table = _fake_clients({("cust-1", "OPENAI"): "sk-oai"})
        r = CredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        # Simulate many nodes in one run asking for the same provider
        for _ in range(5):
            self.assertEqual(r.api_key("cust-1", "openai"), "sk-oai")

        self.assertEqual(table.get_item.call_count, 1)
        self.assertEqual(kms.decrypt.call_count, 1)

    def test_cache_is_per_resolver_instance(self):
        store = {("cust-1", "OPENAI"): "sk-oai"}
        ddb, kms, table = _fake_clients(store)

        CredentialResolver(dynamodb_resource=ddb, kms_client=kms).api_key("cust-1", "openai")
        CredentialResolver(dynamodb_resource=ddb, kms_client=kms).api_key("cust-1", "openai")

        # A fresh resolver (a new run) does its own round-trip — cache doesn't leak across runs
        self.assertEqual(table.get_item.call_count, 2)

    def test_missing_key_is_cached_too(self):
        ddb, kms, table = _fake_clients({})
        r = CredentialResolver(dynamodb_resource=ddb, kms_client=kms)

        r.api_key("cust-1", "openai")
        r.api_key("cust-1", "openai")

        self.assertEqual(table.get_item.call_count, 1)


if __name__ == "__main__":
    unittest.main()
