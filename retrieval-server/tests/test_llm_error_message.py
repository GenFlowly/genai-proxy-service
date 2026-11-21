"""A durable LLM step that exhausts its retries surfaces the vendor's error, not
DBOS's "Step llm_invoke has exceeded its maximum of 3 retries"."""
import unittest

import httpx
import openai
from dbos._error import DBOSMaxStepRetriesExceeded

from streaming import user_facing_llm_error

_OPENAI_TPM = (
    "Rate limit reached for gpt-6.2-astra in project proj_r5xN6CYsCQlVbUUvvw6onf3a "
    "organization org-JG2Qoik3eDdHpygP6XwktKJL on tokens per min (TPM): Limit 50000, "
    "Used 36465, Requested 18522. Please try again in 5.985s. "
    "Visit https://platform.openai.com/account/rate-limits to learn more."
)


def _openai_error(message: str) -> openai.APIError:
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    return openai.APIError(message, request, body=None)


class LlmErrorMessageTests(unittest.TestCase):
    def test_exhausted_retries_report_the_last_vendor_error(self):
        errors = [_openai_error(_OPENAI_TPM.replace("36465", "1")), _openai_error(_OPENAI_TPM)]
        kind, message = user_facing_llm_error(
            DBOSMaxStepRetriesExceeded("llm_invoke", 3, errors), "openai"
        )
        self.assertEqual(kind, "rate_limit")
        self.assertEqual(
            message,
            "Rate limit or quota exceeded (openai): Rate limit reached for gpt-6.2-astra "
            "on tokens per min (TPM): Limit 50000, Used 36465, Requested 18522. "
            "Please try again in 5.985s.",
        )

    def test_exhausted_retries_without_errors_keep_the_dbos_message(self):
        kind, message = user_facing_llm_error(
            DBOSMaxStepRetriesExceeded("llm_invoke", 3, []), "openai"
        )
        self.assertEqual(kind, "provider_error")
        self.assertIn("exceeded its maximum of 3 retries", message)

    def test_unwrapped_vendor_error_is_classified_directly(self):
        kind, message = user_facing_llm_error(_openai_error(_OPENAI_TPM), "openai")
        self.assertEqual(kind, "rate_limit")
        self.assertNotIn("proj_", message)
        self.assertNotIn("org-", message)
        self.assertNotIn("platform.openai.com", message)


if __name__ == "__main__":
    unittest.main()
