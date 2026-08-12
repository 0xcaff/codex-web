import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lxml import etree

sys.path.insert(0, str(Path(__file__).parent))
import fetch_updates


class DownloadEnclosureTests(unittest.TestCase):
    def enclosure(self):
        return etree.fromstring(
            b'<enclosure url="update.zip" sparkle:edSignature="invalid" '
            b'xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" />'
        )

    def response(self, body):
        class Response:
            content = body

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def raise_for_status(self):
                return None

        return Response()

    def test_invalid_signature_leaves_no_staged_file(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "update.zip"
            with patch.object(fetch_updates.requests, "get", return_value=self.response(b"bad")):
                with self.assertRaises(RuntimeError):
                    fetch_updates.download_enclosure(self.enclosure(), dest)
            self.assertFalse(dest.exists())
            self.assertEqual(list(dest.parent.glob(".update.zip.*")), [])

    def test_validated_download_is_atomically_staged(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "update.zip"
            with (
                patch.object(fetch_updates.requests, "get", return_value=self.response(b"good")),
                patch.object(fetch_updates, "verify_sparkle_signature") as verify,
            ):
                fetch_updates.download_enclosure(self.enclosure(), dest)
            self.assertEqual(dest.read_bytes(), b"good")
            verify.assert_called_once_with(b"good", "invalid")


if __name__ == "__main__":
    unittest.main()
