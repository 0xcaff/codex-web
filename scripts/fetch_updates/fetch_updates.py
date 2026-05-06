#!/usr/bin/env python3
import argparse
import base64
from pathlib import Path
from urllib.parse import urljoin

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from lxml import etree
import requests


APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml"

SPARKLE_VERIFY_KEY = Ed25519PublicKey.from_public_bytes(
    base64.b64decode("rhcBvttuqDFriyNqwTQJR3L4UT1WjIK4QxtwtwusVic=", validate=True)
)


def sparkle_name(name: str) -> str:
    return f"{{http://www.andymatuschak.org/xml-namespaces/sparkle}}{name}"


def safe_path_component(value: str) -> str:
    if "/" in value or "\0" in value:
        raise ValueError(f"Unexpected path separator in component: {value!r}")
    return value


def verify_sparkle_signature(data: bytes, signature: str) -> None:
    try:
        decoded_signature = base64.b64decode(signature, validate=True)
        SPARKLE_VERIFY_KEY.verify(decoded_signature, data)
    except InvalidSignature as e:
        raise RuntimeError("Sparkle signature verification failed") from e


def download_enclosure(enclosure: etree._Element, dest: Path) -> None:
    url = urljoin(APPCAST_URL, enclosure.attrib["url"])
    ed_signature = enclosure.attrib[sparkle_name("edSignature")]

    with requests.get(url, timeout=120) as resp:
        resp.raise_for_status()
        data = resp.content

    verify_sparkle_signature(data, ed_signature)

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)


def process_item(version_dir, item):
    version_xml = version_dir / "version.xml"

    if version_xml.is_file():
        print(f"Already staged {version_dir}")
        return

    full_enclosure = item.find("enclosure")
    if full_enclosure is None:
        raise RuntimeError(f"Missing full update enclosure for {version_dir}")

    version_dir.mkdir(parents=True, exist_ok=True)
    download_enclosure(
        full_enclosure,
        version_dir / "update.zip",
        )

    for delta in item.findall(f"{sparkle_name('deltas')}/enclosure"):
        delta_from = safe_path_component(delta.attrib[sparkle_name("deltaFrom")])
        download_enclosure(
            delta,
            version_dir / "deltas" / f"{delta_from}.delta",
            )

    version_xml.write_text(
        etree.tostring(item, encoding="unicode", pretty_print=True),
        encoding="utf-8",
    )

    print(f"Staged {version_dir}")

def run(args: argparse.Namespace) -> None:
    output_root = Path(args.output).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    resp = requests.get(APPCAST_URL, timeout=30)
    resp.raise_for_status()

    root = etree.fromstring(
        resp.content, parser=etree.XMLParser(resolve_entities=False, no_network=True)
    )
    for item in root.findall("./channel/item"):
        sparkle_version = safe_path_component(item.find(sparkle_name("version")).text)
        short_version = safe_path_component(
            item.find(sparkle_name("shortVersionString")).text
        )
        version_dir = output_root / f"{sparkle_version}-{short_version}"

        try:
            process_item(version_dir, item)
        except Exception as e:
            print(f"error {e} for {version_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch and stage Codex Desktop Sparkle updates."
    )
    parser.add_argument("output", help="Destination root directory")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
