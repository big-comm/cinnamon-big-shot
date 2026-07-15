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

var APP_VERSION = '26.8.4';

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cairo = imports.gi.cairo;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;

let _extensionMeta = null;
let _extensionPath = null;
let _instance = null;

let _ = function(str) { return str; };

function computeCanvasExpansion(actions, imgW, imgH,
    offsetX, offsetY, bufScale) {
    if (!actions || actions.length === 0)
        return { expanded: false };

    const imageMaxX = offsetX + imgW / bufScale;
    const imageMaxY = offsetY + imgH / bufScale;
    let minX = offsetX;
    let minY = offsetY;
    let maxX = imageMaxX;
    let maxY = imageMaxY;
    let expanded = false;

    for (const action of actions) {
        if (!action.expandsCanvas || typeof action.getBounds !== 'function')
            continue;
        const bounds = action.getBounds();
        if (bounds[0] < minX) { minX = bounds[0]; expanded = true; }
        if (bounds[1] < minY) { minY = bounds[1]; expanded = true; }
        if (bounds[2] > maxX) { maxX = bounds[2]; expanded = true; }
        if (bounds[3] > maxY) { maxY = bounds[3]; expanded = true; }
    }

    if (!expanded)
        return { expanded: false };

    const padLeft = Math.max(0, Math.ceil((offsetX - minX) * bufScale));
    const padTop = Math.max(0, Math.ceil((offsetY - minY) * bufScale));
    const padRight = Math.max(0, Math.ceil((maxX - imageMaxX) * bufScale));
    const padBottom = Math.max(0, Math.ceil((maxY - imageMaxY) * bufScale));
    return {
        expanded: true,
        padLeft,
        padTop,
        newWidth: imgW + padLeft + padRight,
        newHeight: imgH + padTop + padBottom,
    };
}

// =============================================================================
// GPU DETECTION
// =============================================================================

const GpuVendor = {
    NVIDIA: 'nvidia',
    AMD: 'amd',
    INTEL: 'intel',
    UNKNOWN: 'unknown',
};

function communicateUtf8Async(proc) {
    return new Promise((resolve, reject) => {
        proc.communicate_utf8_async(null, null, (source, result) => {
            try {
                resolve(source.communicate_utf8_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function communicateUtf8WithTimeout(proc, timeoutMs, operation) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            timeoutMs,
            () => {
                timeoutId = 0;
                if (settled)
                    return GLib.SOURCE_REMOVE;

                settled = true;
                try { proc.force_exit(); } catch (_e) { /* */ }
                reject(new Error(operation + ' timed out after ' + timeoutMs + ' ms'));
                return GLib.SOURCE_REMOVE;
            }
        );

        proc.communicate_utf8_async(null, null, (source, result) => {
            if (settled)
                return;
            settled = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            try {
                resolve(source.communicate_utf8_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function waitAsync(proc) {
    return new Promise((resolve, reject) => {
        proc.wait_async(null, (source, result) => {
            try {
                source.wait_finish(result);
                resolve(source.get_successful());
            } catch (e) {
                reject(e);
            }
        });
    });
}

function waitForStageRedraw(milliseconds) {
    return new Promise(resolve => {
        global.stage.queue_redraw();
        GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            milliseconds,
            () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
        );
    });
}

async function detectGpuVendors() {
    try {
        let proc = Gio.Subprocess.new(
            ['lspci'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        let result = await communicateUtf8Async(proc);
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

const AUDIO_PIPELINES = {
    vorbis: [
        { element: 'vorbisenc', pipeline: 'vorbisenc ! queue' },
    ],
    aac: [
        { element: 'fdkaacenc', pipeline: 'fdkaacenc ! queue' },
        { element: 'avenc_aac', pipeline: 'avenc_aac ! queue' },
        { element: 'voaacenc', pipeline: 'voaacenc ! queue' },
    ],
};

const MUXERS = {
    mp4: 'mp4mux fragment-duration=500',
    webm: 'webmmux',
};

const RECORDING_SEGMENT_FOLDER = '.segments';
const RECORDING_MANIFEST_NAME = 'session.json';
const RECORDING_RECOVERY_CLAIM_NAME = 'recovery.claim';
const RECORDING_RESERVATION_SUFFIX = '.bigshot-reserve';
const SEGMENT_STOP_TIMEOUT_MS = 8000;
const MEDIA_PROBE_TIMEOUT_MS = 15000;
const SEGMENT_MERGE_TIMEOUT_MS = 120000;
const RECOVERY_CLAIM_STALE_SECONDS = 300;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function checkElement(name) {
    try {
        let proc = Gio.Subprocess.new(
            ['gst-inspect-1.0', '--exists', name],
            Gio.SubprocessFlags.NONE
        );
        return await waitAsync(proc);
    } catch (e) {
        return false;
    }
}

function toEvenDimension(value) {
    let rounded = Math.max(2, Math.round(value));
    return rounded - (rounded % 2);
}

function parseMediaRate(value) {
    let parts = String(value || '').split('/');
    if (parts.length !== 2)
        return Number(value) || 0;
    let numerator = Number(parts[0]);
    let denominator = Number(parts[1]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) ||
        denominator === 0)
        return 0;
    return numerator / denominator;
}

function normalizeCaptureGeometry(geometry, screenWidth, screenHeight) {
    if (!Array.isArray(geometry) || geometry.length < 4)
        return null;

    let x = Number(geometry[0]);
    let y = Number(geometry[1]);
    let width = Number(geometry[2]);
    let height = Number(geometry[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) ||
        !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 || screenWidth < 2 || screenHeight < 2)
        return null;

    let left = Math.max(0, Math.floor(x));
    let top = Math.max(0, Math.floor(y));
    let right = Math.min(screenWidth, Math.ceil(x + width));
    let bottom = Math.min(screenHeight, Math.ceil(y + height));
    let actualWidth = right - left;
    let actualHeight = bottom - top;

    actualWidth -= actualWidth % 2;
    actualHeight -= actualHeight % 2;
    if (actualWidth < 2 || actualHeight < 2)
        return null;

    return {
        x: left,
        y: top,
        width: actualWidth,
        height: actualHeight,
    };
}

function getVirtualScreenGeometry() {
    let count = global.display.get_n_monitors();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
        let rect = global.display.get_monitor_geometry(i);
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    }
    if (!Number.isFinite(minX))
        return { x: 0, y: 0, width: global.screen_width,
            height: global.screen_height };
    return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function buildRecordingRegionRects(geometry, screenWidth, screenHeight, borderSize) {
    let masks = [];
    let borders = [];
    let right = geometry.x + geometry.width;
    let bottom = geometry.y + geometry.height;
    let addRect = function(list, x, y, width, height) {
        if (width > 0 && height > 0)
            list.push({ x: x, y: y, width: width, height: height });
    };

    addRect(masks, 0, 0, screenWidth, geometry.y);
    addRect(masks, 0, bottom, screenWidth, screenHeight - bottom);
    addRect(masks, 0, geometry.y, geometry.x, geometry.height);
    addRect(masks, right, geometry.y, screenWidth - right, geometry.height);

    let topBorder = Math.min(borderSize, geometry.y);
    let bottomBorder = Math.min(borderSize, screenHeight - bottom);
    let leftBorder = Math.min(borderSize, geometry.x);
    let rightBorder = Math.min(borderSize, screenWidth - right);
    addRect(borders, geometry.x, geometry.y - topBorder,
        geometry.width, topBorder);
    addRect(borders, geometry.x, bottom,
        geometry.width, bottomBorder);
    addRect(borders, geometry.x - leftBorder, geometry.y,
        leftBorder, geometry.height);
    addRect(borders, right, geometry.y,
        rightBorder, geometry.height);

    return { masks: masks, borders: borders };
}

function buildRecordingSessionId() {
    let now = GLib.DateTime.new_now_local();
    let stamp = now.format('%Y%m%d-%H%M%S');
    let suffix = Math.floor(Math.random() * 0x1000000)
        .toString(16)
        .padStart(6, '0');
    return stamp + '-' + suffix;
}

function createRecordingSessionDirectory(recordingDir) {
    let sessionsRoot = GLib.build_filenamev([
        recordingDir,
        RECORDING_SEGMENT_FOLDER,
    ]);
    if (GLib.mkdir_with_parents(sessionsRoot, 0o700) < 0)
        throw new Error('Could not create the recording sessions directory');

    for (let attempt = 0; attempt < 20; attempt++) {
        let id = buildRecordingSessionId();
        let path = GLib.build_filenamev([sessionsRoot, id]);
        if (GLib.mkdir(path, 0o700) === 0)
            return { id: id, path: path };
    }
    throw new Error('Could not allocate a unique recording session directory');
}

function makeUniqueFilePath(path) {
    if (!Gio.File.new_for_path(path).query_exists(null))
        return path;

    let dot = path.lastIndexOf('.');
    let stem = dot > 0 ? path.substring(0, dot) : path;
    let ext = dot > 0 ? path.substring(dot) : '';
    for (let i = 2; i < 1000; i++) {
        let candidate = stem + ' (' + i + ')' + ext;
        if (!Gio.File.new_for_path(candidate).query_exists(null))
            return candidate;
    }
    throw new Error('Could not allocate a unique recording path');
}

function reserveRecordingOutput(path, sessionId) {
    let dot = path.lastIndexOf('.');
    let stem = dot > 0 ? path.substring(0, dot) : path;
    let ext = dot > 0 ? path.substring(dot) : '';
    for (let i = 1; i < 1000; i++) {
        let candidate = i === 1 ? path : stem + ' (' + i + ')' + ext;
        let finalFile = Gio.File.new_for_path(candidate);
        if (finalFile.query_exists(null))
            continue;

        let reservationPath = candidate + RECORDING_RESERVATION_SUFFIX;
        let reservationFile = Gio.File.new_for_path(reservationPath);
        let token = buildRecordingSessionId();
        try {
            let stream = reservationFile.create(Gio.FileCreateFlags.NONE, null);
            stream.write_bytes(GLib.Bytes.new(ByteArray.fromString(JSON.stringify({
                version: 1,
                sessionId: sessionId,
                token: token,
                finalPath: candidate,
            }) + '\n')), null);
            stream.close(null);
            if (finalFile.query_exists(null)) {
                reservationFile.delete(null);
                continue;
            }
            return {
                finalPath: candidate,
                path: reservationPath,
                token: token,
            };
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                continue;
            throw e;
        }
    }
    throw new Error('Could not reserve a unique recording path');
}

function getCurrentBootId() {
    try {
        let loaded = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
        return loaded[0] ? ByteArray.toString(loaded[1]).trim() : null;
    } catch (_e) {
        return null;
    }
}

function readProcessIdentity(pid, segmentPath) {
    pid = Number(pid);
    if (!Number.isInteger(pid) || pid < 1)
        return null;
    try {
        let procRoot = '/proc/' + pid;
        let statLoaded = GLib.file_get_contents(procRoot + '/stat');
        let stat = ByteArray.toString(statLoaded[1]);
        let commandEnd = stat.lastIndexOf(')');
        if (commandEnd < 0)
            return null;
        let fields = stat.substring(commandEnd + 2).trim().split(/\s+/);
        let startTime = fields[19];
        let executable = GLib.file_read_link(procRoot + '/exe');
        let cmdlineLoaded = GLib.file_get_contents(procRoot + '/cmdline');
        let cmdline = ByteArray.toString(cmdlineLoaded[1])
            .split('\0')
            .filter(value => value.length > 0);
        return {
            bootId: getCurrentBootId(),
            pid: pid,
            startTime: startTime,
            executable: executable,
            segmentPath: segmentPath,
            commandContainsSegment: cmdline.some(arg =>
                arg === segmentPath || arg.endsWith('=' + segmentPath)
            ),
        };
    } catch (_e) {
        return null;
    }
}

function deletePathIfExists(path) {
    if (!path) return;
    try {
        let file = Gio.File.new_for_path(path);
        if (file.query_exists(null))
            file.delete(null);
    } catch (e) {
        log('[Big Shot] Failed to delete ' + path + ': ' + e.message);
    }
}

function getRecordingOwnerRegistry() {
    if (!(global.__bigShotRecordingOwners instanceof Set))
        global.__bigShotRecordingOwners = new Set();
    return global.__bigShotRecordingOwners;
}

function readJsonFile(path) {
    let loaded = Gio.File.new_for_path(path).load_contents(null);
    if (!loaded[0])
        throw new Error('Could not read ' + path);
    return JSON.parse(ByteArray.toString(loaded[1]));
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
        this._availableElements = new Set();
        this._pipelineDetectionPromise = null;
        this._pipelineDetectionGeneration = 0;
        this._screencastStartGeneration = 0;
        this._screencastStarting = false;
        this._currentConfigIndex = 0;

        // Recording lifecycle
        this._recordingState = 'idle';
        this._recordingContext = null;
        this._recordingSession = null;
        this._screencastProcess = null;
        this._currentSegmentPath = null;
        this._recordingRegionMask = null;
        this._disabled = false;
        this._recoveryRunning = false;
        this._recordingScreenshotPending = false;

        this._screenshotUI = null;
    }

    enable() {
        this._disabled = false;
        this._pipelineDetectionGeneration++;

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
            this._startScreencast().catch(e => {
                log('[Big Shot] Failed to start screencast: ' + e.message);
            });
        });

        // Reset parts state when UI is closed (ESC, capture done, etc.)
        this._screenshotUI.connect('closed', () => {
            this._onUIClosed();
        });

        // Provide screenshot pixbuf to annotation overlay when ready
        this._screenshotUI.connect('screenshot-ready', (ui, pixbuf) => {
            if (this._annotation && this._annotation._overlay) {
                this._annotation._overlay.setCachedPixbuf(
                    pixbuf,
                    this._screenshotUI.captureScale
                );
            }
        });

        // Notify only after the final PNG has been written successfully.
        this._screenshotUI.connect('screenshot-taken', (ui, filePath) => {
            if (this._disabled || !filePath)
                return;

            let screenshotFile = Gio.File.new_for_path(filePath);
            if (!screenshotFile.query_exists(null))
                return;

            this._showNotification(
                _('Screenshot taken'),
                _('Click to open the Screenshots folder'),
                GLib.path_get_dirname(filePath)
            );
        });

        // Wire annotation compositor for screenshot save
        let ext = this;
        this._screenshotUI._annotationCompositor = function(croppedPixbuf, geom) {
            let overlay = ext._annotation ? ext._annotation._overlay : null;
            let actions = overlay ? overlay._actions : [];
            let originalGeom = geom;
            let presentationCrop = ext._getPresentationCrop(geom);
            if (presentationCrop) {
                let scale = ext._screenshotUI.captureScale;
                let relX = Math.max(0, Math.round(
                    (presentationCrop[0] - originalGeom[0]) * scale
                ));
                let relY = Math.max(0, Math.round(
                    (presentationCrop[1] - originalGeom[1]) * scale
                ));
                let relW = Math.min(
                    Math.round(presentationCrop[2] * scale),
                    croppedPixbuf.get_width() - relX
                );
                let relH = Math.min(
                    Math.round(presentationCrop[3] * scale),
                    croppedPixbuf.get_height() - relY
                );
                if (relW > 0 && relH > 0) {
                    croppedPixbuf = croppedPixbuf.new_subpixbuf(
                        relX, relY, relW, relH
                    );
                    geom = presentationCrop;
                }
            }
            if (!actions || actions.length === 0) {
                return ext._hasPresentation()
                    ? ext._applyPresentation(croppedPixbuf)
                    : null;
            }

            let offsetX = Math.max(0, geom[0]);
            let offsetY = Math.max(0, geom[1]);
            let bufScale = ext._screenshotUI.captureScale;

            let toWidget = function(ax, ay) {
                return [
                    (ax - offsetX) * bufScale,
                    (ay - offsetY) * bufScale,
                ];
            };
            let drawScale = bufScale;

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
                let expansion = computeCanvasExpansion(
                    actions,
                    workPixbuf.get_width(),
                    workPixbuf.get_height(),
                    offsetX,
                    offsetY,
                    bufScale
                );
                let surface;
                let cr;
                let drawToWidget = toWidget;
                if (expansion.expanded) {
                    let baseSurface = Cairo.ImageSurface.createFromPNG(tmpBase);
                    surface = new Cairo.ImageSurface(
                        Cairo.Format.ARGB32,
                        expansion.newWidth,
                        expansion.newHeight
                    );
                    cr = new Cairo.Context(surface);
                    cr.setSourceRGBA(1, 1, 1, 1);
                    cr.paint();
                    cr.setSourceSurface(
                        baseSurface,
                        expansion.padLeft,
                        expansion.padTop
                    );
                    cr.paint();
                    baseSurface.finish();
                    drawToWidget = function(ax, ay) {
                        let point = toWidget(ax, ay);
                        return [
                            point[0] + expansion.padLeft,
                            point[1] + expansion.padTop,
                        ];
                    };
                } else {
                    surface = Cairo.ImageSurface.createFromPNG(tmpBase);
                    cr = new Cairo.Context(surface);
                }

                for (let i = 0; i < actions.length; i++) {
                    let act = actions[i];
                    if (typeof act.drawReal !== 'function') {
                        cr.save();
                        act.draw(cr, drawToWidget, drawScale);
                        cr.restore();
                    }
                }

                surface.writeToPNG(tmpOut);
                surface.finish();

                return ext._applyPresentation(
                    GdkPixbuf.Pixbuf.new_from_file(tmpOut)
                );
            } catch (e) {
                log('[Big Shot] Annotation compositing error: ' + e.message);
                return null;
            } finally {
                try { Gio.File.new_for_path(tmpBase).delete(null); } catch (e) { /* */ }
                try { Gio.File.new_for_path(tmpOut).delete(null); } catch (e) { /* */ }
            }
        };

        // Warm codec detection without blocking Cinnamon's main loop.
        this._detectPipelines().catch(e => {
            log('[Big Shot] Pipeline detection failed: ' + e.message);
        });
        this._recoverRecordingSessions().catch(e => {
            log('[Big Shot] Recording recovery scan failed: ' + e.message);
        });

        log('[Big Shot] Extension enabled for Cinnamon');
    }

    disable() {
        this._disabled = true;
        this._pipelineDetectionGeneration++;
        this._pipelineDetectionPromise = null;
        this._screencastStartGeneration++;
        this._screencastStarting = false;

        // Keep the session alive until its asynchronous process callback has
        // finalized the current segment. Dropping it here can orphan gst-launch.
        let session = this._recordingSession;
        if (session) {
            session.notifyOnComplete = false;
            session.stopRequested = true;
            session.disabling = true;

            if (session.currentSegment && !session.currentSegment.exitHandled) {
                this._recordingState = 'stopping';
                if (!this._requestSegmentStop(session, session.currentSegment, 'disable')) {
                    session.errorMessage = 'Failed to stop the active segment while disabling';
                    this._beginRecordingFinalization(session);
                }
            } else {
                this._beginRecordingFinalization(session);
            }
        } else {
            this._recordingState = 'idle';
            this._recordingContext = null;
            this._currentSegmentPath = null;
            this._screencastProcess = null;
        }

        this._destroyRecordingRegionMask();

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
        this._availableElements.clear();

        log('[Big Shot] Extension disabled');
    }

    // =========================================================================
    // RECORDING RECOVERY
    // =========================================================================

    async _recoverRecordingSessions() {
        if (this._recoveryRunning)
            return;
        this._recoveryRunning = true;

        let videosDir = GLib.get_user_special_dir(
            GLib.UserDirectory.DIRECTORY_VIDEOS
        ) || GLib.get_home_dir();
        let recordingDir = GLib.build_filenamev([videosDir, 'BigShot']);
        let sessionsPath = GLib.build_filenamev([
            recordingDir,
            RECORDING_SEGMENT_FOLDER,
        ]);
        let sessionsDir = Gio.File.new_for_path(sessionsPath);
        if (!sessionsDir.query_exists(null)) {
            this._recoveryRunning = false;
            return;
        }
        try {
            let rootInfo = sessionsDir.query_info(
                'standard::type,standard::is-symlink',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (rootInfo.get_file_type() !== Gio.FileType.DIRECTORY ||
                rootInfo.get_is_symlink()) {
                log('[Big Shot] Recording recovery root is not a real directory: ' +
                    sessionsPath);
                this._recoveryRunning = false;
                return;
            }
        } catch (e) {
            log('[Big Shot] Could not validate recording recovery root: ' + e.message);
            this._recoveryRunning = false;
            return;
        }

        let enumerator = null;
        let pending = [];
        try {
            enumerator = sessionsDir.enumerate_children(
                'standard::name,standard::type,standard::is-symlink',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY ||
                    info.get_is_symlink())
                    continue;
                let sessionPath = GLib.build_filenamev([
                    sessionsPath,
                    info.get_name(),
                ]);
                let manifestPath = GLib.build_filenamev([
                    sessionPath,
                    RECORDING_MANIFEST_NAME,
                ]);
                if (Gio.File.new_for_path(manifestPath).query_exists(null)) {
                    let manifestInfo = Gio.File.new_for_path(manifestPath).query_info(
                        'standard::type,standard::is-symlink,time::modified',
                        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                        null
                    );
                    if (manifestInfo.get_file_type() !== Gio.FileType.REGULAR ||
                        manifestInfo.get_is_symlink())
                        continue;
                    pending.push({
                        id: info.get_name(),
                        path: sessionPath,
                        manifestPath: manifestPath,
                        modified: Number(manifestInfo.get_attribute_uint64(
                            'time::modified'
                        )),
                    });
                }
            }
        } catch (e) {
            log('[Big Shot] Failed to scan recording recovery files: ' + e.message);
        } finally {
            if (enumerator) {
                try { enumerator.close(null); } catch (_e) { /* */ }
            }
        }

        pending.sort((left, right) => left.id.localeCompare(right.id));
        try {
            for (let i = 0; i < pending.length; i++)
                await this._recoverRecordingSession(pending[i], recordingDir);
        } finally {
            this._recoveryRunning = false;
        }
    }

    _claimRecordingRecovery(item, manifest) {
        let owners = getRecordingOwnerRegistry();
        if (owners.has(item.id)) {
            log('[Big Shot] Recovery skipped for active session ' + item.id);
            return null;
        }
        let ageSeconds = Math.floor(Date.now() / 1000) - item.modified;
        let stableState = manifest.state === 'recovery-required' ||
            manifest.state === 'paused';
        if (manifest.currentSegment) {
            let writer = manifest.currentSegment.writer;
            if (!writer || Number(manifest.version) < 3) {
                log('[Big Shot] Recovery requires manual review for legacy ' +
                    'unsettled session ' + item.path);
                return null;
            }
            if (this._recordingWriterIsActive(writer)) {
                log('[Big Shot] Recovery skipped for active writer in session ' +
                    item.id);
                return null;
            }
            stableState = ageSeconds >= 2;
        }
        if (manifest.state === 'finalizing' &&
            (Number(manifest.version) || 1) === 1 && ageSeconds >= 300) {
            try {
                stableState = this._discoverRecoverySegments(
                    item.path,
                    String(manifest.extension || '')
                ).length === 1;
            } catch (_e) {
                stableState = false;
            }
        }
        if (!stableState) {
            log('[Big Shot] Recovery requires manual review for session state ' +
                manifest.state + ': ' + item.path);
            return null;
        }
        if (ageSeconds < 2) {
            log('[Big Shot] Recovery session is still within its finalization window: ' +
                item.id);
            return null;
        }

        let claimPath = GLib.build_filenamev([
            item.path,
            RECORDING_RECOVERY_CLAIM_NAME,
        ]);
        let claimFile = Gio.File.new_for_path(claimPath);
        if (claimFile.query_exists(null)) {
            try {
                let info = claimFile.query_info(
                    'standard::type,standard::is-symlink,time::modified',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null
                );
                if (info.get_file_type() !== Gio.FileType.REGULAR ||
                    info.get_is_symlink()) {
                    log('[Big Shot] Recovery claim is not a regular file: ' +
                        claimPath);
                    return null;
                }
                let claimAge = Math.floor(Date.now() / 1000) -
                    Number(info.get_attribute_uint64('time::modified'));
                if (claimAge < RECOVERY_CLAIM_STALE_SECONDS) {
                    log('[Big Shot] Recovery already claimed for session ' + item.id);
                    return null;
                }
                claimFile.delete(null);
            } catch (e) {
                log('[Big Shot] Could not inspect recovery claim: ' + e.message);
                return null;
            }
        }

        let claimToken = buildRecordingSessionId();
        try {
            let stream = claimFile.create(Gio.FileCreateFlags.NONE, null);
            stream.close(null);
            claimFile.replace_contents(
                ByteArray.fromString(JSON.stringify({ token: claimToken }) + '\n'),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
        } catch (e) {
            log('[Big Shot] Could not claim recovery session ' + item.id + ': ' +
                e.message);
            return null;
        }

        owners.add(item.id);
        return { path: claimPath, token: claimToken };
    }

    _recordingWriterIsActive(writer) {
        if (!writer || !writer.bootId || !writer.startTime ||
            !writer.executable || !writer.segmentPath)
            return false;
        if (writer.bootId !== getCurrentBootId())
            return false;
        let current = readProcessIdentity(writer.pid, writer.segmentPath);
        return !!(current && current.bootId === writer.bootId &&
            current.startTime === String(writer.startTime) &&
            current.executable === writer.executable &&
            current.segmentPath === writer.segmentPath &&
            current.commandContainsSegment &&
            GLib.path_get_basename(current.executable) === 'gst-launch-1.0');
    }

    _releaseRecordingRecovery(id, claim) {
        getRecordingOwnerRegistry().delete(id);
        if (!claim)
            return;
        try {
            let stored = readJsonFile(claim.path);
            if (stored.token === claim.token)
                deletePathIfExists(claim.path);
        } catch (_e) { /* Preserve a foreign or unreadable claim. */ }
    }

    _refreshRecordingRecoveryClaim(session) {
        if (!session || !session.recovering || !session.recoveryClaimPath)
            return;
        let stored = readJsonFile(session.recoveryClaimPath);
        if (stored.token !== session.recoveryClaimToken)
            throw new Error('Recording recovery claim ownership changed');
        Gio.File.new_for_path(session.recoveryClaimPath).replace_contents(
            ByteArray.fromString(JSON.stringify({
                token: session.recoveryClaimToken,
            }) + '\n'),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );
    }

    _discoverRecoverySegments(sessionDir, ext) {
        let directory = Gio.File.new_for_path(sessionDir);
        let enumerator = directory.enumerate_children(
            'standard::name,standard::type,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        let segments = [];
        let indexes = new Set();
        let pattern = new RegExp('^segment-(\\d+)\\.' + ext + '$');
        try {
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.REGULAR ||
                    info.get_is_symlink())
                    continue;
                let match = pattern.exec(info.get_name());
                if (!match)
                    continue;
                let index = Number(match[1]);
                if (!Number.isInteger(index) || index < 1 || indexes.has(index))
                    throw new Error('Duplicate or invalid recording segment index');
                indexes.add(index);
                if (segments.length >= 1000)
                    throw new Error('Recording recovery has too many segments');
                segments.push({
                    index: index,
                    fileName: info.get_name(),
                    path: GLib.build_filenamev([sessionDir, info.get_name()]),
                    stopIntent: 'recovery',
                    forced: false,
                    probe: null,
                });
            }
        } finally {
            try { enumerator.close(null); } catch (_e) { /* */ }
        }
        segments.sort((left, right) => left.index - right.index);
        if (segments.length > 0 && segments[0].index !== 1)
            throw new Error('Recording recovery does not contain its first segment');
        return segments;
    }

    _buildRecoverySession(item, manifest, recordingDir, claim) {
        let version = Number(manifest.version) || 1;
        if (version !== 1 && version !== 2 && version !== 3)
            throw new Error('Unsupported recording recovery manifest version');
        if (String(manifest.id || '') !== item.id)
            throw new Error('Recording recovery manifest id does not match its folder');

        let ext = String(manifest.extension || '');
        if (ext !== 'mp4' && ext !== 'webm')
            throw new Error('Unsupported recording recovery extension');

        let framerate = Number(manifest.framerate);
        if (!Number.isFinite(framerate) || framerate < 1 || framerate > 240)
            throw new Error('Invalid recovery frame rate');

        let finalPath = String(
            manifest.publication && manifest.publication.finalPath ||
            manifest.finalPath || ''
        );
        let finalFile = Gio.File.new_for_path(finalPath);
        let finalParent = finalFile.get_parent();
        if (!finalPath || !finalParent ||
            !finalParent.equal(Gio.File.new_for_path(recordingDir)) ||
            !finalPath.endsWith('.' + ext)) {
            throw new Error('Recovery output path is outside the BigShot folder');
        }

        let rawPublication = manifest.publication;
        if (!rawPublication || typeof rawPublication !== 'object' ||
            Array.isArray(rawPublication))
            rawPublication = {};
        let publicationPhase = String(
            rawPublication.phase || manifest.state || 'pending'
        );

        return {
            id: item.id,
            manifestVersion: version,
            ext: ext,
            recordingDir: recordingDir,
            sessionDir: item.path,
            manifestPath: item.manifestPath,
            finalPath: finalPath,
            pipelineBase: String(manifest.pipeline || ''),
            captureGeometry: manifest.captureGeometry || null,
            displayGeometry: manifest.displayGeometry || null,
            screenGeometry: manifest.screenGeometry || null,
            requestedGeometry: manifest.requestedGeometry || null,
            includeCursor: !!manifest.includeCursor,
            framerate: framerate,
            downsize: Number(manifest.downsize) || 1,
            quality: String(manifest.quality || 'high'),
            startedAt: manifest.startedAt || null,
            segments: this._discoverRecoverySegments(item.path, ext),
            currentSegment: null,
            nextIndex: 1,
            stopRequested: true,
            finalizing: true,
            finalizePromise: null,
            notifyOnComplete: true,
            disabling: false,
            errorMessage: null,
            status: 'recovering',
            publication: {
                phase: publicationPhase,
                finalPath: finalPath,
                expectedDuration: Number(rawPublication.expectedDuration) || 0,
                expectedSignature: rawPublication.expectedSignature || null,
                reservationPath: rawPublication.reservationPath || null,
                reservationToken: rawPublication.reservationToken || null,
            },
            recoveryClaimPath: claim.path,
            recoveryClaimToken: claim.token,
            recovering: true,
        };
    }

    _validateRecordingReservation(session, required) {
        let publication = session && session.publication;
        let reservationPath = publication && publication.reservationPath;
        let reservationToken = publication && publication.reservationToken;
        if (!reservationPath || !reservationToken) {
            if (required)
                throw new Error('Recording output reservation is missing');
            return false;
        }
        if (reservationPath !==
            session.finalPath + RECORDING_RESERVATION_SUFFIX)
            throw new Error('Recording output reservation path changed');
        let file = Gio.File.new_for_path(reservationPath);
        let info = file.query_info(
            'standard::type,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null
        );
        if (info.get_file_type() !== Gio.FileType.REGULAR ||
            info.get_is_symlink())
            throw new Error('Recording output reservation is not a regular file');
        let stored = readJsonFile(reservationPath);
        if (stored.sessionId !== session.id ||
            stored.token !== reservationToken ||
            stored.finalPath !== session.finalPath)
            throw new Error('Recording output reservation ownership changed');
        return true;
    }

    _releaseRecordingReservation(session) {
        let publication = session && session.publication;
        if (!publication || !publication.reservationPath)
            return;
        try {
            if (this._validateRecordingReservation(session, false))
                deletePathIfExists(publication.reservationPath);
        } catch (e) {
            log('[Big Shot] Recording output reservation kept: ' + e.message);
        }
    }

    async _recoverRecordingSession(item, recordingDir) {
        let manifest;
        try {
            manifest = readJsonFile(item.manifestPath);
        } catch (e) {
            log('[Big Shot] Invalid recording recovery manifest at ' + item.path +
                ': ' + e.message);
            return;
        }

        let claim = this._claimRecordingRecovery(item, manifest);
        if (!claim)
            return;

        let session = null;
        try {
            session = this._buildRecoverySession(
                item,
                manifest,
                recordingDir,
                claim
            );
            this._validateRecordingReservation(
                session,
                Number(manifest.version) >= 3
            );
            log('[Big Shot] Recovering recording session ' + item.id);

            let validation = null;
            if (session.segments.length > 0)
                validation = await this._validateRecordingSegments(session);
            else if (session.publication.expectedSignature &&
                Number(session.publication.expectedDuration) > 0) {
                validation = {
                    referenceSignature: session.publication.expectedSignature,
                    expectedDuration: Number(
                        session.publication.expectedDuration
                    ),
                };
            }

            let finalFile = Gio.File.new_for_path(session.finalPath);
            if (finalFile.query_exists(null)) {
                if (!validation)
                    throw new Error('Published recording cannot be validated');
                let publishedProbe = await this._probeRecordingFile(
                    session.finalPath,
                    session
                );
                if (!this._recordingOutputMatches(
                    publishedProbe,
                    validation,
                    session
                )) {
                    throw new Error('Existing recovery output does not match ' +
                        'the reserved recording');
                }
                session.publication.phase = 'published';
                session.status = 'published';
                this._writeRecordingManifest(session);
                this._releaseRecordingReservation(session);
                session.cleanupPending = !this._cleanupRecordingSession(session);
            } else {
                if (!validation)
                    throw new Error('No recording segments are available for recovery');
                await this._publishRecordingSession(session, validation);
            }

            if (session.cleanupPending) {
                log('[Big Shot] Recording recovered but temporary cleanup is pending: ' +
                    session.sessionDir);
            } else {
                log('[Big Shot] Recording recovery completed: ' + session.finalPath);
            }
            if (!this._disabled) {
                this._showNotification(
                    _('Recording complete'),
                    _('Click to open the BigShot folder'),
                    recordingDir
                );
            }
        } catch (e) {
            if (session) {
                session.status = 'recovery-required';
                session.errorMessage = e.message;
                this._writeRecordingManifest(session);
            }
            log('[Big Shot] Recording recovery failed for ' + item.path + ': ' +
                e.message);
            if (!this._disabled)
                this._showNotification('Big Shot', item.path, item.path);
        } finally {
            this._releaseRecordingRecovery(item.id, claim);
        }
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
        let PartMagnifierMod = imports.parts.partmagnifier;
        let PartVideoAnnotationMod = imports.parts.partvideoannotation;
        let PartCropMod = imports.parts.partcrop;
        let PartGradientMod = imports.parts.partgradient;
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
        if (PartVideoAnnotationMod.PartVideoAnnotation.setGettext)
            PartVideoAnnotationMod.PartVideoAnnotation.setGettext(_);
        if (PartGradientMod.PartGradient.setGettext)
            PartGradientMod.PartGradient.setGettext(_);
        if (PartCropMod.PartCrop.setGettext) PartCropMod.PartCrop.setGettext(_);

        // Toolbar
        this._toolbar = new PartToolbarMod.PartToolbar(ui, ext);
        this._parts.push(this._toolbar);

        // Annotation
        this._annotation = new PartAnnotationMod.PartAnnotation(ui, ext);
        this._parts.push(this._annotation);

        this._videoAnnotation = new
            PartVideoAnnotationMod.PartVideoAnnotation(ui, ext);
        this._parts.push(this._videoAnnotation);

        // Shift-activated precision lens for area selection.
        this._magnifier = new PartMagnifierMod.PartMagnifier(ui, ext);
        this._parts.push(this._magnifier);

        this._crop = new PartCropMod.PartCrop(ui, ext);
        this._parts.push(this._crop);

        this._gradient = new PartGradientMod.PartGradient(ui, ext);
        this._parts.push(this._gradient);
        this._gradientPainter = imports.data.gradients.paintGradient;

        // Wire toolbar tool changes
        this._toolbar.onToolChanged(function(toolId) {
            if (toolId !== null && ext._crop && ext._crop.isActive) {
                ext._crop.deactivate();
                ext._toolbar.setCropActive(false);
            }
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
            if (action === 'crop') {
                let active = this._crop && this._crop.isActive;
                if (active) {
                    this._crop.deactivate();
                } else if (this._crop) {
                    let geom = this._screenshotUI.getSelectedGeometry();
                    this._toolbar.selectTool(null);
                    this._crop.activate(
                        geom[0], geom[1], geom[2], geom[3]
                    );
                }
                this._toolbar.setCropActive(!active);
                return;
            }
            if (action === 'padding') {
                if (this._crop && !this._crop.cropRect) {
                    let geom = this._screenshotUI.getSelectedGeometry();
                    this._crop.activate(
                        geom[0], geom[1], geom[2], geom[3]
                    );
                    this._crop.deactivate();
                }
                if (this._crop)
                    this._crop.cyclePadding();
                return;
            }
            if (action === 'gradient') {
                let visible = this._gradient && this._gradient.visible;
                if (this._gradient)
                    this._gradient.setVisible(!visible);
                this._toolbar.setGradientActive(!visible);
                return;
            }

            let result = this._captureAnnotatedBytes();
            if (!result) {
                log('[Big Shot] Failed to capture screenshot');
                return;
            }

            let bytes = result.bytes;
            let pixbuf = result.pixbuf;

            if (action === 'copy') {
                let tmpPath = GLib.build_filenamev([
                    GLib.get_tmp_dir(), 'bigshot-copy-' + Date.now() + '.png'
                ]);
                let tmpFile = Gio.File.new_for_path(tmpPath);
                let outStream = tmpFile.create(Gio.FileCreateFlags.NONE, null);
                outStream.write_bytes(bytes, null);
                outStream.close(null);
                this._screenshotUI.copyFileToClipboard(tmpPath, true);
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
        let pixelGeom = this._screenshotUI.getSelectedPixelGeometry();
        let bufScale = this._screenshotUI.captureScale;

        let presentationCrop = this._getPresentationCrop(geom);
        if (presentationCrop) {
            geom = presentationCrop;
            pixelGeom = [
                Math.round(geom[0] * bufScale),
                Math.round(geom[1] * bufScale),
                Math.round(geom[2] * bufScale),
                Math.round(geom[3] * bufScale),
            ];
        }

        // Crop to selection if needed
        let x = pixelGeom[0];
        let y = pixelGeom[1];
        let w = pixelGeom[2];
        let h = pixelGeom[3];

        if (w <= 0 || h <= 0) return null;

        let cropPixbuf = pixbuf;
        if (x > 0 || y > 0 || w < pixbuf.get_width() || h < pixbuf.get_height()) {
            cropPixbuf = pixbuf.new_subpixbuf(x, y, w, h);
        }

        if (!actions || actions.length === 0) {
            let outputPixbuf = this._applyPresentation(cropPixbuf);
            let buf = outputPixbuf.save_to_bufferv('png', [], []);
            if (!buf[0]) return null;
            return { bytes: GLib.Bytes.new(buf[1]), pixbuf: outputPixbuf };
        }

        // Composite annotations onto the screenshot via Cairo
        let offsetX = geom[0];
        let offsetY = geom[1];
        let tmpDir = GLib.get_tmp_dir();
        let tmpBase = GLib.build_filenamev([tmpDir, 'bigshot-base-' + Date.now() + '.png']);
        let tmpAnnotated = GLib.build_filenamev([tmpDir, 'bigshot-ann-' + Date.now() + '.png']);

        try {
            let toWidget = function(ax, ay) {
                return [
                    (ax - offsetX) * bufScale,
                    (ay - offsetY) * bufScale,
                ];
            };
            let drawScale = bufScale;

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
            let expansion = computeCanvasExpansion(
                actions,
                workPixbuf.get_width(),
                workPixbuf.get_height(),
                offsetX,
                offsetY,
                bufScale
            );
            let surface;
            let cr;
            let drawToWidget = toWidget;
            if (expansion.expanded) {
                let baseSurface = Cairo.ImageSurface.createFromPNG(tmpBase);
                surface = new Cairo.ImageSurface(
                    Cairo.Format.ARGB32,
                    expansion.newWidth,
                    expansion.newHeight
                );
                cr = new Cairo.Context(surface);
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.paint();
                cr.setSourceSurface(
                    baseSurface,
                    expansion.padLeft,
                    expansion.padTop
                );
                cr.paint();
                baseSurface.finish();
                drawToWidget = function(ax, ay) {
                    let point = toWidget(ax, ay);
                    return [
                        point[0] + expansion.padLeft,
                        point[1] + expansion.padTop,
                    ];
                };
            } else {
                surface = Cairo.ImageSurface.createFromPNG(tmpBase);
                cr = new Cairo.Context(surface);
            }

            for (let i = 0; i < actions.length; i++) {
                let act = actions[i];
                if (typeof act.drawReal !== 'function') {
                    cr.save();
                    act.draw(cr, drawToWidget, drawScale);
                    cr.restore();
                }
            }

            surface.writeToPNG(tmpAnnotated);
            surface.finish();

            let annotPixbuf = this._applyPresentation(
                GdkPixbuf.Pixbuf.new_from_file(tmpAnnotated)
            );
            let buf = annotPixbuf.save_to_bufferv('png', [], []);
            if (!buf[0]) return null;
            return { bytes: GLib.Bytes.new(buf[1]), pixbuf: annotPixbuf };
        } finally {
            try { Gio.File.new_for_path(tmpBase).delete(null); } catch (e) { /* */ }
            try { Gio.File.new_for_path(tmpAnnotated).delete(null); } catch (e) { /* */ }
        }
    }

    _getPresentationCrop(selectionGeometry) {
        let rect = this._crop ? this._crop.cropRect : null;
        if (!rect)
            return null;
        let x1 = Math.max(selectionGeometry[0], rect.x);
        let y1 = Math.max(selectionGeometry[1], rect.y);
        let x2 = Math.min(
            selectionGeometry[0] + selectionGeometry[2],
            rect.x + rect.width
        );
        let y2 = Math.min(
            selectionGeometry[1] + selectionGeometry[3],
            rect.y + rect.height
        );
        if (x2 <= x1 || y2 <= y1)
            return null;
        return [x1, y1, x2 - x1, y2 - y1];
    }

    _hasPresentation() {
        return !!(
            (this._crop && this._crop.cropRect) ||
            (this._crop && this._crop.padding > 0) ||
            (this._gradient && this._gradient.selectedGradient) ||
            (this._gradient && this._gradient.borderRadius > 0)
        );
    }

    _applyPresentation(pixbuf) {
        let scale = this._screenshotUI.captureScale || 1;
        let padding = this._crop
            ? Math.max(0, Math.round(this._crop.padding * scale))
            : 0;
        let gradient = this._gradient
            ? this._gradient.selectedGradient
            : null;
        let radius = this._gradient
            ? Math.max(0, Math.round(this._gradient.borderRadius * scale))
            : 0;
        if (padding === 0 && !gradient && radius === 0)
            return pixbuf;

        let tmpBase = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            'bigshot-presentation-base-' + Date.now() + '.png',
        ]);
        let tmpOut = GLib.build_filenamev([
            GLib.get_tmp_dir(),
            'bigshot-presentation-out-' + Date.now() + '.png',
        ]);
        try {
            pixbuf.savev(tmpBase, 'png', [], []);
            let image = Cairo.ImageSurface.createFromPNG(tmpBase);
            let width = pixbuf.get_width() + padding * 2;
            let height = pixbuf.get_height() + padding * 2;
            let surface = new Cairo.ImageSurface(
                Cairo.Format.ARGB32,
                width,
                height
            );
            let cr = new Cairo.Context(surface);
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            if (gradient && this._gradientPainter)
                this._gradientPainter(cr, gradient, 0, 0, width, height);

            cr.save();
            if (radius > 0) {
                let x = padding;
                let y = padding;
                let w = pixbuf.get_width();
                let h = pixbuf.get_height();
                let r = Math.min(radius, w / 2, h / 2);
                cr.newSubPath();
                cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
                cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
                cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
                cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
                cr.closePath();
                cr.clip();
            }
            cr.setSourceSurface(image, padding, padding);
            cr.paint();
            cr.restore();
            surface.writeToPNG(tmpOut);
            surface.finish();
            image.finish();
            return GdkPixbuf.Pixbuf.new_from_file(tmpOut);
        } finally {
            deletePathIfExists(tmpBase);
            deletePathIfExists(tmpOut);
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
                            [_('PNG Images'), [
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
                                            let destPath = destFile.get_path();
                                            if (destPath)
                                                this._screenshotUI.copyFileToClipboard(destPath, false);
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
        if (this._availableConfigs !== null)
            return Promise.resolve(this._availableConfigs);
        if (this._pipelineDetectionPromise)
            return this._pipelineDetectionPromise;

        let generation = this._pipelineDetectionGeneration;
        this._pipelineDetectionPromise = this._runPipelineDetection(generation).then(
            configs => {
                if (generation === this._pipelineDetectionGeneration)
                    this._pipelineDetectionPromise = null;
                return configs;
            },
            error => {
                if (generation === this._pipelineDetectionGeneration)
                    this._pipelineDetectionPromise = null;
                throw error;
            }
        );
        return this._pipelineDetectionPromise;
    }

    async _runPipelineDetection(generation) {
        let gpuVendors = await detectGpuVendors();
        let vendorSet = new Set(gpuVendors);
        let candidates = [];

        for (let i = 0; i < VIDEO_PIPELINES.length; i++) {
            let config = VIDEO_PIPELINES[i];
            let matches = config.vendors.length === 0;
            for (let v = 0; !matches && v < config.vendors.length; v++)
                matches = vendorSet.has(config.vendors[v]);
            if (matches)
                candidates.push(config);
        }

        let elementNames = new Set(['mp4mux', 'webmmux']);
        for (let i = 0; i < candidates.length; i++) {
            let elements = candidates[i].elements;
            for (let e = 0; e < elements.length; e++)
                elementNames.add(elements[e]);
        }
        let audioTypes = Object.keys(AUDIO_PIPELINES);
        for (let t = 0; t < audioTypes.length; t++) {
            let choices = AUDIO_PIPELINES[audioTypes[t]];
            for (let c = 0; c < choices.length; c++)
                elementNames.add(choices[c].element);
        }

        let names = Array.from(elementNames);
        let checks = await Promise.all(names.map(async name => {
            return [name, await checkElement(name)];
        }));
        let availableElements = new Set();
        for (let i = 0; i < checks.length; i++) {
            if (checks[i][1])
                availableElements.add(checks[i][0]);
        }

        if (generation !== this._pipelineDetectionGeneration || !this._screenshotUI)
            return [];

        let gpuConfigs = [];
        let swConfigs = [];
        for (let i = 0; i < candidates.length; i++) {
            let config = candidates[i];
            let available = availableElements.has(config.ext === 'mp4' ? 'mp4mux' : 'webmmux');
            for (let e = 0; available && e < config.elements.length; e++)
                available = availableElements.has(config.elements[e]);
            if (!available)
                continue;
            if (config.vendors.length === 0)
                swConfigs.push(config);
            else
                gpuConfigs.push(config);
        }

        this._gpuVendors = gpuVendors;
        this._availableElements = availableElements;
        this._availableConfigs = gpuConfigs.concat(swConfigs);

        if (this._availableConfigs.length === 0)
            log('[Big Shot] No compatible GStreamer pipeline found!');

        return this._availableConfigs;
    }

    /**
     * Called when the screenshot UI closes (ESC, capture done, etc.).
     * Resets transient part state so the next open starts fresh.
     */
    _onUIClosed() {
        log('[Big Shot] _onUIClosed called, recordingState=' + this._recordingState);
        if (this._screencastStarting) {
            this._screencastStartGeneration++;
            this._screencastStarting = false;
        }

        // Don't reset if a recording is in progress
        if (this._recordingState !== 'idle')
            return;

        if (this._crop)
            this._crop.reset();
        if (this._gradient)
            this._gradient.reset();
        if (this._toolbar) {
            this._toolbar.setCropActive(false);
            this._toolbar.setGradientActive(false);
        }

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

    async _startScreencast() {
        if (this._recordingState !== 'idle' || this._screencastStarting)
            return;

        let startGeneration = ++this._screencastStartGeneration;
        this._screencastStarting = true;
        try {
            await this._runScreencastStart(startGeneration);
        } finally {
            if (startGeneration === this._screencastStartGeneration)
                this._screencastStarting = false;
        }
    }

    async _runScreencastStart(startGeneration) {
        await this._detectPipelines();

        if (startGeneration !== this._screencastStartGeneration ||
            !this._screenshotUI || !this._screenshotUI.visible ||
            this._recordingState !== 'idle')
            return;

        if (this._availableConfigs.length === 0) {
            log('[Big Shot] No GStreamer pipeline available for screencast');
            return;
        }
        if (!GLib.find_program_in_path('ffprobe') ||
            !GLib.find_program_in_path('ffmpeg')) {
            log('[Big Shot] ffmpeg and ffprobe are required for safe recording finalization');
            return;
        }

        let framerate = (this._framerate && this._framerate.value) ? this._framerate.value : 30;
        let downsize = (this._downsize && this._downsize.value) ? this._downsize.value : 1.0;
        let quality = (this._toolbar && this._toolbar.videoQuality) ? this._toolbar.videoQuality : 'high';
        let isWayland = GLib.getenv('WAYLAND_DISPLAY') !== null;
        let requestedGeometry =
            this._screenshotUI.getSelectedScreenGeometry();
        let includeCursor = this._screenshotUI.includeCursor;
        let captureGeometry = null;
        let displayGeometry = null;
        let portal = null;
        let portalCrop = null;
        let screenGeometry = getVirtualScreenGeometry();
        displayGeometry = normalizeCaptureGeometry(
            [
                requestedGeometry[0] - screenGeometry.x,
                requestedGeometry[1] - screenGeometry.y,
                requestedGeometry[2],
                requestedGeometry[3],
            ],
            screenGeometry.width,
            screenGeometry.height
        );
        if (!displayGeometry) {
            log('[Big Shot] Invalid screencast display geometry');
            return;
        }
        if (!isWayland) {
            let captureScale = global.ui_scale || 1;
            captureGeometry = normalizeCaptureGeometry(
                [
                    displayGeometry.x * captureScale,
                    displayGeometry.y * captureScale,
                    displayGeometry.width * captureScale,
                    displayGeometry.height * captureScale,
                ],
                screenGeometry.width * captureScale,
                screenGeometry.height * captureScale
            );
            if (!captureGeometry) {
                log('[Big Shot] Invalid screencast capture geometry');
                return;
            }
        } else {
            try {
                let Portal = imports.portal;
                portal = new Portal.ScreenCastPortal();
                let selectionMode = this._screenshotUI._selectionMode;
                let sourceTypes = selectionMode === 1 ? 2 : 1;
                let stream = await portal.start(sourceTypes, includeCursor);
                if (startGeneration !== this._screencastStartGeneration ||
                    this._recordingState !== 'idle') {
                    portal.close();
                    return;
                }
                let streamSize = stream.size;
                let streamPosition = stream.position;
                if (streamSize && streamSize.length === 2) {
                    captureGeometry = {
                        x: 0,
                        y: 0,
                        width: Number(streamSize[0]),
                        height: Number(streamSize[1]),
                    };
                } else {
                    captureGeometry = {
                        x: 0,
                        y: 0,
                        width: requestedGeometry[2],
                        height: requestedGeometry[3],
                    };
                }
                if (selectionMode === 2 && streamPosition && streamSize) {
                    let left = Math.max(0, Math.round(
                        requestedGeometry[0] - Number(streamPosition[0])
                    ));
                    let top = Math.max(0, Math.round(
                        requestedGeometry[1] - Number(streamPosition[1])
                    ));
                    let width = Math.min(
                        Math.round(requestedGeometry[2]),
                        captureGeometry.width - left
                    );
                    let height = Math.min(
                        Math.round(requestedGeometry[3]),
                        captureGeometry.height - top
                    );
                    if (width <= 0 || height <= 0)
                        throw new Error('Selected area is outside the portal stream');
                    portalCrop = {
                        left: left,
                        top: top,
                        right: captureGeometry.width - left - width,
                        bottom: captureGeometry.height - top - height,
                    };
                    captureGeometry = { x: 0, y: 0, width: width, height: height };
                }
            } catch (e) {
                if (portal)
                    portal.close();
                log('[Big Shot] ScreenCast portal failed: ' + e.message);
                return;
            }
        }
        // Get output file path
        let time = GLib.DateTime.new_now_local();
        let dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        if (!dir) dir = GLib.get_home_dir();
        let recordingDir = GLib.build_filenamev([dir, 'BigShot']);
        try {
            Gio.File.new_for_path(recordingDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                log('[Big Shot] Failed to create recording dir: ' + e.message);
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
        let ext = config.ext;
        let baseName = _('Screencast from %s').format(
            time.format('%Y-%m-%d %H-%M-%S'));
        let filePath = GLib.build_filenamev([recordingDir, baseName + '.' + ext]);

        // Use GStreamer to record the screen directly
        // On X11: ximagesrc, on Wayland: pipewiresrc
        let srcElement;
        if (isWayland) {
            let target = portal.stream.serial
                ? ' target-object=' + GLib.shell_quote(portal.stream.serial)
                : ' path=' + portal.stream.nodeId;
            srcElement = 'pipewiresrc fd=3 do-timestamp=true ' +
                'provide-clock=false on-disconnect=error' + target;
            if (portalCrop) {
                srcElement += ' ! videocrop left=' + portalCrop.left +
                    ' top=' + portalCrop.top +
                    ' right=' + portalCrop.right +
                    ' bottom=' + portalCrop.bottom;
            }
            srcElement += ' ! videoconvert';
        } else {
            let endX = captureGeometry.x + captureGeometry.width - 1;
            let endY = captureGeometry.y + captureGeometry.height - 1;
            srcElement = 'ximagesrc use-damage=0 do-timestamp=true show-pointer=' +
                (includeCursor ? 'true' : 'false') +
                ' startx=' + captureGeometry.x +
                ' starty=' + captureGeometry.y +
                ' endx=' + endX +
                ' endy=' + endY +
                ' ! videoconvert';
        }

        let pipeline;
        try {
            pipeline = this._makePipelineString(
                config,
                framerate + '/1',
                downsize,
                quality,
                captureGeometry
            );
        } catch (e) {
            if (portal)
                portal.close();
            log('[Big Shot] Failed to build recording pipeline: ' + e.message);
            return;
        }
        if (captureGeometry) {
            let outputWidth = downsize < 1.0
                ? toEvenDimension(captureGeometry.width * downsize)
                : captureGeometry.width;
            let outputHeight = downsize < 1.0
                ? toEvenDimension(captureGeometry.height * downsize)
                : captureGeometry.height;
            log('[Big Shot] Capture geometry: x=' + captureGeometry.x +
                ', y=' + captureGeometry.y +
                ', source=' + captureGeometry.width + 'x' + captureGeometry.height +
                ', output=' + outputWidth + 'x' + outputHeight);
        }

        let pipelineBase = srcElement + ' ! video/x-raw,framerate=' +
            framerate + '/1 ! ' + pipeline;
        let sessionLocation;
        try {
            sessionLocation = createRecordingSessionDirectory(recordingDir);
        } catch (e) {
            log('[Big Shot] Failed to create recording session: ' + e.message);
            if (portal)
                portal.close();
            return;
        }
        let sessionId = sessionLocation.id;
        let sessionDir = sessionLocation.path;
        let outputReservation;
        try {
            outputReservation = reserveRecordingOutput(filePath, sessionId);
        } catch (e) {
            log('[Big Shot] Failed to reserve recording output: ' + e.message);
            if (portal)
                portal.close();
            deletePathIfExists(sessionDir);
            return;
        }
        let reservedFinalPath = outputReservation.finalPath;

        let session = {
            id: sessionId,
            config: config,
            ext: ext,
            recordingDir: recordingDir,
            sessionDir: sessionDir,
            manifestPath: GLib.build_filenamev([sessionDir, RECORDING_MANIFEST_NAME]),
            finalPath: reservedFinalPath,
            pipelineBase: pipelineBase,
            captureGeometry: captureGeometry,
            displayGeometry: displayGeometry,
            screenGeometry: screenGeometry,
            requestedGeometry: requestedGeometry,
            includeCursor: includeCursor,
            framerate: framerate,
            downsize: downsize,
            quality: quality,
            portal: portal,
            segments: [],
            currentSegment: null,
            nextIndex: 1,
            stopRequested: false,
            finalizing: false,
            finalizePromise: null,
            notifyOnComplete: true,
            disabling: false,
            errorMessage: null,
            startedAt: GLib.DateTime.new_now_utc().format('%FT%TZ'),
            publication: {
                phase: 'pending',
                finalPath: reservedFinalPath,
                reservationPath: outputReservation.path,
                reservationToken: outputReservation.token,
            },
        };
        session.finalPath = session.publication.finalPath;
        getRecordingOwnerRegistry().add(session.id);

        this._recordingSession = session;
        this._recordingContext = {
            config: config,
            captureGeometry: captureGeometry,
            requestedGeometry: requestedGeometry,
        };

        // Remove the capture UI before the first video frame is produced.
        this._recordingState = 'starting';
        this._screencastStarting = false;
        if (this._screenshotUI && this._screenshotUI.visible)
            this._screenshotUI.close();
        await waitForStageRedraw(32);
        if (this._disabled || this._recordingSession !== session) {
            this._recordingSession = null;
            this._recordingContext = null;
            this._recordingState = 'idle';
            getRecordingOwnerRegistry().delete(session.id);
            if (session.portal)
                session.portal.close();
            this._releaseRecordingReservation(session);
            deletePathIfExists(session.manifestPath);
            deletePathIfExists(session.sessionDir);
            return;
        }

        try {
            this._spawnRecordingSegment(session);
        } catch (e) {
            log('[Big Shot] Failed to start screencast: ' + e.message);
            if (session.currentSegment) {
                session.errorMessage = 'Recording startup failed after process creation: ' +
                    e.message;
                session.stopRequested = true;
                this._recordingState = 'stopping';
                this._requestSegmentStop(session, session.currentSegment, 'stop');
                this._writeRecordingManifest(session);
                return;
            }
            this._recordingSession = null;
            this._recordingContext = null;
            this._recordingState = 'idle';
            getRecordingOwnerRegistry().delete(session.id);
            if (session.portal)
                session.portal.close();
            this._releaseRecordingReservation(session);
            deletePathIfExists(session.manifestPath);
            deletePathIfExists(session.sessionDir);
            return;
        }

        this._recordingState = 'recording';
        this._writeRecordingManifest(session);
        if (this._indicator)
            this._indicator.onRecordingStarted();
        if (this._videoAnnotation)
            this._videoAnnotation.onRecordingStarted();

        // Keep the webcam actor alive while the capture UI closes. The same
        // actor and frozen pipeline settings are retained across all segments.
        try {
            if (this._webcam && this._webcam.enabled)
                this._webcam.reparentForRecording();

            this._screencastStarting = false;
            if (this._screenshotUI && this._screenshotUI.visible) {
                this._screenshotUI.close();
                this._screenshotUI.screencastInProgress = true;
            } else if (this._screenshotUI) {
                this._screenshotUI.screencastInProgress = true;
            }
        } catch (e) {
            log('[Big Shot] Recording UI transition failed: ' + e.message);
        }
        this._showRecordingRegionMask(displayGeometry, screenGeometry);
    }

    _quickStop() {
        if (this._videoAnnotation)
            this._videoAnnotation.finishEditForStop();
        let session = this._recordingSession;
        if (!session || this._recordingState === 'idle' ||
            this._recordingState === 'finalizing')
            return false;

        session.stopRequested = true;
        if (this._recordingState === 'paused' || !session.currentSegment) {
            this._beginRecordingFinalization(session);
            return true;
        }

        this._recordingState = 'stopping';
        if (this._indicator &&
            typeof this._indicator.onFinalizing === 'function')
            this._indicator.onFinalizing();
        this._writeRecordingManifest(session);
        if (session.currentSegment.exitHandled)
            return true;
        if (!this._requestSegmentStop(session, session.currentSegment, 'stop')) {
            session.errorMessage = 'Failed to stop the active recording segment';
            this._beginRecordingFinalization(session);
            return false;
        }
        return true;
    }

    captureScreenshotDuringRecording() {
        if (this._recordingScreenshotPending ||
            !this._recordingSession ||
            (this._recordingState !== 'recording' &&
             this._recordingState !== 'paused'))
            return false;

        let session = this._recordingSession;
        let geometry = session.requestedGeometry;
        if (!geometry || geometry.length !== 4)
            return false;

        let restoreControls = this._videoAnnotation
            ? this._videoAnnotation.suspendControlsForCapture()
            : () => {};
        let captureFinished = false;
        let finishCapture = () => {
            if (captureFinished)
                return;
            captureFinished = true;
            try {
                restoreControls();
            } catch (e) {
                log('[Big Shot] Failed to restore recording controls: ' +
                    e.message);
            }
            this._recordingScreenshotPending = false;
        };
        this._recordingScreenshotPending = true;
        global.stage.queue_redraw();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            if (!captureFinished) {
                log('[Big Shot] Recording screenshot timed out');
                finishCapture();
            }
            return GLib.SOURCE_REMOVE;
        });

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 32, () => {
            let filePath = null;
            let dir = GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_PICTURES
            ) || GLib.get_home_dir();
            let screenshotsDir = GLib.build_filenamev([
                dir,
                _('Screenshots'),
            ]);
            try {
                Gio.File.new_for_path(screenshotsDir)
                    .make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    log('[Big Shot] Failed to create screenshots dir: ' +
                        e.message);
                }
            }

            let time = GLib.DateTime.new_now_local();
            try {
                filePath = makeUniqueFilePath(GLib.build_filenamev([
                    screenshotsDir,
                    _('Screenshot from %s').format(
                        time.format('%Y-%m-%d %H-%M-%S')
                    ) + '.png',
                ]));
                let scale = global.ui_scale || 1;
                let screenshot = new Cinnamon.Screenshot();
                screenshot.screenshot_area(
                    session.includeCursor,
                    Math.round(geometry[0] * scale),
                    Math.round(geometry[1] * scale),
                    Math.round(geometry[2] * scale),
                    Math.round(geometry[3] * scale),
                    filePath,
                    () => {
                        finishCapture();
                        let file = Gio.File.new_for_path(filePath);
                        if (!file.query_exists(null)) {
                            log('[Big Shot] Recording screenshot failed');
                            return;
                        }
                        try {
                            this._screenshotUI.copyFileToClipboard(filePath, false);
                        } catch (e) {
                            log('[Big Shot] Recording screenshot clipboard failed: ' +
                                e.message);
                        }
                        this._showNotification(
                            _('Screenshot taken'),
                            _('Click to open the Screenshots folder'),
                            screenshotsDir
                        );
                    }
                );
            } catch (e) {
                finishCapture();
                log('[Big Shot] Recording screenshot failed: ' + e.message);
            }
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _writeRecordingManifest(session) {
        if (!session || !session.manifestPath)
            return;

        let serializeSegment = function(segment) {
            if (!segment) return null;
            return {
                index: segment.index,
                fileName: segment.fileName || null,
                path: segment.path,
                stopIntent: segment.stopIntent || null,
                forced: !!segment.forced,
                valid: segment.probe ? !!segment.probe.valid : null,
                duration: segment.probe ? segment.probe.duration : null,
                writer: segment.writer || null,
            };
        };
        let data = {
            version: 3,
            id: session.id,
            state: session.status || this._recordingState,
            extension: session.ext,
            finalPath: session.finalPath,
            pipeline: session.pipelineBase,
            captureGeometry: session.captureGeometry,
            displayGeometry: session.displayGeometry,
            screenGeometry: session.screenGeometry,
            requestedGeometry: session.requestedGeometry,
            includeCursor: session.includeCursor,
            framerate: session.framerate,
            downsize: session.downsize,
            quality: session.quality,
            startedAt: session.startedAt,
            processId: session.currentSegment && session.currentSegment.process
                ? session.currentSegment.process.get_identifier()
                : null,
            publication: session.publication || null,
            segments: session.segments.map(serializeSegment),
            currentSegment: serializeSegment(session.currentSegment),
            error: session.errorMessage || null,
        };

        try {
            Gio.File.new_for_path(session.manifestPath).replace_contents(
                ByteArray.fromString(JSON.stringify(data, null, 2) + '\n'),
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
        } catch (e) {
            log('[Big Shot] Failed to write recording manifest: ' + e.message);
        }
    }

    _spawnRecordingSegment(session) {
        if (!session || session !== this._recordingSession)
            throw new Error('Recording session is no longer active');
        if (session.currentSegment)
            throw new Error('A recording segment is already active');

        let index = session.nextIndex++;
        let fileName = 'segment-' + String(index).padStart(3, '0') + '.' + session.ext;
        let path = GLib.build_filenamev([session.sessionDir, fileName]);
        let fullPipeline = session.pipelineBase +
            ' ! filesink location=' + GLib.shell_quote(path);
        let [parseOk, argv] = GLib.shell_parse_argv(
            'gst-launch-1.0 -e ' + fullPipeline
        );
        if (!parseOk)
            throw new Error('Could not parse the GStreamer pipeline');

        log('[Big Shot] Starting recording segment ' + index + ': ' + fullPipeline);
        let process;
        if (session.portal) {
            let descriptor = session.portal.takeDuplicateFd(3);
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.NONE,
            });
            launcher.take_fd(descriptor.fd, descriptor.targetFd);
            process = launcher.spawnv(argv);
        } else {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        }
        let segment = {
            index: index,
            fileName: fileName,
            path: path,
            process: process,
            stopIntent: null,
            signalSent: false,
            exitHandled: false,
            stopTimeoutId: 0,
            forced: false,
            probe: null,
            writer: readProcessIdentity(process.get_identifier(), path),
        };

        session.currentSegment = segment;
        this._screencastProcess = process;
        this._currentSegmentPath = path;
        this._writeRecordingManifest(session);

        process.wait_async(null, (source, result) => {
            this._handleRecordingSegmentExit(session, segment, source, result)
                .catch(e => {
                    session.errorMessage = 'Segment finalization failed: ' + e.message;
                    log('[Big Shot] ' + session.errorMessage);
                    if (session.currentSegment === segment)
                        session.currentSegment = null;
                    this._writeRecordingManifest(session);
                    if (session === this._recordingSession)
                        this._beginRecordingFinalization(session);
                });
        });
        return segment;
    }

    _requestSegmentStop(session, segment, intent) {
        if (!session || !segment || segment.exitHandled)
            return false;

        if (!segment.stopIntent || intent !== 'pause')
            segment.stopIntent = intent;
        if (segment.signalSent) {
            this._writeRecordingManifest(session);
            return true;
        }

        segment.signalSent = true;
        try {
            segment.process.send_signal(2);
        } catch (e) {
            segment.forced = true;
            session.errorMessage = 'Could not send SIGINT to GStreamer: ' + e.message;
            log('[Big Shot] ' + session.errorMessage);
            try { segment.process.force_exit(); } catch (_e) { /* */ }
        }

        segment.stopTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SEGMENT_STOP_TIMEOUT_MS,
            () => {
                segment.stopTimeoutId = 0;
                if (segment.exitHandled)
                    return GLib.SOURCE_REMOVE;

                segment.forced = true;
                session.errorMessage = 'GStreamer did not stop within ' +
                    SEGMENT_STOP_TIMEOUT_MS + ' ms';
                log('[Big Shot] ' + session.errorMessage + '; forcing exit');
                try { segment.process.force_exit(); } catch (e) {
                    log('[Big Shot] Failed to force GStreamer exit: ' + e.message);
                }
                this._writeRecordingManifest(session);
                return GLib.SOURCE_REMOVE;
            }
        );
        this._writeRecordingManifest(session);
        return true;
    }

    async _handleRecordingSegmentExit(session, segment, process, result) {
        if (segment.exitHandled)
            return;

        let successful = false;
        let waitError = null;
        try {
            process.wait_finish(result);
            successful = process.get_successful();
        } catch (e) {
            waitError = e;
        }

        segment.exitHandled = true;
        if (segment.stopTimeoutId) {
            GLib.source_remove(segment.stopTimeoutId);
            segment.stopTimeoutId = 0;
        }
        if (this._screencastProcess === process)
            this._screencastProcess = null;
        if (this._currentSegmentPath === segment.path)
            this._currentSegmentPath = null;

        segment.probe = await this._probeRecordingFile(segment.path, session);
        if (segment.probe.valid &&
            !session.segments.some(item => item.path === segment.path)) {
            session.segments.push({
                index: segment.index,
                fileName: segment.fileName,
                path: segment.path,
                stopIntent: segment.stopIntent,
                forced: segment.forced,
                probe: segment.probe,
            });
        }

        if (waitError) {
            log('[Big Shot] Recording segment wait failed: ' + waitError.message);
            session.errorMessage = 'Recording segment wait failed: ' +
                waitError.message;
        } else if (!successful) {
            log('[Big Shot] Recording segment exited with a non-zero status');
            session.errorMessage = 'GStreamer exited with a non-zero status for segment ' +
                segment.index;
        }

        if (!segment.probe.valid) {
            session.errorMessage = 'Invalid recording segment ' + segment.index + ': ' +
                segment.probe.error;
        } else if (segment.forced) {
            session.errorMessage = session.errorMessage ||
                'Recording segment ' + segment.index + ' required a forced stop';
        } else if (!segment.stopIntent) {
            session.errorMessage = 'Recording segment ' + segment.index +
                ' exited unexpectedly';
        }

        if (session.currentSegment === segment)
            session.currentSegment = null;
        this._writeRecordingManifest(session);
        if (session !== this._recordingSession)
            return;
        if (segment.stopIntent === 'pause' && !session.stopRequested &&
            !session.errorMessage && !session.disabling) {
            this._recordingState = 'paused';
            if (this._indicator)
                this._indicator.onPaused();
            this._writeRecordingManifest(session);
            return;
        }

        this._beginRecordingFinalization(session);
    }

    async _probeRecordingFile(path, session) {
        let result = {
            valid: false,
            path: path,
            size: 0,
            duration: 0,
            frameRate: 0,
            signature: null,
            error: null,
        };

        try {
            this._refreshRecordingRecoveryClaim(session);
            let file = Gio.File.new_for_path(path);
            let info = file.query_info(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                throw new Error('output is not a regular file');
            result.size = info.get_size();
            if (result.size <= 0)
                throw new Error('output is empty');

            let process = Gio.Subprocess.new([
                'ffprobe',
                '-v', 'error',
                '-show_data_hash', 'sha256',
                '-show_entries',
                'format=duration:stream=index,codec_type,codec_name,codec_tag_string,profile,level,pix_fmt,width,height,r_frame_rate,avg_frame_rate,color_range,color_space,color_transfer,color_primaries,field_order,sample_fmt,sample_rate,channels,channel_layout,extradata_hash,start_time,duration',
                '-of', 'json',
                path,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            if (session)
                session.auxProcess = process;
            let completed;
            try {
                completed = await communicateUtf8WithTimeout(
                    process,
                    MEDIA_PROBE_TIMEOUT_MS,
                    'ffprobe'
                );
            } finally {
                if (session && session.auxProcess === process)
                    session.auxProcess = null;
            }
            if (!completed[0] || !process.get_successful())
                throw new Error((completed[2] || 'ffprobe failed').trim());
            this._refreshRecordingRecoveryClaim(session);

            let metadata = JSON.parse(completed[1] || '{}');
            let streams = Array.isArray(metadata.streams) ? metadata.streams : [];
            let video = streams.find(stream => stream.codec_type === 'video');
            result.duration = Number(metadata.format && metadata.format.duration);
            if (!video)
                throw new Error('video stream is missing');
            if (!Number.isFinite(result.duration) || result.duration <= 0)
                throw new Error('duration is invalid');

            let text = function(value) {
                return value === undefined || value === null ? '' : String(value);
            };
            result.frameRate = parseMediaRate(
                video.avg_frame_rate || video.r_frame_rate
            );
            result.signature = {
                video: {
                    codec: text(video.codec_name),
                    codecTag: text(video.codec_tag_string),
                    profile: text(video.profile),
                    level: Number(video.level) || 0,
                    pixelFormat: text(video.pix_fmt),
                    width: Number(video.width) || 0,
                    height: Number(video.height) || 0,
                    colorRange: text(video.color_range),
                    colorSpace: text(video.color_space),
                    colorTransfer: text(video.color_transfer),
                    colorPrimaries: text(video.color_primaries),
                    fieldOrder: text(video.field_order),
                    extraDataHash: text(video.extradata_hash),
                },
                audio: streams
                    .filter(stream => stream.codec_type === 'audio')
                    .map(stream => ({
                        codec: text(stream.codec_name),
                        codecTag: text(stream.codec_tag_string),
                        profile: text(stream.profile),
                        sampleFormat: text(stream.sample_fmt),
                        sampleRate: text(stream.sample_rate),
                        channels: Number(stream.channels) || 0,
                        channelLayout: text(stream.channel_layout),
                        extraDataHash: text(stream.extradata_hash),
                    })),
            };
            result.streamTimings = streams.map(stream => ({
                type: text(stream.codec_type),
                start: Number(stream.start_time) || 0,
                duration: Number(stream.duration) || 0,
            }));
            result.valid = true;
        } catch (e) {
            result.error = e.message;
        }
        return result;
    }

    _beginRecordingFinalization(session) {
        if (!session || session !== this._recordingSession)
            return null;
        if (session.finalizing)
            return session.finalizePromise;
        if (session.currentSegment) {
            session.stopRequested = true;
            this._recordingState = 'stopping';
            if (!session.currentSegment.exitHandled)
                this._requestSegmentStop(session, session.currentSegment, 'stop');
            this._writeRecordingManifest(session);
            return null;
        }

        session.finalizing = true;
        session.status = 'finalizing';
        this._recordingState = 'finalizing';
        this._destroyRecordingRegionMask();
        if (this._screenshotUI)
            this._screenshotUI.screencastInProgress = false;
        if (this._webcam)
            this._webcam.stopPreview();
        if (!this._disabled && this._indicator &&
            typeof this._indicator.onFinalizing === 'function')
            this._indicator.onFinalizing();
        this._writeRecordingManifest(session);

        session.finalizePromise = this._publishRecordingSession(session)
            .then(path => {
                this._completeRecordingSession(session, path, null);
                return path;
            })
            .catch(e => {
                this._completeRecordingSession(session, null, e);
                return null;
            });
        return session.finalizePromise;
    }

    async _validateRecordingSegments(session) {
        if (session.segments.length === 0)
            throw new Error('No valid recording segments were finalized');

        session.segments.sort((left, right) => left.index - right.index);
        let referenceSignature = null;
        let expectedDuration = 0;
        for (let i = 0; i < session.segments.length; i++) {
            let probe = await this._probeRecordingFile(
                session.segments[i].path,
                session
            );
            session.segments[i].probe = probe;
            if (!probe.valid)
                throw new Error('Segment ' + session.segments[i].index +
                    ' failed validation: ' + probe.error);
            let frameRateTolerance = Math.max(0.5, session.framerate * 0.05);
            if (probe.frameRate <= 0 ||
                Math.abs(probe.frameRate - session.framerate) > frameRateTolerance) {
                throw new Error('Segment ' + session.segments[i].index +
                    ' has an unexpected frame rate');
            }

            expectedDuration += probe.duration;
            let signature = JSON.stringify(probe.signature);
            if (referenceSignature === null)
                referenceSignature = probe.signature;
            else if (signature !== JSON.stringify(referenceSignature))
                throw new Error('Recording segments have incompatible stream formats');
        }

        return {
            referenceSignature: referenceSignature,
            expectedDuration: expectedDuration,
        };
    }

    _recordingOutputMatches(probe, validation, session) {
        if (!probe || !probe.valid || !validation)
            return false;
        if (JSON.stringify(probe.signature) !==
            JSON.stringify(validation.referenceSignature))
            return false;
        let frameRateTolerance = Math.max(0.5, session.framerate * 0.05);
        if (probe.frameRate <= 0 ||
            Math.abs(probe.frameRate - session.framerate) > frameRateTolerance)
            return false;
        let durationTolerance = Math.max(
            1.5,
            validation.expectedDuration * 0.03
        );
        return Math.abs(probe.duration - validation.expectedDuration) <=
            durationTolerance;
    }

    async _publishRecordingSession(session, validation) {
        if (session.errorMessage && !session.recovering)
            throw new Error(session.errorMessage);
        if (!validation)
            validation = await this._validateRecordingSegments(session);

        session.publication = session.publication || {};
        session.publication.phase = 'publishing';
        session.publication.finalPath = session.finalPath;
        session.publication.expectedDuration = validation.expectedDuration;
        session.publication.expectedSignature = validation.referenceSignature;
        session.status = 'publishing';
        this._validateRecordingReservation(
            session,
            !session.recovering || session.manifestVersion >= 3
        );
        this._writeRecordingManifest(session);

        if (session.segments.length === 1) {
            this._refreshRecordingRecoveryClaim(session);
            Gio.File.new_for_path(session.segments[0].path).move(
                Gio.File.new_for_path(session.finalPath),
                Gio.FileCopyFlags.NONE,
                null,
                null
            );
        } else {
            await this._mergeRecordingSegments(
                session,
                validation.referenceSignature,
                validation.expectedDuration
            );
        }

        session.publication.phase = 'published';
        session.status = 'published';
        this._writeRecordingManifest(session);
        this._releaseRecordingReservation(session);
        session.cleanupPending = !this._cleanupRecordingSession(session);
        if (session.cleanupPending) {
            session.status = 'published-cleanup-pending';
            this._writeRecordingManifest(session);
        }
        return session.finalPath;
    }

    async _mergeRecordingSegments(session, referenceSignature, expectedDuration) {
        this._refreshRecordingRecoveryClaim(session);
        let listPath = GLib.build_filenamev([session.sessionDir, 'segments.ffconcat']);
        let partialPath = GLib.build_filenamev([
            session.sessionDir,
            'merged.partial.' + session.ext,
        ]);
        deletePathIfExists(listPath);
        deletePathIfExists(partialPath);

        let lines = ['ffconcat version 1.0'];
        for (let i = 0; i < session.segments.length; i++)
            lines.push('file ' + session.segments[i].fileName);
        Gio.File.new_for_path(listPath).replace_contents(
            ByteArray.fromString(lines.join('\n') + '\n'),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        );

        let argv = [
            'ffmpeg',
            '-nostdin',
            '-hide_banner',
            '-loglevel', 'error',
            '-xerror',
            '-n',
            '-f', 'concat',
            '-safe', '1',
            '-i', listPath,
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c', 'copy',
        ];
        if (session.ext === 'mp4')
            argv.push('-movflags', '+faststart');
        argv.push(partialPath);

        log('[Big Shot] Merging ' + session.segments.length + ' recording segments');
        let process = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        session.auxProcess = process;
        let completed;
        try {
            completed = await communicateUtf8WithTimeout(
                process,
                SEGMENT_MERGE_TIMEOUT_MS,
                'FFmpeg concat'
            );
        } finally {
            if (session.auxProcess === process)
                session.auxProcess = null;
        }
        if (!completed[0] || !process.get_successful())
            throw new Error((completed[2] || 'FFmpeg concat failed').trim());
        this._refreshRecordingRecoveryClaim(session);

        let probe = await this._probeRecordingFile(partialPath, session);
        if (!probe.valid)
            throw new Error('Merged recording failed validation: ' + probe.error);
        if (JSON.stringify(probe.signature) !== JSON.stringify(referenceSignature))
            throw new Error('Merged recording stream format changed');
        let frameRateTolerance = Math.max(0.5, session.framerate * 0.05);
        if (probe.frameRate <= 0 ||
            Math.abs(probe.frameRate - session.framerate) > frameRateTolerance)
            throw new Error('Merged recording has an unexpected frame rate');
        let durationTolerance = Math.max(1.5, expectedDuration * 0.03);
        if (Math.abs(probe.duration - expectedDuration) > durationTolerance) {
            throw new Error('Merged recording duration differs from finalized segments');
        }

        Gio.File.new_for_path(partialPath).move(
            Gio.File.new_for_path(session.finalPath),
            Gio.FileCopyFlags.NONE,
            null,
            null
        );
    }

    _cleanupRecordingSession(session) {
        for (let i = 0; i < session.segments.length; i++)
            deletePathIfExists(session.segments[i].path);
        deletePathIfExists(GLib.build_filenamev([session.sessionDir, 'segments.ffconcat']));
        deletePathIfExists(GLib.build_filenamev([
            session.sessionDir,
            'merged.partial.' + session.ext,
        ]));
        deletePathIfExists(session.recoveryClaimPath || GLib.build_filenamev([
            session.sessionDir,
            RECORDING_RECOVERY_CLAIM_NAME,
        ]));

        let directory = Gio.File.new_for_path(session.sessionDir);
        let enumerator = null;
        let unexpected = [];
        try {
            enumerator = directory.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_name() !== RECORDING_MANIFEST_NAME)
                    unexpected.push(info.get_name());
            }
        } catch (e) {
            log('[Big Shot] Could not verify recording session cleanup: ' +
                e.message);
            return false;
        } finally {
            if (enumerator) {
                try { enumerator.close(null); } catch (_e) { /* */ }
            }
        }

        if (unexpected.length > 0) {
            log('[Big Shot] Recovery metadata kept because session files remain: ' +
                unexpected.join(', '));
            return false;
        }

        deletePathIfExists(session.manifestPath);
        try {
            if (directory.query_exists(null))
                directory.delete(null);
            return true;
        } catch (e) {
            log('[Big Shot] Failed to remove recording session directory: ' +
                e.message);
            return false;
        }
    }

    _completeRecordingSession(session, completedPath, error) {
        if (session.portal) {
            session.portal.close();
            session.portal = null;
        }
        if (error) {
            session.status = 'recovery-required';
            session.errorMessage = error.message;
            this._writeRecordingManifest(session);
            log('[Big Shot] Recording finalization failed: ' + error.message +
                '. Recovery files kept at ' + session.sessionDir);
        } else {
            log('[Big Shot] Recording finalized: ' + completedPath);
        }

        if (this._recordingSession === session) {
            this._recordingSession = null;
            this._recordingContext = null;
            this._screencastProcess = null;
            this._currentSegmentPath = null;
            this._recordingState = 'idle';
            if (this._screenshotUI)
                this._screenshotUI.screencastInProgress = false;
        }
        getRecordingOwnerRegistry().delete(session.id);

        if (this._videoAnnotation)
            this._videoAnnotation.onRecordingStopped();
        if (!this._disabled && this._indicator)
            this._indicator.onRecordingStopped();
        if (this._disabled || session.notifyOnComplete === false)
            return;

        if (error) {
            this._showNotification('Big Shot', session.sessionDir, session.sessionDir);
        } else {
            this._showNotification(
                _('Recording complete'),
                _('Click to open the BigShot folder'),
                session.recordingDir
            );
        }
    }

    _showRecordingRegionMask(captureGeometry, screenGeometry) {
        this._destroyRecordingRegionMask();
        if (!captureGeometry)
            return;

        screenGeometry = screenGeometry || getVirtualScreenGeometry();
        let screenWidth = screenGeometry.width;
        let screenHeight = screenGeometry.height;
        let rects = buildRecordingRegionRects(
            captureGeometry,
            screenWidth,
            screenHeight,
            2
        );
        if (rects.masks.length === 0)
            return;

        let mask = new St.Widget({
            name: 'big-shot-recording-region-mask',
            reactive: false,
            can_focus: false,
            layout_manager: new Clutter.FixedLayout(),
        });
        mask.set_position(screenGeometry.x, screenGeometry.y);
        mask.set_size(screenWidth, screenHeight);

        let addActor = function(rect, style, name) {
            let actor = new St.Widget({
                name: name,
                reactive: false,
                can_focus: false,
                style: style,
            });
            actor.set_position(rect.x, rect.y);
            actor.set_size(rect.width, rect.height);
            mask.add_child(actor);
        };

        for (let i = 0; i < rects.masks.length; i++) {
            addActor(
                rects.masks[i],
                'background-color: rgba(0, 0, 0, 0.50);',
                'big-shot-recording-region-dim'
            );
        }
        for (let i = 0; i < rects.borders.length; i++) {
            addActor(
                rects.borders[i],
                'background-color: rgba(190, 190, 190, 0.90);',
                'big-shot-recording-region-border'
            );
        }

        let added = false;
        try {
            Main.layoutManager.addChrome(mask, {
                affectsInputRegion: false,
                affectsStruts: false,
                visibleInFullscreen: true,
            });
            added = true;
            if (mask.get_parent() === Main.uiGroup &&
                global.overlay_group.get_parent() === Main.uiGroup) {
                Main.uiGroup.set_child_above_sibling(mask, global.overlay_group);
            }
            mask.show();
            this._recordingRegionMask = mask;
        } catch (e) {
            log('[Big Shot] Failed to show recording region mask: ' + e.message);
            if (added) {
                try { Main.layoutManager.removeChrome(mask); } catch (_e) { /* */ }
            }
            try { mask.destroy(); } catch (_e) { /* */ }
        }
    }

    _destroyRecordingRegionMask() {
        if (!this._recordingRegionMask)
            return;

        let mask = this._recordingRegionMask;
        this._recordingRegionMask = null;
        try {
            Main.layoutManager.removeChrome(mask);
        } catch (e) {
            log('[Big Shot] Failed to remove recording region mask: ' + e.message);
        }
        try { mask.destroy(); } catch (_e) { /* */ }
    }

    // =========================================================================
    // PAUSE / RESUME
    // =========================================================================

    pauseRecording() {
        if (this._recordingState !== 'recording')
            return false;
        let session = this._recordingSession;
        if (!session || !session.currentSegment)
            return false;

        this._recordingState = 'pausing';
        if (this._indicator) {
            if (typeof this._indicator.onPausing === 'function')
                this._indicator.onPausing();
            else
                this._indicator.onPaused();
        }
        this._writeRecordingManifest(session);
        if (!this._requestSegmentStop(session, session.currentSegment, 'pause')) {
            this._recordingState = 'recording';
            if (this._indicator) {
                if (typeof this._indicator.onPauseCancelled === 'function')
                    this._indicator.onPauseCancelled();
                else
                    this._indicator.onResumed();
            }
            return false;
        }
        return true;
    }

    resumeRecording() {
        if (this._recordingState !== 'paused')
            return false;
        let session = this._recordingSession;
        if (!session || session.stopRequested || session.errorMessage)
            return false;

        this._recordingState = 'resuming';
        this._writeRecordingManifest(session);
        try {
            this._spawnRecordingSegment(session);
            this._recordingState = 'recording';
            if (this._indicator)
                this._indicator.onResumed();
            this._writeRecordingManifest(session);
            return true;
        } catch (e) {
            this._recordingState = 'paused';
            log('[Big Shot] Failed to resume recording: ' + e.message);
            if (this._indicator)
                this._indicator.onPaused();
            this._writeRecordingManifest(session);
            return false;
        }
    }

    togglePauseRecording() {
        if (this._recordingState === 'recording') {
            if (this.pauseRecording() && this._videoAnnotation)
                this._videoAnnotation.enterPausedEditFromPause();
        } else if (this._recordingState === 'paused') {
            if (this._videoAnnotation)
                this._videoAnnotation.finishEditForResume();
            this.resumeRecording();
        }
    }

    _selectAudioPipeline(ext) {
        let type = ext === 'mp4' ? 'aac' : 'vorbis';
        let choices = AUDIO_PIPELINES[type];
        for (let i = 0; i < choices.length; i++) {
            if (this._availableElements.has(choices[i].element))
                return choices[i].pipeline;
        }
        return null;
    }

    _makePipelineString(config, framerateCaps, downsize, quality, captureGeometry) {
        let video = config.src;
        let preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
        video += ' ! ' + config.enc(preset);

        if (downsize < 1.0) {
            let sourceWidth;
            let sourceHeight;
            if (captureGeometry) {
                sourceWidth = captureGeometry.width;
                sourceHeight = captureGeometry.height;
            } else {
                let geo = this._screenshotUI.monitorGeometry;
                sourceWidth = geo.width;
                sourceHeight = geo.height;
            }
            let targetW = toEvenDimension(sourceWidth * downsize);
            let targetH = toEvenDimension(sourceHeight * downsize);
            video = video.replace(
                /queue/,
                'queue ! videoscale ! video/x-raw,width=' + targetW + ',height=' + targetH
            );
        }

        let audioInput = this._audio ? this._audio.makeAudioInput() : null;
        let ext = config.ext;
        let muxer = MUXERS[ext];

        if (audioInput) {
            let audioPipeline = this._selectAudioPipeline(ext);
            if (!audioPipeline) {
                log('[Big Shot] No compatible audio encoder for ' + ext + '; recording without audio');
                return video + ' ! ' + muxer;
            }
            let videoSeg = video + ' ! queue ! mux.';
            let audioSeg = audioInput + ' ! ' + audioPipeline + ' ! mux.';
            let muxDef = muxer + ' name=mux';
            return videoSeg + ' ' + audioSeg + ' ' + muxDef;
        }

        return video + ' ! ' + muxer;
    }

    _showNotification(title, body, folderPath) {
        try {
            let MessageTray = imports.ui.messageTray;
            let source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            let notification = new MessageTray.Notification(source, title, body);
            if (folderPath) {
                notification.connect('clicked', () => {
                    try {
                        let uri = Gio.File.new_for_path(folderPath).get_uri();
                        Gio.AppInfo.launch_default_for_uri(
                            uri,
                            global.create_app_launch_context()
                        );
                    } catch (e) {
                        log('[Big Shot] Failed to open output folder: ' + e.message);
                    }
                });
            }
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
