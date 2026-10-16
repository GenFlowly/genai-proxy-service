"""
Unit tests for the shared multi-tenant collection primitives
(encoding_library.utils.vector_db) and the processors' shared schemas.

Every collection is shared across tenants ('{type}_{model}'), with tenancy in
the customer_id partition-key field — these tests pin the naming, the filter
scoping, the creation race tolerance, and that every processor stamps and
declares customer_id.

Run (needs pymilvus for the schema tests):
    pytest tests -q
"""
import sys
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState
from encoding_library.processors.processor_factory import ProcessorFactory
from encoding_library.utils.vector_db import (
    KNOWN_TYPE_TOKENS,
    collection_data_type,
    customer_filter,
    ensure_collection,
    escape_filter_value,
    shared_collection_name,
)


class SharedCollectionNameTests(unittest.TestCase):
    def test_model_suffix_with_dashes_replaced(self):
        self.assertEqual(
            shared_collection_name("notes", "voyage-4-large"), "notes_voyage_4_large"
        )

    def test_platform_default_model_when_none(self):
        self.assertEqual(
            shared_collection_name("memory"), "memory_all_MiniLM_L6_v2"
        )


class CollectionDataTypeTests(unittest.TestCase):
    def test_shared_names_resolve_to_their_type(self):
        for token in KNOWN_TYPE_TOKENS:
            self.assertEqual(collection_data_type(f"{token}_voyage_4_large"), token)

    def test_legacy_and_unknown_names_resolve_to_none(self):
        self.assertIsNone(collection_data_type("CU92726CAF17F6_notes_voyage_4_large"))
        self.assertIsNone(collection_data_type("CU92726CAF17F6"))
        self.assertIsNone(collection_data_type("memorybank_x"))


class CustomerFilterTests(unittest.TestCase):
    def test_bare_filter(self):
        self.assertEqual(customer_filter("cust-1"), 'customer_id == "cust-1"')

    def test_extra_expression_is_anded_in_parens(self):
        self.assertEqual(
            customer_filter("cust-1", 'note_key == "k"'),
            'customer_id == "cust-1" and (note_key == "k")',
        )

    def test_customer_id_is_escaped(self):
        self.assertEqual(
            customer_filter('c"1\\x'), 'customer_id == "c\\"1\\\\x"'
        )

    def test_escape_filter_value(self):
        self.assertEqual(escape_filter_value('a"b\\c'), 'a\\"b\\\\c')


class EnsureCollectionTests(unittest.TestCase):
    def test_existing_collection_is_not_recreated(self):
        client = MagicMock()
        client.has_collection.return_value = True
        self.assertFalse(ensure_collection(client, "notes_m", "schema", "index"))
        client.create_collection.assert_not_called()

    def test_missing_collection_is_created(self):
        client = MagicMock()
        client.has_collection.return_value = False
        self.assertTrue(ensure_collection(client, "notes_m", "schema", "index"))
        client.create_collection.assert_called_once_with(
            collection_name="notes_m", schema="schema", index_params="index"
        )

    def test_lost_creation_race_is_tolerated(self):
        client = MagicMock()
        # Missing at the check, created concurrently before our create lands.
        client.has_collection.side_effect = [False, True]
        client.create_collection.side_effect = Exception("already exists")
        self.assertFalse(ensure_collection(client, "notes_m", "schema", "index"))

    def test_real_creation_failure_is_raised(self):
        client = MagicMock()
        client.has_collection.return_value = False
        client.create_collection.side_effect = Exception("quota exceeded")
        with self.assertRaises(Exception):
            ensure_collection(client, "notes_m", "schema", "index")


# requires-python is >=3.9: no PEP 604 unions in this file.
def _state(data_type: str, raw_data: Optional[dict] = None) -> MemoryRequestInternalState:
    return MemoryRequestInternalState(
        data_type=data_type,
        customer_id="cust-1",
        client="test",
        raw_data=raw_data or {},
        model_type="voyage",
        model_name="voyage-4-large",
    )


class ProcessorSharedSchemaTests(unittest.TestCase):
    """Every processor names a shared collection and declares the customer_id
    partition key in its schema."""

    DATA_TYPES = {
        "Email": "email_voyage_4_large",
        "NOTE": "notes_voyage_4_large",
        "MEMORY": "memory_voyage_4_large",
        "CONVERSATION": "conversation_voyage_4_large",
        "INSTRUCTION": "instructions_voyage_4_large",
    }

    def test_collection_names_are_shared_not_per_customer(self):
        for data_type, expected in self.DATA_TYPES.items():
            state = _state(data_type)
            processor = ProcessorFactory.get_processor(state)
            self.assertEqual(processor.get_collection_name(state), expected)

    def test_schemas_declare_the_customer_id_partition_key(self):
        for data_type in self.DATA_TYPES:
            processor = ProcessorFactory.get_processor(_state(data_type))
            schema, _index = processor.get_collection_schema(dim=4)
            field = next((f for f in schema.fields if f.name == "customer_id"), None)
            self.assertIsNotNone(field, f"{data_type} schema lacks customer_id")
            self.assertTrue(field.is_partition_key, f"{data_type} customer_id is not the partition key")


class ProcessorRecordStampingTests(unittest.TestCase):
    def test_memory_records_carry_customer_id(self):
        state = _state("MEMORY", {"memory_key": "MEM#1", "memory_value": "v"})
        processor = ProcessorFactory.get_processor(state)
        records = processor.prepare_for_vector_db(state, [{"vector": [0.1], "text": "v"}])
        self.assertEqual(records[0]["customer_id"], "cust-1")
        self.assertEqual(records[0]["id"], "MEM#1_0")

    def test_email_ids_are_customer_prefixed_against_cross_tenant_collisions(self):
        raw = {
            "message_id": "mid@example.com",
            "subject": "s",
            "body": "b",
            "from": "a@example.com",
            "to": ["b@example.com"],
            "date": "2026-01-01T00:00:00",
            "folder": "inbox",
        }
        state = _state("Email", raw)
        processor = ProcessorFactory.get_processor(state)
        records = processor.prepare_for_vector_db(state, [{"vector": [0.1], "text": "b"}])
        self.assertEqual(records[0]["id"], "cust-1:mid@example.com")
        self.assertEqual(records[0]["customer_id"], "cust-1")


if __name__ == "__main__":
    unittest.main()
