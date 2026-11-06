"""S3ArtifactStore sends object tags with the write, so a bucket lifecycle
rule can expire tagged objects (agent scratch files); an untagged write
sends no Tagging header at all."""
import unittest
from unittest.mock import MagicMock

from graph_tools.storage import S3ArtifactStore


class S3ArtifactStoreTagTests(unittest.TestCase):
    def test_tags_go_with_the_write_url_encoded(self):
        client = MagicMock()

        S3ArtifactStore("bucket", client=client).put("k", b"x", "text/plain", tags={"retention": "scratch"})

        self.assertEqual("retention=scratch", client.put_object.call_args.kwargs["Tagging"])

    def test_an_untagged_write_sends_no_tagging(self):
        client = MagicMock()

        S3ArtifactStore("bucket", client=client).put("k", b"x", "text/plain")

        self.assertNotIn("Tagging", client.put_object.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
