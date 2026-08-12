#!/usr/bin/env bash
set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/tree"
if node scripts/check_compatibility.mjs "$fixture/tree" >/dev/null 2>&1; then
  echo "compatibility gate accepted a missing target" >&2
  exit 1
fi
