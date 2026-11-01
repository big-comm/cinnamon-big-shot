/**
 * Big Shot — Webcam overlay during screen recording
 *
 * Displays a draggable webcam preview on screen using GStreamer + Clutter,
 * captured by the screencast compositor pipeline.
 * All mask effects (circle, halo, teardrop, vignette, rounded, widescreen,
 * ornate, neon) are
 * implemented as pixel-level alpha/colour operations — no external SVGs.
 *
 * Cinnamon CJS version — adapted from GNOME Shell ES module original.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const Clutter = imports.gi.Clutter;
const Cogl = imports.gi.Cogl;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const St = imports.gi.St;
const Main = imports.ui.main;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

let _ = function(str) { return str; };

let Gst = null;
try {
    Gst = imports.gi.Gst;
    // Loaded for its side effect: without the GstApp typelib, appsink
    // elements are plain Gst.Element and try_pull_sample() does not exist.
    imports.gi.GstApp;
} catch(e) {
    // GStreamer not available
    Gst = null;
}

const WEBCAM_DEFAULT_WIDTH = 320;

/** Masks that keep the camera's own aspect instead of a square crop. */
const FULL_FRAME_MASKS = new Set(['none', 'widescreen']);

// `var` so parttoolbar can read it through imports.parts.partwebcam.
var BUILTIN_MASKS = [
    { id: 'none',             label: () => _('None') },
    { id: 'circle',           label: () => _('Circle') },
    { id: 'halo',             label: () => _('Halo') },
    { id: 'teardrop',         label: () => _('Teardrop') },
    { id: 'spotlight',        label: () => _('Spot') },
    { id: 'squircle',         label: () => _('Rounded') },
    { id: 'widescreen',       label: () => _('Widescreen') },
    { id: 'ornate-frame',     label: () => _('Ornate') },
    { id: 'neon',             label: () => _('Neon Pink') },
    { id: 'neon-blue',        label: () => _('Neon Blue') },
    { id: 'spectrum',         label: () => _('Neon Spectrum') },
];

/** Ring and glow colours for the single-colour neon masks. */
const NEON_PALETTES = Object.freeze({
    neon: { ring: [255, 60, 235], glow: [190, 0, 220] },
    'neon-blue': { ring: [90, 215, 255], glow: [0, 120, 240] },
});

/** Neon Spectrum sweeps these stops around the ring, hue by angle. */
const SPECTRUM_STOPS = Object.freeze([
    [255, 70, 200],   // pink
    [200, 70, 255],   // violet
    [110, 120, 255],  // indigo
    [80, 200, 255],   // cyan
    [200, 70, 255],   // back to violet, so the sweep closes seamlessly
]);

// =============================================================================
// Simple Icon+Label button helper (same pattern as partaudio.js)
// =============================================================================

function _createIconLabelButton(gicon, labelText, params) {
    let btn = new St.Button(params);

    let container = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'spacing: 4px;',
    });
    btn.set_child(container);

    container.add_child(new St.Icon({ gicon: gicon, icon_size: 16 }));

    let labelActor = new St.Label({
        text: labelText,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'font-size: 11px;',
    });
    container.add_child(labelActor);

    return btn;
}

// =============================================================================
// PartWebcam
// =============================================================================

var PartWebcam = class PartWebcam extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._enabled = false;
        this._maskId = 'circle';
        this._width = WEBCAM_DEFAULT_WIDTH;

        // Runtime state
        this._pipeline = null;
        this._container = null;
        this._webcamActor = null;
        this._pollTimerId = 0;
        this._sink = null;
        this._coglCtx = null;
        this._frameWidth = 0;
        this._frameHeight = 0;
        this._probing = false;

        // Drag state
        this._dragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._capturedEventId = 0;

        // Saved position
        this._savedX = 80;
        this._savedY = 80;

        this._createButton();
    }

    // =========================================================================
    // Bottom bar button
    // =========================================================================

    _createButton() {
        let typeContainer = this._ui.controlContainer;
        if (!typeContainer)
            typeContainer = this._ui.panel;
        if (!typeContainer)
            return;

        this._webcamButton = _createIconLabelButton(
            new Gio.ThemedIcon({ name: 'camera-web-symbolic' }),
            _('Webcam'),
            {
                style_class: 'big-shot-audio-button',
                toggle_mode: true,
                reactive: false,
            }
        );
        this._webcamButton.visible = false;

        this._webcamButton.connect('notify::checked', () => {
            if (this._resettingButton)
                return;
            this.enabled = this._webcamButton.checked;
            if (this._enabled)
                this.startPreview();
            else
                this.stopPreview();
            if (this._webcamToggledCallback)
                this._webcamToggledCallback(this._enabled);
        });

        typeContainer.add_child(this._webcamButton);

        // Simple tooltip (no Screenshot.Tooltip in Cinnamon)
        this._webcamTooltip = new St.Label({
            text: _('Webcam Overlay'),
            style: 'background: rgba(0,0,0,0.85); color: #ffffff; padding: 4px 8px; border-radius: 4px; font-size: 11px;',
            visible: false,
        });
        this._ui.actor.add_child(this._webcamTooltip);

        this._webcamButton.connect('enter-event', () => {
            this._showTooltip(this._webcamButton, this._webcamTooltip);
        });
        this._webcamButton.connect('leave-event', () => {
            this._webcamTooltip.visible = false;
        });
    }

    _showTooltip(button, tooltip) {
        tooltip.visible = true;
        if (this._tooltipIdleId)
            GLib.source_remove(this._tooltipIdleId);
        this._tooltipIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._tooltipIdleId = 0;
            if (this._destroyed || !tooltip.visible || !this._ui.actor)
                return GLib.SOURCE_REMOVE;
            let pos = button.get_transformed_position();
            let origin = this._ui.actor.get_transformed_position();
            let bx = pos[0] - origin[0];
            let by = pos[1] - origin[1];
            let bw = button.width;
            let tw = tooltip.width;
            tooltip.set_position(bx + (bw - tw) / 2, by - tooltip.height - 4);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Register callback for external listeners (e.g. mask row visibility). */
    onWebcamToggled(callback) {
        this._webcamToggledCallback = callback;
    }

    get enabled() { return this._enabled; }
    set enabled(val) {
        this._enabled = !!val;
        if (!this._enabled)
            this.stopPreview();
    }

    get maskId() { return this._maskId; }
    set maskId(val) {
        this._maskId = val;
        this._updateContainerLayout();
    }

    get width() { return this._width; }
    set width(val) {
        if (this._width === val)
            return;
        this._width = val;
        // If currently previewing, restart with new size
        if (this._enabled && this._pipeline && !this._probing) {
            this._stopPipeline();
            this._startPipeline();
        }
    }

    get masks() {
        return BUILTIN_MASKS.map(mask => ({
            id: mask.id,
            label: mask.label(),
        }));
    }
    get available() { return Gst !== null; }

    get selectedDevice() { return this._selectedDevice ? this._selectedDevice : null; }
    set selectedDevice(val) {
        if (this._selectedDevice === val)
            return;
        this._selectedDevice = val;
        // Restart pipeline with new device if currently previewing
        if (this._enabled && this._pipeline && !this._probing) {
            this._stopPipeline();
            this._startPipeline();
        }
    }

    /** Enumerate available webcam devices with human-readable names.
     *  Filters out duplicate V4L2 nodes (metadata/secondary) by keeping
     *  only the first device per unique name (typically the capture node).
     *  Returns [{device: '/dev/video0', name: 'USB Camera', index: 0}, ...] */
    enumerateDevices() {
        const seen = new Set();
        const cams = [];
        for (let i = 0; i < 10; i++) {
            const dev = '/dev/video' + i;
            if (!GLib.file_test(dev, GLib.FileTest.EXISTS))
                continue;
            // Read device name from sysfs
            const nameFile = '/sys/class/video4linux/video' + i + '/name';
            let name = _('Camera %s').format(i);
            try {
                let [ok, contents] = GLib.file_get_contents(nameFile);
                if (ok) {
                    let decoder = new TextDecoder();
                    name = decoder.decode(contents).trim();
                }
            } catch(e) { /* ignore */ }

            // Skip duplicate names (secondary V4L2 nodes for same camera)
            if (seen.has(name))
                continue;
            seen.add(name);

            cams.push({ device: dev, name: name, index: i });
        }
        return cams;
    }

    // =========================================================================
    // Preview lifecycle
    // =========================================================================

    startPreview() {
        log('[Big Shot Webcam] startPreview called: enabled=' + this._enabled +
            ' Gst=' + !!Gst + ' pipeline=' + !!this._pipeline +
            ' isCastMode=' + this._isCastMode);
        if (!this._enabled || !Gst || this._pipeline || !this._isCastMode)
            return;

        this._createOverlay();
        this._startPipeline();
    }

    stopPreview() {
        this._stopPipeline();
        this._destroyOverlay();
    }

    _onModeChanged(isCast) {
        // Show/hide bottom bar button based on screencast mode
        if (this._webcamButton) {
            this._webcamButton.visible = isCast;
            this._webcamButton.reactive = isCast;
        }

        // Don't stop webcam if recording — _finishClosing() resets mode
        // to screenshot, but we need the webcam to persist during recording.
        if (!isCast && (!this._ext || this._ext._recordingState === 'idle'))
            this.stopPreview();
    }

    // =========================================================================
    // Container / overlay geometry helpers
    // =========================================================================

    /** Circle-based masks use a square container inscribed in the shorter dim.
     *  'none' and 'widescreen' keep the camera's own aspect (widescreen does
     *  its own cropping; boxing it in a square would leave a thin strip). */
    _isCircleBased() {
        return !FULL_FRAME_MASKS.has(this._maskId);
    }

    _containerSize() {
        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        if (this._isCircleBased()) {
            const s = Math.min(fw, fh);
            return { w: s, h: s };
        }
        return { w: fw, h: fh };
    }

    _actorOffset() {
        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        if (this._isCircleBased()) {
            const s = Math.min(fw, fh);
            return { x: -(fw - s) / 2, y: -(fh - s) / 2 };
        }
        return { x: 0, y: 0 };
    }

    /** Recalculate container and webcamActor layout when mask changes. */
    _updateContainerLayout() {
        if (!this._container || !this._webcamActor)
            return;

        const sz = this._containerSize();
        const off = this._actorOffset();

        this._container.set_size(sz.w, sz.h);
        this._webcamActor.set_position(off.x, off.y);
        this._webcamActor.set_size(
            this._frameWidth || this._width,
            this._frameHeight || Math.round(this._width * 3 / 4)
        );
    }

    // =========================================================================
    // Overlay
    // =========================================================================

    _createOverlay() {
        if (this._container)
            return;

        const fw = this._frameWidth || this._width;
        const fh = this._frameHeight || Math.round(this._width * 3 / 4);
        const sz = this._containerSize();
        const off = this._actorOffset();

        this._container = new St.Widget({
            reactive: true,
            width: sz.w,
            height: sz.h,
            x: this._savedX,
            y: this._savedY,
            clip_to_allocation: true,
        });

        this._webcamActor = new Clutter.Actor({
            width: fw,
            height: fh,
            x: off.x,
            y: off.y,
        });
        this._container.add_child(this._webcamActor);

        this._setupDrag();

        // Start as child of screenshotUI so the GrabHelper considers
        // clicks on us as "inside" the modal — prevents UI close on click.
        this._overlayParent = 'ui';
        this._ui.actor.add_child(this._container);
    }

    /** Move the overlay to Chrome (for recording, when UI hides). */
    reparentForRecording() {
        if (!this._container || this._overlayParent === 'chrome')
            return;
        this._savedX = this._container.x;
        this._savedY = this._container.y;
        let parent = this._container.get_parent();
        if (parent)
            parent.remove_child(this._container);
        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: true,
        });
        this._container.set_position(this._savedX, this._savedY);
        this._overlayParent = 'chrome';

        // Reconnect drag capture to global.stage so dragging works during recording
        this._connectDragCapture(global.stage);
    }

    /** Move the overlay back to the screenshotUI (for preview). */
    reparentForPreview() {
        if (!this._container || this._overlayParent === 'ui')
            return;
        this._savedX = this._container.x;
        this._savedY = this._container.y;
        try {
            Main.layoutManager.removeChrome(this._container);
        } catch(e) {
            // Ignore if already removed
        }
        this._ui.actor.add_child(this._container);
        this._container.set_position(this._savedX, this._savedY);
        this._overlayParent = 'ui';

        // Reconnect drag capture back to screenshotUI
        this._connectDragCapture(this._ui.actor);
    }

    _destroyOverlay() {
        if (this._container) {
            this._savedX = this._container.x;
            this._savedY = this._container.y;
        }

        this._cleanupDrag();

        if (this._container) {
            if (this._overlayParent === 'chrome') {
                try {
                    Main.layoutManager.removeChrome(this._container);
                } catch(e) {
                    // Ignore if already removed
                }
            } else {
                let parent = this._container.get_parent();
                if (parent)
                    parent.remove_child(this._container);
            }

            this._container.destroy();
            this._container = null;
            this._webcamActor = null;
            this._overlayParent = null;
        }
    }

    // =========================================================================
    // Pixel-level mask functions
    // =========================================================================

    /** Apply the active mask to RGBA pixel data in-place.
     *  All masks work in normalised-radius space:
     *    dist = sqrt((dx/rx)^2 + (dy/ry)^2)
     *  where rx,ry define the mask axes.
     */
    _applyMaskToPixels(data, w, h) {
        switch (this._maskId) {
        case 'none':
            return;
        case 'circle':
            this._maskCircle(data, w, h);
            return;
        case 'halo':
            this._maskHalo(data, w, h);
            return;
        case 'teardrop':
            this._maskTeardrop(data, w, h);
            return;
        case 'spotlight':
            this._maskSpotlight(data, w, h);
            return;
        case 'squircle':
            this._maskRoundedRect(data, w, h, 1.0, 0.14);
            return;
        case 'widescreen':
            this._maskRoundedRect(data, w, h, 16 / 9, 0.08);
            return;
        case 'spectrum':
            this._maskNeon(data, w, h, null);
            return;
        case 'ornate-frame':
            this._maskOrnate(data, w, h);
            return;
        case 'neon':
        case 'neon-blue':
            this._maskNeon(data, w, h, NEON_PALETTES[this._maskId]);
            return;
        }
    }

    /** Sharp circle — r = min(w,h)/2, centred. */
    _maskCircle(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const edge = 0.04;         // 4 % soft edge
        const thresh2 = (1 - edge) * (1 - edge);

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                // Entire row outside — zero alpha
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                if (d2 > 1.0)
                    data[(y * w + x) * 4 + 3] = 0;
                else if (d2 > thresh2) {
                    const d = Math.sqrt(d2);
                    const t = (1.0 - d) / edge;
                    data[(y * w + x) * 4 + 3] = Math.round(
                        data[(y * w + x) * 4 + 3] * t,
                    );
                }
            }
        }
    }

    /** Halo: a thin translucent light band just inside a darkened rim, so the
     *  webcam reads as sitting behind glass. The band stays see-through — it
     *  frames the subject instead of covering them. */
    _maskHalo(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const edge = 0.025;

        const bandInner = 0.855;  // narrow band, hugging the rim
        const bandOuter = 0.965;
        const bandPeak = (bandOuter + bandInner) / 2;
        const bandHalf = (bandOuter - bandInner) / 2;
        const maxWhite = 0.30;    // translucent: content stays visible through it

        const rimStart = 0.955;   // dark outline that defines the edge
        const maxDark = 0.62;

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                if (d2 > 1.0) {
                    data[idx + 3] = 0;
                    continue;
                }
                const d = Math.sqrt(d2);

                if (d > bandInner) {
                    const t = 1 - Math.abs(d - bandPeak) / bandHalf;
                    const mix = maxWhite * Math.max(0, t) ** 1.2;
                    data[idx]     = Math.round(data[idx]     * (1 - mix) + 255 * mix);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - mix) + 255 * mix);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - mix) + 255 * mix);
                }

                if (d > rimStart) {
                    const t = (d - rimStart) / (1 - rimStart);
                    const dark = 1 - maxDark * t ** 0.8;
                    data[idx]     = Math.round(data[idx]     * dark);
                    data[idx + 1] = Math.round(data[idx + 1] * dark);
                    data[idx + 2] = Math.round(data[idx + 2] * dark);
                }

                if (d > 1 - edge)
                    data[idx + 3] = Math.round(data[idx + 3] * ((1 - d) / edge));
            }
        }
    }

    /** Rounded rectangle, cropping the sides to `aspect` and rounding the
     *  corners by `radius` (a fraction of the shorter side).
     *
     *  Uses a signed distance field so the straight edges get exactly the
     *  same soft transition as the corners. Testing the corners separately —
     *  as this did before — left the flat sides cut off abruptly, which read
     *  as "only the corners have an effect".
     */
    _maskRoundedRect(data, w, h, aspect, radius) {
        // Largest aspect-correct box that fits the frame, centred.
        let boxW = w;
        let boxH = Math.round(w / aspect);
        if (boxH > h) {
            boxH = h;
            boxW = Math.round(h * aspect);
        }
        const cx = w / 2;
        const cy = h / 2;
        const rad = Math.min(boxW, boxH) * radius;
        // Half-extents of the straight part, i.e. the box minus its corners.
        const halfW = boxW / 2 - rad;
        const halfH = boxH / 2 - rad;
        const edge = Math.max(1.2, Math.min(boxW, boxH) * 0.012);

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const qy = Math.abs(y + 0.5 - cy) - halfH;
            for (let x = 0; x < w; x++) {
                const qx = Math.abs(x + 0.5 - cx) - halfW;
                // Signed distance to the rounded-box outline: < 0 inside.
                const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
                    Math.min(Math.max(qx, qy), 0) - rad;
                const idx = (y * w + x) * 4;
                if (dist >= 0) {
                    data[idx + 3] = 0;
                } else if (dist > -edge) {
                    data[idx + 3] = Math.round(
                        data[idx + 3] * smooth(-dist / edge));
                }
            }
        }
    }

    /** Spotlight / vignette: circle with darkened edges inside. */
    _maskSpotlight(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.1) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                if (d2 > 1.0) {
                    data[idx + 3] = 0;
                } else {
                    const d = Math.sqrt(d2);
                    // Darken edges: brightness = 1 in centre → 0.15 at rim
                    let brightness;
                    if (d < 0.5)
                        brightness = 1.0;
                    else
                        brightness = 1.0 - 0.85 * ((d - 0.5) / 0.5) ** 1.6;
                    data[idx]     = Math.round(data[idx]     * brightness);
                    data[idx + 1] = Math.round(data[idx + 1] * brightness);
                    data[idx + 2] = Math.round(data[idx + 2] * brightness);
                    // Smooth alpha at very edge
                    if (d > 0.96)
                        data[idx + 3] = Math.round(data[idx + 3] * ((1 - d) / 0.04));
                }
            }
        }
    }

    /** Ornate: circle with BigCommunity gradient border (blue→purple→pink). */
    _maskOrnate(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;

        // Border ring (normalised to radius)
        const innerR = 0.946;
        const outerR = 1.0;
        const aa = 0.012;

        // Circular gradient stops (seamless loop around the circle):
        //  Left=Blue, Top=Purple, Right=Pink, Bottom=Purple, back to Blue
        // Angle normalised [0,1): 0=left, 0.25=top, 0.5=right, 0.75=bottom
        const gStops = [
            { a: 0.00, r: 59,  g: 130, b: 246 },  // blue  (left)
            { a: 0.25, r: 139, g: 92,  b: 246 },  // purple (top)
            { a: 0.50, r: 236, g: 72,  b: 153 },  // pink  (right)
            { a: 0.75, r: 139, g: 92,  b: 246 },  // purple (bottom)
            { a: 1.00, r: 59,  g: 130, b: 246 },  // blue  (left, wrap)
        ];

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > (outerR + aa) * (outerR + aa)) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d2 = dx * dx + dy2;
                const idx = (y * w + x) * 4;
                const d = Math.sqrt(d2);

                if (d > outerR + aa) {
                    data[idx + 3] = 0;
                } else if (d > innerR - aa) {
                    // Angular position [0,1)
                    const angle = (Math.atan2(y - cy, x - cx) / Math.PI + 1) / 2;

                    // Find surrounding gradient stops and interpolate
                    let cR, cG, cB;
                    for (let i = 0; i < gStops.length - 1; i++) {
                        if (angle >= gStops[i].a && angle <= gStops[i + 1].a) {
                            const span = gStops[i + 1].a - gStops[i].a;
                            const t = (angle - gStops[i].a) / span;
                            cR = gStops[i].r * (1 - t) + gStops[i + 1].r * t;
                            cG = gStops[i].g * (1 - t) + gStops[i + 1].g * t;
                            cB = gStops[i].b * (1 - t) + gStops[i + 1].b * t;
                            break;
                        }
                    }

                    // Blend factor: 0 = webcam, 1 = gradient
                    let blend = 1.0;
                    if (d < innerR)
                        blend = (d - (innerR - aa)) / aa;

                    // Outer edge alpha
                    let alpha = 255;
                    if (d > outerR)
                        alpha = Math.round(255 * Math.max(0, (outerR + aa - d) / aa));

                    data[idx]     = Math.round(data[idx]     * (1 - blend) + cR * blend);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - blend) + cG * blend);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - blend) + cB * blend);
                    data[idx + 3] = Math.min(data[idx + 3], alpha);
                }
                // else: inside inner circle — keep webcam pixels unchanged
            }
        }
    }

    /** Sample the spectrum gradient at an angle, in radians. */
    _spectrumColour(angle) {
        const span = SPECTRUM_STOPS.length - 1;
        const t = ((angle / (Math.PI * 2)) % 1 + 1) % 1 * span;
        const i = Math.min(span - 1, Math.floor(t));
        const f = t - i;
        const a = SPECTRUM_STOPS[i];
        const b = SPECTRUM_STOPS[i + 1];
        return [
            a[0] + (b[0] - a[0]) * f,
            a[1] + (b[1] - a[1]) * f,
            a[2] + (b[2] - a[2]) * f,
        ];
    }

    /** Neon ring with outer glow.
     *
     *  `palette` null selects the angular spectrum sweep instead of a single
     *  colour. Every transition is smoothed over one pixel — measured as
     *  1/r in the normalised space the mask works in — because a fixed
     *  fraction of the radius is thinner than a pixel on a small preview and
     *  that is what made the ring look stair-stepped.
     */
    _maskNeon(data, w, h, palette = NEON_PALETTES.neon) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const px = 1 / r;                     // one pixel, normalised
        const aa = Math.max(px * 1.5, 0.006);  // anti-alias width

        // Ring thick enough to survive small previews.
        const ringCenter = 0.90;
        const ringHalf = Math.max(0.026, px * 2.5);
        const ringInner = ringCenter - ringHalf;
        const ringOuter = ringCenter + ringHalf;
        const glowInner = ringInner - 0.16;   // soft bloom on the inside
        const glowOuter = 1.0;                // fades out by the crop edge

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const dy = (y - cy) / r;
            const dy2 = dy * dy;
            if (dy2 > 1.2) {
                for (let x = 0; x < w; x++)
                    data[(y * w + x) * 4 + 3] = 0;
                continue;
            }
            for (let x = 0; x < w; x++) {
                const dx = (x - cx) / r;
                const d = Math.sqrt(dx * dx + dy2);
                const idx = (y * w + x) * 4;

                const [cR, cG, cB] = palette
                    ? palette.ring
                    : this._spectrumColour(Math.atan2(dy, dx) + Math.PI);
                const [gR, gG, gB] = palette ? palette.glow : [cR * 0.75, cG * 0.75, cB * 0.9];

                if (d > glowOuter + aa) {
                    data[idx + 3] = 0;
                    continue;
                }

                // Ring intensity: 1 at the centre line, easing to 0 over aa.
                const ring = 1 - smooth((Math.abs(d - ringCenter) - ringHalf) / aa + 1);

                if (ring > 0.001) {
                    // White-hot core blended towards the neon colour outwards.
                    const core = ring ** 2.2;
                    const rr = cR + (255 - cR) * core * 0.85;
                    const rg = cG + (255 - cG) * core * 0.85;
                    const rb = cB + (255 - cB) * core * 0.85;
                    data[idx]     = Math.round(data[idx]     * (1 - ring) + rr * ring);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - ring) + rg * ring);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - ring) + rb * ring);
                    data[idx + 3] = Math.max(data[idx + 3], Math.round(255 * ring));
                }

                if (d > ringOuter) {
                    // Outside the ring there is no webcam content: paint glow
                    // over transparency so it blends with whatever is behind.
                    const t = (d - ringOuter) / (glowOuter - ringOuter);
                    const glow = (1 - smooth(t)) ** 1.6;
                    const alpha = Math.round(200 * glow);
                    if (ring <= 0.001) {
                        data[idx]     = Math.round(gR);
                        data[idx + 1] = Math.round(gG);
                        data[idx + 2] = Math.round(gB);
                        data[idx + 3] = alpha;
                    } else {
                        data[idx + 3] = Math.max(data[idx + 3], alpha);
                    }
                } else if (d > glowInner && ring <= 0.001) {
                    // Inner bloom tinting the webcam edge.
                    const t = (d - glowInner) / (ringInner - glowInner);
                    const bloom = smooth(t) * 0.5;
                    data[idx]     = Math.round(data[idx]     * (1 - bloom) + gR * bloom);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - bloom) + gG * bloom);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - bloom) + gB * bloom);
                }
            }
        }
    }

    /** Teardrop: the streaming-overlay frame — a circle whose bottom-right
     *  corner stays square, giving the drop/speech-bubble silhouette, wrapped
     *  in a thin white border. The distance field is evaluated per quadrant so
     *  the border keeps an even thickness all the way around the join.
     */
    _maskTeardrop(data, w, h) {
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(w, h) / 2;
        const aa = Math.max(1.2, r * 0.012);
        const border = Math.max(2, r * 0.05);   // thin, like the reference

        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        for (let y = 0; y < h; y++) {
            const py = y + 0.5 - cy;
            for (let x = 0; x < w; x++) {
                const px = x + 0.5 - cx;
                const idx = (y * w + x) * 4;

                // Bottom-right quadrant is a square corner; the rest is round.
                const dist = (px >= 0 && py >= 0)
                    ? Math.max(px - r, py - r)
                    : Math.hypot(px, py) - r;

                if (dist >= 0) {
                    data[idx + 3] = 0;
                    continue;
                }
                // White band hugging the inside of the outline.
                const white = smooth((dist + border) / border);
                if (white > 0.001) {
                    data[idx]     = Math.round(data[idx]     * (1 - white) + 255 * white);
                    data[idx + 1] = Math.round(data[idx + 1] * (1 - white) + 255 * white);
                    data[idx + 2] = Math.round(data[idx + 2] * (1 - white) + 255 * white);
                }
                if (dist > -aa)
                    data[idx + 3] = Math.round(data[idx + 3] * smooth(-dist / aa));
            }
        }
    }

    /** Check if stage coordinates are within the container's bounds. */
    _hitTestContainer(stageX, stageY) {
        if (!this._container)
            return false;
        let result = this._container.transform_stage_point(stageX, stageY);
        if (!result)
            return false;
        let ok = result[0];
        let lx = result[1];
        let ly = result[2];
        return ok && lx >= 0 && ly >= 0 &&
               lx <= this._container.width && ly <= this._container.height;
    }

    _setupDrag() {
        if (!this._container)
            return;

        // All drag events (press, motion, release) are handled via
        // captured-event on the parent scope. This avoids relying on
        // button-press-event delivery to the container, which can fail
        // when the overlay is reparented to Chrome during recording.
        this._connectDragCapture(this._ui.actor);
    }

    /** Handler for all drag events via captured-event on the parent scope.
     *  Uses manual hit-testing so drag works in both screenshotUI and
     *  Chrome (recording) contexts. */
    _onDragCapturedEvent(_actor, event) {
        const type = event.type();

        // Start drag on button press if click is on the webcam container
        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            let coords = event.get_coords();
            let mx = coords[0];
            let my = coords[1];
            const hit = this._hitTestContainer(mx, my);
            if (hit) {
                this._dragging = true;
                this._dragOffsetX = this._container.x - mx;
                this._dragOffsetY = this._container.y - my;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION) {
            let coords = event.get_coords();
            let mx = coords[0];
            let my = coords[1];
            this._container.set_position(
                mx + this._dragOffsetX,
                my + this._dragOffsetY
            );
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._dragging = false;
            this._savedX = this._container.x;
            this._savedY = this._container.y;
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /** Connect drag capture to a given actor (screenshotUI or global.stage). */
    _connectDragCapture(actor) {
        this._disconnectDragCapture();
        this._dragCaptureActor = actor;
        this._dragCapturedId = actor.connect('captured-event',
            this._onDragCapturedEvent.bind(this));
    }

    /** Disconnect the current drag capture listener. */
    _disconnectDragCapture() {
        if (this._dragCapturedId && this._dragCaptureActor) {
            this._dragCaptureActor.disconnect(this._dragCapturedId);
            this._dragCapturedId = 0;
            this._dragCaptureActor = null;
        }
    }

    _cleanupDrag() {
        this._dragging = false;
        this._disconnectDragCapture();
    }

    // =========================================================================
    // GStreamer pipeline
    // =========================================================================

    _findWebcamDevices() {
        const devices = [];
        for (let i = 0; i < 10; i++) {
            const path = '/dev/video' + i;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                devices.push(path);
        }
        return devices;
    }

    /** Quote a value for Gst.parse_launch (double quotes, \ and " escaped). */
    _gstQuote(value) {
        return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    _sourceElement(device) {
        return device === 'pipewire'
            ? 'pipewiresrc'
            : 'v4l2src device=' + this._gstQuote(device);
    }

    /** Watch the pipeline bus so runtime errors (camera unplugged, busy
     *  device, negotiation failure) are not silently ignored. */
    _watchBus(pipeline, onError) {
        const bus = pipeline.get_bus();
        bus.add_signal_watch();
        this._bus = bus;
        this._busErrorId = bus.connect('message::error', (_bus, message) => {
            let detail = '';
            try {
                const parsed = message.parse_error();
                detail = parsed[0] ? parsed[0].message : '';
            } catch (e) {
                // ignore
            }
            log('[Big Shot Webcam] Pipeline error: ' + detail);
            onError();
        });
    }

    /** Stop the current pipeline/timer/bus watch without touching UI state. */
    _teardownPipeline() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }
        if (this._bus) {
            if (this._busErrorId)
                this._bus.disconnect(this._busErrorId);
            this._bus.remove_signal_watch();
            this._bus = null;
            this._busErrorId = 0;
        }
        this._sink = null;
        if (this._pipeline) {
            try {
                this._pipeline.set_state(Gst.State.NULL);
            } catch (e) {
                // Ignore cleanup errors
            }
            this._pipeline = null;
        }
    }

    _startPipeline() {
        log('[Big Shot Webcam] _startPipeline called');
        if (!Gst || this._pipeline)
            return;

        // CJS rejects Gst.init(null) ("Expected type utf8 for argv"): pass
        // an empty array. Any Gst call before a successful init segfaults
        // inside libgstreamer and takes Cinnamon down, so bail out instead.
        try {
            if (!Gst.is_initialized())
                Gst.init([]);
        } catch (e) {
            log('[Big Shot Webcam] GStreamer init failed: ' + e.message);
        }
        if (!Gst.is_initialized()) {
            this._onWebcamFailed();
            return;
        }

        // If the user selected a device, try only that one; otherwise try
        // every /dev/video* node, then PipeWire as last resort.
        this._candidates = this._selectedDevice
            ? [this._selectedDevice]
            : this._findWebcamDevices().concat(['pipewire']);
        this._tryNextCandidate();
    }

    _tryNextCandidate() {
        while (this._candidates && this._candidates.length > 0) {
            const device = this._candidates.shift();
            if (this._startProbe(device))
                return;
        }
        this._candidates = null;
        log('[Big Shot Webcam] No usable webcam device found');
        this._onWebcamFailed();
    }

    /** Start a probe pipeline on `device`. Returns false on immediate failure. */
    _startProbe(device) {
        let pipeline;
        try {
            pipeline = Gst.parse_launch([
                this._sourceElement(device),
                'videoconvert',
                'video/x-raw,format=RGBA',
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ! '));
        } catch (e) {
            return false;
        }

        this._pipeline = pipeline;
        this._sink = pipeline.get_by_name('sink');
        this._watchBus(pipeline, () => {
            // Device rejected (metadata node, busy…) → next candidate
            this._teardownPipeline();
            this._probing = false;
            this._tryNextCandidate();
        });

        if (pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) {
            this._teardownPipeline();
            return false;
        }

        this._activeDevice = device;
        this._probing = true;
        this._probeStartTime = GLib.get_monotonic_time();
        this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            return this._probeFrame(device);
        });
        log('[Big Shot Webcam] Probing device: ' + device);
        return true;
    }

    /** Called when no webcam device could be started. Resets UI state. */
    _onWebcamFailed() {
        this._teardownPipeline();
        this._probing = false;
        this._enabled = false;
        this._resettingButton = true;
        if (this._webcamButton)
            this._webcamButton.checked = false;
        this._resettingButton = false;
        this._destroyOverlay();
        if (this._webcamToggledCallback)
            this._webcamToggledCallback(false);
    }

    /** Read first frame to detect native webcam resolution, then start render pipeline. */
    _probeFrame(device) {
        if (!this._sink) {
            this._pollTimerId = 0;
            return GLib.SOURCE_REMOVE;
        }

        // Timeout: try the next device if no frame within 5 seconds
        const elapsed = (GLib.get_monotonic_time() - this._probeStartTime) / 1e6;
        if (elapsed > 5.0) {
            log('[Big Shot Webcam] Probe timed out on ' + device);
            this._pollTimerId = 0;
            this._teardownPipeline();
            this._probing = false;
            this._tryNextCandidate();
            return GLib.SOURCE_REMOVE;
        }

        let sample;
        try {
            sample = this._sink.try_pull_sample(0);
        } catch (e) {
            // Not transient (e.g. GstApp typelib missing): fail loudly.
            log('[Big Shot Webcam] try_pull_sample failed: ' + e.message);
            this._pollTimerId = 0;
            this._candidates = null;
            this._onWebcamFailed();
            return GLib.SOURCE_REMOVE;
        }
        if (!sample)
            return GLib.SOURCE_CONTINUE;

        // Read native dimensions
        const struct = sample.get_caps().get_structure(0);
        const [okW, nw] = struct.get_int('width');
        const [okH, nh] = struct.get_int('height');

        // Stop probe pipeline (the timer is removed by returning REMOVE)
        this._pollTimerId = 0;
        this._teardownPipeline();
        this._probing = false;
        this._candidates = null;

        if (!okW || !okH || nw <= 0 || nh <= 0) {
            log('[Big Shot Webcam] Invalid frame size from ' + device);
            this._onWebcamFailed();
            return GLib.SOURCE_REMOVE;
        }

        // Calculate target dimensions preserving aspect ratio
        const targetW = this._width;
        const targetH = Math.max(1, Math.round(targetW * nh / nw));
        this._frameWidth = targetW;
        this._frameHeight = targetH;

        // Recalculate container/actor geometry
        this._updateContainerLayout();

        // Phase 2: Start rendering pipeline with correct dimensions
        this._startRenderPipeline(device, targetW, targetH, nw, nh);
        return GLib.SOURCE_REMOVE;
    }

    _startRenderPipeline(device, w, h, nativeW, nativeH) {
        log('[Big Shot Webcam] _startRenderPipeline: device=' + device + ' w=' + w + ' h=' + h + ' native=' + nativeW + 'x' + nativeH);
        try {
            // Lock source to the probed native resolution so that
            // videoscale always receives the expected aspect ratio
            // instead of a different v4l2 mode negotiated by GStreamer.
            const nativeCaps = (nativeW && nativeH)
                ? ' video/x-raw,width=' + nativeW + ',height=' + nativeH + ' !'
                : '';

            const pipelineStr = [
                this._sourceElement(device) + ' !',
                'videoflip method=horizontal-flip !',
                'videoconvert !' + nativeCaps + ' videoscale !',
                'video/x-raw,format=RGBA,width=' + w + ',height=' + h + ' !',
                'appsink name=sink max-buffers=1 drop=true sync=false',
            ].join(' ');

            this._pipeline = Gst.parse_launch(pipelineStr);
            this._sink = this._pipeline.get_by_name('sink');
            this._watchBus(this._pipeline, () => {
                this._stopPipeline();
                this._onWebcamFailed();
            });

            const ret = this._pipeline.set_state(Gst.State.PLAYING);
            if (ret === Gst.StateChangeReturn.FAILURE) {
                log('[Big Shot Webcam] Render pipeline failed to start');
                this._onWebcamFailed();
                return;
            }

            this._activeDevice = device;
            this._image = new Clutter.Image();
            this._imageAttached = false;
            this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                this._pollFrame();
                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            log('[Big Shot Webcam] Pipeline failed: ' + e.message);
            this._onWebcamFailed();
        }
    }

    /**
     * Precompute the active mask as a per-pixel affine transform.
     *
     * Every mask is affine in the input colour for a given pixel:
     *   rgb' = rgb * k + add,  alpha' = alpha * am
     * so running the (expensive, sqrt/atan2-heavy) mask functions once on
     * an all-black and an all-white frame yields k/add/am. Per frame we
     * only touch the pixels the mask actually changes.
     */
    _getMaskTable(w, h) {
        const key = this._maskId + ':' + w + 'x' + h;
        if (this._maskTable && this._maskTable.key === key)
            return this._maskTable;

        if (this._maskId === 'none') {
            this._maskTable = { key: key, indices: null };
            return this._maskTable;
        }

        const n = w * h;
        const black = new Uint8Array(n * 4);
        const white = new Uint8Array(n * 4).fill(255);
        for (let i = 0; i < n; i++)
            black[i * 4 + 3] = 255;
        this._applyMaskToPixels(black, w, h);
        this._applyMaskToPixels(white, w, h);

        const changed = [];
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            if (black[o] !== 0 || black[o + 1] !== 0 || black[o + 2] !== 0 ||
                black[o + 3] !== 255 || white[o] !== 255 ||
                white[o + 1] !== 255 || white[o + 2] !== 255)
                changed.push(i);
        }

        const count = changed.length;
        const indices = new Int32Array(changed);
        const k = new Float32Array(count * 3);
        const add = new Float32Array(count * 3);
        const am = new Float32Array(count);
        for (let j = 0; j < count; j++) {
            const o = indices[j] * 4;
            for (let c = 0; c < 3; c++) {
                add[j * 3 + c] = black[o + c];
                k[j * 3 + c] = (white[o + c] - black[o + c]) / 255;
            }
            am[j] = black[o + 3] / 255;
        }

        this._maskTable = { key: key, indices: indices, k: k, add: add, am: am };
        return this._maskTable;
    }

    _applyMaskTable(data, table) {
        const indices = table.indices;
        if (!indices)
            return;
        const k = table.k;
        const add = table.add;
        const am = table.am;
        for (let j = 0; j < indices.length; j++) {
            const o = indices[j] * 4;
            const t = j * 3;
            data[o] = data[o] * k[t] + add[t];
            data[o + 1] = data[o + 1] * k[t + 1] + add[t + 1];
            data[o + 2] = data[o + 2] * k[t + 2] + add[t + 2];
            data[o + 3] = data[o + 3] * am[j];
        }
    }

    _pollFrame() {
        if (!this._sink || !this._webcamActor)
            return;

        try {
            const sample = this._sink.try_pull_sample(0);
            if (!sample)
                return;

            const fw = this._frameWidth;
            const fh = this._frameHeight;

            const buffer = sample.get_buffer();
            const [success, mapInfo] = buffer.map(Gst.MapFlags.READ);
            if (!success)
                return;

            try {
                // Copy pixel data so we can modify for masking
                const data = new Uint8Array(mapInfo.data);
                this._applyMaskTable(data, this._getMaskTable(fw, fh));

                // Reuse one Clutter.Image; set_data replaces its texture.
                const ok = this._image.set_data(
                    data,
                    Cogl.PixelFormat.RGBA_8888,
                    fw, fh,
                    fw * 4
                );
                if (ok && !this._imageAttached) {
                    this._webcamActor.set_content(this._image);
                    this._imageAttached = true;
                }
            } finally {
                buffer.unmap(mapInfo);
            }
        } catch (e) {
            // Skip frame on error
        }
    }

    _stopPipeline() {
        this._teardownPipeline();
        this._candidates = null;
        this._probing = false;
        this._activeDevice = null;
        this._probeStartTime = 0;
        this._image = null;
        this._imageAttached = false;
    }

    // =========================================================================
    // Cleanup
    // =========================================================================

    destroy() {
        this.stopPreview();
        if (this._tooltipIdleId) {
            GLib.source_remove(this._tooltipIdleId);
            this._tooltipIdleId = 0;
        }

        if (this._webcamTooltip) {
            let p = this._webcamTooltip.get_parent();
            if (p) p.remove_child(this._webcamTooltip);
            this._webcamTooltip.destroy();
            this._webcamTooltip = null;
        }
        if (this._webcamButton) {
            let p = this._webcamButton.get_parent();
            if (p) p.remove_child(this._webcamButton);
            this._webcamButton.destroy();
            this._webcamButton = null;
        }

        PartUI.prototype.destroy.call(this);
    }
};

PartWebcam.setGettext = function(fn) { _ = fn; };
