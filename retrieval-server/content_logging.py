"""Environment gate for log lines that carry user content.

Operational logs (node start/end, counts, models, token usage, errors) stay on
in every environment. Lines that would put conversation content into the log
stream — prompts, system prompts/instructions, LLM responses, memories, user
queries — must check LOG_USER_CONTENT (whole-line content dumps) or pass the
value through redact() (one content field inside an otherwise operational
line), so production never persists user content in logs.

Mirrors the Kotlin proxy's AppConfig convention: APP_ENV == "production"
(set in fly.production.toml) disables content logging; anything else — the
dev Fly app (fly.toml) or an unset var on a local machine — enables it.
"""

import os

LOG_USER_CONTENT: bool = (
    (os.getenv("APP_ENV") or "development").strip().lower() != "production"
)


def redact(value, limit: int = 200) -> str:
    """The value to interpolate into a log line: the real text (truncated to
    `limit`) in development, a placeholder in production."""
    if not LOG_USER_CONTENT:
        return "<redacted>"
    text = value if isinstance(value, str) else str(value)
    return text if len(text) <= limit else text[:limit] + "…"
