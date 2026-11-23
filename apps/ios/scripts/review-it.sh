#!/usr/bin/env bash
# The native client's review flows against a disposable stack: the demo host's three stacked
# pull requests on orbit-api, behind its stand-in `gh` and a bare repository playing GitHub.
# Nothing reaches GitHub and nothing merges anywhere but that bare repository; your real ah
# and tmux are never touched (the host's tmux server is stopped by its own socket).
#
#   ./scripts/review-it.sh [extra swift test args]
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFT=${SWIFT:-swift}
# This repository's server, unless AH_SOURCE names another ah checkout.
export AH_SOURCE=${AH_SOURCE:-$(cd ../server && pwd)}

dir=$(mktemp -d "${TMPDIR:-/tmp}/ah-review-it-XXXXXX")
fifo="$dir.fifo"
mkfifo "$fifo"
# The host lives as long as this fd stays open.
node scripts/demo/host.mjs --dir "$dir" < "$fifo" > "$dir.out" 2> "$dir.err" &
host=$!
exec 3> "$fifo"
cleanup() {
  exec 3>&- || true
  # Closing the pipe ends the host on Linux, but on macOS it never sees that end of input
  # (its stdin is the FIFO) and waiting would hang forever: ask it to stop as well. It
  # cleans up once either way (its ah, its tmux server, its folder).
  kill -TERM "$host" 2>/dev/null || true
  wait "$host" 2>/dev/null || true
  # Its own tmux server, by its socket: a bare `tmux kill-server` could reach yours.
  sock="$dir/tmux/tmux-$(id -u)/default"
  if [[ -S "$sock" ]]; then tmux -S "$sock" kill-server 2>/dev/null || true; fi
  [[ -n "${AH_IT_LOG:-}" ]] && cp "$dir.err" "$AH_IT_LOG" 2>/dev/null
  # The panes' shells end on the hang-up kill-server sent, and one can still be writing its
  # history into the host's home as rm walks it ("Directory not empty"): try again a moment.
  for _ in $(seq 1 20); do rm -rf "$dir" 2>/dev/null && break; sleep 0.25; done
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
# A run where the suites were skipped (no host reached them) or nothing matched the filter
# is not a pass: say so and fail.
ran() {
  local log status
  log=$(mktemp)
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  if grep -q -E '^➜ Suite .* skipped|Test run with 0 tests' "$log"; then
    echo "integration: suites were skipped or no test matched, so nothing was checked against the host" >&2
    status=1
  fi
  rm -f "$log"
  return "$status"
}
ran "$SWIFT" test --filter ReviewIntegrationTests "$@"
