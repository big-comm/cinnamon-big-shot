#!/usr/bin/env bash
# Adds big-shot to org.cinnamon enabled-extensions on first Cinnamon login.
# Idempotent; runs once per user via a marker file so a later user-driven
# disable is preserved across logins.

set -e

UUID="big-shot@bigcommunity.org"
MARKER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cinnamon-big-shot"
MARKER="$MARKER_DIR/auto-enabled"

[ -f "$MARKER" ] && exit 0

mkdir -p "$MARKER_DIR"
touch "$MARKER"

command -v gsettings >/dev/null 2>&1 || exit 0

current=$(gsettings get org.cinnamon enabled-extensions 2>/dev/null || echo "@as []")

case "$current" in
    *"'$UUID'"*) exit 0 ;;
esac

if [ "$current" = "@as []" ] || [ "$current" = "[]" ]; then
    gsettings set org.cinnamon enabled-extensions "['$UUID']"
else
    new=$(printf '%s' "$current" | sed "s/]\$/, '$UUID']/")
    gsettings set org.cinnamon enabled-extensions "$new"
fi
