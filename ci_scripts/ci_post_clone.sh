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
