"""Support requests from signed-in users, published to the support SNS topic.

API Gateway (HTTP API, payload format 2.0) calls `handler` after its Auth0 JWT
authorizer has accepted the caller's access token. The topic's email
subscribers receive each request as plain text.
"""

import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TOPICS = {
    "account": "Account and sign-in",
    "billing": "Billing and usage",
    "bug": "Something isn't working",
    "feature": "Feature request",
    "privacy": "Privacy and data",
    "other": "Something else",
}
SOURCES = {"web", "ios"}

MAX_BODY_BYTES = 20_000
NAME_MAX = 100
EMAIL_MAX = 254
MESSAGE_MIN = 10
MESSAGE_MAX = 5000
APP_VERSION_MAX = 40
PAGE_MAX = 300
USER_AGENT_MAX = 300
SUB_MAX = 200

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CUSTOMER_ID_RE = re.compile(r"^CU[0-9A-F]{6,30}$")
# Everything below U+0020 plus DEL, except the newline a message keeps.
CONTROL_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")
LINE_BREAK_RE = re.compile(r"[\r\n  ]+")

_sns = None


def _client():
    global _sns
    if _sns is None:
        # Imported here so the tests run without boto3; the Lambda runtime has it.
        import boto3

        _sns = boto3.client("sns")
    return _sns


def _response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _single_line(value, limit):
    """A header-safe string: no line breaks or control characters, trimmed, at most `limit` long."""
    if not isinstance(value, str):
        return ""
    text = CONTROL_RE.sub("", LINE_BREAK_RE.sub(" ", value)).strip()
    return text[:limit]


def _multi_line(value):
    if not isinstance(value, str):
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n")
    return CONTROL_RE.sub("", text).strip()


def _caller(event):
    """The Auth0 user ID the JWT authorizer verified, or "" when the request didn't pass through it."""
    authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
    claims = (authorizer.get("jwt") or {}).get("claims") or {}
    return _single_line(claims.get("sub"), SUB_MAX)


def _read_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", errors="replace")
    return raw


def validate(payload):
    """Returns (request, invalid_fields). `request` is only meaningful when no field is invalid."""
    errors = []

    name = _single_line(payload.get("name"), NAME_MAX)

    email = _single_line(payload.get("email"), EMAIL_MAX + 1)
    if not email or len(email) > EMAIL_MAX or not EMAIL_RE.match(email):
        errors.append("email")

    topic = payload.get("topic")
    if not isinstance(topic, str) or topic not in TOPICS:
        errors.append("topic")

    message = _multi_line(payload.get("message"))
    if not MESSAGE_MIN <= len(message) <= MESSAGE_MAX:
        errors.append("message")

    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    source = context.get("source") if context.get("source") in SOURCES else "web"
    customer_id = _single_line(context.get("customerId"), 40)

    request = {
        "name": name,
        "email": email,
        "topic": topic,
        "message": message,
        "source": source,
        "appVersion": _single_line(context.get("appVersion"), APP_VERSION_MAX),
        "page": _single_line(context.get("page"), PAGE_MAX),
        "customerId": customer_id if CUSTOMER_ID_RE.match(customer_id) else "",
    }
    return request, errors


def subject_for(request, stage):
    # SNS rejects a subject that isn't ASCII or is 100 characters or longer.
    prefix = "" if stage == "production" else f"[{stage}] "
    return f"{prefix}Support: {TOPICS[request['topic']]}"[:99]


def message_for(request, request_id, caller, user_agent, received_at):
    reply_to = f"{request['name']} <{request['email']}>" if request["name"] else request["email"]
    sent_from = request["source"] + (f", {request['page']}" if request["page"] else "")
    lines = [
        f"Support request {request_id}",
        "",
        f"Reply to: {reply_to}",
        f"Signed in as: {caller}",
        f"Topic: {TOPICS[request['topic']]}",
    ]
    if request["customerId"]:
        lines.append(f"Account: {request['customerId']} (sent by the app, not verified)")
    lines.append(f"Sent from: {sent_from}")
    if request["appVersion"]:
        lines.append(f"App version: {request['appVersion']}")
    if user_agent:
        lines.append(f"Browser: {user_agent}")
    lines += [
        f"Received: {received_at.strftime('%Y-%m-%d %H:%M UTC')}",
        "",
        "Message:",
        request["message"],
    ]
    return "\n".join(lines)


def handler(event, context):
    request_id = getattr(context, "aws_request_id", None) or str(uuid.uuid4())

    # The route's authorizer rejects unsigned requests; this guards against the route losing it.
    caller = _caller(event)
    if not caller:
        return _response(401, {"error": "unauthorized"})

    raw = _read_body(event)
    if len(raw.encode("utf-8")) > MAX_BODY_BYTES:
        return _response(413, {"error": "too_large"})
    try:
        payload = json.loads(raw)
    except ValueError:
        return _response(400, {"error": "invalid_json"})
    if not isinstance(payload, dict):
        return _response(400, {"error": "invalid_json"})

    # Hidden form field only bots fill in: answer as if it worked, send nothing.
    if payload.get("website"):
        logger.info(json.dumps({"event": "support_request_dropped", "requestId": request_id, "reason": "honeypot"}))
        return _response(202, {"requestId": request_id})

    request, errors = validate(payload)
    if errors:
        return _response(400, {"error": "invalid_request", "fields": errors})

    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    user_agent = _single_line(headers.get("user-agent"), USER_AGENT_MAX)
    stage = os.environ.get("STAGE", "development")

    try:
        _client().publish(
            TopicArn=os.environ["TOPIC_ARN"],
            Subject=subject_for(request, stage),
            Message=message_for(request, request_id, caller, user_agent, datetime.now(timezone.utc)),
        )
    except Exception:
        logger.exception(json.dumps({"event": "support_request_failed", "requestId": request_id}))
        return _response(502, {"error": "unavailable"})

    # The message text stays out of the logs; it's in the support inbox.
    logger.info(json.dumps({
        "event": "support_request_sent",
        "requestId": request_id,
        "topic": request["topic"],
        "source": request["source"],
        "messageChars": len(request["message"]),
    }))
    return _response(202, {"requestId": request_id})
