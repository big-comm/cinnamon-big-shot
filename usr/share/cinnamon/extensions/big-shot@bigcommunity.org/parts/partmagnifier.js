/**
 * Big Shot — Selection magnifier for Cinnamon
 *
 * SPDX-License-Identifier: MIT
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;

const PartBase = imports.parts.partbase;
const PartUI = PartBase.PartUI;

const CAIRO_OPERATOR_CLEAR = 0;
const CAIRO_OPERATOR_OVER = 2;
const AREA_MODE = 2;
const LENS_SIZE = 300;
const LENS_PADDING = 4;
const LENS_OFFSET = 30;
const ZOOM_MIN = 2;
const ZOOM_MAX = 6;
const ZOOM_STEP = 0.5;
const ZOOM_DEFAULT = 2;
const POLL_IDLE_MS = 200;
const POLL_ACTIVE_MS = 16;

var PartMagnifier = class PartMagnifier extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._zoomScale = ZOOM_DEFAULT;
        this._size = LENS_SIZE;
        this._isActive = false;
        this._pollTimerId = 0;
        this._pollIntervalMs = POLL_IDLE_MS;
        this._pointerX = 0;
        this._pointerY = 0;
        this._chromeAdded = false;

        this._buildUI();
        this._connectSignal(this._ui.actor, 'notify::visible', () => {
            this._onUIVisibilityChanged();
        });
        this._connectSignal(this._ui.actor, 'captured-event',
            (_actor, event) => this._onCapturedEvent(event));
    }

    _buildUI() {
        this._container = new St.Widget({
            style_class: 'big-shot-magnifier-lens',
            width: this._size,
            height: this._size,
            visible: false,
            reactive: false,
            clip_to_allocation: true,
        });

        // Clone only the captured preview. This avoids recursive capture of
        // the lens and keeps controls out of the magnified content.
        this._clone = new Clutter.Clone({
            source: this._ui._previewActor,
            clip_to_allocation: true,
            reactive: false,
        });
        this._container.add_child(this._clone);

        this._mask = new St.DrawingArea({
            width: this._size,
            height: this._size,
            reactive: false,
        });
        this._mask.connect('repaint', area => {
            const cr = area.get_context();
            const size = area.get_surface_size();
            this._drawMask(cr, size[0], size[1]);
            if (cr.$dispose)
                cr.$dispose();
        });
        this._container.add_child(this._mask);

        const half = Math.floor(this._size / 2);
        this._crossH = new St.Widget({
            style_class: 'big-shot-magnifier-crosshair',
            width: this._size,
            height: 1,
            x: 0,
            y: half,
            reactive: false,
        });
        this._crossV = new St.Widget({
            style_class: 'big-shot-magnifier-crosshair',
            width: 1,
            height: this._size,
            x: half,
            y: 0,
            reactive: false,
        });
        this._container.add_child(this._crossH);
        this._container.add_child(this._crossV);

        this._zoomLabel = new St.Label({
            style_class: 'big-shot-magnifier-zoom-label',
            text: this._formatZoom(),
            x: 10,
            y: 10,
            reactive: false,
        });
        this._container.add_child(this._zoomLabel);

        Main.layoutManager.addChrome(this._container, {
            affectsInputRegion: false,
            affectsStruts: false,
        });
        this._chromeAdded = true;
    }

    _drawMask(cr, width, height) {
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(centerX, centerY) - LENS_PADDING;

        cr.save();
        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(CAIRO_OPERATOR_OVER);
        cr.setSourceRGBA(0.06, 0.06, 0.06, 1);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        cr.setOperator(CAIRO_OPERATOR_CLEAR);
        cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
        cr.fill();

        cr.setOperator(CAIRO_OPERATOR_OVER);
        for (let i = 0; i < 14; i++) {
            cr.setSourceRGBA(0.08, 0.08, 0.10, 0.45 * (1 - i / 14));
            cr.setLineWidth(1.5);
            cr.arc(centerX, centerY, radius - i, 0, Math.PI * 2);
            cr.stroke();
        }
        cr.setSourceRGBA(1, 1, 1, 0.30);
        cr.setLineWidth(2);
        cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
        cr.stroke();
    }

    _onUIVisibilityChanged() {
        if (this._ui.visible) {
            this._setPollRate(POLL_IDLE_MS);
        } else {
            this._deactivate();
            this._stopPolling();
            this._zoomScale = ZOOM_DEFAULT;
            this._zoomLabel.set_text(this._formatZoom());
        }
    }

    _onCapturedEvent(event) {
        if (!this._isActive || event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP) {
            this._zoomScale = Math.min(
                ZOOM_MAX,
                this._zoomScale + ZOOM_STEP
            );
        } else if (direction === Clutter.ScrollDirection.DOWN) {
            this._zoomScale = Math.max(
                ZOOM_MIN,
                this._zoomScale - ZOOM_STEP
            );
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        this._zoomLabel.set_text(this._formatZoom());
        this._updatePosition();
        return Clutter.EVENT_STOP;
    }

    _setPollRate(intervalMs) {
        if (this._pollTimerId && this._pollIntervalMs === intervalMs)
            return;
        this._stopPolling();
        this._pollIntervalMs = intervalMs;
        this._pollTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            intervalMs,
            () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _tick() {
        const pointer = global.get_pointer();
        const shiftHeld = (pointer[2] &
            Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (shiftHeld && this._ui._selectionMode === AREA_MODE) {
            this._pointerX = pointer[0];
            this._pointerY = pointer[1];
            if (!this._isActive) {
                this._isActive = true;
                this._container.show();
                this._setPollRate(POLL_ACTIVE_MS);
            }
            this._updatePosition();
        } else if (this._isActive) {
            this._deactivate();
            this._setPollRate(POLL_IDLE_MS);
        }
    }

    _updatePosition() {
        const monitor = this._ui.monitorGeometry;
        const localX = this._pointerX - monitor.x;
        const localY = this._pointerY - monitor.y;
        const half = this._size / 2;

        this._clone.set_scale(this._zoomScale, this._zoomScale);
        this._clone.set_position(
            half - localX * this._zoomScale,
            half - localY * this._zoomScale
        );

        let x = this._pointerX + LENS_OFFSET;
        let y = this._pointerY + LENS_OFFSET;
        if (x + this._size > monitor.x + monitor.width)
            x = this._pointerX - this._size - LENS_OFFSET;
        if (y + this._size > monitor.y + monitor.height)
            y = this._pointerY - this._size - LENS_OFFSET;
        x = Math.max(monitor.x, Math.min(
            x,
            monitor.x + monitor.width - this._size
        ));
        y = Math.max(monitor.y, Math.min(
            y,
            monitor.y + monitor.height - this._size
        ));
        this._container.set_position(x, y);
    }

    _formatZoom() {
        return this._zoomScale.toFixed(1) + '×';
    }

    _stopPolling() {
        if (!this._pollTimerId) return;
        GLib.source_remove(this._pollTimerId);
        this._pollTimerId = 0;
    }

    _deactivate() {
        this._isActive = false;
        if (this._container)
            this._container.hide();
    }

    destroy() {
        this._deactivate();
        this._stopPolling();
        if (this._clone) {
            this._clone.set_source(null);
            this._clone = null;
        }
        if (this._container) {
            if (this._chromeAdded) {
                try {
                    Main.layoutManager.removeChrome(this._container);
                } catch (e) {
                    // Actor may already be detached during Cinnamon shutdown.
                }
                this._chromeAdded = false;
            }
            this._container.destroy();
            this._container = null;
        }
        PartUI.prototype.destroy.call(this);
    }
};
