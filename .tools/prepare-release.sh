#!/usr/bin/env bash
set -euo pipefail

# Prepare a release: bump every published package to <version>, commit and
# tag. Nothing is pushed: push the commit and the tag yourself (the script
# prints the command), which triggers .github/workflows/release.yml. That
# workflow checks the tagged commit, builds the addon for every platform,
# and publishes the packages to npm.
#
# The published packages are the workspace's packages without `private`:
# the libraries (packages/*) and the addon's package per platform
# (packages/sessions/npm/*). They are always released together, with the
# same version.
#
# Usage:
#   ./.tools/prepare-release.sh 0.2.0
#   ./.tools/prepare-release.sh 0.3.0-rc.1

SELF_PATH=${BASH_SOURCE[0]:-"$(command -v -- "$0")"}
PROJECT_ROOT="$(cd "$(dirname "$SELF_PATH")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

VERSION="${1#v}"
TAG="v$VERSION"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version '$VERSION', expected e.g. 0.2.0 or 0.3.0-rc.1" >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "Not on a branch, checkout the branch to release from first" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree is not clean, commit or stash your changes first" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists" >&2
  exit 1
fi

# The packages published: every package.json of the workspace without `private`.
PACKAGES=()
for pkg in packages/*/package.json packages/sessions/npm/*/package.json; do
  if [[ "$(jq -r '.private // false' "$pkg")" != true ]]; then
    PACKAGES+=("$pkg")
  fi
done
if [[ ${#PACKAGES[@]} -eq 0 ]]; then
  echo "No package to publish: every package.json is private" >&2
  exit 1
fi

for pkg in "${PACKAGES[@]}"; do
  jq --arg ver "$VERSION" '.version = $ver' "$pkg" >"$pkg.tmp" && mv "$pkg.tmp" "$pkg"
  echo "$(jq -r '.name' "$pkg") $VERSION ($pkg)"
done
# Their formatting, as `pnpm lint` checks it.
pnpm exec oxfmt "${PACKAGES[@]}" >/dev/null

# The packages at the version already (the first release, say): the tag goes
# on HEAD, without a commit.
if git diff --quiet; then
  echo "Every package is at $VERSION already: tagging HEAD"
else
  git commit -aqm "Release $TAG"
fi
git tag -a "$TAG" -m "Release $TAG"

if UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)"; then
  REMOTE="${UPSTREAM%%/*}"
  BRANCH="${UPSTREAM#*/}"
else
  REMOTE="origin"
fi

echo
echo "Created commit and tag $TAG. To release, push both:"
echo
echo "  git push --atomic $REMOTE HEAD:$BRANCH $TAG"
