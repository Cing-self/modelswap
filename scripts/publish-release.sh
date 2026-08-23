#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/publish-release.sh <version> [--auto-notes] [--notes \"text\"] [--notes-file path] [asset...]"
  echo "Example: scripts/publish-release.sh v1.2.3 --auto-notes"
  exit 1
fi

version="$1"
shift
assets=()
auto_notes="false"
manual_notes=""
notes_file_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-notes)
      auto_notes="true"
      shift
      ;;
    --notes)
      if [[ $# -lt 2 ]]; then
        echo "Error: --notes requires a value."
        exit 1
      fi
      manual_notes="$2"
      shift 2
      ;;
    --notes-file)
      if [[ $# -lt 2 ]]; then
        echo "Error: --notes-file requires a path."
        exit 1
      fi
      notes_file_path="$2"
      shift 2
      ;;
    *)
      assets+=("$1")
      shift
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh (GitHub CLI) is not installed."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  if [[ -z "${GH_TOKEN:-}" ]]; then
    token="$(python3 - <<'PY'
import json, os, sys
path = os.path.join(os.path.expanduser("~"), ".okit", "user.json")
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

  if [[ ${#assets[@]} -eq 0 ]]; then
    echo "Error: no dmg found in release/. Run the electron-builder step first."
    exit 1
  fi
fi

notes_file=""
if [[ -n "$notes_file_path" ]]; then
  if [[ ! -f "$notes_file_path" ]]; then
    echo "Error: notes file not found: $notes_file_path"
    exit 1
  fi
  notes_file="$notes_file_path"
elif [[ -n "$manual_notes" ]]; then
  notes_file="$(mktemp)"
  printf "%s\n" "$manual_notes" > "$notes_file"
elif [[ "$auto_notes" == "true" ]]; then
  base_tag=""
  if git rev-parse "$version" >/dev/null 2>&1; then
    base_tag="$(git describe --tags --abbrev=0 "${version}^" 2>/dev/null || true)"
  else
    base_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  fi

  if [[ -n "$base_tag" ]]; then
    range="${base_tag}..HEAD"
    header="Changes since ${base_tag}:"
  else
    range="HEAD"
    header="Initial release:"
  fi

  notes_file="$(mktemp)"
  python3 - <<'PY' "$range" "$header" > "$notes_file"
import re, subprocess, sys

range_spec = sys.argv[1]
header = sys.argv[2]
pattern = re.compile(r"^(feat|fix|docs|chore|refactor|perf|test|build|ci|style)(\([^)]+\))?:\s*(.+)$", re.I)

def run_git_log(rng):
    out = subprocess.check_output(["git", "log", rng, "--pretty=format:%s"], text=True)
    return [line.strip() for line in out.splitlines() if line.strip()]

commits = run_git_log(range_spec)
order = ["Feat", "Fix", "Docs", "Refactor", "Perf", "Test", "Build", "Ci", "Style", "Chore", "Other"]
groups = {k: [] for k in order}
seen = set()

for raw in commits:
    m = pattern.match(raw)
    if m:
        cat = m.group(1).capitalize()
        msg = m.group(3).strip()
    else:
        cat = "Other"
        msg = raw
    if msg in seen:
        continue
    seen.add(msg)
    groups[cat].append(msg)

print(header)
print()
for cat in order:
    if not groups[cat]:
        continue
    print(f"{cat}:")
    for msg in groups[cat]:
        print(f"- {msg}")
    print()
PY
fi

if git rev-parse "$version" >/dev/null 2>&1; then
  echo "Tag $version already exists."
else
  git tag -a "$version" -m "Release $version"
  git push origin "$version"
fi

if gh release view "$version" >/dev/null 2>&1; then
  gh release upload "$version" "${assets[@]}" --clobber
  if [[ -n "$notes_file" ]]; then
    gh release edit "$version" --notes-file "$notes_file"
  fi
  # If the matched release is a draft (e.g. left behind by an earlier run),
  # publishing the assets is not enough — flip it to a real release.
  gh release edit "$version" --draft=false
else
  if [[ -n "$notes_file" ]]; then
    gh release create "$version" "${assets[@]}" --title "$version" --notes-file "$notes_file"
  else
    gh release create "$version" "${assets[@]}" --title "$version" --notes "Release $version"
  fi
fi

echo "Release $version updated."
