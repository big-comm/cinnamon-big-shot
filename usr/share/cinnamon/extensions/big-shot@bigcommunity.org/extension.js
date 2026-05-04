/**
 * Big Shot — Enhanced Screenshot & Screencast for Cinnamon
 *
 * Main extension entry point. Provides screenshot annotation tools,
 * screencast recording with hardware-accelerated encoding, webcam overlay,
 * desktop+mic audio capture, and pause/resume support.
 *
 * Cinnamon CJS version — adapted from GNOME Shell ES module original.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

var APP_VERSION = '26.5.4';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cairo = imports.gi.cairo;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Gettext = imports.gettext;

let _extensionMeta = null;
let _extensionPath = null;
let _instance = null;

let _ = function(str) { return str; };

// =============================================================================
// GPU DETECTION
// =============================================================================

const GpuVendor = {
    NVIDIA: 'nvidia',
    AMD: 'amd',
    INTEL: 'intel',
    UNKNOWN: 'unknown',
};

function detectGpuVendors() {
    try {
        let proc = Gio.Subprocess.new(
            ['lspci'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        let result = proc.communicate_utf8(null, null);
        let stdout = result[1];
        if (!stdout) return [GpuVendor.UNKNOWN];

        let vendors = [];
        let lines = stdout.toLowerCase();

        if (/(?:vga|display controller|3d).*nvidia/.test(lines))
            vendors.push(GpuVendor.NVIDIA);
        if (/(?:vga|display controller).*(?:\bamd\b|\bati\b)/.test(lines))
            vendors.push(GpuVendor.AMD);
        if (/(?:vga|display controller).*intel/.test(lines))
            vendors.push(GpuVendor.INTEL);

        return vendors.length > 0 ? vendors : [GpuVendor.UNKNOWN];
    } catch (e) {
        return [GpuVendor.UNKNOWN];
    }
}

// =============================================================================
// GSTREAMER PIPELINE CONFIGURATIONS
// =============================================================================

const QUALITY_PRESETS = {
    high:   { qp: 18, qp_i: 18, qp_p: 20, qp_b: 22, openh264_br: 8000000, vp9_cq: 13, vp9_minq: 10, vp9_maxq: 50 },
    medium: { qp: 24, qp_i: 24, qp_p: 26, qp_b: 28, openh264_br: 4000000, vp9_cq: 24, vp9_minq: 15, vp9_maxq: 55 },
    low:    { qp: 27, qp_i: 27, qp_p: 29, qp_b: 31, openh264_br: 2000000, vp9_cq: 31, vp9_minq: 20, vp9_maxq: 58 },
};

const VIDEO_PIPELINES = [
    {
        id: 'nvidia-raw-h264-nvenc',
        label: 'NVIDIA H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'nvh264enc rc-mode=cqp qp-const=' + p.qp + ' ! h264parse'; },
        elements: ['videoconvert', 'nvh264enc'],
        ext: 'mp4',
    },
    {
        id: 'va-raw-h264-lp',
        label: 'VA H.264 Low-Power',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'vah264lpenc rate-control=cqp qpi=' + p.qp_i + ' qpp=' + p.qp_p + ' qpb=' + p.qp_b + ' ! h264parse'; },
        elements: ['videoconvert', 'vah264lpenc'],
        ext: 'mp4',
    },
    {
        id: 'va-raw-h264',
        label: 'VA H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'vah264enc rate-control=cqp qpi=' + p.qp_i + ' qpp=' + p.qp_p + ' qpb=' + p.qp_b + ' ! h264parse'; },
        elements: ['videoconvert', 'vah264enc'],
        ext: 'mp4',
    },
    {
        id: 'vaapi-raw-h264',
        label: 'VAAPI H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'vaapih264enc rate-control=cqp init-qp=' + p.qp + ' ! h264parse'; },
        elements: ['videoconvert', 'vaapih264enc'],
        ext: 'mp4',
    },
    {
        id: 'sw-memfd-h264-openh264',
        label: 'Software H.264',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'openh264enc complexity=high bitrate=' + p.openh264_br + ' multi-thread=4 ! h264parse'; },
        elements: ['videoconvert', 'openh264enc'],
        ext: 'mp4',
    },
    {
        id: 'sw-memfd-vp9',
        label: 'Software VP9',
        vendors: [],
        src: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=4 ! queue',
        enc: function(p) { return 'vp9enc min_quantizer=' + p.vp9_minq + ' max_quantizer=' + p.vp9_maxq + ' cq_level=' + p.vp9_cq + ' cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 row-mt=1 ! queue'; },
        elements: ['videoconvert', 'vp9enc'],
        ext: 'webm',
    },
];

const AUDIO_PIPELINE = {
    vorbis: 'vorbisenc ! queue',
    aac: 'fdkaacenc ! queue',
};

const MUXERS = {
    mp4: 'mp4mux fragment-duration=500',
    webm: 'webmmux',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function checkElement(name) {
    try {
        let proc = Gio.Subprocess.new(
            ['gst-inspect-1.0', '--exists', name],
            Gio.SubprocessFlags.NONE
        );
        proc.wait(null);
        return proc.get_successful();
    } catch (e) {
        return false;
    }
}

function checkPipeline(config) {
    for (let i = 0; i < config.elements.length; i++) {
        if (!checkElement(config.elements[i]))
            return false;
    }
    return true;
}

function fixFilePath(filePath, ext) {
    if (!filePath || !ext) return;
    let file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return;
    let newPath = filePath.replace(/\.[^.]+$/, '.' + ext);
    if (newPath !== filePath) {
        let newFile = Gio.File.new_for_path(newPath);
        try {
            file.move(newFile, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            log('[Big Shot] Failed to rename file: ' + e.message);
        }
    }
}

// =============================================================================
// MAIN EXTENSION CLASS
// =============================================================================

var BigShotExtension = class BigShotExtension {
    constructor(metadata) {
        this._meta = metadata;
        this.path = metadata.path;
        this._parts = [];
        this._availableConfigs = null;
        this._currentConfigIndex = 0;

        // Pause/resume state
        this._recordingState = 'idle'; // 'idle' | 'recording' | 'paused'
        this._recordingContext = null;
        this._stopWatcherId = 0;
        this._renameTimerId = 0;
        this._pendingRename = null;

        this._screenshotUI = null;
    }

    enable() {
        // Setup imports search path for our modules
        imports.searchPath.unshift(this.path);

        // Setup gettext
        let uuid = this._meta.uuid;
        Gettext.bindtextdomain(uuid, this.path + '/locale');
        _ = Gettext.dgettext.bind(null, uuid);

        // Set gettext on modules that need it
        let ScreenshotUI = imports.screenshotUI;
        ScreenshotUI.ScreenshotUI.setGettext(_);

        let DrawingOverlayMod = imports.drawing.overlay;
        DrawingOverlayMod.DrawingOverlay.setGettext(_);

        // Create the screenshot UI
        this._screenshotUI = new ScreenshotUI.ScreenshotUI(this.path);

        // Create all parts
        this._createParts();

        // Detect pipelines lazily (on first screencast attempt)

        // Register keybinding to open the screenshot UI
        this._addKeybinding();

        // Handle screencast requests from UI
        this._screenshotUI.connect('screencast-requested', () => {
            this._startScreencast();
        });

        // Reset parts state when UI is closed (ESC, capture done, etc.)
        this._screenshotUI.connect('closed', () => {
            this._onUIClosed();
        });

        // Provide screenshot pixbuf to annotation overlay when ready
        this._screenshotUI.connect('screenshot-ready', (ui, pixbuf) => {
            if (this._annotation && this._annotation._overlay) {
                this._annotation._overlay.setCachedPixbuf(pixbuf, 1);
            }
        });

        // Wire annotation compositor for screenshot save
        let ext = this;
        this._screenshotUI._annotationCompositor = function(croppedPixbuf, geom) {
            let overlay = ext._annotation ? ext._annotation._overlay : null;
            let actions = overlay ? overlay._actions : [];
            if (!actions || actions.length === 0) return null;

            let offsetX = Math.max(0, geom[0]);
            let offsetY = Math.max(0, geom[1]);

            let toWidget = function(ax, ay) {
                return [(ax - offsetX), (ay - offsetY)];
            };
            let drawScale = 1.0;

            // Apply pixel-manipulating effects (blur, censor, etc.)
            let workPixbuf = croppedPixbuf;
            for (let i = 0; i < actions.length; i++) {
                let act = actions[i];
                if (typeof act.drawReal === 'function') {
                    try {
                        let result = act.drawReal(workPixbuf, GdkPixbuf, GLib, toWidget, drawScale);
                        if (result) workPixbuf = result;
                    } catch (err) {
                        log('[Big Shot] drawReal failed: ' + err.message);
                    }
                }
            }

            // Save pixbuf → PNG → Cairo surface → draw annotations → save
            let tmpBase = GLib.build_filenamev([
                GLib.get_tmp_dir(), 'bigshot-comp-' + Date.now() + '.png'
            ]);
            let tmpOut = GLib.build_filenamev([
                GLib.get_tmp_dir(), 'bigshot-out-' + Date.now() + '.png'
            ]);

            try {
                workPixbuf.savev(tmpBase, 'png', [], []);
                let surface = Cairo.ImageSurface.createFromPNG(tmpBase);
                let cr = new Cairo.Context(surface);

                for (let i = 0; i < actions.length; i++) {
                    let act = actions[i];
                    if (typeof act.drawReal !== 'function') {
                        cr.save();
                        act.draw(cr, toWidget, drawScale);
                        cr.restore();
                    }
                }

                surface.writeToPNG(tmpOut);
                surface.finish();

                return GdkPixbuf.Pixbuf.new_from_file(tmpOut);
            } catch (e) {
                log('[Big Shot] Annotation compositing error: ' + e.message);
                return null;
            } finally {
                try { Gio.File.new_for_path(tmpBase).delete(null); } catch (e) { /* */ }
                try { Gio.File.new_for_path(tmpOut).delete(null); } catch (e) { /* */ }
            }
        };

        log('[Big Shot] Extension enabled for Cinnamon');
    }

    disable() {
        // Clean up recording state
        this._recordingState = 'idle';
        this._recordingContext = null;
        if (this._stopWatcherId) {
            GLib.source_remove(this._stopWatcherId);
            this._stopWatcherId = 0;
        }
        if (this._renameTimerId) {
            GLib.source_remove(this._renameTimerId);
            this._renameTimerId = 0;
        }
        this._pendingRename = null;

        // Destroy all parts
        for (let i = 0; i < this._parts.length; i++) {
            try {
                this._parts[i].destroy();
            } catch (e) {
                log('[Big Shot] Error destroying part: ' + e.message);
            }
        }
        this._parts = [];

        // Remove keybinding
        this._removeKeybinding();

        // Destroy screenshot UI
        if (this._screenshotUI) {
            this._screenshotUI.destroy();
            this._screenshotUI = null;
        }

        // Clean up imports search path
        let idx = imports.searchPath.indexOf(this.path);
        if (idx >= 0) {
            imports.searchPath.splice(idx, 1);
        }

        this._availableConfigs = null;

        log('[Big Shot] Extension disabled');
    }

    // =========================================================================
    // KEYBINDING
    // =========================================================================

    /**
     * Disable native screenshot keybindings that conflict with ours.
     * Saves original values for restoration on disable.
     */
    _disableNativeScreenshotKeys() {
        this._savedBindings = {};

        try {
            // Disable media-keys screenshot bindings that use Print variants
            let mediaKeys = new Gio.Settings({
                schema_id: 'org.cinnamon.desktop.keybindings.media-keys',
            });
            let keysToDisable = [
                'screenshot', 'screenshot-clip',
                'area-screenshot', 'area-screenshot-clip',
                'window-screenshot', 'window-screenshot-clip',
            ];
            for (let i = 0; i < keysToDisable.length; i++) {
                let key = keysToDisable[i];
                let val = mediaKeys.get_strv(key);
                if (val && val.length > 0) {
                    this._savedBindings['media:' + key] = val;
                    mediaKeys.set_strv(key, []);
                }
            }

            // Disable custom keybindings that use Print key
            let kbSchema = 'org.cinnamon.desktop.keybindings';
            let kbSettings = new Gio.Settings({ schema_id: kbSchema });
            let customList = kbSettings.get_strv('custom-list');
            for (let i = 0; i < customList.length; i++) {
                let customId = customList[i];
                try {
                    let customPath = '/org/cinnamon/desktop/keybindings/custom-keybindings/' + customId + '/';
                    let customSettings = new Gio.Settings({
                        schema_id: 'org.cinnamon.desktop.keybindings.custom-keybinding',
                        path: customPath,
                    });
                    let binding = customSettings.get_strv('binding');
                    if (binding) {
                        for (let j = 0; j < binding.length; j++) {
                            if (binding[j].indexOf('Print') >= 0) {
                                this._savedBindings['custom:' + customId] = binding;
                                customSettings.set_strv('binding', []);
                                log('[Big Shot] Disabled conflicting custom keybinding: ' + customId + ' = ' + binding.join(', '));
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // custom keybinding might not exist
                }
            }

            Gio.Settings.sync();
        } catch (e) {
            log('[Big Shot] Error disabling native keys: ' + e.message);
        }
    }

    /**
     * Restore previously disabled native screenshot keybindings.
     */
    _restoreNativeScreenshotKeys() {
        if (!this._savedBindings) return;

        try {
            let mediaKeys = new Gio.Settings({
                schema_id: 'org.cinnamon.desktop.keybindings.media-keys',
            });

            let keys = Object.keys(this._savedBindings);
            for (let i = 0; i < keys.length; i++) {
                let fullKey = keys[i];
                let val = this._savedBindings[fullKey];
                if (fullKey.indexOf('media:') === 0) {
                    let key = fullKey.substring(6);
                    mediaKeys.set_strv(key, val);
                } else if (fullKey.indexOf('custom:') === 0) {
                    let customId = fullKey.substring(7);
                    let customPath = '/org/cinnamon/desktop/keybindings/custom-keybindings/' + customId + '/';
                    let customSettings = new Gio.Settings({
                        schema_id: 'org.cinnamon.desktop.keybindings.custom-keybinding',
                        path: customPath,
                    });
                    customSettings.set_strv('binding', val);
                }
            }

            Gio.Settings.sync();
        } catch (e) {
            log('[Big Shot] Error restoring native keys: ' + e.message);
        }
        this._savedBindings = null;
    }

    _addKeybinding() {
        // Disable conflicting native keybindings first
        this._disableNativeScreenshotKeys();

        try {
            Main.keybindingManager.addHotKey(
                'big-shot-screenshot',
                'Print',
                () => {
                    this._screenshotUI.open(0); // UIMode.SCREENSHOT
                }
            );
            Main.keybindingManager.addHotKey(
                'big-shot-screencast',
                '<Shift>Print',
                () => {
                    if (this._recordingState !== 'idle') {
                        this._quickStop();
                    } else {
                        this._screenshotUI.open(1); // UIMode.SCREENCAST
                    }
                }
            );
        } catch (e) {
            log('[Big Shot] Failed to register keybinding: ' + e.message);
        }
    }

    _removeKeybinding() {
        try {
            Main.keybindingManager.removeHotKey('big-shot-screenshot');
            Main.keybindingManager.removeHotKey('big-shot-screencast');
        } catch (e) {
            // Ignore
        }

        // Restore native keybindings
        this._restoreNativeScreenshotKeys();
    }

    // =========================================================================
    // PARTS CREATION
    // =========================================================================

    _createParts() {
        let ui = this._screenshotUI;
        let ext = this;

        // Import parts modules
        let PartToolbarMod = imports.parts.parttoolbar;
        let PartAnnotationMod = imports.parts.partannotation;
        let PartAudioMod = imports.parts.partaudio;
        let PartFramerateMod = imports.parts.partframerate;
        let PartDownsizeMod = imports.parts.partdownsize;
        let PartIndicatorMod = imports.parts.partindicator;
        let PartQuickStopMod = imports.parts.partquickstop;
        let PartWebcamMod = imports.parts.partwebcam;

        // Set gettext on parts that need it
        if (PartToolbarMod.PartToolbar.setGettext) PartToolbarMod.PartToolbar.setGettext(_);
        if (PartAudioMod.PartAudio.setGettext) PartAudioMod.PartAudio.setGettext(_);
        if (PartFramerateMod.PartFramerate.setGettext) PartFramerateMod.PartFramerate.setGettext(_);
        if (PartDownsizeMod.PartDownsize.setGettext) PartDownsizeMod.PartDownsize.setGettext(_);
        if (PartIndicatorMod.PartIndicator.setGettext) PartIndicatorMod.PartIndicator.setGettext(_);
        if (PartWebcamMod.PartWebcam.setGettext) PartWebcamMod.PartWebcam.setGettext(_);

        // Toolbar
        this._toolbar = new PartToolbarMod.PartToolbar(ui, ext);
        this._parts.push(this._toolbar);

        // Annotation
        this._annotation = new PartAnnotationMod.PartAnnotation(ui, ext);
        this._parts.push(this._annotation);

        // Wire toolbar tool changes
        this._toolbar.onToolChanged(function(toolId) {
            let overlay = ext._annotation ? ext._annotation._overlay : null;
            if (overlay) {
                overlay.setReactive(toolId !== null);
            }
        });

        // Wire action buttons
        this._toolbar.onAction(function(action) {
            ext._handleAction(action);
        });

        // Audio (Desktop, Mic)
        this._audio = new PartAudioMod.PartAudio(ui, ext);
        this._parts.push(this._audio);

        // Webcam
        this._webcam = new PartWebcamMod.PartWebcam(ui, ext);
        this._parts.push(this._webcam);

        // Downsize (100%)
        this._downsize = new PartDownsizeMod.PartDownsize(ui, ext);
        this._parts.push(this._downsize);

        // Framerate (30fps)
        this._framerate = new PartFramerateMod.PartFramerate(ui, ext);
        this._parts.push(this._framerate);

        // Indicator
        this._indicator = new PartIndicatorMod.PartIndicator(ui, ext);
        this._parts.push(this._indicator);

        // Quick Stop
        this._quickstop = new PartQuickStopMod.PartQuickStop(ui, ext);
        this._parts.push(this._quickstop);

        // Wire webcam toggle
        this._webcam.onWebcamToggled(function(enabled) {
            if (ext._toolbar._maskRow)
                ext._toolbar._maskRow.visible = enabled;
            if (ext._toolbar._sizeRow)
                ext._toolbar._sizeRow.visible = enabled;
            if (ext._toolbar._cameraRow && enabled) {
                let devices = ext._webcam.enumerateDevices();
                ext._toolbar.populateCameras(devices);
            } else if (ext._toolbar._cameraRow) {
                ext._toolbar._cameraRow.visible = false;
            }
            if (ext._toolbar.repositionVideoPanel)
                ext._toolbar.repositionVideoPanel();
        });

        // Wire camera selection
        this._toolbar.onCameraChanged(function(device) {
            ext._webcam.selectedDevice = device;
        });

        // Wire mic toggle
        this._audio.onMicToggled(function(enabled) {
            if (enabled) {
                let mics = ext._audio.enumerateMicrophones();
                ext._toolbar.populateMicrophones(mics);
            } else {
                ext._toolbar.populateMicrophones([]);
            }
            if (ext._toolbar.repositionVideoPanel)
                ext._toolbar.repositionVideoPanel();
        });

        // Wire mic selection
        this._toolbar.onMicChanged(function(micId) {
            ext._audio.selectedMicId = micId;
        });

        // Wire mask selection
        this._toolbar.onMaskChanged(function(maskId) {
            ext._webcam.maskId = maskId;
        });

        // Wire size selection
        this._toolbar.onSizeChanged(function(width) {
            ext._webcam.width = width;
        });
    }

    // =========================================================================
    // SCREENSHOT SAVE WITH ANNOTATIONS
    // =========================================================================

    _handleAction(action) {
        try {
            let result = this._captureAnnotatedBytes();
            if (!result) {
                log('[Big Shot] Failed to capture screenshot');
                return;
            }

            let bytes = result.bytes;
            let pixbuf = result.pixbuf;

            if (action === 'copy') {
                let clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                try {
                    let player = global.display.get_sound_player();
                    if (player)
                        player.play_from_theme('screen-capture', _('Screenshot copied'), null);
                } catch (e) { /* ignore */ }
                this._screenshotUI.close();
            } else if (action === 'save-as') {
                // Save to temp file, then open file chooser
                let tmpPath = GLib.build_filenamev([
                    GLib.get_tmp_dir(), 'bigshot-saveas-' + Date.now() + '.png'
                ]);
                let tmpFile = Gio.File.new_for_path(tmpPath);
                let outStream = tmpFile.create(Gio.FileCreateFlags.NONE, null);
                outStream.write_bytes(bytes, null);
                outStream.close(null);

                let clipboard = St.Clipboard.get_default();
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

                this._screenshotUI.close();
                this._openSaveDialog(tmpPath, pixbuf);
            }
        } catch (e) {
            log('[Big Shot] Action "' + action + '" failed: ' + e.message);
        }
    }

    _captureAnnotatedBytes() {
        let overlay = this._annotation ? this._annotation._overlay : null;
        let actions = overlay ? overlay._actions : [];
        let pixbuf = this._screenshotUI.getScreenshotPixbuf();
        if (!pixbuf) return null;

        let geom = this._screenshotUI.getSelectedGeometry();

        // Crop to selection if needed
        let x = Math.max(0, geom[0]);
        let y = Math.max(0, geom[1]);
        let w = Math.min(geom[2], pixbuf.get_width() - x);
        let h = Math.min(geom[3], pixbuf.get_height() - y);

        if (w <= 0 || h <= 0) return null;

        let cropPixbuf = pixbuf;
        if (x > 0 || y > 0 || w < pixbuf.get_width() || h < pixbuf.get_height()) {
            cropPixbuf = pixbuf.new_subpixbuf(x, y, w, h);
        }

        if (!actions || actions.length === 0) {
            let buf = cropPixbuf.save_to_bufferv('png', [], []);
            if (!buf[0]) return null;
            return { bytes: GLib.Bytes.new(buf[1]), pixbuf: cropPixbuf };
        }

        // Composite annotations onto the screenshot via Cairo
        let offsetX = x;
        let offsetY = y;
        let tmpDir = GLib.get_tmp_dir();
        let tmpBase = GLib.build_filenamev([tmpDir, 'bigshot-base-' + Date.now() + '.png']);
        let tmpAnnotated = GLib.build_filenamev([tmpDir, 'bigshot-ann-' + Date.now() + '.png']);

        try {
            let toWidget = function(ax, ay) {
                return [(ax - offsetX), (ay - offsetY)];
            };
            let drawScale = 1.0;

            // Apply pixel-manipulating effects
            let workPixbuf = cropPixbuf;
            for (let i = 0; i < actions.length; i++) {
                let act = actions[i];
                if (typeof act.drawReal === 'function') {
                    try {
                        let result = act.drawReal(workPixbuf, GdkPixbuf, GLib, toWidget, drawScale);
                        if (result) workPixbuf = result;
                    } catch (err) {
                        log('[Big Shot] drawReal failed: ' + err.message);
                    }
                }
            }

            // Save pixbuf → PNG → Cairo surface → draw annotations → save
            workPixbuf.savev(tmpBase, 'png', [], []);
            let surface = Cairo.ImageSurface.createFromPNG(tmpBase);
            let cr = new Cairo.Context(surface);

            for (let i = 0; i < actions.length; i++) {
                let act = actions[i];
                if (typeof act.drawReal !== 'function') {
                    cr.save();
                    act.draw(cr, toWidget, drawScale);
                    cr.restore();
                }
            }

            surface.writeToPNG(tmpAnnotated);
            surface.finish();

            let annotPixbuf = GdkPixbuf.Pixbuf.new_from_file(tmpAnnotated);
            let buf = annotPixbuf.save_to_bufferv('png', [], []);
            if (!buf[0]) return null;
            return { bytes: GLib.Bytes.new(buf[1]), pixbuf: annotPixbuf };
        } finally {
            try { Gio.File.new_for_path(tmpBase).delete(null); } catch (e) { /* */ }
            try { Gio.File.new_for_path(tmpAnnotated).delete(null); } catch (e) { /* */ }
        }
    }

    _pixbufToBytes(pixbuf) {
        let result = pixbuf.save_to_bufferv('png', [], []);
        if (!result[0]) throw new Error('Failed to save pixbuf to buffer');
        return GLib.Bytes.new(result[1]);
    }

    _openSaveDialog(tmpPath, pixbuf) {
        try {
            let time = GLib.DateTime.new_now_local();
            let suggestedName = _('Screenshot from %s').format(
                time.format('%Y-%m-%d %H-%M-%S')) + '.png';

            let bus = Gio.DBus.session;
            bus.call(
                'org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser',
                'SaveFile',
                new GLib.Variant('(ssa{sv})', [
                    '',
                    _('Save Screenshot'),
                    {
                        'current_name': new GLib.Variant('s', suggestedName),
                        'current_folder': new GLib.Variant('ay',
                            new TextEncoder().encode(
                                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ||
                                GLib.get_home_dir()
                            )),
                        'filters': new GLib.Variant('a(sa(us))', [
                            ['PNG Images', [
                                [0, '*.png'],
                            ]],
                        ]),
                    },
                ]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, asyncResult) => {
                    try {
                        let result = conn.call_finish(asyncResult);
                        let unpacked = result.deepUnpack();
                        let requestPath = unpacked[0];

                        let subId = bus.signal_subscribe(
                            'org.freedesktop.portal.Desktop',
                            'org.freedesktop.portal.Request',
                            'Response',
                            requestPath,
                            null,
                            Gio.DBusSignalFlags.NO_MATCH_RULE,
                            (c, sender, path, iface, signal, params) => {
                                bus.signal_unsubscribe(subId);
                                let respUnpacked = params.deepUnpack();
                                let response = respUnpacked[0];
                                let results = respUnpacked[1];
                                if (response === 0 && results.uris) {
                                    let uris = results.uris.deepUnpack();
                                    if (uris.length > 0) {
                                        let destFile = Gio.File.new_for_uri(uris[0]);
                                        let srcFile = Gio.File.new_for_path(tmpPath);
                                        try {
                                            srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                                        } catch (err) {
                                            log('[Big Shot] Save failed: ' + err.message);
                                        }
                                    }
                                }
                                try { Gio.File.new_for_path(tmpPath).delete(null); } catch (e) { /* */ }
                            }
                        );
                    } catch (e) {
                        log('[Big Shot] Portal SaveFile failed: ' + e.message);
                        try { Gio.File.new_for_path(tmpPath).delete(null); } catch (e2) { /* */ }
                    }
                }
            );
        } catch (e) {
            log('[Big Shot] Save dialog failed: ' + e.message);
            try { Gio.File.new_for_path(tmpPath).delete(null); } catch (e2) { /* */ }
        }
    }

    // =========================================================================
    // SCREENCAST — Direct GStreamer pipeline (no D-Bus proxy)
    // =========================================================================

    _detectPipelines() {
        if (this._availableConfigs !== null) return;

        this._gpuVendors = detectGpuVendors();
        let vendorSet = {};
        for (let i = 0; i < this._gpuVendors.length; i++) {
            vendorSet[this._gpuVendors[i]] = true;
        }

        let gpuConfigs = [];
        let swConfigs = [];

        for (let i = 0; i < VIDEO_PIPELINES.length; i++) {
            let config = VIDEO_PIPELINES[i];
            if (!checkPipeline(config)) continue;

            if (config.vendors.length === 0) {
                swConfigs.push(config);
                continue;
            }

            let matches = false;
            for (let v = 0; v < config.vendors.length; v++) {
                if (vendorSet[config.vendors[v]]) {
                    matches = true;
                    break;
                }
            }
            if (matches) gpuConfigs.push(config);
        }

        this._availableConfigs = gpuConfigs.concat(swConfigs);

        if (this._availableConfigs.length === 0) {
            log('[Big Shot] No compatible GStreamer pipeline found!');
        }
    }

    /**
     * Called when the screenshot UI closes (ESC, capture done, etc.).
     * Resets transient part state so the next open starts fresh.
     */
    _onUIClosed() {
        log('[Big Shot] _onUIClosed called, recordingState=' + this._recordingState);
        // Don't reset if a recording is in progress
        if (this._recordingState !== 'idle')
            return;

        // Stop and reset webcam
        if (this._webcam) {
            this._webcam.stopPreview();
            this._webcam.enabled = false;
            if (this._webcam._webcamButton)
                this._webcam._webcamButton.checked = false;
        }

        // Close video settings panel if open
        if (this._toolbar && this._toolbar._editButton) {
            this._toolbar._editButton.checked = false;
        }
    }

    _startScreencast() {
        this._detectPipelines();

        if (this._availableConfigs.length === 0) {
            log('[Big Shot] No GStreamer pipeline available for screencast');
            return;
        }

        let framerate = (this._framerate && this._framerate.value) ? this._framerate.value : 30;
        let downsize = (this._downsize && this._downsize.value) ? this._downsize.value : 1.0;
        let quality = (this._toolbar && this._toolbar.videoQuality) ? this._toolbar.videoQuality : 'high';

        // Get output file path
        let time = GLib.DateTime.new_now_local();
        let dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        if (!dir) dir = GLib.get_home_dir();
        let screenscastDir = GLib.build_filenamev([dir, 'Screencasts']);
        try {
            Gio.File.new_for_path(screenscastDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                log('[Big Shot] Failed to create screencast dir: ' + e.message);
            }
        }

        // Build configs list with preferred first
        let configs = this._availableConfigs.slice();
        let preferredId = this._toolbar ? this._toolbar.selectedPipelineId : null;
        if (preferredId) {
            for (let i = 0; i < configs.length; i++) {
                if (configs[i].id === preferredId && i > 0) {
                    let preferred = configs.splice(i, 1)[0];
                    configs.unshift(preferred);
                    break;
                }
            }
        }

        // Try to start recording with the first available config
        let config = configs[0];
        let pipeline = this._makePipelineString(config, framerate + '/1', downsize, quality);
        let ext = config.ext;
        let baseName = _('Screencast from %s').format(
            time.format('%Y-%m-%d %H-%M-%S'));
        let filePath = GLib.build_filenamev([screenscastDir, baseName + '.' + ext]);

        // Use GStreamer to record the screen directly
        // On X11: ximagesrc, on Wayland: pipewiresrc
        let isWayland = GLib.getenv('WAYLAND_DISPLAY') !== null;
        let srcElement = isWayland
            ? 'pipewiresrc ! videoconvert'
            : 'ximagesrc use-damage=0 show-pointer=true ! videoconvert';

        let fullPipeline = srcElement + ' ! video/x-raw,framerate=' + framerate + '/1 ! ' +
                           pipeline + ' ! filesink location=' + GLib.shell_quote(filePath);

        log('[Big Shot] Starting screencast: ' + fullPipeline);

        try {
            // Launch GStreamer pipeline as a subprocess
            // Use shell_parse_argv to correctly handle paths with spaces
            let [parseOk, argv] = GLib.shell_parse_argv('gst-launch-1.0 -e ' + fullPipeline);
            if (!parseOk) {
                log('[Big Shot] Failed to parse screencast pipeline command');
                return;
            }
            this._screencastProcess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.NONE
            );

            this._recordingState = 'recording';
            this._currentSegmentPath = filePath;
            this._recordingContext = { config: config };

            if (this._indicator) this._indicator.onRecordingStarted();

            // Reparent webcam to chrome before closing UI,
            // so it stays visible during recording
            if (this._webcam && this._webcam.enabled)
                this._webcam.reparentForRecording();

            this._screenshotUI.close();
            this._screenshotUI.screencastInProgress = true;

            // Watch for process exit
            this._screencastProcess.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                } catch (e) {
                    log('[Big Shot] Screencast process error: ' + e.message);
                }
                this._onFinalStop();
            });

        } catch (e) {
            log('[Big Shot] Failed to start screencast: ' + e.message);
        }
    }

    _quickStop() {
        if (this._recordingState === 'paused') {
            this._signalScreencastProcess('CONT');
        }
        if (this._screencastProcess) {
            // Send SIGINT to gracefully stop gst-launch
            this._signalScreencastProcess('INT');
        }
    }

    // =========================================================================
    // PAUSE / RESUME
    // =========================================================================

    _findScreencastPid() {
        if (this._screencastProcess) {
            // GSubprocess has get_identifier() which returns PID as string
            let pid = this._screencastProcess.get_identifier();
            return pid ? parseInt(pid, 10) : 0;
        }
        return 0;
    }

    _signalScreencastProcess(signal) {
        let pid = this._findScreencastPid();
        if (!pid) {
            log('[Big Shot] Screencast process not found for signal');
            return false;
        }
        try {
            let proc = Gio.Subprocess.new(
                ['kill', '-' + signal, String(pid)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.wait(null);
            return proc.get_successful();
        } catch (e) {
            log('[Big Shot] Failed to signal process: ' + e.message);
            return false;
        }
    }

    pauseRecording() {
        if (this._recordingState !== 'recording') return;
        if (this._signalScreencastProcess('STOP')) {
            this._recordingState = 'paused';
            if (this._indicator) this._indicator.onPaused();
        }
    }

    resumeRecording() {
        if (this._recordingState !== 'paused') return;
        if (this._signalScreencastProcess('CONT')) {
            this._recordingState = 'recording';
            if (this._indicator) this._indicator.onResumed();
        }
    }

    togglePauseRecording() {
        if (this._recordingState === 'recording') {
            this.pauseRecording();
        } else if (this._recordingState === 'paused') {
            this.resumeRecording();
        }
    }

    _onFinalStop() {
        if (this._recordingState === 'idle') return;

        this._recordingState = 'idle';
        if (this._indicator) this._indicator.onRecordingStopped();
        if (this._webcam) this._webcam.stopPreview();
        this._recordingContext = null;
        this._screencastProcess = null;
        this._screenshotUI.screencastInProgress = false;
    }

    _makePipelineString(config, framerateCaps, downsize, quality) {
        let video = config.src;
        let preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
        video += ' ! ' + config.enc(preset);

        if (downsize < 1.0) {
            let monitor = global.display.get_current_monitor();
            let geo = global.display.get_monitor_geometry(monitor);
            let targetW = Math.round(geo.width * downsize);
            let targetH = Math.round(geo.height * downsize);
            video = video.replace(
                /queue/,
                'queue ! videoscale ! video/x-raw,width=' + targetW + ',height=' + targetH
            );
        }

        let audioInput = this._audio ? this._audio.makeAudioInput() : null;
        let ext = config.ext;
        let muxer = MUXERS[ext];

        if (audioInput) {
            let audioPipeline = ext === 'mp4' ? AUDIO_PIPELINE.aac : AUDIO_PIPELINE.vorbis;
            let videoSeg = video + ' ! queue ! mux.';
            let audioSeg = audioInput + ' ! ' + audioPipeline + ' ! mux.';
            let muxDef = muxer + ' name=mux';
            return videoSeg + ' ' + audioSeg + ' ' + muxDef;
        }

        return video + ' ! ' + muxer;
    }

    _showNotification(title, body) {
        try {
            let source = new imports.ui.messageTray.SystemNotificationSource('Big Shot');
            Main.messageTray.add(source);
            let notification = new imports.ui.messageTray.Notification(
                source, title, body);
            source.notify(notification);
        } catch (e) {
            log('[Big Shot] Notification: ' + title + ' - ' + body);
        }
    }
};

// =============================================================================
// CINNAMON EXTENSION ENTRY POINTS
// =============================================================================

function init(metadata) {
    _extensionMeta = metadata;
    _extensionPath = metadata.path;
}

function enable() {
    _instance = new BigShotExtension(_extensionMeta);
    _instance.enable();
}

function disable() {
    if (_instance) {
        _instance.disable();
        _instance = null;
    }
}
