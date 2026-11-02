#!/usr/bin/env bash
# Adds big-shot to org.cinnamon enabled-extensions on first Cinnamon login.
# Idempotent; runs once per user via a marker file so a later user-driven
# disable is preserved across logins. The marker is only written after the
# extension is confirmed enabled, so a transient gsettings/dconf failure is
# retried on the next login.

set -u

UUID="big-shot@bigcommunity.org"
MARKER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cinnamon-big-shot"
MARKER="$MARKER_DIR/auto-enabled"

[ -f "$MARKER" ] && exit 0
command -v gsettings >/dev/null 2>&1 || exit 0

mark_done() {
    mkdir -p "$MARKER_DIR" && touch "$MARKER"
}

current=$(gsettings get org.cinnamon enabled-extensions 2>/dev/null) || exit 0

case "$current" in
    *"'$UUID'"*) mark_done; exit 0 ;;
esac

if [ "$current" = "@as []" ] || [ "$current" = "[]" ]; then
    new="['$UUID']"
else
    new=$(printf '%s' "$current" | sed "s/]\$/, '$UUID']/")
fi

gsettings set org.cinnamon enabled-extensions "$new" && mark_done
