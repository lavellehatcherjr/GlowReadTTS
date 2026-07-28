#!/usr/bin/env bash
# build.sh
#
# Packages the extension into glowreadtts-<version>.zip at the repository root.
#
# Uses an explicit allowlist: only the paths named in ALLOW are copied. Anything
# added to the repository later stays out until it is named here. A denylist
# would ship new files silently, which is the wrong default.
#
# Built from a staging copy so the working tree is untouched, and zipped from
# inside that copy so manifest.json lands at the archive root rather than nested
# in a folder.
#
# Usage:
#   bash build.sh           # build
#   bash build.sh --list    # show what would be included, build nothing

set -e
set -u

cd "$(dirname "$0")"

STAGE_DIR=""

# ── what ships ──────────────────────────────────────────────────────────────
#
# Directories are copied whole; individual files are named individually.
# libs/ subdirectories are listed separately rather than as libs/ so a new
# libs/<something> does not ship by accident.
#
# assets/ may hold more than icons, so only the five that manifest.json
# references are named. Never copy assets/ wholesale.
#
# LICENSE and NOTICE ship because Apache 2.0 requires both accompany a
# distribution.

ALLOW=(
  manifest.json
  LICENSE
  NOTICE
  popup
  background
  content
  options
  offscreen
  eula
  help
  libs/kokoro
  libs/kokoro-model
  libs/onnx
  assets/icon-16.png
  assets/icon-32.png
  assets/icon-48.png
  assets/icon-128.png
  assets/icon-256.png
)

# ── what must never appear in the archive ───────────────────────────────────
#
# The allowlist already excludes all of this. These patterns are a second
# check against the built archive, so a future edit to ALLOW that lets
# something through fails the build rather than shipping quietly.
#
# \.zip$ matters more than it looks: the archive is written to the repository
# root, which is the directory the build reads from, so a careless widening of
# ALLOW could pack the archive into itself.

FORBIDDEN='^\.git|^node_modules/|^build\.sh$|^scripts/|^samples/|\.zip$|\.md$|\.DS_Store$|^assets/(chrome-store|medium|post|posttoday|thumbnails)/|^assets/icon\.svg$'

# ── helpers ─────────────────────────────────────────────────────────────────

cleanup() {
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR"
  fi
}
trap cleanup EXIT

fail() {
  echo ""
  echo "✗ BUILD FAILED: $1"
  exit 1
}

# Paths the extension needs at runtime, derived from manifest.json.
#
# offscreen/ is appended by hand because it is NOT named anywhere in the
# manifest: "offscreen" there is a permission, and the document path lives in
# background/service-worker.js as a runtime string. A manifest-only check would
# happily ship a package with no offscreen document, which breaks every AI read.
required_paths() {
  python3 - <<'PY'
import json
m = json.load(open('manifest.json'))
out = ['manifest.json', 'LICENSE', 'NOTICE',
       'offscreen/offscreen.html', 'offscreen/offscreen.js']
out += list(m.get('icons', {}).values())
out += list(m.get('action', {}).get('default_icon', {}).values())
if m.get('action', {}).get('default_popup'):
    out.append(m['action']['default_popup'])
if m.get('background', {}).get('service_worker'):
    out.append(m['background']['service_worker'])
for cs in m.get('content_scripts', []):
    out += cs.get('js', []) + cs.get('css', [])
if m.get('options_ui', {}).get('page'):
    out.append(m['options_ui']['page'])
for war in m.get('web_accessible_resources', []):
    for r in war.get('resources', []):
        # "libs/kokoro/*" becomes the prefix "libs/kokoro/"
        out.append(r[:-1] if r.endswith('*') else r)
for p in sorted(set(out)):
    print(p)
PY
}

manifest_version() {
  python3 -c "import json; print(json.load(open('manifest.json'))['version'])"
}

# ── pre-flight ──────────────────────────────────────────────────────────────

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then
  LIST_ONLY=1
fi

for tool in zip unzip python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is required but not installed."
  fi
done

if [ ! -f manifest.json ]; then
  fail "manifest.json not found. Run this from the repository root."
fi

VERSION="$(manifest_version)"
ZIP_NAME="glowreadtts-${VERSION}.zip"
ZIP_PATH="$(pwd)/$ZIP_NAME"

# Packaging uncommitted work ships something that is not in the repository.
# Worth saying out loud, but building mid-change is legitimate, so this only
# warns.
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "⚠ Working tree is dirty. The archive will include uncommitted changes."
    echo ""
  fi
fi

# ── list mode ───────────────────────────────────────────────────────────────

if [ "$LIST_ONLY" -eq 1 ]; then
  echo "=== Would include (allowlist) ==="
  for p in "${ALLOW[@]}"; do
    if [ -e "$p" ]; then
      printf "  ✓ %-28s %s\n" "$p" "$(du -sh "$p" | cut -f1)"
    else
      printf "  ✗ %-28s MISSING FROM REPOSITORY\n" "$p"
    fi
  done
  echo ""
  echo "=== Would exclude (present but not allowlisted) ==="
  for p in * .[!.]*; do
    [ -e "$p" ] || continue
    listed=0
    for a in "${ALLOW[@]}"; do
      case "$a" in "$p"|"$p"/*) listed=1; break ;; esac
    done
    if [ "$listed" -eq 0 ]; then
      printf "  - %-28s %s\n" "$p" "$(du -sh "$p" 2>/dev/null | cut -f1)"
    fi
  done
  echo ""
  echo "  - assets/  (all except the five manifest-referenced icons)"
  for p in assets/*/; do
    [ -d "$p" ] || continue
    printf "      %-26s %s\n" "$p" "$(du -sh "$p" | cut -f1)"
  done
  echo ""
  echo "Version: $VERSION  ->  $ZIP_NAME (not built; --list)"
  exit 0
fi

# ── stage ───────────────────────────────────────────────────────────────────

echo "=== Building GlowReadTTS $VERSION ==="
echo ""

STAGE_DIR="$(mktemp -d)"
rm -f "$ZIP_PATH"

echo "Staging..."
for p in "${ALLOW[@]}"; do
  [ -e "$p" ] || fail "allowlisted path missing from repository: $p"
  mkdir -p "$STAGE_DIR/$(dirname "$p")"
  cp -R "$p" "$STAGE_DIR/$(dirname "$p")/"
  printf "  ✓ %s\n" "$p"
done
echo ""

# ── zip ─────────────────────────────────────────────────────────────────────
#
# Zipping "." from inside the staging directory is what puts manifest.json at
# the archive root. Zipping the directory itself would nest everything one
# level down, which the store rejects.

echo "Packing..."
( cd "$STAGE_DIR" && zip -rq "$ZIP_PATH" . -x '.DS_Store' '*/.DS_Store' )
[ -f "$ZIP_PATH" ] || fail "zip produced no archive."
echo "  ✓ $ZIP_NAME"
echo ""

# ── verify ──────────────────────────────────────────────────────────────────

echo "Verifying..."
ENTRIES="$(unzip -Z1 "$ZIP_PATH")"

# 1. manifest.json at the archive root, not nested in a directory.
if ! printf '%s\n' "$ENTRIES" | grep -qx 'manifest.json'; then
  fail "manifest.json is not at the archive root."
fi
echo "  ✓ manifest.json at archive root"

# 2. Every path the manifest references (plus the runtime-only offscreen
#    document) is present.
MISSING=0
while read -r req; do
  [ -n "$req" ] || continue
  case "$req" in
    */) printf '%s\n' "$ENTRIES" | grep -q "^$req" || { echo "  ✗ missing: $req"; MISSING=$((MISSING + 1)); } ;;
    *)  printf '%s\n' "$ENTRIES" | grep -qx "$req"  || { echo "  ✗ missing: $req"; MISSING=$((MISSING + 1)); } ;;
  esac
done <<EOF
$(required_paths)
EOF
[ "$MISSING" -eq 0 ] || fail "$MISSING manifest-referenced path(s) absent from the archive."
echo "  ✓ all manifest-referenced paths present"

# 3. Nothing unexpected slipped in.
UNEXPECTED="$(printf '%s\n' "$ENTRIES" | grep -E "$FORBIDDEN" || true)"
if [ -n "$UNEXPECTED" ]; then
  echo "$UNEXPECTED" | sed 's/^/  ✗ unexpected: /'
  fail "archive contains files that must not ship."
fi
echo "  ✓ no unexpected files"

# 4. The archive is readable.
unzip -tq "$ZIP_PATH" >/dev/null 2>&1 || fail "archive failed integrity check."
echo "  ✓ archive integrity"
echo ""

# ── report ──────────────────────────────────────────────────────────────────

FILE_COUNT="$(printf '%s\n' "$ENTRIES" | grep -vc '/$' || true)"
UNCOMPRESSED="$(unzip -l "$ZIP_PATH" | tail -1 | awk '{print $1}')"
UNCOMPRESSED_MB=$((UNCOMPRESSED / 1024 / 1024))
COMPRESSED="$(du -h "$ZIP_PATH" | cut -f1)"

echo "=== Done ==="
echo "  Output:       $ZIP_NAME"
echo "  Version:      $VERSION"
echo "  Files:        $FILE_COUNT"
echo "  Uncompressed: ${UNCOMPRESSED_MB} MB"
echo "  Compressed:   $COMPRESSED"

# Well under the store's 2 GB limit. A number far above the expected ~120 MB
# means something unintended got in, so it is worth flagging rather than
# discovering during review.
if [ "$UNCOMPRESSED_MB" -gt 200 ]; then
  echo ""
  echo "⚠ WARNING: uncompressed size is ${UNCOMPRESSED_MB} MB, well above the"
  echo "  expected ~120 MB. Check the listing for something unintended:"
  echo "    unzip -l $ZIP_NAME"
fi
