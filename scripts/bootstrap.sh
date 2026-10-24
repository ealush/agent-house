#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Native project generation requires macOS with Xcode 26+ and XcodeGen 2.44+.' >&2
  exit 1
fi
command -v xcodegen >/dev/null || { echo 'Install XcodeGen: brew install xcodegen' >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo 'Install and select the full Xcode 26+ app.' >&2; exit 1; }
version=$(xcodebuild -version | awk '/^Xcode / && !v { v = $2 } END { print v }')
if [[ -z "$version" || "${version%%.*}" -lt 26 ]]; then
  echo 'Select Xcode 26 or newer before generating the project.' >&2
  exit 1
fi
xcodegen generate --spec project.yml
xcodebuild -resolvePackageDependencies -project AgentHubNative.xcodeproj -scheme AgentHubNative

