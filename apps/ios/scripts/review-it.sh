#!/usr/bin/env bash
# The native client's review flows against a disposable stack: the demo host's three stacked
# pull requests on orbit-api, behind its stand-in `gh` and a bare repository playing GitHub.
# Nothing reaches GitHub and nothing merges anywhere but that bare repository; your real ah
# and tmux are never touched (the host's tmux server is stopped by its own socket).
#
#   AH_SOURCE=../ah ./scripts/review-it.sh [extra swift test args]
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFT=${SWIFT:-swift}
export AH_SOURCE=${AH_SOURCE:-../ah}

dir=$(mktemp -d "${TMPDIR:-/tmp}/ah-review-it-XXXXXX")
fifo="$dir.fifo"
mkfifo "$fifo"
# The host lives as long as this fd stays open.
node scripts/demo/host.mjs --dir "$dir" < "$fifo" > "$dir.out" 2> "$dir.err" &
host=$!
exec 3> "$fifo"
cleanup() {
  exec 3>&- || true
  wait "$host" 2>/dev/null || true
  # Its own tmux server, by its socket: a bare `tmux kill-server` could reach yours.
  sock="$dir/tmux/tmux-$(id -u)/default"
  if [[ -S "$sock" ]]; then tmux -S "$sock" kill-server 2>/dev/null || true; fi
  [[ -n "${AH_IT_LOG:-}" ]] && cp "$dir.err" "$AH_IT_LOG" 2>/dev/null
  rm -rf "$dir" "$fifo" "$dir.out" "$dir.err"
}
trap cleanup EXIT

for _ in $(seq 1 360); do [[ -s "$dir.out" ]] && break; sleep 0.5; done
line=$(head -n1 "$dir.out")
[[ -n "$line" ]] || { echo "the demo host didn't start:" >&2; tail -20 "$dir.err" >&2; exit 1; }
export AH_IT_PORT=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$line")
export AH_IT_TOKEN=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["localToken"])' "$line")
export AH_IT_DIR="$dir"
export AH_REVIEW_DIR="$dir"
echo "review fixture host on 127.0.0.1:$AH_IT_PORT ($dir)"
"$SWIFT" test --filter ReviewIntegrationTests "$@"
