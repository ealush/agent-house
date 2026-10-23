#!/usr/bin/env bash
# Runs the native client's integration tests against a disposable ah host.
#
#   AH_SOURCE=../ah ./scripts/integration.sh [extra swift test args]
#
# AH_SOURCE is an ah checkout with the native device sign-in routes (its node_modules
# installed). SWIFT overrides the swift binary. Nothing touches your real ah or tmux.
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFT=${SWIFT:-swift}
export AH_SOURCE=${AH_SOURCE:-../ah}

fifo=$(mktemp -u)
mkfifo "$fifo"
# The host lives as long as this fd stays open; closing it cleans the host up.
node scripts/it-host.mjs < "$fifo" > "$fifo.out" 2> "$fifo.err" &
host=$!
exec 3> "$fifo"
cleanup() {
  exec 3>&- || true
  wait "$host" 2>/dev/null || true
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
echo "integration host on 127.0.0.1:$AH_IT_PORT"
"$SWIFT" test --filter Integration "$@"
