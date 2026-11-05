"""services/content_source.py: pipeline messages keep only record keys, and
text reloads from the source tables only for the message's own customer."""
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from encoding_library.models.memory_request_internal_state import MemoryRequestInternalState  # noqa: E402

from services import content_source  # noqa: E402


class FakeTables:
    """In-memory stand-in for the DynamoDB tables content_source reads."""

    KEYS = {
        "CustomerNotes": ("customerId", "noteKey"),
        "Message": ("conversationId", "messageId"),
        "Conversation": ("customerId", "conversationId"),
        "Instructions": ("instructionId", "version"),
        "CustomerMemory": ("customerId", "memoryId"),
    }

    def __init__(self):
        self.rows = {name: {} for name in self.KEYS}

    def put(self, table, item):
        key = tuple(item[k] for k in self.KEYS[table])
        self.rows[table][key] = item

    def get_item(self, table_name, key):
        return self.rows[table_name].get(tuple(key[k] for k in self.KEYS[table_name]))


def state(data_type, raw_data, customer_id="CU1"):
    return MemoryRequestInternalState(
        data_type=data_type, customer_id=customer_id, client="react-app", raw_data=raw_data
    )


class PointerStateTest(unittest.TestCase):

    def test_note_keeps_keys_and_timestamp_only(self):
        pointer = content_source.to_pointer_state({
            "data_type": "NOTE",
            "customer_id": "CU1",
            "raw_data": {
                "notes_id": "n-1", "note_key": "nk-1", "note_value": "my diary",
                "title": "Private", "created_at": "2026-11-05T00:00:00Z",
            },
            "data_chunks": ["my diary"],
            "vectors": [[0.1]],
        })
        self.assertEqual(
            pointer["raw_data"],
            {"notes_id": "n-1", "note_key": "nk-1", "created_at": "2026-11-05T00:00:00Z"},
        )
        self.assertIsNone(pointer["data_chunks"])
        self.assertIsNone(pointer["vectors"])
        self.assertEqual(pointer["customer_id"], "CU1")

    def test_every_source_backed_type_drops_its_text(self):
        cases = {
            "CONVERSATION": {"conversation_key": "c", "message_key": "m", "text": "User: hi", "title": ""},
            "INSTRUCTION": {"instruction_id": "i", "version": 2, "name": "Coach", "instructions": "Be kind",
                            "category": "Health", "tags": ["x"]},
            "MEMORY": {"memory_key": "MEM#1", "memory_value": "Lives in Pune", "title": "[memory] home"},
        }
        for data_type, raw_data in cases.items():
            with self.subTest(data_type):
                pointer = content_source.to_pointer_state({"data_type": data_type, "raw_data": raw_data})
                for text_field in ("text", "title", "name", "instructions", "category", "tags", "memory_value"):
                    self.assertNotIn(text_field, pointer["raw_data"])

    def test_email_has_no_source_table_and_is_left_alone(self):
        message = {"data_type": "Email", "raw_data": {"message_id": "e1", "body": "hello"}}
        self.assertIs(content_source.to_pointer_state(message), message)
        self.assertFalse(content_source.is_source_backed("Email"))
        self.assertTrue(content_source.is_source_backed("note"))


class LoadRawDataTest(unittest.TestCase):

    def setUp(self):
        self.tables = FakeTables()
        patcher = mock.patch.object(content_source, "_get_item", side_effect=self.tables.get_item)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_note_reloads_text_and_title(self):
        self.tables.put("CustomerNotes", {
            "customerId": "CU1", "noteKey": "nk-1", "noteValue": "my diary", "title": "Private",
            "noteCreatedAt": "2026-01-01T00:00:00Z",
        })
        loaded = content_source.load_raw_data(state("NOTE", {"note_key": "nk-1", "notes_id": "n-1"}))
        self.assertEqual(loaded, {
            "note_key": "nk-1", "note_value": "my diary", "title": "Private",
            "created_at": "2026-01-01T00:00:00Z", "notes_id": "n-1",
        })

    def test_deleted_or_missing_note_loads_nothing(self):
        self.tables.put("CustomerNotes", {"customerId": "CU1", "noteKey": "gone", "noteValue": "x", "is_delete": True})
        self.assertIsNone(content_source.load_raw_data(state("NOTE", {"note_key": "gone"})))
        self.assertIsNone(content_source.load_raw_data(state("NOTE", {"note_key": "never"})))

    def test_note_lookup_is_scoped_to_the_message_customer(self):
        self.tables.put("CustomerNotes", {"customerId": "CU2", "noteKey": "nk-1", "noteValue": "theirs"})
        self.assertIsNone(content_source.load_raw_data(state("NOTE", {"note_key": "nk-1"}, customer_id="CU1")))

    def _exchange(self, author="CU1", user_text="what is 2+2", assistant_text="4"):
        self.tables.put("Message", {"conversationId": "conv-1", "messageId": "u-1", "customerId": author,
                                    "role": "user", "text": user_text})
        self.tables.put("Message", {"conversationId": "conv-1", "messageId": "a-1", "customerId": author,
                                    "role": "assistant", "text": assistant_text, "previousMessageId": "u-1"})

    def test_conversation_exchange_matches_what_the_proxy_used_to_send(self):
        self._exchange()
        loaded = content_source.load_raw_data(state("CONVERSATION", {
            "conversation_key": "conv-1", "message_key": "a-1", "created_at": "t0",
        }))
        self.assertEqual(loaded, {
            "conversation_key": "conv-1", "message_key": "a-1",
            "text": "User: what is 2+2\nAssistant: 4", "title": "", "created_at": "t0",
        })

    def test_each_side_of_an_exchange_is_capped(self):
        self._exchange(user_text="u" * 40_000, assistant_text="a" * 40_000)
        text = content_source.load_raw_data(
            state("CONVERSATION", {"conversation_key": "conv-1", "message_key": "a-1"})
        )["text"]
        cap = content_source.MAX_EXCHANGE_SIDE_CHARS
        self.assertEqual(text, f"User: {'u' * cap}\nAssistant: {'a' * cap}")

    def test_forked_rows_load_for_the_fork_owner(self):
        self._exchange(author="CU-original-author")
        self.tables.put("Conversation", {"customerId": "CU1", "conversationId": "conv-1"})
        loaded = content_source.load_raw_data(
            state("CONVERSATION", {"conversation_key": "conv-1", "message_key": "a-1"})
        )
        self.assertIn("Assistant: 4", loaded["text"])

    def test_someone_elses_exchange_loads_nothing(self):
        self._exchange(author="CU2")
        self.tables.put("Conversation", {"customerId": "CU2", "conversationId": "conv-1"})
        self.assertIsNone(content_source.load_raw_data(
            state("CONVERSATION", {"conversation_key": "conv-1", "message_key": "a-1"}, customer_id="CU1")
        ))

    def test_instruction_loads_only_for_its_creator(self):
        self.tables.put("Instructions", {
            "instructionId": "ins-1", "version": 2, "creator": "CU1", "name": "Coach",
            "instructions": "Be kind", "category": "Health", "tags": ["a", "b"],
        })
        loaded = content_source.load_raw_data(state("INSTRUCTION", {"instruction_id": "ins-1", "version": "2"}))
        self.assertEqual(loaded["instructions"], "Be kind")
        self.assertEqual(loaded["version"], 2)
        self.assertEqual(loaded["tags"], ["a", "b"])
        self.assertIsNone(content_source.load_raw_data(
            state("INSTRUCTION", {"instruction_id": "ins-1", "version": 2}, customer_id="CU2")
        ))

    def test_memory_reloads_text_with_the_proxys_title(self):
        self.tables.put("CustomerMemory", {"customerId": "CU1", "memoryId": "MEM#1", "text": "Lives in Pune",
                                           "kind": "CORE", "createdAt": "t1"})
        loaded = content_source.load_raw_data(state("MEMORY", {"memory_key": "MEM#1"}))
        self.assertEqual(loaded, {"memory_key": "MEM#1", "memory_value": "Lives in Pune",
                                  "title": "[memory] core", "created_at": "t1"})

    def test_types_without_a_source_table_are_refused(self):
        with self.assertRaises(ValueError):
            content_source.load_raw_data(state("Email", {"message_id": "e1"}))


if __name__ == "__main__":
    unittest.main()
