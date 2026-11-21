#!/usr/bin/env bash
# Builds the app, unsigned, for the iOS simulator and for the Mac (Mac Catalyst): the compile
# check without running tests (scripts/verify.sh runs them). macOS with Xcode 26+.
#
#   ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d AgentHubNative.xcodeproj ]] || ./scripts/bootstrap.sh
for destination in 'generic/platform=iOS Simulator' 'platform=macOS,variant=Mac Catalyst'; do
  echo "building for $destination"
  xcodebuild build \
    -project AgentHubNative.xcodeproj \
    -scheme AgentHubNative \
    -destination "$destination" \
    -derivedDataPath DerivedData \
    -skipPackagePluginValidation \
    -quiet \
    CODE_SIGNING_ALLOWED=NO
done
