"""Unit tests for routes.probe_models (stdlib unittest + mock, no pytest harness).

The probe is what keeps the embedding dropdown honest, so its three behaviours
are pinned: endpoint dispatch matches the production encoder, per-response
classification is correct, and a single auth failure never wipes the list.
Run: `python -m unittest tests.test_probe_models`.
"""
import unittest
from unittest.mock import AsyncMock, patch

import routes.probe_models as pm
from routes.probe_models import (
    _AUTH_ERROR,
    _INCONCLUSIVE,
    _SUPPORTED,
    _UNSUPPORTED,
    ProbeVendorCredentials,
    _endpoint_and_payload,
    _probe_one,
    _probe_vendor,
)


class EndpointDispatchTest(unittest.TestCase):
    def test_voyage_text_model_uses_embeddings_endpoint(self):
        url, payload = _endpoint_and_payload("voyage", "voyage-4-large")
        self.assertEqual(url, "https://api.voyageai.com/v1/embeddings")
        self.assertEqual(payload["model"], "voyage-4-large")

    def test_voyage_context_model_uses_contextualized_endpoint(self):
        url, payload = _endpoint_and_payload("voyage", "voyage-context-4")
        self.assertEqual(url, "https://api.voyageai.com/v1/contextualizedembeddings")
        self.assertIn("inputs", payload)

    def test_openai_uses_openai_endpoint(self):
        url, payload = _endpoint_and_payload("openai", "text-embedding-3-small")
        self.assertEqual(url, "https://api.openai.com/v1/embeddings")


class _Resp:
    def __init__(self, status_code):
        self.status_code = status_code


class ProbeOneClassificationTest(unittest.IsolatedAsyncioTestCase):
    async def _verdict_for_status(self, status):
        client = AsyncMock()
        client.post.return_value = _Resp(status)
        return await _probe_one(client, "voyage", "voyage-4", "k")

    async def test_200_is_supported(self):
        self.assertEqual(await self._verdict_for_status(200), _SUPPORTED)

    async def test_400_and_404_are_unsupported(self):
        self.assertEqual(await self._verdict_for_status(400), _UNSUPPORTED)
        self.assertEqual(await self._verdict_for_status(404), _UNSUPPORTED)

    async def test_401_is_auth_error(self):
        self.assertEqual(await self._verdict_for_status(401), _AUTH_ERROR)

    async def test_429_and_500_are_inconclusive(self):
        self.assertEqual(await self._verdict_for_status(429), _INCONCLUSIVE)
        self.assertEqual(await self._verdict_for_status(500), _INCONCLUSIVE)

    async def test_transport_error_is_inconclusive(self):
        import httpx

        client = AsyncMock()
        client.post.side_effect = httpx.ConnectError("boom")
        self.assertEqual(await _probe_one(client, "voyage", "voyage-4", "k"), _INCONCLUSIVE)


class ProbeVendorAggregationTest(unittest.IsolatedAsyncioTestCase):
    async def test_splits_supported_and_inconclusive(self):
        verdicts = {
            "voyage-4-large": _SUPPORTED,
            "voyage-multimodal-3.5": _UNSUPPORTED,
            "voyage-3": _INCONCLUSIVE,
        }
        with patch.object(pm, "_list_provider_models", return_value=list(verdicts)), \
             patch.object(pm, "_probe_one", new=AsyncMock(side_effect=lambda c, p, m, k: verdicts[m])):
            result = await _probe_vendor(ProbeVendorCredentials(provider="voyage", api_key="k"))
        self.assertIsNone(result.error)
        self.assertEqual(result.supported, ["voyage-4-large"])
        self.assertEqual(result.inconclusive, ["voyage-3"])
        self.assertNotIn("voyage-multimodal-3.5", result.supported)

    async def test_auth_error_wipes_nothing(self):
        with patch.object(pm, "_list_provider_models", return_value=["voyage-4"]), \
             patch.object(pm, "_probe_one", new=AsyncMock(return_value=_AUTH_ERROR)):
            result = await _probe_vendor(ProbeVendorCredentials(provider="voyage", api_key="bad"))
        self.assertEqual(result.error, "authentication failed")
        self.assertEqual(result.supported, [])
        self.assertEqual(result.inconclusive, [])

    async def test_unknown_provider_errors(self):
        with patch.object(pm, "_list_provider_models", side_effect=Exception("nope")):
            result = await _probe_vendor(ProbeVendorCredentials(provider="weird", api_key="k"))
        self.assertIsNotNone(result.error)
        self.assertEqual(result.supported, [])


if __name__ == "__main__":
    unittest.main()
