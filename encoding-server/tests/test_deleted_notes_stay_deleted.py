"""A deleted note stays deleted: notes are hard-deleted now, and a DynamoDB
update on a missing item creates it, so every pipeline write to a note row
requires the row to exist, and a Voyage batch that finishes after a note was
deleted doesn't store that note's vectors."""
import os
import unittest
from unittest import mock

from botocore.exceptions import ClientError

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from handlers import accumulate_voyage_notes_lambda, voyage_batch_store  # noqa: E402


def _condition_failed():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "missing"}}, "UpdateItem")


class BatchStampTests(unittest.TestCase):
    def test_stamps_require_the_note_and_a_deleted_one_does_not_undo_the_rest(self):
        ddb = mock.MagicMock()
        ddb.update_item.side_effect = [_condition_failed(), {}]
        refs = [
            {"customer_id": "CU1", "note_key": "gone", "s3_key": "CU1/notes/gone.json"},
            {"customer_id": "CU1", "note_key": "live", "s3_key": "CU1/notes/live.json"},
        ]

        with mock.patch.object(accumulate_voyage_notes_lambda, "dynamodb", ddb):
            accumulate_voyage_notes_lambda._stamp_batch("batch-1", refs)

        self.assertEqual(2, ddb.update_item.call_count)
        for call in ddb.update_item.call_args_list:
            self.assertEqual("attribute_exists(noteKey)", call.kwargs["ConditionExpression"])

    def test_other_errors_still_fail_the_submit(self):
        ddb = mock.MagicMock()
        ddb.update_item.side_effect = ClientError({"Error": {"Code": "ThrottlingException"}}, "UpdateItem")

        with mock.patch.object(accumulate_voyage_notes_lambda, "dynamodb", ddb):
            with self.assertRaises(ClientError):
                accumulate_voyage_notes_lambda._stamp_batch(
                    "batch-1", [{"customer_id": "CU1", "note_key": "n", "s3_key": "k"}]
                )

    def test_rolling_a_note_back_to_pending_requires_the_note(self):
        ddb = mock.MagicMock()

        with mock.patch.object(accumulate_voyage_notes_lambda, "dynamodb", ddb):
            accumulate_voyage_notes_lambda._reset_note("CU1", "n")

        self.assertEqual("attribute_exists(noteKey)", ddb.update_item.call_args.kwargs["ConditionExpression"])


class BatchStoreTests(unittest.TestCase):
    def _batch(self, note_key):
        return {"data_type": "NOTE", "customer_id": "CU1", "raw_data": {"note_key": note_key},
                "data_chunks": ["chunk"]}

    def test_a_note_deleted_while_its_batch_ran_gets_no_vectors(self):
        ddb = mock.MagicMock()
        ddb.get_item.side_effect = lambda **kw: (
            {"Item": {"noteKey": {"S": "live"}}} if kw["Key"]["noteKey"]["S"] == "live"
            else {"Item": {"noteKey": {"S": "soft"}, "is_delete": {"BOOL": True}}} if kw["Key"]["noteKey"]["S"] == "soft"
            else {}
        )
        stored = []

        with mock.patch.object(voyage_batch_store, "_dynamodb", ddb), \
                mock.patch.object(voyage_batch_store, "store_embeddings_handler",
                                  side_effect=lambda event, ctx: stored.append(event["raw_data"]["note_key"])):
            count, missing = voyage_batch_store.store_batch_results(
                [self._batch("gone"), self._batch("live"), self._batch("soft")],
                {"b0c0": [0.1], "b1c0": [0.2], "b2c0": [0.3]},
                None,
            )

        self.assertEqual(["live"], stored)
        self.assertEqual((1, 0), (count, missing))
        self.assertTrue(all(call.kwargs["ConsistentRead"] for call in ddb.get_item.call_args_list))


if __name__ == "__main__":
    unittest.main()
