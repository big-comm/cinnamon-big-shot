#!/usr/bin/env bash
# Big Shot for Cinnamon — Build & Pack Script
# Builds big-shot-cinnamon.zip from a staging copy, so the tracked files
# (metadata.json, extension.js) are never modified by a build.
set -euo pipefail

UUID="big-shot@bigcommunity.org"
EXT_DIR="usr/share/cinnamon/extensions/${UUID}"
OUTPUT="big-shot-cinnamon.zip"

cd "$(dirname "$0")"
ROOT="$PWD"

echo "=== Big Shot (Cinnamon) Build ==="

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
DEST="${STAGE}/${UUID}"
mkdir -p "$DEST"

# Copy every runtime file; leave out sources/tooling that are not needed
# at runtime.
tar -C "$EXT_DIR" \
    --exclude='./po' --exclude='./locale' --exclude='__pycache__' \
    --exclude='*.pyc' --exclude='*~' --exclude='./auto-enable.sh' \
    -cf - . | tar -C "$DEST" -xf -

# Inject version into the staged metadata.json / extension.js only
VERSION_INT=$(date +%y%m%d)
VERSION_STR=$(date +%y.%m.%d)
sed -i "s/\"version\": \"\{0,1\}[0-9]*\"\{0,1\}/\"version\": \"${VERSION_INT}\"/" "${DEST}/metadata.json"
sed -i "s/^var APP_VERSION = '.*';/var APP_VERSION = '${VERSION_STR}';/" "${DEST}/extension.js"

# Compile .po → .mo (validated)
for po_file in "${EXT_DIR}/po"/*.po; do
    [ -f "$po_file" ] || continue
    lang=$(basename "$po_file" .po)
    mo_dir="${DEST}/locale/${lang}/LC_MESSAGES"
    mkdir -p "$mo_dir"
    msgfmt --check-format "$po_file" -o "${mo_dir}/${UUID}.mo"
    echo "  ${lang}: OK"
done

rm -f "${ROOT}/${OUTPUT}"
if command -v zip >/dev/null 2>&1; then
    (cd "$DEST" && zip -qr "${ROOT}/${OUTPUT}" .)
else
    (cd "$DEST" && python3 -m zipfile -c "${ROOT}/${OUTPUT}" ./*)
fi
echo "=== Built: ${OUTPUT} ==="
