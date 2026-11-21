#!/usr/bin/env bash
# Every check this machine can run, in one go, then a summary: what passed, what failed, and
# what couldn't run here and why. A skipped check is not a pass: it's listed, and with
# --strict it fails the run. `mise run check` runs this; CI runs the same steps, split by
# platform (.github/workflows).
#
#   scripts/check.sh [--strict]
#
# Linux runs the server, the web build, the database and the app's portable checks; Swift
# adds the app's package tests and the app-against-server integration; macOS with Xcode adds
# the app's simulator, UI and Mac Catalyst builds.
set -uo pipefail
cd "$(dirname "$0")/.."
strict=0
case "${1:-}" in
  --strict) strict=1 ;;
  '') ;;
  *) echo 'usage: scripts/check.sh [--strict]' >&2; exit 2 ;;
esac

server=apps/server
ios=apps/ios
results=()
failed=0
skipped=0
have() { command -v "$1" >/dev/null 2>&1; }
step() {
  local name=$1 dir=$2
  shift 2
  echo
  echo "━━ $name"
  if (cd "$dir" && "$@"); then
    results+=("PASS  $name")
  else
    results+=("FAIL  $name")
    failed=$((failed + 1))
  fi
}
skip() {
  results+=("SKIP  $1 — $2")
  skipped=$((skipped + 1))
}

if [[ ! -d node_modules || ! -d $server/node_modules ]]; then
  echo "No node_modules: run \`mise run setup\` (pnpm install) first." >&2
  exit 1
fi

# ---------- the workspace itself
step 'workspace: mise.toml parses untrusted (the systemd unit runs node through it)' . scripts/check-mise.sh

# ---------- server and web client (anywhere with Node and tmux)
step 'server: typecheck' "$server" pnpm typecheck
step 'server: web build' "$server" pnpm build
step 'server: prisma schema and migrations' "$server" pnpm prisma:check
if have tmux; then
  step 'server: tests (unit, API, lifecycle, security)' "$server" pnpm test
else
  skip 'server: tests' 'no tmux on PATH'
fi
browser=$(cd "$server" && node -e "
const { existsSync } = require('node:fs');
let bundled; try { bundled = require('playwright-core').chromium.executablePath(); } catch {}
const found = [process.env.AH_CHROMIUM, bundled, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
process.stdout.write(found ?? '');" 2>/dev/null)
if [[ -n $browser ]] && have tmux; then
  step 'server: page in a real browser' "$server" env AH_UI_DIST=dist pnpm test:ui
else
  skip 'server: page in a real browser' 'no Chromium (pnpm exec playwright-core install chromium, or AH_CHROMIUM)'
fi

# ---------- the app's portable checks (anywhere with Python and Node)
step 'ios: static (scaffold, links, plists, provenance)' "$ios" ./scripts/verify.sh --static
step 'ios: every server route reachable from the app' "$ios" node scripts/backend-coverage.mjs
step 'protocol: the app'"'"'s API version and feature gates match the server' . node packages/protocol/check-app.mjs

# ---------- Swift: the app's package, and the app against a real server
if have swift; then
  step 'ios: swift test (portable package)' "$ios" swift test
  if have tmux && have python3; then
    step 'integration: app against a disposable host' "$ios" ./scripts/integration.sh
    step 'integration: app review flows against the demo stack' "$ios" ./scripts/review-it.sh
  else
    skip 'integration' 'needs tmux and python3'
  fi
else
  skip 'ios: swift test (portable package)' 'no Swift toolchain (Xcode on macOS; swift.org or the swift:6.4 container on Linux)'
  skip 'integration: app against a disposable host' 'no Swift toolchain'
  skip 'integration: app review flows against the demo stack' 'no Swift toolchain'
fi

# ---------- Apple platforms (macOS with Xcode and XcodeGen)
if [[ $(uname -s) == Darwin ]] && have xcodebuild && have xcodegen; then
  step 'ios: simulator unit + UI tests, Mac Catalyst build' "$ios" ./scripts/verify.sh
else
  skip 'ios: simulator unit + UI tests, Mac Catalyst build' 'needs macOS with Xcode 26+ and XcodeGen'
fi

echo
echo '━━ summary'
printf '%s\n' "${results[@]}"
if ((failed)); then
  echo "$failed failed, $skipped not run here."
  exit 1
fi
if ((skipped)); then
  echo "Nothing failed; $skipped not run here, so they're unverified on this machine."
  ((strict)) && exit 1
  exit 0
fi
echo 'Everything ran and passed.'
