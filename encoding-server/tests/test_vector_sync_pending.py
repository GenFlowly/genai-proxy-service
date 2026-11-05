"""A record's VectorSyncPending row is deleted once its vectors are stored, and
a failure to delete never fails the store step."""
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")

from handlers.vector_sync_pending import clear_pending, registry_item_key  # noqa: E402


class RegistryItemKeyTest(unittest.TestCase):
    def test_conversation_rows_are_keyed_by_the_assistant_message(self):
        self.assertEqual(
            registry_item_key("CONVERSATION", {"conversation_key": "c-1", "message_key": "m-1"}),
            "conversation#m-1",
        )
        self.assertEqual(registry_item_key("CONVERSATION", {"messageKey": "m-2"}), "conversation#m-2")

    def test_note_rows_are_keyed_by_the_note(self):
        self.assertEqual(registry_item_key("NOTE", {"note_key": "n-1"}), "notes#n-1")
        self.assertEqual(registry_item_key("NOTE", {"note_id": "n-2"}), "notes#n-2")

    def test_other_types_and_missing_keys_have_no_row(self):
        self.assertIsNone(registry_item_key("INSTRUCTION", {"instruction_id": "i-1"}))
        self.assertIsNone(registry_item_key("EMAIL", {"message_id": "e-1"}))
        self.assertIsNone(registry_item_key("NOTE", {}))


class ClearPendingTest(unittest.TestCase):
    def test_deletes_the_row(self):
        dynamodb = mock.Mock()
        with mock.patch.dict(os.environ, {"VECTOR_SYNC_PENDING_TABLE": "VSP-test"}):
            clear_pending("CU-1", "NOTE", {"note_key": "n-1"}, dynamodb=dynamodb)
        dynamodb.delete_item.assert_called_once_with(
            TableName="VSP-test",
            Key={"customerId": {"S": "CU-1"}, "itemKey": {"S": "notes#n-1"}},
        )

    def test_types_without_a_row_touch_nothing(self):
        dynamodb = mock.Mock()
        clear_pending("CU-1", "INSTRUCTION", {"instruction_id": "i-1"}, dynamodb=dynamodb)
        dynamodb.delete_item.assert_not_called()

    def test_a_failed_delete_never_raises(self):
        dynamodb = mock.Mock()
        dynamodb.delete_item.side_effect = RuntimeError("throttled")
        clear_pending("CU-1", "CONVERSATION", {"message_key": "m-1"}, dynamodb=dynamodb)


if __name__ == "__main__":
    unittest.main()
