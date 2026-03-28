#!/usr/bin/env bash
# Big Shot for Cinnamon — Build & Pack Script
set -euo pipefail

UUID="big-shot@bigcommunity.org"
EXT_DIR="usr/share/cinnamon/extensions/${UUID}"
PO_DIR="${EXT_DIR}/po"
LOCALE_DIR="${EXT_DIR}/locale"
OUTPUT="big-shot-cinnamon.zip"

cd "$(dirname "$0")"

echo "=== Big Shot (Cinnamon) Build ==="

# Inject version into metadata.json
VERSION_INT=$(date +%y%m%d)
VERSION_STR=$(date +%y.%m.%d)
sed -i "s/\"version\": [0-9]*/\"version\": ${VERSION_INT}/" "${EXT_DIR}/metadata.json"
sed -i "s/^var APP_VERSION = '.*';/var APP_VERSION = '${VERSION_STR}';/" "${EXT_DIR}/extension.js"

# Compile .po → .mo
for po_file in "${PO_DIR}"/*.po; do
    [ -f "$po_file" ] || continue
    lang=$(basename "$po_file" .po)
    mo_dir="${LOCALE_DIR}/${lang}/LC_MESSAGES"
    mkdir -p "$mo_dir"
    msgfmt "$po_file" -o "${mo_dir}/${UUID}.mo"
    echo "  ${lang}: OK"
done

# Pack the extension
cd "${EXT_DIR}"
zip -r "../../../../${OUTPUT}" \
    metadata.json extension.js stylesheet.css \
    parts/ drawing/ data/ locale/ \
    --exclude '*.po' --exclude '*.pot' --exclude 'po/'
cd "../../../.."
echo "=== Built: ${OUTPUT} ==="
