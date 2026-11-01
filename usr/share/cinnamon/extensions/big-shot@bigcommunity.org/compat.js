/**
 * Big Shot — Compatibility helpers across Cinnamon versions.
 *
 * Cinnamon 6.7+/6.8 added a `copy_to_clipboard` argument to
 * Cinnamon.Screenshot.screenshot_area() before the callback; 5.4–6.6
 * take the callback as the 7th argument. Calling with the wrong arity
 * throws synchronously (before any capture happens), so we probe once
 * and remember which form works.
 */

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;

let _screenshotAreaHasClipboardArg = null;

function _isArityError(e) {
    return e && /argument/i.test(String(e.message || e));
}

/**
 * Capture an area of the stage to `filename`.
 * `callback(success)` is invoked once the capture finished.
 */
function screenshotArea(screenshot, includeCursor, x, y, width, height,
    filename, callback) {
    let cb = (_obj, success) => callback(success !== false);
    if (_screenshotAreaHasClipboardArg === true) {
        screenshot.screenshot_area(includeCursor, x, y, width, height,
            filename, false, cb);
        return;
    }
    try {
        screenshot.screenshot_area(includeCursor, x, y, width, height,
            filename, cb);
        _screenshotAreaHasClipboardArg = false;
    } catch (e) {
        if (_screenshotAreaHasClipboardArg === false || !_isArityError(e))
            throw e;
        screenshot.screenshot_area(includeCursor, x, y, width, height,
            filename, false, cb);
        _screenshotAreaHasClipboardArg = true;
    }
}

/** St.Clipboard.set_content only exists on Cinnamon >= 6.0. */
function canSetClipboardContent() {
    let clipboard = St.Clipboard.get_default();
    return typeof clipboard.set_content === 'function';
}

/**
 * Private, per-user directory for temporary files (mode 0700),
 * under $XDG_RUNTIME_DIR when available. Falls back to /tmp.
 */
function getPrivateTempDir() {
    let base = GLib.get_user_runtime_dir() || GLib.get_tmp_dir();
    let dir = GLib.build_filenamev([base, 'big-shot']);
    if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
        return GLib.get_tmp_dir();
    return dir;
}

let _tempCounter = 0;

/** Unique temporary file path inside the private temp dir. */
function makeTempPath(prefix, ext) {
    _tempCounter++;
    return GLib.build_filenamev([
        getPrivateTempDir(),
        prefix + '-' + GLib.get_monotonic_time() + '-' + _tempCounter +
            '.' + (ext || 'png'),
    ]);
}

/** Delete a file, ignoring errors (missing file etc.). */
function deleteQuietly(path) {
    if (!path) return;
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (_e) {
        // ignore
    }
}
