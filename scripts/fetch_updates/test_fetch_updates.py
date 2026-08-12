import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fetch_updates


class FakeResponse:
    content = b"downloaded update"

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        return None


class FakeEnclosure:
    attrib = {
        "url": "https://example.invalid/update.zip",
        fetch_updates.sparkle_name("edSignature"): "invalid",
    }


class DownloadEnclosureTests(unittest.TestCase):
    def test_invalid_signature_is_not_staged(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "update.zip"
            with (
                patch.object(fetch_updates.requests, "get", return_value=FakeResponse()),
                patch.object(
                    fetch_updates,
                    "verify_sparkle_signature",
                    side_effect=RuntimeError("invalid signature"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "invalid signature"):
                    fetch_updates.download_enclosure(FakeEnclosure(), destination)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
