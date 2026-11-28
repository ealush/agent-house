#!/usr/bin/env bash
# Tag the commit an App Store release of the app was built from: `ios/v<version>`. At that
# commit the app, what it needs of a host (AppProtocol.requires) and the server it was tested
# against are one tree, so the tag is the pin between them: a host's Settings → System says
# which releases its checkout contains (`git tag --merged HEAD 'ios/v*'`), and
# `git show ios/v<version>:apps/ios/Sources/Networking/AppProtocol.swift` says what that
# release asks of any host.
#
#   scripts/tag-app-release.sh <version> [<commit>]          # tag it here (commit: HEAD)
#   scripts/tag-app-release.sh <version> [<commit>] --push   # and push the tag to origin
#
# The commit's MARKETING_VERSION (apps/ios/project.yml, the app and both extensions) must be
# <version>, and it must be on origin's main: a release is built from main. A tag that exists
# already is never moved.
set -euo pipefail
cd "$(dirname "$0")/.."

push=0
args=()
for a in "$@"; do
  case "$a" in
    --push) push=1 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) args+=("$a") ;;
  esac
done
if [ "${#args[@]}" -lt 1 ] || [ "${#args[@]}" -gt 2 ]; then
  echo 'usage: scripts/tag-app-release.sh <version> [<commit>] [--push]' >&2
  exit 2
fi
version="${args[0]}"
commit="$(git rev-parse --verify "${args[1]:-HEAD}^{commit}")"
tag="ios/v$version"

if ! [[ "$version" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "$version isn't a version like 1.2 or 1.2.3" >&2
  exit 1
fi
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "$tag already tags $(git rev-parse --short "$tag^{commit}"); a release's tag never moves" >&2
  exit 1
fi

versions="$(git show "$commit:apps/ios/project.yml" | sed -n 's/^ *MARKETING_VERSION: *//p' | sort -u)"
if [ "$versions" != "$version" ]; then
  echo "$(git rev-parse --short "$commit") builds MARKETING_VERSION $(echo "$versions" | paste -sd, -), not $version" >&2
  exit 1
fi

git fetch --quiet origin main
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "$(git rev-parse --short "$commit") isn't on origin/main: tag the main commit the release was built from" >&2
  exit 1
fi

git tag -a "$tag" "$commit" -m "Agent House $version for iOS, iPadOS and Mac (App Store), with the server it was tested against"
echo "tagged $tag at $(git log -1 --format='%h %s' "$commit")"
if [ "$push" = 1 ]; then
  git push origin "refs/tags/$tag"
else
  echo "push it with: git push origin refs/tags/$tag"
fi
