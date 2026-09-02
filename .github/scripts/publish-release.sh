#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: .github/scripts/publish-release.sh <version> [asset...]"
  echo "Release notes must exist in release-notes/<version>.json."
  exit 1
fi

version="$1"
shift
assets=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    *)
      assets+=("$1")
      shift
      ;;
  esac
done

# Never derive user-facing release notes from commit titles. The reviewed,
# versioned record is the single source for both this GitHub Release body and
# the structured asset read by the desktop update sheet.
node .github/scripts/release-notes.js validate "$version"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh (GitHub CLI) is not installed."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  if [[ -z "${GH_TOKEN:-}" ]]; then
    token="$(python3 - <<'PY'
import json, os, sys
path = os.path.join(os.path.expanduser("~"), ".modelswap", "user.json")
try:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    token = (data.get("repo", {}) or {}).get("github", {}).get("token", "")
    if token:
        sys.stdout.write(token)
except Exception:
    pass
PY
)"
    if [[ -n "$token" ]]; then
      export GH_TOKEN="$token"
    fi
  fi

  if ! gh auth status >/dev/null 2>&1; then
    echo "Error: gh is not authenticated. Run: gh auth login"
    exit 1
  fi
fi

if [[ ${#assets[@]} -eq 0 ]]; then
  # CLI ships via npm only — the sole binary artifact is the desktop dmg
  # (built by CI's electron-builder step before this script runs).
  release_dir="dist/release/$version"
  mkdir -p "$release_dir"

  for dmg in release/*.dmg; do
    [[ -f "$dmg" ]] || continue
    cp "$dmg" "$release_dir/"
    # SHA256 sidecar must reference the BARE filename: `shasum --check` runs
    # in the downloader's directory, and a build-machine path inside the
    # file breaks the check.
    (cd "$release_dir" && shasum -a 256 "$(basename "$dmg")" > "$(basename "$dmg").sha256")
    assets+=("$release_dir/$(basename "$dmg")" "$release_dir/$(basename "$dmg").sha256")
  done

  node .github/scripts/release-notes.js copy "$version" "$release_dir/release-notes.json"
  node .github/scripts/release-notes.js render "$version" "$release_dir/release-notes.md"
  assets+=("$release_dir/release-notes.json")

  if [[ ${#assets[@]} -eq 0 ]]; then
    echo "Error: no dmg found in release/. Run the electron-builder step first."
    exit 1
  fi
fi

notes_file="$(mktemp)"
node .github/scripts/release-notes.js render "$version" "$notes_file"

if git rev-parse "$version" >/dev/null 2>&1; then
  echo "Tag $version already exists."
else
  git tag -a "$version" -m "Release $version"
  git push origin "$version"
fi

if gh release view "$version" >/dev/null 2>&1; then
  gh release upload "$version" "${assets[@]}" --clobber
  gh release edit "$version" --notes-file "$notes_file"
  # If the matched release is a draft (e.g. left behind by an earlier run),
  # publishing the assets is not enough — flip it to a real release.
  gh release edit "$version" --draft=false
else
  gh release create "$version" "${assets[@]}" --title "$version" --notes-file "$notes_file"
fi

echo "Release $version updated."
