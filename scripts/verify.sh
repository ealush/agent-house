#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --static ) ]]; then
  echo 'Usage: ./scripts/verify.sh [--static]' >&2
  exit 2
fi
python3 scripts/check-workspace.py
bash -n scripts/bootstrap.sh scripts/verify.sh
if [[ "${1:-}" == --static ]]; then
  exit 0
fi
./scripts/bootstrap.sh

destination=${AH_SIMULATOR_DESTINATION:-}
if [[ -z "$destination" ]]; then
  device_id=$(xcrun simctl list devices available --json | python3 -c '
import json,re,sys
devices=json.load(sys.stdin)["devices"]
for runtime, entries in devices.items():
    version=re.search(r"\.iOS-(\d+)", runtime)
    if version and int(version[1]) >= 26:
        for device in entries:
            if device["name"].startswith("iPhone") and device.get("isAvailable"):
                print(device["udid"])
                sys.exit(0)
sys.exit("Install an iOS 26+ iPhone simulator, or set AH_SIMULATOR_DESTINATION.")
')
  destination="platform=iOS Simulator,id=$device_id"
fi
xcodebuild test \
  -project AgentHubNative.xcodeproj \
  -scheme AgentHubNative \
  -destination "$destination" \
  -derivedDataPath DerivedData \
  CODE_SIGNING_ALLOWED=NO

