#!/usr/bin/env bash
# Runs the native client's integration tests against a disposable ah host.
#
#   ./scripts/integration.sh [extra swift test args]
#
# The host is this repository's server, apps/server (its node_modules installed: pnpm
# install at the root); AH_SOURCE points at another server instead: the folder with its
# server/ and test/ (a checkout's apps/server, or the root of an ah from before the move). SWIFT overrides the swift binary. Nothing touches your real ah or tmux.
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFT=${SWIFT:-swift}
# This repository's server, unless AH_SOURCE names another ah checkout.
export AH_SOURCE=${AH_SOURCE:-$(cd ../server && pwd)}

# Every route this ah answers has a way in from the app (or a stated reason it doesn't).
node scripts/backend-coverage.mjs

fifo=$(mktemp -u)
mkfifo "$fifo"
# The host lives as long as this fd stays open; closing it cleans the host up.
node scripts/it-host.mjs < "$fifo" > "$fifo.out" 2> "$fifo.err" &
host=$!
exec 3> "$fifo"
cleanup() {
  exec 3>&- || true
  # Closing the pipe ends the host on Linux, but on macOS it never sees that end of input
  # (its stdin is the FIFO) and waiting would hang forever: ask it to stop as well. It
  # cleans up once either way (its ah, its tmux server, its folder).
  kill -TERM "$host" 2>/dev/null || true
  wait "$host" 2>/dev/null || true
  # AH_IT_LOG=<file> keeps the host's log (ah's own stdout/stderr) for debugging.
  [[ -n "${AH_IT_LOG:-}" ]] && cp "$fifo.err" "$AH_IT_LOG" 2>/dev/null
  rm -f "$fifo" "$fifo.out" "$fifo.err"
}
trap cleanup EXIT

for _ in $(seq 1 300); do
  [[ -s "$fifo.out" ]] && break
  if ! kill -0 "$host" 2>/dev/null; then cat "$fifo.err" >&2; exit 1; fi
  sleep 0.1
done
line=$(head -n1 "$fifo.out")
[[ -n "$line" ]] || { echo "ah didn't start" >&2; cat "$fifo.err" >&2; exit 1; }

export AH_IT_PORT=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["port"])' "$line")
export AH_IT_TOKEN=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["localToken"])' "$line")
export AH_IT_KEYS=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["keys"])' "$line")
export AH_IT_QUESTION_KEYS=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["questionKeys"])' "$line")
# The host's own folder: its private tmux server (TMUX_TMPDIR) lives under it.
export AH_IT_DIR=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["dir"])' "$line")
echo "integration host on 127.0.0.1:$AH_IT_PORT"
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
# Serialized: ah has a create-window race when the tmux session is new (two
# concurrent POST /api/windows both run tmux new-session); see docs/native/RISKS.md.
# ReviewIntegrationTests runs against its own demo stack in review-it.sh.
ran "$SWIFT" test --no-parallel --filter Integration --skip ReviewIntegrationTests "$@"
