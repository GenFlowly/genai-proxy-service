"""A rate-limited durable LLM step waits as long as the vendor says before
re-sending, instead of spending its 1s/2s backoff retries inside the same full
rate-limit window (production 2026-11-23: three attempts in 5s against
"Please try again in 13.319s", then DBOS Error 7)."""
import asyncio
import time
import unittest
from unittest import mock

import httpx
import openai

from graph.nodes import llm_node
from graph.nodes.llm_node import (
    _invoke_llm_waiting_out_rate_limits,
    _is_transient_llm_error,
    _vendor_retry_after_sec,
)

_OPENAI_TPM = (
    "Rate limit reached for gpt-6.2-sol in project proj_r5xN6CYsCQlVbUUvvw6onf3a "
    "organization org-JG2Qoik3eDdHpygP6XwktKJL on tokens per min (TPM): Limit 50000, "
    "Used 46240, Requested 14859. Please try again in {wait}. "
    "Visit https://platform.openai.com/account/rate-limits to learn more."
)


def _openai_error(message: str) -> openai.APIError:
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    return openai.APIError(message, request, body=None)


def _tpm_error(wait: str) -> openai.APIError:
    return _openai_error(_OPENAI_TPM.format(wait=wait))


def _http_429(headers: dict) -> openai.RateLimitError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(429, headers=headers, request=request)
    return openai.RateLimitError("Error code: 429 - rate_limit_error", response=response, body=None)


class VendorRetryAfterTests(unittest.TestCase):
    def test_reads_openai_go_durations(self):
        self.assertAlmostEqual(_vendor_retry_after_sec(_tpm_error("13.319s")), 13.319)
        self.assertAlmostEqual(_vendor_retry_after_sec(_tpm_error("441ms")), 0.441)
        self.assertAlmostEqual(_vendor_retry_after_sec(_tpm_error("1m30s")), 90.0)

    def test_reads_retry_after_headers(self):
        self.assertAlmostEqual(_vendor_retry_after_sec(_http_429({"retry-after-ms": "2500"})), 2.5)
        self.assertAlmostEqual(_vendor_retry_after_sec(_http_429({"retry-after": "7"})), 7.0)

    def test_no_stated_wait_or_not_a_rate_limit(self):
        self.assertIsNone(_vendor_retry_after_sec(_http_429({})))
        self.assertIsNone(_vendor_retry_after_sec(_openai_error("Request timed out. Please try again in 5s.")))
        self.assertIsNone(_vendor_retry_after_sec(_openai_error(
            "429 You exceeded your current quota, please check your plan and billing details. "
            "Please try again in 5s."
        )))


class WaitOutRateLimitTests(unittest.TestCase):
    def _run(self, outcomes):
        """Run the step's invoke against a fake vendor that yields `outcomes` in
        order (an exception is raised); returns (result, sleeps)."""
        calls = iter(outcomes)

        async def fake_invoke(llm, structured_llm, messages):
            outcome = next(calls)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        sleeps = []

        async def fake_sleep(sec):
            sleeps.append(sec)

        with mock.patch.object(llm_node, "_invoke_llm", fake_invoke), \
                mock.patch.object(llm_node.asyncio, "sleep", fake_sleep):
            result = asyncio.run(_invoke_llm_waiting_out_rate_limits(None, None, [], "openai"))
        return result, sleeps

    def test_waits_the_stated_time_then_succeeds(self):
        ok = ("response", None, None)
        result, sleeps = self._run([_tpm_error("13.319s"), _tpm_error("11.582s"), ok])
        self.assertEqual(result, ok)
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(13.319 < sleeps[0] <= 14.319)
        self.assertTrue(11.582 < sleeps[1] <= 12.582)

    def test_a_wait_past_the_budget_fails_without_sleeping_or_backoff_retry(self):
        error = _tpm_error("6m0s")
        with self.assertRaises(openai.APIError) as raised:
            self._run([error])
        self.assertIs(raised.exception, error)
        # DBOS must not re-send it 1s/2s later either: the vendor said 6 minutes.
        self.assertFalse(_is_transient_llm_error(error))

    def test_budget_is_shared_across_waits(self):
        with mock.patch.object(llm_node, "_LLM_RATE_LIMIT_WAIT_BUDGET_SEC", 20.0):
            with self.assertRaises(openai.APIError):
                self._run([_tpm_error("13s"), _tpm_error("13s")])

    def test_other_errors_raise_at_once(self):
        error = _openai_error("Request timed out.")
        with self.assertRaises(openai.APIError):
            self._run([error])
        # ...and keep the DBOS backoff retry.
        self.assertTrue(_is_transient_llm_error(error))

    def test_rate_limit_without_a_stated_wait_keeps_the_backoff_retry(self):
        error = _http_429({})
        with self.assertRaises(openai.RateLimitError):
            self._run([error])
        self.assertTrue(_is_transient_llm_error(error))

    def test_real_wait_outlasts_the_vendor_window(self):
        """No mocked sleep: a vendor that rejects until its window resets (0.4s
        here, 13s in production) is answered on the first re-send."""
        window_resets_at = time.monotonic() + 0.4
        sent_at = []

        async def vendor(llm, structured_llm, messages):
            sent_at.append(time.monotonic())
            if time.monotonic() < window_resets_at:
                raise _tpm_error("400ms")
            return ("response", None, None)

        with mock.patch.object(llm_node, "_invoke_llm", vendor):
            result = asyncio.run(_invoke_llm_waiting_out_rate_limits(None, None, [], "openai"))
        self.assertEqual(result, ("response", None, None))
        self.assertEqual(len(sent_at), 2)


if __name__ == "__main__":
    unittest.main()
