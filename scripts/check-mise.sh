#!/usr/bin/env bash
# mise.toml must parse without `mise trust`: the systemd unit runs node through mise's shims
# from this checkout, and an untrusted config that needs trust (templates, tool options)
# makes the shim — and the server — fail to start. Parses a copy in a folder nobody
# trusted; without mise, refuses what's known to need trust.
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -n -E '\{\{|\{%' mise.toml; then echo 'mise.toml: templates need `mise trust`; the service would not start' >&2; exit 1; fi
if awk '/^\[tools\]/{t=1;next} /^\[/{t=0} t && /=[[:space:]]*\{/' mise.toml | grep .; then echo 'mise.toml: tool options need `mise trust`; the service would not start' >&2; exit 1; fi
if command -v mise >/dev/null; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  cp mise.toml "$tmp/"
  (cd "$tmp" && env -u MISE_TRUSTED_CONFIG_PATHS mise current node >/dev/null) || { echo 'mise.toml does not parse untrusted: the service would not start' >&2; exit 1; }
  echo 'mise.toml parses untrusted (mise current node)'
else
  echo 'mise.toml has no templates or tool options (mise not installed: static check only)'
fi
