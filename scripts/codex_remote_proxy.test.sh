#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/bin"
cat >"$test_root/bin/websocat" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CODEX_REMOTE_PROXY_CAPTURE"
EOF
chmod +x "$test_root/bin/websocat"

capture="$test_root/websocat-args"
PATH="$test_root/bin:$PATH" \
  CODEX_REMOTE_PROXY_CAPTURE="$capture" \
  CODEX_UNIX_SOCKET="/tmp/codex-app-server.sock" \
  CODEX_BUFFER_SIZE=4096 \
  "$project_root/scripts/codex_remote_proxy" -c ignored app-server --unused

expected=$'-E\n-t\n-B\n4096\n-\nws-c:unix:/tmp/codex-app-server.sock'
actual="$(<"$capture")"
if [[ "$actual" != "$expected" ]]; then
  echo "unexpected websocat arguments:" >&2
  printf '%s\n' "$actual" >&2
  exit 1
fi

if "$project_root/scripts/codex_remote_proxy" -c 2>/dev/null; then
  echo "expected missing -c value to fail" >&2
  exit 1
fi

if CODEX_UNIX_SOCKET="/tmp/codex-app-server.sock" "$project_root/scripts/codex_remote_proxy" nope 2>/dev/null; then
  echo "expected unsupported mode to fail" >&2
  exit 1
fi
