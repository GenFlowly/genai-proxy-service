"""Environment gate for log lines carrying user content or user identifiers.

Same two-layer policy as the other services (see genai-proxy-server/
development.md, "Logging policy"): production lambdas log WARNING+ only and
never user content; development logs the full INFO narrative. APP_ENV is set
on every lambda by the CDK stacks (production/development from the deploy
STAGE); unset — e.g. a local run — means development.
"""

import logging
import os

_ENV = (os.getenv("APP_ENV") or os.getenv("STAGE") or "development").strip().lower()
IS_PRODUCTION = _ENV == "production"
LOG_USER_CONTENT = not IS_PRODUCTION


def default_log_level() -> int:
    """Root log level: WARNING in production, INFO elsewhere.
    An explicit LOG_LEVEL env var overrides either."""
    name = (os.getenv("LOG_LEVEL") or ("WARNING" if IS_PRODUCTION else "INFO")).strip().upper()
    return getattr(logging, name, logging.INFO)


def mask_sub(sub) -> str:
    """Auth sub for a log line: full in development, 'provider|ab…' in
    production (subs are pseudonymous user identifiers)."""
    if sub is None:
        return "null"
    text = str(sub)
    if LOG_USER_CONTENT:
        return text
    sep = text.find("|")
    return (text[: sep + 3] if sep >= 0 else text[:3]) + "…"
