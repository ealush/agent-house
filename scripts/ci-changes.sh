#!/usr/bin/env bash
# Which parts of the repository a pull request touches, for CI (.github/workflows/ci.yml):
# prints server=true|false and ios=true|false (to $GITHUB_OUTPUT when set) and why.
#
#   scripts/ci-changes.sh <base sha>      # a pull request: what changed since its base
#   scripts/ci-changes.sh                 # anything else (a push to main, a manual run): everything
#
# server: the server's own jobs (tests, browser, security). ios: the app's (Swift on Linux,
# the simulator and Mac Catalyst on macOS). The app-against-server integration runs for
# either. A change to the contract (packages/protocol) or to anything both sides build with
# (the workspace, the CI itself) is both. When unsure — no base, an unreadable diff — it's
# both: a missed check costs more than a long run.
set -euo pipefail
cd "$(dirname "$0")/.."
base=${1:-}
server=false ios=false
both() { server=true ios=true; }
out() {
  echo "server=$server ios=$ios"
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then
    { echo "server=$server"; echo "ios=$ios"; } >> "$GITHUB_OUTPUT"
  fi
}

if [[ -z $base ]] || ! files=$(git diff --name-only "$base"...HEAD 2>/dev/null); then
  echo "no base to compare with: checking everything"
  both
  out
  exit 0
fi
while IFS= read -r f; do
  [[ -z $f ]] && continue
  case $f in
    apps/server/*) server=true; why="server" ;;
    apps/ios/*) ios=true; why="app" ;;
    packages/protocol/*) both; why="contract: both" ;;
    bin/*) server=true; why="server (its root entry points)" ;;
    .github/*|mise.toml|scripts/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml) both; why="workspace: both" ;;
    *) why="neither (docs)" ;;
  esac
  echo "  $f → $why"
done <<< "$files"
out
