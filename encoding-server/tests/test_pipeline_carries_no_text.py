"""The indexing pipeline end to end: SQS messages, Step Functions inputs and
batch payloads (and therefore the dead-letter queue, which receives the
execution input) carry ids only, while embedding still reads the real text
from the source tables."""
import json
import os
import unittest
from unittest import mock

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("STATE_MACHINE_ARN", "arn:aws:states:us-east-1:000000000000:stateMachine:test")

from encoding_library.processors.note_processor import NoteProcessor  # noqa: E402

from handlers import create_and_store_lambda, ingest_notes_lambda, parse_and_chunk_lambda, trigger_lambda  # noqa: E402
from services import content_source  # noqa: E402
from tests.test_content_source import FakeTables  # noqa: E402

SECRET = "SECRET-DIARY-ENTRY"
NOTE_TEXT = " ".join(f"{SECRET}-{i}" for i in range(60))


def word_chunks(text, encoder, chunking_type=None, chunking_technique=None, chunk_size=None, chunk_overlap=None):
    """Deterministic stand-in for create_chunks: one word per chunk."""
    return text.split()


def note_pointer(note_key="nk-1"):
    return {
        "data_type": "NOTE", "customer_id": "CU1", "client": "react-app",
        "raw_data": {"note_key": note_key, "created_at": "2026-11-05T00:00:00Z"},
        "model_type": "voyage", "model_name": "voyage-4-large", "request_id": "rid-1",
    }


class PipelineTest(unittest.TestCase):

    def setUp(self):
        self.tables = FakeTables()
        self.tables.put("CustomerNotes", {
            "customerId": "CU1", "noteKey": "nk-1", "noteValue": NOTE_TEXT, "title": "Diary",
        })
        for patcher in (
            mock.patch.object(content_source, "_get_item", side_effect=self.tables.get_item),
            mock.patch.object(parse_and_chunk_lambda, "create_chunks", side_effect=word_chunks),
            mock.patch.object(parse_and_chunk_lambda, "get_chunking_params", return_value=(1, 0)),
            mock.patch.object(create_and_store_lambda, "create_chunks", side_effect=word_chunks),
            mock.patch.object(create_and_store_lambda, "get_chunking_params", return_value=(1, 0)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def assertNoText(self, payload):
        self.assertNotIn(SECRET, json.dumps(payload))
        self.assertNotIn("Diary", json.dumps(payload))

    def test_ingest_queues_keys_only(self):
        sqs = mock.MagicMock()
        sqs.send_message.return_value = {"MessageId": "m-1"}
        auth = mock.MagicMock()
        auth.verify_user.return_value = (True, "CU1", None)
        with mock.patch.object(ingest_notes_lambda, "sqs", sqs), \
                mock.patch.object(ingest_notes_lambda, "auth_service", auth):
            response = ingest_notes_lambda.handler({"body": json.dumps({
                "dataType": "NOTE", "client": "react-app", "modelType": "voyage",
                "modelName": "voyage-4-large",
                "data": {"note_key": "nk-1", "note_value": NOTE_TEXT, "title": "Diary",
                         "created_at": "2026-11-05T00:00:00Z"},
            })}, None)

        self.assertEqual(response["statusCode"], 202)
        body = json.loads(sqs.send_message.call_args.kwargs["MessageBody"])
        self.assertNoText(body)
        self.assertEqual(body["raw_data"]["note_key"], "nk-1")
        self.assertEqual(body["customer_id"], "CU1")

    def test_trigger_strips_text_from_messages_queued_before_the_change(self):
        legacy_body = {**note_pointer(), "raw_data": {"note_key": "nk-1", "note_value": NOTE_TEXT,
                                                      "title": "Diary", "created_at": "t"}}
        sfn = mock.MagicMock()
        sfn.start_execution.return_value = {"executionArn": "arn:exec"}
        context = mock.MagicMock(aws_request_id="req-1")
        with mock.patch.object(trigger_lambda, "sfn", sfn):
            result = trigger_lambda.handler(
                {"Records": [{"messageId": "m-1", "body": json.dumps(legacy_body)}]}, context
            )

        self.assertEqual(result["batchItemFailures"], [])
        execution_input = json.loads(sfn.start_execution.call_args.kwargs["input"])
        self.assertNoText(execution_input)
        self.assertEqual(execution_input["raw_data"], {"note_key": "nk-1", "created_at": "t"})

    def test_parse_and_chunk_returns_a_chunk_plan_without_chunks(self):
        result = parse_and_chunk_lambda.handler(note_pointer(), None)

        batches = result["batches"]
        self.assertNoText(result)
        self.assertEqual([b["chunk_offset"] for b in batches], [0, 25, 50])
        self.assertEqual([b["chunk_count"] for b in batches], [25, 25, 11])
        self.assertTrue(all(b["chunk_total"] == 61 for b in batches))  # title + 60 words
        self.assertTrue(all(b["data_chunks"] is None for b in batches))
        self.assertTrue(all((b["chunk_size"], b["chunk_overlap"]) == (1, 0) for b in batches))
        self.assertEqual(len({b["content_sha256"] for b in batches}), 1)

    def test_deleted_note_plans_no_batches(self):
        self.tables.put("CustomerNotes", {"customerId": "CU1", "noteKey": "nk-1", "noteValue": NOTE_TEXT,
                                          "is_delete": True})
        self.assertEqual(parse_and_chunk_lambda.handler(note_pointer(), None), {"batches": []})

    def _store(self, batch, ddb=None):
        inserted = []
        milvus = mock.MagicMock()
        milvus.insert.side_effect = lambda collection_name, data: inserted.extend(data) or {"insert_count": len(data)}

        def fake_embeddings(chunks, encoder, customer_id=None):
            return [{"text": c, "vector": [0.0, 1.0], "index": i} for i, c in enumerate(chunks)]

        with mock.patch.object(create_and_store_lambda, "get_embedding_model_for_customer"), \
                mock.patch.object(create_and_store_lambda, "create_embeddings", side_effect=fake_embeddings), \
                mock.patch.object(create_and_store_lambda, "get_milvus_client", return_value=milvus), \
                mock.patch.object(create_and_store_lambda, "ensure_collection", return_value=False), \
                mock.patch.object(NoteProcessor, "get_collection_schema", return_value=(None, None)), \
                mock.patch("boto3.client", return_value=ddb or mock.MagicMock()):
            summary = create_and_store_lambda.handler(dict(batch), None)
        return summary, inserted

    def _plan(self):
        return parse_and_chunk_lambda.handler(note_pointer(), None)["batches"]

    def test_store_embeds_its_slice_of_the_reloaded_text(self):
        summary, inserted = self._store(self._plan()[1])

        self.assertNoText(summary)
        self.assertEqual(summary["inserted"], 25)
        self.assertEqual([r["id"] for r in inserted], [f"nk-1_{i}" for i in range(25, 50)])
        self.assertEqual(inserted[0]["note_value"], f"{SECRET}-24")  # word 25 follows the title

    def test_store_skips_a_batch_whose_note_changed_after_planning(self):
        plan = self._plan()
        self.tables.put("CustomerNotes", {"customerId": "CU1", "noteKey": "nk-1", "noteValue": "edited",
                                          "title": "Diary"})
        summary, inserted = self._store(plan[1])
        self.assertEqual((summary["inserted"], inserted), (0, []))

    def test_a_plan_mismatch_makes_the_first_batch_embed_everything(self):
        drifted = [{**b, "chunk_total": 99} for b in self._plan()]
        first, first_rows = self._store(drifted[0])
        later, later_rows = self._store(drifted[1])
        self.assertEqual(first["inserted"], 61)
        self.assertEqual(len({r["id"] for r in first_rows}), 61)
        self.assertEqual((later["inserted"], later_rows), (0, []))

    def test_marking_a_note_synced_requires_its_row(self):
        ddb = mock.MagicMock()

        self._store(self._plan()[0], ddb=ddb)

        [call] = [c for c in ddb.update_item.call_args_list if c.kwargs.get("TableName") == "CustomerNotes"]
        self.assertEqual("attribute_exists(noteKey)", call.kwargs["ConditionExpression"])

    def test_a_note_deleted_while_it_was_stored_is_not_brought_back_or_counted_as_a_failure(self):
        from botocore.exceptions import ClientError

        ddb = mock.MagicMock()
        ddb.update_item.side_effect = ClientError(
            {"Error": {"Code": "ConditionalCheckFailedException", "Message": "missing"}}, "UpdateItem"
        )
        with mock.patch.object(create_and_store_lambda, "count") as counted:
            summary, _ = self._store(self._plan()[0], ddb=ddb)

        names = [c.args[0] for c in counted.call_args_list]
        self.assertIn("vector_store_note_deleted_total", names)
        self.assertNotIn("vector_store_ddb_writeback_failure_total", names)
        self.assertEqual(25, summary["inserted"])

    def test_batches_planned_before_the_change_still_store_their_chunks(self):
        legacy_batch = {**note_pointer(), "raw_data": {"note_key": "nk-1", "created_at": "t"},
                        "data_chunks": ["alpha", "beta"], "chunk_offset": 25}
        with mock.patch.object(content_source, "_get_item") as no_reads:
            summary, inserted = self._store(legacy_batch)
        no_reads.assert_not_called()
        self.assertEqual([r["id"] for r in inserted], ["nk-1_25", "nk-1_26"])
        self.assertEqual(summary["inserted"], 2)


if __name__ == "__main__":
    unittest.main()
