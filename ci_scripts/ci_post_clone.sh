#!/usr/bin/env bash
# Xcode Cloud runs this right after cloning, before it resolves packages and builds. The project
# is generated (project.yml), not committed, so it's made here; and SwiftTerm's build plugin
# needs trusting, as `-skipPackagePluginValidation` does for a local build.
set -euo pipefail
cd "$(dirname "$0")/.."

defaults write com.apple.dt.Xcode IDESkipPackagePluginFingerprintValidatation -bool YES
defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES

command -v xcodegen >/dev/null || brew install xcodegen
xcodegen generate --spec project.yml

# Xcode Cloud doesn't resolve packages itself: it builds the versions the project's resolved
# file names, and a generated project has none. This is that file, as a Mac's resolve wrote it
# (AgentHubNative.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved after
# scripts/bootstrap.sh); copy it here again when a package in project.yml changes.
resolved=AgentHubNative.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
mkdir -p "$resolved"
cp ci_scripts/Package.resolved "$resolved/Package.resolved"
