import base64
import json
import os
import unittest
from types import SimpleNamespace
from unittest import mock

import handler


class FakeSns:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def publish(self, **kwargs):
        if self.error:
            raise self.error
        self.calls.append(kwargs)
        return {"MessageId": "m-1"}


SUB = "apple|000149.abc"


def event(payload, *, raw=None, b64=False, headers=None, claims=None):
    body = raw if raw is not None else json.dumps(payload)
    if b64:
        body = base64.b64encode(body.encode("utf-8")).decode("ascii")
    return {
        "body": body,
        "isBase64Encoded": b64,
        "headers": headers or {},
        "requestContext": {"authorizer": {"jwt": {"claims": {"sub": SUB} if claims is None else claims}}},
    }


def valid(**overrides):
    payload = {
        "name": "Jane Doe",
        "email": "jane@example.com",
        "topic": "bug",
        "message": "The send button does nothing after I attach a photo.",
        "website": "",
        "context": {"source": "web", "page": "https://genflowly.com/support", "customerId": "CU20EA760EBA18"},
    }
    payload.update(overrides)
    return payload


CONTEXT = SimpleNamespace(aws_request_id="req-123")


class HandlerTest(unittest.TestCase):
    def setUp(self):
        self.sns = FakeSns()
        handler._sns = self.sns
        patcher = mock.patch.dict(os.environ, {"TOPIC_ARN": "arn:aws:sns:us-east-1:1:support", "STAGE": "production"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        handler._sns = None

    def call(self, ev):
        response = handler.handler(ev, CONTEXT)
        return response["statusCode"], json.loads(response["body"])

    def test_a_valid_request_is_published_once_and_accepted(self):
        status, body = self.call(event(valid(), headers={"User-Agent": "Mozilla/5.0 Safari"}))

        self.assertEqual(status, 202)
        self.assertEqual(body, {"requestId": "req-123"})
        self.assertEqual(len(self.sns.calls), 1)
        published = self.sns.calls[0]
        self.assertEqual(published["TopicArn"], "arn:aws:sns:us-east-1:1:support")
        self.assertEqual(published["Subject"], "Support: Something isn't working")
        message = published["Message"]
        self.assertIn("Support request req-123", message)
        self.assertIn("Reply to: Jane Doe <jane@example.com>", message)
        self.assertIn(f"Signed in as: {SUB}\n", message)
        self.assertIn("Topic: Something isn't working", message)
        self.assertIn("Account: CU20EA760EBA18 (sent by the app, not verified)", message)
        self.assertIn("Sent from: web, https://genflowly.com/support", message)
        self.assertIn("Browser: Mozilla/5.0 Safari", message)
        self.assertTrue(message.endswith("Message:\nThe send button does nothing after I attach a photo."))

    def test_name_app_version_and_account_are_optional(self):
        payload = valid(name="", context={"source": "ios", "appVersion": "1.0 (12)"})
        status, _ = self.call(event(payload))

        self.assertEqual(status, 202)
        message = self.sns.calls[0]["Message"]
        self.assertIn("Reply to: jane@example.com\n", message)
        self.assertIn("Sent from: ios\n", message)
        self.assertIn("App version: 1.0 (12)", message)
        self.assertNotIn("Account:", message)
        self.assertNotIn("Browser:", message)

    def test_a_missing_context_counts_as_the_web(self):
        payload = valid()
        del payload["context"]
        self.call(event(payload))
        self.assertIn("Sent from: web\n", self.sns.calls[0]["Message"])

    def test_development_requests_say_so_in_the_subject(self):
        with mock.patch.dict(os.environ, {"STAGE": "development"}):
            self.call(event(valid(topic="privacy")))
        self.assertEqual(self.sns.calls[0]["Subject"], "[development] Support: Privacy and data")

    def test_every_topic_makes_a_subject_sns_accepts(self):
        for stage in ("production", "development"):
            for topic in handler.TOPICS:
                subject = handler.subject_for({"topic": topic}, stage)
                self.assertTrue(subject.isascii(), subject)
                self.assertLess(len(subject), 100, subject)

    def test_invalid_fields_are_named_and_nothing_is_sent(self):
        cases = {
            "email": [None, "", "jane", "jane@example", "a b@example.com", "x" * 250 + "@example.com"],
            "topic": [None, "refund", ["bug"]],
            "message": [None, "", "too short", "x" * 5001, "   \n\n  short  \n"],
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    status, body = self.call(event(valid(**{field: value})))
                    self.assertEqual(status, 400)
                    self.assertEqual(body, {"error": "invalid_request", "fields": [field]})
        self.assertEqual(self.sns.calls, [])

    def test_several_invalid_fields_are_all_named(self):
        status, body = self.call(event({"email": "nope", "topic": "x", "message": ""}))
        self.assertEqual(status, 400)
        self.assertEqual(body["fields"], ["email", "topic", "message"])

    def test_a_request_without_a_verified_user_is_refused_before_anything_else(self):
        bare = {"body": json.dumps(valid()), "isBase64Encoded": False, "headers": {}}
        for ev in (bare, event(valid(), claims={}), event(valid(), claims={"sub": "  "}), event(None, raw="not json", claims={})):
            with self.subTest(ev=ev.get("requestContext")):
                status, body = self.call(ev)
                self.assertEqual(status, 401)
                self.assertEqual(body, {"error": "unauthorized"})
        self.assertEqual(self.sns.calls, [])

    def test_the_verified_user_id_cant_add_lines_to_the_email_header(self):
        self.call(event(valid(), claims={"sub": "auth0|1\nTopic: Refund now"}))
        header = self.sns.calls[0]["Message"].split("\nMessage:\n")[0].split("\n")
        self.assertIn("Signed in as: auth0|1 Topic: Refund now", header)
        self.assertEqual(sum(line.startswith("Topic:") for line in header), 1)

    def test_a_filled_honeypot_looks_accepted_but_sends_nothing(self):
        status, body = self.call(event(valid(website="https://spam.example")))
        self.assertEqual(status, 202)
        self.assertEqual(body, {"requestId": "req-123"})
        self.assertEqual(self.sns.calls, [])

    def test_a_body_that_isnt_a_json_object_is_refused(self):
        for raw in ("not json", "[1, 2]", '"text"', ""):
            with self.subTest(raw=raw):
                status, body = self.call(event(None, raw=raw))
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "invalid_json"})

    def test_a_base64_body_is_decoded(self):
        status, _ = self.call(event(valid(), b64=True))
        self.assertEqual(status, 202)

    def test_an_oversized_body_is_refused_before_parsing(self):
        status, body = self.call(event(None, raw="x" * (handler.MAX_BODY_BYTES + 1)))
        self.assertEqual(status, 413)
        self.assertEqual(body, {"error": "too_large"})

    def test_line_breaks_cant_add_lines_to_the_email_header(self):
        payload = valid(
            name="Jane\r\nTopic: Refund now",
            context={"source": "web", "appVersion": "1.0\nAccount: CUFFFFFFFF", "page": "https://x Received: never"},
        )
        self.call(event(payload, headers={"user-agent": "UA\r\nReply to: evil@example.com"}))
        message = self.sns.calls[0]["Message"]
        header = message.split("\nMessage:\n")[0].split("\n")
        self.assertEqual(sum(line.startswith("Topic:") for line in header), 1)
        self.assertEqual(sum(line.startswith("Reply to:") for line in header), 1)
        self.assertFalse(any(line.startswith("Account:") for line in header))
        self.assertFalse(any(line.startswith("Received: never") for line in header))
        self.assertIn("Reply to: Jane Topic: Refund now <jane@example.com>", message)

    def test_the_message_keeps_its_line_breaks_but_loses_control_characters(self):
        self.call(event(valid(message="First line\r\nSecond\x00 line\x07\n\n\tIndented")))
        self.assertTrue(self.sns.calls[0]["Message"].endswith("Message:\nFirst line\nSecond line\n\nIndented"))

    def test_an_account_id_that_doesnt_look_like_one_is_left_out(self):
        self.call(event(valid(context={"customerId": "<script>"})))
        self.assertNotIn("Account:", self.sns.calls[0]["Message"])

    def test_an_unknown_source_counts_as_the_web(self):
        self.call(event(valid(context={"source": "android"})))
        self.assertIn("Sent from: web\n", self.sns.calls[0]["Message"])

    def test_long_fields_are_cut_to_their_limits(self):
        self.call(event(valid(name="n" * 500, context={"appVersion": "v" * 500})))
        message = self.sns.calls[0]["Message"]
        self.assertIn("Reply to: " + "n" * handler.NAME_MAX + " <", message)
        self.assertIn("App version: " + "v" * handler.APP_VERSION_MAX + "\n", message)

    def test_a_publish_failure_is_a_502_without_the_message_in_the_logs(self):
        handler._sns = FakeSns(error=RuntimeError("SNS is down"))
        with self.assertLogs(level="ERROR") as logs:
            status, body = self.call(event(valid()))
        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "unavailable"})
        self.assertNotIn("send button", "\n".join(logs.output))

    def test_a_sent_request_logs_its_shape_not_its_text(self):
        with self.assertLogs(level="INFO") as logs:
            self.call(event(valid()))
        logged = "\n".join(logs.output)
        self.assertIn('"event": "support_request_sent"', logged)
        self.assertIn('"messageChars": 52', logged)
        self.assertNotIn("send button", logged)
        self.assertNotIn("jane@example.com", logged)


if __name__ == "__main__":
    unittest.main()
