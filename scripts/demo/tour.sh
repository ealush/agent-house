#!/usr/bin/env bash
# Walks the app on a simulator against a running demo host and saves a screenshot per step.
#
#   node scripts/demo/host.mjs --dir /tmp/ah-demo &         # on this Mac, or tunnelled to its loopback
#   scripts/demo/tour.sh <simulator id> '<steps>' [origin] [setup code]
#
# Steps are TourUITests' (`shot:inbox;tap:Welcome flow;wait:2;shot:session`). Screenshots and
# accessibility trees land in ./tour-out. The origin defaults to http://127.0.0.1:47681; a setup
# code is only needed the first time the simulator pairs.
set -euo pipefail
cd "$(dirname "$0")/../.."
id=${1:?simulator id (xcrun simctl list devices)}
steps=${2:?tour steps}
origin=${3:-http://127.0.0.1:47681}
code=${4:-}
out=$PWD/tour-out
rm -rf "$out" && mkdir -p "$out"
common=(-project AgentHubNative.xcodeproj -scheme AgentHubNative -destination "platform=iOS Simulator,id=$id"
  -derivedDataPath DerivedData -skipPackagePluginValidation
  # Ad-hoc simulator signing: the Keychain needs the app's entitlements.
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=)
[[ -d AgentHubNative.xcodeproj ]] || ./scripts/bootstrap.sh
xcodebuild build-for-testing "${common[@]}" -quiet
TEST_RUNNER_AH_DEMO_ORIGIN=$origin TEST_RUNNER_AH_DEMO_CODE=$code TEST_RUNNER_AH_TOUR=$steps TEST_RUNNER_AH_TOUR_OUT=$out \
  xcodebuild test-without-building "${common[@]}" -only-testing:AgentHubNativeUITests/TourUITests/testTour > "$out/xcodebuild.log" 2>&1 &
xb=$!
# xcodebuild can linger long after the test ends; stop it once the suite reports.
while kill -0 $xb 2>/dev/null; do
  if grep -qE "Test Suite 'Selected tests' (passed|failed)" "$out/xcodebuild.log"; then sleep 5; kill $xb 2>/dev/null || true; break; fi
  sleep 1
done
wait $xb 2>/dev/null || true
grep -E "error:|Test Case .*(passed|failed|skipped)" "$out/xcodebuild.log" | grep -v IDESchemeAction || true
ls "$out"
